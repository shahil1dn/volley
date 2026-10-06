// Q&A (ADR-008; A18–A20) and start_session. Every test is rolled back except
// the concurrency one, which needs separate connections and cleans up.
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { connectAsOwner } from '../scripts/pg-connect.ts';
import { MAX_ACTIVITIES, MAX_OPTION_CHARS, MAX_PROMPT_CHARS } from '../src/lib/session-limits.ts';
import { parseSessionForm } from '../src/lib/server/session-form.ts';
import { inRolledBackTransaction, makeRun, scanCounts, skipWithoutDatabase as skip, submit } from './db-helpers.ts';

let db: pg.Client;
before(async () => {
	if (!skip) db = await connectAsOwner();
});
after(async () => {
	await db?.end();
});

async function startSession(client: pg.Client, hostId: string, items: unknown) {
	return (await client.query('select public.start_session($1, $2) as result', [hostId, JSON.stringify(items)])).rows[0].result;
}

// A host with a live session whose one activity, a Q&A, is open.
async function openQnaFor(client: pg.Client, hostId: string) {
	const { code } = await startSession(client, hostId, [{ type: 'qna', prompt: 'Ask us anything' }]);
	const { rows } = await client.query(
		`update public.runs set status = 'live', item_state = 'open' where code = $1 returning id`,
		[code],
	);
	return { userId: hostId, code: code as string, runId: rows[0].id as string };
}

async function openQna(client = db) {
	return openQnaFor(client, (await makeRun(client)).userId);
}

async function ask(code: string, text: string, participant = randomUUID()) {
	return submit(db, code, participant, randomUUID(), text);
}

async function vote(code: string, participant: string, questionId: number, up: boolean, client = db, ipHash = 'test-ip') {
	return (await client.query('select public.vote_question($1, $2, $3, $4, $5) as result', [code, participant, questionId, up, ipHash]))
		.rows[0].result;
}

async function state(code: string) {
	return (await db.query('select public.get_state($1) as result', [code])).rows[0].result;
}

async function act(hostId: string, code: string, action: string, key?: string) {
	return (await db.query('select public.host_action($1, $2, $3, $4) as result', [hostId, code, action, key ?? null])).rows[0].result;
}

// The main list as [text, votes].
async function mainList(code: string) {
	return (await state(code)).questions.map(([, text, votes]: [number, string, number]) => [text, votes]);
}

async function idOf(code: string, text: string): Promise<number> {
	const found = (await state(code)).questions.find(([, t]: [number, string]) => t === text);
	return Number(found[0]);
}

test('a question is tidied but keeps its case, and joins the main list with no votes', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const qna = await openQna();
		assert.deepEqual(await ask(qna.code, '  How   do I START with AI?  '), { status: 'ok', left: 4 });
		assert.deepEqual(await mainList(qna.code), [['How do I START with AI?', 0]]);
	});
});

test('blank and overlong questions are refused; each person may ask 5', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const qna = await openQna();
		assert.equal((await ask(qna.code, '   ')).status, 'invalid');
		assert.equal((await ask(qna.code, 'x'.repeat(281))).status, 'invalid');
		assert.equal((await ask(qna.code, 'x'.repeat(280))).status, 'ok');
		const me = randomUUID();
		for (let i = 1; i <= 5; i++) assert.equal((await ask(qna.code, `Question ${i}`, me)).status, 'ok');
		assert.deepEqual(await ask(qna.code, 'One too many', me), { status: 'limit', left: 0 });
		assert.equal((await state(qna.code)).questions.length, 6);
	});
});

test('A18: an upvote counts once per person, a retry changes nothing, and undo takes it back', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const qna = await openQna();
		await ask(qna.code, 'Will it rain?');
		const id = await idOf(qna.code, 'Will it rain?');
		const me = randomUUID();

		assert.deepEqual(await vote(qna.code, me, id, true), { status: 'ok', voted: true, votes: 1 });
		assert.deepEqual(await vote(qna.code, me, id, true), { status: 'ok', voted: true, votes: 1 }, 'second upvote or retry');
		assert.deepEqual(await mainList(qna.code), [['Will it rain?', 1]]);
		assert.deepEqual(await vote(qna.code, randomUUID(), id, true), { status: 'ok', voted: true, votes: 2 }, 'someone else counts');

		assert.deepEqual(await vote(qna.code, me, id, false), { status: 'ok', voted: false, votes: 1 });
		assert.deepEqual(await vote(qna.code, me, id, false), { status: 'ok', voted: false, votes: 1 }, 'retried undo');
		const rows = await db.query('select count(*) from public.question_votes where question_id = $1', [id]);
		assert.equal(Number(rows.rows[0].count), 1);
	});
});

test('the main list sorts by votes, then oldest first', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const qna = await openQna();
		for (const text of ['first', 'second', 'third', 'fourth']) await ask(qna.code, text);
		// Asked in the same transaction, so they share a timestamp and their order
		// of asking (id) breaks the tie.
		await vote(qna.code, randomUUID(), await idOf(qna.code, 'third'), true);
		await vote(qna.code, randomUUID(), await idOf(qna.code, 'third'), true);
		await vote(qna.code, randomUUID(), await idOf(qna.code, 'fourth'), true);
		assert.deepEqual(await mainList(qna.code), [['third', 2], ['fourth', 1], ['first', 0], ['second', 0]]);
	});
});

test('A19: hiding takes a question out of the state; unhiding brings it back', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const qna = await openQna();
		await ask(qna.code, 'keep');
		await ask(qna.code, 'rude');
		const rude = await idOf(qna.code, 'rude');
		assert.equal((await act(qna.userId, qna.code, 'hide', String(rude))).status, 'ok');
		assert.deepEqual(await mainList(qna.code), [['keep', 0]]);
		assert.equal((await vote(qna.code, randomUUID(), rude, true)).status, 'closed', 'a hidden question takes no votes');
		const logged = await db.query(`select action, key from public.moderation where run_id = $1`, [qna.runId]);
		assert.deepEqual(logged.rows, [{ action: 'hide', key: String(rude) }]);
		await act(qna.userId, qna.code, 'unhide', String(rude));
		assert.equal((await mainList(qna.code)).length, 2);
	});
});

test('A19: an answered question leaves the main list but stays in the host view', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const qna = await openQna();
		await ask(qna.code, 'done');
		await ask(qna.code, 'open');
		const done = await idOf(qna.code, 'done');
		assert.equal((await act(qna.userId, qna.code, 'answer', String(done))).status, 'ok');
		assert.deepEqual(await mainList(qna.code), [['open', 0]]);
		assert.equal((await vote(qna.code, randomUUID(), done, true)).status, 'closed');
		const view = (await db.query('select public.host_view($1, $2) as v', [qna.userId, qna.code])).rows[0].v;
		assert.deepEqual(view.questions.map(([, text, , hidden, answered]: unknown[]) => [text, hidden, answered]), [
			['open', false, false],
			['done', false, true],
		]);
		await act(qna.userId, qna.code, 'unanswer', String(done));
		assert.equal((await mainList(qna.code)).length, 2);
	});
});

test('hide, answer and unanswer refuse a question that is not on this item, or a bad id', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const mine = await openQna();
		const theirs = await openQna();
		await ask(theirs.code, 'not yours');
		const other = String(await idOf(theirs.code, 'not yours'));
		for (const action of ['hide', 'answer', 'unanswer']) {
			assert.equal((await act(mine.userId, mine.code, action, other)).status, 'invalid', action);
			assert.equal((await act(mine.userId, mine.code, action, 'abc')).status, 'invalid', action);
		}
		assert.equal((await vote(mine.code, randomUUID(), Number(other), true)).status, 'closed');
	});
});

test('the state carries at most 40 questions', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const qna = await openQna();
		await db.query(
			`insert into public.questions (run_id, item_id, text)
			 select $1, i.id, 'q' || n from public.runs r join public.deck_items i on i.deck_id = r.deck_id, generate_series(1, 45) n
			 where r.id = $1`,
			[qna.runId],
		);
		assert.equal((await state(qna.code)).questions.length, 40);
	});
});

test('votes are refused when answers are frozen or closed', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const qna = await openQna();
		await ask(qna.code, 'q');
		const id = await idOf(qna.code, 'q');
		await act(qna.userId, qna.code, 'freeze');
		assert.equal((await vote(qna.code, randomUUID(), id, true)).status, 'frozen');
		await act(qna.userId, qna.code, 'unfreeze');
		await act(qna.userId, qna.code, 'close');
		assert.equal((await vote(qna.code, randomUUID(), id, true)).status, 'closed');
		assert.equal((await vote('ZZZZZ', randomUUID(), id, true)).status, 'closed');
	});
});

test('A20: the purge removes a run with its questions and votes', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const qna = await openQna();
		await ask(qna.code, 'gone soon');
		await vote(qna.code, randomUUID(), await idOf(qna.code, 'gone soon'), true);
		await db.query(
			`update public.runs set status = 'ended', ended_at = now() - interval '25 hours', last_activity_at = now() - interval '25 hours' where id = $1`,
			[qna.runId],
		);
		await db.query('select public.purge_expired()');
		const left = await db.query(
			`select (select count(*) from public.questions where run_id = $1) as questions,
			        (select count(*) from public.question_votes v where not exists (select 1 from public.questions q where q.id = v.question_id)) as orphan_votes,
			        (select count(*) from public.question_votes v join public.questions q on q.id = v.question_id where q.run_id = $1) as votes`,
			[qna.runId],
		);
		assert.deepEqual(left.rows[0], { questions: '0', orphan_votes: '0', votes: '0' });
	});
});

test('start_session builds the activities in order, one room code for all', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const host = await makeRun(db);
		const result = await startSession(db, host.userId, [
			{ type: 'word_cloud', prompt: ' One word for AI? ' },
			{ type: 'poll', prompt: 'Tea or coffee?', options: [' Tea', 'Coffee '] },
			{ type: 'qna', prompt: 'Ask us anything' },
		]);
		assert.equal(result.status, 'ok');
		const items = await db.query(
			`select i.position, i.type, i.settings from public.runs r join public.deck_items i on i.deck_id = r.deck_id
			 where r.code = $1 order by i.position`,
			[result.code],
		);
		assert.deepEqual(items.rows, [
			{ position: 0, type: 'word_cloud', settings: { prompt: 'One word for AI?' } },
			{ position: 1, type: 'poll', settings: { prompt: 'Tea or coffee?', options: ['Tea', 'Coffee'] } },
			{ position: 2, type: 'qna', settings: { prompt: 'Ask us anything' } },
		]);
	});
});

test('start_session refuses bad sessions and leaves no deck behind', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const host = await makeRun(db);
		const decksBefore = (await db.query('select count(*) from public.decks where host_id = $1', [host.userId])).rows[0].count;
		assert.equal((await startSession(db, randomUUID(), [{ type: 'qna', prompt: 'Q?' }])).status, 'not_host');
		const word = { type: 'word_cloud', prompt: 'Q?' };
		for (const items of [
			[],
			Array.from({ length: MAX_ACTIVITIES + 1 }, () => word),
			{ type: 'qna', prompt: 'Q?' },
			[{ type: 'quiz', prompt: 'Q?' }],
			[word, { type: 'qna', prompt: '   ' }],
			[word, { type: 'poll', prompt: 'Q?', options: ['Only one'] }],
			[word, { type: 'poll', prompt: 'Q?', options: ['Yes', 'yes'] }],
			[word, { type: 'poll', prompt: 'Q?' }],
			['word_cloud'],
		]) {
			assert.equal((await startSession(db, host.userId, items)).status, 'invalid', JSON.stringify(items));
		}
		const decksAfter = (await db.query('select count(*) from public.decks where host_id = $1', [host.userId])).rows[0].count;
		assert.equal(decksAfter, decksBefore);
	});
});

// The app's cap (MAX_ACTIVITIES) and the database's are written separately, so
// this starts a session at each edge: a drift in either goes red here.
test('start_session takes 1 up to MAX_ACTIVITIES activities and refuses 0 and one more', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const host = await makeRun(db);
		const activity = (n: number) => ({ type: 'word_cloud', prompt: `Question ${n}` });
		for (const count of [1, MAX_ACTIVITIES]) {
			const result = await startSession(db, host.userId, Array.from({ length: count }, (_, n) => activity(n)));
			assert.equal(result.status, 'ok', `${count} activities`);
			const prompts = await db.query(
				`select i.settings ->> 'prompt' as prompt from public.runs r join public.deck_items i on i.deck_id = r.deck_id
				 where r.code = $1 order by i.position`,
				[result.code],
			);
			assert.deepEqual(prompts.rows.map((row) => row.prompt), Array.from({ length: count }, (_, n) => `Question ${n}`));
		}
		for (const count of [0, MAX_ACTIVITIES + 1]) {
			assert.equal((await startSession(db, host.userId, Array.from({ length: count }, (_, n) => activity(n)))).status, 'invalid', `${count} activities`);
		}
	});
});

// What the page posts, read by the server, then stored: the options that come
// out of the database are the ones typed, in the order typed.
test('a posted session round-trips through the reader and start_session, options included', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const host = await makeRun(db);
		const form = new FormData();
		const typed = [
			{ type: 'poll', prompt: 'Tea or coffee?', options: ['Tea', 'Coffee', 'Neither', 'Water'] },
			{ type: 'word_cloud', prompt: 'One word?', options: ['stray'] },
			{ type: 'poll', prompt: 'Second poll?', options: ['Yes', 'No'] },
		];
		for (const [i, activity] of typed.entries()) {
			form.append('type', activity.type);
			form.append('prompt', activity.prompt);
			for (const option of activity.options) form.append(`options${i}`, option);
		}
		const parsed = parseSessionForm(form);
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		const result = await startSession(db, host.userId, parsed.items);
		assert.equal(result.status, 'ok');
		const stored = await db.query(
			`select i.type, i.settings from public.runs r join public.deck_items i on i.deck_id = r.deck_id
			 where r.code = $1 order by i.position`,
			[result.code],
		);
		assert.deepEqual(stored.rows, [
			{ type: 'poll', settings: { prompt: 'Tea or coffee?', options: ['Tea', 'Coffee', 'Neither', 'Water'] } },
			{ type: 'word_cloud', settings: { prompt: 'One word?' } },
			{ type: 'poll', settings: { prompt: 'Second poll?', options: ['Yes', 'No'] } },
		]);
	});
});

// The reader and the database were written apart; both must take the longest
// question and option the limits allow, and neither a character more.
test('start_session accepts a question and an option of exactly the limit, and refuses one more', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const host = await makeRun(db);
		const prompt = 'q'.repeat(MAX_PROMPT_CHARS);
		const option = '🙂'.repeat(MAX_OPTION_CHARS);
		const ok = await startSession(db, host.userId, [{ type: 'poll', prompt, options: [option, 'short'] }]);
		assert.equal(ok.status, 'ok');
		const stored = await db.query(
			`select i.settings from public.runs r join public.deck_items i on i.deck_id = r.deck_id where r.code = $1`,
			[ok.code],
		);
		assert.deepEqual(stored.rows[0].settings, { prompt, options: [option, 'short'] });
		assert.equal((await startSession(db, host.userId, [{ type: 'poll', prompt, options: [`${option}🙂`, 'short'] }])).status, 'invalid');
		assert.equal((await startSession(db, host.userId, [{ type: 'qna', prompt: `${prompt}q` }])).status, 'invalid');
	});
});

test('the export carries every question with its votes, hidden and answered', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const qna = await openQna();
		for (const text of ['a', 'b', 'c']) await ask(qna.code, text);
		await vote(qna.code, randomUUID(), await idOf(qna.code, 'b'), true);
		await act(qna.userId, qna.code, 'hide', String(await idOf(qna.code, 'c')));
		await act(qna.userId, qna.code, 'answer', String(await idOf(qna.code, 'a')));
		const exported = (await db.query('select public.host_export($1, $2) as e', [qna.userId, qna.code])).rows[0].e;
		assert.deepEqual(exported.items[0].questions, [['b', 1, false, false], ['a', 0, false, true], ['c', 0, true, false]]);
	});
});

test('10 concurrent upvotes from one participant count once', { skip }, async () => {
	const setup = await connectAsOwner();
	const ipHash = `test-${randomUUID()}`;
	let hostId: string | undefined;
	let runId: string | undefined;
	let phones: pg.Client[] = [];
	try {
		hostId = (await makeRun(setup)).userId;
		const qna = await openQnaFor(setup, hostId);
		runId = qna.runId;
		assert.equal((await submit(setup, qna.code, randomUUID(), randomUUID(), 'popular?', ipHash)).status, 'ok');
		const { rows } = await setup.query('select id from public.questions where run_id = $1', [runId]);
		const id = Number(rows[0].id);
		phones = await Promise.all(Array.from({ length: 10 }, () => connectAsOwner()));
		const me = randomUUID();
		const results = await Promise.all(phones.map((phone) => vote(qna.code, me, id, true, phone, ipHash)));
		assert.ok(results.every((result) => result.status === 'ok' && result.voted === true), JSON.stringify(results));
		const after = await setup.query('select votes from public.questions where id = $1', [id]);
		assert.equal(after.rows[0].votes, 1);
	} finally {
		await Promise.all(phones.map((phone) => phone.end()));
		if (hostId) await setup.query('delete from auth.users where id = $1', [hostId]);
		await setup.query('delete from public.rate_limits where key = any($1)', [[`ip:${ipHash}`, `run:${runId}`]]);
		await setup.end();
	}
});

// A11 for the Q&A state, seeded at realistic size (see db-get-state.test.ts).
test('A11: the Q&A list is read through its index at realistic sizes', { skip }, async () => {
	const fresh = await connectAsOwner();
	try {
		await inRolledBackTransaction(fresh, async () => {
			const qna = await openQna(fresh);
			await fresh.query(
				`insert into public.questions (run_id, item_id, text, votes)
				 select $1, i.id, 'q' || n, n % 17 from public.runs r join public.deck_items i on i.deck_id = r.deck_id, generate_series(1, 5000) n
				 where r.id = $1`,
				[qna.runId],
			);
			await fresh.query('analyze public.questions');
			const before = await scanCounts(fresh, ['questions']);
			const questions = (await fresh.query('select public.get_state($1) as s', [qna.code])).rows[0].s.questions;
			const after = await scanCounts(fresh, ['questions']);
			assert.equal(questions.length, 40);
			assert.equal(after.questions.sequential - before.questions.sequential, 0, 'questions: sequential scan');
			assert.ok(after.questions.index - before.questions.index >= 1, 'questions: not read through an index');
		});
	} finally {
		// ANALYZE's row estimates outlive the rollback; refresh them from the real rows.
		await fresh.query('analyze public.questions').catch(() => undefined);
		await fresh.end();
	}
});

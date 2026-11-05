// The feedback form (ADR-018, migration 0019; A24 to A27, A29). Every test is
// rolled back except the concurrency one, which needs separate connections and
// cleans up after itself.
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { connectAsOwner } from '../scripts/pg-connect.ts';
import { inRolledBackTransaction, makeRun, scanCounts, skipWithoutDatabase as skip, submit } from './db-helpers.ts';

let db: pg.Client;
before(async () => {
	if (!skip) db = await connectAsOwner();
});
after(async () => {
	await db?.end();
});

type Question = { text: string; scale: string };
const THREE: Question[] = [
	{ text: 'How was the talk?', scale: 'stars' },
	{ text: 'How likely are you to come again?', scale: 'ten' },
	{ text: 'The room', scale: 'words' },
];

async function start(client: pg.Client, hostId: string, items: object[]) {
	return (await client.query('select public.start_session($1, $2) as result', [hostId, JSON.stringify(items)])).rows[0].result;
}

async function act(client: pg.Client, hostId: string, code: string, action: string, key: string | null = null) {
	return (await client.query('select public.host_action($1, $2, $3, $4) as result', [hostId, code, action, key])).rows[0].result;
}

async function state(code: string, client = db) {
	return (await client.query('select public.get_state($1) as result', [code])).rows[0].result;
}

async function hostView(hostId: string, code: string) {
	return (await db.query('select public.host_view($1, $2) as result', [hostId, code])).rows[0].result;
}

// A host with a session whose first activity, a feedback form, is open.
async function openForm(client = db, questions: Question[] = THREE) {
	const { userId } = await makeRun(client);
	const started = await start(client, userId, [{ type: 'feedback', prompt: 'Tell us how it went', questions }]);
	assert.equal(started.status, 'ok', 'session started');
	assert.equal((await act(client, userId, started.code, 'open')).status, 'ok', 'answers opened');
	const runId = (await client.query('select id from public.runs where code = $1', [started.code])).rows[0].id as string;
	return { userId, code: started.code as string, runId };
}

const send = (code: string, ratings: unknown, participant = randomUUID(), submitId = randomUUID(), client = db) =>
	submit(client, code, participant, submitId, typeof ratings === 'string' ? ratings : JSON.stringify(ratings));

async function tallies(runId: string, client = db): Promise<Record<string, number>> {
	const { rows } = await client.query('select key, count from public.tallies where run_id = $1 order by key', [runId]);
	return Object.fromEntries(rows.map((row) => [row.key, row.count]));
}

async function count(table: string, runId: string, client = db) {
	return Number((await client.query(`select count(*) from public.${table} where run_id = $1`, [runId])).rows[0].count);
}

// ---------- A27: what a host may start ----------

test('A27: a form of 1 and of 8 questions starts, stored trimmed and in order, and can come first', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const { userId } = await makeRun(db);
		for (const size of [1, 8]) {
			const questions = Array.from({ length: size }, (_, n) => ({ text: `  Question ${n}  `, scale: ['stars', 'ten', 'words'][n % 3] }));
			const started = await start(db, userId, [{ type: 'feedback', prompt: ' Feedback ', questions }]);
			assert.equal(started.status, 'ok', `${size} questions`);
			const { rows } = await db.query(
				'select i.type, i.position, i.settings from public.deck_items i join public.runs r on r.deck_id = i.deck_id where r.code = $1',
				[started.code],
			);
			assert.deepEqual(rows, [{
				type: 'feedback',
				position: 0,
				settings: { prompt: 'Feedback', questions: questions.map((q) => ({ text: q.text.trim(), scale: q.scale })) },
			}]);
		}
	});
});

test('A27: a form of 0 or 9 questions, an unknown scale, or an empty or 81-character question is refused', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const { userId } = await makeRun(db);
		const form = (questions: unknown) => [{ type: 'word_cloud', prompt: 'Warm-up?' }, { type: 'feedback', prompt: 'Feedback', questions }];
		const ok = { text: 'Fine?', scale: 'stars' };
		const cases: [string, unknown][] = [
			['0 questions', []],
			['9 questions', Array(9).fill(ok)],
			['an unknown scale', [ok, { text: 'Hmm?', scale: 'thumbs' }]],
			['no scale', [{ text: 'Hmm?' }]],
			['a scale that is not text', [{ text: 'Hmm?', scale: 5 }]],
			['an empty question', [ok, { text: '   ', scale: 'ten' }]],
			['an 81-character question', [{ text: 'x'.repeat(81), scale: 'words' }]],
			['a question that is not text', [{ text: 42, scale: 'stars' }]],
			['no questions at all', undefined],
			['questions that are not a list', { text: 'Hmm?', scale: 'stars' }],
		];
		for (const [what, questions] of cases) assert.equal((await start(db, userId, form(questions))).status, 'invalid', what);
		// The edges that must pass, so the refusals above are about the one thing wrong.
		assert.equal((await start(db, userId, form([{ text: 'x'.repeat(80), scale: 'words' }]))).status, 'ok', '80 characters');
		assert.equal((await start(db, userId, form(Array(8).fill(ok)))).status, 'ok', '8 questions after a word cloud');
		// A refused session leaves no deck behind.
		const decks = await db.query(`select count(*) from public.decks where host_id = $1 and title = 'Session'`, [userId]);
		assert.equal(Number(decks.rows[0].count), 2);
	});
});

// ---------- A25: what a phone may send ----------

test('A25: a form with a question missing, an extra question, a rating off its scale, a non-integer or half filled is refused', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const form = await openForm();
		const me = randomUUID();
		const cases: [string, unknown][] = [
			['a question missing (a gap)', [5, null, 3]],
			['a partly filled form', [5, 10]],
			['an empty form', []],
			['an extra question', [5, 10, 3, 3]],
			['0 on stars', [0, 10, 3]],
			['6 on stars', [6, 10, 3]],
			['11 on ten', [5, 11, 3]],
			['0 on ten', [5, 0, 3]],
			['6 on words', [5, 10, 6]],
			['a negative rating', [-1, 10, 3]],
			['a non-integer', [4.5, 10, 3]],
			['a whole number written as a decimal', '[5.0, 10, 3]'],
			['a number in exponent form', '[5, 1e1, 3]'],
			['a rating as text', ['5', 10, 3]],
			['a rating as true', [true, 10, 3]],
			['a list inside the list', [[5], 10, 3]],
			['a form keyed by question', { 0: 5, 1: 10, 2: 3 }],
			['a lone number', 5],
			['text that is not JSON', 'five, ten, three'],
			['a huge number', [99999999999999999999, 10, 3]],
		];
		for (const [what, ratings] of cases) {
			assert.deepEqual(await send(form.code, ratings, me), { status: 'invalid' }, what);
		}
		// Nothing above was stored or used up this phone's one form: it can still send a whole one.
		assert.equal(await count('responses', form.runId), 0);
		assert.deepEqual(await tallies(form.runId), {});
		assert.deepEqual(await send(form.code, [5, 10, 3], me), { status: 'ok', left: 0 });
		// The edges of each scale are taken.
		assert.deepEqual(await send(form.code, [1, 1, 1]), { status: 'ok', left: 0 });
		assert.deepEqual(await send(form.code, ' [ 1 , 10 , 5 ] '), { status: 'ok', left: 0 }, 'spaces around the numbers');
		assert.deepEqual(await tallies(form.runId), { '0:1': 2, '0:5': 1, '1:1': 1, '1:10': 2, '2:1': 1, '2:3': 1, '2:5': 1, n: 3 });
	});
});

test('a form is refused once answers are closed or Show results was pressed', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const form = await openForm();
		assert.equal((await act(db, form.userId, form.code, 'close')).status, 'ok');
		assert.equal((await send(form.code, [5, 10, 3])).status, 'closed');
		assert.equal((await act(db, form.userId, form.code, 'open')).status, 'ok');
		assert.equal((await send(form.code, [5, 10, 3])).status, 'ok', 'open again, taken');
		assert.equal((await act(db, form.userId, form.code, 'reveal')).status, 'ok');
		assert.equal((await send(form.code, [5, 10, 3])).status, 'closed');
		assert.equal((await tallies(form.runId)).n, 1);
	});
});

// ---------- A26: one form per person ----------

test("A26: a participant's second form is refused, and the first stands unchanged", { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const form = await openForm();
		const me = randomUUID();
		assert.deepEqual(await send(form.code, [5, 10, 3], me), { status: 'ok', left: 0 });
		assert.deepEqual(await send(form.code, [1, 1, 1], me), { status: 'limit', left: 0 });
		assert.deepEqual(await tallies(form.runId), { '0:5': 1, '1:10': 1, '2:3': 1, n: 1 });
		assert.equal(await count('responses', form.runId), 1);
	});
});

test('A26: the same submit id sent twice stores one form and gets the same answer both times', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const form = await openForm();
		const me = randomUUID();
		const submitId = randomUUID();
		const first = await send(form.code, [4, 7, 2], me, submitId);
		const again = await send(form.code, [4, 7, 2], me, submitId);
		assert.deepEqual(first, { status: 'ok', left: 0 });
		assert.deepEqual(again, first);
		// A retry after Show results still gets the answer it got before (SPEC 12).
		assert.equal((await act(db, form.userId, form.code, 'reveal')).status, 'ok');
		assert.deepEqual(await send(form.code, [4, 7, 2], me, submitId), first);
		assert.equal(await count('responses', form.runId), 1);
		assert.deepEqual(await tallies(form.runId), { '0:4': 1, '1:7': 1, '2:2': 1, n: 1 });
	});
});

test('A26: 10 concurrent forms from one participant store exactly one', { skip }, async () => {
	const setup = await connectAsOwner();
	const form = await openForm(setup);
	const ipHash = `test-${randomUUID()}`;
	const phones = await Promise.all(Array.from({ length: 10 }, () => connectAsOwner()));
	try {
		const me = randomUUID();
		const results = await Promise.all(
			phones.map((phone, i) => submit(phone, form.code, me, randomUUID(), JSON.stringify([1 + (i % 5), 1 + i, 1 + (i % 5)]), ipHash)),
		);
		assert.deepEqual(results.map((result) => result.status).sort(), [...Array(9).fill('limit'), 'ok']);
		assert.equal(await count('responses', form.runId, setup), 1);
		const stored = await tallies(form.runId, setup);
		assert.equal(stored.n, 1);
		assert.equal(Object.values(stored).reduce((sum, n) => sum + n, 0), 4, 'one rating per question, and the count of forms');
	} finally {
		await Promise.all(phones.map((phone) => phone.end()));
		await setup.query('delete from auth.users where id = $1', [form.userId]);
		await setup.query('delete from public.rate_limits where key = any($1)', [[`ip:${ipHash}`, `run:${form.runId}`]]);
		await setup.end();
	}
});

// ---------- A24: results stay out of the shared state until Show ----------

test('A24: the shared state has no ratings before Show results and has them after; the count of forms throughout', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const form = await openForm();
		await send(form.code, [5, 10, 3]);
		await send(form.code, [4, 10, 1]);

		const open = await state(form.code);
		assert.deepEqual(open.tallies, [], 'open');
		assert.equal(open.responses, 2);
		// Not anywhere else in it either: no rating key appears in the whole state.
		assert.doesNotMatch(JSON.stringify(open), /"\d+:\d+"/);
		// The questions themselves are public: phones need them.
		assert.deepEqual(open.item.settings.questions, THREE);

		assert.equal((await act(db, form.userId, form.code, 'close')).status, 'ok');
		const closed = await state(form.code);
		assert.deepEqual(closed.tallies, [], 'closed');
		assert.equal(closed.responses, 2);

		// The host sees them all along.
		const host = await hostView(form.userId, form.code);
		assert.equal(host.responses, 2);
		assert.deepEqual(
			host.tallies.filter(([key]: [string]) => key !== 'n').map(([key, n]: [string, number]) => [key, n]).sort(),
			[['0:4', 1], ['0:5', 1], ['1:10', 2], ['2:1', 1], ['2:3', 1]],
		);

		assert.equal((await act(db, form.userId, form.code, 'reveal')).status, 'ok');
		const shown = await state(form.code);
		assert.equal(shown.itemState, 'revealed');
		assert.deepEqual(shown.tallies, [['1:10', 2], ['0:4', 1], ['0:5', 1], ['2:1', 1], ['2:3', 1]]);
		assert.equal(shown.responses, 2);
	});
});

test('A24: moving off a shown form and back hides its ratings again', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const { userId } = await makeRun(db);
		const { code } = await start(db, userId, [
			{ type: 'feedback', prompt: 'Feedback', questions: THREE },
			{ type: 'word_cloud', prompt: 'One word?' },
		]);
		await act(db, userId, code, 'open');
		await send(code, [5, 10, 3]);
		await act(db, userId, code, 'reveal');
		assert.equal((await state(code)).tallies.length, 3);
		await act(db, userId, code, 'next');
		await act(db, userId, code, 'back');
		const back = await state(code);
		assert.deepEqual([back.itemState, back.tallies, back.responses], ['closed', [], 1]);
	});
});

test('A24: an ended session keeps unshown ratings out of the state', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const form = await openForm();
		await send(form.code, [5, 10, 3]);
		await act(db, form.userId, form.code, 'end');
		const ended = await state(form.code);
		assert.deepEqual([ended.status, ended.tallies, ended.responses], ['ended', [], 1]);
	});
});

// ---------- Show results and moderation ----------

test('Show results works straight from open on a feedback form only; nothing on it can be hidden', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const form = await openForm();
		await send(form.code, [5, 10, 3]);
		for (const action of ['hide', 'unhide']) {
			assert.equal((await act(db, form.userId, form.code, action, '0:5')).status, 'invalid', action);
		}
		assert.equal((await db.query('select count(*) from public.moderation where run_id = $1', [form.runId])).rows[0].count, '0');
		assert.equal((await act(db, form.userId, form.code, 'reveal')).status, 'ok', 'reveal while open');
		assert.equal((await state(form.code)).itemState, 'revealed');
		assert.equal((await act(db, form.userId, form.code, 'reveal')).status, 'illegal', 'already shown');

		// A word cloud still has to close first, as before.
		const cloud = await makeRun(db);
		assert.equal((await act(db, cloud.userId, cloud.code, 'reveal')).status, 'illegal');
	});
});

test('a frozen session cannot show a form, and a phone cannot send one', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const form = await openForm();
		assert.equal((await act(db, form.userId, form.code, 'freeze')).status, 'ok');
		assert.equal((await send(form.code, [5, 10, 3])).status, 'frozen');
		assert.equal((await act(db, form.userId, form.code, 'reveal')).status, 'illegal');
	});
});

test("the host's export carries a form's questions and every tally", { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const form = await openForm();
		await send(form.code, [5, 10, 3]);
		const exported = (await db.query('select public.host_export($1, $2) as result', [form.userId, form.code])).rows[0].result;
		assert.equal(exported.items.length, 1);
		assert.deepEqual(exported.items[0].form, THREE);
		assert.equal(exported.items[0].prompt, 'Tell us how it went');
		assert.deepEqual(exported.items[0].tallies.map(([key, n]: [string, number]) => [key, n]).sort(), [['0:5', 1], ['1:10', 1], ['2:3', 1], ['n', 1]]);
		// Other types carry no form.
		const cloud = await makeRun(db);
		const other = (await db.query('select public.host_export($1, $2) as result', [cloud.userId, cloud.code])).rows[0].result;
		assert.equal(other.items[0].form, null);
	});
});

// ---------- A29: retention ----------

test("A29: the purge removes a feedback form's answers, tallies and quotas with its run", { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const old = await openForm();
		const recent = await openForm();
		for (const form of [old, recent]) await send(form.code, [5, 10, 3]);
		for (const [form, hours] of [[old, 25], [recent, 23]] as const) {
			await db.query(
				`update public.runs set status = 'ended', ended_at = now() - make_interval(hours => $2), last_activity_at = now() - make_interval(hours => $2) where id = $1`,
				[form.runId, hours],
			);
		}
		const under = async (runId: string) => ({
			runs: Number((await db.query('select count(*) from public.runs where id = $1', [runId])).rows[0].count),
			responses: await count('responses', runId),
			tallies: await count('tallies', runId),
			quotas: await count('quotas', runId),
		});
		assert.deepEqual(await under(old.runId), { runs: 1, responses: 1, tallies: 4, quotas: 1 }, 'seeded');
		await db.query('select public.purge_expired()');
		assert.deepEqual(await under(old.runId), { runs: 0, responses: 0, tallies: 0, quotas: 0 });
		assert.deepEqual(await under(recent.runId), { runs: 1, responses: 1, tallies: 4, quotas: 1 });
	});
});

// ---------- A11 ----------

// As in db-get-state's A11 test: realistic volumes, fresh statistics and a fresh
// connection, then the scans get_state really ran on a feedback form, open and shown.
test('A11: get_state reads a feedback form through indexes only', { skip }, async () => {
	const tables = ['runs', 'deck_items', 'tallies'];
	const fresh = await connectAsOwner();
	try {
		await inRolledBackTransaction(fresh, async () => {
			const form = await openForm(fresh);
			await send(form.code, [5, 10, 3], randomUUID(), randomUUID(), fresh);
			const { userId } = await makeRun(fresh);
			const crowdDeck = (await fresh.query(`insert into public.decks (host_id, title) values ($1, 'Crowd') returning id`, [userId])).rows[0].id;
			await fresh.query(
				`insert into public.deck_items (deck_id, position, type, settings) select $1, n, 'feedback', $2 from generate_series(0, 299) n`,
				[crowdDeck, { prompt: 'F', questions: THREE }],
			);
			await fresh.query(
				`insert into public.runs (deck_id, code, status, item_state)
				 select $1, 'Q' || (
					select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', ((n / (32 ^ p)::int) % 32) + 1, 1), '' order by p desc)
					from generate_series(0, 3) p
				 ), 'live', 'open'
				 from generate_series(0, 1999) n`,
				[crowdDeck],
			);
			await fresh.query(
				`insert into public.tallies (run_id, item_id, key, count)
				 select r.id, (select id from public.deck_items where deck_id = $1 and position = 0), k, 3
				 from public.runs r cross join unnest(array['0:1', '1:2', '2:3', 'n']) k where r.deck_id = $1`,
				[crowdDeck],
			);
			await fresh.query('analyze public.runs, public.deck_items, public.tallies');

			for (const itemState of ['open', 'revealed']) {
				await fresh.query('update public.runs set item_state = $2 where id = $1', [form.runId, itemState]);
				const beforeScans = await scanCounts(fresh, tables);
				const read = await state(form.code, fresh);
				assert.equal(read.responses, 1, itemState);
				assert.equal(read.tallies.length, itemState === 'open' ? 0 : 3, itemState);
				const afterScans = await scanCounts(fresh, tables);
				for (const table of tables) {
					assert.equal(afterScans[table].sequential - beforeScans[table].sequential, 0, `${itemState}, ${table}: sequential scan`);
					assert.ok(afterScans[table].index - beforeScans[table].index >= 1, `${itemState}, ${table}: not read through an index`);
				}
			}
		});
	} finally {
		await fresh.query('analyze public.runs, public.deck_items, public.tallies');
		await fresh.end();
	}
});

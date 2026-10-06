// Q&A on the projector, one question at a time (ADR-013): the host's
// question_next / question_back, what the shared state shows, and the edges
// (retries, hiding, deleting, switching activity). Every test is rolled back.
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { connectAsOwner } from '../scripts/pg-connect.ts';
import { inRolledBackTransaction, makeRun, skipWithoutDatabase as skip, submit } from './db-helpers.ts';

let db: pg.Client;
before(async () => {
	if (!skip) db = await connectAsOwner();
});
after(async () => {
	await db?.end();
});

type Item = { type: string; prompt: string };
type Session = { userId: string; code: string; runId: string };

// A live session of the given activities with the first one open for answers.
async function liveSession(items: Item[] = [{ type: 'qna', prompt: 'Ask us anything' }]): Promise<Session> {
	const host = await makeRun(db);
	const { code } = (await db.query('select public.start_session($1, $2) as r', [host.userId, JSON.stringify(items)])).rows[0].r;
	const { rows } = await db.query(`update public.runs set status = 'live', item_state = 'open' where code = $1 returning id`, [code]);
	return { userId: host.userId, code, runId: rows[0].id };
}

const act = async (s: Session, action: string, key: string | null = '') =>
	(await db.query('select public.host_action($1, $2, $3, $4) as r', [s.userId, s.code, action, key])).rows[0].r;
const state = async (s: Session) => (await db.query('select public.get_state($1) as r', [s.code])).rows[0].r;
const view = async (s: Session) => (await db.query('select public.host_view($1, $2) as r', [s.userId, s.code])).rows[0].r;

// Asks a question from a fresh phone and gives it `votes` upvotes from others.
async function ask(s: Session, text: string, votes = 0): Promise<number> {
	await submit(db, s.code, randomUUID(), randomUUID(), text);
	const id = Number((await db.query('select id from public.questions where run_id = $1 and text = $2', [s.runId, text])).rows[0].id);
	for (let n = 0; n < votes; n++) {
		await db.query('select public.vote_question($1, $2, $3, true, $4)', [s.code, randomUUID(), id, `ip-${n}`]);
	}
	return id;
}

// What the host's Next/Previous button sends: the question on screen now, or ''.
const onScreen = async (s: Session) => String((await view(s)).shown ?? '');
const next = async (s: Session) => act(s, 'question_next', await onScreen(s));
const back = async (s: Session) => act(s, 'question_back', await onScreen(s));
const shownText = async (s: Session): Promise<string | null> => (await state(s)).shown?.[1] ?? null;

test('before the host puts one up, nothing is on screen and the state only counts what is waiting', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const s = await liveSession();
		await ask(s, 'First?');
		await ask(s, 'Second?', 2);
		const { shown, waiting, questions } = await state(s);
		assert.equal(shown, null);
		assert.equal(waiting, 2);
		assert.equal(questions.length, 2, 'phones still get the whole list');
	});
});

test('Next puts up the most-voted question, then the next most, to the end, and then stays put and says so', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const s = await liveSession();
		await ask(s, 'Few votes?', 1);
		await ask(s, 'Most votes?', 3);
		await ask(s, 'No votes?');
		const seen: (string | null)[] = [];
		for (let n = 0; n < 3; n++) {
			const moved = await next(s);
			assert.equal(moved.status, 'ok');
			assert.equal(moved.moved, true);
			seen.push(await shownText(s));
		}
		assert.deepEqual(seen, ['Most votes?', 'Few votes?', 'No votes?']);

		const before = await state(s);
		const end = await next(s);
		assert.deepEqual({ ...end, version: undefined }, { status: 'ok', version: undefined, moved: false, reason: 'none_left' });
		const after = await state(s);
		assert.equal(after.version, before.version, 'nothing changed, so the version did not move');
		assert.equal(await shownText(s), 'No votes?', 'the last question stays up');
	});
});

test('the question on screen stays put as votes shift and new ones arrive; only the next pick reads the latest votes', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const s = await liveSession();
		await ask(s, 'Early favourite?', 2);
		await ask(s, 'Quiet one?', 1);
		await next(s);
		assert.equal(await shownText(s), 'Early favourite?');

		const late = await ask(s, 'Late but loud?', 5);
		await ask(s, 'Another?', 1);
		assert.equal(await shownText(s), 'Early favourite?', 'a better-voted arrival does not replace it');
		const live = (await state(s)).shown;
		assert.equal(live[2], 2, 'its own count is still live');

		await next(s);
		assert.equal((await state(s)).shown[0], late, 'the next pick sees the votes as they are now');
	});
});

test('moving on marks the question answered, so it leaves the phones\' list; Previous goes back and un-answers nothing', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const s = await liveSession();
		await ask(s, 'A?', 3);
		await ask(s, 'B?', 2);
		await ask(s, 'C?', 1);
		await next(s); // A
		await next(s); // B; A is done
		const afterTwo = await state(s);
		assert.deepEqual(afterTwo.questions.map((q: [number, string, number]) => q[1]), ['B?', 'C?'], 'A left the list');
		assert.equal(afterTwo.waiting, 1, 'only C is still waiting');

		await back(s); // A again, B left as it was
		assert.equal(await shownText(s), 'A?');
		const answered = Object.fromEntries((await view(s)).questions.map((q: [number, string, number, boolean, boolean]) => [q[1], q[4]]));
		assert.deepEqual(answered, { 'A?': true, 'B?': false, 'C?': false });
		assert.deepEqual((await state(s)).questions.map((q: [number, string, number]) => q[1]), ['B?', 'C?'], 'going back put nothing back on the phones');
	});
});

test('after Previous, Next goes forward through what was shown before it brings anything new', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const s = await liveSession();
		await ask(s, 'A?', 4);
		await ask(s, 'B?', 3);
		await ask(s, 'C?', 2);
		await ask(s, 'D?', 1);
		await next(s); // A
		await next(s); // B
		await next(s); // C
		await back(s);
		assert.equal(await shownText(s), 'B?', 'one step back is the one just before');
		await back(s);
		assert.equal(await shownText(s), 'A?');
		const order: (string | null)[] = [];
		for (let n = 0; n < 4; n++) {
			await next(s);
			order.push(await shownText(s));
		}
		assert.deepEqual(order, ['B?', 'C?', 'D?', 'D?'], 'B, C again, then the new D, then the end');
	});
});

test('Previous at the first question stays put and says so', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const s = await liveSession();
		await ask(s, 'Only?', 1);
		assert.deepEqual({ ...(await back(s)), version: undefined }, { status: 'ok', version: undefined, moved: false, reason: 'first' });
		await next(s);
		const before = (await state(s)).version;
		const again = await back(s);
		assert.deepEqual({ ...again, version: undefined }, { status: 'ok', version: undefined, moved: false, reason: 'first' });
		assert.equal((await state(s)).version, before);
		assert.equal(await shownText(s), 'Only?');
	});
});

test('a retried or doubled Next cannot skip a question; a stale key moves nothing', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const s = await liveSession();
		const a = await ask(s, 'A?', 3);
		await ask(s, 'B?', 2);
		await ask(s, 'C?', 1);

		const first = await act(s, 'question_next', ''); // the host saw nothing on screen
		assert.equal(first.moved, true);
		assert.equal((await state(s)).shown[0], a);
		const versionAfterFirst = (await state(s)).version;

		// The reply was lost and the button pressed again: the same key, still ''.
		const retry = await act(s, 'question_next', '');
		assert.deepEqual({ ...retry, version: undefined }, { status: 'ok', version: undefined, moved: false, reason: 'stale' });
		assert.equal((await state(s)).shown[0], a, 'still A, not B');
		assert.equal((await state(s)).version, versionAfterFirst);

		// A key for some other question is stale too.
		assert.equal((await act(s, 'question_next', String(a + 1000))).reason, 'stale');
		assert.equal((await act(s, 'question_back', String(a + 1000))).reason, 'stale');

		// And the real key still works exactly once.
		assert.equal((await act(s, 'question_next', String(a))).moved, true);
		assert.equal((await act(s, 'question_next', String(a))).reason, 'stale');
		assert.equal(await shownText(s), 'B?');
	});
});

test('Next and Previous refuse a missing or malformed key, a non-Q&A activity, a session not started or ended, and another host', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const s = await liveSession();
		await ask(s, 'A?');
		for (const key of [null, 'abc', '1; drop table questions', '12345678901234567890']) {
			assert.equal((await act(s, 'question_next', key)).status, 'illegal', String(key));
		}
		const stranger = await makeRun(db);
		const theirs = (await db.query('select public.host_action($1, $2, $3, $4) as r', [stranger.userId, s.code, 'question_next', ''])).rows[0].r;
		assert.equal(theirs.status, 'not_found');
		assert.equal(await shownText(s), null, "someone else's press moved nothing");

		// A session that has not started (the lobby) has nothing to put on a screen yet.
		const lobby = await makeRun(db);
		const { code: lobbyCode } = (await db.query('select public.start_session($1, $2) as r', [lobby.userId, JSON.stringify([{ type: 'qna', prompt: 'Q?' }])])).rows[0].r;
		const early = (await db.query('select public.host_action($1, $2, $3, $4) as r', [lobby.userId, lobbyCode, 'question_next', ''])).rows[0].r;
		assert.equal(early.status, 'illegal');

		const cloud = await liveSession([{ type: 'word_cloud', prompt: 'Q?' }]);
		assert.equal((await act(cloud, 'question_next', '')).status, 'illegal');

		await act(s, 'end');
		assert.equal((await act(s, 'question_next', '')).status, 'illegal');
	});
});

test('hiding the question on screen takes it off at once, unhiding does not put it back, and Next carries on', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const s = await liveSession();
		const a = await ask(s, 'A?', 2);
		await ask(s, 'B?', 1);
		await next(s);
		assert.equal(await shownText(s), 'A?');

		const hidden = await act(s, 'hide', String(a));
		assert.equal(hidden.status, 'ok');
		const afterHide = await state(s);
		assert.equal(afterHide.shown, null, 'gone from the projector in the same state');
		assert.equal(afterHide.waiting, 1);
		assert.equal((await view(s)).shown, null);

		await act(s, 'unhide', String(a));
		assert.equal((await state(s)).shown, null, 'not resurrected');
		// Whatever route a question is hidden by, the state never carries it as shown.
		await next(s);
		await db.query('update public.questions set hidden = true where id = $1', [a]);
		assert.equal((await state(s)).shown, null, 'hidden directly, still not shown');
		await db.query('update public.questions set hidden = false, on_screen = false where id = $1', [a]);
		assert.equal((await state(s)).waiting, 2, 'but waiting its turn again');

		// With the screen empty, Next brings the top-voted question: A, still unanswered.
		await next(s);
		assert.equal(await shownText(s), 'A?');
	});
});

test('a question that disappears from under the screen (deleted) leaves the projector clear and Next still works', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const s = await liveSession();
		const a = await ask(s, 'A?', 2);
		await ask(s, 'B?', 1);
		await next(s);
		await db.query('delete from public.questions where id = $1', [a]);
		const gone = await state(s);
		assert.equal(gone.shown, null);
		assert.equal(gone.waiting, 1);
		assert.equal((await next(s)).moved, true);
		assert.equal(await shownText(s), 'B?');
	});
});

test('switching activity and coming back finds the same question on screen; each Q&A keeps its own', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const s = await liveSession([
			{ type: 'qna', prompt: 'First Q&A' },
			{ type: 'word_cloud', prompt: 'A word?' },
			{ type: 'qna', prompt: 'Second Q&A' },
		]);
		await ask(s, 'One?', 2);
		await ask(s, 'Two?', 1);
		await next(s);
		assert.equal(await shownText(s), 'One?');

		await act(s, 'next');
		const onCloud = await state(s);
		assert.equal(onCloud.shown, null, 'a word cloud has no question on screen');
		assert.equal(onCloud.waiting, 0);

		await act(s, 'next');
		await act(s, 'open');
		await ask(s, 'Other room?', 1);
		assert.equal(await shownText(s), null, 'the second Q&A starts clear');
		await next(s);
		assert.equal(await shownText(s), 'Other room?');

		await act(s, 'back');
		await act(s, 'back');
		const home = await state(s);
		assert.equal(home.shown[1], 'One?', 'back where it was left');
		assert.equal(home.waiting, 1);
	});
});

test('what reaches the projector is a question\'s id, text and votes, and nothing else', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const s = await liveSession();
		await ask(s, 'A?', 1);
		await next(s);
		const shown = (await state(s)).shown;
		assert.equal(shown.length, 3);
		assert.deepEqual([typeof shown[0], shown[1], shown[2]], ['number', 'A?', 1]);
		assert.deepEqual(Object.keys(await state(s)).sort(), [
			'closesAt', 'code', 'currentPosition', 'hostName', 'item', 'itemState', 'opensAt', 'players', 'questions', 'serverNow', 'shown', 'status', 'tallies', 'version', 'waiting',
		]);
	});
});

test('the host view says which is on screen and gives each question its turn', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const s = await liveSession();
		const a = await ask(s, 'A?', 2);
		await ask(s, 'B?', 1);
		assert.equal((await view(s)).shown, null);
		await next(s);
		const v = await view(s);
		assert.equal(v.shown, a);
		const turns = Object.fromEntries(v.questions.map((q: [number, string, number, boolean, boolean, number | null]) => [q[1], q[5]]));
		assert.deepEqual(turns, { 'A?': 1, 'B?': null });
	});
});

test('only one question per activity can be on screen, and one must have had its turn', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const s = await liveSession();
		const a = await ask(s, 'A?');
		const b = await ask(s, 'B?');
		await db.query('savepoint one');
		await assert.rejects(db.query('update public.questions set on_screen = true where id = $1', [a]), /questions_on_screen_was_shown/);
		await db.query('rollback to savepoint one');
		await db.query('update public.questions set on_screen = true, shown_seq = 1 where id = $1', [a]);
		await db.query('savepoint two');
		await assert.rejects(db.query('update public.questions set on_screen = true, shown_seq = 2 where id = $1', [b]), /questions_on_screen_idx/);
		await db.query('rollback to savepoint two');
	});
});

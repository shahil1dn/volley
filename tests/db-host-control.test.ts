// Host control (S7): starting a session, host_action's state machine
// (ARCHITECTURE §4), moderation, and host_view. Every test is rolled back.
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { connectAsOwner } from '../scripts/pg-connect.ts';
import { inRolledBackTransaction, makeRun, skipWithoutDatabase as skip, submit, type TestRun } from './db-helpers.ts';

let db: pg.Client;
before(async () => {
	if (!skip) db = await connectAsOwner();
});
after(async () => {
	await db?.end();
});

async function act(hostId: string, code: string, action: string, key?: string) {
	return (await db.query('select public.host_action($1, $2, $3, $4) as result', [hostId, code, action, key ?? null])).rows[0].result;
}

async function runRow(runId: string) {
	return (await db.query('select status, item_state, current_position, version, ended_at from public.runs where id = $1', [runId])).rows[0];
}

async function addItem(run: TestRun, position: number) {
	await db.query(`insert into public.deck_items (deck_id, position, type) values ($1, $2, 'word_cloud')`, [run.deckId, position]);
}

async function startWordCloud(hostId: string, prompt: string) {
	const items = JSON.stringify([{ type: 'word_cloud', prompt }]);
	return (await db.query('select public.start_session($1, $2) as result', [hostId, items])).rows[0].result;
}

test('a session starts as a lobby run of its word cloud, for that host', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const host = await makeRun(db);
		const started = await startWordCloud(host.userId, '  One word for AI?  ');
		assert.equal(started.status, 'ok');
		const code = started.code;
		assert.match(code, /^[A-HJ-NP-Z2-9]{5}$/);
		const run = await db.query(
			`select r.status, r.item_state, d.host_id, i.type, i.settings
			 from public.runs r join public.decks d on d.id = r.deck_id join public.deck_items i on i.deck_id = d.id
			 where r.code = $1`,
			[code],
		);
		assert.deepEqual(run.rows, [
			{ status: 'lobby', item_state: 'closed', host_id: host.userId, type: 'word_cloud', settings: { prompt: 'One word for AI?' } },
		]);
	});
});

test('a session is refused for a non-host and a blank or overlong question', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const host = await makeRun(db);
		const start = async (hostId: string, prompt: string) => (await startWordCloud(hostId, prompt)).status;
		assert.equal(await start(randomUUID(), 'Hello?'), 'not_host');
		assert.equal(await start(host.userId, '   '), 'invalid');
		assert.equal(await start(host.userId, 'x'.repeat(141)), 'invalid');
	});
});

test('opening starts the run; close, freeze, unfreeze and end each move it on and bump the version', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const run = await makeRun(db, { status: 'lobby', itemState: 'closed' });
		assert.deepEqual(await act(run.userId, run.code, 'open'), { status: 'ok', version: 1 });
		assert.deepEqual(await runRow(run.runId), { status: 'live', item_state: 'open', current_position: 0, version: '1', ended_at: null });
		await act(run.userId, run.code, 'freeze');
		assert.equal((await runRow(run.runId)).status, 'frozen');
		await act(run.userId, run.code, 'close');
		assert.equal((await runRow(run.runId)).item_state, 'closed');
		await act(run.userId, run.code, 'unfreeze');
		await act(run.userId, run.code, 'reveal');
		assert.equal((await runRow(run.runId)).item_state, 'revealed');
		assert.deepEqual(await act(run.userId, run.code, 'end'), { status: 'ok', version: 6 });
		const ended = await runRow(run.runId);
		assert.equal(ended.status, 'ended');
		assert.ok(ended.ended_at instanceof Date);
		assert.equal((await submit(db, run.code, randomUUID(), randomUUID(), 'late')).status, 'closed');
	});
});

test('next and back move between items and close answers; the ends of the deck are refused', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const run = await makeRun(db);
		await addItem(run, 1);
		assert.equal((await act(run.userId, run.code, 'back')).status, 'illegal');
		assert.equal((await act(run.userId, run.code, 'next')).status, 'ok');
		assert.deepEqual(
			[(await runRow(run.runId)).current_position, (await runRow(run.runId)).item_state],
			[1, 'closed'],
		);
		assert.equal((await act(run.userId, run.code, 'next')).status, 'illegal');
		assert.equal((await act(run.userId, run.code, 'back')).status, 'ok');
		assert.equal((await runRow(run.runId)).current_position, 0);
	});
});

test('illegal moves are refused and change nothing', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const cases: [Parameters<typeof makeRun>[1], string[]][] = [
			[{ status: 'lobby', itemState: 'closed' }, ['close', 'reveal', 'next', 'back', 'freeze', 'unfreeze']],
			[{ status: 'live', itemState: 'open' }, ['open', 'reveal', 'unfreeze']],
			[{ status: 'live', itemState: 'closed' }, ['close', 'unfreeze']],
			[{ status: 'frozen', itemState: 'closed' }, ['open', 'reveal', 'next', 'freeze']],
			[{ status: 'ended', itemState: 'closed' }, ['open', 'close', 'reveal', 'next', 'back', 'freeze', 'unfreeze', 'end', 'hide']],
			[{ itemType: 'quiz', status: 'live', itemState: 'closed' }, ['open']],
		];
		for (const [options, actions] of cases) {
			const run = await makeRun(db, options);
			for (const action of actions) {
				assert.deepEqual(await act(run.userId, run.code, action, 'word'), { status: 'illegal' }, `${JSON.stringify(options)} ${action}`);
			}
			assert.equal((await runRow(run.runId)).version, '0', JSON.stringify(options));
		}
		const run = await makeRun(db);
		assert.deepEqual(await act(run.userId, run.code, 'explode'), { status: 'invalid' });
	});
});

test("another host's run is refused as if it didn't exist, and is left alone", { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const mine = await makeRun(db, { status: 'lobby', itemState: 'closed' });
		const theirs = await makeRun(db);
		for (const action of ['open', 'end', 'freeze']) {
			assert.deepEqual(await act(theirs.userId, mine.code, action), { status: 'not_found' });
		}
		assert.deepEqual(await act(mine.userId, 'ZZZZZ', 'open'), { status: 'not_found' });
		assert.equal((await runRow(mine.runId)).version, '0');
		const view = await db.query('select public.host_view($1, $2) as view', [theirs.userId, mine.code]);
		assert.equal(view.rows[0].view, null);
	});
});

test('hide and unhide flip the tally, log a moderation row each, and change the public state', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const run = await makeRun(db);
		await submit(db, run.code, randomUUID(), randomUUID(), 'rude');
		await submit(db, run.code, randomUUID(), randomUUID(), 'kind');
		const visible = async () => (await db.query('select public.get_state($1) as s', [run.code])).rows[0].s.tallies;

		assert.equal((await act(run.userId, run.code, 'hide', 'rude')).status, 'ok');
		assert.deepEqual(await visible(), [['kind', 1]]);
		assert.equal((await act(run.userId, run.code, 'unhide', 'rude')).status, 'ok');
		assert.deepEqual(await visible(), [['kind', 1], ['rude', 1]]);

		const log = await db.query('select key, action from public.moderation where run_id = $1 order by id', [run.runId]);
		assert.deepEqual(log.rows, [{ key: 'rude', action: 'hide' }, { key: 'rude', action: 'unhide' }]);
		assert.deepEqual(await act(run.userId, run.code, 'hide', 'never-sent'), { status: 'invalid' });
		assert.deepEqual(await act(run.userId, run.code, 'hide'), { status: 'invalid' });
	});
});

test('the host view includes hidden words and full settings', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const run = await makeRun(db, { settings: { prompt: 'Q?', correct: 1 } });
		await submit(db, run.code, randomUUID(), randomUUID(), 'rude');
		await submit(db, run.code, randomUUID(), randomUUID(), 'kind');
		await submit(db, run.code, randomUUID(), randomUUID(), 'kind');
		await act(run.userId, run.code, 'hide', 'rude');
		const view = (await db.query('select public.host_view($1, $2) as view', [run.userId, run.code])).rows[0].view;
		assert.deepEqual(view, {
			code: run.code,
			status: 'live',
			version: 4,
			currentPosition: 0,
			itemCount: 1,
			itemState: 'open',
			item: { type: 'word_cloud', settings: { prompt: 'Q?', correct: 1 } },
			tallies: [['kind', 2, false], ['rude', 1, true]],
			questions: [],
		});
	});
});

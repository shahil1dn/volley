// get_state (SPEC 14–17, A9's invariant, A11). Runs against the database in
// .env.local; every test is rolled back.
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { connectAsOwner } from '../scripts/pg-connect.ts';
import { inRolledBackTransaction, makeRun, scanCounts, skipWithoutDatabase as skip, type TestRun } from './db-helpers.ts';

let db: pg.Client;
before(async () => {
	if (!skip) db = await connectAsOwner();
});
after(async () => {
	await db?.end();
});

async function getState(client: pg.Client, code: string) {
	return (await client.query('select public.get_state($1) as state', [code])).rows[0].state;
}

async function addTallies(client: pg.Client, run: TestRun, tallies: [string, number, boolean?][]) {
	for (const [key, count, hidden = false] of tallies) {
		await client.query('insert into public.tallies (run_id, item_id, key, count, hidden) values ($1, $2, $3, $4, $5)', [
			run.runId, run.itemId, key, count, hidden,
		]);
	}
}

test('an unknown code returns null', { skip }, async () => {
	assert.equal(await getState(db, 'ZZZZZ'), null);
});

test('state carries the run, the item and empty lists for a new run', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const run = await makeRun(db, { settings: { prompt: 'One word for AI?' } });
		const state = await getState(db, run.code);
		const { serverNow, ...rest } = state;
		assert.deepEqual(rest, {
			code: run.code,
			status: 'live',
			version: 0,
			currentPosition: 0,
			itemState: 'open',
			opensAt: null,
			closesAt: null,
			hostName: null,
			item: { type: 'word_cloud', settings: { prompt: 'One word for AI?' } },
			tallies: [],
			questions: [],
			players: [],
		});
		assert.ok(Math.abs(serverNow - Date.now()) < 60_000, 'serverNow is the database clock in milliseconds');
	});
});

test('tallies are ordered by count, then alphabetically, and a hidden word is absent', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const run = await makeRun(db);
		// Inserted out of order, so a result in insertion order cannot pass.
		await addTallies(db, run, [['zebra', 2], ['rude', 9, true], ['bots', 1], ['apple', 3], ['ai', 3]]);
		assert.deepEqual((await getState(db, run.code)).tallies, [['ai', 3], ['apple', 3], ['zebra', 2], ['bots', 1]]);
	});
});

test('at most the top 100 tallies are sent', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const run = await makeRun(db);
		await db.query(
			`insert into public.tallies (run_id, item_id, key, count)
			 select $1, $2, 'word ' || n, n from generate_series(1, 150) n`,
			[run.runId, run.itemId],
		);
		const { tallies } = await getState(db, run.code);
		assert.equal(tallies.length, 100);
		assert.deepEqual(tallies[0], ['word 150', 150]);
		assert.deepEqual(tallies[99], ['word 51', 51]);
	});
});

test("another run of the same deck doesn't leak its tallies", { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const run = await makeRun(db);
		await addTallies(db, run, [['mine', 1]]);
		const other = await db.query(
			`insert into public.runs (deck_id, code, status, item_state) values ($1, $2, 'live', 'open') returning id`,
			[run.deckId, 'QQQQQ'],
		);
		await db.query('insert into public.tallies (run_id, item_id, key, count) values ($1, $2, $3, $4)', [
			other.rows[0].id, run.itemId, 'theirs', 50,
		]);
		assert.deepEqual((await getState(db, run.code)).tallies, [['mine', 1]]);
	});
});

test('a correct answer is absent before the reveal, at any depth, and present after', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const settings = { question: 'Capital of France?', correct: 1, options: [{ text: 'Lyon' }, { text: 'Paris', correct: true }] };
		const run = await makeRun(db, { itemType: 'quiz', settings });
		const hidden = await getState(db, run.code);
		assert.deepEqual(hidden.item.settings, { question: 'Capital of France?', options: [{ text: 'Lyon' }, { text: 'Paris' }] });
		assert.ok(!JSON.stringify(hidden).includes('correct'));

		await db.query(`update public.runs set item_state = 'revealed' where id = $1`, [run.runId]);
		assert.deepEqual((await getState(db, run.code)).item.settings, settings);
	});
});

// A11. Tiny tables make Postgres prefer sequential scans whatever the indexes, so
// this seeds realistic volumes inside the rolled-back transaction, refreshes the
// planner's statistics, and checks which scans get_state actually ran. A fresh
// connection, so no plan cached from the tests above (made against tiny tables)
// is reused.
test('A11: get_state reads every table through an index at realistic sizes', { skip }, async () => {
	const tables = ['runs', 'deck_items', 'tallies', 'players'];
	const fresh = await connectAsOwner();
	try {
		await inRolledBackTransaction(fresh, async () => {
			const run = await makeRun(fresh);
			await addTallies(fresh, run, [['visible', 5], ['hidden', 7, true]]);
			const crowdDeck = (
				await fresh.query('insert into public.decks (host_id, title) values ($1, $2) returning id', [run.userId, 'Crowd'])
			).rows[0].id;
			await fresh.query(
				`insert into public.deck_items (deck_id, position, type) select $1, n, 'word_cloud' from generate_series(0, 299) n`,
				[crowdDeck],
			);
			// Deterministic, valid codes: 'Q' plus n written in the code alphabet.
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
				 select r.id, (select id from public.deck_items where deck_id = $1 and position = 0), 'word ' || k, k
				 from public.runs r cross join generate_series(1, 3) k where r.deck_id = $1`,
				[crowdDeck],
			);
			await fresh.query(
				`insert into public.players (run_id, participant_id, nickname, score)
				 select r.id, gen_random_uuid(), 'player ' || k, k
				 from public.runs r cross join generate_series(1, 2) k where r.deck_id = $1`,
				[crowdDeck],
			);
			await fresh.query('analyze public.runs, public.deck_items, public.tallies, public.players');

			const beforeScans = await scanCounts(fresh, tables);
			assert.deepEqual((await getState(fresh, run.code)).tallies, [['visible', 5]]);
			const afterScans = await scanCounts(fresh, tables);
			for (const table of tables) {
				assert.equal(afterScans[table].sequential - beforeScans[table].sequential, 0, `${table}: sequential scan`);
				assert.ok(afterScans[table].index - beforeScans[table].index >= 1, `${table}: not read through an index`);
			}
		});
	} finally {
		// ANALYZE's row estimates outlive the rollback; refresh them from the real rows.
		await fresh.query('analyze public.runs, public.deck_items, public.tallies, public.players');
		await fresh.end();
	}
});

test('a submitted word appears in the state', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const run = await makeRun(db);
		await db.query('select public.submit_answer($1, $2, $3, $4, $5)', [run.code, randomUUID(), randomUUID(), 'Hello', 'test-ip']);
		const state = await getState(db, run.code);
		assert.deepEqual(state.tallies, [['hello', 1]]);
		assert.equal(state.version, 1);
	});
});

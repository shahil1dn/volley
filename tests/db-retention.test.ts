// S8: purge_expired (SPEC 23, A12) and host_export. Every test is rolled back,
// so the purge only ever sees this transaction's backdated rows as its own.
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { connectAsOwner } from '../scripts/pg-connect.ts';
import { inRolledBackTransaction, makeRun, scanCounts, skipWithoutDatabase as skip, submit, type TestRun } from './db-helpers.ts';

let db: pg.Client;
before(async () => {
	if (!skip) db = await connectAsOwner();
});
after(async () => {
	await db?.end();
});

const CHILD_TABLES = ['responses', 'tallies', 'quotas', 'moderation', 'players'];

async function purge(client = db) {
	return (await client.query('select public.purge_expired() as result')).rows[0].result;
}

// Moves a run's clock back as if it had ended (or last moved) `hours` ago.
async function age(run: TestRun, hours: number, ended: boolean) {
	await db.query(
		`update public.runs
		 set status = case when $3 then 'ended' else status end,
		     ended_at = case when $3 then now() - make_interval(hours => $2) end,
		     last_activity_at = now() - make_interval(hours => $2)
		 where id = $1`,
		[run.runId, hours, ended],
	);
}

// A run with a row in every table under it: an answer (response, tally,
// quota), a moderation entry and a player.
async function runWithEverything(): Promise<TestRun> {
	const run = await makeRun(db);
	assert.equal((await submit(db, run.code, randomUUID(), randomUUID(), 'kept?')).status, 'ok');
	assert.equal((await db.query(`select public.host_action($1, $2, 'hide', 'kept?') as r`, [run.userId, run.code])).rows[0].r.status, 'ok');
	await db.query(`insert into public.players (run_id, participant_id, nickname) values ($1, $2, 'p')`, [run.runId, randomUUID()]);
	return run;
}

async function rowsUnder(runId: string) {
	const counts: Record<string, number> = {};
	for (const table of ['runs', ...CHILD_TABLES]) {
		const column = table === 'runs' ? 'id' : 'run_id';
		counts[table] = Number((await db.query(`select count(*) from public.${table} where ${column} = $1`, [runId])).rows[0].count);
	}
	return counts;
}

const EVERYTHING = { runs: 1, responses: 1, tallies: 1, quotas: 1, moderation: 1, players: 1 };
const NOTHING = { runs: 0, responses: 0, tallies: 0, quotas: 0, moderation: 0, players: 0 };

test('A12: a run ended 25h ago is deleted with everything under it; one ended 23h ago stays; decks stay', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const old = await runWithEverything();
		const recent = await runWithEverything();
		await age(old, 25, true);
		await age(recent, 23, true);
		assert.deepEqual(await rowsUnder(old.runId), EVERYTHING, 'seeded before the purge');

		await purge();

		assert.deepEqual(await rowsUnder(old.runId), NOTHING);
		assert.deepEqual(await rowsUnder(recent.runId), EVERYTHING);
		for (const run of [old, recent]) {
			const deck = await db.query(
				'select (select count(*) from public.decks where id = $1) as decks, (select count(*) from public.deck_items where deck_id = $1) as items',
				[run.deckId],
			);
			assert.deepEqual(deck.rows[0], { decks: '1', items: '1' }, 'deck and its activities kept');
		}
	});
});

test('a run idle for 25h is deleted even though it never ended; one idle for 23h stays', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const abandoned = await runWithEverything();
		const quiet = await runWithEverything();
		await age(abandoned, 25, false);
		await age(quiet, 23, false);

		await purge();

		assert.deepEqual(await rowsUnder(abandoned.runId), NOTHING);
		assert.deepEqual(await rowsUnder(quiet.runId), EVERYTHING);
	});
});

// Nothing moves an ended run's clock today, but the promise is "24 hours after
// it ends", so later activity on it must not keep it alive.
test('a run ended 25h ago is deleted even if something touched it since', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const run = await runWithEverything();
		await age(run, 25, true);
		await db.query(`update public.runs set last_activity_at = now() - interval '1 hour' where id = $1`, [run.runId]);

		await purge();

		assert.deepEqual(await rowsUnder(run.runId), NOTHING);
	});
});

test('rate-limit windows older than an hour are pruned; newer ones keep counting', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const key = `test-retention:${randomUUID()}`;
		await db.query(
			`insert into public.rate_limits (key, window_start, count)
			 values ($1, now() - interval '61 minutes', 5), ($1, now() - interval '59 minutes', 5)`,
			[key],
		);
		const result = await purge();
		assert.ok(result.rateLimitWindows >= 1);
		const { rows } = await db.query(
			`select round(extract(epoch from now() - window_start) / 60) as minutes_ago from public.rate_limits where key = $1`,
			[key],
		);
		assert.deepEqual(rows, [{ minutes_ago: '59' }]);
	});
});

// A11 for the purge, seeded at realistic sizes as in db-get-state.test.ts. A
// fresh connection, so no plan made against tiny tables is reused.
test('A11: the purge finds expired runs and old windows through indexes', { skip }, async () => {
	const tables = ['runs', 'rate_limits', ...CHILD_TABLES];
	const fresh = await connectAsOwner();
	try {
		await inRolledBackTransaction(fresh, async () => {
			const run = await makeRun(fresh);
			await fresh.query(
				`insert into public.runs (deck_id, code, status, item_state)
				 select $1, 'Q' || (
					select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', ((n / (32 ^ p)::int) % 32) + 1, 1), '' order by p desc)
					from generate_series(0, 3) p
				 ), 'live', 'open'
				 from generate_series(0, 1999) n`,
				[run.deckId],
			);
			// Three rows per run in every table under runs.
			const eachRun = 'from public.runs r cross join generate_series(1, 3) k where r.deck_id = $1';
			for (const statement of [
				`insert into public.responses (run_id, item_id, participant_id, submit_id, value) select r.id, $2::uuid, gen_random_uuid(), gen_random_uuid(), 'w' ${eachRun}`,
				`insert into public.tallies (run_id, item_id, key, count) select r.id, $2::uuid, 'w' || k, 1 ${eachRun}`,
				`insert into public.quotas (run_id, item_id, participant_id, used) select r.id, $2::uuid, gen_random_uuid(), 1 ${eachRun}`,
				`insert into public.moderation (run_id, item_id, key, action) select r.id, $2::uuid, 'w', 'hide' ${eachRun}`,
			]) {
				await fresh.query(statement, [run.deckId, run.itemId]);
			}
			await fresh.query(`insert into public.players (run_id, participant_id, nickname) select r.id, gen_random_uuid(), 'p' || k ${eachRun}`, [run.deckId]);
			await fresh.query(
				`insert into public.rate_limits (key, window_start, count)
				 select 'test-a11:' || n, date_bin('10 seconds', now(), timestamptz '2000-01-01'), 1 from generate_series(1, 5000) n`,
			);
			await fresh.query(`update public.runs set last_activity_at = now() - interval '25 hours' where id = $1`, [run.runId]);
			await fresh.query(`analyze public.runs, public.rate_limits, public.${CHILD_TABLES.join(', public.')}`);

			const beforeScans = await scanCounts(fresh, tables);
			assert.equal((await purge(fresh)).runs >= 1, true);
			const afterScans = await scanCounts(fresh, tables);
			for (const table of tables) {
				assert.equal(afterScans[table].sequential - beforeScans[table].sequential, 0, `${table}: sequential scan`);
			}
		});
	} finally {
		// ANALYZE's row estimates outlive the rollback; refresh them from the real rows.
		await fresh.query(`analyze public.runs, public.rate_limits, public.${CHILD_TABLES.join(', public.')}`);
		await fresh.end();
	}
});

test('SPEC 23: the purge is scheduled hourly', { skip }, async () => {
	const { rows } = await db.query(`select schedule, command, active from cron.job where jobname = 'volley-purge-expired'`);
	assert.deepEqual(rows, [{ schedule: '0 * * * *', command: 'select public.purge_expired()', active: true }]);
});

async function exportFor(hostId: string, code: string) {
	return (await db.query('select public.host_export($1, $2) as result', [hostId, code])).rows[0].result;
}

test('host_export gives every activity with its full tallies, hidden words marked', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const run = await makeRun(db, { settings: { prompt: 'One word?' } });
		await db.query(`insert into public.deck_items (deck_id, position, type, settings) values ($1, 1, 'word_cloud', '{"prompt":"Another?"}')`, [run.deckId]);
		for (const word of ['beta', 'alpha', 'beta', 'rude']) {
			assert.equal((await submit(db, run.code, randomUUID(), randomUUID(), word)).status, 'ok');
		}
		await db.query(`select public.host_action($1, $2, 'hide', 'rude')`, [run.userId, run.code]);

		assert.deepEqual(await exportFor(run.userId, run.code), {
			code: run.code,
			items: [
				{ position: 0, type: 'word_cloud', prompt: 'One word?', tallies: [['beta', 2, false], ['alpha', 1, false], ['rude', 1, true]] },
				{ position: 1, type: 'word_cloud', prompt: 'Another?', tallies: [] },
			],
		});
	});
});

test("host_export returns nothing for another host's run or an unknown code", { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const mine = await makeRun(db);
		const theirs = await makeRun(db);
		assert.equal(await exportFor(mine.userId, theirs.code), null);
		assert.equal(await exportFor(mine.userId, 'ZZZZZ'), null);
	});
});

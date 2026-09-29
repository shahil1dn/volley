// submit_answer's rules (SPEC 12, 18–21; A1, A3). Runs against the database in
// .env.local. Every test is rolled back except the concurrency test, which needs
// committed rows and deletes them itself.
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { connectAsOwner } from '../scripts/pg-connect.ts';
import { normaliseWord } from '../src/lib/words.ts';
import { inRolledBackTransaction, makeRun, skipWithoutDatabase as skip, submit } from './db-helpers.ts';

let db: pg.Client;
before(async () => {
	if (!skip) db = await connectAsOwner();
});
after(async () => {
	await db?.end();
});

async function count(sql: string, params: unknown[]): Promise<number> {
	return Number((await db.query(sql, params)).rows[0].count);
}

// Seeds a rate-limit counter at `hits` for the current window. now() is fixed for
// the whole transaction, so this is the same window submit_answer will use.
async function seedRateLimit(key: string, hits: number) {
	await db.query(
		`insert into public.rate_limits (key, window_start, count)
		 values ($1, date_bin('10 seconds', now(), timestamptz '2000-01-01 00:00:00+00'), $2)`,
		[key, hits],
	);
}

test('A1: with 3 answers each, the 4th word is refused and not stored', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const run = await makeRun(db);
		const me = randomUUID();
		const results = [];
		for (const word of ['alpha', 'beta', 'gamma', 'delta']) results.push(await submit(db, run.code, me, randomUUID(), word));
		assert.deepEqual(results, [
			{ status: 'ok', left: 2 },
			{ status: 'ok', left: 1 },
			{ status: 'ok', left: 0 },
			{ status: 'limit', left: 0 },
		]);
		assert.equal(await count('select count(*) from public.responses where run_id = $1', [run.runId]), 3);
		assert.equal(await count(`select count(*) from public.tallies where run_id = $1 and key = 'delta'`, [run.runId]), 0);
	});
});

test('the answer limit comes from the item settings', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const run = await makeRun(db, { settings: { answersPerPerson: 1 } });
		const me = randomUUID();
		assert.deepEqual(await submit(db, run.code, me, randomUUID(), 'one'), { status: 'ok', left: 0 });
		assert.deepEqual(await submit(db, run.code, me, randomUUID(), 'two'), { status: 'limit', left: 0 });
	});
});

test('A1: 10 concurrent submits from one participant store exactly 3', { skip }, async () => {
	const setup = await connectAsOwner();
	const run = await makeRun(setup);
	const ipHash = `test-${randomUUID()}`;
	const phones = await Promise.all(Array.from({ length: 10 }, () => connectAsOwner()));
	try {
		const me = randomUUID();
		const results = await Promise.all(phones.map((phone, i) => submit(phone, run.code, me, randomUUID(), `word ${i}`, ipHash)));
		const statuses = results.map((result) => result.status).sort();
		assert.deepEqual(statuses, [...Array(7).fill('limit'), ...Array(3).fill('ok')]);
		const stored = await setup.query('select count(*) from public.responses where run_id = $1', [run.runId]);
		assert.equal(Number(stored.rows[0].count), 3);
		const used = await setup.query('select used from public.quotas where run_id = $1 and participant_id = $2', [run.runId, me]);
		assert.equal(used.rows[0].used, 3);
		const tallied = await setup.query('select coalesce(sum(count), 0) as total from public.tallies where run_id = $1', [run.runId]);
		assert.equal(Number(tallied.rows[0].total), 3);
	} finally {
		await Promise.all(phones.map((phone) => phone.end()));
		await setup.query('delete from auth.users where id = $1', [run.userId]);
		await setup.query('delete from public.rate_limits where key = any($1)', [[`ip:${ipHash}`, `run:${run.runId}`]]);
		await setup.end();
	}
});

test('A3: the same submit id sent twice is stored once and answered the same', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const run = await makeRun(db);
		const me = randomUUID();
		const submitId = randomUUID();
		const first = await submit(db, run.code, me, submitId, 'retry');
		const second = await submit(db, run.code, me, submitId, 'retry');
		assert.deepEqual(first, { status: 'ok', left: 2 });
		assert.deepEqual(second, first);
		assert.equal(await count('select count(*) from public.responses where run_id = $1', [run.runId]), 1);
		assert.equal(await count(`select count from public.tallies where run_id = $1 and key = 'retry'`, [run.runId]), 1);
		assert.equal(await count('select version as count from public.runs where id = $1', [run.runId]), 1);
	});
});

test('a retried submit is still answered ok after the item closes', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const run = await makeRun(db);
		const me = randomUUID();
		const submitId = randomUUID();
		await submit(db, run.code, me, submitId, 'early');
		await db.query(`update public.runs set item_state = 'closed' where id = $1`, [run.runId]);
		assert.deepEqual(await submit(db, run.code, me, submitId, 'early'), { status: 'ok', left: 2 });
		assert.equal((await submit(db, run.code, me, randomUUID(), 'late')).status, 'closed');
	});
});

test('closed items, runs not live and unknown codes are refused', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const hourAgo = new Date(Date.now() - 3_600_000);
		const inAnHour = new Date(Date.now() + 3_600_000);
		const cases = [
			{ options: { itemState: 'closed' }, expected: 'closed' },
			{ options: { itemState: 'revealed' }, expected: 'closed' },
			{ options: { opensAt: inAnHour }, expected: 'closed' },
			{ options: { closesAt: hourAgo }, expected: 'closed' },
			{ options: { status: 'lobby' }, expected: 'closed' },
			{ options: { status: 'ended' }, expected: 'closed' },
			{ options: { status: 'frozen' }, expected: 'frozen' },
			{ options: { opensAt: hourAgo, closesAt: inAnHour }, expected: 'ok' },
		];
		for (const { options, expected } of cases) {
			const run = await makeRun(db, options);
			const result = await submit(db, run.code, randomUUID(), randomUUID(), 'word');
			assert.equal(result.status, expected, JSON.stringify(options));
			const stored = await count('select count(*) from public.responses where run_id = $1', [run.runId]);
			assert.equal(stored, expected === 'ok' ? 1 : 0, JSON.stringify(options));
		}
		assert.equal((await submit(db, 'ZZZZZ', randomUUID(), randomUUID(), 'word')).status, 'closed');
	});
});

test('invalid words and missing fields are refused and not stored', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const run = await makeRun(db);
		for (const value of ['', '   ', 'a'.repeat(26)]) {
			assert.equal((await submit(db, run.code, randomUUID(), randomUUID(), value)).status, 'invalid', JSON.stringify(value));
		}
		const { rows } = await db.query('select public.submit_answer($1, $2, $3, null, $4) as result', [
			run.code, randomUUID(), randomUUID(), 'test-ip',
		]);
		assert.equal(rows[0].result.status, 'invalid');
		assert.equal((await submit(db, run.code, randomUUID(), randomUUID(), 'word', '')).status, 'invalid');
		assert.equal(await count('select count(*) from public.responses where run_id = $1', [run.runId]), 0);
	});
});

test('words are stored in the same normalised form the phone uses', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const inputs = ['  Machine   Learning ', 'AI', ' Ünï\tCODE  X\n', 'İstanbul', 'a b', '😀'.repeat(13), 'a'.repeat(25)];
		for (const raw of inputs) {
			const { rows } = await db.query('select public.normalise_word($1) as word', [raw]);
			assert.equal(rows[0].word, normaliseWord(raw), JSON.stringify(raw));
		}
		const run = await makeRun(db);
		await submit(db, run.code, randomUUID(), randomUUID(), '  Machine   Learning ');
		await submit(db, run.code, randomUUID(), randomUUID(), 'machine learning');
		assert.equal(await count(`select count from public.tallies where run_id = $1 and key = 'machine learning'`, [run.runId]), 2);
	});
});

test('rate limits trip per IP and per run, and refusals still count', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const run = await makeRun(db);
		await seedRateLimit('ip:flooder', 300);
		assert.equal((await submit(db, run.code, randomUUID(), randomUUID(), 'word', 'flooder')).status, 'rate_limited');

		await seedRateLimit(`run:${run.runId}`, 600);
		assert.equal((await submit(db, run.code, randomUUID(), randomUUID(), 'word', 'another-ip')).status, 'rate_limited');
		assert.equal(await count('select count(*) from public.responses where run_id = $1', [run.runId]), 0);

		// A submit refused for its quota still used up rate-limit budget.
		const other = await makeRun(db, { settings: { answersPerPerson: 1 } });
		const me = randomUUID();
		await submit(db, other.code, me, randomUUID(), 'one', 'counted-ip');
		assert.equal((await submit(db, other.code, me, randomUUID(), 'two', 'counted-ip')).status, 'limit');
		assert.equal(await count(`select count from public.rate_limits where key = 'ip:counted-ip'`, []), 2);
	});
});

test('a hidden word stays hidden when sent again, and still counts', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const run = await makeRun(db);
		await submit(db, run.code, randomUUID(), randomUUID(), 'rude');
		await db.query(`update public.tallies set hidden = true where run_id = $1 and key = 'rude'`, [run.runId]);
		assert.equal((await submit(db, run.code, randomUUID(), randomUUID(), 'rude')).status, 'ok');
		const { rows } = await db.query(`select count, hidden from public.tallies where run_id = $1 and key = 'rude'`, [run.runId]);
		assert.deepEqual(rows[0], { count: 2, hidden: true });
	});
});

test('an accepted submit bumps the run version and activity time; a refused one does not', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const run = await makeRun(db, { settings: { answersPerPerson: 1 } });
		await db.query(`update public.runs set last_activity_at = now() - interval '1 hour' where id = $1`, [run.runId]);
		const me = randomUUID();
		await submit(db, run.code, me, randomUUID(), 'one');
		await submit(db, run.code, me, randomUUID(), 'two');
		const { rows } = await db.query(
			`select version, last_activity_at > now() - interval '1 minute' as touched from public.runs where id = $1`,
			[run.runId],
		);
		assert.deepEqual(rows[0], { version: '1', touched: true });
	});
});

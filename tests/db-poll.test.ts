// The poll (Milestone 2, ADR-007): start_test_poll, and submit_answer's poll
// rules. Every test is rolled back except the concurrency one, which needs
// separate connections and cleans up after itself.
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

const OPTIONS = ['Tea', 'Coffee', 'Neither'];

async function startPoll(client: pg.Client, hostId: string, prompt: string, options: string[]) {
	return (await client.query('select public.start_test_poll($1, $2, $3) as result', [hostId, prompt, options])).rows[0].result;
}

// A host with a live poll whose one question is open.
async function openPoll(client: pg.Client, options = OPTIONS) {
	return openPollFor(client, (await makeRun(client)).userId, options);
}

async function openPollFor(client: pg.Client, hostId: string, options = OPTIONS) {
	const { code } = await startPoll(client, hostId, 'Tea or coffee?', options);
	const { rows } = await client.query(
		`update public.runs set status = 'live', item_state = 'open' where code = $1 returning id`,
		[code],
	);
	return { userId: hostId, code, runId: rows[0].id as string };
}

async function tallies(client: pg.Client, runId: string) {
	const { rows } = await client.query(
		'select key, count from public.tallies where run_id = $1 order by key',
		[runId],
	);
	return Object.fromEntries(rows.map((row) => [row.key, row.count]));
}

test('start_test_poll makes a poll with every option at zero', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const poll = await openPoll(db, [' Tea ', 'Coffee', 'Neither']);
		const item = await db.query(
			`select i.type, i.settings from public.runs r join public.deck_items i on i.deck_id = r.deck_id where r.id = $1`,
			[poll.runId],
		);
		assert.deepEqual(item.rows, [{ type: 'poll', settings: { prompt: 'Tea or coffee?', options: OPTIONS } }]);
		assert.deepEqual(await tallies(db, poll.runId), { Coffee: 0, Neither: 0, Tea: 0 });
	});
});

test('start_test_poll refuses a non-host, a blank question and bad option lists', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const host = await makeRun(db);
		assert.equal((await startPoll(db, randomUUID(), 'Q?', OPTIONS)).status, 'not_host');
		for (const [prompt, options] of [
			['   ', OPTIONS],
			['Q?', ['Only one']],
			['Q?', ['1', '2', '3', '4', '5', '6', '7']],
			['Q?', ['Yes', '  ']],
			['Q?', ['Yes', 'x'.repeat(81)]],
			['Q?', ['Yes', 'yes']],
			['Q?', []],
		] as const) {
			assert.equal((await startPoll(db, host.userId, prompt, [...options])).status, 'invalid', JSON.stringify(options));
		}
		assert.equal((await startPoll(db, host.userId, 'Q?', ['Yes', 'No'])).status, 'ok');
		assert.equal((await startPoll(db, host.userId, 'Q?', ['1', '2', '3', '4', '5', '6'])).status, 'ok');
	});
});

test('a vote counts for the option at that position, stored as its text', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const poll = await openPoll(db);
		assert.deepEqual(await submit(db, poll.code, randomUUID(), randomUUID(), '1'), { status: 'ok', left: 0 });
		assert.deepEqual(await submit(db, poll.code, randomUUID(), randomUUID(), '1'), { status: 'ok', left: 0 });
		assert.deepEqual(await submit(db, poll.code, randomUUID(), randomUUID(), '2'), { status: 'ok', left: 0 });
		assert.deepEqual(await tallies(db, poll.runId), { Coffee: 2, Neither: 1, Tea: 0 });
		const stored = await db.query('select value from public.responses where run_id = $1 order by value', [poll.runId]);
		assert.deepEqual(stored.rows.map((row) => row.value), ['Coffee', 'Coffee', 'Neither']);
	});
});

test('one vote per participant: a second vote is refused and not counted', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const poll = await openPoll(db);
		const me = randomUUID();
		assert.equal((await submit(db, poll.code, me, randomUUID(), '0')).status, 'ok');
		assert.deepEqual(await submit(db, poll.code, me, randomUUID(), '1'), { status: 'limit', left: 0 });
		assert.deepEqual(await tallies(db, poll.runId), { Coffee: 0, Neither: 0, Tea: 1 });
	});
});

test('a retried vote (same submit id) is stored once and answered the same', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const poll = await openPoll(db);
		const me = randomUUID();
		const submitId = randomUUID();
		const first = await submit(db, poll.code, me, submitId, '2');
		assert.deepEqual(first, { status: 'ok', left: 0 });
		assert.deepEqual(await submit(db, poll.code, me, submitId, '2'), first);
		assert.deepEqual(await tallies(db, poll.runId), { Coffee: 0, Neither: 1, Tea: 0 });
		const stored = await db.query('select count(*) from public.responses where run_id = $1', [poll.runId]);
		assert.equal(Number(stored.rows[0].count), 1);
	});
});

test('a vote that is not an option position is refused', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const poll = await openPoll(db);
		for (const value of ['3', '5', '-1', '01', '1.0', ' 1', 'Tea', '', '9']) {
			assert.equal((await submit(db, poll.code, randomUUID(), randomUUID(), value)).status, 'invalid', JSON.stringify(value));
		}
		assert.deepEqual(await tallies(db, poll.runId), { Coffee: 0, Neither: 0, Tea: 0 });
	});
});

test('the shared state lists every visible option; hiding one takes it out', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const poll = await openPoll(db);
		await submit(db, poll.code, randomUUID(), randomUUID(), '1');
		const state = async () => (await db.query('select public.get_state($1) as s', [poll.code])).rows[0].s;
		assert.deepEqual((await state()).tallies, [['Coffee', 1], ['Neither', 0], ['Tea', 0]]);
		assert.deepEqual((await state()).item.settings.options, OPTIONS);
		await db.query(`select public.host_action($1, $2, 'hide', 'Tea')`, [poll.userId, poll.code]);
		assert.deepEqual((await state()).tallies, [['Coffee', 1], ['Neither', 0]]);
	});
});

test('the word cloud still allows 3 answers each and refuses a 4th', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const run = await makeRun(db);
		const me = randomUUID();
		for (const [word, left] of [['a', 2], ['b', 1], ['c', 0]] as const) {
			assert.deepEqual(await submit(db, run.code, me, randomUUID(), word), { status: 'ok', left });
		}
		assert.deepEqual(await submit(db, run.code, me, randomUUID(), 'd'), { status: 'limit', left: 0 });
	});
});

test('10 concurrent votes from one participant count exactly once', { skip }, async () => {
	const setup = await connectAsOwner();
	const ipHash = `test-${randomUUID()}`;
	let hostId: string | undefined;
	let runId: string | undefined;
	let phones: pg.Client[] = [];
	try {
		hostId = (await makeRun(setup)).userId;
		const poll = await openPollFor(setup, hostId);
		runId = poll.runId;
		phones = await Promise.all(Array.from({ length: 10 }, () => connectAsOwner()));
		const me = randomUUID();
		const results = await Promise.all(phones.map((phone, i) => submit(phone, poll.code, me, randomUUID(), String(i % 3), ipHash)));
		assert.deepEqual(results.map((result) => result.status).sort(), [...Array(9).fill('limit'), 'ok']);
		const total = Object.values(await tallies(setup, poll.runId)).reduce((sum: number, n) => sum + Number(n), 0);
		assert.equal(total, 1);
	} finally {
		await Promise.all(phones.map((phone) => phone.end()));
		if (hostId) await setup.query('delete from auth.users where id = $1', [hostId]);
		await setup.query('delete from public.rate_limits where key = any($1)', [[`ip:${ipHash}`, `run:${runId}`]]);
		await setup.end();
	}
});

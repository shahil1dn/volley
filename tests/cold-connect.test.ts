// Only a connection that timed out while opening is retried, and only once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryColdConnect } from '../src/lib/server/cold-connect.ts';

function failingTimes(failures: number, message: string) {
	let calls = 0;
	const run = async () => {
		calls++;
		if (calls <= failures) throw new Error(message);
		return 'ok';
	};
	return { run, calls: () => calls };
}

test('a cold connection that timed out is retried once and succeeds', async () => {
	const cold = failingTimes(1, 'Connection terminated due to connection timeout');
	assert.equal(await retryColdConnect(cold.run), 'ok');
	assert.equal(cold.calls(), 2);
});

test('it is not retried a second time', async () => {
	const dead = failingTimes(2, 'Connection terminated due to connection timeout');
	await assert.rejects(retryColdConnect(dead.run), /connection timeout/);
	assert.equal(dead.calls(), 2);
});

test('a busy pool, a query error or a non-Error is not retried', async () => {
	for (const message of ['timeout exceeded when trying to connect', 'Query read timeout', 'duplicate key value']) {
		const other = failingTimes(1, message);
		await assert.rejects(retryColdConnect(other.run), new RegExp(message));
		assert.equal(other.calls(), 1, message);
	}
	let calls = 0;
	await assert.rejects(
		retryColdConnect(async () => {
			calls++;
			throw 'Connection terminated due to connection timeout';
		}),
	);
	assert.equal(calls, 1);
});

// The projector's poll bars (src/lib/poll.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pollBars } from '../src/lib/poll.ts';

test("bars follow the host's option order, not the vote order", () => {
	// Tallies arrive most-voted first; the bars must not reorder as votes come in.
	assert.deepEqual(pollBars(['Tea', 'Coffee', 'Neither'], [['Coffee', 5], ['Neither', 2], ['Tea', 0]]), [
		{ label: 'Tea', votes: 0 },
		{ label: 'Coffee', votes: 5 },
		{ label: 'Neither', votes: 2 },
	]);
});

test('an option missing from the tallies (hidden by the host) gets no bar', () => {
	assert.deepEqual(pollBars(['Tea', 'Coffee'], [['Coffee', 1]]), [{ label: 'Coffee', votes: 1 }]);
});

test('settings without an options list give no bars', () => {
	assert.deepEqual(pollBars(undefined, [['Tea', 1]]), []);
	assert.deepEqual(pollBars('Tea', [['Tea', 1]]), []);
	assert.deepEqual(pollBars([1, 'Tea'], [['Tea', 1]]), [{ label: 'Tea', votes: 1 }]);
});

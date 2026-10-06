import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNewer, keepOwnCount, newSubmitId, OWN_COUNT_MAX_MS, serverClockOffset, stateMadeAt, WAITING_CAP, waitingCount, type RoomState } from '../src/lib/room-client.ts';

const state = (version: number) => ({ version }) as RoomState;

test('an older cached state is ignored; the same or newer is shown', () => {
	assert.equal(isNewer(null, state(0)), true);
	assert.equal(isNewer(state(5), state(4)), false);
	assert.equal(isNewer(state(5), state(5)), true);
	assert.equal(isNewer(state(5), state(6)), true);
});

test('the clock offset adds the cache age to the server time', () => {
	assert.equal(serverClockOffset(10_000, null, 9_000), 1_000);
	assert.equal(serverClockOffset(10_000, '2', 9_000), 3_000);
	assert.equal(serverClockOffset(10_000, 'nonsense', 9_000), 1_000);
	assert.equal(serverClockOffset(10_000, '-3', 9_000), 1_000);
});

test('submit ids are version-4 UUIDs, including the fallback without randomUUID', () => {
	const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
	assert.match(newSubmitId(), v4);
	const original = crypto.randomUUID;
	try {
		Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
		const ids = new Set(Array.from({ length: 200 }, newSubmitId));
		assert.equal(ids.size, 200);
		for (const id of ids) assert.match(id, v4);
	} finally {
		Object.defineProperty(crypto, 'randomUUID', { value: original, configurable: true });
	}
});

test('a cached state was made Age seconds before it arrived; an uncached one after its request was sent', () => {
	assert.equal(stateMadeAt(1_000, 5_000, '2'), 3_000);
	assert.equal(stateMadeAt(1_000, 5_000, null), 1_000);
	assert.equal(stateMadeAt(1_000, 5_000, '0'), 1_000);
	assert.equal(stateMadeAt(1_000, 5_000, '-3'), 1_000);
	assert.equal(stateMadeAt(1_000, 5_000, 'nonsense'), 1_000);
});

test('the count from the vote reply stands until a state made after it arrives, and never longer than the limit', () => {
	const own = { votes: 4, at: 10_000 };
	// Made before the reply: a request already in flight, or a copy from the edge cache.
	assert.equal(keepOwnCount(own, 9_999, 10_500), true);
	// Made at or after the reply: it includes the vote, so it can be trusted.
	assert.equal(keepOwnCount(own, 10_000, 10_500), false);
	assert.equal(keepOwnCount(own, 12_000, 12_500), false);
	// A missing Age header can't pin the number for good.
	assert.equal(keepOwnCount(own, 9_000, 10_000 + OWN_COUNT_MAX_MS - 1), true);
	assert.equal(keepOwnCount(own, 9_000, 10_000 + OWN_COUNT_MAX_MS), false);
});

test('the waiting count reads 100 at exactly 100 and 100+ only above it', () => {
	assert.equal(WAITING_CAP, 100);
	for (const [waiting, shown] of [[0, '0'], [1, '1'], [99, '99'], [100, '100'], [101, '100+'], [5000, '100+']] as const) {
		assert.equal(waitingCount(waiting), shown, String(waiting));
	}
});

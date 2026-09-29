import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNewer, newSubmitId, serverClockOffset, type RoomState } from '../src/lib/room-client.ts';

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

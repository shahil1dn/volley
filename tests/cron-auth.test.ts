// Going live: only Vercel's cron call, carrying the secret, reaches the keep-alive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cronAuthorised } from '../src/lib/server/cron-auth.ts';

const SECRET = 'a-cron-secret-of-enough-length';

test('the right bearer secret is accepted', () => {
	assert.equal(cronAuthorised(`Bearer ${SECRET}`, SECRET), true);
});

test('a missing, wrong, unprefixed or extended secret is refused', () => {
	assert.equal(cronAuthorised(null, SECRET), false);
	assert.equal(cronAuthorised('', SECRET), false);
	assert.equal(cronAuthorised('Bearer wrong-secret-of-enough-length', SECRET), false);
	assert.equal(cronAuthorised(SECRET, SECRET), false);
	assert.equal(cronAuthorised(`Bearer ${SECRET}x`, SECRET), false);
	assert.equal(cronAuthorised(`Bearer ${SECRET.slice(0, -1)}`, SECRET), false);
});

test('an unset or short secret refuses everything, even a matching header', () => {
	assert.equal(cronAuthorised('Bearer ', ''), false);
	assert.equal(cronAuthorised('Bearer undefined', undefined), false);
	assert.equal(cronAuthorised('Bearer short', 'short'), false);
});

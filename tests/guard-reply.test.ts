import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardReply } from '../src/lib/guard-reply.ts';

test('only the guard\'s own error replies are recognised', () => {
	assert.equal(guardReply({ type: 'error', error: { message: 'signed_out' } }), 'signed_out');
	assert.equal(guardReply({ type: 'error', error: { message: 'not_host' } }), 'not_host');
	assert.equal(guardReply({ type: 'error', error: { message: 'Internal Error' } }), null, 'another error is not a guard reply');
	assert.equal(guardReply({ type: 'error', error: new TypeError('Failed to fetch') }), null, 'a dropped connection is not either');
	assert.equal(guardReply({ type: 'error' }), null);
	assert.equal(guardReply({ type: 'failure', error: { message: 'signed_out' } }), null, 'only an error result counts');
	assert.equal(guardReply({ type: 'success' }), null);
});

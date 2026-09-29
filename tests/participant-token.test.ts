import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { hashClientIp, makeParticipantToken, readParticipantToken } from '../src/lib/server/participant-token.ts';

const SECRET = 'test-secret-that-is-long-enough-for-hmac';
const ID = '2f1c9a52-8a8e-4c1e-9d3b-6c1f0e7a4b21';

test('a token reads back as the participant it was made for', () => {
	assert.equal(readParticipantToken(SECRET, 'ABCDE', makeParticipantToken(SECRET, 'ABCDE', ID)), ID);
	const fresh = makeParticipantToken(SECRET, 'ABCDE');
	assert.match(readParticipantToken(SECRET, 'ABCDE', fresh) ?? '', /^[0-9a-f-]{36}$/);
});

test('a token is refused in another room, under another secret, or when altered', () => {
	const token = makeParticipantToken(SECRET, 'ABCDE', ID);
	assert.equal(readParticipantToken(SECRET, 'FGHJK', token), null);
	assert.equal(readParticipantToken('another-secret', 'ABCDE', token), null);
	const otherId = '9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4';
	assert.equal(readParticipantToken(SECRET, 'ABCDE', `${otherId}.${token.split('.')[1]}`), null);
	assert.equal(readParticipantToken(SECRET, 'ABCDE', `${token}x`), null);
});

test('malformed tokens are refused, not thrown on', () => {
	for (const bad of [undefined, '', '.', ID, `${ID}.`, `${ID}.a.b`, `not-a-uuid.${'a'.repeat(43)}`]) {
		assert.equal(readParticipantToken(SECRET, 'ABCDE', bad), null, String(bad));
	}
});

test('the IP hash is stable, secret-dependent and not a plain hash of the IP', () => {
	const ip = '203.0.113.7';
	assert.equal(hashClientIp(SECRET, ip), hashClientIp(SECRET, ip));
	assert.notEqual(hashClientIp(SECRET, ip), hashClientIp(SECRET, '203.0.113.8'));
	assert.notEqual(hashClientIp(SECRET, ip), hashClientIp('another-secret', ip));
	for (const plain of ['hex', 'base64url'] as const) {
		assert.notEqual(hashClientIp(SECRET, ip), createHash('sha256').update(ip).digest(plain));
	}
});

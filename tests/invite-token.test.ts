// Invite-link tokens and the password rule (src/lib/server/invite-token.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashToken, newToken, passwordProblem, TOKEN_PATTERN } from '../src/lib/server/invite-token.ts';

test('a new token fits the link pattern, its hash fits what the database accepts, and none repeat', () => {
	const seen = new Set<string>();
	for (let i = 0; i < 200; i++) {
		const { token, hash } = newToken();
		assert.match(token, TOKEN_PATTERN);
		assert.match(hash, /^[A-Za-z0-9_-]{43}$/, 'the pattern create_host_invite checks');
		assert.equal(hash, hashToken(token));
		assert.notEqual(hash, token, 'only the hash is stored');
		seen.add(token);
	}
	assert.equal(seen.size, 200);
});

test('the link pattern refuses anything that is not exactly a token', () => {
	for (const bad of ['', 'short', `${'a'.repeat(43)}x`, `${'a'.repeat(42)}!`, `${'a'.repeat(42)}/`]) {
		assert.doesNotMatch(bad, TOKEN_PATTERN, JSON.stringify(bad));
	}
});

test('passwords need 10 characters and at most 72 bytes', () => {
	assert.match(passwordProblem('x'.repeat(9)) ?? '', /at least 10/);
	assert.equal(passwordProblem('x'.repeat(10)), null);
	assert.equal(passwordProblem('x'.repeat(72)), null);
	assert.match(passwordProblem('x'.repeat(73)) ?? '', /at most 72/);
	// Counted in bytes, as bcrypt counts: 25 × 3-byte characters is 75 bytes.
	assert.match(passwordProblem('€'.repeat(25)) ?? '', /at most 72/);
});

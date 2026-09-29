import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashEmail, HOST_SESSION_SECONDS, hostArea, makeHostSession, readHostSession } from '../src/lib/server/host-session.ts';

const SECRET = 'host-secret-that-is-long-enough-for-hmac';
const USER = '2f1c9a52-8a8e-4c1e-9d3b-6c1f0e7a4b21';
const NOW = 1_790_000_000;

test('a host session reads back until it expires, then is refused', () => {
	const token = makeHostSession(SECRET, USER, NOW);
	assert.equal(readHostSession(SECRET, token, NOW), USER);
	assert.equal(readHostSession(SECRET, token, NOW + HOST_SESSION_SECONDS - 1), USER);
	assert.equal(readHostSession(SECRET, token, NOW + HOST_SESSION_SECONDS), null);
	assert.equal(HOST_SESSION_SECONDS, 12 * 60 * 60);
});

test('a host session is refused under another secret or when altered', () => {
	const token = makeHostSession(SECRET, USER, NOW);
	const [user, expires, signature] = token.split('.');
	assert.equal(readHostSession('another-secret', token, NOW), null);
	assert.equal(readHostSession(SECRET, `${user}.${Number(expires) + 3600}.${signature}`, NOW), null, 'extended expiry');
	assert.equal(readHostSession(SECRET, `9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4.${expires}.${signature}`, NOW), null, 'other user');
	for (const bad of [undefined, '', USER, `${USER}.${expires}`, `${USER}.soon.${signature}`, `${token}.extra`]) {
		assert.equal(readHostSession(SECRET, bad, NOW), null, String(bad));
	}
});

test('email hashes ignore case and spacing, and depend on the secret', () => {
	assert.equal(hashEmail(SECRET, ' Host@Example.com '), hashEmail(SECRET, 'host@example.com'));
	assert.notEqual(hashEmail(SECRET, 'host@example.com'), hashEmail(SECRET, 'other@example.com'));
	assert.notEqual(hashEmail(SECRET, 'host@example.com'), hashEmail('another-secret', 'host@example.com'));
});

test('host pages and APIs are guarded; participant and public routes are not', () => {
	const cases: [string, 'page' | 'api' | null][] = [
		['/decks', 'page'],
		['/decks/', 'page'],
		['/decks/3f2a', 'page'],
		['/run/ABCDE/control', 'page'],
		['/api/host', 'api'],
		['/api/host/decks', 'api'],
		['/api/r/ABCDE/host', 'api'],
		['/api/r/ABCDE/host/open', 'api'],
		['/', null],
		['/decksandmore', null],
		['/run/ABCDE', null],
		['/j/ABCDE', null],
		['/api/r/ABCDE/state', null],
		['/api/r/ABCDE/answer', null],
		['/api/r/ABCDE/hostile', null],
		['/api/hosts', null],
	];
	for (const [path, expected] of cases) assert.equal(hostArea(path), expected, path);
});

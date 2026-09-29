// allow_sign_in: the host sign-in brute-force guard (S6). Rolled back.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { connectAsOwner } from '../scripts/pg-connect.ts';
import { inRolledBackTransaction, skipWithoutDatabase as skip } from './db-helpers.ts';

let db: pg.Client;
before(async () => {
	if (!skip) db = await connectAsOwner();
});
after(async () => {
	await db?.end();
});

async function attempt(ipHash: string, emailHash: string): Promise<boolean> {
	return (await db.query('select public.allow_sign_in($1, $2) as allowed', [ipHash, emailHash])).rows[0].allowed;
}

test('one email gets 10 attempts per window, from any address', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const results = [];
		for (let i = 0; i < 11; i++) results.push(await attempt(`ip-${i}`, 'email-a'));
		assert.deepEqual(results, [...Array(10).fill(true), false]);
		assert.equal(await attempt('ip-new', 'email-b'), true, 'another email is unaffected');
	});
});

test('one address gets 30 attempts per window, across any emails', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const results = [];
		for (let i = 0; i < 31; i++) results.push(await attempt('ip-a', `email-${i}`));
		assert.deepEqual(results, [...Array(30).fill(true), false]);
		assert.equal(await attempt('ip-b', 'email-new'), true, 'another address is unaffected');
	});
});

test('refused attempts still count, and blank hashes are refused', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		for (let i = 0; i < 12; i++) await attempt('ip-a', 'email-a');
		const { rows } = await db.query(`select count from public.rate_limits where key = 'signin-email:email-a'`);
		assert.equal(rows[0].count, 12);
		assert.equal(await attempt('', 'email-z'), false);
		assert.equal(await attempt('ip-z', ''), false);
	});
});

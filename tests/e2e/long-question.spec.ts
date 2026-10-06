// A Q&A question may be up to 280 characters. The answer route once refused
// anything over 200 characters before it reached the database, so a longer
// question never arrived and the phone blamed the connection.
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import type pg from 'pg';
import { connectAsOwner } from '../../scripts/pg-connect.ts';
import { addHost, BASE, signIn, startSession, statusValue } from './helpers.ts';

const admin = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SECRET_KEY ?? '', {
	auth: { persistSession: false, autoRefreshToken: false },
}).auth.admin;

let db: pg.Client;
const hostEmail = `volley-e2e-long-${randomUUID()}@example.com`;
let hostPassword = '';
const suiteStart = new Date();

test.beforeAll(async () => {
	db = await connectAsOwner();
	hostPassword = addHost(hostEmail).password;
});

test.afterAll(async () => {
	const { rows } = await db.query('select id from auth.users where email = $1', [hostEmail]);
	for (const { id } of rows) await admin.deleteUser(id);
	await db.query(
		`delete from public.rate_limits
		 where (key like 'signin-%' or key like 'ip:%' or key like 'run:%') and window_start >= $1::timestamptz - interval '15 minutes'`,
		[suiteStart],
	);
	await db.end();
});

test('a Q&A question of the full 280 characters is accepted and reaches the list', async ({ browser }) => {
	const laptop = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 720 } });
	const control = await laptop.newPage();
	await signIn(control, hostEmail, hostPassword);
	await control.waitForURL('**/decks');
	const code = await startSession(control, [{ type: 'Q&A', question: 'Ask us anything' }]);
	await control.getByRole('button', { name: 'Open answers' }).click();
	await expect(statusValue(control, 'Answers')).toHaveText('Open');

	const long = 'Why does it matter so much that we ask this particular question out loud? '.repeat(4).slice(0, 280).trim();
	expect(long.length).toBeGreaterThan(200);
	const phone = await (await browser.newContext({ baseURL: BASE, viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })).newPage();
	await phone.goto(`/j/${code}`);
	await phone.getByLabel('Your question (anonymous)').fill(long);
	await phone.getByRole('button', { name: 'Ask' }).click();
	await expect(phone.locator('.question', { hasText: long.slice(0, 40) })).toBeVisible({ timeout: 8000 });
	await expect(phone.getByText("That didn't send")).toHaveCount(0);
});

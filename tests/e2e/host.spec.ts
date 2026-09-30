// S6: host sign-in, the host guard (A6) and the httpOnly session (A7). Makes
// real Supabase Auth users for the run and deletes them in afterAll.
import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import type pg from 'pg';
import { connectAsOwner } from '../../scripts/pg-connect.ts';
import { makeHostSession } from '../../src/lib/server/host-session.ts';
import { addHost, BASE, signIn } from './helpers.ts';

const HOST_API = '/api/r/ABCDE/host';
const admin = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SECRET_KEY ?? '', {
	auth: { persistSession: false, autoRefreshToken: false },
}).auth.admin;

let db: pg.Client;
const hostEmail = `volley-e2e-host-${randomUUID()}@example.com`;
const nonHostEmail = `volley-e2e-guest-${randomUUID()}@example.com`;
const nonHostPassword = randomBytes(18).toString('base64url');
let firstPassword = '';
let hostPassword = '';
let nonHostId = '';
const suiteStart = new Date();

async function hostCookie(page: Page) {
	return (await page.context().cookies(BASE)).find((cookie) => cookie.name === 'volley_host');
}

// In order: the first test creates the host the others sign in as.
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
	db = await connectAsOwner();
	// Confirmed, with a working password, but not a host: the worst case of a
	// public self-sign-up.
	const { data, error } = await admin.createUser({ email: nonHostEmail, password: nonHostPassword, email_confirm: true });
	if (error) throw error;
	nonHostId = data.user.id;
});

test.afterAll(async () => {
	const { rows } = await db.query('select id from auth.users where email = any($1)', [[hostEmail, nonHostEmail]]);
	for (const { id } of rows) await admin.deleteUser(id);
	await db.query(
		`delete from public.rate_limits where key like 'signin-%' and window_start >= $1::timestamptz - interval '15 minutes'`,
		[suiteStart],
	);
	await db.end();
});

test('add-host creates a host, and running it again resets the password', async () => {
	const first = addHost(hostEmail);
	expect(first.output).toContain('(new account)');
	const second = addHost(hostEmail);
	expect(second.output).toContain('(password reset)');
	expect(second.password).toHaveLength(32);
	expect(second.password).not.toBe(first.password);
	firstPassword = first.password;
	hostPassword = second.password;
	const { rows } = await db.query('select count(*)::int as n from public.hosts where email = $1', [hostEmail]);
	expect(rows[0].n).toBe(1);
});

test('a host signs in, reaches their decks and signs out; the session is httpOnly (A7)', async ({ page }) => {
	await signIn(page, hostEmail, firstPassword);
	await expect(page.getByRole('alert')).toHaveText('Email or password is incorrect.');

	await signIn(page, hostEmail, hostPassword);
	await page.waitForURL('**/decks');
	await expect(page.getByRole('heading', { name: 'Start a session' })).toBeVisible();
	await expect(page.getByText(`Signed in as ${hostEmail}`)).toBeVisible();

	expect(await page.evaluate(() => document.cookie)).not.toContain('volley_host');
	const cookie = await hostCookie(page);
	expect(cookie?.httpOnly).toBe(true);
	expect(cookie?.sameSite).toBe('Lax');
	expect(cookie?.path).toBe('/');
	const hoursLeft = ((cookie?.expires ?? 0) - Date.now() / 1000) / 3600;
	expect(hoursLeft).toBeGreaterThan(11.9);
	expect(hoursLeft).toBeLessThanOrEqual(12);

	expect((await page.request.get(HOST_API)).status(), 'guard passed; the route is built in S7').toBe(404);

	await page.getByRole('button', { name: 'Sign out' }).click();
	await page.waitForURL(`${BASE}/`);
	expect(await hostCookie(page)).toBeUndefined();
	await page.goto('/decks');
	await expect(page).toHaveURL(`${BASE}/`);
});

// Found through a flaky poll test: the page's start-up reset a type chosen
// before it finished loading, so a quick host on slow Wi-Fi got a word cloud.
test('an activity type chosen before the page finishes loading is kept', async ({ page }) => {
	await signIn(page, hostEmail, hostPassword);
	await page.waitForURL('**/decks');
	await page.context().route(/\.(js|ts|svelte)(\?|$)/, async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 300));
		await route.continue();
	});
	await page.goto('/decks', { waitUntil: 'commit' });
	await page.getByLabel('Activity 1 type').selectOption({ label: 'Poll' });
	await page.waitForLoadState('networkidle');
	// Settled, so a late reset would already have happened.
	await page.waitForTimeout(1000);
	await expect(page.getByLabel('Activity 1 type')).toHaveValue('poll');
	await expect(page.getByLabel('Activity 2 type'), 'the defaults still apply').toHaveValue('');
	await page.goto('/decks');
	await expect(page.getByLabel('Activity 1 type'), 'the defaults still apply').toHaveValue('word_cloud');
});

test('a wrong password gets a plain message and no session', async ({ page }) => {
	await signIn(page, hostEmail, 'not-the-password');
	await expect(page.getByRole('alert')).toHaveText('Email or password is incorrect.');
	await expect(page.getByLabel('Email'), 'the email is kept for the next try').toHaveValue(hostEmail);
	expect(await hostCookie(page)).toBeUndefined();
});

test("a signed-up account that isn't a host gets nowhere (A6)", async ({ page }) => {
	await signIn(page, nonHostEmail, nonHostPassword);
	await expect(page.getByRole('alert')).toHaveText("That account isn't a host on this Volley.");
	expect(await hostCookie(page)).toBeUndefined();

	// Even holding a valid session for that account, every host path is refused.
	const session = makeHostSession(process.env.HOST_SESSION_SECRET ?? '', nonHostId, Math.floor(Date.now() / 1000));
	await page.context().addCookies([{ name: 'volley_host', value: session, url: BASE, httpOnly: true }]);
	expect((await page.goto('/decks'))?.status()).toBe(403);
	expect((await page.request.get(HOST_API)).status()).toBe(403);
});

test('without a session, host pages send you to sign in and host APIs answer 401', async ({ page }) => {
	await page.goto('/decks');
	await expect(page).toHaveURL(`${BASE}/`);
	await expect(page.getByRole('heading', { name: 'Host sign-in' })).toBeVisible();
	expect((await page.request.get(HOST_API)).status()).toBe(401);
	expect((await page.request.get('/api/r/ABCDE/host/export')).status()).toBe(401);
	expect((await page.request.get('/run/ABCDE/control', { maxRedirects: 0 })).status()).toBe(303);
});

test('sign-in attempts for one email stop after 10 per 15 minutes', async ({ page }) => {
	const target = `volley-e2e-nobody-${randomUUID()}@example.com`;
	for (let i = 0; i < 10; i++) {
		await signIn(page, target, 'guess');
		await expect(page.getByRole('alert')).toHaveText('Email or password is incorrect.');
	}
	await signIn(page, target, 'guess');
	await expect(page.getByRole('alert')).toHaveText('Too many attempts. Wait 15 minutes, then try again.');
});

// ADR-011: an admin invites a host by link; the host sets their own password,
// is named on the projector, can be reset and removed. Real accounts, all
// deleted in afterAll.
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import type pg from 'pg';
import { connectAsOwner } from '../../scripts/pg-connect.ts';
import { addHost, BASE, signIn, startSession } from './helpers.ts';

const admin = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SECRET_KEY ?? '', {
	auth: { persistSession: false, autoRefreshToken: false },
}).auth.admin;
const PHONE = { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

let db: pg.Client;
const ownerEmail = `volley-e2e-owner-${randomUUID()}@example.com`;
const samEmail = `volley-e2e-sam-${randomUUID()}@example.com`;
let ownerPassword = '';
const suiteStart = new Date();

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
	db = await connectAsOwner();
	ownerPassword = addHost(ownerEmail).password;
	const made = spawnSync('node', ['--env-file=.env.local', 'scripts/set-host.mjs', ownerEmail, '--name', 'Owner', '--admin'], { encoding: 'utf8' });
	if (made.status !== 0) throw new Error(`set-host failed: ${made.stderr}`);
});

test.afterAll(async () => {
	const { rows } = await db.query('select id from auth.users where email = any($1)', [[ownerEmail, samEmail]]);
	for (const { id } of rows) await admin.deleteUser(id);
	await db.query(
		`delete from public.rate_limits
		 where (key like 'signin-%' or key like 'ip:%' or key like 'run:%') and window_start >= $1::timestamptz - interval '15 minutes'`,
		[suiteStart],
	);
	await db.end();
});

async function newVisitor(browser: Browser, options = {}): Promise<Page> {
	return (await browser.newContext({ baseURL: BASE, ...options })).newPage();
}

// Runs an action that makes a link and returns the new one. A previous link
// stays on screen, so wait for the box to change before reading it.
async function linkFor(owner: Page, action: () => Promise<void>): Promise<string> {
	const link = owner.getByRole('textbox', { name: 'Link', exact: true });
	const previous = (await link.count()) > 0 ? await link.inputValue() : '';
	await action();
	await expect(link).toBeVisible();
	await expect(link).not.toHaveValue(previous);
	return link.inputValue();
}

let ownerPage: Page;
let inviteLink = '';

test('an admin reaches Hosts from their sessions page and creates an invite link', async ({ browser }) => {
	ownerPage = await newVisitor(browser, { viewport: { width: 1280, height: 720 } });
	await signIn(ownerPage, ownerEmail, ownerPassword);
	await ownerPage.waitForURL('**/decks');
	await expect(ownerPage.getByText('Signed in as Owner')).toBeVisible();
	await ownerPage.getByRole('link', { name: 'Manage hosts' }).click();
	await expect(ownerPage.getByRole('heading', { name: 'Hosts', exact: true })).toBeVisible();
	await expect(ownerPage.getByRole('button', { name: /^Remove: Owner/ }), 'no removing yourself').toHaveCount(0);

	// A link shown once must survive other buttons being pressed meanwhile.
	await linkFor(ownerPage, async () => {
		await ownerPage.getByLabel('Their name, as shown on the big screen').fill('Temp');
		await ownerPage.getByLabel('Their email').fill(`temp-${samEmail}`);
		await ownerPage.getByRole('button', { name: 'Create invite link' }).click();
	});
	await ownerPage.getByRole('button', { name: 'Cancel link: Temp' }).click();
	await expect(ownerPage.getByRole('button', { name: 'Cancel link: Temp' })).toHaveCount(0);
	await expect(ownerPage.getByRole('heading', { name: 'Invite link for Temp' }), 'still on screen').toBeVisible();

	inviteLink = await linkFor(ownerPage, async () => {
		await ownerPage.getByLabel('Their name, as shown on the big screen').fill('Sam');
		await ownerPage.getByLabel('Their email').fill(samEmail);
		await ownerPage.getByRole('button', { name: 'Create invite link' }).click();
	});
	expect(inviteLink).toMatch(new RegExp(`^${BASE}/invite/[A-Za-z0-9_-]{43}$`));
	await expect(ownerPage.getByText(`Send this to ${samEmail}`)).toBeVisible();
	await expect(ownerPage.getByRole('button', { name: 'Cancel link: Sam' })).toBeVisible();
	await ownerPage.screenshot({ path: 'screenshots/hosts/hosts-page-link.png', fullPage: true });
});

test('the invitee sets their own password, is signed in, and the link then stops working', async ({ browser }) => {
	const sam = await newVisitor(browser, PHONE);
	await sam.goto(inviteLink);
	await expect(sam.getByRole('heading', { name: 'You’re invited to host' })).toBeVisible();
	await expect(sam.getByLabel('Email')).toHaveValue(samEmail);
	await expect(sam.getByLabel('Your name, as shown on the big screen')).toHaveValue('Sam');
	await sam.screenshot({ path: 'screenshots/hosts/invite-phone.png' });

	await sam.getByLabel(/Choose a password/).fill('short');
	await sam.getByRole('button', { name: 'Create my login' }).click();
	// The browser's own minlength check stops it before the server sees it.
	await expect(sam).toHaveURL(inviteLink);

	await sam.getByLabel(/Choose a password/).fill('first-password-123');
	// SvelteKit refuses a form POST whose Origin isn't the site's own, but only in
	// production builds; the dev server these tests use skips that check. So
	// check what the browser sends: a page with Referrer-Policy no-referrer
	// makes it send "Origin: null", which production refused on 2026-10-01.
	const posted = sam.waitForRequest((request) => request.method() === 'POST' && request.url().startsWith(inviteLink));
	await sam.getByRole('button', { name: 'Create my login' }).click();
	expect((await (await posted).allHeaders()).origin, 'the form post carries the site’s own origin').toBe(BASE);
	await sam.waitForURL('**/decks');
	await expect(sam.getByText('Signed in as Sam')).toBeVisible();
	await expect(sam.getByRole('link', { name: 'Manage hosts' }), 'not an admin').toHaveCount(0);
	expect((await sam.goto('/hosts'))?.status()).toBe(403);

	await sam.goto(inviteLink);
	await expect(sam.getByRole('heading', { name: 'This link has been used' })).toBeVisible();
	await expect(sam.getByLabel(/Choose a password/)).toHaveCount(0);
});

test("the projector names the host: 'Sam hosting'", async ({ browser }) => {
	const sam = await newVisitor(browser, { viewport: { width: 1280, height: 720 } });
	await signIn(sam, samEmail, 'first-password-123');
	await sam.waitForURL('**/decks');
	const code = await startSession(sam, [{ type: 'Word cloud', question: 'Named?' }]);
	const projector = await sam.context().newPage();
	await projector.goto(`/run/${code}`);
	await expect(projector.getByText(`Room ${code} · Sam hosting`)).toBeVisible();
});

test('a reset link replaces the password, ends the old sessions, and the old password stops working', async ({ browser }) => {
	const oldSession = await newVisitor(browser);
	await signIn(oldSession, samEmail, 'first-password-123');
	await oldSession.waitForURL('**/decks');

	await ownerPage.goto('/hosts');
	const resetLink = await linkFor(ownerPage, () => ownerPage.getByRole('button', { name: 'Reset password: Sam' }).click());
	await expect(ownerPage.getByRole('heading', { name: 'Password reset link for Sam' })).toBeVisible();

	const sam = await newVisitor(browser, PHONE);
	await sam.goto(resetLink);
	await expect(sam.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
	await sam.getByLabel(/New password/).fill('second-password-456');
	await sam.getByRole('button', { name: 'Save new password' }).click();
	await sam.waitForURL('**/decks');
	await expect(sam.getByText('Signed in as Sam'), 'the session the reset just made works').toBeVisible();

	await oldSession.goto('/decks');
	await expect(oldSession, 'signed out, and not bounced in a loop').toHaveURL(`${BASE}/`);
	await expect(oldSession.getByRole('heading', { name: 'Host sign-in' })).toBeVisible();

	const fresh = await newVisitor(browser);
	await signIn(fresh, samEmail, 'first-password-123');
	await expect(fresh.getByText('Email or password is incorrect.')).toBeVisible();
	await signIn(fresh, samEmail, 'second-password-456');
	await fresh.waitForURL('**/decks');
});

test('pressing Cancel on the remove prompt removes nobody', async () => {
	await ownerPage.goto('/hosts');
	ownerPage.once('dialog', (dialog) => dialog.dismiss());
	await ownerPage.getByRole('button', { name: 'Remove: Sam' }).click();
	await ownerPage.waitForTimeout(1500);
	await ownerPage.reload();
	await expect(ownerPage.getByRole('button', { name: 'Remove: Sam' }), 'Sam is still a host').toBeVisible();
	const { rows } = await db.query('select count(*)::int as n from public.hosts where email = $1', [samEmail]);
	expect(rows[0].n).toBe(1);
});

test('removing a host ends their access at once', async ({ browser }) => {
	const sam = await newVisitor(browser);
	await signIn(sam, samEmail, 'second-password-456');
	await sam.waitForURL('**/decks');

	await ownerPage.goto('/hosts');
	ownerPage.once('dialog', (dialog) => dialog.accept());
	await ownerPage.getByRole('button', { name: 'Remove: Sam' }).click();
	await expect(ownerPage.getByRole('button', { name: 'Remove: Sam' })).toHaveCount(0);

	expect((await sam.goto('/decks'))?.status(), 'the still-open session is refused').toBe(403);
	const { rows } = await db.query('select count(*)::int as n from auth.users where email = $1', [samEmail]);
	expect(rows[0].n, 'the Auth account is deleted too').toBe(0);
});

test('a made-up link is refused plainly', async ({ page }) => {
	await page.goto(`/invite/${'x'.repeat(43)}`);
	await expect(page.getByRole('heading', { name: 'This link isn’t valid' })).toBeVisible();
	await page.goto('/invite/not-a-token');
	await expect(page.getByRole('heading', { name: 'This link isn’t valid' })).toBeVisible();
});

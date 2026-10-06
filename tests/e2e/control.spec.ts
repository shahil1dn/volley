// The control page's layout (status, grouped controls, a separate End session),
// the one disabled look, and the upvote's tick on a phone. Real host account;
// its rooms go with it in afterAll.
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import type pg from 'pg';
import { connectAsOwner } from '../../scripts/pg-connect.ts';
import { addHost, BASE, signIn, startSession, statusValue, themeColour } from './helpers.ts';

const admin = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SECRET_KEY ?? '', {
	auth: { persistSession: false, autoRefreshToken: false },
}).auth.admin;

let db: pg.Client;
const hostEmail = `volley-e2e-control-${randomUUID()}@example.com`;
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

async function startAsHost(page: Page, activities: Parameters<typeof startSession>[1]) {
	await signIn(page, hostEmail, hostPassword);
	await page.waitForURL('**/decks');
	return startSession(page, activities);
}

const paint = (page: Page, name: string) =>
	page.getByRole('button', { name, exact: true }).evaluate((el) => {
		const style = getComputedStyle(el);
		return { colour: style.color, fill: style.backgroundColor, opacity: style.opacity };
	});

test('the status is labelled, the controls are grouped, and End session stands apart in red', async ({ browser }) => {
	const laptop = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 800 } });
	const control = await laptop.newPage();
	await startAsHost(control, [{ type: 'Word cloud', question: 'One word for AI?' }, { type: 'Q&A', question: 'Ask us anything' }]);

	await expect(statusValue(control, 'Session')).toHaveText('Not started');
	await expect(statusValue(control, 'Answers')).toHaveText('Closed');
	await expect(statusValue(control, 'Activity')).toHaveText('1 of 2');

	// The main action (Open answers here) lives in the pinned bar with the status, not in a group below.
	const main = control.getByRole('group', { name: 'Status and main action', exact: true });
	await expect(control.getByRole('group', { name: 'Answers', exact: true }), 'only Q&A has an Answers group').toHaveCount(0);
	const activity = control.getByRole('group', { name: 'Activity', exact: true });
	const input = control.getByRole('group', { name: 'Input', exact: true });
	await expect(main.getByRole('button')).toHaveText(['Open answers']);
	await expect(activity.getByRole('button')).toHaveText(['Previous', 'Next']);
	await expect(input.getByRole('button')).toHaveText(['Freeze input']);

	// End session is in none of the groups, sits below all of them, and is the only red control.
	const end = control.getByRole('button', { name: 'End session' });
	await expect(control.getByRole('group').getByRole('button', { name: 'End session' })).toHaveCount(0);
	const endTop = (await end.boundingBox())!.y;
	for (const group of [activity, input]) {
		const box = (await group.boundingBox())!;
		expect(endTop, 'below every group').toBeGreaterThanOrEqual(box.y + box.height);
	}
	const error = await themeColour(control, 'error');
	expect((await paint(control, 'End session')).colour).toBe(error);
	for (const name of ['Open answers', 'Previous', 'Next', 'Freeze input']) {
		expect((await paint(control, name)).colour, `${name} is not styled as destructive`).not.toBe(error);
	}

	// The one filled button is the next step on the answers: Open, then Close.
	const accent = await themeColour(control, 'accent');
	await control.getByRole('button', { name: 'Open answers' }).click();
	await expect(statusValue(control, 'Session')).toHaveText('Live');
	await expect(statusValue(control, 'Answers')).toHaveText('Open');
	for (const name of ['Close answers', 'Previous', 'Next', 'Freeze input', 'End session']) {
		const { fill } = await paint(control, name);
		expect(fill === accent, `${name} filled with the accent`).toBe(name === 'Close answers');
	}
	await control.getByRole('button', { name: 'Freeze input' }).click();
	await expect(statusValue(control, 'Session')).toHaveText('Frozen');
	await expect(statusValue(control, 'Answers'), 'freezing leaves the answers as they were').toHaveText('Open');

	// Disabled is one look: Previous (on the first activity) and, after the end, everything.
	const muted = await themeColour(control, 'muted');
	const surface = await themeColour(control, 'surface');
	expect(await paint(control, 'Previous')).toEqual({ colour: muted, fill: surface, opacity: '1' });
	control.once('dialog', (dialog) => dialog.accept());
	await end.click();
	await expect(statusValue(control, 'Session')).toHaveText('Ended');
	await expect(statusValue(control, 'Answers')).toHaveText('Closed');
	for (const name of ['End session', 'Close answers', 'Open answers']) {
		if ((await control.getByRole('button', { name, exact: true }).count()) === 0) continue;
		expect(await paint(control, name), `${name}, disabled`).toEqual({ colour: muted, fill: surface, opacity: '1' });
	}
});

test('an upvote shows a tick as well as the fill, and loses both when undone', async ({ browser }) => {
	const laptop = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 800 } });
	const control = await laptop.newPage();
	const code = await startAsHost(control, [{ type: 'Q&A', question: 'Ask us anything' }]);
	await control.getByRole('button', { name: 'Open answers' }).click();
	await expect(statusValue(control, 'Answers')).toHaveText('Open');

	const phone = await (await browser.newContext({ baseURL: BASE, viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })).newPage();
	await phone.goto(`/j/${code}`);
	await phone.getByLabel('Your question (anonymous)').fill('Is AI safe?');
	await phone.getByRole('button', { name: 'Ask' }).click();
	const upvote = phone.getByRole('button', { name: 'Upvote “Is AI safe?”' });
	await upvote.click({ timeout: 10_000 });
	await expect(upvote).toHaveAttribute('aria-pressed', 'true');
	await expect(upvote.locator('svg.btn__tick'), 'a tick, not only a colour').toBeVisible();
	await upvote.click();
	await expect(upvote).toHaveAttribute('aria-pressed', 'false');
	await expect(upvote.locator('svg.btn__tick')).toHaveCount(0);
});

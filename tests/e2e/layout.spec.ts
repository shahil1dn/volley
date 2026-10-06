// The two desktop layouts: /decks with a live "Your session" summary beside the list,
// and the control page with the status and main action pinned to the top.
// Real host account; its rooms go with it in afterAll.
import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import type pg from 'pg';
import { connectAsOwner } from '../../scripts/pg-connect.ts';
import { activityBox, addHost, BASE, builderReady, signIn, startSession, statusValue } from './helpers.ts';

const admin = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SECRET_KEY ?? '', {
	auth: { persistSession: false, autoRefreshToken: false },
}).auth.admin;

let db: pg.Client;
const hostEmail = `volley-e2e-layout-${randomUUID()}@example.com`;
let hostState: Awaited<ReturnType<BrowserContext['storageState']>>;
const suiteStart = new Date();

test.beforeAll(async ({ browser }) => {
	db = await connectAsOwner();
	const { password } = addHost(hostEmail);
	const context = await browser.newContext({ baseURL: BASE });
	const page = await context.newPage();
	await signIn(page, hostEmail, password);
	await page.waitForURL('**/decks');
	hostState = await context.storageState();
	await context.close();
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

async function hostPage(browser: Browser, width: number, height: number, path: string): Promise<Page> {
	const context = await browser.newContext({ baseURL: BASE, viewport: { width, height }, storageState: hostState, ...(width < 600 ? { isMobile: true, hasTouch: true } : {}) });
	const page = await context.newPage();
	await page.goto(path);
	return page;
}

const summaryOf = (page: Page) => page.getByRole('complementary', { name: 'Your session' });

test('the summary beside the activity list follows what is typed', async ({ browser }) => {
	const page = await hostPage(browser, 1440, 900, '/decks');
	await builderReady(page);
	const summary = summaryOf(page);
	await expect(summary).toContainText('1 of 10 activities');
	await expect(summary.getByRole('listitem')).toHaveCount(1);
	await expect(summary).toContainText('1 · Word cloud');
	await expect(summary).toContainText('No question yet');

	await activityBox(page, 1).getByLabel('Question', { exact: true }).fill('How was the week?');
	await expect(summary).toContainText('How was the week?');
	await expect(summary).not.toContainText('No question yet');

	await activityBox(page, 1).getByLabel('Type', { exact: true }).selectOption({ label: 'Poll' });
	await expect(summary).toContainText('1 · Poll · 2 options');
	await activityBox(page, 1).getByRole('button', { name: 'Add option' }).click();
	await expect(summary).toContainText('1 · Poll · 3 options');

	await page.getByRole('button', { name: 'Add activity' }).click();
	await expect(summary).toContainText('2 of 10 activities');
	await expect(summary.getByRole('listitem')).toHaveCount(2);
	await expect(summary).toContainText('2 · Word cloud');

	await page.getByRole('button', { name: 'Remove activity 1' }).click();
	await expect(summary.getByRole('listitem')).toHaveCount(1);
	await expect(summary).toContainText('1 of 10 activities');
	await expect(summary).not.toContainText('How was the week?');
});

test('the summary sits beside the list from 960px wide, stays in view, and drops under the list below it', async ({ browser }) => {
	const wide = await hostPage(browser, 960, 700, '/decks');
	await builderReady(wide);
	for (let n = 2; n <= 5; n++) await wide.getByRole('button', { name: 'Add activity' }).click();
	await wide.evaluate(() => window.scrollTo(0, 0));
	const list = wide.locator('.session__main');
	const listBox = (await list.boundingBox())!;
	const sideBox = (await summaryOf(wide).boundingBox())!;
	expect(sideBox.x, 'beside the list').toBeGreaterThanOrEqual(listBox.x + listBox.width);
	expect(sideBox.y, 'level with the top of the list').toBeLessThan(listBox.y + 200);
	await wide.evaluate(() => window.scrollTo(0, 900));
	const scrolled = (await summaryOf(wide).boundingBox())!;
	expect(scrolled.y, 'still in view after scrolling').toBeGreaterThanOrEqual(0);
	expect(scrolled.y).toBeLessThan(100);
	await expect(summaryOf(wide).getByRole('button', { name: 'Start session' }), 'with the Start button').toBeInViewport();

	const narrow = await hostPage(browser, 959, 700, '/decks');
	await builderReady(narrow);
	const narrowList = (await narrow.locator('.session__main').boundingBox())!;
	const below = (await summaryOf(narrow).boundingBox())!;
	expect(below.y, 'under the list').toBeGreaterThanOrEqual(narrowList.y + narrowList.height);
	expect(below.width, 'full width').toBeGreaterThan(narrowList.width - 2);

	const phone = await hostPage(browser, 375, 812, '/decks');
	await builderReady(phone);
	const phoneList = (await phone.locator('.session__main').boundingBox())!;
	const phoneSummary = (await summaryOf(phone).boundingBox())!;
	expect(phoneSummary.y).toBeGreaterThanOrEqual(phoneList.y + phoneList.height);
	expect(phoneSummary.x + phoneSummary.width, 'no sideways scroll').toBeLessThanOrEqual(375);
	await expect(summaryOf(phone).getByRole('button', { name: 'Start session' })).toBeVisible();
});

test('the control bar stays pinned to the top while the page scrolls, and its action still works', async ({ browser }) => {
	const setup = await hostPage(browser, 1280, 800, '/decks');
	const code = await startSession(setup, [{ type: 'Word cloud', question: 'One word?' }]);

	const control = await hostPage(browser, 1280, 420, `/run/${code}/control`);
	const bar = control.getByRole('group', { name: 'Status and main action', exact: true });
	await expect(bar).toBeVisible();
	const scrollable = await control.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
	expect(scrollable, 'the page is taller than the window, so scrolling means something').toBeGreaterThan(150);

	await control.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
	await expect(control.getByRole('heading', { name: 'One word?' }), 'the heading has scrolled away').not.toBeInViewport();
	const pinned = (await bar.boundingBox())!;
	expect(pinned.y, 'the bar is at the top of the window').toBeGreaterThanOrEqual(-1);
	expect(pinned.y).toBeLessThanOrEqual(1);
	await expect(statusValue(control, 'Session')).toBeInViewport();

	await expect(control.getByRole('button', { name: 'Open answers' }), 'one Open answers, in the bar, not a second copy below').toHaveCount(1);
	await bar.getByRole('button', { name: 'Open answers' }).click();
	await expect(statusValue(control, 'Session')).toHaveText('Live');
	await expect(statusValue(control, 'Answers')).toHaveText('Open');
	await expect(control.getByRole('button', { name: 'Close answers' }), 'one Close answers, in the bar').toHaveCount(1);
	await bar.getByRole('button', { name: 'Close answers' }).click();
	await expect(statusValue(control, 'Answers')).toHaveText('Closed');
});

test('on a Q&A session the bar holds Next question, and it puts the next question on the projector', async ({ browser }) => {
	const setup = await hostPage(browser, 1280, 800, '/decks');
	const code = await startSession(setup, [{ type: 'Q&A', question: 'Ask us anything' }]);
	const control = await hostPage(browser, 1280, 800, `/run/${code}/control`);
	await expect(control.getByRole('button', { name: 'Next question' }), 'one Next question, in the bar').toHaveCount(1);
	await expect(control.getByRole('group', { name: 'Status and main action', exact: true }).getByRole('button', { name: 'Next question' })).toBeVisible();
	await control.getByRole('group', { name: 'Answers', exact: true }).getByRole('button', { name: 'Open answers' }).click();
	await expect(statusValue(control, 'Session')).toHaveText('Live');

	const phoneContext = await browser.newContext({ baseURL: BASE, viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
	const phone = await phoneContext.newPage();
	await phone.goto(`/j/${code}`);
	await phone.getByLabel(/Your question/).fill('Does the bar work?');
	await phone.getByRole('button', { name: 'Ask' }).click();
	await expect(phone.getByText('Does the bar work?')).toBeVisible();

	const projector = await (await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } })).newPage();
	await projector.goto(`/run/${code}`);
	await expect(projector.getByText('1 question waiting')).toBeVisible({ timeout: 15_000 });
	await control.getByRole('group', { name: 'Status and main action', exact: true }).getByRole('button', { name: 'Next question' }).click();
	await expect(projector.getByRole('region', { name: 'Question on screen' })).toContainText('Does the bar work?', { timeout: 15_000 });
	await expect(control.locator('.control__badge')).toBeVisible();
});

test('on a phone the bar stays pinned, fits the screen, and keeps the action in reach', async ({ browser }) => {
	const setup = await hostPage(browser, 1280, 800, '/decks');
	const code = await startSession(setup, [{ type: 'Word cloud', question: 'One word?' }]);
	const control = await hostPage(browser, 375, 812, `/run/${code}/control`);
	const bar = control.getByRole('group', { name: 'Status and main action', exact: true });
	await expect(bar).toBeVisible();
	const box = (await bar.boundingBox())!;
	expect(box.x + box.width, 'no sideways scroll').toBeLessThanOrEqual(375);
	expect(box.height, 'a compact bar: its phone rules are on').toBeLessThan(122);
	await control.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
	await expect(bar.getByRole('button', { name: 'Open answers' })).toBeInViewport();
	await bar.getByRole('button', { name: 'Open answers' }).click();
	await expect(statusValue(control, 'Session')).toHaveText('Live');
});

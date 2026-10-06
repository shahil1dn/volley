// Empty, loading and failed states: what a phone, the projector, the control page
// and the /decks form say when the server can't be reached or answers badly.
// Real host account; its room goes with it in afterAll.
import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import type pg from 'pg';
import { connectAsOwner } from '../../scripts/pg-connect.ts';
import { addHost, BASE, signIn, startSession } from './helpers.ts';

const admin = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SECRET_KEY ?? '', {
	auth: { persistSession: false, autoRefreshToken: false },
}).auth.admin;
const PHONE = { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, baseURL: BASE };

let db: pg.Client;
const hostEmail = `volley-e2e-states-${randomUUID()}@example.com`;
let hostPassword = '';
const suiteStart = new Date();

// Signed in once: sign-in is rate-limited per email, and this file opens many pages as the host.
let hostState: Awaited<ReturnType<BrowserContext['storageState']>>;

test.beforeAll(async ({ browser }) => {
	db = await connectAsOwner();
	hostPassword = addHost(hostEmail).password;
	const context = await browser.newContext({ baseURL: BASE });
	const page = await context.newPage();
	await signIn(page, hostEmail, hostPassword);
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

async function visitor(browser: Browser, options: object = {}): Promise<[BrowserContext, Page]> {
	const context = await browser.newContext({ baseURL: BASE, ...options });
	return [context, await context.newPage()];
}

async function hostWithSession(browser: Browser, activities: Parameters<typeof startSession>[1]) {
	const [context, page] = await visitor(browser, { viewport: { width: 1280, height: 800 }, storageState: hostState });
	await page.goto('/decks');
	const code = await startSession(page, activities);
	return { context, page, code };
}

test('a phone says so when it loses the connection, and stops saying it when the connection is back', async ({ browser }) => {
	const { page: control, code } = await hostWithSession(browser, [{ type: 'Word cloud', question: 'One word?' }]);
	await control.getByRole('button', { name: 'Open answers' }).click();
	const [phoneContext, phone] = await visitor(browser, PHONE);
	await phone.goto(`/j/${code}`);
	await expect(phone.getByRole('textbox', { name: 'Your answer' })).toBeVisible();
	await expect(phone.getByRole('status')).toHaveCount(0);

	await phoneContext.setOffline(true);
	await expect(phone.getByRole('status')).toContainText('Connection lost', { timeout: 15_000 });
	await expect(phone.getByRole('textbox', { name: 'Your answer' }), 'the last view stays').toBeVisible();

	await phoneContext.setOffline(false);
	await expect(phone.getByRole('status')).toHaveCount(0, { timeout: 15_000 });
});

test('a phone that cannot reach the room at first says so instead of "Joining…" for ever', async ({ browser }) => {
	const [context, phone] = await visitor(browser, PHONE);
	await context.route('**/api/r/*/state', (route) => route.abort());
	await phone.goto('/j/ABCDE');
	await expect(phone.getByText("Can't reach the session. Trying again…")).toBeVisible({ timeout: 15_000 });
});

test('the projector shows Loading before it knows the room, Reconnecting when it loses it, and what an ended room had', async ({ browser }) => {
	const { page: control, code } = await hostWithSession(browser, [{ type: 'Word cloud', question: 'One word?' }]);

	const [loadingContext, loading] = await visitor(browser, { viewport: { width: 1440, height: 900 } });
	await loadingContext.route('**/api/r/*/state', () => undefined);
	await loading.goto(`/run/${code}`);
	await expect(loading.getByText('Loading…')).toBeVisible();
	await expect(loading.getByText('0 answers'), 'no count for a room it has not heard from').toHaveCount(0);
	await expect(loading.getByText('Answers will appear here')).toHaveCount(0);

	const [projectorContext, projector] = await visitor(browser, { viewport: { width: 1440, height: 900 } });
	await projector.goto(`/run/${code}`);
	await expect(projector.getByText('Starting soon')).toBeVisible();
	await projectorContext.setOffline(true);
	await expect(projector.getByText('Reconnecting…')).toBeVisible({ timeout: 15_000 });
	await projectorContext.setOffline(false);
	await expect(projector.getByText('Reconnecting…')).toHaveCount(0, { timeout: 15_000 });

	control.once('dialog', (dialog) => dialog.accept());
	await control.getByRole('button', { name: 'End session' }).click();
	await expect(projector.getByText('Session ended')).toBeVisible({ timeout: 10_000 });
	await expect(projector.getByText('No answers were sent.')).toBeVisible();
	await expect(projector.getByText('Answers will appear here')).toHaveCount(0);
});

test('a room code that does not exist: the projector has no join box and says to check the code', async ({ browser }) => {
	const [, projector] = await visitor(browser, { viewport: { width: 1440, height: 900 } });
	await projector.goto('/run/ZZZZZ');
	await expect(projector.getByRole('heading', { name: "We can't find that room" })).toBeVisible();
	await expect(projector.getByText('Check the code and try again.')).toBeVisible();
	await expect(projector.getByRole('img', { name: /QR code/ })).toHaveCount(0);
});

test('the control page says when it is offline or signed out, and loading never claims to be empty', async ({ browser }) => {
	const { context, page: control, code } = await hostWithSession(browser, [{ type: 'Word cloud', question: 'One word?' }]);
	await expect(control.getByRole('heading', { name: 'One word?' })).toBeVisible();
	await expect(control.getByRole('status')).toHaveCount(0);

	await context.setOffline(true);
	await expect(control.getByRole('status')).toContainText('Connection lost', { timeout: 15_000 });
	await control.getByRole('button', { name: 'Open answers' }).click();
	await expect(control.getByText('No connection. Try again.')).toBeVisible();
	await context.setOffline(false);
	await expect(control.getByRole('status')).toHaveCount(0, { timeout: 15_000 });

	await control.route('**/api/r/*/host', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"status":"signed_out"}' }));
	await expect(control.getByRole('alert').filter({ hasText: "You've been signed out" })).toBeVisible({ timeout: 15_000 });
	await expect(control.getByRole('link', { name: 'Sign in again' })).toHaveAttribute('href', '/');
	await control.unroute('**/api/r/*/host');

	const [loadingContext, loading] = await visitor(browser, { storageState: hostState, viewport: { width: 1280, height: 800 } });
	await loadingContext.route('**/api/r/*/host', () => undefined);
	await loading.goto(`/run/${code}/control`);
	await expect(loading.getByText('Loading…')).toBeVisible();
	await expect(loading.getByText('No answers yet.')).toHaveCount(0);
});

test('a failed Start session keeps what was typed and says what happened', async ({ browser }) => {
	const [context, decks] = await visitor(browser, { ...PHONE, storageState: hostState });
	await decks.goto('/decks');
	await expect(decks.getByRole('button', { name: 'Add activity' })).toBeEnabled();
	const question = decks.getByLabel('Question', { exact: true });
	await question.fill('A question that must survive');

	await context.route('**/decks?/startSession', (route) => route.abort());
	await decks.getByRole('button', { name: 'Start session' }).click();
	await expect(decks.getByRole('alert')).toContainText("couldn't confirm the session started");
	await expect(question, 'the form is still there, as typed').toHaveValue('A question that must survive');
	await expect(decks.getByRole('button', { name: 'Start session' }), 'and can be pressed again').toBeEnabled();
	await context.unroute('**/decks?/startSession');

	await context.route('**/decks?/startSession', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ type: 'error', error: { message: 'Internal Error' } }) }));
	await decks.getByRole('button', { name: 'Start session' }).click();
	await expect(decks.getByRole('alert')).toContainText("couldn't confirm the session started");
	await expect(question).toHaveValue('A question that must survive');
});

test('a page that does not exist gets the branded page with a way out, not a bare 404', async ({ browser }) => {
	const [, page] = await visitor(browser, PHONE);
	await page.goto('/no-such-page');
	await expect(page.getByRole('heading', { name: "We can't find that page" })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Join a session' })).toHaveAttribute('href', '/join');
	await expect(page.getByText('Volley', { exact: true }).first()).toBeVisible();
});

test('a signed-out host pressing Start is told they are signed out, with a way back, and keeps the form', async ({ browser }) => {
	const [context, decks] = await visitor(browser, { ...PHONE, storageState: hostState });
	await decks.goto('/decks');
	await expect(decks.getByRole('button', { name: 'Add activity' })).toBeEnabled();
	await decks.getByLabel('Question', { exact: true }).fill('Typed before the session ended');
	await context.clearCookies();
	await decks.getByRole('button', { name: 'Start session' }).click();
	await expect(decks.getByRole('alert')).toContainText("You've been signed out");
	await expect(decks.getByRole('alert')).not.toContainText('connection');
	await expect(decks.getByRole('link', { name: 'Sign in again' })).toHaveAttribute('href', '/');
	await expect(decks.getByLabel('Question', { exact: true })).toHaveValue('Typed before the session ended');
});

test('pressing Start again after a server error starts the session', async ({ browser }) => {
	const [context, decks] = await visitor(browser, { ...PHONE, storageState: hostState });
	await decks.goto('/decks');
	await expect(decks.getByRole('button', { name: 'Add activity' })).toBeEnabled();
	await decks.getByLabel('Question', { exact: true }).fill('Second try works');
	let failures = 1;
	await context.route('**/decks?/startSession', (route) =>
		failures-- > 0 ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ type: 'error', error: { message: 'Internal Error' } }) }) : route.continue(),
	);
	await decks.getByRole('button', { name: 'Start session' }).click();
	await expect(decks.getByRole('alert')).toContainText("couldn't confirm the session started");
	await decks.getByRole('button', { name: 'Start session' }).click();
	await decks.waitForURL(/\/run\/[A-Z0-9]{5}\/control$/);
	await expect(decks.getByRole('heading', { name: 'Second try works' })).toBeVisible();
});

test('a control page that is told on its first load that the host is signed out says so instead of Loading', async ({ browser }) => {
	const { context, code } = await hostWithSession(browser, [{ type: 'Word cloud', question: 'One word?' }]);
	const [freshContext, fresh] = await visitor(browser, { storageState: hostState, viewport: { width: 1280, height: 800 } });
	await freshContext.route('**/api/r/*/host', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"status":"signed_out"}' }));
	await fresh.goto(`/run/${code}/control`);
	await expect(fresh.getByRole('alert')).toContainText("You've been signed out");
	await expect(fresh.getByText('Loading…')).toHaveCount(0);
});

test('a host who is no longer a host is told so, not "Connection lost" for ever', async ({ browser }) => {
	const { context, page: control } = await hostWithSession(browser, [{ type: 'Word cloud', question: 'One word?' }]);
	await expect(control.getByRole('heading', { name: 'One word?' })).toBeVisible();
	await context.route('**/api/r/*/host', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: '{"status":"not_host"}' }));
	await expect(control.getByRole('alert')).toContainText("You're no longer a host on this Volley");
	await expect(control.getByText('Connection lost')).toHaveCount(0);
});

test('"We can\'t find that room" is not shown together with a connection-lost warning', async ({ browser }) => {
	const { page: control, code } = await hostWithSession(browser, [{ type: 'Word cloud', question: 'One word?' }]);
	await control.getByRole('button', { name: 'Open answers' }).click();

	const [phoneContext, phone] = await visitor(browser, PHONE);
	await phone.goto(`/j/${code}`);
	await expect(phone.getByRole('textbox', { name: 'Your answer' })).toBeVisible();
	const [projectorContext, projector] = await visitor(browser, { viewport: { width: 1440, height: 900 } });
	await projector.goto(`/run/${code}`);
	await expect(projector.getByText('Answers will appear here')).toBeVisible();
	const [controlContext, controlTwo] = await visitor(browser, { storageState: hostState, viewport: { width: 1280, height: 800 } });
	await controlTwo.goto(`/run/${code}/control`);
	await expect(controlTwo.getByRole('heading', { name: 'One word?' })).toBeVisible();

	for (const context of [phoneContext, projectorContext, controlContext]) await context.route(/\/api\/r\/[A-Z0-9]+\/(state|host)$/, (route) => route.fulfill({ status: 500, body: 'x' }));
	await expect(phone.getByRole('status')).toContainText('Connection lost', { timeout: 15_000 });
	await expect(projector.getByText('Reconnecting…')).toBeVisible({ timeout: 15_000 });
	await expect(controlTwo.getByRole('status')).toContainText('Connection lost', { timeout: 15_000 });

	for (const context of [phoneContext, projectorContext, controlContext]) {
		await context.unroute(/\/api\/r\/[A-Z0-9]+\/(state|host)$/);
		await context.route(/\/api\/r\/[A-Z0-9]+\/(state|host)$/, (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"No such room"}' }));
	}
	await expect(phone.getByRole('heading', { name: "We can't find that room" })).toBeVisible({ timeout: 15_000 });
	await expect(phone.getByRole('status')).toHaveCount(0);
	await expect(projector.getByRole('heading', { name: "We can't find that room" })).toBeVisible({ timeout: 15_000 });
	await expect(projector.getByText('Reconnecting…')).toHaveCount(0);
	await expect(controlTwo.getByRole('heading', { name: "We can't find that session" })).toBeVisible({ timeout: 15_000 });
	await expect(controlTwo.getByRole('status')).toHaveCount(0);
});

test('the projector shows the join box while the first poll is still slow', async ({ browser }) => {
	const { code } = await hostWithSession(browser, [{ type: 'Word cloud', question: 'One word?' }]);
	const [context, projector] = await visitor(browser, { viewport: { width: 1440, height: 900 } });
	await context.route('**/api/r/*/state', () => undefined);
	await projector.goto(`/run/${code}`);
	await expect(projector.getByText('Loading…')).toBeVisible();
	await expect(projector.getByRole('img', { name: /QR code/ })).toBeVisible();
	await expect(projector.getByText(code, { exact: true })).toBeVisible();
	await expect(projector.getByText('0 answers'), 'no count for a room it has not heard from').toHaveCount(0);
});

test('an action notice that came from a lost connection goes away when the connection returns', async ({ browser }) => {
	const { context, page: control } = await hostWithSession(browser, [{ type: 'Word cloud', question: 'One word?' }]);
	await expect(control.getByRole('heading', { name: 'One word?' })).toBeVisible();
	await context.route('**/api/r/*/host', (route) => route.abort());
	await control.getByRole('button', { name: 'Open answers' }).click();
	await expect(control.getByText('No connection. Try again.')).toBeVisible();
	await expect(control.getByRole('status')).toContainText('Connection lost', { timeout: 15_000 });
	await context.unroute('**/api/r/*/host');
	await expect(control.getByRole('status')).toHaveCount(0, { timeout: 15_000 });
	await expect(control.getByText('No connection. Try again.')).toHaveCount(0);
});

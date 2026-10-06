// Q&A on the projector, one question at a time (ADR-013), from the host's
// control page to the projector: the order, the progress line, the first and
// last edges, a second control tab pressing on stale information, and a very
// long question. Real host account; rooms go with it in afterAll.
import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import type pg from 'pg';
import { connectAsOwner } from '../../scripts/pg-connect.ts';
import { addHost, BASE, signIn, startSession, statusValue } from './helpers.ts';

const admin = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SECRET_KEY ?? '', {
	auth: { persistSession: false, autoRefreshToken: false },
}).auth.admin;
const PHONE = { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

let db: pg.Client;
const hostEmail = `volley-e2e-screen-${randomUUID()}@example.com`;
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

// A host with an open Q&A, a projector, and one phone per question asked.
async function room(browser: Browser, questions: string[]) {
	const laptop = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 720 } });
	const control = await laptop.newPage();
	await signIn(control, hostEmail, hostPassword);
	await control.waitForURL('**/decks');
	const code = await startSession(control, [{ type: 'Q&A', question: 'Ask us anything' }]);
	await control.getByRole('button', { name: 'Open answers' }).click();
	await expect(statusValue(control, 'Answers')).toHaveText('Open');
	const projector = await laptop.newPage();
	await projector.goto(`/run/${code}`);
	const phones: Page[] = [];
	for (const question of questions) {
		const phone = await (await browser.newContext({ ...PHONE, baseURL: BASE })).newPage();
		await phone.goto(`/j/${code}`);
		await phone.getByLabel('Your question (anonymous)').fill(question);
		await phone.getByRole('button', { name: 'Ask' }).click();
		phones.push(phone);
	}
	return { laptop, control, projector, phones, code };
}

const upvote = (phone: Page, question: string) => phone.getByRole('button', { name: `Upvote “${question}”` });

test('one question at a time, most votes first, with progress, a highlighted row and the edges said out loud', async ({ browser }) => {
	const { control, projector, phones } = await room(browser, ['Which model first?', 'Is it safe?', 'Do I need to code?']);
	// Votes: safe 2, model 1, code 0 (a phone doesn't vote on its own question's order here, only counts).
	await upvote(phones[0], 'Is it safe?').click({ timeout: 12_000 });
	await upvote(phones[2], 'Is it safe?').click({ timeout: 12_000 });
	await upvote(phones[1], 'Which model first?').click({ timeout: 12_000 });
	await expect(projector.getByText('3 questions waiting')).toBeVisible({ timeout: 5000 });
	await expect(projector.getByText('Up next')).toBeVisible();
	await expect(control.getByText('Nothing on screen · 3 waiting')).toBeVisible();
	await expect(control.getByRole('button', { name: 'Previous question' })).toBeEnabled();

	const onScreen = projector.getByRole('region', { name: 'Question on screen' });
	await control.getByRole('button', { name: 'Previous question' }).click();
	await expect(control.getByText('That is the first question shown.')).toBeVisible();

	const row = (text: string) => control.locator('li', { hasText: text });
	for (const [n, [text, votes]] of ([['Is it safe?', '2 votes'], ['Which model first?', '1 vote'], ['Do I need to code?', '0 votes']] as const).entries()) {
		await control.getByRole('button', { name: 'Next question' }).click();
		await expect(onScreen.getByText(text)).toBeVisible({ timeout: 3000 });
		await expect(onScreen.getByText(votes)).toBeVisible();
		await expect(onScreen.getByText(n === 2 ? 'No more questions waiting' : `${2 - n} more waiting`)).toBeVisible();
		await expect(control.getByText(`On screen: ${n + 1} of 3 · ${2 - n} waiting`)).toBeVisible();
		await expect(row(text), 'highlighted, with a word as well as a ring').toHaveAttribute('aria-current', 'true');
		await expect(row(text).getByText('On screen', { exact: true })).toBeVisible();
		await expect(control.locator('li[aria-current="true"]')).toHaveCount(1);
	}

	// At the end, Next says so and nothing moves.
	await control.getByRole('button', { name: 'Next question' }).click();
	await expect(control.getByText('No more questions are waiting.')).toBeVisible();
	await expect(onScreen.getByText('Do I need to code?')).toBeVisible();

	// Previous steps back through them, without un-answering anything.
	await control.getByRole('button', { name: 'Previous question' }).click();
	await expect(onScreen.getByText('Which model first?')).toBeVisible({ timeout: 3000 });
	await control.getByRole('button', { name: 'Previous question' }).click();
	await expect(onScreen.getByText('Is it safe?')).toBeVisible({ timeout: 3000 });
	await control.getByRole('button', { name: 'Previous question' }).click();
	await expect(control.getByText('That is the first question shown.')).toBeVisible();
	await expect(onScreen.getByText('Is it safe?')).toBeVisible();
});

test('a second control tab pressing Next on stale information cannot skip a question', async ({ browser }) => {
	const { laptop, control, projector } = await room(browser, ['First?', 'Second?']);
	await expect(projector.getByText('2 questions waiting')).toBeVisible({ timeout: 5000 });
	const second = await laptop.newPage();
	await second.goto(control.url());
	await expect(second.getByRole('button', { name: 'Next question' })).toBeEnabled();
	// This tab stops refreshing, so it still believes nothing is on screen.
	await second.route('**/api/r/*/host', (route) => (route.request().method() === 'GET' ? route.abort() : route.continue()));

	await control.getByRole('button', { name: 'Next question' }).click();
	const onScreen = projector.getByRole('region', { name: 'Question on screen' });
	await expect(onScreen.getByText(/First\?|Second\?/)).toBeVisible({ timeout: 3000 });
	const first = (await onScreen.locator('.qna1__text').textContent())?.trim();

	await second.getByRole('button', { name: 'Next question' }).click();
	await expect(second.getByText('The projector had already moved.')).toBeVisible();
	await projector.waitForTimeout(1500);
	expect((await onScreen.locator('.qna1__text').textContent())?.trim(), 'the stale press moved nothing').toBe(first);
});

test('a question of the full 280 characters shrinks to fit the projector instead of running off it', async ({ browser }) => {
	const long = `${'Why does it matter so much that we ask this particular question out loud '.repeat(4)}`.slice(0, 280).trim();
	const { control, projector } = await room(browser, [long]);
	await expect(projector.getByText('1 question waiting')).toBeVisible({ timeout: 5000 });
	await control.getByRole('button', { name: 'Next question' }).click();
	const body = projector.locator('.qna1__body');
	await expect(body.locator('.qna1__text')).toContainText('Why does it matter', { timeout: 3000 });
	await projector.waitForTimeout(500);
	const fits = await body.evaluate((el) => ({ over: el.scrollHeight > el.clientHeight + 1, wide: el.scrollWidth > el.clientWidth + 1 }));
	expect(fits).toEqual({ over: false, wide: false });
});

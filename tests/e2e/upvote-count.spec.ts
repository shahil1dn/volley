// A phone shows the vote count the server returns the moment an upvote lands,
// instead of waiting up to a poll (3s) for it, and a poll that carries an older
// count (the edge cache serves copies a second or more old) cannot step it back.
// Real host account; its room goes with it in afterAll.
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import type pg from 'pg';
import { connectAsOwner } from '../../scripts/pg-connect.ts';
import { addHost, BASE, signIn, startSession, statusValue } from './helpers.ts';

const admin = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SECRET_KEY ?? '', {
	auth: { persistSession: false, autoRefreshToken: false },
}).auth.admin;
const PHONE = { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const POLL_MS = 3000;

let db: pg.Client;
const hostEmail = `volley-e2e-count-${randomUUID()}@example.com`;
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

// The count shown beside the question, as a number.
const shownVotes = async (phone: Page) => Number(/^(\d+)/.exec(await phone.locator('.question__votes').first().innerText())?.[1]);

// Samples the shown count every 40ms for `ms`, with the time since `since`.
async function watch(phone: Page, ms: number, since: number) {
	const seen: { votes: number; at: number }[] = [];
	const end = Date.now() + ms;
	while (Date.now() < end) {
		seen.push({ votes: await shownVotes(phone), at: Date.now() - since });
		await phone.waitForTimeout(40);
	}
	return seen;
}

test('an upvote shows the new count at once, and a stale poll cannot roll it back', async ({ browser }) => {
	test.setTimeout(90_000);
	const laptop = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 720 } });
	const control = await laptop.newPage();
	await signIn(control, hostEmail, hostPassword);
	await control.waitForURL('**/decks');
	const code = await startSession(control, [{ type: 'Q&A', question: 'Ask us anything' }]);
	await control.getByRole('button', { name: 'Open answers' }).click();
	await expect(statusValue(control, 'Answers')).toHaveText('Open');

	const asker = await (await browser.newContext({ ...PHONE, baseURL: BASE })).newPage();
	await asker.goto(`/j/${code}`);
	await asker.getByLabel('Your question (anonymous)').fill('Counting?');
	await asker.getByRole('button', { name: 'Ask' }).click();

	const voter = await (await browser.newContext({ ...PHONE, baseURL: BASE })).newPage();
	// Every state the voter fetches is passed through and remembered, so a copy
	// can be served back later the way an edge cache would: old, with an Age.
	let last = { body: '', madeAt: 0 };
	let serveStale: { body: string; madeAt: number } | null = null;
	await voter.route('**/api/r/*/state', async (route) => {
		if (serveStale) {
			// An honest cache copy: its Age is how long ago it was made, so it keeps
			// getting older instead of claiming a fixed age.
			const age = Math.ceil((Date.now() - serveStale.madeAt) / 1000);
			await route.fulfill({ status: 200, contentType: 'application/json', headers: { age: String(age) }, body: serveStale.body });
			return;
		}
		const response = await route.fetch();
		last = { body: await response.text(), madeAt: Date.now() };
		await route.fulfill({ response, body: last.body });
	});
	await voter.goto(`/j/${code}`);
	const upvote = voter.getByRole('button', { name: 'Upvote “Counting?”' });
	await expect(upvote).toBeVisible({ timeout: 12_000 });
	expect(await shownVotes(voter)).toBe(0);
	const before = { ...last };

	// UP: the count moves well inside one poll, and then a stale copy (0 votes) comes back.
	await upvote.click();
	const upAt = Date.now();
	await expect(upvote).toHaveAttribute('aria-pressed', 'true');
	serveStale = before;
	const up = await watch(voter, POLL_MS * 2 + 1000, upAt);
	const first = up.find((sample) => sample.votes === 1);
	expect(first, 'the new count appeared').toBeDefined();
	expect(first!.at, 'well under one poll').toBeLessThan(POLL_MS / 3);
	expect(up.filter((sample) => sample.at >= first!.at).map((sample) => sample.votes), 'never back to 0').not.toContain(0);

	// The real state catches up and agrees.
	serveStale = null;
	await expect.poll(async () => (await voter.locator('main').innerText()).includes('1 vote'), { timeout: 8000 }).toBe(true);
	const withVote = { ...last };
	expect(await shownVotes(voter)).toBe(1);

	// DOWN: taking the vote back shows 0 at once, and a stale copy (1 vote) cannot bring the 1 back.
	await upvote.click();
	const downAt = Date.now();
	await expect(upvote).toHaveAttribute('aria-pressed', 'false');
	serveStale = withVote;
	const down = await watch(voter, POLL_MS * 2 + 1000, downAt);
	const gone = down.find((sample) => sample.votes === 0);
	expect(gone, 'the lower count appeared').toBeDefined();
	expect(gone!.at).toBeLessThan(POLL_MS / 3);
	expect(down.filter((sample) => sample.at >= gone!.at).map((sample) => sample.votes), 'never back to 1').not.toContain(1);
});

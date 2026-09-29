// S5: phones join a room and answer (SPEC 10–13). Uses the dev database in
// .env.local; every room made here is committed, because the dev server reads
// it on another connection, and deleted in afterAll.
import { expect, test, type Browser, type Page } from '@playwright/test';
import type pg from 'pg';
import { connectAsOwner } from '../../scripts/pg-connect.ts';
import { MESSAGES } from '../../src/lib/room-client.ts';
import { makeRun, type TestRun } from '../db-helpers.ts';

const PHONE = { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
// Outside test-results, which Playwright empties at the start of every run.
const SCREENS = 'screenshots/s5';
const PROMPT = 'One word for AI?';

let db: pg.Client;
const rooms: TestRun[] = [];
const suiteStart = new Date();

test.beforeAll(async () => {
	db = await connectAsOwner();
});

test.afterAll(async () => {
	for (const room of rooms) await db.query('delete from auth.users where id = $1', [room.userId]);
	await db.query(
		`delete from public.rate_limits
		 where key = any($1) or (key like 'ip:%' and window_start >= $2::timestamptz - interval '10 seconds')`,
		[rooms.map((room) => `run:${room.runId}`), suiteStart],
	);
	await db.end();
});

async function newRoom(options: Parameters<typeof makeRun>[1] = {}) {
	const room = await makeRun(db, { settings: { prompt: PROMPT }, ...options });
	rooms.push(room);
	return room;
}

async function newPhone(browser: Browser): Promise<Page> {
	const context = await browser.newContext({ ...PHONE, baseURL: 'http://localhost:5174' });
	return context.newPage();
}

async function sendWord(page: Page, word: string) {
	await page.getByRole('textbox', { name: 'Your answer' }).fill(word);
	await page.getByRole('button', { name: 'Send' }).click();
}

async function count(sql: string, params: unknown[]) {
	return Number((await db.query(sql, params)).rows[0].count);
}

test('three phones join and answer, and each is limited to 3', async ({ browser }) => {
	const room = await newRoom();
	const phones = await Promise.all([1, 2, 3].map(() => newPhone(browser)));
	for (const page of phones) {
		await page.goto(`/j/${room.code}`);
		await expect(page.getByRole('heading', { name: PROMPT })).toBeVisible();
	}
	await phones[0].getByRole('textbox', { name: 'Your answer' }).fill('robots');
	await phones[0].screenshot({ path: `${SCREENS}/2-answering.png` });

	for (const [page, word] of phones.map((page, i) => [page, ['robots', 'ethics', 'python'][i]] as const)) {
		await sendWord(page, word);
		await expect(page.getByText(`Sent: ${word}. 2 left.`)).toBeVisible();
	}
	await phones[0].screenshot({ path: `${SCREENS}/3-sent.png` });

	expect(await count('select count(*) from public.responses where run_id = $1', [room.runId])).toBe(3);
	const { rows } = await db.query('select key from public.tallies where run_id = $1 order by key', [room.runId]);
	expect(rows.map((row) => row.key)).toEqual(['ethics', 'python', 'robots']);

	await sendWord(phones[0], 'drones');
	await expect(phones[0].getByText('Sent: robots, drones. 1 left.')).toBeVisible();
	await sendWord(phones[0], 'chips');
	await expect(phones[0].getByText(MESSAGES.limit)).toBeVisible();
	await expect(phones[0].getByRole('textbox', { name: 'Your answer' })).toHaveCount(0);
	await phones[0].screenshot({ path: `${SCREENS}/4-limit-reached.png` });
	expect(await count('select count(*) from public.responses where run_id = $1', [room.runId])).toBe(5);
});

test('a phone waits until the item opens, then shows the question', async ({ browser }) => {
	const room = await newRoom({ itemState: 'closed' });
	const page = await newPhone(browser);
	await page.goto(`/j/${room.code}`);
	await expect(page.getByRole('heading', { name: 'Waiting for the next question' })).toBeVisible();
	await page.screenshot({ path: `${SCREENS}/1-waiting.png` });

	await db.query(`update public.runs set item_state = 'open' where id = $1`, [room.runId]);
	await expect(page.getByRole('heading', { name: PROMPT })).toBeVisible({ timeout: 10_000 });
});

test('an answer whose reply is lost is retried with the same id and stored once', async ({ browser }) => {
	const room = await newRoom();
	const page = await newPhone(browser);
	const submitIds: string[] = [];
	let lostReplyStatus: number | null = null;
	await page.route(`**/api/r/${room.code}/answer`, async (route) => {
		if (route.request().method() !== 'POST') return route.continue();
		submitIds.push(JSON.parse(route.request().postData() ?? '{}').submitId);
		if (lostReplyStatus === null) {
			// The server receives and stores it; the phone never hears back.
			lostReplyStatus = (await route.fetch()).status();
			return route.abort('connectionreset');
		}
		return route.continue();
	});

	await page.goto(`/j/${room.code}`);
	await sendWord(page, 'retry');
	await expect(page.getByText('Sent: retry. 2 left.')).toBeVisible();

	expect(lostReplyStatus, 'the first attempt reached the server and was stored').toBe(200);
	expect(submitIds).toHaveLength(2);
	expect(submitIds[1]).toBe(submitIds[0]);
	expect(await count('select count(*) from public.responses where run_id = $1', [room.runId])).toBe(1);
	expect(await count(`select count from public.tallies where run_id = $1 and key = 'retry'`, [room.runId])).toBe(1);
});

test("a phone with a wrong clock still learns the server's time", async ({ browser }) => {
	const room = await newRoom();
	const page = await newPhone(browser);
	// This phone's clock runs an hour fast.
	await page.addInitScript(() => {
		const realNow = Date.now;
		Date.now = () => realNow() + 3_600_000;
	});
	await page.goto(`/j/${room.code}`);
	await expect(page.getByRole('heading', { name: PROMPT })).toBeVisible();
	const offset = Number(await page.locator('main').getAttribute('data-clock-offset'));
	expect(Math.abs(offset + 3_600_000)).toBeLessThan(30_000);
});

test('an unknown room gets a friendly page', async ({ browser }) => {
	const page = await newPhone(browser);
	await page.goto('/j/ZZZZZ');
	await expect(page.getByRole('heading', { name: "We can't find that room" })).toBeVisible();
});

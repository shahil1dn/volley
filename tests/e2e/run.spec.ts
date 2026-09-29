// S7 / A8: a host runs a word cloud from the control view while phones answer
// and the projector follows. Uses a real host account and committed rooms,
// all deleted in afterAll.
import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import type pg from 'pg';
import { connectAsOwner } from '../../scripts/pg-connect.ts';
import { makeRun, type TestRun } from '../db-helpers.ts';
import { addHost, BASE, signIn } from './helpers.ts';

const PHONE = { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const SCREENS = 'screenshots/s7';
const PROMPT = 'One word for AI?';
const admin = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SECRET_KEY ?? '', {
	auth: { persistSession: false, autoRefreshToken: false },
}).auth.admin;

// 40 base words of varied length, each in three forms: 120 distinct answers.
const BASE_WORDS = [
	'robots', 'ethics', 'python', 'data', 'bias', 'chatbots', 'automation', 'privacy', 'vision', 'agents',
	'creativity', 'jobs', 'safety', 'models', 'training', 'tokens', 'hype', 'future', 'research', 'startups',
	'art', 'music', 'code', 'health', 'climate', 'education', 'search', 'translation', 'speech', 'games',
	'maths', 'energy', 'chips', 'cloud', 'open source', 'regulation', 'trust', 'memory', 'reasoning', 'fun',
];
const WORDS_120 = BASE_WORDS.flatMap((word) => [word, `${word} tools`, `more ${word}`]);

let db: pg.Client;
const hostEmail = `volley-e2e-host-${randomUUID()}@example.com`;
let hostPassword = '';
const rooms: TestRun[] = [];
const suiteStart = new Date();

test.beforeAll(async () => {
	db = await connectAsOwner();
	hostPassword = addHost(hostEmail).password;
});

test.afterAll(async () => {
	const { rows } = await db.query('select id from auth.users where email = $1', [hostEmail]);
	for (const { id } of rows) await admin.deleteUser(id);
	for (const room of rooms) await db.query('delete from auth.users where id = $1', [room.userId]);
	await db.query(
		`delete from public.rate_limits
		 where key like 'signin-%' and window_start >= $1::timestamptz - interval '15 minutes'
		    or key like 'ip:%' and window_start >= $1::timestamptz - interval '10 seconds'
		    or key = any($2)`,
		[suiteStart, rooms.map((room) => `run:${room.runId}`)],
	);
	await db.end();
});

async function newPhone(browser: Browser): Promise<Page> {
	return (await browser.newContext({ ...PHONE, baseURL: BASE })).newPage();
}

async function sendWord(page: Page, word: string) {
	await page.getByRole('textbox', { name: 'Your answer' }).fill(word);
	await page.getByRole('button', { name: 'Send' }).click();
	await expect(page.getByText(`Sent: ${word}.`)).toBeVisible();
}

test('A8: phones answer and the projector follows; hide, freeze and end reach every screen', async ({ browser }) => {
	const laptop = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 720 } });
	const control = await laptop.newPage();
	await signIn(control, hostEmail, hostPassword);
	await control.waitForURL('**/decks');
	await control.getByLabel('Question').fill(PROMPT);
	await control.getByRole('button', { name: 'Start a test run' }).click();
	await control.waitForURL(/\/run\/[A-Z0-9]{5}\/control$/);
	const code = /\/run\/([A-Z0-9]{5})\/control$/.exec(control.url())?.[1] ?? '';
	await control.getByRole('button', { name: 'Open answers' }).click();
	await expect(control.getByText('Session: live. Answers: open.')).toBeVisible();

	const projector = await laptop.newPage();
	await projector.goto(`/run/${code}`);
	await expect(projector.getByRole('heading', { name: PROMPT })).toBeVisible();
	const cloud = projector.getByRole('list', { name: 'Word cloud' });

	const phones = await Promise.all([1, 2, 3].map(() => newPhone(browser)));
	const words = ['robots', 'ethics', 'python'];
	for (const [i, phone] of phones.entries()) {
		await phone.goto(`/j/${code}`);
		await sendWord(phone, words[i]);
	}
	// Within 3 seconds of the last answer, with no reload.
	for (const word of words) await expect(cloud.getByText(word, { exact: true })).toBeVisible({ timeout: 3000 });
	await expect(projector.getByText('3 answers')).toBeVisible({ timeout: 3000 });

	await control.getByRole('button', { name: 'Hide “robots”' }).click();
	await expect(cloud.getByText('robots', { exact: true })).toHaveCount(0, { timeout: 3000 });
	await expect(control.getByRole('button', { name: 'Unhide “robots”' })).toBeVisible();

	await control.getByRole('button', { name: 'Freeze input' }).click();
	// Phones poll every 3 seconds (SPEC 15).
	for (const phone of phones) await expect(phone.getByRole('heading', { name: 'Answers are paused' })).toBeVisible({ timeout: 5000 });
	await expect(projector.getByText('Answers paused')).toBeVisible({ timeout: 3000 });

	control.once('dialog', (dialog) => dialog.accept());
	await control.getByRole('button', { name: 'End session' }).click();
	for (const phone of phones) await expect(phone.getByRole('heading', { name: "That's a wrap" })).toBeVisible({ timeout: 5000 });
	await expect(projector.getByText('Session ended')).toBeVisible({ timeout: 3000 });
	await expect(cloud.getByText('ethics', { exact: true }), 'the results stay on screen').toBeVisible();
});

test('the projector fits a full cloud on screen at 1280×720 and 1024×768', async ({ browser }) => {
	const room = await makeRun(db, { settings: { prompt: 'What does AI mean to you?' } });
	rooms.push(room);
	// 40 phones, 3 different words each, all through submit_answer.
	for (let phone = 0; phone < 40; phone++) {
		const participant = randomUUID();
		for (const word of WORDS_120.slice(phone * 3, phone * 3 + 3)) {
			await db.query('select public.submit_answer($1, $2, $3, $4, $5)', [room.code, participant, randomUUID(), word, 'fit-test']);
		}
	}
	const { rows } = await db.query('select count(*)::int as n from public.tallies where run_id = $1', [room.runId]);
	expect(rows[0].n).toBe(120);

	for (const [width, height] of [[1280, 720], [1024, 768]]) {
		const page = await (await browser.newContext({ baseURL: BASE, viewport: { width, height } })).newPage();
		await page.goto(`/run/${room.code}`);
		const words = page.locator('.cloud__word');
		// The shared state sends the top 100 words (S4).
		await expect(words).toHaveCount(100);
		await page.waitForTimeout(600); // let the pop-in animation settle before measuring
		const fit = await page.evaluate(() => {
			const cloud = document.querySelector('.cloud') as HTMLElement;
			const box = cloud.getBoundingClientRect();
			const outside = [...cloud.querySelectorAll('.cloud__word')].filter((word) => {
				const r = word.getBoundingClientRect();
				return r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5;
			}).length;
			return {
				outside,
				cloudOverflows: cloud.scrollHeight > cloud.clientHeight || cloud.scrollWidth > cloud.clientWidth,
				pageScrolls: document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth,
				fit: Number(getComputedStyle(cloud).getPropertyValue('--fit')),
			};
		});
		expect(fit, `${width}×${height}`).toMatchObject({ outside: 0, cloudOverflows: false, pageScrolls: false });
		expect(fit.fit, 'words are shrunk only as far as needed, not to the floor').toBeGreaterThan(0.2);
		await page.screenshot({ path: `${SCREENS}/projector-${width}x${height}-100-words.png` });
	}
});

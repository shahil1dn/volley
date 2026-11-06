// The projector's feedback results (ADR-018) show every question at once, on a screen that can't
// scroll, and each chart's bars must be tall enough to show the shape of the answers: a count of 1
// beside a count of 3 has to look different. The worst case is the longest form: 6 questions, a
// 140-character title and an 80-character question. The room code stays on screen, because people
// may still join for later activities. Eight phones answer through the same route the phone page
// uses. The host account is deleted in afterAll, with its sessions.
import { randomUUID } from 'node:crypto';
import { expect, request, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { activityBox, addHost, BASE, builderReady, signIn, statusValue } from './helpers.ts';
import { MAX_FORM_QUESTION_CHARS, MAX_FORM_QUESTIONS, MAX_PROMPT_CHARS } from '../../src/lib/session-limits.ts';

const SCALE_NAMES = { stars: 'Stars, 1 to 5', ten: '1 to 10', words: 'Very bad to Very good' } as const;
type Scale = keyof typeof SCALE_NAMES;
const TITLE = "What did you think of today's workshop on building with AI agents, from the first live demo to the hands-on session, and the closing panels?";
// The long question on the 10-point scale (the most bars) and a worded scale in each row, whose labels are the widest.
const SIX: { text: string; scale: Scale }[] = [
	{ text: 'How useful were the hands-on exercises for the work you are planning next month?', scale: 'ten' },
	{ text: 'The talk', scale: 'words' },
	{ text: 'The slides', scale: 'stars' },
	{ text: 'The room', scale: 'ten' },
	{ text: 'The food', scale: 'words' },
	{ text: 'Would you come again?', scale: 'stars' },
];
const THREE = SIX.slice(0, 3);
// Eight people's ratings on each scale: a shape with 1s, 2s and a 4 in it.
const RATINGS: Record<Scale, number[]> = {
	stars: [5, 4, 4, 3, 5, 4, 2, 4],
	ten: [9, 8, 10, 7, 8, 9, 6, 8],
	words: [4, 3, 5, 4, 4, 2, 5, 4],
};
// The shortest bar track allowed at each projector size.
const SIZES = [
	{ width: 1920, height: 1080, minTrack: 120 },
	{ width: 1280, height: 720, minTrack: 80 },
];

const admin = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SECRET_KEY ?? '', {
	auth: { persistSession: false, autoRefreshToken: false },
}).auth.admin;
const hostEmail = `volley-e2e-form-results-${randomUUID()}@example.com`;
let hostPassword = '';

test.beforeAll(() => {
	hostPassword = addHost(hostEmail).password;
});

test.afterAll(async () => {
	const { data } = await admin.listUsers({ perPage: 1000 });
	for (const user of data.users.filter((u) => u.email === hostEmail)) await admin.deleteUser(user.id);
});

// Each phone has its own cookie, as a real one would: join, then send the whole form.
async function eightPhonesAnswer(code: string, questions: { scale: Scale }[]) {
	for (let p = 0; p < 8; p++) {
		const phone = await request.newContext({ baseURL: BASE });
		await phone.get(`/api/r/${code}/answer`);
		const value = JSON.stringify(questions.map(({ scale }, q) => RATINGS[scale][(p + q) % 8]));
		const sent = await phone.post(`/api/r/${code}/answer`, { data: { submitId: randomUUID(), value } });
		expect((await sent.json()).status).toBe('ok');
		await phone.dispose();
	}
}

const trackHeights = (projector: Page) =>
	projector.locator('.form-result__track').evaluateAll((tracks) => tracks.map((track) => track.getBoundingClientRect().height));

// At each size: every track at least its floor, nothing scrolls, nothing is cut off, the header
// stays clear of the charts, and the room code is on screen.
async function checkSizes(projector: Page, code: string, questions: { scale: Scale }[]) {
	for (const { width, height, minTrack } of SIZES) {
		await projector.setViewportSize({ width, height });
		await expect(projector.locator('.form-result__track')).toHaveCount(questions.reduce((sum, { scale }) => sum + (scale === 'ten' ? 10 : 5), 0));
		await expect.poll(async () => Math.min(...(await trackHeights(projector))), { message: `shortest bar track at ${width}x${height}` }).toBeGreaterThanOrEqual(minTrack);
		const layout = await projector.evaluate(() => {
			const list = document.querySelector('.form-results') as HTMLElement;
			return {
				pageScrolls: document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth,
				cutOff: list.scrollHeight > list.clientHeight + 1 || list.scrollWidth > list.clientWidth + 1,
				headerBottom: (document.querySelector('.host__top') as HTMLElement).getBoundingClientRect().bottom,
				resultsTop: list.getBoundingClientRect().top,
				resultsBottom: list.getBoundingClientRect().bottom,
			};
		});
		expect(layout.pageScrolls, `the page scrolls at ${width}x${height}`).toBe(false);
		expect(layout.cutOff, `the results are cut off at ${width}x${height}`).toBe(false);
		expect(layout.headerBottom).toBeLessThanOrEqual(layout.resultsTop);
		expect(layout.resultsBottom).toBeLessThanOrEqual(height);
		await expect(projector.locator('.host__code')).toHaveText(code);
		await expect(projector.locator('.host__code')).toBeInViewport({ ratio: 1 });
	}
}

test('feedback results: the longest form (6 questions, 140-character title) keeps every bar at least 120px tall at 1920x1080 and 80px at 1280x720, and 3 questions too', async ({ browser }) => {
	test.setTimeout(120_000);
	expect(TITLE.length).toBe(MAX_PROMPT_CHARS);
	expect(SIX).toHaveLength(MAX_FORM_QUESTIONS);
	expect(SIX[0].text.length).toBe(MAX_FORM_QUESTION_CHARS);

	const control = await (await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 900 } })).newPage();
	await signIn(control, hostEmail, hostPassword);
	await control.waitForURL('**/decks');
	await builderReady(control);
	for (const [a, questions] of [SIX, THREE].entries()) {
		if (a > 0) await control.getByRole('button', { name: 'Add activity' }).click();
		const box = activityBox(control, a + 1);
		await box.getByLabel('Type', { exact: true }).selectOption({ label: 'Feedback form' });
		await box.getByLabel('Title', { exact: true }).fill(TITLE);
		for (const [j, { text, scale }] of questions.entries()) {
			if (j > 0) await box.getByRole('button', { name: 'Add question' }).click();
			await box.getByLabel(`Question ${j + 1}`, { exact: true }).fill(text);
			await box.getByLabel(`Scale for question ${j + 1}`, { exact: true }).selectOption({ label: SCALE_NAMES[scale] });
		}
	}
	await control.getByRole('button', { name: 'Start session' }).click();
	await control.waitForURL(/\/run\/[A-Z0-9]{5}\/control$/);
	const code = /\/run\/([A-Z0-9]{5})\/control$/.exec(control.url())?.[1] ?? '';

	const projector = await (await browser.newContext({ baseURL: BASE, viewport: { width: 1920, height: 1080 } })).newPage();
	await projector.goto(`/run/${code}`);
	for (const [a, questions] of [SIX, THREE].entries()) {
		if (a > 0) {
			await control.getByRole('button', { name: 'Next', exact: true }).click();
			await expect(statusValue(control, 'Activity')).toHaveText('2 of 2');
		}
		await control.getByRole('button', { name: 'Open answers' }).click();
		await expect(statusValue(control, 'Answers')).toHaveText('Open');
		await eightPhonesAnswer(code, questions);
		await expect(control.getByText('8 people have answered.')).toBeVisible();
		await control.getByRole('button', { name: 'Show results' }).click();
		await expect(projector.getByRole('list', { name: 'Feedback results' }).locator(':scope > li')).toHaveCount(questions.length, { timeout: 5_000 });
		await projector.evaluate(() => document.fonts.ready);
		await checkSizes(projector, code, questions);
		await projector.setViewportSize({ width: 1920, height: 1080 });
	}

	await projector.context().close();
	await control.context().close();
});

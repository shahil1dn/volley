// A30, the feedback form (ADR-018): a host builds a form of three questions on
// three scales; three phones rate it on one screen and send once; the projector
// shows only how many have answered until the host presses Show results, then
// each question's average and counts within 3s. The control page has the
// results all along. The host account is deleted in afterAll, with its sessions.
import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { activityBox, addHost, BASE, builderReady, signIn, statusValue } from './helpers.ts';

const PHONE = { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const SCREENS = 'screenshots/feedback';
const TITLE = 'How did today go?';
const QUESTIONS = [
	{ text: 'The talk', scale: 'Stars, 1 to 5' },
	{ text: 'How likely are you to come again?', scale: '1 to 10' },
	{ text: 'The room', scale: 'Very bad to Very good' },
];
// Each phone's form, as the radio names it rates: [stars, 1 to 10, words].
const FORMS = [
	['5 stars', '9 out of 10', 'Good'],
	['4 stars', '7 out of 10', 'Okay'],
	['4 stars', '10 out of 10', 'Very good'],
];
// Worked by hand: (5 + 4 + 4) / 3 = 4.33 → 4.3; (9 + 7 + 10) / 3 = 8.67 → 8.7; (4 + 3 + 5) / 3 = 4.0.
const AVERAGES = ['4.3', '8.7', '4.0'];

const admin = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SECRET_KEY ?? '', {
	auth: { persistSession: false, autoRefreshToken: false },
}).auth.admin;
const hostEmail = `volley-e2e-feedback-${randomUUID()}@example.com`;
let hostPassword = '';

test.beforeAll(() => {
	hostPassword = addHost(hostEmail).password;
});

test.afterAll(async () => {
	const { data } = await admin.listUsers({ perPage: 1000 });
	for (const user of data.users.filter((u) => u.email === hostEmail)) await admin.deleteUser(user.id);
});

async function newPhone(browser: Browser): Promise<Page> {
	return (await browser.newContext({ ...PHONE, baseURL: BASE })).newPage();
}

const question = (page: Page, text: string) => page.getByRole('group', { name: text, exact: true });
// The radio is hidden and its label is what a person taps (a star, a number, a word),
// so the test taps the label too, then checks the radio it holds.
async function rate(page: Page, text: string, rating: string) {
	const radio = question(page, text).getByRole('radio', { name: rating, exact: true });
	await question(page, text).locator('label', { has: page.getByRole('radio', { name: rating, exact: true }) }).click();
	await expect(radio).toBeChecked();
}

test('A30: phones rate a feedback form; the projector shows the count, then the results within 3s of Show results', async ({ browser }) => {
	const laptop = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 900 } });
	const control = await laptop.newPage();
	await signIn(control, hostEmail, hostPassword);
	await control.waitForURL('**/decks');
	await builderReady(control);

	// The builder: a feedback form can be the first activity, with a title and its own questions.
	const box = activityBox(control, 1);
	await box.getByLabel('Type', { exact: true }).selectOption({ label: 'Feedback form' });
	await box.getByLabel('Title', { exact: true }).fill(TITLE);
	for (const [j, { text, scale }] of QUESTIONS.entries()) {
		if (j > 0) await box.getByRole('button', { name: 'Add question' }).click();
		await box.getByLabel(`Question ${j + 1}`, { exact: true }).fill(text);
		await box.getByLabel(`Scale for question ${j + 1}`, { exact: true }).selectOption({ label: scale });
	}
	// A thank-you slide after it, so the host can move on and come back.
	await control.getByRole('button', { name: 'Add activity' }).click();
	await activityBox(control, 2).getByLabel('Type', { exact: true }).selectOption({ label: 'Thank you' });
	await expect(control.getByRole('complementary', { name: 'Your session' })).toContainText('1 · Feedback form · 3 questions');
	await control.screenshot({ path: `${SCREENS}/builder.png`, fullPage: true });
	await control.getByRole('button', { name: 'Start session' }).click();
	await control.waitForURL(/\/run\/[A-Z0-9]{5}\/control$/);
	const code = /\/run\/([A-Z0-9]{5})\/control$/.exec(control.url())?.[1] ?? '';
	await control.getByRole('button', { name: 'Open answers' }).click();
	await expect(statusValue(control, 'Answers')).toHaveText('Open');

	const projector = await (await browser.newContext({ baseURL: BASE, viewport: { width: 1920, height: 1080 } })).newPage();
	await projector.goto(`/run/${code}`);
	await expect(projector.getByRole('heading', { name: TITLE })).toBeVisible();
	for (const { text } of QUESTIONS) await expect(projector.getByRole('listitem').filter({ hasText: text })).toBeVisible();
	await expect(projector.getByText('0 people have answered')).toBeVisible();

	const phones = await Promise.all(FORMS.map(() => newPhone(browser)));
	for (const [p, phone] of phones.entries()) {
		await phone.goto(`/j/${code}`);
		await expect(phone.getByRole('heading', { name: TITLE })).toBeVisible();
		const send = phone.getByRole('button', { name: 'Send' });
		// Send waits until every question has a rating.
		for (const [q, rating] of FORMS[p].entries()) {
			await expect(send).toBeDisabled();
			await rate(phone, QUESTIONS[q].text, rating);
		}
		if (p === 0) await phone.screenshot({ path: `${SCREENS}/phone-form.png`, fullPage: true });
		await send.click();
		await expect(phone.getByRole('heading', { name: 'Thanks for your feedback' })).toBeVisible();
		// The phone shows back its own ratings, not anyone else's.
		for (const [q, rating] of FORMS[p].entries()) {
			await expect(phone.getByRole('listitem').filter({ hasText: QUESTIONS[q].text })).toContainText(rating);
		}
		if (p === 0) await phone.screenshot({ path: `${SCREENS}/phone-sent.png`, fullPage: true });
	}

	// The count reaches the projector; the results do not.
	await expect(projector.getByText('3 people have answered')).toBeVisible({ timeout: 3_000 });
	await expect(projector.getByRole('list', { name: 'Feedback results' })).toHaveCount(0);
	// Each average is drawn with "average out of" beside it, so none is on the screen yet.
	await expect(projector.getByText('average out of')).toHaveCount(0);
	await projector.screenshot({ path: `${SCREENS}/projector-before.png` });

	// The host has them live, before Show results.
	await expect(control.getByText('3 people have answered.')).toBeVisible();
	for (const [q, average] of AVERAGES.entries()) {
		await expect(control.getByRole('table', { name: new RegExp(QUESTIONS[q].text) })).toContainText(`Average ${average} from 3`);
	}
	await control.screenshot({ path: `${SCREENS}/control.png`, fullPage: true });

	// The 3 seconds run from the press, not from when the control page catches up.
	const shownAt = Date.now();
	await control.getByRole('button', { name: 'Show results' }).click();
	const results = projector.getByRole('list', { name: 'Feedback results' });
	await expect(results).toBeVisible({ timeout: 3_000 });
	for (const [q, average] of AVERAGES.entries()) {
		await expect(results.getByRole('listitem').filter({ hasText: QUESTIONS[q].text }).first()).toContainText(average, { timeout: 3_000 });
	}
	expect(Date.now() - shownAt).toBeLessThan(3_000);
	await expect(statusValue(control, 'Answers')).toHaveText('Shown');
	// The counts are there for each point: two people gave the talk 4 stars.
	await expect(results.getByText('4 stars: 2', { exact: true })).toBeAttached();
	await projector.screenshot({ path: `${SCREENS}/projector-after.png` });

	// Showing the results closed answers, and a phone that already sent still sees only its own.
	await expect(phones[0].getByRole('heading', { name: 'Thanks for your feedback' })).toBeVisible();
	await expect(phones[0].getByText('average out of')).toHaveCount(0);
	const late = await newPhone(browser);
	await late.goto(`/j/${code}`);
	await expect(late.getByRole('heading', { name: 'Waiting for the next question' })).toBeVisible();
	await expect(late.getByRole('button', { name: 'Send' })).toHaveCount(0);

	// Shown once, the form is closed for good: after Next then Back there is no Open answers.
	await expect(control.getByText('Results are on the projector. This form is closed for good.')).toBeVisible();
	await control.getByRole('button', { name: 'Next', exact: true }).click();
	await expect(statusValue(control, 'Activity')).toHaveText('2 of 2');
	await control.getByRole('button', { name: 'Previous', exact: true }).click();
	await expect(statusValue(control, 'Activity')).toHaveText('1 of 2');
	await expect(control.getByText('Results were shown, so this form is closed for good.')).toBeVisible();
	await expect(control.getByRole('button', { name: 'Open answers' })).toHaveCount(0);

	await Promise.all([...phones, late, projector].map((page) => page.context().close()));
	await laptop.close();
});

// A form of 4 to 6 questions is two phone pages (ADR-018): 5 is 3 then 2.
const FIVE = [
	{ text: 'The talk', scale: 'Stars, 1 to 5', rating: '4 stars' },
	{ text: 'The slides', scale: '1 to 10', rating: '8 out of 10' },
	{ text: 'The room', scale: 'Very bad to Very good', rating: 'Good' },
	{ text: 'The food', scale: 'Stars, 1 to 5', rating: '3 stars' },
	{ text: 'Would you come again?', scale: '1 to 10', rating: '9 out of 10' },
];

test('a 5-question form is two phone pages, 3 then 2: Next waits for its page, Back keeps the ratings, Send is on the last page', async ({ browser }) => {
	const laptop = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 900 } });
	const control = await laptop.newPage();
	await signIn(control, hostEmail, hostPassword);
	await control.waitForURL('**/decks');
	await builderReady(control);
	const box = activityBox(control, 1);
	await box.getByLabel('Type', { exact: true }).selectOption({ label: 'Feedback form' });
	await box.getByLabel('Title', { exact: true }).fill('Rate the day');
	for (const [j, { text, scale }] of FIVE.entries()) {
		if (j > 0) await box.getByRole('button', { name: 'Add question' }).click();
		await box.getByLabel(`Question ${j + 1}`, { exact: true }).fill(text);
		await box.getByLabel(`Scale for question ${j + 1}`, { exact: true }).selectOption({ label: scale });
	}
	await control.getByRole('button', { name: 'Start session' }).click();
	await control.waitForURL(/\/run\/[A-Z0-9]{5}\/control$/);
	const code = /\/run\/([A-Z0-9]{5})\/control$/.exec(control.url())?.[1] ?? '';
	await control.getByRole('button', { name: 'Open answers' }).click();

	const phone = await newPhone(browser);
	await phone.goto(`/j/${code}`);
	await expect(phone.getByRole('heading', { name: 'Rate the day' })).toBeVisible();
	await expect(phone.getByText('1 of 2')).toBeVisible();
	// Page 1 is the first three questions, with Next and no Send.
	for (const q of FIVE.slice(0, 3)) await expect(question(phone, q.text)).toBeVisible();
	for (const q of FIVE.slice(3)) await expect(question(phone, q.text)).toHaveCount(0);
	await expect(phone.getByRole('button', { name: 'Send' })).toHaveCount(0);
	const next = phone.getByRole('button', { name: 'Next' });
	for (const q of FIVE.slice(0, 3)) {
		await expect(next).toBeDisabled();
		await rate(phone, q.text, q.rating);
	}
	await expect(next).toBeEnabled();
	await next.click();

	// Page 2 is the last two, and the keyboard is on its first question.
	await expect(phone.getByText('2 of 2')).toBeVisible();
	for (const q of FIVE.slice(0, 3)) await expect(question(phone, q.text)).toHaveCount(0);
	await expect(question(phone, FIVE[3].text).getByRole('radio').first()).toBeFocused();
	// Back keeps what was chosen on page 1, and lands on the first question's choice.
	await phone.getByRole('button', { name: 'Back' }).click();
	for (const q of FIVE.slice(0, 3)) await expect(question(phone, q.text).getByRole('radio', { name: q.rating, exact: true })).toBeChecked();
	await expect(question(phone, FIVE[0].text).getByRole('radio', { name: FIVE[0].rating, exact: true })).toBeFocused();
	await next.click();
	const send = phone.getByRole('button', { name: 'Send' });
	for (const q of FIVE.slice(3)) {
		await expect(send).toBeDisabled();
		await rate(phone, q.text, q.rating);
	}
	await send.click();
	await expect(phone.getByRole('heading', { name: 'Thanks for your feedback' })).toBeVisible();
	for (const q of FIVE) await expect(phone.getByRole('listitem').filter({ hasText: q.text })).toContainText(q.rating);

	// The host has the whole form, sent once: all five questions counted.
	await expect(control.getByText('1 person has answered.')).toBeVisible();
	for (const q of FIVE) await expect(control.getByRole('table', { name: q.text })).toContainText('from 1');

	await phone.context().close();
	await laptop.close();
});

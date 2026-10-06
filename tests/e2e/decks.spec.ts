// The /decks session builder: a list that starts at one activity, grows to the
// cap and shrinks again, shows poll options only for polls, and when the server
// refuses a post says which field is wrong and gives back everything typed.
// Uses a real host account; the rooms it starts go with the host in afterAll.
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import type pg from 'pg';
import { connectAsOwner } from '../../scripts/pg-connect.ts';
import { MAX_ACTIVITIES, MAX_OPTIONS, MIN_OPTIONS } from '../../src/lib/session-limits.ts';
import { activityBox, addHost, BASE, builderReady, signIn, startSession } from './helpers.ts';

const admin = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SECRET_KEY ?? '', {
	auth: { persistSession: false, autoRefreshToken: false },
}).auth.admin;

let db: pg.Client;
const hostEmail = `volley-e2e-decks-${randomUUID()}@example.com`;
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
		`delete from public.rate_limits where key like 'signin-%' and window_start >= $1::timestamptz - interval '15 minutes'`,
		[suiteStart],
	);
	await db.end();
});

async function openBuilder(page: Page) {
	await signIn(page, hostEmail, hostPassword);
	await page.waitForURL('**/decks');
	await builderReady(page);
}

const addActivity = (page: Page) => page.getByRole('button', { name: 'Add activity' });
const headings = (page: Page) => page.getByRole('heading', { name: /^Activity \d+$/ });
const question = (page: Page, n: number) => activityBox(page, n).getByLabel('Question', { exact: true });
const typeOf = (page: Page, n: number) => activityBox(page, n).getByLabel('Type', { exact: true });
const option = (page: Page, n: number, j: number) => activityBox(page, n).getByLabel(`Option ${j}`, { exact: true });

test('the list starts at one activity, grows to the cap, and renumbers when one is removed', async ({ page }) => {
	await openBuilder(page);
	await expect(headings(page)).toHaveCount(1);
	await expect(page.getByRole('button', { name: 'Remove activity 1' }), 'the last activity cannot be removed').toBeDisabled();

	for (let n = 2; n <= MAX_ACTIVITIES; n++) await addActivity(page).click();
	await expect(headings(page)).toHaveCount(MAX_ACTIVITIES);
	await expect(addActivity(page), 'the cap is reached').toBeDisabled();
	await expect(page.getByText(`${MAX_ACTIVITIES} of ${MAX_ACTIVITIES}`)).toBeVisible();

	// What was typed stays with its activity when another is removed.
	await question(page, 2).fill('Second');
	await question(page, 3).fill('Third');
	await page.getByRole('button', { name: 'Remove activity 2' }).click();
	await expect(headings(page)).toHaveCount(MAX_ACTIVITIES - 1);
	await expect(question(page, 2)).toHaveValue('Third');
	await expect(addActivity(page), 'room again').toBeEnabled();
});

test('poll options show for a poll only, from two to six, and are kept when the type is switched away and back', async ({ page }) => {
	await openBuilder(page);
	await expect(page.getByLabel('Option 1', { exact: true }), 'a word cloud has none').toHaveCount(0);

	await typeOf(page, 1).selectOption({ label: 'Poll' });
	await expect(option(page, 1, 1)).toBeVisible();
	await expect(option(page, 1, 2)).toBeVisible();
	await expect(option(page, 1, 3)).toHaveCount(0);
	for (const j of [1, 2]) await expect(page.getByRole('button', { name: `Remove option ${j}` }), 'two is the least').toBeDisabled();

	for (let n = MIN_OPTIONS + 1; n <= MAX_OPTIONS; n++) await activityBox(page, 1).getByRole('button', { name: 'Add option' }).click();
	await expect(option(page, 1, MAX_OPTIONS)).toBeVisible();
	await expect(activityBox(page, 1).getByRole('button', { name: 'Add option' }), 'six is the most').toBeDisabled();

	await option(page, 1, 1).fill('Tea');
	await option(page, 1, 6).fill('Water');
	await activityBox(page, 1).getByRole('button', { name: 'Remove option 2' }).click();
	await expect(option(page, 1, 6), 'one fewer now').toHaveCount(0);
	await expect(option(page, 1, 5)).toHaveValue('Water');

	await typeOf(page, 1).selectOption({ label: 'Q&A' });
	await expect(page.getByLabel('Option 1', { exact: true })).toHaveCount(0);
	await typeOf(page, 1).selectOption({ label: 'Poll' });
	await expect(option(page, 1, 1)).toHaveValue('Tea');
	await expect(option(page, 1, 5)).toHaveValue('Water');
});

test('a session of mixed activities starts, and the poll keeps its options in the order typed', async ({ browser }) => {
	const laptop = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 720 } });
	const control = await laptop.newPage();
	await signIn(control, hostEmail, hostPassword);
	await control.waitForURL('**/decks');
	const code = await startSession(control, [
		{ type: 'Poll', question: 'Tea or coffee?', options: ['Tea', 'Coffee', 'Neither', 'Water'] },
		{ type: 'Word cloud', question: 'One word for AI?' },
		{ type: 'Q&A', question: 'Ask us anything' },
	]);
	await control.getByRole('button', { name: 'Open answers' }).click();
	await expect(control.getByText('Session: live. Answers: open.')).toBeVisible();
	const projector = await laptop.newPage();
	await projector.goto(`/run/${code}`);
	await expect(projector.getByRole('list', { name: 'Poll results' }).getByRole('listitem')).toContainText(['Tea', 'Coffee', 'Neither', 'Water']);
});

test('a refused submit says which field is wrong, next to it, and gives back everything typed', async ({ page }) => {
	await openBuilder(page);
	await question(page, 1).fill('  One word for AI?  ');
	await addActivity(page).click();
	await typeOf(page, 2).selectOption({ label: 'Poll' });
	// No question, and options that repeat or are blank.
	await activityBox(page, 2).getByRole('button', { name: 'Add option' }).click();
	await activityBox(page, 2).getByRole('button', { name: 'Add option' }).click();
	const typed = ['Tea', 'tea', '', 'Coffee'];
	for (const [j, value] of typed.entries()) await option(page, 2, j + 1).fill(value);
	await addActivity(page).click();
	await typeOf(page, 3).selectOption({ label: 'Q&A' });
	await question(page, 3).fill('Ask us anything');

	await page.getByRole('button', { name: 'Start session' }).click();
	// Refused, so still on the builder (a plain form post keeps its action in the address).
	await expect(page).toHaveURL(`${BASE}/decks?/startSession`);

	// Every activity and option is still there, as typed, spaces included.
	await expect(headings(page)).toHaveCount(3);
	await expect(question(page, 1)).toHaveValue('  One word for AI?  ');
	await expect(typeOf(page, 2)).toHaveValue('poll');
	await expect(typeOf(page, 3)).toHaveValue('qna');
	await expect(question(page, 3)).toHaveValue('Ask us anything');
	for (const [j, value] of typed.entries()) await expect(option(page, 2, j + 1)).toHaveValue(value);
	await expect(option(page, 2, typed.length + 1), 'no option was added or lost').toHaveCount(0);

	// Each message sits with its own field, and only that field is marked.
	await expect(activityBox(page, 2).getByText('Write the question.')).toBeVisible();
	await expect(question(page, 2)).toHaveAttribute('aria-invalid', 'true');
	await expect(option(page, 2, 2)).toHaveAttribute('aria-invalid', 'true');
	await expect(activityBox(page, 2).getByText('Same as option 1. Options must differ.')).toBeVisible();
	await expect(option(page, 2, 3)).toHaveAttribute('aria-invalid', 'true');
	await expect(activityBox(page, 2).getByText('Write an option, or remove this one.')).toBeVisible();
	await expect(question(page, 1)).not.toHaveAttribute('aria-invalid', 'true');
	await expect(option(page, 2, 1)).not.toHaveAttribute('aria-invalid', 'true');
	await expect(option(page, 2, 4)).not.toHaveAttribute('aria-invalid', 'true');
	await expect(activityBox(page, 3).locator('[aria-invalid="true"]')).toHaveCount(0);
	await expect(question(page, 2), 'focus goes to the first problem').toBeFocused();

	// Fixing a field clears its message; the rest stay until fixed.
	await question(page, 2).fill('Tea or coffee?');
	await expect(activityBox(page, 2).getByText('Write the question.')).toHaveCount(0);
	await expect(activityBox(page, 2).getByText('Same as option 1. Options must differ.')).toBeVisible();

	await option(page, 2, 2).fill('Water');
	await activityBox(page, 2).getByRole('button', { name: 'Remove option 3' }).click();
	await page.getByRole('button', { name: 'Start session' }).click();
	await page.waitForURL(/\/run\/[A-Z0-9]{5}\/control$/);
});

// The page can't send these, so they are made by hand, exactly as a script would.
test('the server refuses an over-cap or lopsided post on its own, and ignores options on non-polls', async ({ page }) => {
	await openBuilder(page);
	const send = (fields: [string, string][]) =>
		page.evaluate(async (entries) => {
			const body = new FormData();
			for (const [name, value] of entries) body.append(name, value);
			const response = await fetch('/decks?/startSession', { method: 'POST', body, headers: { 'x-sveltekit-action': 'true' } });
			return response.json();
		}, fields);
	const word = (n: number): [string, string][] => [['type', 'word_cloud'], ['prompt', `Question ${n}`]];

	const tooMany = await send(Array.from({ length: MAX_ACTIVITIES + 1 }, (_, n) => word(n)).flat());
	expect(tooMany.type).toBe('failure');
	expect(tooMany.status).toBe(400);
	expect(tooMany.data).toContain(`at most ${MAX_ACTIVITIES}`);

	const none = await send([]);
	expect(none.type).toBe('failure');
	expect(none.data).toContain('Add at least one activity.');

	const lopsided = await send([...word(0), ['type', 'qna']]);
	expect(lopsided.type).toBe('failure');
	expect(lopsided.data).toContain('incomplete');

	const onePollOption = await send([['type', 'poll'], ['prompt', 'Q?'], ['options0', 'Only one']]);
	expect(onePollOption.type).toBe('failure');
	expect(onePollOption.data).toContain('needs 2 to 6 options');

	// Options sent for a Q&A are dropped and the session starts. (The database drops
	// them too, so this proves the outcome; tests/session-form.test.ts pins the reader.)
	const stray = await send([['type', 'qna'], ['prompt', 'Ask us'], ['options0', 'stray'], ['options0', 'options']]);
	expect(stray.type).toBe('redirect');
	expect(stray.location).toMatch(/^\/run\/[A-Z0-9]{5}\/control$/);
	const settings = await db.query(
		`select i.settings from public.runs r join public.deck_items i on i.deck_id = r.deck_id where r.code = $1`,
		[/([A-Z0-9]{5})\/control$/.exec(stray.location)?.[1]],
	);
	expect(settings.rows).toEqual([{ settings: { prompt: 'Ask us' } }]);
});

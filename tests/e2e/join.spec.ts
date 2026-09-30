// /join: the enter-a-code page people type from the projector (SPEC routes).
import { expect, test, type Page } from '@playwright/test';
import type pg from 'pg';
import { connectAsOwner } from '../../scripts/pg-connect.ts';
import { makeRun, type TestRun } from '../db-helpers.ts';

const PHONE = { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

let db: pg.Client;
let room: TestRun;

test.beforeAll(async () => {
	db = await connectAsOwner();
	room = await makeRun(db, { settings: { prompt: 'Joined?' } });
});

test.afterAll(async () => {
	await db.query('delete from auth.users where id = $1', [room.userId]);
	await db.end();
});

test.use(PHONE);

async function joinWith(page: Page, typed: string) {
	await page.goto('/join');
	const field = page.getByRole('textbox', { name: 'Room code' });
	await field.fill(typed);
	// The phone keyboard's Go key submits the form.
	await field.press('Enter');
}

test('a real code, typed loosely, lands on that room', async ({ page }) => {
	const loose = `${room.code.slice(0, 2).toLowerCase()} ${room.code.slice(2)}`;
	await joinWith(page, loose);
	await expect(page).toHaveURL(`/j/${room.code}`);
	await expect(page.getByRole('heading', { name: 'Joined?' })).toBeVisible();
});

test('a malformed or unknown code stays on /join with an error tied to the field', async ({ page }) => {
	for (const [typed, message] of [
		['ABC', 'Room codes are 5 letters and numbers'],
		['ZZZZZ', "There's no session with that code right now"],
	]) {
		await joinWith(page, typed);
		await expect(page).toHaveURL(/\/join\?code=/);
		const field = page.getByRole('textbox', { name: 'Room code' });
		await expect(field).toHaveAttribute('aria-invalid', 'true');
		await expect(field).toHaveAccessibleDescription(new RegExp(message));
		await expect(field, 'what was typed is kept for fixing').toHaveValue(typed);
	}
	await page.screenshot({ path: 'screenshots/join/unknown-code.png' });
});

test('the field is set up for a phone keyboard', async ({ page }) => {
	await page.goto('/join');
	const field = page.getByRole('textbox', { name: 'Room code' });
	await expect(field).toHaveAttribute('autocapitalize', 'characters');
	await expect(field).toHaveAttribute('enterkeyhint', 'go');
	await expect(field).toHaveAttribute('autocomplete', 'off');
	await expect(field).not.toHaveAttribute('aria-invalid');
});

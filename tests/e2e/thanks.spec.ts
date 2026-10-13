// The thank-you slide: the builder fills in the copy's message, and once the
// host moves to it the control page offers nothing to answer, phones show the
// message alone, and the projector shows it in place of the join panel. The
// host account is deleted in afterAll, and its sessions with it.
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { brand } from '../../src/lib/brand.ts';
import { activityBox, addHost, BASE, builderReady, signIn, statusValue } from './helpers.ts';

const PHONE = { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const admin = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SECRET_KEY ?? '', {
	auth: { persistSession: false, autoRefreshToken: false },
}).auth.admin;
const hostEmail = `volley-e2e-thanks-${randomUUID()}@example.com`;
let hostPassword = '';

test.beforeAll(() => {
	hostPassword = addHost(hostEmail).password;
});

test.afterAll(async () => {
	const { data } = await admin.listUsers({ perPage: 1000 });
	for (const user of data.users.filter((u) => u.email === hostEmail)) await admin.deleteUser(user.id);
});

test('a session ends on a thank-you slide: nothing to answer, the message on phones and the projector', async ({ page, browser }) => {
	await signIn(page, hostEmail, hostPassword);
	await page.waitForURL(/\/decks$/);
	await builderReady(page);
	await activityBox(page, 1).getByLabel('Question', { exact: true }).fill('One word?');
	await page.getByRole('button', { name: 'Add activity' }).click();
	const slide = activityBox(page, 2);
	await slide.getByLabel('Type', { exact: true }).selectOption({ label: 'Thank you' });
	// The field is a message now, already holding the copy's own words.
	await expect(slide.getByLabel('Message', { exact: true })).toHaveValue(brand.thankYou.message);
	await page.getByRole('button', { name: 'Start session' }).click();
	await page.waitForURL(/\/run\/[A-Z0-9]{5}\/control$/);
	const code = /\/run\/([A-Z0-9]{5})\/control$/.exec(page.url())?.[1] ?? '';

	await page.getByRole('button', { name: 'Open answers' }).click();
	await expect(statusValue(page, 'Answers')).toHaveText('Open');
	await page.getByRole('button', { name: 'Next', exact: true }).click();
	await expect(statusValue(page, 'Activity')).toHaveText('2 of 2');
	await expect(statusValue(page, 'Answers')).toHaveText('None');
	await expect(page.getByText('On screen now. Nothing to answer.')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Open answers' })).toHaveCount(0);

	const phone = await browser.newContext(PHONE);
	const phonePage = await phone.newPage();
	await phonePage.goto(`${BASE}/j/${code}`);
	await expect(phonePage.getByRole('heading', { level: 1 })).toHaveText(brand.thankYou.message);
	await expect(phonePage.getByRole('textbox')).toHaveCount(0);
	await phone.close();

	const projector = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
	await projector.goto(`${BASE}/run/${code}`);
	await expect(projector.getByRole('heading', { level: 1 })).toHaveText(brand.thankYou.message);
	await expect(projector.getByText('Scan, or go to')).toHaveCount(0);
	// This copy's link decides whether a QR code is shown.
	await expect(projector.getByRole('img', { name: /^QR code for / })).toHaveCount(brand.thankYou.link ? 1 : 0);
	await projector.close();
});

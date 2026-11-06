// The thank-you slide: the builder fills in the copy's message, and once the
// host moves to it the control page offers nothing to answer, phones show the
// message alone, and the projector shows it in place of the join panel. The
// host account is deleted in afterAll, and its sessions with it.
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { brand } from '../../src/lib/brand.ts';
import { activityBox, addHost, BASE, builderReady, signIn, statusValue } from './helpers.ts';

const PHONE = { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const admin = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SECRET_KEY ?? '', {
	auth: { persistSession: false, autoRefreshToken: false },
}).auth.admin;
const hostEmail = `volley-e2e-thanks-${randomUUID()}@example.com`;
// The thank-you pictures, if this copy has any (brand.thankYou.background).
const pictures = brand.thankYou.background ?? null;

// Every picture a page asks for: the slide's backdrop is a CSS background, so it shows here
// as an image request. The logo, if the copy has one, is expected on every screen.
function imagesAsked(page: Page): string[] {
	const asked: string[] = [];
	page.on('request', (request) => {
		const path = new URL(request.url()).pathname;
		if (request.resourceType() === 'image' && path !== brand.logo) asked.push(path);
	});
	return asked;
}

// How far a box's middle is from the middle of the screen, in px, across and down.
async function offCentre(page: Page, selector: string): Promise<[number, number]> {
	return page.locator(selector).evaluate((element) => {
		const box = element.getBoundingClientRect();
		return [Math.abs(box.left + box.width / 2 - window.innerWidth / 2), Math.abs(box.top + box.height / 2 - window.innerHeight / 2)];
	});
}

// What is drawn behind a thing: the backdrop's picture under the words, or nothing.
async function pictureBehind(page: Page, selector: string): Promise<string | null> {
	return page.locator(selector).evaluate((element) => {
		const box = element.getBoundingClientRect();
		const behind = document.elementsFromPoint(box.left + box.width / 2, box.top + box.height / 2).find((e) => e.classList.contains('thanks-backdrop'));
		return behind ? getComputedStyle(behind).backgroundImage : null;
	});
}
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
	// Words already typed are kept when a row becomes a thank-you slide.
	await page.getByRole('button', { name: 'Add activity' }).click();
	const typed = activityBox(page, 2);
	await typed.getByLabel('Question', { exact: true }).fill('See you next week');
	await typed.getByLabel('Type', { exact: true }).selectOption({ label: 'Thank you' });
	await expect(typed.getByLabel('Message', { exact: true })).toHaveValue('See you next week');
	await typed.getByRole('button', { name: 'Remove activity 2' }).click();
	await page.getByRole('button', { name: 'Add activity' }).click();
	const slide = activityBox(page, 2);
	await slide.getByLabel('Type', { exact: true }).selectOption({ label: 'Thank you' });
	// The field is a message now, already holding the copy's own words.
	await expect(slide.getByLabel('Message', { exact: true })).toHaveValue(brand.thankYou.message);
	// Changing its mind drops those words, so they can't start a word cloud by accident; coming back refills them.
	await slide.getByLabel('Type', { exact: true }).selectOption({ label: 'Word cloud' });
	await expect(slide.getByLabel('Question', { exact: true })).toHaveValue('');
	await slide.getByLabel('Type', { exact: true }).selectOption({ label: 'Thank you' });
	await expect(slide.getByLabel('Message', { exact: true })).toHaveValue(brand.thankYou.message);
	await page.getByRole('button', { name: 'Start session' }).click();
	await page.waitForURL(/\/run\/[A-Z0-9]{5}\/control$/);
	const code = /\/run\/([A-Z0-9]{5})\/control$/.exec(page.url())?.[1] ?? '';

	await page.getByRole('button', { name: 'Open answers' }).click();
	await expect(statusValue(page, 'Answers')).toHaveText('Open');
	// The projector before the slide: the join panel and its QR are there to be hidden.
	const projector = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
	const projectorAsked = imagesAsked(projector);
	await projector.goto(`${BASE}/run/${code}`);
	await expect(projector.getByText('Scan, or go to')).toBeVisible();
	await expect(projector.getByRole('img', { name: /^QR code to join/ })).toHaveCount(1);
	// A phone on the first activity, before the slide: no picture yet, whatever the copy.
	const phone = await browser.newContext(PHONE);
	const phonePage = await phone.newPage();
	const phoneAsked = imagesAsked(phonePage);
	await phonePage.goto(`${BASE}/j/${code}`);
	await expect(phonePage.getByRole('heading', { name: 'One word?' })).toBeVisible();
	expect(phoneAsked, 'no picture before the slide').toEqual([]);
	expect(projectorAsked, 'no picture before the slide').toEqual([]);

	await page.getByRole('button', { name: 'Next', exact: true }).click();
	await expect(statusValue(page, 'Activity')).toHaveText('2 of 2');
	await expect(statusValue(page, 'Answers')).toHaveText('None');
	await expect(page.getByText('On screen now. Nothing to answer.')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Open answers' })).toHaveCount(0);

	await expect(phonePage.getByRole('heading', { level: 1 })).toHaveText(brand.thankYou.message);
	await expect(phonePage.getByText('Keep this page open')).toHaveCount(0);
	// The phone's slide: no accent line, and its words in the middle of the whole screen.
	expect(await phonePage.locator('.phone-slide').evaluate((element) => getComputedStyle(element, '::before').content)).toBe('none');
	const [phoneAcross, phoneDown] = await offCentre(phonePage, '.phone-slide__message');
	expect(phoneAcross, 'the message is centred across').toBeLessThan(2);
	const [, hintDown] = await offCentre(phonePage, '.phone-slide__hint');
	expect(Math.abs((phoneDown + hintDown) / 2), 'message and hint together sit mid-screen').toBeLessThan(40);
	await expect(phonePage.locator('.phone-slide__hint')).toHaveCSS('text-align', 'center');

	await expect(projector.locator('.thanks__message')).toHaveText(brand.thankYou.message);
	// With no link the message alone sits in the middle of the whole screen, not just below the header.
	if (!brand.thankYou.link) {
		const [across, down] = await offCentre(projector, '.thanks__message');
		expect(across).toBeLessThan(2);
		expect(down, 'mid-screen').toBeLessThan(2);
	}
	// The picture, if the copy has one, is drawn behind the words once the slide is up, on each
	// screen its own; with none, neither screen asks for a picture at all.
	if (pictures) {
		await expect.poll(() => pictureBehind(phonePage, '.phone-slide__message')).toContain(pictures.phone);
		await expect.poll(() => pictureBehind(projector, '.thanks__message')).toContain(pictures.projector);
		expect(phoneAsked).toEqual([pictures.phone]);
		expect(projectorAsked).toEqual([pictures.projector]);
	} else {
		expect(await pictureBehind(phonePage, '.phone-slide__message')).toBeNull();
		expect(await pictureBehind(projector, '.thanks__message')).toBeNull();
		expect(phoneAsked).toEqual([]);
		expect(projectorAsked).toEqual([]);
	}
	await phone.close();
	await expect(projector.getByText('Scan, or go to')).toHaveCount(0);
	await expect(projector.getByRole('img', { name: /^QR code to join/ })).toHaveCount(0);
	// Answers are never open here, so the header doesn't call them closed.
	const roomLabel = projector.locator('.host__meta .label');
	await expect(roomLabel).toContainText(`Room ${code}`);
	await expect(roomLabel).not.toContainText('Answers');
	// This copy's link decides whether a QR code is shown.
	await expect(projector.getByRole('img', { name: /^QR code for / })).toHaveCount(brand.thankYou.link ? 1 : 0);
	await projector.close();
});

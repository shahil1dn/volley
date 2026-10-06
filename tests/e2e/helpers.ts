// Shared by the browser tests.
import { spawnSync } from 'node:child_process';
import { expect, type Page } from '@playwright/test';

export const BASE = 'http://localhost:5174';

// Makes (or resets) a host with the real `npm run add-host` script and returns
// the printed password.
export function addHost(email: string): { output: string; password: string } {
	const run = spawnSync('node', ['--env-file=.env.local', 'scripts/add-host.mjs', email], { encoding: 'utf8' });
	if (run.status !== 0) throw new Error(`add-host failed: ${run.stderr}`);
	return { output: run.stdout, password: /Password: (\S+)/.exec(run.stdout)?.[1] ?? '' };
}

export async function signIn(page: Page, email: string, password: string) {
	await page.goto('/');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill(password);
	await page.getByRole('button', { name: 'Sign in' }).click();
}

export type Activity = { type: 'Word cloud' | 'Poll' | 'Q&A'; question: string; options?: string[] };

// One activity's box on the /decks form, by its heading.
export const activityBox = (page: Page, n: number) => page.getByRole('group', { name: `Activity ${n}`, exact: true });

// The add and remove buttons stay disabled until the page's script has run, so
// an enabled "Add activity" means the form is ready to be filled.
export async function builderReady(page: Page) {
	await expect(page.getByRole('button', { name: 'Add activity' })).toBeEnabled();
}

// Fills the /decks session form, one activity after another, and starts it.
// Returns the room code from the control view it lands on.
export async function startSession(page: Page, activities: Activity[]): Promise<string> {
	await builderReady(page);
	for (const [i, activity] of activities.entries()) {
		if (i > 0) await page.getByRole('button', { name: 'Add activity' }).click();
		const box = activityBox(page, i + 1);
		await box.getByLabel('Type', { exact: true }).selectOption({ label: activity.type });
		await box.getByLabel('Question', { exact: true }).fill(activity.question);
		for (const [j, option] of (activity.options ?? []).entries()) {
			if (j >= 2) await box.getByRole('button', { name: 'Add option' }).click();
			await box.getByLabel(`Option ${j + 1}`, { exact: true }).fill(option);
		}
	}
	await page.getByRole('button', { name: 'Start session' }).click();
	await page.waitForURL(/\/run\/[A-Z0-9]{5}\/control$/);
	return /\/run\/([A-Z0-9]{5})\/control$/.exec(page.url())?.[1] ?? '';
}

// The control page's status block: Session, Answers and Activity, each a label and a value.
export function statusValue(page: Page, label: 'Session' | 'Answers' | 'Activity') {
	return page.locator('.status__item', { has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) }).locator('dd');
}

// A theme variable (accent, muted, error, surface...) as the browser computes it, for comparing
// against what an element actually renders with.
export function themeColour(page: Page, name: string) {
	return page.evaluate((variable) => {
		const probe = document.createElement('i');
		probe.style.color = `var(--${variable})`;
		document.body.append(probe);
		const colour = getComputedStyle(probe).color;
		probe.remove();
		return colour;
	}, name);
}

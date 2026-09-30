// Shared by the browser tests.
import { spawnSync } from 'node:child_process';
import type { Page } from '@playwright/test';

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

export type Activity = { type: 'Word cloud' | 'Poll' | 'Q&A'; question: string; options?: string };

// Fills the /decks session form (up to 3 activities, in order) and starts it.
// Returns the room code from the control view it lands on.
export async function startSession(page: Page, activities: Activity[]): Promise<string> {
	for (const [i, activity] of activities.entries()) {
		await page.getByLabel(`Activity ${i + 1} type`).selectOption({ label: activity.type });
		await page.getByLabel(`Activity ${i + 1} question`).fill(activity.question);
		if (activity.options) await page.getByLabel(`Activity ${i + 1} poll options`).fill(activity.options);
	}
	await page.getByRole('button', { name: 'Start session' }).click();
	await page.waitForURL(/\/run\/[A-Z0-9]{5}\/control$/);
	return /\/run\/([A-Z0-9]{5})\/control$/.exec(page.url())?.[1] ?? '';
}

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

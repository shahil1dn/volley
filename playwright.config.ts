import { defineConfig } from '@playwright/test';
import { refuseProduction } from './scripts/production-guard.ts';

// Before anything starts, the dev server included: its database is the one in
// .env.local, and that must never be production.
refuseProduction(process.env, 'the browser tests');

// Browser tests drive real phones against a dev server on its own port, so they
// never collide with one already running on 5173. One worker: the tests share
// the dev database and each makes and deletes its own rooms.
export default defineConfig({
	testDir: 'tests/e2e',
	timeout: 60_000,
	workers: 1,
	use: { baseURL: 'http://localhost:5174', browserName: 'chromium' },
	webServer: {
		command: 'npm run dev -- --port 5174 --strictPort',
		url: 'http://localhost:5174',
		reuseExistingServer: false,
		timeout: 60_000,
	},
});

// The Vercel CLI is run through spawn. "Not installed" and "did not answer" must not look like a
// failed command, and must tell a person what to do.
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChecks, type Ctx } from '../scripts/lib/checks.ts';
import { realExec, vercelProbe } from '../scripts/lib/vercel.ts';
import { runSetup } from '../scripts/lib/setup.ts';

function withPath<T>(path: string, work: () => T): T {
	const before = process.env.PATH;
	process.env.PATH = path;
	try {
		return work();
	} finally {
		process.env.PATH = before;
	}
}

const emptyDir = () => mkdtempSync(join(tmpdir(), 'volley-nopath-'));

test('a missing Vercel CLI says it is not installed and how to install it', () => {
	const exec = realExec(process.cwd());
	assert.throws(() => withPath(emptyDir(), () => exec(['env', 'ls'])), /the Vercel CLI isn't installed \(install it with: npm i -g vercel\)/);
});

test('a Vercel CLI that does not answer in time says so, not "exit 1"', () => {
	const dir = emptyDir();
	writeFileSync(join(dir, 'vercel'), '#!/bin/sh\nexec sleep 5\n');
	chmodSync(join(dir, 'vercel'), 0o755);
	const exec = realExec(process.cwd(), 300);
	assert.throws(() => withPath(`${dir}:/usr/bin:/bin`, () => exec(['env', 'ls'])), /did not finish within 0\.3 seconds/);
});

test('a Vercel CLI that cannot be run for another reason says what, and is not called a timeout', () => {
	const dir = emptyDir();
	writeFileSync(join(dir, 'vercel'), '#!/bin/sh\nexit 0\n');
	chmodSync(join(dir, 'vercel'), 0o644); // present, but not executable
	const exec = realExec(process.cwd());
	assert.throws(() => withPath(dir, () => exec(['env', 'ls'])), (error: Error) => /could not be run \(EACCES\)/.test(error.message) && !/did not finish/.test(error.message));
});

test('a Vercel CLI that runs and fails is still an ordinary failure with its own first line', () => {
	const dir = emptyDir();
	writeFileSync(join(dir, 'vercel'), '#!/bin/sh\necho "Error: not logged in" >&2\nexit 1\n');
	chmodSync(join(dir, 'vercel'), 0o755);
	const result = withPath(`${dir}:/usr/bin:/bin`, () => realExec(process.cwd())(['env', 'ls']));
	assert.equal(result.status, 1);
	assert.match(result.stderr, /not logged in/);
});

test('doctor --vercel and setup send a person to install the CLI, not to log in, when it is missing', async () => {
	const missing = () => withPath(emptyDir(), () => realExec(process.cwd())(['env', 'ls']));
	const linked = { projectId: 'p', orgId: 't' };
	const probe = vercelProbe(missing, () => linked);
	const ctx: Ctx = { env: {}, readFile: () => null, migrationsOnDisk: () => [], fetchJson: async () => ({ status: 200, body: {} }), query: async () => [], connectOwner: async () => ({ ok: false, reason: 'x' }), connectPooler: async () => ({ ok: false, reason: 'x' }), vercel: probe };
	const checks = await runChecks(ctx);
	for (const id of ['vercel.env', 'vercel.protection']) {
		const check = checks.find((c) => c.id === id);
		assert.equal(check?.status, 'fail', id);
		assert.match(check?.summary ?? '', /isn't installed/);
		assert.match(check?.next[0].text ?? '', /npm i -g vercel/, id);
		assert.doesNotMatch(check?.next[0].text ?? '', /^HUMAN: Run `vercel login` and approve/, id);
	}
	const result = await runSetup(
		{ dryRun: false, force: false, resetFirstAdmin: false, envFile: '.env.local', skipMigrate: true, pushVercelEnv: true, vercelTargets: ['production'], vercelProtection: true, disableSignup: false },
		{ root: mkdtempSync(join(tmpdir(), 'volley-setup-')), env: {}, migrationsDir: new URL('../db/migrations/', import.meta.url), now: () => 0, read: () => null, write: () => undefined, remove: () => undefined, isIgnored: () => true, connectOwner: async () => { throw new Error('no db'); }, authAdmin: () => { throw new Error('no auth'); }, exec: missing, vercelLink: () => linked, fetch, doctor: async (env) => ({ ctx: { ...ctx, env }, close: async () => undefined }) },
	);
	for (const id of ['vercel.env', 'vercel.protection']) {
		const step = result.steps.find((s) => s.id === id);
		assert.equal(step?.status, 'failed', id);
		assert.match(step?.next[0].text ?? '', /npm i -g vercel/, id);
	}
});

test('the CLI disappearing between listing and adding is also an install step, not a login step', async () => {
	const linked = { projectId: 'p', orgId: 't' };
	const exec = (args: string[]) => {
		if (args[1] === 'ls') return { status: 0, stdout: '[]', stderr: '' };
		throw new Error("the Vercel CLI isn't installed (install it with: npm i -g vercel)");
	};
	const result = await runSetup(
		{ dryRun: false, force: false, resetFirstAdmin: false, envFile: '.env.local', skipMigrate: true, pushVercelEnv: true, vercelTargets: ['preview'], vercelProtection: false, disableSignup: false },
		{ root: mkdtempSync(join(tmpdir(), 'volley-setup-')), env: { HOST_SESSION_SECRET: 'h'.repeat(64) }, migrationsDir: new URL('../db/migrations/', import.meta.url), now: () => 0, read: () => null, write: () => undefined, remove: () => undefined, isIgnored: () => true, connectOwner: async () => { throw new Error('no db'); }, authAdmin: () => { throw new Error('no auth'); }, exec, vercelLink: () => linked, fetch, doctor: async (env) => ({ ctx: { env, readFile: () => null, migrationsOnDisk: () => [], fetchJson: async () => ({ status: 200, body: {} }), query: async () => [], connectOwner: async () => ({ ok: false, reason: 'x' }), connectPooler: async () => ({ ok: false, reason: 'x' }) }, close: async () => undefined }) },
	);
	const step = result.steps.find((s) => s.id === 'vercel.env');
	assert.equal(step?.status, 'failed');
	assert.match(step?.next[0].text ?? '', /npm i -g vercel/);
});

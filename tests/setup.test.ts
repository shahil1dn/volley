// npm run setup: idempotent, never overwrites without --force, never prints a secret, never
// prompts. Env-file steps run against a temp folder with fakes; the database steps run against
// the TEST database (rolled back or cleaned up). Nothing here can reach production.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import type pg from 'pg';
import { PRODUCTION_REF } from '../scripts/production-guard.ts';
import { runChecks, type Ctx } from '../scripts/lib/checks.ts';
import { connectOwnerWith } from '../scripts/lib/context.ts';
import { parse } from '../scripts/lib/env.ts';
import { toText } from '../scripts/lib/report.ts';
import { FIRST_ADMIN_FILE, runSetup, summaryText, type Deps, type Options } from '../scripts/lib/setup.ts';
import { skipWithoutDatabase as skip } from './db-helpers.ts';

const REF = 'abcdefghijklmnopqrst';
const STORE_KEY = 'sb_publishable_VALUE_FROM_THE_STORE_0123456789';

const OPTIONS: Options = { dryRun: false, force: false, envFile: '.env.local', skipMigrate: true, pushVercelEnv: false, vercelTargets: ['production', 'preview'], vercelProtection: false, disableSignup: false };

type Calls = { exec: { args: string[]; input?: string }[]; fetches: { url: string; init?: RequestInit }[] };

function folder(files: Record<string, string> = {}) {
	const root = mkdtempSync(join(tmpdir(), 'volley-setup-'));
	for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
	return root;
}

function depsFor(root: string, env: Record<string, string | undefined>, over: Partial<Deps> = {}, calls: Calls = { exec: [], fetches: [] }): Deps {
	const emptyCtx = (e: Record<string, string | undefined>): Ctx => ({
		env: e,
		readFile: () => null,
		migrationsOnDisk: () => [],
		fetchJson: async () => ({ status: 200, body: { disable_signup: true } }),
		query: async () => {
			throw new Error('no database in this fake');
		},
		connectOwner: async () => ({ ok: false, reason: 'fake' }),
		connectPooler: async () => ({ ok: false, reason: 'fake' }),
	});
	return {
		root,
		env,
		migrationsDir: new URL('../db/migrations/', import.meta.url),
		now: () => 0,
		exists: (path) => existsSync(join(root, path)),
		read: (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null),
		write: (path, text, mode) => {
			writeFileSync(join(root, path), text, { mode });
		},
		connectOwner: async () => {
			throw new Error('this test must not connect to a database');
		},
		authAdmin: () => {
			throw new Error('this test must not reach Supabase');
		},
		exec: (args, input) => {
			calls.exec.push({ args, input });
			return { status: 0, stdout: '[]', stderr: '' };
		},
		vercelLink: () => null,
		fetch: (async (url: string, init?: RequestInit) => {
			calls.fetches.push({ url, init });
			return new Response('{}', { status: 200 });
		}) as typeof fetch,
		doctor: async (e) => ({ ctx: emptyCtx(e), close: async () => undefined }),
		...over,
	};
}

const everything = (result: Awaited<ReturnType<typeof runSetup>>, options: Options) => summaryText(result.steps, options) + toText(result.checks) + JSON.stringify(result);
const STORE_ENV = { SUPABASE_URL: `https://${REF}.supabase.co`, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: STORE_KEY, NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co` };

test('setup copies the NEXT_PUBLIC_ names, makes the secrets, writes a private file, and prints no value', async () => {
	const root = folder();
	const result = await runSetup(OPTIONS, depsFor(root, { ...STORE_ENV }));
	const written = parse(readFileSync(join(root, '.env.local'), 'utf8'));
	assert.equal(written.PUBLIC_SUPABASE_PUBLISHABLE_KEY, STORE_KEY);
	assert.equal(written.PUBLIC_SUPABASE_URL, `https://${REF}.supabase.co`);
	for (const name of ['HOST_SESSION_SECRET', 'PARTICIPANT_SECRET', 'CRON_SECRET']) {
		assert.ok(written[name].length >= 64, `${name} has ${written[name].length} characters`);
		assert.ok(!everything(result, OPTIONS).includes(written[name]), `${name}'s value was printed`);
	}
	assert.equal(new Set([written.HOST_SESSION_SECRET, written.PARTICIPANT_SECRET, written.CRON_SECRET]).size, 3, 'three different secrets');
	assert.ok(!everything(result, OPTIONS).includes(STORE_KEY), 'the copied key was printed');
	assert.equal(statSync(join(root, '.env.local')).mode & 0o777, 0o600, 'the file is private to the owner');
	assert.match(summaryText(result.steps, OPTIONS), /HOST_SESSION_SECRET \(set \(64 chars\)\)/);
});

test('secrets have real entropy: fresh ones differ between runs and use many different characters', async () => {
	const first = folder();
	const second = folder();
	await runSetup(OPTIONS, depsFor(first, {}));
	await runSetup(OPTIONS, depsFor(second, {}));
	const one = parse(readFileSync(join(first, '.env.local'), 'utf8')).HOST_SESSION_SECRET;
	const two = parse(readFileSync(join(second, '.env.local'), 'utf8')).HOST_SESSION_SECRET;
	assert.notEqual(one, two);
	assert.ok(new Set(one).size >= 25, 'a long random string uses many different characters');
	assert.match(one, /^[A-Za-z0-9_-]{64}$/);
});

test('a second run changes nothing: same file bytes, every env step unchanged', async () => {
	const root = folder();
	await runSetup(OPTIONS, depsFor(root, { ...STORE_ENV }));
	const before = readFileSync(join(root, '.env.local'), 'utf8');
	const again = await runSetup(OPTIONS, depsFor(root, { ...STORE_ENV }));
	assert.equal(readFileSync(join(root, '.env.local'), 'utf8'), before);
	for (const id of ['env.public_names', 'env.secrets']) assert.equal(again.steps.find((s) => s.id === id)?.status, 'unchanged', id);
	assert.ok(!again.steps.some((s) => s.id === 'env.file'), 'nothing was written');
});

test('--force is required to replace a secret; without it the old value stays, with it a new one is made', async () => {
	const root = folder();
	await runSetup(OPTIONS, depsFor(root, {}));
	const original = parse(readFileSync(join(root, '.env.local'), 'utf8'));
	await runSetup(OPTIONS, depsFor(root, {}));
	assert.equal(parse(readFileSync(join(root, '.env.local'), 'utf8')).HOST_SESSION_SECRET, original.HOST_SESSION_SECRET, 'kept without --force');
	const forced = await runSetup({ ...OPTIONS, force: true }, depsFor(root, {}));
	const replaced = parse(readFileSync(join(root, '.env.local'), 'utf8'));
	assert.notEqual(replaced.HOST_SESSION_SECRET, original.HOST_SESSION_SECRET);
	assert.ok(!everything(forced, OPTIONS).includes(replaced.HOST_SESSION_SECRET), 'a forced secret is not printed either');
	assert.match(summaryText(forced.steps, OPTIONS), /signed out/);
});

test('--force rewrites only the secret lines: comments and other settings stay exactly as they were', async () => {
	const root = folder({ '.env.local': '# my notes\nSUPABASE_URL=https://mine.example\nHOST_SESSION_SECRET=old-value-to-replace\nOTHER=keep me\n' });
	await runSetup({ ...OPTIONS, force: true }, depsFor(root, {}));
	const text = readFileSync(join(root, '.env.local'), 'utf8');
	assert.match(text, /^# my notes$/m);
	assert.match(text, /^SUPABASE_URL=https:\/\/mine\.example$/m);
	assert.match(text, /^OTHER=keep me$/m);
	assert.doesNotMatch(text, /old-value-to-replace/);
	assert.equal((text.match(/^HOST_SESSION_SECRET=/gm) ?? []).length, 1, 'replaced in place, not duplicated');
});

test('an existing PUBLIC_ value is never replaced by a NEXT_PUBLIC_ copy', async () => {
	const root = folder({ '.env.local': 'PUBLIC_SUPABASE_PUBLISHABLE_KEY=my-own-key\n# a comment that must survive\n' });
	await runSetup(OPTIONS, depsFor(root, { NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: STORE_KEY }));
	const text = readFileSync(join(root, '.env.local'), 'utf8');
	assert.match(text, /^PUBLIC_SUPABASE_PUBLISHABLE_KEY=my-own-key$/m);
	assert.match(text, /# a comment that must survive/);
});

test('--dry-run changes nothing and says what it would do; --from-env-file only fills gaps', async () => {
	const root = folder({ '.env.pulled': `SUPABASE_URL=https://${REF}.supabase.co\nPOSTGRES_URL=postgres://x\nSTRAY_NAME=nope\n` });
	const dry = await runSetup({ ...OPTIONS, dryRun: true, fromEnvFile: '.env.pulled' }, depsFor(root, { ...STORE_ENV }));
	assert.equal(existsSync(join(root, '.env.local')), false, 'a dry run wrote nothing');
	assert.ok(dry.steps.every((s) => s.status !== 'done'));
	assert.match(summaryText(dry.steps, { ...OPTIONS, dryRun: true }), /DRY RUN: nothing was changed/);
	assert.ok(dry.steps.some((s) => s.status === 'would'));

	await runSetup({ ...OPTIONS, fromEnvFile: '.env.pulled' }, depsFor(root, { SUPABASE_URL: 'https://already-set.example' }));
	const written = parse(readFileSync(join(root, '.env.local'), 'utf8'));
	assert.equal(written.POSTGRES_URL, 'postgres://x', 'a missing name was imported');
	assert.equal(written.SUPABASE_URL, undefined, 'a name that was already set is left alone');
	assert.equal(written.STRAY_NAME, undefined, 'names the app does not read are ignored');
});

test('setup refuses to run against this repo\'s production database, before writing anything', async () => {
	const root = folder();
	const result = await runSetup(OPTIONS, depsFor(root, { POSTGRES_URL_NON_POOLING: `postgres://postgres.${PRODUCTION_REF}:pw@127.0.0.1:1/postgres` }));
	assert.equal(result.steps[0].id, 'guard.production');
	assert.equal(result.steps[0].status, 'failed');
	assert.match(result.steps[0].detail, /points at the production database/);
	assert.equal(existsSync(join(root, '.env.local')), false);
	assert.ok(!everything(result, OPTIONS).includes(`postgres.${PRODUCTION_REF}:pw`), 'the connection string was printed');
});

test('setup with no TTY and a missing flag value stops with a message naming the flag, and never waits for input', () => {
	const run = spawnSync(process.execPath, ['scripts/setup.ts', '--first-admin-email'], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' } });
	assert.equal(run.status, 1);
	assert.match(run.stderr, /--first-admin-email needs a value/);
	assert.equal(run.stdout, '', 'it stopped before doing anything');
	const unknown = spawnSync(process.execPath, ['scripts/setup.ts', '--nonsense'], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' } });
	assert.equal(unknown.status, 1);
	assert.match(unknown.stderr, /Unknown option --nonsense/);
	const help = spawnSync(process.execPath, ['scripts/setup.ts', '--help'], { encoding: 'utf8', timeout: 15_000, env: { PATH: process.env.PATH ?? '' } });
	assert.equal(help.status, 0);
	for (const word of ['--dry-run', '--force', '--first-admin-email', '--push-vercel-env', 'Exit codes:', 'never asks a question']) assert.match(help.stdout, new RegExp(word));
});

test('a full dry run in an empty folder with no environment finishes by itself and tells the agent what to do', () => {
	rmSync('.env.nothing', { force: true });
	const run = spawnSync(process.execPath, [join(process.cwd(), 'scripts/setup.ts'), '--dry-run', '--skip-migrate', '--env-out', '.env.nothing'], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' } });
	assert.notEqual(run.status, null, 'it did not hang');
	assert.ok([1, 2].includes(run.status as number));
	assert.match(run.stdout, /DRY RUN: nothing was changed/);
	assert.match(run.stdout, /Verdict: not ready/);
	assert.equal(existsSync('.env.nothing'), false);
});

test('--push-vercel-env: only the linked project, values on stdin never in arguments, existing names left alone', async () => {
	const root = folder();
	const calls: Calls = { exec: [], fetches: [] };
	const env = { ...STORE_ENV, HOST_SESSION_SECRET: `host-${'a'.repeat(60)}`, PARTICIPANT_SECRET: `part-${'b'.repeat(60)}`, CRON_SECRET: `cron-${'c'.repeat(60)}`, SUPABASE_SECRET_KEY: 'sb_secret_THE_SERVER_KEY_VALUE', POSTGRES_URL: 'postgres://u:pw@aws-0-eu-west-2.pooler.supabase.com:6543/postgres', POSTGRES_URL_NON_POOLING: 'postgres://u:pw@h:5432/postgres', PUBLIC_SUPABASE_PUBLISHABLE_KEY: STORE_KEY };
	const exec: Deps['exec'] = (args, input) => {
		calls.exec.push({ args, input });
		if (args[0] === 'env' && args[1] === 'ls') return { status: 0, stdout: JSON.stringify([{ key: 'SUPABASE_URL', target: ['production', 'preview'] }, { key: 'HOST_SESSION_SECRET', target: ['production'] }]), stderr: '' };
		return { status: 0, stdout: '{}', stderr: '' };
	};

	const unlinked = await runSetup({ ...OPTIONS, pushVercelEnv: true }, depsFor(root, env, { exec }, calls));
	assert.equal(unlinked.steps.find((s) => s.id === 'vercel.env')?.status, 'failed');
	assert.equal(calls.exec.length, 0, 'an unlinked folder touches nothing on Vercel');

	const dry = await runSetup({ ...OPTIONS, pushVercelEnv: true, dryRun: true }, depsFor(root, env, { exec, vercelLink: () => ({ projectId: 'prj_1', orgId: 'team_1' }) }, calls));
	assert.equal(dry.steps.find((s) => s.id === 'vercel.env')?.status, 'would');
	assert.ok(!calls.exec.some((call) => call.args.includes('add')), 'a dry run adds nothing');

	const done = await runSetup({ ...OPTIONS, pushVercelEnv: true }, depsFor(root, env, { exec, vercelLink: () => ({ projectId: 'prj_1', orgId: 'team_1' }) }, calls));
	assert.equal(done.steps.find((s) => s.id === 'vercel.env')?.status, 'done');
	const adds = calls.exec.filter((call) => call.args[0] === 'env' && call.args[1] === 'add');
	assert.ok(adds.length > 0);
	const writesTo = calls.exec.filter((call) => call.args[0] === 'env' && (call.args[1] === 'add' || call.args[1] === 'update'));
	assert.ok(!writesTo.some((call) => call.args[2] === 'SUPABASE_URL'), 'a name Vercel already has is neither added nor updated without --force');
	assert.ok(!writesTo.some((call) => call.args[2] === 'HOST_SESSION_SECRET' && call.args[3] === 'production'), 'and not on a target that already has it');
	assert.ok(adds.some((call) => call.args[2] === 'HOST_SESSION_SECRET' && call.args[3] === 'preview'));
	assert.ok(!adds.some((call) => call.args[2] === 'CRON_SECRET' && call.args[3] === 'preview'), 'the cron secret is production only');
	for (const call of adds) {
		assert.equal(call.input, env[call.args[2] as keyof typeof env], 'the value goes in on stdin');
		for (const arg of call.args) assert.notEqual(arg, env[call.args[2] as keyof typeof env], 'a value must not be an argument');
		if (['HOST_SESSION_SECRET', 'SUPABASE_SECRET_KEY', 'POSTGRES_URL'].includes(call.args[2])) assert.ok(call.args.includes('--sensitive'), `${call.args[2]} is sensitive`);
	}
	assert.ok(!everything(done, OPTIONS).includes('sb_secret_THE_SERVER_KEY_VALUE'));
});

test('--vercel-protection changes the setting only when it is wrong, and only on the linked project', async () => {
	const calls: Calls = { exec: [], fetches: [] };
	const link = () => ({ projectId: 'prj_1', orgId: 'team_1' });
	const exec = (current: string | null): Deps['exec'] => (args, input) => {
		calls.exec.push({ args, input });
		return { status: 0, stdout: JSON.stringify({ ssoProtection: current === null ? null : { deploymentType: current } }), stderr: '' };
	};
	const ok = await runSetup({ ...OPTIONS, vercelProtection: true }, depsFor(folder(), {}, { exec: exec('preview'), vercelLink: link }, calls));
	assert.equal(ok.steps.find((s) => s.id === 'vercel.protection')?.status, 'unchanged');
	assert.ok(!calls.exec.some((call) => call.args.includes('PATCH')));

	const wrong = await runSetup({ ...OPTIONS, vercelProtection: true }, depsFor(folder(), {}, { exec: exec('all'), vercelLink: link }, calls));
	assert.equal(wrong.steps.find((s) => s.id === 'vercel.protection')?.status, 'done');
	const patch = calls.exec.find((call) => call.args.includes('PATCH'));
	assert.ok(patch);
	assert.ok(patch.args.some((arg) => arg.includes('prj_1')), 'the linked project');
	assert.deepEqual(JSON.parse(patch.input ?? ''), { ssoProtection: { deploymentType: 'preview' } });

	const none = await runSetup({ ...OPTIONS, vercelProtection: true }, depsFor(folder(), {}, { exec: exec('all') }, calls));
	assert.equal(none.steps.find((s) => s.id === 'vercel.protection')?.status, 'failed');
	assert.equal(none.steps.find((s) => s.id === 'vercel.protection')?.next[0].command, 'vercel link');
});

test('--disable-signup needs an access token, and says plainly what a person does instead', async () => {
	const calls: Calls = { exec: [], fetches: [] };
	const without = await runSetup({ ...OPTIONS, disableSignup: true }, depsFor(folder(), { SUPABASE_URL: `https://${REF}.supabase.co` }, {}, calls));
	const step = without.steps.find((s) => s.id === 'auth.signup_disabled');
	assert.equal(step?.status, 'failed');
	assert.ok(step?.next.every((next) => next.kind === 'human'));
	assert.equal(calls.fetches.length, 0);
	assert.equal(without.exitCode === 2 || without.exitCode === 1, true);

	const withToken = await runSetup({ ...OPTIONS, disableSignup: true }, depsFor(folder(), { SUPABASE_URL: `https://${REF}.supabase.co`, SUPABASE_ACCESS_TOKEN: 'sbp_TOKEN_VALUE_XYZ' }, {}, calls));
	assert.equal(withToken.steps.find((s) => s.id === 'auth.signup_disabled')?.status, 'done');
	assert.equal(calls.fetches[0].url, `https://api.supabase.com/v1/projects/${REF}/config/auth`);
	assert.equal(calls.fetches[0].init?.method, 'PATCH');
	assert.ok(!everything(withToken, OPTIONS).includes('sbp_TOKEN_VALUE_XYZ'));
});

// ---- the database steps, on the TEST database ----

const admin = () => createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SECRET_KEY ?? '', { auth: { persistSession: false, autoRefreshToken: false } }).auth.admin;

async function withDb<T>(body: (db: pg.Client) => Promise<T>): Promise<T> {
	const db = await connectOwnerWith(process.env);
	try {
		return await body(db);
	} finally {
		await db.end();
	}
}

test('the first admin: made once with the password in a private file and nowhere else; a second run changes nothing', { skip }, async () => {
	const email = `volley-setup-${randomUUID()}@example.com`;
	const root = folder();
	const deps = () => depsFor(root, { ...process.env }, { connectOwner: connectOwnerWith, authAdmin: () => admin() });
	const options = { ...OPTIONS, firstAdminEmail: email, firstAdminName: 'First' };
	try {
		const first = await runSetup(options, deps());
		const made = first.steps.find((s) => s.id === 'hosts.first_admin');
		assert.equal(made?.status, 'done', made?.detail);
		const file = readFileSync(join(root, FIRST_ADMIN_FILE), 'utf8');
		const password = /password: (\S+)/.exec(file)?.[1] ?? '';
		assert.ok(password.length >= 32);
		assert.equal(statSync(join(root, FIRST_ADMIN_FILE)).mode & 0o777, 0o600);
		assert.ok(!everything(first, options).includes(password), 'the password was printed');
		assert.ok(made?.next.some((next) => next.kind === 'human'), 'handing over the password is a HUMAN step');
		const row = await withDb(async (db) => (await db.query('select is_admin, name from public.hosts where email = $1', [email])).rows[0]);
		assert.deepEqual(row, { is_admin: true, name: 'First' });

		const second = await runSetup(options, deps());
		assert.equal(second.steps.find((s) => s.id === 'hosts.first_admin')?.status, 'unchanged');
		assert.equal(readFileSync(join(root, FIRST_ADMIN_FILE), 'utf8'), file, 'the password file was not touched');
	} finally {
		await withDb(async (db) => {
			const { rows } = await db.query('select id from auth.users where lower(email) = $1', [email]);
			for (const { id } of rows) await admin().deleteUser(id);
		});
		rmSync(root, { recursive: true, force: true });
	}
});

test('an existing account that is not a host is not touched without --force', { skip }, async () => {
	const email = `volley-setup-${randomUUID()}@example.com`;
	const root = folder();
	const created = await admin().createUser({ email, password: `Pw-${randomUUID()}`, email_confirm: true });
	try {
		const deps = depsFor(root, { ...process.env }, { connectOwner: connectOwnerWith, authAdmin: () => admin() });
		const result = await runSetup({ ...OPTIONS, firstAdminEmail: email }, deps);
		const step = result.steps.find((s) => s.id === 'hosts.first_admin');
		assert.equal(step?.status, 'failed');
		assert.match(step?.detail ?? '', /--force/);
		assert.equal(existsSync(join(root, FIRST_ADMIN_FILE)), false, 'no password file was made');
		const hosts = await withDb(async (db) => (await db.query('select count(*)::int as n from public.hosts where email = $1', [email])).rows[0].n);
		assert.equal(hosts, 0);
	} finally {
		if (created.data.user) await admin().deleteUser(created.data.user.id);
		rmSync(root, { recursive: true, force: true });
	}
});

test('migrations: a dry run on an up-to-date database applies nothing and a real run is a no-op; a bad address is a clear failed step', { skip }, async () => {
	const root = folder();
	const deps = depsFor(root, { ...process.env }, { connectOwner: connectOwnerWith });
	const dry = await runSetup({ ...OPTIONS, skipMigrate: false, dryRun: true }, deps);
	assert.equal(dry.steps.find((s) => s.id === 'db.migrate')?.status, 'unchanged');
	const real = await runSetup({ ...OPTIONS, skipMigrate: false }, deps);
	assert.equal(real.steps.find((s) => s.id === 'db.migrate')?.status, 'unchanged');
	assert.equal(existsSync(join(root, '.env.local')), false, 'a re-run on a complete copy writes no file');

	const broken = await runSetup({ ...OPTIONS, skipMigrate: false }, depsFor(folder(), { ...process.env, POSTGRES_URL_NON_POOLING: undefined }, { connectOwner: connectOwnerWith }));
	const failed = broken.steps.find((s) => s.id === 'db.connect');
	assert.equal(failed?.status, 'failed');
	assert.match(failed?.detail ?? '', /POSTGRES_URL_NON_POOLING is not set/);
	assert.equal(failed?.next[0].kind, 'human');
});

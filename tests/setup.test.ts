// npm run setup: idempotent, never overwrites without --force, never prints a secret, never
// prompts. Env-file steps run against a temp folder with fakes; the database steps run against
// the TEST database (rolled back or cleaned up). Nothing here can reach production.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import type pg from 'pg';
import { PRODUCTION_REF } from '../scripts/production-guard.ts';
import { runChecks, type Ctx } from '../scripts/lib/checks.ts';
import { connectOwnerWith, realContext } from '../scripts/lib/context.ts';
import { parse } from '../scripts/lib/env.ts';
import { makeHost } from '../scripts/lib/make-host.ts';
import { toText } from '../scripts/lib/report.ts';
import { FIRST_ADMIN_FILE, realDeps, runSetup, summaryText, type Deps, type Options } from '../scripts/lib/setup.ts';
import { skipWithoutDatabase as skip } from './db-helpers.ts';

const REF = 'abcdefghijklmnopqrst';
const STORE_KEY = 'sb_publishable_VALUE_FROM_THE_STORE_0123456789';

const OPTIONS: Options = { dryRun: false, force: false, resetFirstAdmin: false, envFile: '.env.local', skipMigrate: true, pushVercelEnv: false, vercelTargets: ['production', 'preview'], vercelProtection: false, disableSignup: false };

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
		read: (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null),
		write: (path, text, mode) => {
			writeFileSync(join(root, path), text, { mode });
		},
		isIgnored: () => true,
		remove: (path) => rmSync(join(root, path), { force: true }),
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

test('--from-env-file only imports names shaped like settings, and a value with $ patterns arrives unmangled', async () => {
	const tricky = 'postgres://u:p$&w$`z@h:5432/postgres';
	const root = folder({ '.env.pulled.local': `POSTGRES_URL_NON_POOLING='${tricky}'\nPUBLIC_lowercase=1\nNEXT_PUBLIC_A-B=2\nPUBLIC_OK=3\n` });
	await runSetup({ ...OPTIONS, fromEnvFile: '.env.pulled.local' }, depsFor(root, {}));
	const written = parse(readFileSync(join(root, '.env.local'), 'utf8'));
	assert.equal(written.POSTGRES_URL_NON_POOLING, tricky);
	assert.equal(written.PUBLIC_OK, '3');
	assert.equal(written.PUBLIC_lowercase, undefined, 'a lowercase name is not a setting');
	assert.equal(written['NEXT_PUBLIC_A-B'], undefined, 'nor is a name with a dash');
});

test('an imported value that cannot be written back faithfully stops setup before anything is written', async () => {
	const root = folder({ '.env.pulled.local': 'POSTGRES_URL="first line\\nsecond line"\n' });
	const result = await runSetup({ ...OPTIONS, fromEnvFile: '.env.pulled.local' }, depsFor(root, {}));
	const failed = result.steps.find((s) => s.id === 'env.file');
	assert.equal(failed?.status, 'failed');
	assert.match(failed?.detail ?? '', /POSTGRES_URL/);
	assert.ok(!everything(result, OPTIONS).includes('second line'), 'the value was printed');
	assert.equal(existsSync(join(root, '.env.local')), false, 'no half-written file');
	assert.equal(result.exitCode, 2);
});

test('the real write is private from the start: an existing world-readable .env.local ends up 0600 and complete', async () => {
	const root = folder({ '.env.local': '# mine\nKEEP=1\n' });
	chmodSync(join(root, '.env.local'), 0o644);
	const hooks = { connectOwner: connectOwnerWith, authAdmin: () => admin(), exec: () => ({ status: 0, stdout: '[]', stderr: '' }), vercelLink: () => null, doctor: async (e: Record<string, string | undefined>) => depsFor(root, e).doctor(e) };
	await runSetup(OPTIONS, { ...realDeps(root, {}, hooks), isIgnored: () => true });
	assert.equal(statSync(join(root, '.env.local')).mode & 0o777, 0o600);
	assert.match(readFileSync(join(root, '.env.local'), 'utf8'), /^# mine\nKEEP=1\nHOST_SESSION_SECRET=/);
	assert.deepEqual(readdirSync(root).filter((name) => name.endsWith('.tmp')), []);
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

test('a production address that arrives ONLY through --from-env-file is refused: nothing written, no connection, no Vercel call, doctor skips its database checks', async () => {
	const root = folder({ '.env.pulled.local': `POSTGRES_URL_NON_POOLING=postgres://postgres.${PRODUCTION_REF}:pw-IMPORTED@127.0.0.1:1/postgres\n` });
	const calls: Calls = { exec: [], fetches: [] };
	let connects = 0;
	let doctorConnects = 0;
	const doctor: Deps['doctor'] = async (e) => ({
		ctx: {
			env: e, readFile: () => null, migrationsOnDisk: () => [], fetchJson: async () => ({ status: 200, body: { disable_signup: true } }),
			query: async () => { doctorConnects++; return []; },
			connectOwner: async () => { doctorConnects++; return { ok: true }; },
			connectPooler: async () => { doctorConnects++; return { ok: true }; },
		},
		close: async () => undefined,
	});
	const deps = depsFor(root, { ...STORE_ENV }, { doctor, vercelLink: () => ({ projectId: 'p', orgId: 't' }), connectOwner: async () => { connects++; throw new Error('connected'); } }, calls);
	const result = await runSetup({ ...OPTIONS, skipMigrate: false, firstAdminEmail: 'a@example.com', pushVercelEnv: true, vercelProtection: true, fromEnvFile: '.env.pulled.local' }, deps);
	const guard = result.steps.find((s) => s.id === 'guard.production');
	assert.equal(guard?.status, 'failed');
	assert.match(guard?.detail ?? '', /POSTGRES_URL_NON_POOLING points at the production database/);
	assert.equal(connects, 0, 'setup connected to production');
	assert.equal(doctorConnects, 0, 'doctor connected to production');
	assert.equal(calls.exec.length, 0, 'nothing was pushed to Vercel');
	assert.equal(existsSync(join(root, '.env.local')), false, 'the production address was not written to the env file');
	assert.ok(!everything(result, OPTIONS).includes('pw-IMPORTED'), 'the connection string was printed');
	for (const id of ['db.connect', 'db.pooler_tls', 'db.migrations', 'db.pg_cron', 'hosts.first_admin']) assert.equal(result.checks.find((c) => c.id === id)?.status, 'skipped', id);
	assert.equal(result.exitCode, 2, 'only a person can fix this');
});

test('the database connection itself refuses production, so a future step cannot skip the guard', async () => {
	await assert.rejects(connectOwnerWith({ POSTGRES_URL_NON_POOLING: `postgres://postgres.${PRODUCTION_REF}:pw@127.0.0.1:1/postgres` }), /production database/);
	const env = { POSTGRES_URL: `postgres://postgres.${PRODUCTION_REF}:pw@127.0.0.1:1/postgres`, POSTGRES_URL_NON_POOLING: `postgres://postgres.${PRODUCTION_REF}:pw@127.0.0.1:1/postgres` };
	const { ctx, close } = realContext(process.cwd(), env, false);
	try {
		const checks = await runChecks(ctx);
		for (const id of ['db.connect', 'db.pooler_tls', 'db.migrations', 'db.pg_cron']) assert.equal(checks.find((c) => c.id === id)?.status, 'skipped', `${id}: a real attempt to 127.0.0.1:1 would have failed, not skipped`);
	} finally {
		await close();
	}
});

test('the connection guard reads the address the way pg does: an encoded or overridden production ref is refused before any connection', async () => {
	for (const address of [
		'postgresql://postgres:pw@db.%71eheedlsskaurqshmueb.supabase.co:5432/postgres',
		'postgresql://postgres:pw@aws-0-eu-west-2.pooler.supabase.com:5432/postgres?host=db.%71eheedlsskaurqshmueb.supabase.co',
	]) {
		await assert.rejects(connectOwnerWith({ POSTGRES_URL_NON_POOLING: address }), /production database/, address);
		const { ctx, close } = realContext(process.cwd(), { POSTGRES_URL: address, POSTGRES_URL_NON_POOLING: address }, false);
		try {
			assert.equal((await runChecks(ctx)).find((c) => c.id === 'db.connect')?.status, 'skipped', 'doctor must not connect either');
		} finally {
			await close();
		}
	}
});

test('.gitignore covers every .env* name except .env.example, including the names setup suggests', () => {
	const ignored = (name: string) => spawnSync('git', ['check-ignore', '-q', '--no-index', name], { encoding: 'utf8' }).status === 0;
	for (const name of ['.env', '.env.local', '.env.pulled', '.env.pulled.local', '.env.production', '.env.nothing']) assert.ok(ignored(name), `${name} is not ignored`);
	assert.equal(ignored('.env.example'), false, '.env.example is meant to be committed');
	for (const name of [FIRST_ADMIN_FILE, `${FIRST_ADMIN_FILE}.123.tmp`]) assert.ok(ignored(name), `${name} is not ignored`);
});

test('--env-out refuses a path git does not ignore: nothing written, nothing printed', async () => {
	const root = folder();
	const result = await runSetup({ ...OPTIONS, envFile: '.env.custom' }, depsFor(root, { ...STORE_ENV }, { isIgnored: () => false }));
	const refused = result.steps.find((s) => s.id === 'env.out');
	assert.equal(refused?.status, 'failed');
	assert.match(refused?.detail ?? '', /\.env\.custom/);
	assert.equal(refused?.next[0].command, 'npm run setup -- --env-out .env.local');
	assert.equal(existsSync(join(root, '.env.custom')), false);
	assert.ok(!result.steps.some((s) => s.id === 'env.file'));
	const allowed = await runSetup({ ...OPTIONS, envFile: '.env.custom' }, depsFor(root, { ...STORE_ENV }, { isIgnored: () => true }));
	assert.ok(allowed.steps.some((s) => s.id === 'env.file' && s.status === 'done'));
});

test('the real isIgnored asks git: ignored in a repo that ignores it, not ignored otherwise, and allowed where there is no repo', () => {
	const repo = folder({ '.gitignore': '.env*\n!.env.example\n' });
	assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
	const hooks = { connectOwner: connectOwnerWith, authAdmin: () => admin(), exec: () => ({ status: 0, stdout: '', stderr: '' }), vercelLink: () => null, doctor: async () => { throw new Error('unused'); } };
	const deps = realDeps(repo, {}, hooks);
	assert.equal(deps.isIgnored('.env.pulled'), true);
	assert.equal(deps.isIgnored('.env.example'), false);
	assert.equal(deps.isIgnored('notes.txt'), false);
	assert.equal(realDeps(folder(), {}, hooks).isIgnored('anything.txt'), true, 'no repo, nothing to commit to');
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
	for (const word of ['--dry-run', '--force', '--reset-first-admin', '--first-admin-email', '--push-vercel-env', 'Exit codes:', 'never asks a question']) assert.match(help.stdout, new RegExp(word));
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

test('--vercel-protection rewrites only "all"; Standard Protection and anything unknown are reported and left alone', async () => {
	const calls: Calls = { exec: [], fetches: [] };
	const link = () => ({ projectId: 'prj_1', orgId: 'team_1' });
	for (const current of ['prod_deployment_urls_and_all_previews', 'brand_new_mode']) {
		const exec: Deps['exec'] = (args, input) => {
			calls.exec.push({ args, input });
			return { status: 0, stdout: JSON.stringify({ ssoProtection: { deploymentType: current } }), stderr: '' };
		};
		const result = await runSetup({ ...OPTIONS, vercelProtection: true }, depsFor(folder(), {}, { exec, vercelLink: link }, calls));
		const step = result.steps.find((s) => s.id === 'vercel.protection');
		assert.equal(step?.status, 'warn', current);
		assert.ok(step?.next.every((next) => next.kind === 'human'));
		assert.ok(!calls.exec.some((call) => call.args.includes('PATCH')), `${current} was rewritten`);
	}
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

// ---- the first admin, on a fake database: the order of steps and what a failure leaves behind ----

type HostState = { host?: { is_admin: boolean }; account?: boolean };
type WorldOptions = { accountAppearsLate?: boolean; failWrite?: boolean; failCreate?: boolean; failPromote?: boolean; hostsTableMissing?: boolean; files?: Record<string, string> };

function fakeAdminWorld(state: HostState, over: WorldOptions = {}) {
	const log: string[] = [];
	let checked = 0;
	const db = {
		query: async (sql: string) => {
			const text = sql.replace(/\s+/g, ' ').trim();
			if (/^(begin|commit|rollback)$/.test(text)) { log.push(`db:${text}`); return { rows: [], rowCount: 0 }; }
			if (over.hostsTableMissing && /public\.hosts/.test(text)) throw Object.assign(new Error('relation "public.hosts" does not exist'), { code: '42P01' });
			if (/select is_admin from public\.hosts/.test(text)) return { rows: state.host ? [state.host] : [], rowCount: state.host ? 1 : 0 };
			if (/select 1 from auth\.users/.test(text)) {
				const there = state.account || (over.accountAppearsLate && checked++ > 0); // the first look says no, later ones say yes
				return { rows: there ? [{}] : [], rowCount: there ? 1 : 0 };
			}
			if (/select id from auth\.users/.test(text)) return { rows: state.account || over.accountAppearsLate ? [{ id: 'u-existing' }] : [], rowCount: state.account || over.accountAppearsLate ? 1 : 0 };
			if (/^insert into public\.hosts/.test(text)) { log.push('db:insert host'); return { rows: [], rowCount: 1 }; }
			if (/^update public\.hosts/.test(text)) {
				if (over.failPromote) throw new Error('deadlock detected');
				log.push('db:update host');
				return { rows: [], rowCount: 1 };
			}
			throw new Error(`unexpected SQL in this fake: ${text}`);
		},
		end: async () => undefined,
	} as unknown as pg.Client;
	const authAdmin = (): Deps['authAdmin'] extends (e: never) => infer A ? A : never => ({
		createUser: async () => {
			log.push('auth:createUser');
			if (state.account || over.failCreate) return { data: { user: null }, error: { message: 'boom: password pw-SECRET rejected' } };
			state.account = true; // the account now exists in the (fake) auth service
			return { data: { user: { id: 'u-new' } }, error: null };
		},
		updateUserById: async () => {
			log.push('auth:setPassword');
			return { error: null };
		},
	});
	const root = folder(over.files);
	const over2: Partial<Deps> = {
		connectOwner: async () => db,
		authAdmin,
		write: (path, text, mode) => {
			if (path === FIRST_ADMIN_FILE) log.push(`write:${path}`);
			if (over.failWrite && path === FIRST_ADMIN_FILE) throw new Error('disk full');
			writeFileSync(join(root, path), text, { mode });
		},
	};
	return { root, log, deps: depsFor(root, { POSTGRES_URL_NON_POOLING: 'postgres://u:p@h.invalid:5432/db' }, over2) };
}

const ADMIN_OPTIONS = { ...OPTIONS, firstAdminEmail: 'new.person@example.com' };
const passwordFileFor = (email: string) => `Volley first admin\nemail: ${email}\npassword: ${'x'.repeat(32)}\nSign in at the site root (/).\n`;

test('first admin: the password file is written BEFORE the account is touched; if the write fails no account is made or changed', async () => {
	const world = fakeAdminWorld({}, { failWrite: true });
	const result = await runSetup(ADMIN_OPTIONS, world.deps);
	const step = result.steps.find((s) => s.id === 'hosts.first_admin');
	assert.equal(step?.status, 'failed');
	assert.deepEqual(world.log, [`write:${FIRST_ADMIN_FILE}`], 'nothing else happened');

	const good = fakeAdminWorld({});
	await runSetup(ADMIN_OPTIONS, good.deps);
	assert.ok(good.log.indexOf(`write:${FIRST_ADMIN_FILE}`) >= 0 && good.log.indexOf(`write:${FIRST_ADMIN_FILE}`) < good.log.indexOf('auth:createUser'), `order was ${good.log.join(' → ')}`);
});

test('first admin: if the account cannot be made the password file is removed, the error is plain, and a rerun starts clean', async () => {
	const world = fakeAdminWorld({}, { failCreate: true });
	const first = await runSetup(ADMIN_OPTIONS, world.deps);
	const step = first.steps.find((s) => s.id === 'hosts.first_admin');
	assert.equal(step?.status, 'failed');
	assert.equal(existsSync(join(world.root, FIRST_ADMIN_FILE)), false, 'no file with a password for an account that does not exist');
	assert.match(step?.detail ?? '', /password file was removed/);

	const retry = fakeAdminWorld({});
	const again = await runSetup(ADMIN_OPTIONS, retry.deps);
	assert.equal(again.steps.find((s) => s.id === 'hosts.first_admin')?.status, 'done', 'a rerun makes the host (it is not "unchanged")');
});

test('first admin: making an existing non-admin host an admin needs --reset-first-admin', async () => {
	const without = fakeAdminWorld({ host: { is_admin: false }, account: true });
	const refused = await runSetup(ADMIN_OPTIONS, without.deps);
	const step = refused.steps.find((s) => s.id === 'hosts.first_admin');
	assert.equal(step?.status, 'failed');
	assert.match(step?.detail ?? '', /--reset-first-admin/);
	assert.equal(step?.next[0].kind, 'human', 'promoting someone is a person\'s decision');
	assert.equal(step?.next[0].command, undefined, 'a mistyped email must not become a command the agent runs');
	assert.match(step?.next[0].text ?? '', /Confirm new\.person@example\.com is the right person, then run: npm run setup -- --first-admin-email new\.person@example\.com --reset-first-admin/);
	assert.equal(refused.exitCode, 2);
	assert.ok(!without.log.some((entry) => entry.startsWith('db:')), 'the host row was not touched');

	const forced = fakeAdminWorld({ host: { is_admin: false }, account: true });
	const done = await runSetup({ ...ADMIN_OPTIONS, resetFirstAdmin: true }, forced.deps);
	assert.equal(done.steps.find((s) => s.id === 'hosts.first_admin')?.status, 'done');
	assert.ok(forced.log.includes('db:update host'));
	assert.ok(!forced.log.includes('auth:setPassword'), 'promoting a host does not touch its password');

	const dry = fakeAdminWorld({ host: { is_admin: false }, account: true });
	const would = await runSetup({ ...ADMIN_OPTIONS, resetFirstAdmin: true, dryRun: true }, dry.deps);
	assert.equal(would.steps.find((s) => s.id === 'hosts.first_admin')?.status, 'would');
	assert.deepEqual(dry.log, []);
});

test('first admin: the password file must be git-ignored before anything is made', async () => {
	const unignored = fakeAdminWorld({});
	const refused = await runSetup(ADMIN_OPTIONS, { ...unignored.deps, isIgnored: (path) => path !== FIRST_ADMIN_FILE });
	assert.equal(refused.steps.find((s) => s.id === 'hosts.first_admin')?.status, 'failed');
	assert.deepEqual(unignored.log, [], 'nothing written, nothing created');
});

test('setup\'s own account-changing run steps carry `confirm`: vercel link, and a --reset-first-admin rerun (but not a plain rerun)', async () => {
	const unlinked = await runSetup({ ...OPTIONS, pushVercelEnv: true, vercelProtection: true }, depsFor(folder(), {}));
	for (const id of ['vercel.env', 'vercel.protection']) {
		const next = unlinked.steps.find((s) => s.id === id)?.next.find((n) => n.command === 'vercel link');
		assert.equal(next?.confirm, 'account', id);
	}
	const account = await runSetup(ADMIN_OPTIONS, fakeAdminWorld({}, { failPromote: true }).deps);
	assert.equal(account.steps.find((s) => s.id === 'hosts.first_admin')?.next[0].confirm, 'destructive', 'the rerun resets an account that exists');
	const none = await runSetup(ADMIN_OPTIONS, fakeAdminWorld({}, { failCreate: true }).deps);
	assert.equal(none.steps.find((s) => s.id === 'hosts.first_admin')?.next[0].confirm, undefined, 'a plain rerun changes nothing that exists');
	assert.match(summaryText(account.steps, ADMIN_OPTIONS), /\[ask the person first\]/);
});

test('first admin: a bad email is refused without echoing it, and the fix is a person\'s step with a template, never a command', async () => {
	const hostile = 'a@b.com; touch /tmp/pwned #';
	const world = fakeAdminWorld({});
	const result = await runSetup({ ...ADMIN_OPTIONS, firstAdminEmail: hostile }, world.deps);
	const step = result.steps.find((s) => s.id === 'hosts.first_admin');
	assert.equal(step?.status, 'failed');
	assert.ok(!JSON.stringify(result.steps).includes('touch /tmp/pwned'), 'the hostile text was echoed back');
	assert.ok(step?.next.every((next) => next.kind === 'human' && next.command === undefined));
	assert.match(step?.next[0].template ?? '', /--first-admin-email <EMAIL>/);
	assert.equal(result.exitCode, 2);
	assert.deepEqual(world.log, []);
});

test('with no --first-admin-email, the skipped step asks a person for the email via a template, not a command', async () => {
	const result = await runSetup(OPTIONS, depsFor(folder(), {}));
	const step = result.steps.find((s) => s.id === 'hosts.first_admin');
	assert.equal(step?.status, 'skipped');
	assert.equal(step?.next[0].kind, 'human');
	assert.equal(step?.next[0].command, undefined);
	assert.match(step?.next[0].template ?? '', /<EMAIL>/);
});

// ---- migrations, pg_cron, exit codes and redaction, on a scripted fake database ----

const MIGRATION_FILES = readdirSync(new URL('../db/migrations/', import.meta.url)).filter((name) => name.endsWith('.sql')).sort();
const DB_ENV = { POSTGRES_URL_NON_POOLING: 'postgres://u:pw-DBPASS-0123@h.invalid:5432/db' };

// A pg client that answers by pattern and records every statement; anything unlisted is an error.
function scriptedDb(rules: [RegExp, (sql: string) => { rows: unknown[]; rowCount?: number } | Error][]) {
	const log: string[] = [];
	const client = {
		query: async (sql: string) => {
			const text = sql.replace(/\s+/g, ' ').trim();
			log.push(text);
			for (const [pattern, answer] of rules) {
				if (!pattern.test(text)) continue;
				const result = answer(text);
				if (result instanceof Error) throw result;
				return { rowCount: result.rows.length, ...result };
			}
			throw new Error(`unexpected SQL in this fake: ${text.slice(0, 80)}`);
		},
		end: async () => undefined,
	} as unknown as pg.Client;
	return { client, log };
}

const allApplied = (): [RegExp, () => { rows: unknown[] }] => [/^select filename from public\.schema_migrations/, () => ({ rows: MIGRATION_FILES.map((filename) => ({ filename })) })];
const bookkeeping: [RegExp, () => { rows: unknown[] }] = [/^create table if not exists public\.schema_migrations/, () => ({ rows: [] })];

test('--dry-run only reads: on a fresh database nothing is created and the plan names every migration', async () => {
	const { client, log } = scriptedDb([[/^begin read only$/, () => ({ rows: [] })], [/to_regclass\('public\.schema_migrations'\)/, () => ({ rows: [{ table: null }] })], [/^rollback$/, () => ({ rows: [] })]]);
	const result = await runSetup({ ...OPTIONS, skipMigrate: false, dryRun: true }, depsFor(folder(), DB_ENV, { connectOwner: async () => client }));
	const step = result.steps.find((s) => s.id === 'db.migrate');
	assert.equal(step?.status, 'would');
	assert.match(step?.detail ?? '', new RegExp(`Would apply ${MIGRATION_FILES.length}: ${MIGRATION_FILES[0]}`));
	assert.ok(log.every((sql) => /^(begin read only|rollback|select )/.test(sql)), `a dry run ran: ${log.join(' | ')}`);
	assert.ok(!log.some((sql) => /create table|alter table|revoke/i.test(sql)));
});

test('--dry-run on a database it cannot read is a failed step, never "all migrations are already applied"', async () => {
	const { client } = scriptedDb([[/^begin read only$/, () => ({ rows: [] })], [/to_regclass/, () => new Error('permission denied for schema public')], [/^rollback$/, () => ({ rows: [] })]]);
	const result = await runSetup({ ...OPTIONS, skipMigrate: false, dryRun: true }, depsFor(folder(), DB_ENV, { connectOwner: async () => client }));
	const step = result.steps.find((s) => s.id === 'db.migrate');
	assert.equal(step?.status, 'failed');
	assert.match(step?.detail ?? '', /permission denied/);
	assert.doesNotMatch(summaryText(result.steps, OPTIONS), /already applied/);
});

test('pg_cron: a missing purge job is scheduled with exactly migration 0008\'s arguments; a switched-off one is switched on', async () => {
	const migration = readFileSync(new URL(`../db/migrations/${MIGRATION_FILES.find((name) => name.startsWith('0008')) ?? 'missing'}`, import.meta.url), 'utf8').replace(/\s+/g, ' ');
	const expected = /select cron\.schedule\([^;]*\)/.exec(migration)?.[0];
	assert.ok(expected, 'found the schedule call in migration 0008');
	const missing = scriptedDb([bookkeeping, allApplied(), [/from cron\.job/, () => ({ rows: [] })], [/^select cron\.schedule/, () => ({ rows: [{ schedule: 1 }] })]]);
	const scheduled = await runSetup({ ...OPTIONS, skipMigrate: false }, depsFor(folder(), DB_ENV, { connectOwner: async () => missing.client }));
	assert.equal(scheduled.steps.find((s) => s.id === 'db.pg_cron')?.status, 'done');
	assert.ok(missing.log.includes(expected), `ran: ${missing.log.filter((sql) => /cron/.test(sql)).join(' | ')}`);

	const off = scriptedDb([bookkeeping, allApplied(), [/from cron\.job/, () => ({ rows: [{ jobid: 7, active: false }] })], [/cron\.alter_job/, () => ({ rows: [{}] })]]);
	const switched = await runSetup({ ...OPTIONS, skipMigrate: false }, depsFor(folder(), DB_ENV, { connectOwner: async () => off.client }));
	assert.equal(switched.steps.find((s) => s.id === 'db.pg_cron')?.status, 'done');
	assert.ok(off.log.some((sql) => /cron\.alter_job/.test(sql)));

	const fine = scriptedDb([bookkeeping, allApplied(), [/from cron\.job/, () => ({ rows: [{ jobid: 7, active: true }] })]]);
	const same = await runSetup({ ...OPTIONS, skipMigrate: false }, depsFor(folder(), DB_ENV, { connectOwner: async () => fine.client }));
	assert.equal(same.steps.find((s) => s.id === 'db.pg_cron')?.status, 'unchanged');
	assert.ok(!fine.log.some((sql) => /schedule|alter_job/.test(sql)));
});

test('a pg_cron failure after good migrations is its own step: step ids stay unique and the fix is a person\'s', async () => {
	const { client } = scriptedDb([bookkeeping, allApplied(), [/from cron\.job/, () => Object.assign(new Error('schema "cron" does not exist'), { code: '3F000' })]]);
	const result = await runSetup({ ...OPTIONS, skipMigrate: false }, depsFor(folder(), DB_ENV, { connectOwner: async () => client }));
	const ids = result.steps.map((s) => s.id);
	assert.equal(new Set(ids).size, ids.length, `duplicate step id in ${ids.join(', ')}`);
	assert.equal(result.steps.find((s) => s.id === 'db.migrate')?.status, 'unchanged');
	const cron = result.steps.find((s) => s.id === 'db.pg_cron');
	assert.equal(cron?.status, 'failed');
	assert.ok(cron?.next.every((next) => next.kind === 'human'));
	assert.match(cron?.next[0].text ?? '', /pg_cron/);
});

// A doctor whose only complaint is "run npm run setup": the loop an agent would be stuck in.
const SETUP_LOOP_DOCTOR: Deps['doctor'] = async (e) => ({
	ctx: {
		env: e, readFile: () => null, migrationsOnDisk: () => ['0001_a.sql'], fetchJson: async () => ({ status: 200, body: { disable_signup: true } }),
		query: async () => { throw Object.assign(new Error('relation "public.schema_migrations" does not exist'), { code: '42P01' }); },
		connectOwner: async () => ({ ok: true }), connectPooler: async () => ({ ok: true }),
	},
	close: async () => undefined,
});

test('exit code: a setup step that only a person can fix is exit 2 even when doctor also says "run setup"', async () => {
	const result = await runSetup({ ...OPTIONS, skipMigrate: false }, depsFor(folder(), {}, { doctor: SETUP_LOOP_DOCTOR }));
	assert.equal(result.steps.find((s) => s.id === 'db.connect')?.status, 'failed');
	assert.ok(result.checks.some((c) => c.status === 'fail' && c.next.some((n) => n.kind === 'run' && n.command === 'npm run setup')), 'doctor does suggest running setup');
	assert.equal(result.exitCode, 2, 'a loop: the agent would run setup again and get the same failure');
});

test('exit code: a failed step the agent can act on is exit 1, and a clean run with a clean doctor is 0', async () => {
	const hasCommand = await runSetup({ ...OPTIONS, vercelProtection: true }, depsFor(folder(), {}, { doctor: SETUP_LOOP_DOCTOR }));
	const link = hasCommand.steps.find((s) => s.id === 'vercel.protection');
	assert.equal(link?.status, 'failed');
	assert.ok(link?.next.some((n) => n.kind === 'run'), 'not linked: `vercel link` is something the agent runs');
	assert.equal(hasCommand.exitCode, 1);
});

test('secrets in error text are replaced before anything is reported: a driver message, a CLI message and a Management API message', async () => {
	const URL_WITH_PASSWORD = 'postgres://postgres.abcdefghijklmnopqrst:pw-LEAKY-PASSWORD-123@aws-0-eu-west-2.pooler.supabase.com:5432/postgres';
	const env = { POSTGRES_URL_NON_POOLING: URL_WITH_PASSWORD, SUPABASE_ACCESS_TOKEN: 'sbp_LEAKY_TOKEN_456', SUPABASE_URL: `https://${REF}.supabase.co`, SUPABASE_SECRET_KEY: 'sb_secret_LEAKY_KEY_789', HOST_SESSION_SECRET: `host-${'h'.repeat(60)}` };
	const calls: Calls = { exec: [], fetches: [] };
	const exec: Deps['exec'] = (args) => (args[1] === 'ls' ? { status: 0, stdout: '[]', stderr: '' } : { status: 1, stdout: '', stderr: `Error: rejected value sb_secret_LEAKY_KEY_789 for ${args[2]}` });
	const result = await runSetup({ ...OPTIONS, skipMigrate: false, pushVercelEnv: true, disableSignup: true }, depsFor(folder(), env, {
		connectOwner: async () => { throw new Error(`password authentication failed for ${URL_WITH_PASSWORD}`); },
		exec, vercelLink: () => ({ projectId: 'p', orgId: 't' }),
		fetch: (async () => { throw new Error('request to Bearer sbp_LEAKY_TOKEN_456 failed'); }) as typeof fetch,
	}, calls));
	const out = everything(result, OPTIONS);
	for (const secret of ['pw-LEAKY-PASSWORD-123', 'sbp_LEAKY_TOKEN_456', 'sb_secret_LEAKY_KEY_789', URL_WITH_PASSWORD]) assert.ok(!out.includes(secret), `leaked ${secret}`);
	assert.ok(result.steps.some((s) => s.id === 'db.connect' && s.status === 'failed' && s.detail.includes('[hidden]')), 'the message is still there, minus the secret');
});

test('first admin: an auth error that repeats the generated password never reaches the report', async () => {
	let seen = '';
	const world = fakeAdminWorld({}, {});
	const result = await runSetup(ADMIN_OPTIONS, { ...world.deps, authAdmin: () => ({
		createUser: async (attrs: { password: string }) => { seen = attrs.password; return { data: { user: null }, error: { message: `password ${attrs.password} is too weak` } }; },
		updateUserById: async () => ({ error: null }),
	}) });
	assert.ok(seen.length >= 32);
	assert.ok(!everything(result, OPTIONS).includes(seen), 'the generated password leaked through the error text');
	assert.equal(result.steps.find((s) => s.id === 'hosts.first_admin')?.status, 'failed');
});

test('--push-vercel-env help says it sends THIS machine\'s Supabase values to Production', () => {
	const help = spawnSync(process.execPath, ['scripts/setup.ts', '--help'], { encoding: 'utf8', timeout: 15_000, env: { PATH: process.env.PATH ?? '' } });
	const text = help.stdout.replace(/\s+/g, ' ');
	assert.match(text, /--push-vercel-env .*Production/);
	assert.match(text, /test (Supabase )?(project|database).*production (would )?use/i);
});

test('first admin: a failed password-file write leaves an existing file alone (the write is atomic, so there is nothing to clean up)', async () => {
	const world = fakeAdminWorld({}, { failWrite: true, files: { [FIRST_ADMIN_FILE]: passwordFileFor('new.person@example.com') } });
	const result = await runSetup({ ...ADMIN_OPTIONS, resetFirstAdmin: true }, world.deps);
	assert.equal(result.steps.find((s) => s.id === 'hosts.first_admin')?.status, 'failed');
	assert.equal(readFileSync(join(world.root, FIRST_ADMIN_FILE), 'utf8'), passwordFileFor('new.person@example.com'), 'a possibly valid file was deleted for nothing');
});

test('first admin: account and host row are made in ONE transaction; a failure rolls back and the advice matches what a rerun does', async () => {
	// The account is made, then the host step fails: rolled back, the account exists but is not a host, a rerun needs --reset-first-admin.
	const world = fakeAdminWorld({}, { failPromote: true });
	const result = await runSetup(ADMIN_OPTIONS, world.deps);
	const step = result.steps.find((s) => s.id === 'hosts.first_admin');
	assert.equal(step?.status, 'failed');
	assert.ok(world.log.includes('db:begin') && world.log.includes('db:rollback') && !world.log.includes('db:commit'), world.log.join(' → '));
	assert.equal(existsSync(join(world.root, FIRST_ADMIN_FILE)), false);
	assert.equal(step?.next[0].command, 'npm run setup -- --first-admin-email new.person@example.com --reset-first-admin', 'the account now exists, so a plain rerun would be refused');
	// And what the advice says is true: the rerun without --reset-first-admin really is refused.
	const state: HostState = { account: true };
	const plain = await runSetup(ADMIN_OPTIONS, fakeAdminWorld(state).deps);
	assert.equal(plain.steps.find((s) => s.id === 'hosts.first_admin')?.status, 'failed');

	// The account could not be made at all: nothing exists, so a plain rerun is the right advice.
	const none = fakeAdminWorld({}, { failCreate: true });
	const failed = await runSetup(ADMIN_OPTIONS, none.deps);
	assert.equal(failed.steps.find((s) => s.id === 'hosts.first_admin')?.next[0].command, 'npm run setup -- --first-admin-email new.person@example.com');
});

test('first admin: a database without the hosts table is a step, not a crash: "would" in a dry run, "failed" otherwise', async () => {
	const dry = await runSetup({ ...ADMIN_OPTIONS, dryRun: true }, fakeAdminWorld({}, { hostsTableMissing: true }).deps);
	const would = dry.steps.find((s) => s.id === 'hosts.first_admin');
	assert.equal(would?.status, 'would');
	assert.match(would?.detail ?? '', /migrations/);

	const real = await runSetup(ADMIN_OPTIONS, fakeAdminWorld({}, { hostsTableMissing: true }).deps);
	const failed = real.steps.find((s) => s.id === 'hosts.first_admin');
	assert.equal(failed?.status, 'failed');
	assert.match(failed?.detail ?? '', /hosts table/);
	assert.ok(failed?.next.every((next) => next.kind === 'human'));
	assert.equal(real.exitCode, 2);
});

test('first admin: any other database error while looking the host up is also a step with the message scrubbed', async () => {
	const { client } = scriptedDb([[/public\.hosts/, () => new Error('connection terminated: postgres://u:pw-DBPASS-0123@h.invalid:5432/db')]]);
	const result = await runSetup(ADMIN_OPTIONS, depsFor(folder(), DB_ENV, { connectOwner: async () => client }));
	const step = result.steps.find((s) => s.id === 'hosts.first_admin');
	assert.equal(step?.status, 'failed');
	assert.ok(!JSON.stringify(result).includes('pw-DBPASS-0123'));
});

test('--env-out must stay inside the repo: absolute, ../ and empty paths are refused, and the SAME relative path is checked and written', async () => {
	const outside = mkdtempSync(join(tmpdir(), 'volley-outside-'));
	for (const envFile of [join(outside, 'creds'), '../escape', '/scripts/creds', '.', '']) {
		const root = folder();
		const result = await runSetup({ ...OPTIONS, envFile }, depsFor(root, { ...STORE_ENV }));
		assert.equal(result.steps.find((s) => s.id === 'env.out')?.status, 'failed', JSON.stringify(envFile));
		assert.equal(existsSync(join(outside, 'creds')), false, 'secrets were written outside the repo');
		assert.deepEqual(readdirSync(root), [], `something was written under the repo for ${JSON.stringify(envFile)}`);
	}
	// An absolute path that lands inside the repo is fine, and git is asked about the path that is written.
	const root = folder();
	const asked: string[] = [];
	await runSetup({ ...OPTIONS, envFile: join(root, 'sub', '..', '.env.inside') }, depsFor(root, {}, { isIgnored: (path) => (asked.push(path), true) }));
	assert.deepEqual(asked, ['.env.inside']);
	assert.equal(existsSync(join(root, '.env.inside')), true);
});

test('the real isIgnored fails closed: outside the repo, through a symlinked folder, or when git cannot answer inside a repo', () => {
	const hooks = { connectOwner: connectOwnerWith, authAdmin: () => admin(), exec: () => ({ status: 0, stdout: '', stderr: '' }), vercelLink: () => null, doctor: async () => { throw new Error('unused'); } };
	const elsewhere = folder();
	const repo = folder({ '.gitignore': '.env*\n' });
	assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
	symlinkSync(elsewhere, join(repo, 'link'));
	const inRepo = realDeps(repo, {}, hooks);
	assert.equal(inRepo.isIgnored('.env.fine'), true);
	assert.equal(inRepo.isIgnored('../escape'), false, 'a path outside the repo');
	assert.equal(inRepo.isIgnored('link/.env.x'), false, 'git exits 128 beyond a symlink: that is not "ignored"');
	assert.equal(inRepo.isIgnored('/scripts/creds'), false);

	// No repo at all: nothing can be committed, but the file must still land inside the folder.
	const bare = folder();
	symlinkSync(elsewhere, join(bare, 'link'));
	const noRepo = realDeps(bare, {}, hooks);
	assert.equal(noRepo.isIgnored('.env.fine'), true);
	assert.equal(noRepo.isIgnored('link/.env.x'), false, 'a symlinked folder leads outside');
});

test('an error that escapes setup is scrubbed of the values it read from the env file and the import, not only process.env', async () => {
	const root = folder({ '.env.local': 'SUPABASE_SECRET_KEY=sb_secret_FROM_THE_ENV_FILE_123\n', '.env.pulled.local': 'POSTGRES_URL=postgres://u:pw-IMPORTED-456@h:6543/db\n' });
	const boom: Deps['doctor'] = async () => {
		throw new Error('doctor blew up near sb_secret_FROM_THE_ENV_FILE_123 and pw-IMPORTED-456');
	};
	await assert.rejects(runSetup({ ...OPTIONS, fromEnvFile: '.env.pulled.local' }, depsFor(root, {}, { doctor: boom })), (error: Error) => /doctor blew up/.test(error.message) && !error.message.includes('sb_secret_FROM_THE_ENV_FILE_123') && !error.message.includes('pw-IMPORTED-456'));
});

test('--reset-first-admin resets an existing account and leaves the generated secrets byte-identical', async () => {
	const first = fakeAdminWorld({ host: { is_admin: true }, account: true });
	await runSetup(OPTIONS, first.deps); // writes the secrets into .env.local
	const before = readFileSync(join(first.root, '.env.local'));
	const state: HostState = { account: true };
	const second = fakeAdminWorld(state);
	writeFileSync(join(second.root, '.env.local'), before);
	const result = await runSetup({ ...ADMIN_OPTIONS, resetFirstAdmin: true }, second.deps);
	assert.equal(result.steps.find((s) => s.id === 'hosts.first_admin')?.status, 'done');
	assert.ok(second.log.includes('auth:setPassword'), 'the account password was reset');
	assert.ok(readFileSync(join(second.root, '.env.local')).equals(before), 'the secrets were touched');
	assert.ok(!result.steps.some((s) => s.id === 'env.file'), 'nothing was written to the env file');
	assert.equal(result.steps.find((s) => s.id === 'env.secrets')?.status, 'unchanged');
});

test('--force alone leaves an existing account and host alone (it only replaces secrets)', async () => {
	for (const state of [{ account: true }, { host: { is_admin: false }, account: true }] as HostState[]) {
		const world = fakeAdminWorld(state, { files: { [FIRST_ADMIN_FILE]: 'old password file\n' } });
		const result = await runSetup({ ...ADMIN_OPTIONS, force: true }, world.deps);
		const step = result.steps.find((s) => s.id === 'hosts.first_admin');
		assert.equal(step?.status, 'failed', JSON.stringify(state));
		assert.match(step?.detail ?? '', /--reset-first-admin/);
		assert.match(step?.detail ?? '', /--force.*regenerat/i, 'the warning says what --force really does');
		assert.ok(!world.log.some((entry) => /^(auth:|db:(insert|update|begin))/.test(entry)), `touched the account: ${world.log.join(' → ')}`);
		assert.equal(readFileSync(join(world.root, FIRST_ADMIN_FILE), 'utf8'), 'old password file\n');
	}
});

test('no command setup prints for the first-admin account case contains --force; they all use --reset-first-admin', async () => {
	const printed: string[] = [];
	const scenarios: [HostState, WorldOptions, Partial<Options>][] = [
		[{ host: { is_admin: false }, account: true }, {}, {}], // existing non-admin host
		[{ account: true }, {}, {}], // existing account, not a host
		[{}, { failPromote: true }, {}], // account made, host step failed
		[{}, { failCreate: true }, {}], // nothing made
		[{ account: true }, { files: { [FIRST_ADMIN_FILE]: 'old\n' } }, {}], // a password file is in the way
		[{}, { hostsTableMissing: true }, {}],
	];
	for (const [state, over, opts] of scenarios) {
		const result = await runSetup({ ...ADMIN_OPTIONS, ...opts }, fakeAdminWorld(state, over).deps);
		const step = result.steps.find((s) => s.id === 'hosts.first_admin');
		for (const next of step?.next ?? []) {
			printed.push(`${next.command ?? ''} ${next.text}`);
			assert.ok(!(next.command ?? '').includes('--force'), `${JSON.stringify(state)}: ${next.command}`);
			assert.ok(!/run[: ]+npm run setup[^\n]*--force/.test(next.text), `${JSON.stringify(state)}: ${next.text}`);
		}
	}
	assert.ok(printed.filter((line) => line.includes('--reset-first-admin')).length >= 3, `advice was: ${printed.join(' | ')}`);
});

test('a password file already in the way is only replaced with --reset-first-admin, never with --force', async () => {
	const withForce = fakeAdminWorld({}, { files: { [FIRST_ADMIN_FILE]: 'old\n' } });
	const refused = await runSetup({ ...ADMIN_OPTIONS, force: true }, withForce.deps);
	assert.equal(refused.steps.find((s) => s.id === 'hosts.first_admin')?.status, 'failed');
	assert.equal(readFileSync(join(withForce.root, FIRST_ADMIN_FILE), 'utf8'), 'old\n');
	const withReset = fakeAdminWorld({}, { files: { [FIRST_ADMIN_FILE]: passwordFileFor('new.person@example.com') } });
	const done = await runSetup({ ...ADMIN_OPTIONS, resetFirstAdmin: true }, withReset.deps);
	assert.equal(done.steps.find((s) => s.id === 'hosts.first_admin')?.status, 'done');
	assert.match(readFileSync(join(withReset.root, FIRST_ADMIN_FILE), 'utf8'), /password: \S{32}/);
});

test('--reset-first-admin does not regenerate secrets, and --force still does (the original meaning is kept)', async () => {
	const root = folder();
	await runSetup(OPTIONS, depsFor(root, {}));
	const original = parse(readFileSync(join(root, '.env.local'), 'utf8'));
	await runSetup({ ...OPTIONS, resetFirstAdmin: true }, depsFor(root, {}));
	assert.equal(parse(readFileSync(join(root, '.env.local'), 'utf8')).HOST_SESSION_SECRET, original.HOST_SESSION_SECRET);
	await runSetup({ ...OPTIONS, force: true }, depsFor(root, {}));
	assert.notEqual(parse(readFileSync(join(root, '.env.local'), 'utf8')).HOST_SESSION_SECRET, original.HOST_SESSION_SECRET);
});

test('first admin: both refusals (existing non-admin host, existing account) are a person\'s decision and exit 2, with no run command', async () => {
	for (const state of [{ host: { is_admin: false }, account: true }, { account: true }] as HostState[]) {
		const result = await runSetup(ADMIN_OPTIONS, fakeAdminWorld(state).deps);
		const step = result.steps.find((s) => s.id === 'hosts.first_admin');
		assert.equal(step?.status, 'failed');
		assert.ok(step?.next.length && step.next.every((next) => next.kind === 'human' && next.command === undefined), JSON.stringify(step?.next));
		assert.match(step?.next[0].text ?? '', /^HUMAN: Confirm new\.person@example\.com is the right person, then run: npm run setup -- --first-admin-email new\.person@example\.com --reset-first-admin$/);
		assert.equal(result.exitCode, 2, JSON.stringify(state));
	}
});

test('first admin: a dry run with --reset-first-admin says what would really happen to an existing account', async () => {
	const plain = await runSetup({ ...ADMIN_OPTIONS, resetFirstAdmin: true, dryRun: true }, fakeAdminWorld({ account: true }).deps);
	const detail = plain.steps.find((s) => s.id === 'hosts.first_admin')?.detail ?? '';
	assert.match(detail, /Would reset the password of the existing account new\.person@example\.com, make it an admin host/);
	assert.doesNotMatch(detail, /Would create/);
	assert.doesNotMatch(detail, /replace/);
	const withFile = await runSetup({ ...ADMIN_OPTIONS, resetFirstAdmin: true, dryRun: true }, fakeAdminWorld({ account: true }, { files: { [FIRST_ADMIN_FILE]: passwordFileFor('new.person@example.com') } }).deps);
	assert.match(withFile.steps.find((s) => s.id === 'hosts.first_admin')?.detail ?? '', /Would reset the password of the existing account .*and replace the existing \.volley-first-admin\.txt/);
	const fresh = await runSetup({ ...ADMIN_OPTIONS, dryRun: true }, fakeAdminWorld({}).deps);
	assert.match(fresh.steps.find((s) => s.id === 'hosts.first_admin')?.detail ?? '', /Would create new\.person@example\.com as an admin host/);
});

test('first admin: --reset-first-admin only replaces a password file that is for the same email', async () => {
	for (const [label, content, expected] of [
		['another person', passwordFileFor('someone.else@example.com'), 'someone.else@example.com'],
		['nobody readable', 'just some notes\n', 'unreadable'],
	] as const) {
		for (const dryRun of [false, true]) {
			const world = fakeAdminWorld({ account: true }, { files: { [FIRST_ADMIN_FILE]: content } });
			const result = await runSetup({ ...ADMIN_OPTIONS, resetFirstAdmin: true, dryRun }, world.deps);
			const step = result.steps.find((s) => s.id === 'hosts.first_admin');
			assert.equal(step?.status, 'failed', `${label} (dry run ${dryRun})`);
			if (expected !== 'unreadable') assert.match(step?.detail ?? '', new RegExp(expected.replace('.', '\\.')), 'names the other email');
			assert.ok(step?.next.every((next) => next.kind === 'human'), 'a human decides whose password file this is');
			assert.equal(readFileSync(join(world.root, FIRST_ADMIN_FILE), 'utf8'), content, 'the file was left alone');
			assert.ok(!world.log.some((entry) => /^auth:|^db:(insert|update|begin)/.test(entry)), 'no account was touched');
			assert.equal(result.exitCode, 2);
		}
	}
	const same = fakeAdminWorld({ account: true }, { files: { [FIRST_ADMIN_FILE]: passwordFileFor('new.person@example.com') } });
	const done = await runSetup({ ...ADMIN_OPTIONS, resetFirstAdmin: true }, same.deps);
	assert.equal(done.steps.find((s) => s.id === 'hosts.first_admin')?.status, 'done');
	assert.notEqual(readFileSync(join(same.root, FIRST_ADMIN_FILE), 'utf8'), passwordFileFor('new.person@example.com'));
});

test('first admin: the password-file-in-the-way message names both ways out', async () => {
	const world = fakeAdminWorld({}, { files: { [FIRST_ADMIN_FILE]: passwordFileFor('new.person@example.com') } });
	const result = await runSetup(ADMIN_OPTIONS, world.deps);
	const detail = result.steps.find((s) => s.id === 'hosts.first_admin')?.detail ?? '';
	assert.match(detail, /--reset-first-admin to replace it \(only when it's for the same email\)/);
});

test('first admin: deleting a password file that may hold an unread password is a person\'s step, not a command the agent runs', async () => {
	const world = fakeAdminWorld({}, { files: { [FIRST_ADMIN_FILE]: passwordFileFor('new.person@example.com') } });
	const result = await runSetup(ADMIN_OPTIONS, world.deps);
	const step = result.steps.find((s) => s.id === 'hosts.first_admin');
	assert.equal(step?.status, 'failed');
	assert.ok(step?.next.length && step.next.every((next) => next.kind === 'human' && next.command === undefined), JSON.stringify(step?.next));
	assert.match(step?.next[0].text ?? '', /may hold a password nobody has read/);
	assert.match(step?.next[0].text ?? '', /rm \.volley-first-admin\.txt/);
	assert.equal(result.exitCode, 2);
	assert.equal(readFileSync(join(world.root, FIRST_ADMIN_FILE), 'utf8'), passwordFileFor('new.person@example.com'));
});

test('first admin: if the account appeared after setup looked, its password is NOT reset without the flag', async () => {
	const world = fakeAdminWorld({}, { accountAppearsLate: true });
	const result = await runSetup(ADMIN_OPTIONS, world.deps);
	const step = result.steps.find((s) => s.id === 'hosts.first_admin');
	assert.equal(step?.status, 'failed');
	assert.ok(!world.log.includes('auth:setPassword') && !world.log.includes('auth:createUser'), `auth was called: ${world.log.join(' → ')}`);
	assert.equal(existsSync(join(world.root, FIRST_ADMIN_FILE)), false, 'the password file was removed');
	assert.match(step?.detail ?? '', /appeared|already exists/);
});

test('makeHost: refuses when the account is not in the state the caller expected', async () => {
	const queries: string[] = [];
	const db = (found: boolean) => ({ query: async (sql: string) => (queries.push(sql), { rows: /select id from auth\.users/.test(sql) && found ? [{ id: 'u1' }] : [], rowCount: 1 }) }) as unknown as pg.Client;
	let touched = 0;
	const authAdmin = { createUser: async () => (touched++, { data: { user: { id: 'u2' } }, error: null }), updateUserById: async () => (touched++, { error: null }) };
	await assert.rejects(makeHost(db(true), authAdmin, 'a@example.com', 'pw', { expectExisting: false }), /already exists/);
	await assert.rejects(makeHost(db(false), authAdmin, 'a@example.com', 'pw', { expectExisting: true }), /no longer exists|isn't there/);
	assert.equal(touched, 0);
	await makeHost(db(true), authAdmin, 'a@example.com', 'pw', { expectExisting: true });
	await makeHost(db(false), authAdmin, 'a@example.com', 'pw');
	assert.equal(touched, 2);
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

test('an existing account that is not a host is not touched without --reset-first-admin', { skip }, async () => {
	const email = `volley-setup-${randomUUID()}@example.com`;
	const root = folder();
	const created = await admin().createUser({ email, password: `Pw-${randomUUID()}`, email_confirm: true });
	try {
		const deps = depsFor(root, { ...process.env }, { connectOwner: connectOwnerWith, authAdmin: () => admin() });
		const result = await runSetup({ ...OPTIONS, firstAdminEmail: email }, deps);
		const step = result.steps.find((s) => s.id === 'hosts.first_admin');
		assert.equal(step?.status, 'failed');
		assert.match(step?.detail ?? '', /--reset-first-admin/);
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

test('the command line wires --reset-first-admin and --force to different things (dry run against the test DB, a scratch account)', { skip }, async () => {
	const email = `volley-setup-${randomUUID()}@example.com`;
	const created = await admin().createUser({ email, password: `Pw-${randomUUID()}`, email_confirm: true });
	const dryRun = (...flags: string[]) => {
		const secrets = { HOST_SESSION_SECRET: 'h'.repeat(64), PARTICIPANT_SECRET: 'p'.repeat(64), CRON_SECRET: 'c'.repeat(64) };
		const run = spawnSync(process.execPath, ['--env-file=.env.local', 'scripts/setup.ts', '--dry-run', '--skip-migrate', '--json', '--env-out', '.env.nothing', '--first-admin-email', email, ...flags], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...secrets } });
		assert.ok(!/Unknown option/.test(run.stderr), run.stderr);
		const steps = JSON.parse(run.stdout).steps as { id: string; status: string }[];
		return { admin: steps.find((entry) => entry.id === 'hosts.first_admin')?.status, secrets: steps.find((entry) => entry.id === 'env.secrets')?.status };
	};
	try {
		assert.deepEqual(dryRun(), { admin: 'failed', secrets: 'unchanged' });
		assert.deepEqual(dryRun('--force'), { admin: 'failed', secrets: 'would' }, '--force replaces secrets but does not reset an account');
		assert.deepEqual(dryRun('--reset-first-admin'), { admin: 'would', secrets: 'unchanged' }, '--reset-first-admin resets the account but keeps the secrets');
		assert.equal(existsSync('.env.nothing'), false);
	} finally {
		if (created.data.user) await admin().deleteUser(created.data.user.id);
		rmSync('.env.nothing', { force: true });
	}
});

// ---- fixes from the A15 trial (docs/trial-A15-record.md) ----

const LINK = () => ({ projectId: 'prj_1', orgId: 'team_1' });
const PUSH_ENV = { ...STORE_ENV, HOST_SESSION_SECRET: `host-${'a'.repeat(60)}`, PARTICIPANT_SECRET: `part-${'b'.repeat(60)}`, CRON_SECRET: `cron-${'c'.repeat(60)}`, SUPABASE_SECRET_KEY: 'sb_secret_THE_SERVER_KEY_VALUE', POSTGRES_URL: 'postgres://u:pw@aws-0-eu-west-2.pooler.supabase.com:6543/postgres', POSTGRES_URL_NON_POOLING: 'postgres://u:pw@h:5432/postgres', PUBLIC_SUPABASE_PUBLISHABLE_KEY: STORE_KEY };

test('row 9: a push where Production works and Preview is refused says exactly that, with the CLI\'s real reason', async () => {
	const added: string[] = [];
	const exec: Deps['exec'] = (args, input) => {
		if (args[1] === 'ls') return { status: 0, stdout: '[]', stderr: '' };
		if (args[3] === 'preview') return { status: 1, stdout: '', stderr: `<claude-code-hint v="1" type="plugin" />\nRetrieving project…\nError: Preview needs a Git connection (REASON_FROM_CLI) for ${input}\n` };
		added.push(`${args[2]} ${args[3]}`);
		return { status: 0, stdout: '', stderr: '' };
	};
	const result = await runSetup({ ...OPTIONS, pushVercelEnv: true }, depsFor(folder(), PUSH_ENV, { exec, vercelLink: LINK }));
	const step = result.steps.find((s) => s.id === 'vercel.env');
	assert.equal(step?.status, 'failed');
	// Production gets all 8 settings of PUSH_ENV (7 required everywhere + the cron secret); the count is pinned, not matched.
	assert.equal(added.length, 8);
	assert.match(step?.detail ?? '', /^Production done \(8 added\), Preview failed: .*REASON_FROM_CLI/);
	for (const name of ['HOST_SESSION_SECRET', 'PARTICIPANT_SECRET', 'CRON_SECRET', 'SUPABASE_SECRET_KEY', 'POSTGRES_URL']) assert.ok(!everything(result, OPTIONS).includes(PUSH_ENV[name as keyof typeof PUSH_ENV]), `${name} was echoed into the report`);
	assert.doesNotMatch(step?.detail ?? '', /claude-code-hint|Retrieving project/);
	assert.ok(added.length > 0 && added.every((one) => one.endsWith(' production')), 'Production went up before Preview was tried');
	assert.match(step?.detail ?? '', /not added: .*HOST_SESSION_SECRET/, 'the settings still missing are named');
	assert.ok(step?.next.every((next) => next.kind === 'human'), 'a person fixes this');
	assert.match(step?.next[0].text ?? '', /run `npm run setup -- --push-vercel-env` again/);
	assert.ok(!everything(result, OPTIONS).includes('sb_secret_THE_SERVER_KEY_VALUE'));
});

test('row 9: when the very first target fails nothing is claimed done', async () => {
	const exec: Deps['exec'] = (args) => (args[1] === 'ls' ? { status: 0, stdout: '[]', stderr: '' } : { status: 1, stdout: '', stderr: 'Error: not logged in\n' });
	const result = await runSetup({ ...OPTIONS, pushVercelEnv: true }, depsFor(folder(), PUSH_ENV, { exec, vercelLink: LINK }));
	const step = result.steps.find((s) => s.id === 'vercel.env');
	assert.equal(step?.status, 'failed');
	assert.match(step?.detail ?? '', /Production failed: .*not logged in/);
	assert.doesNotMatch(step?.detail ?? '', /Production done/);
});

test('row 3: SUPABASE_URL is filled from the store\'s NEXT_PUBLIC_ or the PUBLIC_ URL, and never over a value that is set', async () => {
	for (const name of ['NEXT_PUBLIC_SUPABASE_URL', 'PUBLIC_SUPABASE_URL']) {
		const root = folder();
		const result = await runSetup(OPTIONS, depsFor(root, { [name]: `https://${REF}.supabase.co`, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: STORE_KEY }));
		const written = parse(readFileSync(join(root, '.env.local'), 'utf8'));
		assert.equal(written.SUPABASE_URL, `https://${REF}.supabase.co`, name);
		if (name.startsWith('NEXT_')) assert.equal(written.PUBLIC_SUPABASE_URL, `https://${REF}.supabase.co`, 'and the PUBLIC_ copy is there for SvelteKit');
		assert.doesNotMatch(result.checks.find((c) => c.id === 'env.required')?.summary ?? '', /SUPABASE_URL/, 'doctor no longer lists it as missing');
	}
	const root = folder();
	await runSetup(OPTIONS, depsFor(root, { SUPABASE_URL: `https://${REF}.supabase.co/`, NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co` }));
	assert.ok(!/^SUPABASE_URL=/m.test(readFileSync(join(root, '.env.local'), 'utf8')), 'a SUPABASE_URL that is already set is left alone');
});

test('row 5: the env.file step tells the person to close any editor on the file and not to save an old window', async () => {
	const result = await runSetup(OPTIONS, depsFor(folder(), {}));
	const detail = result.steps.find((s) => s.id === 'env.file')?.detail ?? '';
	assert.match(detail, /close any editor/i);
	assert.match(detail, /old window|stale/i);
});

test('row 6: the first-admin hand-off is addressed to the person, who opens the file; an agent never reads it', async () => {
	const world = fakeAdminWorld({});
	const result = await runSetup(ADMIN_OPTIONS, world.deps);
	const step = result.steps.find((s) => s.id === 'hosts.first_admin');
	assert.equal(step?.status, 'done');
	const text = step?.next.map((next) => next.text).join(' ') ?? '';
	assert.match(text, /the person (opens|reads) the file/i);
	assert.match(text, /The agent must not open it/i);
	assert.doesNotMatch(text, /\(read the file/);
});

test('row 4: a purge job that migration 0008 scheduled in this very run is reported as done, not unchanged', async () => {
	const without0008 = MIGRATION_FILES.filter((name) => !name.startsWith('0008'));
	const db = scriptedDb([
		bookkeeping,
		[/^select filename from public\.schema_migrations/, () => ({ rows: without0008.map((filename) => ({ filename })) })],
		[/^begin$/, () => ({ rows: [] })],
		[/^commit$/, () => ({ rows: [] })],
		[/^insert into public\.schema_migrations/, () => ({ rows: [] })],
		[/^select jobid, active from cron\.job/, () => ({ rows: [{ jobid: 7, active: true }] })],
		[/./, () => ({ rows: [] })],
	]);
	const result = await runSetup({ ...OPTIONS, skipMigrate: false }, depsFor(folder(), DB_ENV, { connectOwner: async () => db.client }));
	const cron = result.steps.find((s) => s.id === 'db.pg_cron');
	assert.equal(cron?.status, 'done');
	assert.match(cron?.detail ?? '', /migration 0008 .* this run/);
	assert.ok(result.steps.find((s) => s.id === 'db.migrate')?.detail.includes('0008'));
});

test('row 10: Standard Protection (all_except_custom_domains) is left alone by --vercel-protection and not a warning', async () => {
	const calls: Calls = { exec: [], fetches: [] };
	const exec: Deps['exec'] = (args, input) => {
		calls.exec.push({ args, input });
		return { status: 0, stdout: JSON.stringify({ ssoProtection: { deploymentType: 'all_except_custom_domains' } }), stderr: '' };
	};
	const result = await runSetup({ ...OPTIONS, vercelProtection: true }, depsFor(folder(), {}, { exec, vercelLink: LINK }, calls));
	const step = result.steps.find((s) => s.id === 'vercel.protection');
	assert.equal(step?.status, 'unchanged');
	assert.match(step?.detail ?? '', /Standard Protection/);
	assert.ok(!calls.exec.some((call) => call.args.includes('PATCH')));
});

test('row 9: the partial-push report survives the CLI disappearing part-way', async () => {
	let production = 0;
	const exec: Deps['exec'] = (args) => {
		if (args[1] === 'ls') return { status: 0, stdout: '[]', stderr: '' };
		if (args[3] === 'preview') throw new Error("the Vercel CLI isn't installed (install it with: npm i -g vercel)");
		production++;
		return { status: 0, stdout: '', stderr: '' };
	};
	const result = await runSetup({ ...OPTIONS, pushVercelEnv: true }, depsFor(folder(), PUSH_ENV, { exec, vercelLink: LINK }));
	const step = result.steps.find((s) => s.id === 'vercel.env');
	assert.equal(step?.status, 'failed');
	assert.equal(production, 8);
	assert.match(step?.detail ?? '', /^Production done \(8 added\), Preview failed: .*isn't installed.*not added: .*\(preview\)/);
	assert.match(step?.next[0].text ?? '', /Install the Vercel CLI/, 'the install hint is kept');
});

// ---- setup stops when the settings are from different Supabase projects ----

const OTHER = 'zyxwvutsrqponmlkjihg';
const mixedFolderRun = async (env: Record<string, string>, over: Partial<Options> = {}) => {
	const root = folder();
	const calls: Calls = { exec: [], fetches: [] };
	let connects = 0;
	const deps = depsFor(root, env, { connectOwner: async () => (connects++, scriptedDb([]).client), vercelLink: LINK }, calls);
	const result = await runSetup({ ...OPTIONS, skipMigrate: false, pushVercelEnv: true, disableSignup: true, ...over }, deps);
	return { root, calls, connects, result };
};

test('mixed projects: a stale PUBLIC_/NEXT_PUBLIC_ address stops setup before anything is written, connected to, pushed or sent', async () => {
	const pooler = `postgres://postgres.${REF}:pw@aws-0-eu-west-2.pooler.supabase.com:5432/postgres`;
	const cases: Record<string, Record<string, string>> = {
		'SUPABASE_URL is filled from a NEXT_PUBLIC_ address of another project': { NEXT_PUBLIC_SUPABASE_URL: `https://${OTHER}.supabase.co`, POSTGRES_URL_NON_POOLING: pooler },
		'PUBLIC_ and NEXT_PUBLIC_ addresses point at different projects': { PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co`, NEXT_PUBLIC_SUPABASE_URL: `https://${OTHER}.supabase.co`, POSTGRES_URL_NON_POOLING: pooler },
		'a set SUPABASE_URL against another project\'s database': { SUPABASE_URL: `https://${OTHER}.supabase.co`, POSTGRES_URL_NON_POOLING: pooler },
	};
	for (const [label, env] of Object.entries(cases)) {
		const { root, calls, connects, result } = await mixedFolderRun({ ...env, SUPABASE_ACCESS_TOKEN: 'sbp_TOKEN_VALUE_XYZ' });
		const step = result.steps.find((s) => s.id === 'env.same_project');
		assert.equal(step?.status, 'failed', label);
		assert.ok(step?.next.every((next) => next.kind === 'human'), label);
		assert.equal(result.exitCode, 2, label);
		assert.equal(existsSync(join(root, '.env.local')), false, `${label}: nothing written`);
		assert.equal(connects, 0, `${label}: no database connection`);
		assert.equal(calls.exec.length, 0, `${label}: nothing sent to Vercel`);
		assert.equal(calls.fetches.length, 0, `${label}: nothing sent to Supabase`);
		assert.ok(!everything(result, OPTIONS).includes('sbp_TOKEN_VALUE_XYZ'));
	}
});

test('one project, written two ways, is not "mixed": setup carries on', async () => {
	const { root, result } = await mixedFolderRun({ NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co`, PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co`, POSTGRES_URL_NON_POOLING: `postgres://postgres.${REF}:pw@aws-0-eu-west-2.pooler.supabase.com:5432/postgres` }, { pushVercelEnv: false, disableSignup: false, skipMigrate: true });
	assert.equal(result.steps.find((s) => s.id === 'env.same_project'), undefined);
	assert.equal(existsSync(join(root, '.env.local')), true);
});

test('row 9: the CLI\'s JSON answer is the reason when it gives one, and a value it echoes is blanked', async () => {
	const exec: Deps['exec'] = (args, input) => {
		if (args[1] === 'ls') return { status: 0, stdout: '[]', stderr: '' };
		if (args[3] === 'preview') return { status: 1, stdout: JSON.stringify({ status: 'action_required', reason: 'git_branch_required', message: `Which branch for ${input}?` }), stderr: 'Retrieving project…\n' };
		return { status: 0, stdout: '', stderr: '' };
	};
	const result = await runSetup({ ...OPTIONS, pushVercelEnv: true }, depsFor(folder(), PUSH_ENV, { exec, vercelLink: LINK }));
	const step = result.steps.find((s) => s.id === 'vercel.env');
	assert.match(step?.detail ?? '', /Preview failed: .*git_branch_required: Which branch for \[hidden\]/);
	for (const name of ['HOST_SESSION_SECRET', 'PARTICIPANT_SECRET', 'CRON_SECRET', 'SUPABASE_SECRET_KEY', 'POSTGRES_URL']) assert.ok(!everything(result, OPTIONS).includes(PUSH_ENV[name as keyof typeof PUSH_ENV]), `${name} was echoed`);
});

// npm run doctor: each check's ok and fail paths, the JSON shape and the exit codes, against
// fixtures and fakes (no network, no database). Written so a check that stops checking turns a test red.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exitCode, runChecks, type Check, type Ctx } from '../scripts/lib/checks.ts';
import { VARS } from '../scripts/lib/env.ts';
import { toJson, toText } from '../scripts/lib/report.ts';

const REF = 'abcdefghijklmnopqrst';
const SECRET = 'S3CR3T-VALUE-THAT-MUST-NEVER-BE-PRINTED-0123456789';
const GOOD_ENV: Record<string, string> = {
	HOST_SESSION_SECRET: `host-${SECRET}`,
	PARTICIPANT_SECRET: `part-${SECRET}`,
	CRON_SECRET: `cron-${SECRET}`,
	SUPABASE_URL: `https://${REF}.supabase.co`,
	SUPABASE_SECRET_KEY: `sb_secret_${SECRET}`,
	POSTGRES_URL: `postgres://postgres.${REF}:pw-${SECRET}@aws-0-eu-west-2.pooler.supabase.com:6543/postgres?sslmode=require`,
	POSTGRES_URL_NON_POOLING: `postgres://postgres.${REF}:pw-${SECRET}@aws-0-eu-west-2.pooler.supabase.com:5432/postgres`,
	PUBLIC_SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${SECRET}`,
};

type Over = Partial<{
	env: Record<string, string | undefined>;
	files: Record<string, string | null>;
	migrations: string[];
	applied: string[] | 'no-table';
	cron: 'ok' | 'off' | 'missing-job' | 'no-extension' | 'inactive';
	hosts: { total: number; admins: number } | 'no-table';
	settings: { status: number; body: unknown } | Error;
	owner: { ok: false; reason: string };
	pooler: { ok: false; reason: string };
	vercel: Ctx['vercel'];
	throwOnQuery: Error;
}>;

function ctxWith(over: Over = {}): Ctx {
	const migrations = over.migrations ?? ['0001_a.sql', '0002_b.sql'];
	const files: Record<string, string | null> = {
		'svelte.config.js': "adapter({ regions: ['lhr1'], runtime: 'nodejs24.x' })",
		'vercel.json': JSON.stringify({ crons: [{ path: '/api/cron/keep-alive', schedule: '0 9 * * *' }] }),
		...over.files,
	};
	return {
		env: over.env ?? { ...GOOD_ENV },
		readFile: (path) => files[path] ?? null,
		migrationsOnDisk: () => migrations,
		fetchJson: async () => {
			if (over.settings instanceof Error) throw over.settings;
			return over.settings ?? { status: 200, body: { disable_signup: true } };
		},
		async query(sql) {
			if (over.throwOnQuery) throw over.throwOnQuery;
			if (sql.includes('schema_migrations')) {
				if (over.applied === 'no-table') throw Object.assign(new Error('relation "public.schema_migrations" does not exist'), { code: '42P01' });
				return (over.applied ?? migrations).map((filename) => ({ filename }));
			}
			if (sql.includes('cron.job')) {
				const mode = over.cron ?? 'ok';
				if (mode === 'no-extension') throw Object.assign(new Error('schema "cron" does not exist'), { code: '3F000' });
				if (mode === 'missing-job') return [];
				return [{ active: mode !== 'inactive', schedule: '0 * * * *' }];
			}
			if (sql.includes('public.hosts')) {
				if (over.hosts === 'no-table') throw Object.assign(new Error('relation "public.hosts" does not exist'), { code: '42P01' });
				return [over.hosts ?? { total: 2, admins: 1 }];
			}
			throw new Error(`unexpected query: ${sql}`);
		},
		connectOwner: async () => over.owner ?? { ok: true },
		connectPooler: async () => over.pooler ?? { ok: true },
		vercel: over.vercel,
	};
}

const byId = (checks: Check[], id: string): Check => {
	const found = checks.find((check) => check.id === id);
	assert.ok(found, `no check ${id}`);
	return found;
};
const nextText = (check: Check) => check.next.map((next) => next.text).join(' | ');

test('a healthy copy: every check is ok, the Vercel ones are skipped, and the exit code is 0', async () => {
	const checks = await runChecks(ctxWith());
	assert.deepEqual(checks.filter((check) => check.status === 'fail' || check.status === 'warn'), []);
	for (const id of ['vercel.linked', 'vercel.env', 'vercel.protection']) assert.equal(byId(checks, id).status, 'skipped');
	assert.equal(exitCode(checks), 0);
});

test('env.public_names: the store\'s NEXT_PUBLIC_ names fail with the exact rename, and a command the agent can run', async () => {
	const { PUBLIC_SUPABASE_PUBLISHABLE_KEY: _, ...rest } = GOOD_ENV;
	const checks = await runChecks(ctxWith({ env: { ...rest, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x', NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co` } }));
	const check = byId(checks, 'env.public_names');
	assert.equal(check.status, 'fail');
	assert.match(check.summary, /NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY → PUBLIC_SUPABASE_PUBLISHABLE_KEY/);
	assert.match(check.summary, /NEXT_PUBLIC_SUPABASE_URL → PUBLIC_SUPABASE_URL/);
	assert.equal(check.next[0].kind, 'run');
	assert.equal(check.next[0].command, 'npm run setup');
	assert.equal(byId(checks, 'env.required').status, 'ok', 'the missing PUBLIC_ name is reported once, here, not again as "missing"');
	assert.equal(exitCode(checks), 1);
});

test('env.public_names: the older ANON name is accepted for the publishable key', async () => {
	const { PUBLIC_SUPABASE_PUBLISHABLE_KEY: _, ...rest } = GOOD_ENV;
	const check = byId(await runChecks(ctxWith({ env: { ...rest, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'eyJ-anon' } })), 'env.public_names');
	assert.equal(check.status, 'fail');
	assert.match(check.summary, /NEXT_PUBLIC_SUPABASE_ANON_KEY → PUBLIC_SUPABASE_PUBLISHABLE_KEY/);
});

test('env.required: names the missing ones; generated secrets are a command, Supabase values are a HUMAN step with where to get them', async () => {
	const { HOST_SESSION_SECRET: _a, SUPABASE_SECRET_KEY: _b, ...rest } = GOOD_ENV;
	const check = byId(await runChecks(ctxWith({ env: rest })), 'env.required');
	assert.equal(check.status, 'fail');
	assert.match(check.summary, /HOST_SESSION_SECRET.*SUPABASE_SECRET_KEY|SUPABASE_SECRET_KEY.*HOST_SESSION_SECRET/);
	assert.ok(check.next.some((next) => next.kind === 'run' && next.command === 'npm run setup'));
	const human = check.next.find((next) => next.kind === 'human');
	assert.ok(human && human.text.startsWith('HUMAN: Add SUPABASE_SECRET_KEY') && /Supabase dashboard/.test(human.text));
});

test('env.secrets: a short secret fails; no CRON_SECRET is only a warning', async () => {
	const short = byId(await runChecks(ctxWith({ env: { ...GOOD_ENV, HOST_SESSION_SECRET: 'tooshort' } })), 'env.secrets');
	assert.equal(short.status, 'fail');
	assert.match(short.summary, /HOST_SESSION_SECRET/);
	const { CRON_SECRET: _, ...noCron } = GOOD_ENV;
	const warn = byId(await runChecks(ctxWith({ env: noCron })), 'env.secrets');
	assert.equal(warn.status, 'warn');
	assert.equal(exitCode(await runChecks(ctxWith({ env: noCron }))), 0, 'a warning never fails a run');
});

test('env.same_project: values from two different Supabase projects fail', async () => {
	const check = byId(await runChecks(ctxWith({ env: { ...GOOD_ENV, SUPABASE_URL: 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co' } })), 'env.same_project');
	assert.equal(check.status, 'fail');
	assert.match(check.summary, /SUPABASE_URL → zzzzzzzzzzzzzzzzzzzz/);
	assert.equal(check.next[0].kind, 'human');
});

test('db.pooler: the direct address and the session-mode port both fail, with different fixes', async () => {
	const direct = byId(await runChecks(ctxWith({ env: { ...GOOD_ENV, POSTGRES_URL: `postgres://postgres:pw@db.${REF}.supabase.co:5432/postgres` } })), 'db.pooler');
	assert.equal(direct.status, 'fail');
	assert.equal(direct.next[0].kind, 'human');
	assert.match(nextText(direct), /Transaction pooler/);
	const session = byId(await runChecks(ctxWith({ env: { ...GOOD_ENV, POSTGRES_URL: GOOD_ENV.POSTGRES_URL.replace(':6543', ':5432') } })), 'db.pooler');
	assert.equal(session.status, 'fail');
	assert.equal(session.next[0].kind, 'edit');
	assert.match(session.next[0].text, /6543/);
});

test('db.region: a database in another region than the functions is named in plain English, with both ways out', async () => {
	const env = { ...GOOD_ENV, POSTGRES_URL: GOOD_ENV.POSTGRES_URL.replace('eu-west-2', 'us-east-1') };
	const checks = await runChecks(ctxWith({ env }));
	const check = byId(checks, 'db.region');
	assert.equal(check.status, 'fail');
	assert.match(check.summary, /database is in us-east-1 but the functions run in lhr1/);
	assert.ok(check.next.some((next) => next.kind === 'edit' && /regions: \['iad1'\]/.test(next.text)), 'the agent can move the functions');
	assert.ok(check.next.some((next) => next.kind === 'human' && /eu-west-2/.test(next.text)), 'or a person can recreate the project');
	assert.equal(exitCode(checks), 1);
	assert.equal(byId(await runChecks(ctxWith()), 'db.region').status, 'ok');
});

test('db.region: no pinned region is a warning; an unknown region is a warning, not a guess', async () => {
	assert.equal(byId(await runChecks(ctxWith({ files: { 'svelte.config.js': 'adapter({})' } })), 'db.region').status, 'warn');
	assert.equal(byId(await runChecks(ctxWith({ files: { 'svelte.config.js': "adapter({ regions: ['zzz1'] })" } })), 'db.region').status, 'warn');
});

test('db.connect and db.pooler_tls: failures carry the reason, and a certificate failure points at the pinned CA file', async () => {
	const owner = byId(await runChecks(ctxWith({ owner: { ok: false, reason: 'password authentication failed (28P01)' } })), 'db.connect');
	assert.equal(owner.status, 'fail');
	assert.match(owner.summary, /password authentication failed/);
	assert.equal(owner.next[0].kind, 'human');
	const tls = byId(await runChecks(ctxWith({ pooler: { ok: false, reason: 'unable to verify the first certificate' } })), 'db.pooler_tls');
	assert.equal(tls.status, 'fail');
	assert.equal(tls.next[0].kind, 'edit');
	assert.match(tls.next[0].text, /supabase-ca\.ts/);
	const auth = byId(await runChecks(ctxWith({ pooler: { ok: false, reason: 'password authentication failed' } })), 'db.pooler_tls');
	assert.equal(auth.next[0].kind, 'human');
});

test('db.migrations: pending ones are counted and named, a missing bookkeeping table means all of them, and setup is the fix', async () => {
	const some = byId(await runChecks(ctxWith({ migrations: ['0001_a.sql', '0002_b.sql', '0003_c.sql'], applied: ['0001_a.sql'] })), 'db.migrations');
	assert.equal(some.status, 'fail');
	assert.match(some.summary, /2 of 3 migrations are not applied yet \(0002_b\.sql … 0003_c\.sql\)/);
	assert.equal(some.next[0].command, 'npm run setup');
	const none = byId(await runChecks(ctxWith({ applied: 'no-table' })), 'db.migrations');
	assert.match(none.summary, /2 of 2/);
	assert.equal(byId(await runChecks(ctxWith()), 'db.migrations').status, 'ok');
});

test('db.pg_cron: the extension off, the job missing and the job switched off each fail, and the agent gets setup (plus the dashboard path when the extension is the problem)', async () => {
	const off = byId(await runChecks(ctxWith({ cron: 'no-extension' })), 'db.pg_cron');
	assert.equal(off.status, 'fail');
	assert.match(off.summary, /pg_cron isn't switched on/);
	assert.ok(off.next.some((next) => next.kind === 'run') && off.next.some((next) => next.kind === 'human' && /Extensions/.test(next.text)));
	const missing = byId(await runChecks(ctxWith({ cron: 'missing-job' })), 'db.pg_cron');
	assert.match(missing.summary, /not scheduled/);
	const inactive = byId(await runChecks(ctxWith({ cron: 'inactive' })), 'db.pg_cron');
	assert.match(inactive.summary, /switched off/);
	assert.equal(byId(await runChecks(ctxWith()), 'db.pg_cron').status, 'ok');
});

test('auth.signup_disabled: sign-up on fails as a HUMAN step with the place to click; off passes; a wrong key or unreachable Supabase says so', async () => {
	const on = await runChecks(ctxWith({ settings: { status: 200, body: { disable_signup: false } } }));
	const check = byId(on, 'auth.signup_disabled');
	assert.equal(check.status, 'fail');
	assert.equal(check.next.length, 1);
	assert.ok(check.next[0].text.startsWith('HUMAN:') && /Authentication → Sign In \/ Providers/.test(check.next[0].text));
	assert.equal(exitCode(on), 2, 'only a person can fix it');
	assert.equal(byId(await runChecks(ctxWith()), 'auth.signup_disabled').status, 'ok');
	assert.match(byId(await runChecks(ctxWith({ settings: { status: 401, body: null } })), 'auth.signup_disabled').summary, /HTTP 401/);
	assert.match(byId(await runChecks(ctxWith({ settings: new Error('fetch failed') })), 'auth.signup_disabled').summary, /Could not reach Supabase Auth: fetch failed/);
	assert.equal(byId(await runChecks(ctxWith({ settings: { status: 200, body: {} } })), 'auth.signup_disabled').status, 'warn');
});

test('hosts.first_admin: no host, hosts but no admin, and an admin each read right; no table is skipped, not failed', async () => {
	const none = byId(await runChecks(ctxWith({ hosts: { total: 0, admins: 0 } })), 'hosts.first_admin');
	assert.equal(none.status, 'fail');
	assert.match(none.summary, /no host yet/);
	assert.equal(none.next[0].kind, 'run');
	assert.match(none.next[0].command ?? '', /--first-admin-email <EMAIL>/);
	const noAdmin = byId(await runChecks(ctxWith({ hosts: { total: 2, admins: 0 } })), 'hosts.first_admin');
	assert.match(noAdmin.summary, /none is an admin/);
	assert.match(noAdmin.next[0].command ?? '', /set-host/);
	assert.equal(byId(await runChecks(ctxWith({ hosts: { total: 3, admins: 1 } })), 'hosts.first_admin').status, 'ok');
	assert.equal(byId(await runChecks(ctxWith({ hosts: 'no-table' })), 'hosts.first_admin').status, 'skipped');
});

test('vercel checks: not linked, missing settings, and protection that covers production each fail with the right kind of next step', async () => {
	const linked = { projectId: 'prj_1', orgId: 'team_1' };
	const probe = (over: { link?: typeof linked | null; names?: Record<string, string[]>; protection?: string | null }): Ctx['vercel'] => ({
		linked: () => (over.link === undefined ? linked : over.link),
		envNames: async () => over.names ?? {},
		protection: async () => (over.protection === undefined ? null : over.protection),
	});
	const names = (target: string) => VARS.filter((spec) => spec.required === true || (spec.required === 'production' && target === 'production')).map((spec) => spec.name);

	const unlinked = byId(await runChecks(ctxWith({ vercel: probe({ link: null }) })), 'vercel.linked');
	assert.equal(unlinked.status, 'fail');
	assert.equal(unlinked.next[0].command, 'vercel link');

	const full = await runChecks(ctxWith({ vercel: probe({ names: { production: names('production'), preview: names('preview') }, protection: 'preview' }) }));
	for (const id of ['vercel.linked', 'vercel.env', 'vercel.protection']) assert.equal(byId(full, id).status, 'ok', id);

	const missing = byId(await runChecks(ctxWith({ vercel: probe({ names: { production: ['SUPABASE_URL'], preview: [] } }) })), 'vercel.env');
	assert.equal(missing.status, 'fail');
	assert.match(missing.summary, /HOST_SESSION_SECRET \(production\)/);
	assert.ok(missing.next.some((next) => next.kind === 'run' && /--push-vercel-env/.test(next.command ?? '')));
	assert.ok(missing.next.some((next) => next.kind === 'human' && /Storage/.test(next.text)), 'store-supplied values are a person\'s step');

	for (const covered of ['all', 'prod_deployment_urls_and_all_previews']) {
		const protection = byId(await runChecks(ctxWith({ vercel: probe({ protection: covered }) })), 'vercel.protection');
		assert.equal(protection.status, 'fail', covered);
		assert.match(protection.summary, /keep-alive cron/);
		assert.ok(protection.next.some((next) => next.kind === 'run' && next.command === 'npm run setup -- --vercel-protection'));
		assert.ok(protection.next.some((next) => next.kind === 'human' && /Only Preview Deployments/.test(next.text)));
	}
	assert.equal(byId(await runChecks(ctxWith({ vercel: probe({ protection: null }) })), 'vercel.protection').status, 'ok');
});

test('vercel.cron: a missing keep-alive entry is a warning with the edit to make', async () => {
	const check = byId(await runChecks(ctxWith({ files: { 'vercel.json': '{}' } })), 'vercel.cron');
	assert.equal(check.status, 'warn');
	assert.equal(check.next[0].kind, 'edit');
});

test('a check that crashes is reported as a failed check with its message, and the others still run', async () => {
	const checks = await runChecks(ctxWith({ throwOnQuery: new Error('boom') }));
	assert.equal(byId(checks, 'db.migrations').status, 'skipped');
	const ctx = ctxWith();
	ctx.readFile = () => {
		throw new Error('disk exploded');
	};
	const crashed = byId(await runChecks(ctx), 'db.region');
	assert.equal(crashed.status, 'fail');
	assert.match(crashed.summary, /This check crashed: disk exploded/);
	assert.equal(byId(await runChecks(ctx), 'env.required').status, 'ok');
});

test('exit codes: 0 all fine, 1 when the agent can fix something, 2 when only a person can, and 1 if both are present', async () => {
	assert.equal(exitCode(await runChecks(ctxWith())), 0);
	assert.equal(exitCode(await runChecks(ctxWith({ hosts: { total: 0, admins: 0 } }))), 1);
	assert.equal(exitCode(await runChecks(ctxWith({ settings: { status: 200, body: { disable_signup: false } } }))), 2);
	assert.equal(exitCode(await runChecks(ctxWith({ hosts: { total: 0, admins: 0 }, settings: { status: 200, body: { disable_signup: false } } }))), 1);
});

test('the JSON has a stable shape: ids, status, summary, next actions, counts, exit code', async () => {
	const result = toJson(await runChecks(ctxWith({ hosts: { total: 0, admins: 0 } })));
	assert.deepEqual(Object.keys(result).sort(), ['checks', 'counts', 'exitCode', 'ok']);
	assert.equal(result.ok, false);
	assert.equal(result.exitCode, 1);
	assert.deepEqual(Object.keys(result.counts).sort(), ['fail', 'ok', 'skipped', 'warn']);
	assert.deepEqual(result.checks.map((check) => check.id), [
		'env.required', 'env.public_names', 'env.secrets', 'env.same_project', 'db.pooler', 'db.region', 'db.connect', 'db.pooler_tls',
		'db.migrations', 'db.pg_cron', 'auth.signup_disabled', 'hosts.first_admin', 'vercel.linked', 'vercel.env', 'vercel.protection', 'vercel.cron',
	]);
	for (const check of result.checks) {
		assert.deepEqual(Object.keys(check).sort(), ['id', 'next', 'status', 'summary']);
		assert.ok(['ok', 'fail', 'warn', 'skipped'].includes(check.status));
		for (const next of check.next) assert.ok(['run', 'edit', 'human'].includes(next.kind));
	}
	assert.equal(toJson(await runChecks(ctxWith())).exitCode, 0);
	assert.match(toText(await runChecks(ctxWith({ hosts: { total: 0, admins: 0 } }))), /Verdict: not ready\. Exit 1/);
});

test('no result, in text or JSON, ever contains a secret value, however many checks fail', async () => {
	const worst: Over[] = [
		{ env: { ...GOOD_ENV, POSTGRES_URL: `postgres://postgres:pw-${SECRET}@db.${REF}.supabase.co:5432/postgres`, HOST_SESSION_SECRET: `x${SECRET}`.slice(0, 8) } },
		{ env: { ...GOOD_ENV, SUPABASE_URL: `https://zzzzzzzzzzzzzzzzzzzz.supabase.co`, NEXT_PUBLIC_SUPABASE_ANON_KEY: `anon-${SECRET}` }, owner: { ok: false, reason: 'could not connect' }, settings: { status: 200, body: { disable_signup: false } } },
		{ throwOnQuery: new Error('boom'), hosts: 'no-table', cron: 'no-extension', applied: 'no-table' },
	];
	for (const over of worst) {
		const checks = await runChecks(ctxWith(over));
		const text = toText(checks) + JSON.stringify(toJson(checks));
		assert.ok(!text.includes(SECRET), 'a secret value leaked into the report');
		for (const value of Object.values(over.env ?? {})) if (value && value.length > 12) assert.ok(!text.includes(value), 'an environment value leaked into the report');
	}
});

test('npm run doctor --help documents the exit codes and --json; an unknown flag is an error, not a hang', () => {
	const help = spawnSync(process.execPath, ['scripts/doctor.ts', '--help'], { encoding: 'utf8', timeout: 15_000, env: { PATH: process.env.PATH ?? '' } });
	assert.equal(help.status, 0);
	assert.match(help.stdout, /Exit codes:/);
	assert.match(help.stdout, /0 {2}everything is ok/);
	assert.match(help.stdout, /1 {2}something failed that you, the agent, can fix/);
	assert.match(help.stdout, /2 {2}something failed that only a person can do/);
	assert.match(help.stdout, /--json/);
	const bad = spawnSync(process.execPath, ['scripts/doctor.ts', '--nonsense'], { encoding: 'utf8', timeout: 15_000, env: { PATH: process.env.PATH ?? '' } });
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /Unknown option --nonsense/);
});

test('doctor run with an empty environment finishes by itself, says what is missing, and prints valid JSON with --json', () => {
	const run = spawnSync(process.execPath, ['scripts/doctor.ts', '--json'], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' } });
	assert.notEqual(run.status, null, 'it did not hang');
	assert.ok([1, 2].includes(run.status as number));
	const parsed = JSON.parse(run.stdout);
	assert.equal(parsed.exitCode, run.status);
	assert.equal(parsed.checks.find((check: Check) => check.id === 'env.required').status, 'fail');
});

// The list of settings is found by grepping src/, so a new one can't be forgotten.
test('every setting src/ reads is in doctor\'s list, and .env.example documents every one in that list', () => {
	const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]));
	const read = new Set<string>();
	for (const file of walk('src').filter((name) => /\.(ts|svelte)$/.test(name))) {
		const text = readFileSync(file, 'utf8');
		for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\$env\/(?:static|dynamic)\/(?:private|public)'/g)) {
			for (const name of match[1].split(',').map((part) => part.trim().split(/\s+as\s+/)[0]).filter(Boolean)) if (name !== 'env') read.add(name);
		}
		for (const match of text.matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)) read.add(match[1]);
	}
	assert.ok(read.size >= 6, `expected to find the app's settings, found ${[...read]}`);
	const listed = new Set(VARS.map((spec) => spec.name));
	for (const name of read) assert.ok(listed.has(name), `${name} is read by src/ but missing from scripts/lib/env.ts`);
	const example = readFileSync('.env.example', 'utf8');
	for (const name of listed) assert.match(example, new RegExp(`^${name}=`, 'm'), `${name} is missing from .env.example`);
	assert.doesNotMatch(example, /^[A-Z_]+=\S/m, '.env.example must hold no values');
});

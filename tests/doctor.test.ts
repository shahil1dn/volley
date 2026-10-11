// npm run doctor: each check's ok and fail paths, the JSON shape and the exit codes, against
// fixtures and fakes (no network, no database). Written so a check that stops checking turns a test red.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exitCode, projectRefOf, runChecks, type Check, type Ctx } from '../scripts/lib/checks.ts';
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

test('env.same_project: the direct address (user@db.<ref>.supabase.co) is read too, so a mixed project there is caught', async () => {
	const direct = (ref: string) => `postgres://postgres:pw@db.${ref}.supabase.co:5432/postgres`;
	const mixed = byId(await runChecks(ctxWith({ env: { ...GOOD_ENV, POSTGRES_URL_NON_POOLING: direct('zzzzzzzzzzzzzzzzzzzz') } })), 'env.same_project');
	assert.equal(mixed.status, 'fail');
	assert.match(mixed.summary, /POSTGRES_URL_NON_POOLING → zzzzzzzzzzzzzzzzzzzz/);
	assert.equal(byId(await runChecks(ctxWith({ env: { ...GOOD_ENV, POSTGRES_URL_NON_POOLING: direct(REF) } })), 'env.same_project').status, 'ok');
	assert.equal(projectRefOf(direct(REF)), REF);
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
	const withToken = await runChecks(ctxWith({ env: { ...GOOD_ENV, SUPABASE_ACCESS_TOKEN: 'sbp_x', }, settings: { status: 200, body: { disable_signup: false } } }));
	const offered = byId(withToken, 'auth.signup_disabled');
	assert.ok(offered.next.some((next) => next.kind === 'run' && next.command === 'npm run setup -- --disable-signup'), 'with an access token the agent can switch it off');
	assert.ok(offered.next.some((next) => next.kind === 'human'), 'and the by-hand way stays as the fallback');
	assert.equal(exitCode(withToken), 1);
	assert.equal(byId(await runChecks(ctxWith()), 'auth.signup_disabled').status, 'ok');
	assert.match(byId(await runChecks(ctxWith({ settings: { status: 401, body: null } })), 'auth.signup_disabled').summary, /HTTP 401/);
	assert.match(byId(await runChecks(ctxWith({ settings: new Error('fetch failed') })), 'auth.signup_disabled').summary, /Could not reach Supabase Auth: fetch failed/);
	assert.equal(byId(await runChecks(ctxWith({ settings: { status: 200, body: {} } })), 'auth.signup_disabled').status, 'warn');
});

test('hosts.first_admin: no host, hosts but no admin, and an admin each read right; no table is skipped, not failed', async () => {
	const none = byId(await runChecks(ctxWith({ hosts: { total: 0, admins: 0 } })), 'hosts.first_admin');
	assert.equal(none.status, 'fail');
	assert.match(none.summary, /no host yet/);
	assert.equal(none.next[0].kind, 'human', 'asking the person for their email is a person\'s step');
	assert.equal(none.next[0].command, undefined, 'a placeholder is never in a command');
	assert.match(none.next[0].template ?? '', /npm run setup -- --first-admin-email <EMAIL>/);
	assert.match(none.next[0].text, /^HUMAN: /);
	const noAdmin = byId(await runChecks(ctxWith({ hosts: { total: 2, admins: 0 } })), 'hosts.first_admin');
	assert.match(noAdmin.summary, /none is an admin/);
	assert.equal(noAdmin.next[0].kind, 'human');
	assert.match(noAdmin.next[0].template ?? '', /npm run set-host -- <EMAIL> --admin/);
	assert.equal(exitCode([none]), 2, 'with no email known, only a person can go on');
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

	// Vercel documents "All Deployments" as protecting production domains. Standard Protection is
	// documented as leaving them open, so it is a warning for a person, never rewritten.
	const all = byId(await runChecks(ctxWith({ vercel: probe({ protection: 'all' }) })), 'vercel.protection');
	assert.equal(all.status, 'fail');
	assert.match(all.summary, /keep-alive cron/);
	assert.ok(all.next.some((next) => next.kind === 'run' && next.command === 'npm run setup -- --vercel-protection'));
	assert.ok(all.next.some((next) => next.kind === 'human' && /Only Preview Deployments/.test(next.text)));
	for (const other of ['prod_deployment_urls_and_all_previews', 'something_new']) {
		const protection = byId(await runChecks(ctxWith({ vercel: probe({ protection: other }) })), 'vercel.protection');
		assert.equal(protection.status, 'warn', other);
		assert.ok(protection.next.every((next) => next.kind === 'human'), `${other}: nothing the agent should change`);
		assert.equal(exitCode([protection]), 0, 'a warning never fails a run');
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
	assert.equal(exitCode(await runChecks(ctxWith({ applied: [] }))), 1);
	assert.equal(exitCode(await runChecks(ctxWith({ settings: { status: 200, body: { disable_signup: false } } }))), 2);
	assert.equal(exitCode(await runChecks(ctxWith({ hosts: { total: 0, admins: 0 } }))), 2, 'no host yet: only the person knows their email');
	assert.equal(exitCode(await runChecks(ctxWith({ applied: [], settings: { status: 200, body: { disable_signup: false } } }))), 1);
});

test('exitCode can set aside "run npm run setup" suggestions, so a setup that already failed is not sent round in a circle', async () => {
	const loop = await runChecks(ctxWith({ applied: [] }));
	assert.equal(exitCode(loop), 1);
	assert.equal(exitCode(loop, { ignoreSetup: true }), 2, 'nothing else the agent can do');
	const edit = await runChecks(ctxWith({ applied: [], files: { 'svelte.config.js': "adapter({ regions: ['iad1'] })" } }));
	assert.equal(exitCode(edit, { ignoreSetup: true }), 1, 'a file edit is still the agent\'s to make');
});

test('every failure reason is scrubbed of the secrets in the environment, however it got into the text', async () => {
	const leaky: Over = {
		owner: { ok: false, reason: `password authentication failed for ${GOOD_ENV.POSTGRES_URL_NON_POOLING}` },
		pooler: { ok: false, reason: `server said pw-${SECRET} is wrong` },
		settings: new Error(`GET failed with apikey ${GOOD_ENV.PUBLIC_SUPABASE_PUBLISHABLE_KEY}`),
		vercel: {
			linked: () => ({ projectId: 'p', orgId: 't' }),
			envNames: async () => { throw new Error(`cli said ${GOOD_ENV.SUPABASE_SECRET_KEY}`); },
			protection: async () => { throw new Error(`cli said cron-${SECRET}`); },
		},
	};
	const checks = await runChecks(ctxWith(leaky));
	const text = toText(checks) + JSON.stringify(toJson(checks));
	assert.ok(!text.includes(SECRET), 'a secret value leaked into the report');
	assert.match(text, /\[hidden\]/, 'the message survives with the secret blanked');
	assert.match(byId(checks, 'db.connect').summary, /password authentication failed/);
});

test('the JSON has a stable shape: ids, status, summary, next actions, counts, exit code', async () => {
	const result = toJson(await runChecks(ctxWith({ applied: [] })));
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
		for (const next of check.next) {
			assert.ok(['run', 'edit', 'human'].includes(next.kind));
			assert.ok(Object.keys(next).every((key) => ['kind', 'text', 'command', 'template', 'confirm'].includes(key)), `unexpected field in ${JSON.stringify(next)}`);
		}
	}
	assert.equal(toJson(await runChecks(ctxWith())).exitCode, 0);
	assert.match(toText(await runChecks(ctxWith({ applied: [] }))), /Verdict: not ready\. Exit 1/);
	assert.match(toText(await runChecks(ctxWith({ hosts: { total: 0, admins: 0 } }))), /Verdict: not ready\. Exit 2/);
});

test('a `run` command is always something that can be executed as written: no placeholder, ever', async () => {
	const scenarios: Over[] = [
		{ hosts: { total: 0, admins: 0 } }, { hosts: { total: 2, admins: 0 } }, { hosts: 'no-table' }, { applied: [] }, { cron: 'no-extension' }, { cron: 'missing-job' }, { cron: 'inactive' },
		{ env: {} }, { env: { ...GOOD_ENV, NEXT_PUBLIC_X: 'y' } }, { settings: { status: 200, body: { disable_signup: false } } }, { owner: { ok: false, reason: 'no' }, pooler: { ok: false, reason: 'no' } },
	];
	for (const over of scenarios) {
		for (const check of await runChecks(ctxWith(over))) {
			for (const next of check.next) if (next.kind === 'run') assert.ok(next.command && !/[<>]/.test(next.command), `${check.id}: ${next.command}`);
		}
	}
});

// Commands that change a person's account or destroy something. An agent must get a yes before running them,
// so each carries `confirm`, and nothing else does.
const NEEDS_CONFIRM = /--force|--reset-first-admin|--disable-signup|vercel link|--push-vercel-env|--vercel-protection/;

test('every run step that changes an account or destroys something says so with `confirm`, and no other step does', async () => {
	const linked = { projectId: 'p', orgId: 't' };
	const vercel = (over: { link?: typeof linked | null; protection?: string | null; names?: Record<string, string[]> }): Ctx['vercel'] => ({ linked: () => (over.link === undefined ? linked : over.link), envNames: async () => over.names ?? {}, protection: async () => (over.protection === undefined ? null : over.protection) });
	const scenarios: [string, Over, string][] = [
		['weak secret', { env: { ...GOOD_ENV, HOST_SESSION_SECRET: 'short' } }, 'destructive'],
		['sign-up on, token set', { env: { ...GOOD_ENV, SUPABASE_ACCESS_TOKEN: 'sbp_x' }, settings: { status: 200, body: { disable_signup: false } } }, 'account'],
		['not linked', { vercel: vercel({ link: null }) }, 'account'],
		['missing on vercel', { vercel: vercel({ names: { production: [], preview: [] } }) }, 'account'],
		['protection covers production', { vercel: vercel({ protection: 'all' }) }, 'account'],
	];
	const seen = new Set<string>();
	for (const [label, over, kind] of scenarios) {
		const checks = await runChecks(ctxWith(over));
		const flagged = checks.flatMap((check) => check.next).filter((next) => next.kind === 'run' && NEEDS_CONFIRM.test(next.command ?? ''));
		assert.ok(flagged.length > 0, `${label}: expected a sensitive run step`);
		for (const next of flagged) {
			assert.equal(next.confirm, kind, `${label}: ${next.command}`);
			seen.add(next.command ?? '');
		}
	}
	assert.equal(seen.size, 5, `five different sensitive commands were exercised: ${[...seen].join(' | ')}`);
	// The reverse: `confirm` appears on nothing else, in any scenario.
	for (const [, over] of scenarios.concat([['plain', { hosts: { total: 0, admins: 0 } }, ''], ['pending', { applied: [] }, '']])) {
		for (const next of (await runChecks(ctxWith(over))).flatMap((check) => check.next)) {
			if (next.confirm) assert.match(next.command ?? '', NEEDS_CONFIRM, `unexpected confirm on ${next.command}`);
		}
	}
});

test('the text report tells an agent to ask first on a step that needs a yes', async () => {
	const text = toText(await runChecks(ctxWith({ env: { ...GOOD_ENV, HOST_SESSION_SECRET: 'short' } })));
	assert.match(text, /-> Run: npm run setup -- --force[^\n]*\[ask the person first\]/);
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

// ---- fixes from the A15 trial ----

const vercelWith = (over: { protection?: string | null }): Ctx['vercel'] => ({
	linked: () => ({ projectId: 'prj_1', orgId: 'team_1' }),
	envNames: async () => ({}),
	protection: async () => (over.protection === undefined ? null : over.protection),
});

test('row 10: all_except_custom_domains is Vercel\'s Standard Protection: ok for the site, with the cron check left to a person', async () => {
	const check = byId(await runChecks(ctxWith({ vercel: vercelWith({ protection: 'all_except_custom_domains' }) })), 'vercel.protection');
	assert.equal(check.status, 'ok');
	assert.match(check.summary, /Standard Protection/);
	assert.match(check.summary, /first scheduled run/);
	assert.ok(check.next.length > 0 && check.next.every((next) => next.kind === 'human' && /keep-alive/.test(next.text)), 'a HUMAN look at the cron log, never a run step');
	assert.equal(exitCode([check]), 0);
});

test('row 8: vercel.linked names .vercel/project.json as the proof, and says the git-parse message can be ignored', async () => {
	const ok = byId(await runChecks(ctxWith({ vercel: vercelWith({}) })), 'vercel.linked');
	assert.equal(ok.status, 'ok');
	assert.match(ok.summary, /\.vercel\/project\.json/);
	assert.match(ok.summary, /Failed to parse Git repo data/);
});

test('sign-up wording is the Supabase docs\' own, with the page cited', async () => {
	const check = byId(await runChecks(ctxWith({ settings: { status: 200, body: { disable_signup: false } } })), 'auth.signup_disabled');
	const text = check.next.map((next) => next.text).join(' ');
	assert.match(text, /Allow new users to sign up/);
	assert.match(text, /supabase\.com\/docs\/guides\/auth\/general-configuration/);
	assert.doesNotMatch(text, /not confirmed|best known/);
});

test('row 3: a missing SUPABASE_URL with a store or PUBLIC_ URL for the project is a fix setup makes, not a step for the person', async () => {
	const { SUPABASE_URL: _, ...rest } = GOOD_ENV;
	for (const name of ['NEXT_PUBLIC_SUPABASE_URL', 'PUBLIC_SUPABASE_URL']) {
		const checks = await runChecks(ctxWith({ env: { ...rest, [name]: `https://${REF}.supabase.co` } }));
		assert.equal(byId(checks, 'env.required').status, 'ok', name);
		const names = byId(checks, 'env.public_names');
		assert.equal(names.status, 'fail', name);
		assert.match(names.summary, /→ SUPABASE_URL/);
		assert.equal(names.next[0].command, 'npm run setup');
	}
	const none = byId(await runChecks(ctxWith({ env: { ...rest } })), 'env.required');
	assert.equal(none.status, 'fail');
	assert.ok(none.next.some((next) => next.kind === 'human' && /SUPABASE_URL/.test(next.text)), 'with no URL anywhere it is still the person\'s');
});

test('env.same_project also compares the public address names; PUBLIC_ against NEXT_PUBLIC_ pointing apart fails', async () => {
	const other = 'zyxwvutsrqponmlkjihg';
	const apart = byId(await runChecks(ctxWith({ env: { ...GOOD_ENV, PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co`, NEXT_PUBLIC_SUPABASE_URL: `https://${other}.supabase.co` } })), 'env.same_project');
	assert.equal(apart.status, 'fail');
	assert.match(apart.summary, /PUBLIC_SUPABASE_URL → abcdefghijklmnopqrst/);
	assert.match(apart.summary, /NEXT_PUBLIC_SUPABASE_URL → zyxwvutsrqponmlkjihg/);
	assert.ok(apart.next.every((next) => next.kind === 'human'));
	const together = byId(await runChecks(ctxWith({ env: { ...GOOD_ENV, PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co`, NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co` } })), 'env.same_project');
	assert.equal(together.status, 'ok');
});

test('env.public_names says where the address came from: a PUBLIC_ source is not called a store name', async () => {
	const { SUPABASE_URL: _, ...rest } = GOOD_ENV;
	const fromPublic = byId(await runChecks(ctxWith({ env: { ...rest, PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co` } })), 'env.public_names');
	assert.match(fromPublic.summary, /PUBLIC_SUPABASE_URL → SUPABASE_URL/);
	assert.doesNotMatch(fromPublic.summary, /store gave/i);
	const fromStore = byId(await runChecks(ctxWith({ env: { ...rest, NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co` } })), 'env.public_names');
	assert.match(fromStore.summary, /NEXT_PUBLIC_SUPABASE_URL → SUPABASE_URL/);
});

test('vercel.protection names the API value it is talking about; only all_except_custom_domains is "Standard Protection", and previews are mentioned', async () => {
	const standard = byId(await runChecks(ctxWith({ vercel: vercelWith({ protection: 'all_except_custom_domains' }) })), 'vercel.protection');
	assert.match(standard.summary, /preview/i);
	assert.match(standard.summary, /custom domain/i);
	assert.match(standard.summary, /not verified|unverified/i);
	const legacy = byId(await runChecks(ctxWith({ vercel: vercelWith({ protection: 'prod_deployment_urls_and_all_previews' }) })), 'vercel.protection');
	assert.equal(legacy.status, 'warn');
	assert.match(legacy.summary, /prod_deployment_urls_and_all_previews/);
	assert.match(legacy.summary, /legacy/i);
	assert.doesNotMatch(legacy.summary, /is on as Standard Protection/);
});

test('trial 2 row 6: the vercel.env fix says exactly what it sends: the generated secrets AND the Supabase values', async () => {
	const check = byId(await runChecks(ctxWith({ vercel: { linked: () => ({ projectId: 'p', orgId: 't' }), envNames: async () => ({}), protection: async () => null } })), 'vercel.env');
	const push = check.next.find((next) => /--push-vercel-env/.test(next.command ?? ''));
	assert.ok(push);
	assert.match(push.text, /generated secrets/);
	assert.match(push.text, /Supabase/);
	assert.match(push.text, /never overwrites/);
});

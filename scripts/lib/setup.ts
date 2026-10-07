// `npm run setup`: gets a copy of Volley ready, safe to run again. Built for an AI agent first:
// it never asks a question, never overwrites a value it didn't make unless --force, never prints
// a secret value, and ends by running doctor so its last line is the verdict.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { productionSetting, refuseProduction } from '../production-guard.ts';
import { exitCode, publicRenames, runChecks, type Check, type Ctx, type Next } from './checks.ts';
import { EMAIL, makeHost, setHost } from './make-host.ts';
import { applyMigrations, pendingMigrations } from './migrations.ts';
import { VARS, makeSecret, mask, parse, setLine } from './env.ts';
import { addEnv, setProtectionPreviewOnly, vercelProbe, type Exec } from './vercel.ts';

export type Options = {
	dryRun: boolean;
	force: boolean;
	envFile: string; // where values are written, relative to the repo root
	fromEnvFile?: string;
	firstAdminEmail?: string;
	firstAdminName?: string;
	skipMigrate: boolean;
	pushVercelEnv: boolean;
	vercelTargets: string[];
	vercelProtection: boolean;
	disableSignup: boolean;
};

export type StepStatus = 'done' | 'unchanged' | 'would' | 'skipped' | 'failed';
export type Step = { id: string; status: StepStatus; detail: string; next: Next[] };

export type AuthAdmin = Parameters<typeof makeHost>[1];

export type Deps = {
	root: string;
	env: Record<string, string | undefined>;
	migrationsDir: URL;
	now(): number;
	exists(path: string): boolean;
	read(path: string): string | null;
	write(path: string, text: string, mode: number): void;
	remove(path: string): void;
	// Does git ignore this path? True also where there is no git repo (nothing to commit to).
	isIgnored(path: string): boolean;
	connectOwner(env: Record<string, string | undefined>): Promise<pg.Client>;
	authAdmin(env: Record<string, string | undefined>): AuthAdmin;
	exec: Exec;
	vercelLink(): { projectId: string; orgId: string } | null;
	fetch: typeof fetch;
	doctor(env: Record<string, string | undefined>): Promise<{ ctx: Ctx; close: () => Promise<void> }>;
};

export const FIRST_ADMIN_FILE = '.volley-first-admin.txt';
const GENERATED = VARS.filter((spec) => spec.origin === 'generated');
const SENSITIVE = new Set(['HOST_SESSION_SECRET', 'PARTICIPANT_SECRET', 'CRON_SECRET', 'SUPABASE_SECRET_KEY', 'POSTGRES_URL', 'POSTGRES_URL_NON_POOLING']);

const step = (id: string, status: StepStatus, detail: string, next: Next[] = []): Step => ({ id, status, detail, next });
const humanNext = (text: string): Next => ({ kind: 'human', text: `HUMAN: ${text}` });
const failure = (error: unknown) => (error as Error).message;

export const realDeps = (root: string, env: Record<string, string | undefined>, hooks: Pick<Deps, 'connectOwner' | 'exec' | 'vercelLink' | 'doctor' | 'authAdmin'>): Deps => ({
	root,
	env,
	migrationsDir: new URL('../../db/migrations/', import.meta.url),
	now: () => Date.now(),
	exists: (path) => existsSync(join(root, path)),
	read: (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null),
	write: (path, text, mode) => {
		writeFileSync(join(root, path), text, { mode });
		chmodSync(join(root, path), mode); // mode only applies to a new file; make an existing one private too
	},
	remove: (path) => rmSync(join(root, path), { force: true }),
	isIgnored: (path) => {
		// 0: ignored. 1: not ignored. Anything else (no repo, no git): nothing can be committed.
		const run = spawnSync('git', ['check-ignore', '-q', '--', path], { cwd: root });
		return run.status !== 1;
	},
	fetch,
	...hooks,
});

export async function runSetup(options: Options, deps: Deps): Promise<{ steps: Step[]; checks: Check[]; exitCode: 0 | 1 | 2 }> {
	const steps: Step[] = [];
	let fileText = deps.read(options.envFile) ?? '';
	let effective: Record<string, string | undefined> = { ...parse(fileText), ...deps.env };
	const writes: string[] = [];

	// Every write step goes through the production guard first: this repo's own production database is refused.
	try {
		refuseProduction(effective, 'setup', 'Setup never writes to the production database; ask the owner to run it with their approval.');
	} catch (error) {
		steps.push(step('guard.production', 'failed', failure(error), [humanNext('Point .env.local at a test or fresh Supabase project, not production.')]));
		return finish(steps, options, deps, effective);
	}

	// Secrets go only to a file git ignores, so a later `git add .` can't publish them.
	if (!deps.isIgnored(options.envFile)) {
		steps.push(step('env.out', 'failed', `${options.envFile} isn't ignored by git, so secrets written there could be committed. Nothing was written.`, [{ kind: 'run', command: 'npm run setup -- --env-out .env.local', text: 'Write to a file git ignores: npm run setup -- --env-out .env.local (every .env* name is ignored except .env.example).' }]));
		return finish(steps, options, deps, effective);
	}

	const put = (name: string, value: string) => {
		fileText = setLine(fileText, name, value);
		effective = { ...effective, [name]: value };
		writes.push(name);
	};

	// 1. Values from another env file (for example one `vercel env pull` made). Fills gaps only.
	let imported: Record<string, string> = {}; // also in a dry run, so the production guard sees what would arrive
	if (options.fromEnvFile) {
		const text = deps.read(options.fromEnvFile);
		if (text === null) steps.push(step('env.import', 'failed', `The file ${options.fromEnvFile} doesn't exist.`, [{ kind: 'run', command: 'vercel env pull .env.pulled.local', text: 'Make it with: vercel env pull .env.pulled.local (needs a linked project; every .env* name is git-ignored), or write the Supabase values into it.' }]));
		else {
			const incoming = parse(text);
			const names = Object.keys(incoming).filter((name) => (VARS.some((spec) => spec.name === name) || name.startsWith('NEXT_PUBLIC_') || name.startsWith('PUBLIC_')) && incoming[name] && !effective[name]);
			imported = Object.fromEntries(names.map((name) => [name, incoming[name]]));
			if (!options.dryRun) for (const name of names) put(name, incoming[name]);
			steps.push(step('env.import', names.length === 0 ? 'unchanged' : options.dryRun ? 'would' : 'done', names.length === 0 ? `Nothing to import from ${options.fromEnvFile}: every name it has is already set.` : `${options.dryRun ? 'Would import' : 'Imported'} ${names.join(', ')} from ${options.fromEnvFile}.`));
		}
	} else steps.push(step('env.import', 'skipped', 'No --from-env-file given.'));

	// 2. NEXT_PUBLIC_… → PUBLIC_… (copies; the originals stay).
	const renames = publicRenames(effective);
	if (renames.length === 0) steps.push(step('env.public_names', 'unchanged', 'No NEXT_PUBLIC_… names need a PUBLIC_… copy.'));
	else {
		if (!options.dryRun) for (const rename of renames) put(rename.to, effective[rename.from] as string);
		steps.push(step('env.public_names', options.dryRun ? 'would' : 'done', `${options.dryRun ? 'Would copy' : 'Copied'} ${renames.map((rename) => `${rename.from} → ${rename.to}`).join(', ')}.`));
	}

	// 3. Secrets.
	const made: string[] = [];
	const kept: string[] = [];
	for (const spec of GENERATED) {
		const current = effective[spec.name];
		if (current && !options.force) {
			kept.push(`${spec.name}: ${mask(current)}`);
			continue;
		}
		made.push(spec.name);
		if (!options.dryRun) put(spec.name, makeSecret());
	}
	steps.push(step('env.secrets', made.length === 0 ? 'unchanged' : options.dryRun ? 'would' : 'done', [
		made.length > 0 ? `${options.dryRun ? 'Would generate' : 'Generated'} ${made.map((name) => `${name}${options.dryRun ? '' : ` (${mask(effective[name])})`}`).join(', ')}${options.force ? ' (--force replaced any existing value: hosts are signed out and phones look new)' : ''}.` : '',
		kept.length > 0 ? `Kept as they were: ${kept.join(', ')}.` : '',
	].filter(Boolean).join(' ')));

	// The guard again, on the FINAL values: an address that only arrived through the import (or a
	// rename) must be refused before anything is written, connected to or pushed.
	try {
		refuseProduction({ ...effective, ...imported }, 'setup', 'Setup never writes to the production database; ask the owner to run it with their approval.');
	} catch (error) {
		steps.push(step('guard.production', 'failed', failure(error), [humanNext('Point the settings (.env.local and any --from-env-file) at a test or fresh Supabase project, not production.')]));
		return finish(steps, options, deps, { ...effective, ...imported });
	}

	// Write the env file once, private to the owner.
	if (writes.length > 0 && !options.dryRun) {
		deps.write(options.envFile, fileText, 0o600);
		steps.push(step('env.file', 'done', `Wrote ${[...new Set(writes)].join(', ')} to ${options.envFile} (permissions 0600).`));
	}

	// 4. Database: migrations, pg_cron, the first host. Needs the direct connection.
	let db: pg.Client | null = null;
	const needDb = !options.skipMigrate || options.firstAdminEmail !== undefined;
	if (needDb) {
		try {
			if (!effective.POSTGRES_URL_NON_POOLING) throw new Error('POSTGRES_URL_NON_POOLING is not set');
			db = await deps.connectOwner(effective);
		} catch (error) {
			steps.push(step('db.connect', 'failed', `Can't connect to the database: ${failure(error)}.`, [humanNext('Put the direct (or session-pooler) connection string in POSTGRES_URL_NON_POOLING in .env.local (Supabase dashboard → Connect), then run `npm run setup` again.')]));
		}
	}
	try {
		if (db) {
			if (options.skipMigrate) steps.push(step('db.migrate', 'skipped', '--skip-migrate was given.'));
			else {
				if (options.dryRun) {
					const pending = await pendingMigrations(db, deps.migrationsDir).catch(() => []);
					steps.push(step('db.migrate', pending.length === 0 ? 'unchanged' : 'would', pending.length === 0 ? 'All migrations are already applied.' : `Would apply ${pending.length}: ${pending.join(', ')}.`));
				} else {
					try {
						const applied = await applyMigrations(db, deps.migrationsDir);
						steps.push(step('db.migrate', applied.length === 0 ? 'unchanged' : 'done', applied.length === 0 ? 'All migrations are already applied.' : `Applied ${applied.length}: ${applied.join(', ')}.`));
						const switchedOn = await ensureCronJob(db);
						if (switchedOn) steps.push(step('db.pg_cron', 'done', 'Switched the hourly purge job (volley-purge-expired) back on.'));
					} catch (error) {
						steps.push(step('db.migrate', 'failed', failure(error), [humanNext('If the message says pg_cron can\'t be created: Supabase dashboard → Database → Extensions → search "pg_cron" → enable it, then run `npm run setup` again. Otherwise read the message and fix the SQL error it names.')]));
					}
				}
			}
			if (options.firstAdminEmail !== undefined) steps.push(await firstAdmin(db, options, deps, effective));
		}
	} finally {
		await db?.end().catch(() => undefined);
	}
	if (options.firstAdminEmail === undefined) steps.push(step('hosts.first_admin', 'skipped', 'No --first-admin-email given, so no host was made.', [{ kind: 'run', command: 'npm run setup -- --first-admin-email <EMAIL>', text: 'Ask the person which email they will sign in with, then run: npm run setup -- --first-admin-email <EMAIL>' }]));

	// 5. Vercel and Supabase settings: only with their own explicit flags.
	if (options.pushVercelEnv) steps.push(await pushVercelEnv(options, deps, effective));
	if (options.vercelProtection) steps.push(await protectionStep(options, deps));
	if (options.disableSignup) steps.push(await disableSignup(options, deps, effective));

	return finish(steps, options, deps, effective);
}

async function finish(steps: Step[], options: Options, deps: Deps, effective: Record<string, string | undefined>) {
	// The last thing setup does is ask doctor, on the values as they are now.
	const env = { ...effective };
	const { ctx: made, close } = await deps.doctor(env);
	// If the values point at production, doctor skips every database and Supabase check: it never connects.
	const blocked = productionSetting(env) ? `${productionSetting(env)} points at the production database, so this check was not run.` : undefined;
	const refuse = async () => {
		throw new Error(blocked);
	};
	const ctx: Ctx = blocked ? { ...made, blocked, query: refuse, connectOwner: async () => ({ ok: false, reason: blocked }), connectPooler: async () => ({ ok: false, reason: blocked }) } : made;
	try {
		const checks = await runChecks(ctx);
		const stepsFailed = steps.some((entry) => entry.status === 'failed');
		const code = exitCode(checks);
		const failed = steps.filter((entry) => entry.status === 'failed');
		const stepCode = failed.length === 0 ? 0 : failed.some((entry) => entry.next.some((next) => next.kind !== 'human')) ? 1 : 2;
		// 1 (the agent can act) beats 2 (a person is needed); 0 only when neither side failed.
		const codes = [code, stepCode].filter((value) => value > 0);
		return { steps, checks, exitCode: (codes.length === 0 ? 0 : Math.min(...codes)) as 0 | 1 | 2 };
	} finally {
		await close();
	}
}

// If the purge job exists but is switched off, switches it on. Returns true if it did.
async function ensureCronJob(db: pg.Client): Promise<boolean> {
	const { rows } = await db.query("select jobid, active from cron.job where jobname = 'volley-purge-expired'");
	if (rows.length === 0 || rows[0].active !== false) return false;
	await db.query('select cron.alter_job(job_id := $1, active := true)', [rows[0].jobid]);
	return true;
}

async function firstAdmin(db: pg.Client, options: Options, deps: Deps, effective: Record<string, string | undefined>): Promise<Step> {
	const email = (options.firstAdminEmail ?? '').trim().toLowerCase();
	if (!EMAIL.test(email)) return step('hosts.first_admin', 'failed', `"${options.firstAdminEmail}" isn't an email address.`, [{ kind: 'run', command: 'npm run setup -- --first-admin-email <EMAIL>', text: 'Run again with the person\'s real email.' }]);
	const host = (await db.query('select is_admin from public.hosts where email = $1', [email])).rows[0];
	if (host?.is_admin) return step('hosts.first_admin', 'unchanged', `${email} is already an admin host. Nothing changed (no password was touched).`);
	if (host) {
		if (options.dryRun) return step('hosts.first_admin', 'would', `Would make the existing host ${email} an admin.`);
		await setHost(db, email, { name: options.firstAdminName, admin: true });
		return step('hosts.first_admin', 'done', `${email} was already a host; made them an admin. Their password was not touched.`);
	}
	const account = (await db.query('select 1 from auth.users where lower(email) = $1', [email])).rows.length > 0;
	if (account && !options.force) {
		return step('hosts.first_admin', 'failed', `A Supabase account for ${email} already exists but isn't a host. Making it a host resets its password, so setup won't do that without --force.`, [{ kind: 'run', command: `npm run setup -- --first-admin-email ${email} --force`, text: `If that is the right person: run npm run setup -- --first-admin-email ${email} --force` }]);
	}
	if (options.dryRun) return step('hosts.first_admin', 'would', `Would create ${email} as an admin host and write the first password to ${FIRST_ADMIN_FILE} (never to the screen).`);
	if (deps.exists(FIRST_ADMIN_FILE) && !options.force) return step('hosts.first_admin', 'failed', `${FIRST_ADMIN_FILE} already exists, and setup won't overwrite a file that may hold a password.`, [{ kind: 'run', command: `rm ${FIRST_ADMIN_FILE}`, text: `If you have already used it: delete it (rm ${FIRST_ADMIN_FILE}) and run setup again.` }]);
	const password = makeSecret().slice(0, 32);
	await makeHost(db, deps.authAdmin(effective), email, password);
	await setHost(db, email, { name: options.firstAdminName, admin: true });
	deps.write(FIRST_ADMIN_FILE, `Volley first admin\nemail: ${email}\npassword: ${password}\nSign in at the site root (/). Delete this file once the password is saved somewhere safe.\n`, 0o600);
	return step('hosts.first_admin', 'done', `Created ${email} as an admin host. The first password is in ${FIRST_ADMIN_FILE} (permissions 0600); it was not printed.`, [humanNext(`Give the person the password in ${FIRST_ADMIN_FILE} privately (read the file, don't paste it into a chat log), have them sign in at the site root and keep it in a password manager, then delete the file.`)]);
}

async function pushVercelEnv(options: Options, deps: Deps, effective: Record<string, string | undefined>): Promise<Step> {
	const link = deps.vercelLink();
	if (!link) return step('vercel.env', 'failed', 'This folder is not linked to a Vercel project, so there is nowhere to push to.', [{ kind: 'run', command: 'vercel link', text: 'Run: vercel link (pick the project), then run setup again with --push-vercel-env.' }]);
	let present: Record<string, string[]>;
	try {
		present = await vercelProbe(deps.exec, () => link).envNames();
	} catch (error) {
		return step('vercel.env', 'failed', failure(error), [humanNext('Run `vercel login` and approve it in the browser, then run setup again.')]);
	}
	const todo: { name: string; target: string; replace: boolean }[] = [];
	for (const target of options.vercelTargets) {
		for (const spec of VARS) {
			if (spec.required === false || (spec.required === 'production' && target !== 'production')) continue;
			if (!effective[spec.name]) continue;
			const there = (present[target] ?? []).includes(spec.name);
			if (!there || options.force) todo.push({ name: spec.name, target, replace: there });
		}
	}
	if (todo.length === 0) return step('vercel.env', 'unchanged', `Nothing to add: ${options.vercelTargets.join(' and ')} already have every setting that is set here.`);
	if (options.dryRun) return step('vercel.env', 'would', `Would add to the linked project: ${todo.map((entry) => `${entry.name} (${entry.target})`).join(', ')}.`);
	try {
		for (const entry of todo) {
			if (entry.replace) {
				const result = deps.exec(['env', 'update', entry.name, entry.target, '--yes', ...(SENSITIVE.has(entry.name) ? ['--sensitive'] : [])], effective[entry.name]);
				if (result.status !== 0) throw new Error(`the Vercel CLI could not update ${entry.name} on ${entry.target}`);
			} else addEnv(deps.exec, entry.name, entry.target, effective[entry.name] as string, SENSITIVE.has(entry.name));
		}
	} catch (error) {
		return step('vercel.env', 'failed', failure(error), [humanNext('Run `vercel login` if it is not logged in; otherwise add the setting in the Vercel dashboard → Project → Settings → Environment Variables.')]);
	}
	return step('vercel.env', 'done', `Added to the linked project: ${todo.map((entry) => `${entry.name} (${entry.target})`).join(', ')}. Values went in through stdin; none were printed.`);
}

async function protectionStep(options: Options, deps: Deps): Promise<Step> {
	const link = deps.vercelLink();
	if (!link) return step('vercel.protection', 'failed', 'This folder is not linked to a Vercel project.', [{ kind: 'run', command: 'vercel link', text: 'Run: vercel link, then run setup again with --vercel-protection.' }]);
	try {
		const current = await vercelProbe(deps.exec, () => link).protection();
		if (current === null || current === 'preview') return step('vercel.protection', 'unchanged', 'Vercel Authentication already covers preview deployments only (or is off).');
		if (options.dryRun) return step('vercel.protection', 'would', `Would change Vercel Authentication from "${current}" to preview deployments only.`);
		setProtectionPreviewOnly(deps.exec, link);
		return step('vercel.protection', 'done', `Changed Vercel Authentication from "${current}" to preview deployments only, so the keep-alive cron can reach production.`);
	} catch (error) {
		return step('vercel.protection', 'failed', failure(error), [humanNext('Vercel dashboard → the project → Settings → Deployment Protection → Vercel Authentication → "Only Preview Deployments" → Save.')]);
	}
}

// The Management API needs a personal access token a person makes; the request body field
// (disable_signup) follows the documented response type and is not confirmed for PATCH.
async function disableSignup(options: Options, deps: Deps, effective: Record<string, string | undefined>): Promise<Step> {
	const token = effective.SUPABASE_ACCESS_TOKEN;
	const ref = /\/\/([a-z0-9]{20})\.supabase\.co/.exec(effective.SUPABASE_URL ?? '')?.[1];
	if (!token || !ref) {
		return step('auth.signup_disabled', 'failed', `Can't switch public sign-up off without ${!token ? 'SUPABASE_ACCESS_TOKEN' : 'a SUPABASE_URL with the project ref'}.`, [humanNext('Either make an access token (Supabase dashboard → Account → Access Tokens), put it in SUPABASE_ACCESS_TOKEN and run `npm run setup -- --disable-signup`; or turn it off by hand: Authentication → Sign In / Providers → "Allow new users to sign up" off → Save.')]);
	}
	if (options.dryRun) return step('auth.signup_disabled', 'would', 'Would ask the Supabase Management API to switch public sign-up off.');
	try {
		const response = await deps.fetch(`https://api.supabase.com/v1/projects/${ref}/config/auth`, {
			method: 'PATCH',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ disable_signup: true }),
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) throw new Error(`the Supabase Management API answered HTTP ${response.status}`);
		return step('auth.signup_disabled', 'done', 'Asked Supabase to switch public sign-up off. Doctor below confirms it.');
	} catch (error) {
		return step('auth.signup_disabled', 'failed', failure(error), [humanNext('Turn it off by hand: Supabase dashboard → Authentication → Sign In / Providers → "Allow new users to sign up" off → Save.')]);
	}
}

export function summaryText(steps: Step[], options: Options): string {
	const lines = [options.dryRun ? 'DRY RUN: nothing was changed. This is what setup would do.' : 'Setup summary:'];
	for (const entry of steps) {
		lines.push(`[${entry.status.padEnd(9)}] ${entry.id}: ${entry.detail}`);
		for (const next of entry.next) lines.push(`             -> ${next.text}`);
	}
	return lines.join('\n');
}


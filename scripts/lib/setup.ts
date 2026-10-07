// `npm run setup`: gets a copy of Volley ready, safe to run again. Built for an AI agent first:
// it never asks a question, never overwrites a value it didn't make unless --force (and never the first admin
// without --reset-first-admin), never prints
// a secret value, and ends by running doctor so its last line is the verdict.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type pg from 'pg';
import { productionSetting, refuseProduction } from '../production-guard.ts';
import { exitCode, human, publicRenames, runChecks, type Check, type Ctx, type Next } from './checks.ts';
import { EMAIL, makeHost, setHost } from './make-host.ts';
import { applyMigrations, pendingMigrationsReadOnly } from './migrations.ts';
import { ENV_NAME, VARS, makeSecret, mask, parse, redact, redactDeep, secretValues, setLine } from './env.ts';
import { writePrivate } from './private-file.ts';
import { safeRelative } from './safe-path.ts';
import { shellQuote } from './shell.ts';
import { addEnv, setProtectionPreviewOnly, vercelProbe, type Exec } from './vercel.ts';

export type Options = {
	dryRun: boolean;
	force: boolean; // replace generated secrets and values already on Vercel. Never touches the first admin.
	resetFirstAdmin: boolean; // reset an existing account's password / make an existing host an admin / replace the password file
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

export type StepStatus = 'done' | 'unchanged' | 'would' | 'skipped' | 'warn' | 'failed';
export type Step = { id: string; status: StepStatus; detail: string; next: Next[] };

export type AuthAdmin = Parameters<typeof makeHost>[1];

export type Deps = {
	root: string;
	env: Record<string, string | undefined>;
	migrationsDir: URL;
	now(): number;
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
const humanNext = human;
const EMAIL_TEMPLATE = 'npm run setup -- --first-admin-email <EMAIL>';
const failure = (error: unknown) => (error as Error).message;

export const realDeps = (root: string, env: Record<string, string | undefined>, hooks: Pick<Deps, 'connectOwner' | 'exec' | 'vercelLink' | 'doctor' | 'authAdmin'>): Deps => ({
	root,
	env,
	migrationsDir: new URL('../../db/migrations/', import.meta.url),
	now: () => Date.now(),
	read: (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null),
	write: (path, text, mode) => writePrivate(join(root, path), text, mode),
	remove: (path) => rmSync(join(root, path), { force: true }),
	isIgnored: (path) => {
		// Fail closed. The file must really sit inside the folder (a `../` path or a symlinked folder leads
		// elsewhere), and git must say yes (exit 0). Exit 1 is "not ignored"; any other answer (128: beyond a
		// symlink, outside the repo, a broken repo) only counts as fine when there is no repo at all.
		try {
			const home = realpathSync(root);
			const folder = realpathSync(dirname(join(root, path)));
			if (folder !== home && !folder.startsWith(home + sep)) return false;
		} catch {
			return false;
		}
		const run = spawnSync('git', ['check-ignore', '-q', '--', path], { cwd: root });
		if (run.status === 0) return true;
		if (run.status === 1) return false;
		return spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root }).status !== 0;
	},
	fetch,
	...hooks,
});

type SetupResult = { steps: Step[]; checks: Check[]; exitCode: 0 | 1 | 2 };

export async function runSetup(options: Options, deps: Deps): Promise<SetupResult> {
	// Every version of the settings setup has seen (process env, the env file, the import, what it
	// generated), so an error that escapes is scrubbed of all of them, not only of process.env.
	const seen: Record<string, string | undefined>[] = [deps.env];
	try {
		return await setup(options, deps, (view) => void seen.push(view));
	} catch (error) {
		throw new Error(redact((error as Error).message, seen.flatMap(secretValues)));
	}
}

async function setup(options: Options, deps: Deps, track: (view: Record<string, string | undefined>) => void): Promise<SetupResult> {
	const steps: Step[] = [];
	// One relative path, used for the read, git's ignore check and the write.
	const envFile = safeRelative(deps.root, options.envFile);
	let fileText = envFile === null ? '' : (deps.read(envFile) ?? '');
	let effective: Record<string, string | undefined> = { ...parse(fileText), ...deps.env };
	track(effective);
	const writes: string[] = [];

	// Every write step goes through the production guard first: this repo's own production database is refused.
	try {
		refuseProduction(effective, 'setup', 'Setup never writes to the production database; ask the owner to run it with their approval.');
	} catch (error) {
		steps.push(step('guard.production', 'failed', failure(error), [humanNext('Point .env.local at a test or fresh Supabase project, not production.')]));
		return finish(steps, options, deps, effective);
	}

	// Secrets go only to a file inside the repo that git ignores, so a later `git add .` can't publish them.
	if (envFile === null) {
		steps.push(step('env.out', 'failed', 'The --env-out path must be a file inside this folder (not the folder itself, not an absolute path elsewhere, not ../). Nothing was written.', [{ kind: 'run', command: 'npm run setup -- --env-out .env.local', text: 'Use a file name inside this folder that git ignores: npm run setup -- --env-out .env.local' }]));
		return finish(steps, options, deps, effective);
	}
	if (!deps.isIgnored(envFile)) {
		steps.push(step('env.out', 'failed', `${envFile} isn't ignored by git (or can't be checked), so secrets written there could be committed. Nothing was written.`, [{ kind: 'run', command: 'npm run setup -- --env-out .env.local', text: 'Write to a file git ignores: npm run setup -- --env-out .env.local (every .env* name is ignored except .env.example).' }]));
		return finish(steps, options, deps, effective);
	}

	// A value that can't be written to an env file so it reads back the same is refused, never written
	// mangled. Only the NAME is kept for the message: the value may be a secret.
	const unsafe: string[] = [];
	const put = (name: string, value: string) => {
		try {
			fileText = setLine(fileText, name, value);
		} catch {
			unsafe.push(name);
			return;
		}
		effective = { ...effective, [name]: value };
		track(effective);
		writes.push(name);
	};

	// 1. Values from another env file (for example one `vercel env pull` made). Fills gaps only.
	let imported: Record<string, string> = {}; // also in a dry run, so the production guard sees what would arrive
	if (options.fromEnvFile) {
		const text = deps.read(options.fromEnvFile);
		if (text === null) steps.push(step('env.import', 'failed', `The file ${options.fromEnvFile} doesn't exist.`, [{ kind: 'run', command: 'vercel env pull .env.pulled.local', text: 'Make it with: vercel env pull .env.pulled.local (needs a linked project; every .env* name is git-ignored), or write the Supabase values into it.' }]));
		else {
			const incoming = parse(text);
			const names = Object.keys(incoming).filter((name) => ENV_NAME.test(name) && (VARS.some((spec) => spec.name === name) || name.startsWith('NEXT_PUBLIC_') || name.startsWith('PUBLIC_')) && incoming[name] && !effective[name]);
			imported = Object.fromEntries(names.map((name) => [name, incoming[name]]));
			track(incoming);
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

	if (unsafe.length > 0) {
		steps.push(step('env.file', 'failed', `Nothing was written to ${envFile}: the value of ${[...new Set(unsafe)].join(', ')} can't be stored in an env file so it reads back the same (a line break, or quotes of every kind).`, [humanNext(`Fix the value of ${[...new Set(unsafe)].join(', ')} at its source (Supabase dashboard → Connect for the connection strings), then run \`npm run setup\` again.`)]));
		return finish(steps, options, deps, effective);
	}

	// Write the env file once, private to the owner.
	if (writes.length > 0 && !options.dryRun) {
		deps.write(envFile, fileText, 0o600);
		steps.push(step('env.file', 'done', `Wrote ${[...new Set(writes)].join(', ')} to ${envFile} (permissions 0600).`));
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
			else if (options.dryRun) {
				// Read only: a dry run must not create the bookkeeping table either.
				try {
					const pending = await pendingMigrationsReadOnly(db, deps.migrationsDir);
					steps.push(step('db.migrate', pending.length === 0 ? 'unchanged' : 'would', pending.length === 0 ? 'All migrations are already applied.' : `Would apply ${pending.length}: ${pending.join(', ')}.`));
				} catch (error) {
					steps.push(step('db.migrate', 'failed', `Could not read which migrations are applied: ${failure(error)}`, [humanNext('Fix what the message says (usually the database address or password in POSTGRES_URL_NON_POOLING), then run again.')]));
				}
			} else {
				let migrated = false;
				try {
					const applied = await applyMigrations(db, deps.migrationsDir);
					migrated = true;
					steps.push(step('db.migrate', applied.length === 0 ? 'unchanged' : 'done', applied.length === 0 ? 'All migrations are already applied.' : `Applied ${applied.length}: ${applied.join(', ')}.`));
				} catch (error) {
					steps.push(step('db.migrate', 'failed', failure(error), [humanNext('If the message says pg_cron can\'t be created: Supabase dashboard → Database → Extensions → search "pg_cron" → enable it, then run `npm run setup` again. Otherwise read the message and fix the SQL error it names.')]));
				}
				if (migrated) {
					try {
						const did = await ensureCronJob(db);
						steps.push(step('db.pg_cron', did ? 'done' : 'unchanged', did === 'scheduled' ? 'Scheduled the hourly purge job (volley-purge-expired), as migration 0008 does.' : did === 'switched on' ? 'Switched the hourly purge job (volley-purge-expired) back on.' : 'The hourly purge job (volley-purge-expired) is scheduled and on.'));
					} catch (error) {
						steps.push(step('db.pg_cron', 'failed', `Could not check or schedule the hourly purge job: ${failure(error)}`, [humanNext('Supabase dashboard → Database → Extensions → search "pg_cron" → enable it, then run `npm run setup` again.')]));
					}
				}
			}
			if (options.firstAdminEmail !== undefined) steps.push(await firstAdmin(db, options, deps, effective).catch((error) => hostLookupFailed(error, options)));
		}
	} finally {
		await db?.end().catch(() => undefined);
	}
	if (options.firstAdminEmail === undefined) steps.push(step('hosts.first_admin', 'skipped', 'No --first-admin-email given, so no host was made.', [humanNext('Ask the person which email they will sign in with, then run the template with it.', EMAIL_TEMPLATE)]));

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
		const failed = steps.filter((entry) => entry.status === 'failed');
		let code: 0 | 1 | 2;
		if (failed.some((entry) => entry.next.some((next) => next.kind !== 'human'))) code = 1; // setup's own failure the agent can act on
		else if (failed.length > 0) code = exitCode(checks, { ignoreSetup: true }) === 1 ? 1 : 2; // only a person can fix it: "run setup" must not send the agent round again
		else code = exitCode(checks);
		return { steps: redactDeep(steps, secretValues(effective)), checks, exitCode: code };
	} finally {
		await close();
	}
}

// Makes sure the hourly purge job exists and is on. The schedule call is migration 0008's, word for word.
async function ensureCronJob(db: pg.Client): Promise<'scheduled' | 'switched on' | null> {
	const { rows } = await db.query("select jobid, active from cron.job where jobname = 'volley-purge-expired'");
	if (rows.length === 0) {
		await db.query("select cron.schedule('volley-purge-expired', '0 * * * *', 'select public.purge_expired()')");
		return 'scheduled';
	}
	if (rows[0].active !== false) return null;
	await db.query('select cron.alter_job(job_id := $1, active := true)', [rows[0].jobid]);
	return 'switched on';
}

// The hosts table is missing (migrations failed, were skipped, or this is a dry run on a fresh database) or
// the lookup failed some other way: a step the agent can read, never a crash.
function hostLookupFailed(error: unknown, options: Options): Step {
	if ((error as { code?: string }).code === '42P01' || /does not exist/i.test(failure(error))) {
		if (options.dryRun) return step('hosts.first_admin', 'would', 'Would create the first admin after the migrations are applied: the hosts table does not exist yet.');
		return step('hosts.first_admin', 'failed', 'The hosts table does not exist, so the first admin could not be made: the migrations have not been applied.', [humanNext('Fix the db.migrate problem above (or run without --skip-migrate), then run setup again with the same --first-admin-email.')]);
	}
	return step('hosts.first_admin', 'failed', `Could not look the host up: ${failure(error)}`, [humanNext('Fix what the message says, then run setup again.')]);
}

async function firstAdmin(db: pg.Client, options: Options, deps: Deps, effective: Record<string, string | undefined>): Promise<Step> {
	const email = (options.firstAdminEmail ?? '').trim().toLowerCase();
	// The text is never echoed back: it came from outside and ends up in the report.
	if (!EMAIL.test(email)) return step('hosts.first_admin', 'failed', "That isn't a plain email address (letters, digits and . _ % + - only, one @, a real domain).", [humanNext('Ask the person for the email they will sign in with, then run the template with it.', EMAIL_TEMPLATE)]);
	const asked = shellQuote(email);
	// Never --force here: it also regenerates every secret, which signs all hosts out and makes phones look new.
	const resetCommand = `npm run setup -- --first-admin-email ${asked} --reset-first-admin`;
	// A person's decision, not the agent's: a mistyped email that matches someone else would otherwise be promoted or reset.
	const resetNext = (): Next => humanNext(`Confirm ${email} is the right person, then run: ${resetCommand}`);
	const forceWarning = ' (Not --force: that regenerates the secrets, which signs every host out and makes phones look new.)';
	const host = (await db.query('select is_admin from public.hosts where email = $1', [email])).rows[0];
	if (host?.is_admin) return step('hosts.first_admin', 'unchanged', `${email} is already an admin host. Nothing changed (no password was touched).`);
	if (host) {
		if (!options.resetFirstAdmin) return step('hosts.first_admin', 'failed', `${email} is already a host but not an admin. Making them one gives them power over every host, so setup won't without --reset-first-admin.${forceWarning}`, [resetNext()]);
		if (options.dryRun) return step('hosts.first_admin', 'would', `Would make the existing host ${email} an admin.`);
		await setHost(db, email, { name: options.firstAdminName, admin: true });
		return step('hosts.first_admin', 'done', `${email} was already a host; made them an admin. Their password was not touched.`);
	}
	const account = (await db.query('select 1 from auth.users where lower(email) = $1', [email])).rows.length > 0;
	if (account && !options.resetFirstAdmin) {
		return step('hosts.first_admin', 'failed', `A Supabase account for ${email} already exists but isn't a host. Making it a host resets its password, so setup won't do that without --reset-first-admin.${forceWarning}`, [resetNext()]);
	}
	// A password file that is already there: replaced only on request, and only if it is for this same person.
	const existingFile = deps.read(FIRST_ADMIN_FILE);
	if (existingFile !== null) {
		if (!options.resetFirstAdmin) return step('hosts.first_admin', 'failed', `${FIRST_ADMIN_FILE} already exists, and setup won't overwrite a file that may hold a password. Pass --reset-first-admin to replace it (only when it's for the same email), or have a person delete it once the password has been handed over.${forceWarning}`, [humanNext(`The file may hold a password nobody has read. Find out whether it was handed over; if it was (or is no longer needed), delete it (rm ${FIRST_ADMIN_FILE}) and run setup again.`)]);
		const owner = /^email: (\S+)$/m.exec(existingFile)?.[1]?.toLowerCase();
		if (owner !== email) return step('hosts.first_admin', 'failed', `${FIRST_ADMIN_FILE} is for ${owner && EMAIL.test(owner) ? owner : "someone setup can't identify"}, not ${email}, so setup won't replace it.`, [humanNext(`Find out whether that password was handed over. If it was (or is no longer needed), delete ${FIRST_ADMIN_FILE} and run setup again.`)]);
	}
	if (options.dryRun) {
		if (account) return step('hosts.first_admin', 'would', `Would reset the password of the existing account ${email}, make it an admin host${existingFile !== null ? ` and replace the existing ${FIRST_ADMIN_FILE}` : ''}, with the new password written to ${FIRST_ADMIN_FILE} (never to the screen).`);
		return step('hosts.first_admin', 'would', `Would create ${email} as an admin host and write the first password to ${FIRST_ADMIN_FILE} (never to the screen).`);
	}
	if (!deps.isIgnored(FIRST_ADMIN_FILE)) return step('hosts.first_admin', 'failed', `${FIRST_ADMIN_FILE} isn't ignored by git, so a password written there could be committed. Nothing was made.`, [{ kind: 'edit', text: `Add ${FIRST_ADMIN_FILE} to .gitignore, then run setup again.` }]);

	// The file first, the account second: a password that exists only after a failed write would leave an
	// account nobody can sign in to, and a rerun would call it "unchanged".
	const password = makeSecret().slice(0, 32);
	try {
		deps.write(FIRST_ADMIN_FILE, `Volley first admin\nemail: ${email}\npassword: ${password}\nSign in at the site root (/). Delete this file once the password is saved somewhere safe.\n`, 0o600);
	} catch (error) {
		// The write is atomic (temp file, then rename), so an existing file is untouched: nothing to clean up.
		return step('hosts.first_admin', 'failed', `Could not write ${FIRST_ADMIN_FILE}: ${redact(failure(error), [password])}. No account was made or changed.`, [humanNext('Make the folder writable (or free some disk space), then run setup again.')]);
	}
	// The account and the host row land together or not at all. (The Supabase account itself is made through
	// its API and can't be rolled back, so afterwards we look at what really exists and advise from that.)
	try {
		await db.query('begin');
		await makeHost(db, deps.authAdmin(effective), email, password, { expectExisting: account });
		await setHost(db, email, { name: options.firstAdminName, admin: true });
		await db.query('commit');
	} catch (error) {
		await db.query('rollback').catch(() => undefined);
		deps.remove(FIRST_ADMIN_FILE);
		const exists = await db.query('select 1 from auth.users where lower(email) = $1', [email]).then((found) => found.rows.length > 0, () => false);
		const again = `npm run setup -- --first-admin-email ${asked}${exists ? ' --reset-first-admin' : ''}`;
		const state = exists ? `The Supabase account exists but is not a host (its password may have been reset), so a rerun needs --reset-first-admin to set a fresh one.${forceWarning}` : 'No account was made, so a plain rerun starts from the beginning.';
		return step('hosts.first_admin', 'failed', `${redact(failure(error), [password])}. The password file was removed. ${state}`, [{ kind: 'run', command: again, text: `Once the cause above is fixed, run: ${again}` }]);
	}
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
	return step('vercel.env', 'done', `Added to the linked project: ${todo.map((entry) => `${entry.name} (${entry.target})`).join(', ')}. These are THIS machine's values, now live on those targets (a test database here means the deployment uses the test database). Values went in through stdin; none were printed.`);
}

async function protectionStep(options: Options, deps: Deps): Promise<Step> {
	const link = deps.vercelLink();
	if (!link) return step('vercel.protection', 'failed', 'This folder is not linked to a Vercel project.', [{ kind: 'run', command: 'vercel link', text: 'Run: vercel link, then run setup again with --vercel-protection.' }]);
	try {
		const current = await vercelProbe(deps.exec, () => link).protection();
		if (current === null || current === 'preview') return step('vercel.protection', 'unchanged', 'Vercel Authentication already covers preview deployments only (or is off).');
		// Only "All Deployments" is documented to protect production domains (Vercel docs: Deployment
		// Protection → "Choose which URLs to protect"). Any other value is left exactly as it is.
		if (current !== 'all') return step('vercel.protection', 'warn', `Vercel Authentication is "${current}". Setup only changes "all" (All Deployments), the one mode documented to cover production domains, so it left this alone.`, [humanNext('Look at the first scheduled run: Vercel dashboard → the project → Logs, filter requestPath:/api/cron/keep-alive. Status 200 means it gets through; a login page means set Vercel Authentication to "Only Preview Deployments".')]);
		if (options.dryRun) return step('vercel.protection', 'would', 'Would change Vercel Authentication from "all" to preview deployments only.');
		setProtectionPreviewOnly(deps.exec, link);
		return step('vercel.protection', 'done', 'Changed Vercel Authentication from "all" to preview deployments only, so the keep-alive cron can reach production.');
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


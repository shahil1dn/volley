// `npm run doctor`'s checks. Read-only, and built for an AI agent first: every check
// has a stable id, a status, one plain sentence, and exact next actions that are
// either something the agent can run or edit itself, or a step marked HUMAN: that
// only a person can do. Nothing here ever puts a secret VALUE into a result.
import { VARS, publicName, nextPublicNames, redactDeep, secretValues, type VarSpec } from './env.ts';

export type Status = 'ok' | 'fail' | 'warn' | 'skipped';
// run: a command the agent can run, exactly as written (`command`, never with a placeholder in it).
// edit: a file change the agent can make. human: a person must. `template` is a command with a
// <PLACEHOLDER> that only a person can fill in (an email, say): never run it as it stands.
// `confirm`: a run step that changes a person's account ('account') or destroys something that can't be
// brought back ('destructive'). The agent must have the person's yes before running it.
export type Next = { kind: 'run' | 'edit' | 'human'; text: string; command?: string; template?: string; confirm?: 'account' | 'destructive' };
export type Check = { id: string; status: Status; summary: string; next: Next[] };

const run = (command: string, text = '', confirm?: Next['confirm']): Next => ({ kind: 'run', command, text: text || `Run: ${command}`, ...(confirm ? { confirm } : {}) });
const edit = (text: string): Next => ({ kind: 'edit', text });
// What a person does after a Vercel CLI call failed: install the CLI if it is not there, else log in.
export const cliMissing = (error: unknown): boolean => /isn't installed/.test((error as Error).message);
export const vercelProblemNext = (error: unknown, then: string): Next =>
	cliMissing(error)
		? human(`Install the Vercel CLI (\`npm i -g vercel\`), run \`vercel login\` and approve it in the browser, then ${then}.`)
		: human(`Run \`vercel login\` and approve it in the browser, then ${then}.`);

export const human = (text: string, template?: string): Next => ({
	kind: 'human',
	text: `HUMAN: ${text}${template ? ` Template (replace the placeholder; never run it as it stands): ${template}` : ''}`,
	...(template ? { template } : {}),
});

type Rows = Record<string, unknown>[];
export type VercelProbe = {
	// The linked project, or null when this folder isn't linked (.vercel/project.json).
	linked(): { projectId: string; orgId: string } | null;
	// Environment variable NAMES by target (production, preview, development). Never values.
	envNames(): Promise<Record<string, string[]>>;
	// The project's Vercel Authentication setting: the deploymentType, or null for none.
	protection(): Promise<string | null>;
};

export type Ctx = {
	env: Record<string, string | undefined>;
	// A repo file's text (repo-relative path), or null when it isn't there.
	readFile(path: string): string | null;
	migrationsOnDisk(): string[];
	fetchJson(url: string, headers: Record<string, string>): Promise<{ status: number; body: unknown }>;
	// Read-only SQL as the database owner (direct connection, else the pooler). Throws on failure.
	query(sql: string): Promise<Rows>;
	// Each connects once and resolves 'ok' or a reason. The pooler one uses the pinned CA, like the app.
	connectOwner(): Promise<{ ok: true } | { ok: false; reason: string }>;
	connectPooler(): Promise<{ ok: true } | { ok: false; reason: string }>;
	// Only when --vercel was asked for; otherwise undefined and those checks are skipped.
	vercel?: VercelProbe;
	// Set when the settings point at this repo's production database: every database check is
	// skipped with this sentence and nothing connects.
	blocked?: string;
};

const blockedCheck = (ctx: Ctx, id: string): Check | null => (ctx.blocked ? { id, status: 'skipped', summary: ctx.blocked, next: [] } : null);

// Vercel function regions the app can be pinned to, and the AWS region Supabase names for the
// same place (Vercel's regions list; the pooler host carries the AWS name). The pairs are the
// ones Vercel documents as sharing a location; add to this table if a new region appears.
export const REGION_PAIRS: Record<string, string> = {
	iad1: 'us-east-1', cle1: 'us-east-2', sfo1: 'us-west-1', pdx1: 'us-west-2', yul1: 'ca-central-1',
	lhr1: 'eu-west-2', dub1: 'eu-west-1', cdg1: 'eu-west-3', fra1: 'eu-central-1', arn1: 'eu-north-1',
	sin1: 'ap-southeast-1', syd1: 'ap-southeast-2', hnd1: 'ap-northeast-1', icn1: 'ap-northeast-2',
	kix1: 'ap-northeast-3', bom1: 'ap-south-1', hkg1: 'ap-east-1', gru1: 'sa-east-1', cpt1: 'af-south-1',
};

export const awsRegionOf = (poolerUrl: string): string | null => /aws-\d+-([a-z0-9-]+)\.pooler\.supabase\.com/.exec(poolerUrl)?.[1] ?? null;
export const projectRefOf = (value: string): string | null =>
	/\/\/([a-z0-9]{20})\.supabase\.co/.exec(value)?.[1] ?? /\/\/postgres\.([a-z0-9]{20}):/.exec(value)?.[1] ?? /@db\.([a-z0-9]{20})\.supabase\.co/.exec(value)?.[1] ?? null;

// The renames a store's NEXT_PUBLIC_… names need before SvelteKit can read them. Only for names
// whose PUBLIC_ twin is missing. The publishable key is also accepted from the store's older
// ANON name (not confirmed which of the two a given store sends; both are tried).
export function publicRenames(env: Record<string, string | undefined>): { from: string; to: string }[] {
	const found = nextPublicNames(env)
		.filter((from) => !env[publicName(from)])
		.map((from) => ({ from, to: publicName(from) }));
	const key = 'PUBLIC_SUPABASE_PUBLISHABLE_KEY';
	if (!env[key] && !found.some((rename) => rename.to === key)) {
		const alias = ['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'].find((name) => env[name]);
		if (alias) found.push({ from: alias, to: key });
	}
	return found;
}

// The publishable key under whichever name it has: the PUBLIC_ one, or the store's NEXT_PUBLIC_ one.
const publishableKey = (env: Record<string, string | undefined>): string | undefined => {
	const rename = publicRenames(env).find((entry) => entry.to === 'PUBLIC_SUPABASE_PUBLISHABLE_KEY');
	return env.PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? (rename ? env[rename.from] : undefined);
};

const missingNames = (ctx: Ctx, wanted: (spec: VarSpec) => boolean): VarSpec[] => {
	const covered = new Set(publicRenames(ctx.env).map((rename) => rename.to));
	return VARS.filter((spec) => wanted(spec) && !ctx.env[spec.name] && !covered.has(spec.name));
};

function envRequired(ctx: Ctx): Check {
	const missing = missingNames(ctx, (spec) => spec.required === true);
	if (missing.length === 0) return { id: 'env.required', status: 'ok', summary: 'Every setting the app needs is set.', next: [] };
	const generated = missing.filter((spec) => spec.origin === 'generated');
	const supplied = missing.filter((spec) => spec.origin !== 'generated');
	const next: Next[] = [];
	if (generated.length > 0) next.push(run('npm run setup', `Run: npm run setup (it generates ${generated.map((spec) => spec.name).join(', ')}).`));
	for (const spec of supplied) next.push(human(`Add ${spec.name} to .env.local. ${spec.what} Get it from: ${spec.where}`));
	return { id: 'env.required', status: 'fail', summary: `These settings are missing: ${missing.map((spec) => spec.name).join(', ')}.`, next };
}

function envPublicNames(ctx: Ctx): Check {
	const renames = publicRenames(ctx.env);
	if (renames.length === 0) return { id: 'env.public_names', status: 'ok', summary: 'No NEXT_PUBLIC_… names are waiting to be renamed.', next: [] };
	return {
		id: 'env.public_names',
		status: 'fail',
		summary: `SvelteKit reads PUBLIC_… names, but the store gave NEXT_PUBLIC_… ones: ${renames.map((rename) => `${rename.from} → ${rename.to}`).join(', ')}.`,
		next: [run('npm run setup', `Run: npm run setup (it adds ${renames.map((rename) => rename.to).join(', ')} as copies; the originals stay).`)],
	};
}

function envSecrets(ctx: Ctx): Check {
	const weak = VARS.filter((spec) => spec.origin === 'generated' && spec.minLength && ctx.env[spec.name] && (ctx.env[spec.name] as string).length < spec.minLength);
	if (weak.length > 0) {
		return {
			id: 'env.secrets',
			status: 'fail',
			summary: `Too short to be safe: ${weak.map((spec) => `${spec.name} (needs ${spec.minLength}+ characters)`).join(', ')}.`,
			next: [run('npm run setup -- --force', 'Run: npm run setup -- --force (replaces them with fresh ones; this signs every host out and makes phones look new).', 'destructive')],
		};
	}
	if (!ctx.env.CRON_SECRET) {
		return {
			id: 'env.secrets',
			status: 'warn',
			summary: "CRON_SECRET isn't set here. Only the production deployment needs it, so this is fine for local work.",
			next: [run('npm run setup', 'Run: npm run setup to make one, then give it to Vercel Production with `npm run setup -- --push-vercel-env`.')],
		};
	}
	return { id: 'env.secrets', status: 'ok', summary: 'The generated secrets are long enough.', next: [] };
}

function envSameProject(ctx: Ctx): Check {
	const refs = (['SUPABASE_URL', 'POSTGRES_URL', 'POSTGRES_URL_NON_POOLING'] as const)
		.map((name) => ({ name, ref: ctx.env[name] ? projectRefOf(ctx.env[name] as string) : null }))
		.filter((entry): entry is { name: (typeof entry)['name']; ref: string } => entry.ref !== null);
	const distinct = new Set(refs.map((entry) => entry.ref));
	if (distinct.size <= 1) return { id: 'env.same_project', status: refs.length === 0 ? 'skipped' : 'ok', summary: refs.length === 0 ? 'No Supabase address to compare yet.' : 'The API address and the database addresses belong to one Supabase project.', next: [] };
	return {
		id: 'env.same_project',
		status: 'fail',
		summary: `These point at different Supabase projects: ${refs.map((entry) => `${entry.name} → ${entry.ref}`).join(', ')}.`,
		next: [human('Make SUPABASE_URL, POSTGRES_URL and POSTGRES_URL_NON_POOLING all come from the same Supabase project (Supabase dashboard → Connect).')],
	};
}

function dbPooler(ctx: Ctx): Check {
	const raw = ctx.env.POSTGRES_URL;
	if (!raw) return { id: 'db.pooler', status: 'skipped', summary: 'POSTGRES_URL is not set (see env.required).', next: [] };
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { id: 'db.pooler', status: 'fail', summary: "POSTGRES_URL isn't a valid connection address.", next: [human('Copy the Transaction pooler connection string from Supabase dashboard → Connect into POSTGRES_URL.')] };
	}
	const isPooler = url.hostname.endsWith('.pooler.supabase.com');
	if (!isPooler) {
		return {
			id: 'db.pooler',
			status: 'fail',
			summary: 'POSTGRES_URL is the direct database address. The app needs the transaction pooler, or a busy session runs out of connections.',
			next: [human('Supabase dashboard → Connect → Transaction pooler: copy that connection string (host ends .pooler.supabase.com, port 6543) into POSTGRES_URL.')],
		};
	}
	if (url.port !== '6543') {
		return {
			id: 'db.pooler',
			status: 'fail',
			summary: `POSTGRES_URL uses port ${url.port || '5432'}, which is the pooler's session mode. The app needs transaction mode, port 6543.`,
			next: [edit('In POSTGRES_URL change the port to 6543 (same host and user).')],
		};
	}
	return { id: 'db.pooler', status: 'ok', summary: 'POSTGRES_URL is the transaction pooler (port 6543).', next: [] };
}

function dbRegion(ctx: Ctx): Check {
	const dbRegion = ctx.env.POSTGRES_URL ? awsRegionOf(ctx.env.POSTGRES_URL) : null;
	if (!dbRegion) return { id: 'db.region', status: 'skipped', summary: "Can't read the database region: POSTGRES_URL is missing or isn't a pooler address.", next: [] };
	const config = ctx.readFile('svelte.config.js');
	const regions = config ? [...(/regions:\s*\[([^\]]*)\]/.exec(config)?.[1] ?? '').matchAll(/['"]([a-z]{3}\d)['"]/g)].map((match) => match[1]) : [];
	if (regions.length === 0) return { id: 'db.region', status: 'warn', summary: "svelte.config.js doesn't pin the function regions, so Vercel picks one (US East by default) and may sit far from the database.", next: [edit(`In svelte.config.js set adapter({ regions: ['${Object.entries(REGION_PAIRS).find(([, aws]) => aws === dbRegion)?.[0] ?? '<vercel region>'}'] }).`)] };
	const matching = Object.entries(REGION_PAIRS).find(([, aws]) => aws === dbRegion)?.[0];
	const unknown = regions.filter((region) => !REGION_PAIRS[region]);
	if (unknown.length > 0) return { id: 'db.region', status: 'warn', summary: `The function region ${unknown.join(', ')} isn't in doctor's region table, so it can't compare it with the database region (${dbRegion}).`, next: [] };
	if (regions.every((region) => REGION_PAIRS[region] === dbRegion)) return { id: 'db.region', status: 'ok', summary: `The functions (${regions.join(', ')}) and the database (${dbRegion}) are in the same region.`, next: [] };
	return {
		id: 'db.region',
		status: 'fail',
		summary: `The database is in ${dbRegion} but the functions run in ${regions.join(', ')} (${regions.map((region) => REGION_PAIRS[region]).join(', ')}). Every answer would cross the sea twice.`,
		next: [
			...(matching ? [edit(`Easiest: in svelte.config.js set adapter({ regions: ['${matching}'] }) so the functions sit beside the database, then redeploy.`)] : []),
			human(`Or create the Supabase project in the region next to your functions (${regions.map((region) => REGION_PAIRS[region]).join(', ')}); a project's region can't be changed once made.`),
		],
	};
}

async function dbConnect(ctx: Ctx): Promise<Check> {
	const blocked = blockedCheck(ctx, 'db.connect');
	if (blocked) return blocked;
	if (!ctx.env.POSTGRES_URL_NON_POOLING) return { id: 'db.connect', status: 'skipped', summary: 'POSTGRES_URL_NON_POOLING is not set (see env.required).', next: [] };
	const result = await ctx.connectOwner();
	if (result.ok) return { id: 'db.connect', status: 'ok', summary: 'Connected to the database as its owner (the address scripts use).', next: [] };
	return { id: 'db.connect', status: 'fail', summary: `Could not connect with POSTGRES_URL_NON_POOLING: ${result.reason}`, next: [human('Check POSTGRES_URL_NON_POOLING in Supabase dashboard → Connect (copy it again; the database password may have been reset).')] };
}

async function dbPoolerTls(ctx: Ctx): Promise<Check> {
	const blocked = blockedCheck(ctx, 'db.pooler_tls');
	if (blocked) return blocked;
	if (!ctx.env.POSTGRES_URL) return { id: 'db.pooler_tls', status: 'skipped', summary: 'POSTGRES_URL is not set (see env.required).', next: [] };
	const result = await ctx.connectPooler();
	if (result.ok) return { id: 'db.pooler_tls', status: 'ok', summary: "Connected through the pooler, verifying its certificate against the app's pinned Supabase root CA.", next: [] };
	const certificate = /certificate|self[- ]signed|unable to (get|verify)/i.test(result.reason);
	return {
		id: 'db.pooler_tls',
		status: 'fail',
		summary: `Could not connect through the pooler: ${result.reason}`,
		next: certificate
			? [edit('The pooler\'s certificate no longer chains to the root pinned in src/lib/server/supabase-ca.ts. Replace that certificate with Supabase\'s current root CA (Supabase dashboard → Database → Settings → SSL certificate).')]
			: [human('Check POSTGRES_URL (user, password, host) in Supabase dashboard → Connect → Transaction pooler.')],
	};
}

const tableMissing = (error: unknown) => (error as { code?: string })?.code === '42P01' || /does not exist/i.test(String((error as Error)?.message));

async function dbMigrations(ctx: Ctx): Promise<Check> {
	const blocked = blockedCheck(ctx, 'db.migrations');
	if (blocked) return blocked;
	const onDisk = ctx.migrationsOnDisk();
	let applied: string[];
	try {
		applied = (await ctx.query('select filename from public.schema_migrations')).map((row) => String(row.filename));
	} catch (error) {
		if (!tableMissing(error)) return { id: 'db.migrations', status: 'skipped', summary: "Can't read the database (see db.connect).", next: [] };
		applied = [];
	}
	const pending = onDisk.filter((name) => !applied.includes(name));
	if (pending.length === 0) return { id: 'db.migrations', status: 'ok', summary: `All ${onDisk.length} migrations are applied.`, next: [] };
	return {
		id: 'db.migrations',
		status: 'fail',
		summary: `${pending.length} of ${onDisk.length} migrations are not applied yet (${pending[0]}${pending.length > 1 ? ` … ${pending.at(-1)}` : ''}).`,
		next: [run('npm run setup', 'Run: npm run setup (it applies the missing migrations in order, each once).')],
	};
}

async function dbPgCron(ctx: Ctx): Promise<Check> {
	const blocked = blockedCheck(ctx, 'db.pg_cron');
	if (blocked) return blocked;
	let rows: Rows;
	try {
		rows = await ctx.query("select active, schedule from cron.job where jobname = 'volley-purge-expired'");
	} catch (error) {
		const noCron = (error as { code?: string })?.code === '3F000' || tableMissing(error);
		if (!noCron) return { id: 'db.pg_cron', status: 'skipped', summary: "Can't read the database (see db.connect).", next: [] };
		return {
			id: 'db.pg_cron',
			status: 'fail',
			summary: "pg_cron isn't switched on, so finished sessions' answers would never be deleted (they must go within 24 hours).",
			next: [run('npm run setup', 'Run: npm run setup (migration 0008 turns pg_cron on and schedules the hourly purge).'), human('If setup says it may not create the pg_cron extension: Supabase dashboard → Database → Extensions → search "pg_cron" → enable, then run `npm run setup` again.')],
		};
	}
	if (rows.length === 0) return { id: 'db.pg_cron', status: 'fail', summary: 'pg_cron is on but the hourly purge job (volley-purge-expired) is not scheduled.', next: [run('npm run setup', 'Run: npm run setup (it schedules the job).')] };
	if (rows[0].active === false) return { id: 'db.pg_cron', status: 'fail', summary: 'The hourly purge job exists but is switched off.', next: [run('npm run setup', 'Run: npm run setup (it switches the job back on).')] };
	return { id: 'db.pg_cron', status: 'ok', summary: `The purge job runs on schedule "${rows[0].schedule}".`, next: [] };
}

async function authSignup(ctx: Ctx): Promise<Check> {
	const url = ctx.env.SUPABASE_URL;
	const key = publishableKey(ctx.env);
	if (!url || !key) return { id: 'auth.signup_disabled', status: 'skipped', summary: 'SUPABASE_URL or the publishable key is not set (see env.required).', next: [] };
	let reply: { status: number; body: unknown };
	try {
		reply = await ctx.fetchJson(`${url.replace(/\/$/, '')}/auth/v1/settings`, { apikey: key });
	} catch (error) {
		return { id: 'auth.signup_disabled', status: 'fail', summary: `Could not reach Supabase Auth: ${(error as Error).message}`, next: [human('Check SUPABASE_URL and your internet connection.')] };
	}
	if (reply.status !== 200) return { id: 'auth.signup_disabled', status: 'fail', summary: `Supabase Auth answered HTTP ${reply.status} to the settings request, so the publishable key or the address is wrong.`, next: [human('Check SUPABASE_URL and PUBLIC_SUPABASE_PUBLISHABLE_KEY (Supabase dashboard → Project Settings → API).')] };
	const flag = (reply.body as { disable_signup?: unknown } | null)?.disable_signup;
	if (flag === true) return { id: 'auth.signup_disabled', status: 'ok', summary: 'Public sign-up is off, so only hosts you add can have accounts.', next: [] };
	if (flag === false) {
		return {
			id: 'auth.signup_disabled',
			status: 'fail',
			summary: 'Anyone on the internet can create a Supabase account on this project (public sign-up is on). The app refuses such accounts, but switch it off.',
			next: [
				...(ctx.env.SUPABASE_ACCESS_TOKEN ? [run('npm run setup -- --disable-signup', 'Run: npm run setup -- --disable-signup (SUPABASE_ACCESS_TOKEN is set, so it can ask the Supabase Management API to switch sign-up off).', 'account')] : []),
				human('Supabase dashboard → your project → Authentication → Sign In / Providers → turn off "Allow new users to sign up" → Save. (Menu wording as best known; not confirmed in the docs.) Then run `npm run doctor` again.'),
			],
		};
	}
	return { id: 'auth.signup_disabled', status: 'warn', summary: "Supabase's settings reply didn't say whether sign-up is allowed (no disable_signup field).", next: [human('Check Authentication → Sign In / Providers in the Supabase dashboard: "Allow new users to sign up" should be off.')] };
}

async function hostsFirstAdmin(ctx: Ctx): Promise<Check> {
	const blocked = blockedCheck(ctx, 'hosts.first_admin');
	if (blocked) return blocked;
	let rows: Rows;
	try {
		rows = await ctx.query('select count(*)::int as total, count(*) filter (where is_admin)::int as admins from public.hosts');
	} catch (error) {
		return { id: 'hosts.first_admin', status: 'skipped', summary: tableMissing(error) ? 'The hosts table does not exist yet (see db.migrations).' : "Can't read the database (see db.connect).", next: [] };
	}
	const total = Number(rows[0]?.total ?? 0);
	const admins = Number(rows[0]?.admins ?? 0);
	if (admins > 0) return { id: 'hosts.first_admin', status: 'ok', summary: `${total} host${total === 1 ? '' : 's'}, ${admins} of them admin.`, next: [] };
	if (total === 0) {
		return {
			id: 'hosts.first_admin',
			status: 'fail',
			summary: 'There is no host yet, so nobody can sign in and start a session.',
			next: [human('Ask the person which email they will sign in with, then run the template with it (it makes the account and an admin host; the first password goes to a private file, never the screen).', 'npm run setup -- --first-admin-email <EMAIL>')],
		};
	}
	return { id: 'hosts.first_admin', status: 'fail', summary: `There ${total === 1 ? 'is 1 host' : `are ${total} hosts`} but none is an admin, so nobody can invite more hosts.`, next: [human("Ask the person which existing host should be the admin, then run the template with that host's email.", 'npm run set-host -- <EMAIL> --admin')] };
}

const NEED_VERCEL: Next[] = [run('npm run doctor -- --vercel', 'Run: npm run doctor -- --vercel (checks the linked Vercel project; read-only).')];
const skippedVercel = (id: string): Check => ({ id, status: 'skipped', summary: 'Not checked: pass --vercel to check the linked Vercel project.', next: NEED_VERCEL });

function vercelLinked(ctx: Ctx): Check {
	if (!ctx.vercel) return skippedVercel('vercel.linked');
	const link = ctx.vercel.linked();
	if (link) return { id: 'vercel.linked', status: 'ok', summary: 'This folder is linked to a Vercel project (.vercel/project.json).', next: [] };
	return {
		id: 'vercel.linked',
		status: 'fail',
		summary: 'This folder is not linked to a Vercel project, so nothing can be checked or set there.',
		next: [run('vercel link', 'Run: vercel link (pick or create the project).', 'account'), human('If the CLI says you are not logged in: run `vercel login` and approve the sign-in in the browser it opens.')],
	};
}

async function vercelEnv(ctx: Ctx): Promise<Check> {
	if (!ctx.vercel) return skippedVercel('vercel.env');
	if (!ctx.vercel.linked()) return { id: 'vercel.env', status: 'skipped', summary: 'Needs vercel.linked first.', next: [] };
	let names: Record<string, string[]>;
	try {
		names = await ctx.vercel.envNames();
	} catch (error) {
		return { id: 'vercel.env', status: 'fail', summary: `Could not list the project's environment variables: ${(error as Error).message}`, next: [vercelProblemNext(error, 'run `npm run doctor -- --vercel` again')] };
	}
	const need = (target: string) => VARS.filter((spec) => spec.required === true || (spec.required === 'production' && target === 'production')).map((spec) => spec.name);
	const missing = ['production', 'preview'].flatMap((target) => need(target).filter((name) => !(names[target] ?? []).includes(name)).map((name) => ({ target, name })));
	if (missing.length === 0) return { id: 'vercel.env', status: 'ok', summary: 'Production and Preview have every setting the app needs.', next: [] };
	const fromGenerated = missing.filter((entry) => VARS.find((spec) => spec.name === entry.name)?.origin !== 'supabase');
	const fromSupabase = missing.filter((entry) => VARS.find((spec) => spec.name === entry.name)?.origin === 'supabase');
	const next: Next[] = [];
	if (fromGenerated.length > 0) next.push(run('npm run setup -- --push-vercel-env', 'Run: npm run setup -- --push-vercel-env (adds the generated secrets to the targets that lack them; never overwrites).', 'account'));
	if (fromSupabase.length > 0) next.push(human('Vercel dashboard → Storage → connect the Supabase project to this Vercel project for Production and Preview (it sets SUPABASE_URL, POSTGRES_URL … for you). The publishable key then needs the PUBLIC_ name: run `npm run setup -- --push-vercel-env` afterwards.'));
	return { id: 'vercel.env', status: 'fail', summary: `Missing on Vercel: ${missing.map((entry) => `${entry.name} (${entry.target})`).join(', ')}.`, next };
}

async function vercelProtection(ctx: Ctx): Promise<Check> {
	if (!ctx.vercel) return skippedVercel('vercel.protection');
	if (!ctx.vercel.linked()) return { id: 'vercel.protection', status: 'skipped', summary: 'Needs vercel.linked first.', next: [] };
	let type: string | null;
	try {
		type = await ctx.vercel.protection();
	} catch (error) {
		return { id: 'vercel.protection', status: 'fail', summary: `Could not read the project's deployment protection: ${(error as Error).message}`, next: [vercelProblemNext(error, 'run `npm run doctor -- --vercel` again')] };
	}
	if (type === null || type === 'preview') return { id: 'vercel.protection', status: 'ok', summary: type === null ? 'No Vercel Authentication, so the cron can reach production.' : 'Vercel Authentication covers preview deployments only, so the cron can reach production.', next: [] };
	// Vercel's Deployment Protection page: "All Deployments" protects production domains too, Standard
	// Protection (prod_deployment_urls_and_all_previews) protects everything except production domains.
	if (type === 'all') {
		return {
			id: 'vercel.protection',
			status: 'fail',
			summary: 'Vercel Authentication is on for All Deployments, production included; the daily keep-alive cron then gets a login page instead of the app and Supabase can pause the project.',
			next: [run('npm run setup -- --vercel-protection', 'Run: npm run setup -- --vercel-protection (sets Vercel Authentication to preview deployments only).', 'account'), human('Or by hand: Vercel dashboard → the project → Settings → Deployment Protection → Vercel Authentication → choose "Only Preview Deployments" → Save.')],
		};
	}
	const standard = type === 'prod_deployment_urls_and_all_previews';
	return {
		id: 'vercel.protection',
		status: 'warn',
		summary: standard
			? 'Vercel Authentication is on as Standard Protection. Vercel documents that this leaves production domains open, so the keep-alive cron should get through, but the docs do not say which address the cron calls.'
			: `Vercel Authentication is set to "${type}", a value doctor does not know, so it can't tell whether the keep-alive cron reaches production.`,
		next: [human('Look at the first scheduled run: Vercel dashboard → the project → Logs, filter requestPath:/api/cron/keep-alive. Status 200 means it gets through. A login page or redirect means set Vercel Authentication to "Only Preview Deployments" (Settings → Deployment Protection).')],
	};
}

function vercelCron(ctx: Ctx): Check {
	const text = ctx.readFile('vercel.json');
	if (text === null) return { id: 'vercel.cron', status: 'warn', summary: 'No vercel.json, so no keep-alive cron is configured. Supabase pauses an idle free project after 7 days.', next: [edit('Add a crons entry for /api/cron/keep-alive to vercel.json.')] };
	try {
		const crons = (JSON.parse(text) as { crons?: { path?: string }[] }).crons ?? [];
		if (crons.some((cron) => cron.path === '/api/cron/keep-alive')) return { id: 'vercel.cron', status: 'ok', summary: 'vercel.json schedules the daily keep-alive.', next: [] };
	} catch {
		return { id: 'vercel.cron', status: 'fail', summary: "vercel.json isn't valid JSON.", next: [edit('Fix the JSON in vercel.json.')] };
	}
	return { id: 'vercel.cron', status: 'warn', summary: 'vercel.json has no keep-alive cron. Supabase pauses an idle free project after 7 days.', next: [edit('Add { "path": "/api/cron/keep-alive", "schedule": "0 9 * * *" } to crons in vercel.json.')] };
}

export const CHECKS: ((ctx: Ctx) => Check | Promise<Check>)[] = [
	envRequired, envPublicNames, envSecrets, envSameProject,
	dbPooler, dbRegion, dbConnect, dbPoolerTls, dbMigrations, dbPgCron,
	authSignup, hostsFirstAdmin,
	vercelLinked, vercelEnv, vercelProtection, vercelCron,
];

export const IDS = [
	'env.required', 'env.public_names', 'env.secrets', 'env.same_project', 'db.pooler', 'db.region', 'db.connect', 'db.pooler_tls',
	'db.migrations', 'db.pg_cron', 'auth.signup_disabled', 'hosts.first_admin', 'vercel.linked', 'vercel.env', 'vercel.protection', 'vercel.cron',
];

export async function runChecks(ctx: Ctx): Promise<Check[]> {
	const results: Check[] = [];
	for (const [index, check] of CHECKS.entries()) {
		try {
			results.push(await check(ctx));
		} catch (error) {
			// A crashed check says so, with the message only: never the environment.
			results.push({ id: IDS[index], status: 'fail', summary: `This check crashed: ${(error as Error).message}`, next: [human('Tell the maintainers: doctor itself failed on this check.')] });
		}
	}
	// Whatever a driver, the network or the Vercel CLI said, no secret value goes into a report.
	return redactDeep(results, secretValues(ctx.env));
}

// 1: the agent can fix something by running a command or editing a file. 2: only a person can.
// 0: nothing failed. Warnings and skips never fail a run. If both kinds are present, the agent's
// own fixes come first (1); once they are done the run reports the human steps (2).
// `ignoreSetup`: don't count "run npm run setup" as something the agent can do. Setup uses this after one
// of its own steps failed, so a failure only a person can fix is not turned into "run setup again".
const isSetupRun = (next: Next) => next.kind === 'run' && /^npm run setup(\s|$)/.test(next.command ?? '');
export function exitCode(checks: Check[], options: { ignoreSetup?: boolean } = {}): 0 | 1 | 2 {
	const failed = checks.filter((check) => check.status === 'fail');
	if (failed.length === 0) return 0;
	return failed.some((check) => check.next.some((next) => next.kind !== 'human' && !(options.ignoreSetup && isSetupRun(next)))) ? 1 : 2;
}

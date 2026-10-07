// Returns Volley's test Supabase project to "brand new" for Volley's purposes, so a setup trial
// can start from nothing. It wipes data, so every guard runs BEFORE anything connects: only the
// one test project (by exact ref, any letter case) is ever accepted, production is named and
// refused, and a confirmation flag must be given. Supabase's managed schemas and extensions are never touched.
import pg from 'pg';
import { addressConfig } from './connection-target.ts';
import { PRODUCTION_REF, productionSetting } from '../production-guard.ts';
import { projectRefOf } from './checks.ts';

export const TEST_REF = 'gzwzfjukswcifikbsufm';
export const CONFIRM_FLAG = '--yes-wipe-volley-test-db';
const ADDRESSES = ['SUPABASE_URL', 'POSTGRES_URL'];

// The only two addresses the test project has: its direct host with the plain user, or any region's
// pooler with the project-qualified user.
const DIRECT_HOST = `db.${TEST_REF}.supabase.co`;
const POOLER_HOST = /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/;

type Target = { config: pg.ClientConfig } | { refusal: string };

// Reads POSTGRES_URL_NON_POOLING ONCE (addressConfig: the one reading every owner connection uses) and
// accepts only what it resolves to: one of the two shapes above. A regex over the text is not enough:
// percent-encoding, ?host=, ?user= and a longer host name each read differently to a pattern than to pg.
// The returned config is what gets connected to, so what is checked is what is used. A refusal never
// prints a piece of the address (a password can sit anywhere in it), only fixed text.
function readTarget(raw: string): Target {
	const refuse = (why: string): Target => ({ refusal: `POSTGRES_URL_NON_POOLING isn't the test project's address (${TEST_REF}): ${why}. Nothing was touched.` });
	if (/[\s\x00-\x1f\x7f]/.test(raw)) return refuse('it contains whitespace or control characters');
	let config: pg.ClientConfig & { host: string };
	let query: URLSearchParams;
	try {
		config = addressConfig(raw);
		query = new URL(raw).searchParams;
	} catch {
		return refuse('it cannot be read as a connection address');
	}
	for (const key of query.keys()) {
		if (key.toLowerCase() !== 'sslmode') return refuse('it has a query parameter other than sslmode (a parameter can change where pg connects)');
	}
	const host = config.host.toLowerCase();
	const user = String(config.user ?? '').toLowerCase();
	const direct = host === DIRECT_HOST && user === 'postgres';
	const pooler = POOLER_HOST.test(host) && user === `postgres.${TEST_REF}`;
	if (!direct && !pooler) return refuse(`its host and user are not the project's direct host (${DIRECT_HOST}, user postgres) or a Supabase pooler host (user postgres.${TEST_REF})`);
	return { config };
}

function checkTarget(env: Record<string, string | undefined>, args: string[]): Target {
	const production = productionSetting(env);
	if (production) return { refusal: `${production} points at the production database (${PRODUCTION_REF}). This script only ever wipes the test project (${TEST_REF}).` };
	if (!env.POSTGRES_URL_NON_POOLING) return { refusal: `POSTGRES_URL_NON_POOLING is not set, so there is nothing to confirm is the test project (${TEST_REF}).` };
	const target = readTarget(env.POSTGRES_URL_NON_POOLING);
	if ('refusal' in target) return target;
	for (const name of ADDRESSES) {
		const value = env[name];
		if (!value) continue;
		const ref = projectRefOf(value.toLowerCase());
		if (ref !== TEST_REF) return { refusal: `${name} ${ref ? `belongs to project ${ref}` : 'has no readable project ref'}, which isn't the test project (${TEST_REF}). Nothing was touched.` };
	}
	if (!args.includes(CONFIRM_FLAG)) return { refusal: `This wipes every table, function, auth user and Volley cron job in the test project. Pass ${CONFIRM_FLAG} to confirm.` };
	return target;
}

// Why this must not run, or null when every guard passes.
export function wipeableRefusal(env: Record<string, string | undefined>, args: string[]): string | null {
	const target = checkTarget(env, args);
	return 'refusal' in target ? target.refusal : null;
}

// Drops what Volley's migrations create in `public` (never an extension's own objects), our one cron
// job, and every auth user. pg_cron itself stays: Supabase's owner role owns it, and migration 0008 now
// copes with it being installed already. Written as catalogue loops so it needs no list of names to go stale.
const WIPE_PUBLIC = `
do $wipe$
declare r record;
begin
	if to_regclass('cron.job') is not null then
		perform cron.unschedule(jobid) from cron.job where jobname = 'volley-purge-expired';
	end if;
	for r in select format('%I.%I', n.nspname, c.relname) as name, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
		where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
		and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
		order by (c.relkind in ('v', 'm')) desc, (c.relkind = 'S') asc
	loop
		execute case r.relkind when 'v' then 'drop view if exists ' when 'm' then 'drop materialized view if exists ' when 'S' then 'drop sequence if exists ' when 'f' then 'drop foreign table if exists ' else 'drop table if exists ' end || r.name || ' cascade';
	end loop;
	for r in select p.oid::regprocedure::text as name, p.prokind from pg_proc p
		where p.pronamespace = 'public'::regnamespace and p.prokind in ('f', 'p')
		and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
	loop
		execute case r.prokind when 'p' then 'drop procedure if exists ' else 'drop function if exists ' end || r.name || ' cascade';
	end loop;
	for r in select format('%I.%I', n.nspname, t.typname) as name from pg_type t join pg_namespace n on n.oid = t.typnamespace
		left join pg_class c on c.oid = t.typrelid
		where n.nspname = 'public' and t.typtype in ('e', 'd', 'c') and (t.typtype <> 'c' or c.relkind = 'c')
		and not exists (select 1 from pg_depend d where d.objid = t.oid and d.deptype = 'e')
	loop
		execute 'drop type if exists ' || r.name || ' cascade';
	end loop;
end
$wipe$`;

// Encrypted, certificate not checked: the same trade-off as the other scripts (a laptop, Supabase's own CA).
const connectWith = async (config: pg.ClientConfig): Promise<pg.Client> => {
	const client = new pg.Client({ ...config, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000 });
	await client.connect();
	return client;
};

export type Left = { objects: number; users: number; jobs: number };

export async function resetTestDb(
	env: Record<string, string | undefined>,
	args: string[],
	connect: (config: pg.ClientConfig) => Promise<pg.Client> = connectWith,
): Promise<Left> {
	const target = checkTarget(env, args);
	if ('refusal' in target) throw new Error(target.refusal);
	const db = await connect(target.config);
	try {
		await db.query('begin');
		try {
			await db.query(WIPE_PUBLIC);
			await db.query('delete from auth.users');
			const left = await db.query(`select
				(select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f') and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e'))
				+ (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')) as objects,
				(select count(*) from auth.users) as users,
				(select case when to_regclass('cron.job') is null then 0 else (select count(*) from cron.job where jobname = 'volley-purge-expired') end) as jobs`);
			await db.query('commit');
			const row = left.rows[0] ?? {};
			return { objects: Number(row.objects ?? 0), users: Number(row.users ?? 0), jobs: Number(row.jobs ?? 0) };
		} catch (error) {
			await db.query('rollback').catch(() => undefined);
			throw error;
		}
	} finally {
		await db.end().catch(() => undefined);
	}
}

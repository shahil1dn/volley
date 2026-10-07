// Returns Volley's test Supabase project to "brand new" for Volley's purposes, so a setup trial
// can start from nothing. It wipes data, so every guard runs BEFORE anything connects: only the
// one test project (by exact ref, any letter case) is ever accepted, production is named and
// refused, and a confirmation flag must be given. Supabase's managed schemas are never touched (pg_cron, which
// Volley's own migration 0008 installs, is the one extension removed).
import type pg from 'pg';
import { PRODUCTION_REF, productionSetting } from '../production-guard.ts';
import { projectRefOf } from './checks.ts';
import { connectOwnerWith } from './context.ts';

export const TEST_REF = 'gzwzfjukswcifikbsufm';
export const CONFIRM_FLAG = '--yes-wipe-volley-test-db';
const ADDRESSES = ['SUPABASE_URL', 'POSTGRES_URL', 'POSTGRES_URL_NON_POOLING'];

// Why this must not run, or null when every guard passes.
export function wipeableRefusal(env: Record<string, string | undefined>, args: string[]): string | null {
	const production = productionSetting(env);
	if (production) return `${production} points at the production database (${PRODUCTION_REF}). This script only ever wipes the test project (${TEST_REF}).`;
	if (!env.POSTGRES_URL_NON_POOLING) return `POSTGRES_URL_NON_POOLING is not set, so there is nothing to confirm is the test project (${TEST_REF}).`;
	for (const name of ADDRESSES) {
		const value = env[name];
		if (!value) continue;
		const ref = projectRefOf(value.toLowerCase());
		if (ref !== TEST_REF) return `${name} ${ref ? `belongs to project ${ref}` : 'has no readable project ref'}, which isn't the test project (${TEST_REF}). Nothing was touched.`;
	}
	if (!args.includes(CONFIRM_FLAG)) return `This wipes every table, function, auth user and Volley cron job in the test project. Pass ${CONFIRM_FLAG} to confirm.`;
	return null;
}

// Drops what Volley's migrations create in `public` (never an extension's own objects), our one cron
// job (and the pg_cron extension itself, which migration 0008 installs), and every auth user. Written as catalogue loops so it needs no list of names to go stale.
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

export type Left = { objects: number; users: number; jobs: number };

export async function resetTestDb(
	env: Record<string, string | undefined>,
	args: string[],
	connect: (env: Record<string, string | undefined>) => Promise<pg.Client> = connectOwnerWith,
): Promise<Left> {
	const refusal = wipeableRefusal(env, args);
	if (refusal) throw new Error(refusal);
	const db = await connect(env);
	try {
		await db.query('begin');
		try {
			await db.query(WIPE_PUBLIC);
			// A new project has no pg_cron. Leaving it installed makes migration 0008's grants fail on the next run
			// (found by running the trial sequence), and its job table goes with it.
			await db.query('drop extension if exists pg_cron');
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

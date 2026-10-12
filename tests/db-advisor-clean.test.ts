// Migration 0017 (A13): every table says "no Data API access" explicitly, and the foreign keys the Security
// Advisor flagged have an index that starts with their column. Runs against the database in .env.local.
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { connectAsOwner } from '../scripts/pg-connect.ts';
import { inRolledBackTransaction, makeRun, skipWithoutDatabase as skip } from './db-helpers.ts';

let db: pg.Client;
before(async () => {
	if (!skip) db = await connectAsOwner();
});
after(async () => {
	await db?.end();
});

// Every table in the schema, not a fixed list, so a table added later without a policy fails here too.
const tablesWith = async (extra: string) => (await db.query(`
	select c.relname, c.relrowsecurity, c.relforcerowsecurity,
	  (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies,
	  ${extra}
	from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') order by 1`)).rows;

test('every public table has row security enabled and forced, and at least one policy', { skip }, async () => {
	const tables = await tablesWith('0 as unused');
	assert.ok(tables.length >= 14, 'found the tables');
	for (const table of tables) {
		assert.ok(table.relrowsecurity && table.relforcerowsecurity, `${table.relname}: RLS not enabled and forced`);
		assert.ok(table.policies >= 1, `${table.relname}: no policy (the Advisor reports rls_enabled_no_policy)`);
	}
});

test('every policy is a deny-all for anon and authenticated only, so it can never allow a row or touch the app role', { skip }, async () => {
	const { rows } = await db.query(`
		select p.polrelid::regclass::text as tbl, p.polname, p.polpermissive, p.polcmd,
		  coalesce(pg_get_expr(p.polqual, p.polrelid), '') as using_expr,
		  coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') as check_expr,
		  array(select r.rolname from pg_roles r where r.oid = any(p.polroles) order by 1) as roles
		from pg_policy p where p.polrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace)`);
	assert.ok(rows.length >= 14);
	for (const row of rows) {
		assert.equal(row.using_expr, 'false', `${row.tbl}.${row.polname}: using ${row.using_expr}`);
		assert.ok(row.check_expr === 'false' || row.check_expr === '', `${row.tbl}.${row.polname}: with check ${row.check_expr}`);
		assert.deepEqual(row.roles, ['anon', 'authenticated'], `${row.tbl}.${row.polname}: roles ${row.roles}`);
	}
});

test('anon and authenticated still get nothing: no privileges, and rows stay hidden even if a grant slipped in', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const tables = (await tablesWith('0 as unused')).map((table) => table.relname as string);
		for (const role of ['anon', 'authenticated']) {
			for (const name of tables) {
				for (const privilege of ['select', 'insert', 'update', 'delete', 'truncate']) {
					const { rows } = await db.query('select has_table_privilege($1, $2, $3) as has', [role, `public.${name}`, privilege]);
					assert.equal(rows[0].has, false, `${role} has ${privilege} on ${name}`);
				}
			}
		}
		// The second layer, proved on its own: grant the privileges (undone with the transaction) and look.
		await makeRun(db);
		await db.query('grant select, insert, update, delete on all tables in schema public to anon, authenticated');
		for (const role of ['anon', 'authenticated']) {
			await db.query('savepoint probe');
			await db.query(`set local role ${role}`);
			for (const name of ['runs', 'decks', 'hosts', 'deck_items']) {
				assert.equal((await db.query(`select count(*)::int as n from public.${name}`)).rows[0].n, 0, `${role} saw rows in ${name}`);
			}
			await assert.rejects(db.query('insert into public.hosts (user_id, email) values (gen_random_uuid(), \'x@example.invalid\')'), /row-level security|violates/i);
			await db.query('rollback to savepoint probe');
		}
	});
});

test('the six foreign keys the Advisor flagged each have an index that starts with their column', { skip }, async () => {
	const columns = [['host_invites', 'created_by'], ['moderation', 'item_id'], ['questions', 'item_id'], ['quotas', 'item_id'], ['responses', 'item_id'], ['tallies', 'item_id']];
	for (const [table, column] of columns) {
		const { rows } = await db.query(`
			select i.indexrelid::regclass::text as idx from pg_index i
			join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
			where i.indrelid = $1::regclass and a.attname = $2 and i.indisvalid and i.indpred is null`, [`public.${table}`, column]);
		assert.ok(rows.length >= 1, `${table}.${column}: no plain index starts with it`);
	}
});

test('no foreign key in public lacks an index that starts with its columns (what unindexed_foreign_keys checks)', { skip }, async () => {
	const { rows } = await db.query(`
		select c.conrelid::regclass::text as tbl, c.conname from pg_constraint c
		where c.contype = 'f' and c.connamespace = 'public'::regnamespace
		  and not exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indisvalid and (i.indkey::int2[])[0:cardinality(c.conkey)-1] @> c.conkey)`);
	assert.deepEqual(rows, []);
});

test('0017 can be run again over itself (rolled back) and changes nothing', { skip }, async () => {
	const sql = readFileSync('db/migrations/0017_advisor_clean.sql', 'utf8');
	const count = async () => (await db.query(`select (select count(*) from pg_policy p where p.polrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace))::int as policies,
		(select count(*) from pg_indexes where schemaname = 'public')::int as indexes`)).rows[0];
	const before = await count();
	await inRolledBackTransaction(db, async () => {
		await db.query(sql);
		assert.deepEqual(await count(), before);
	});
});

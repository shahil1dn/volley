// A4: nothing in the database is reachable with the public key.
// Runs against the database in .env.local; every statement is rolled back.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { connectAsOwner } from '../scripts/pg-connect.ts';

const skip = process.env.POSTGRES_URL_NON_POOLING ? false : 'no database in .env.local';
const PUBLIC_ROLES = ['anon', 'authenticated'];
const EXPECTED_TABLES = [
	'deck_items', 'decks', 'hosts', 'moderation', 'players', 'quotas',
	'rate_limits', 'responses', 'runs', 'schema_migrations', 'tallies',
];
const PERMISSION_DENIED = '42501';
const REFUSED = [401, 403, 404];

let db: pg.Client;
before(async () => {
	if (!skip) db = await connectAsOwner();
});
after(async () => {
	await db?.end();
});

// Every table in the schema, not a fixed list, so a table added later without
// locking it down fails here too.
async function publicTables(): Promise<{ name: string; plainColumn: string }[]> {
	const { rows } = await db.query(`
		select c.relname as name,
			-- Not an identity or generated column: writing one of those fails
			-- before the permission check, which would pass the test for the wrong reason.
			(select attname from pg_attribute
				where attrelid = c.oid and attnum > 0 and not attisdropped and attidentity = '' and attgenerated = ''
				order by attnum limit 1) as "plainColumn"
		from pg_class c join pg_namespace n on n.oid = c.relnamespace
		where n.nspname = 'public' and c.relkind in ('r', 'p')
		order by 1`);
	return rows;
}

async function inRolledBackTransaction(work: () => Promise<void>) {
	await db.query('begin');
	try {
		await work();
	} finally {
		await db.query('rollback');
	}
}

// The error code from running `sql` as `role`, or null if it succeeded.
async function errorCodeAs(role: string, sql: string): Promise<string | null> {
	await db.query('savepoint probe');
	try {
		await db.query(`set local role ${role}`);
		await db.query(sql);
		return null;
	} catch (err) {
		return (err as { code?: string }).code ?? 'unknown';
	} finally {
		await db.query('rollback to savepoint probe');
	}
}

test('the Volley tables exist', { skip }, async () => {
	const names = (await publicTables()).map((table) => table.name);
	for (const expected of EXPECTED_TABLES) assert.ok(names.includes(expected), `missing table ${expected}`);
});

test('row-level security is enabled and forced on every table', { skip }, async () => {
	const { rows } = await db.query(`
		select c.relname, c.relrowsecurity, c.relforcerowsecurity
		from pg_class c join pg_namespace n on n.oid = c.relnamespace
		where n.nspname = 'public' and c.relkind in ('r', 'p')`);
	for (const row of rows) {
		assert.ok(row.relrowsecurity && row.relforcerowsecurity, `${row.relname}: RLS not enabled and forced`);
	}
});

test('A4 in the database: public roles cannot read, write or empty any table', { skip }, async () => {
	await inRolledBackTransaction(async () => {
		for (const { name, plainColumn } of await publicTables()) {
			const table = `public.${db.escapeIdentifier(name)}`;
			const column = db.escapeIdentifier(plainColumn);
			for (const role of PUBLIC_ROLES) {
				for (const sql of [
					`select * from ${table} limit 1`,
					`insert into ${table} default values`,
					`update ${table} set ${column} = ${column}`,
					`delete from ${table}`,
					`truncate ${table}`,
				]) {
					assert.equal(await errorCodeAs(role, sql), PERMISSION_DENIED, `${role} was not refused: ${sql}`);
				}
			}
		}
	});
});

test('A4 in the database: public roles cannot use any sequence', { skip }, async () => {
	await inRolledBackTransaction(async () => {
		const { rows } = await db.query(`
			select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
			where n.nspname = 'public' and c.relkind = 'S'`);
		for (const { name } of rows) {
			for (const role of PUBLIC_ROLES) {
				const sql = `select nextval('public.${db.escapeIdentifier(name)}')`;
				assert.equal(await errorCodeAs(role, sql), PERMISSION_DENIED, `${role} was not refused: ${sql}`);
			}
		}
	});
});

// The same promise from the outside: what someone holding the publishable key
// gets back from Supabase's API. Only a refusal counts (401/403, or 404 for a
// table the API won't expose); a 400 from a bad body would prove nothing.
// Filters match no rows, so even a wrongly allowed update or delete changes nothing.
test('A4 through the API: the publishable key is refused on every table', { skip }, async () => {
	const { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY } = process.env;
	assert.ok(PUBLIC_SUPABASE_URL && PUBLIC_SUPABASE_PUBLISHABLE_KEY, 'public Supabase URL and key must be set');
	const headers = { apikey: PUBLIC_SUPABASE_PUBLISHABLE_KEY, 'content-type': 'application/json' };
	for (const { name, plainColumn } of await publicTables()) {
		const base = `${PUBLIC_SUPABASE_URL}/rest/v1/${name}`;
		const matchesNothing = `${encodeURIComponent(plainColumn)}=is.null`;
		const setToNull = JSON.stringify({ [plainColumn]: null });
		const attempts: [string, string, RequestInit][] = [
			['select', `${base}?select=*&limit=1`, { headers }],
			['insert', base, { method: 'POST', headers, body: '{}' }],
			['update', `${base}?${matchesNothing}`, { method: 'PATCH', headers, body: setToNull }],
			['delete', `${base}?${matchesNothing}`, { method: 'DELETE', headers }],
		];
		for (const [action, url, init] of attempts) {
			const res = await fetch(url, init);
			await res.arrayBuffer();
			assert.ok(REFUSED.includes(res.status), `${action} on ${name} was not refused (HTTP ${res.status})`);
		}
	}
});

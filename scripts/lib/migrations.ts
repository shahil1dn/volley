// Applies db/migrations/*.sql in filename order, each once. Shared by `npm run migrate`
// (scripts/migrate.mjs) and `npm run setup`, so there is one way to migrate.
import { readdir, readFile } from 'node:fs/promises';
import type pg from 'pg';

// Locked down like every other table: only the owner ever reads it.
const BOOKKEEPING = `
	create table if not exists public.schema_migrations (
		filename text primary key,
		applied_at timestamptz not null default now()
	);
	alter table public.schema_migrations enable row level security;
	alter table public.schema_migrations force row level security;
	revoke all on public.schema_migrations from anon, authenticated;
`;

export async function pendingMigrations(client: pg.Client, dir: URL): Promise<string[]> {
	const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
	await client.query(BOOKKEEPING);
	const { rows } = await client.query('select filename from public.schema_migrations');
	const applied = new Set(rows.map((row) => row.filename));
	return files.filter((name) => !applied.has(name));
}

// What `pendingMigrations` finds, without writing anything (a dry run): no bookkeeping table means
// every migration is pending. A database that can't be read throws; it is never "nothing pending".
export async function pendingMigrationsReadOnly(client: pg.Client, dir: URL): Promise<string[]> {
	const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
	await client.query('begin read only');
	try {
		const { rows: found } = await client.query(`select to_regclass('public.schema_migrations') as "table"`);
		if (found[0]?.table === null) return files;
		const { rows } = await client.query('select filename from public.schema_migrations');
		const applied = new Set(rows.map((row) => row.filename));
		return files.filter((name) => !applied.has(name));
	} finally {
		await client.query('rollback');
	}
}

export async function applyMigrations(client: pg.Client, dir: URL, log: (line: string) => void = () => undefined): Promise<string[]> {
	const pending = await pendingMigrations(client, dir);
	for (const name of pending) {
		// A migration and its record commit together, so a failure leaves neither.
		await client.query('begin');
		try {
			await client.query(await readFile(new URL(name, dir), 'utf8'));
			await client.query('insert into public.schema_migrations (filename) values ($1)', [name]);
			await client.query('commit');
		} catch (err) {
			await client.query('rollback');
			throw new Error(`Migration ${name} failed: ${(err as Error).message}`);
		}
		log(`Applied ${name}`);
	}
	return pending;
}

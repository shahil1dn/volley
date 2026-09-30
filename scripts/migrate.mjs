// Applies db/migrations/*.sql in filename order, each once. Safe to re-run.
//   node --env-file=.env.local scripts/migrate.mjs                  (the test project)
//   node --env-file=<production env> scripts/migrate.mjs --production
// Production takes the flag on purpose, and the owner's OK first (2026-09-30).
import { readdir, readFile } from 'node:fs/promises';
import { connectAsOwner } from './pg-connect.ts';
import { refuseProduction } from './production-guard.ts';

if (!process.argv.includes('--production')) {
	refuseProduction(process.env, 'migrate', 'Add --production to migrate production, with the owner\'s approval.');
}

const migrationsDir = new URL('../db/migrations/', import.meta.url);
const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();

const client = await connectAsOwner();
try {
	// Locked down like every other table: only the owner ever reads it.
	await client.query(`
		create table if not exists public.schema_migrations (
			filename text primary key,
			applied_at timestamptz not null default now()
		);
		alter table public.schema_migrations enable row level security;
		alter table public.schema_migrations force row level security;
		revoke all on public.schema_migrations from anon, authenticated;
	`);
	const { rows } = await client.query('select filename from public.schema_migrations');
	const applied = new Set(rows.map((row) => row.filename));

	const pending = files.filter((name) => !applied.has(name));
	for (const name of pending) {
		// A migration and its record commit together, so a failure leaves neither.
		await client.query('begin');
		try {
			await client.query(await readFile(new URL(name, migrationsDir), 'utf8'));
			await client.query('insert into public.schema_migrations (filename) values ($1)', [name]);
			await client.query('commit');
		} catch (err) {
			await client.query('rollback');
			throw new Error(`Migration ${name} failed: ${err.message}`);
		}
		console.log(`Applied ${name}`);
	}
	console.log(pending.length === 0 ? 'Up to date: no migrations to apply.' : `${pending.length} applied.`);
} finally {
	await client.end();
}

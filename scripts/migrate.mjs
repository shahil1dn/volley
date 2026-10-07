// Applies db/migrations/*.sql in filename order, each once. Safe to re-run.
//   node --env-file=.env.local scripts/migrate.mjs                  (the test project)
//   node --env-file=<production env> scripts/migrate.mjs --production
// Production takes the flag on purpose, and the owner's OK first (2026-09-30).
import { connectAsOwner } from './pg-connect.ts';
import { applyMigrations } from './lib/migrations.ts';
import { refuseProduction } from './production-guard.ts';

if (!process.argv.includes('--production')) {
	refuseProduction(process.env, 'migrate', 'Add --production to migrate production, with the owner\'s approval.');
}

const client = await connectAsOwner();
try {
	const applied = await applyMigrations(client, new URL('../db/migrations/', import.meta.url), console.log);
	console.log(applied.length === 0 ? 'Up to date: no migrations to apply.' : `${applied.length} applied.`);
} finally {
	await client.end();
}

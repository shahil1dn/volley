// Applies db/schema.sql to the database in .env.local.
//   node --env-file=.env.local scripts/migrate.mjs
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const url = process.env.POSTGRES_URL_NON_POOLING;
if (!url) throw new Error('POSTGRES_URL_NON_POOLING is not set. Run with --env-file=.env.local');

// Supabase signs with its own certificate authority, which Node does not ship.
// The link stays encrypted; only the certificate check is skipped, and only in
// this one-off script run from a developer laptop. The app itself never uses it.
const withoutSslMode = new URL(url);
withoutSslMode.searchParams.delete('sslmode');
const client = new pg.Client({
  connectionString: withoutSslMode.toString(),
  ssl: { rejectUnauthorized: false },
});
await client.connect();
try {
  await client.query(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  console.log('Schema applied.');
} finally {
  await client.end();
}

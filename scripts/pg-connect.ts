import pg from 'pg';

// Connects as the database owner from .env.local, for scripts and database tests
// run from a developer laptop. The app itself never uses this.
export async function connectAsOwner(): Promise<pg.Client> {
	const url = process.env.POSTGRES_URL_NON_POOLING;
	if (!url) throw new Error('POSTGRES_URL_NON_POOLING is not set. Run with --env-file=.env.local');

	// Supabase signs with its own certificate authority, which Node does not ship.
	// The link stays encrypted; only the certificate check is skipped.
	const withoutSslMode = new URL(url);
	withoutSslMode.searchParams.delete('sslmode');
	const client = new pg.Client({
		connectionString: withoutSslMode.toString(),
		ssl: { rejectUnauthorized: false },
	});
	await client.connect();
	return client;
}

import { attachDatabasePool } from '@vercel/functions';
import pg from 'pg';
import { POSTGRES_URL } from '$env/static/private';
import { SUPABASE_ROOT_CA } from '$lib/server/supabase-ca';

// Every server-side database call goes through here, over a direct Postgres
// connection via Supabase's transaction pooler (ADR-006). The Data API topped
// out at ~44 calls a second; this path measured ~320–340 answers a second.

// Per function instance. Fluid compute runs many requests on one instance, and
// each call holds a connection for ~20 ms, so 3 carry ~150 calls a second per
// instance. Kept small because every instance's connections count against the
// pooler's client limit; Supabase suggests starting at 1–5 for serverless.
const POOL_MAX = 3;

// The only SQL the app runs: fixed statements, values only ever as parameters.
const STATEMENTS = {
	get_state: 'select public.get_state($1) as result',
	submit_answer: 'select public.submit_answer($1, $2, $3, $4, $5) as result',
	allow_sign_in: 'select public.allow_sign_in($1, $2) as result',
	start_test_run: 'select public.start_test_run($1, $2) as result',
	host_action: 'select public.host_action($1, $2, $3, $4) as result',
	host_view: 'select public.host_view($1, $2) as result',
	host_email: 'select email as result from public.hosts where user_id = $1',
} as const;

let pool: pg.Pool | undefined;

function getPool(): pg.Pool {
	if (pool) return pool;
	const url = new URL(POSTGRES_URL);
	// The URL's own sslmode would override the stricter `ssl` settings below.
	url.searchParams.delete('sslmode');
	url.searchParams.delete('supa');
	pool = new pg.Pool({
		connectionString: url.toString(),
		// Verifies the pooler's certificate chain and hostname against Supabase's
		// pinned root, rather than accepting any certificate.
		ssl: { ca: SUPABASE_ROOT_CA, rejectUnauthorized: true },
		max: POOL_MAX,
		idleTimeoutMillis: 5_000,
		// Fail fast instead of leaving a phone waiting: a stuck pooler or query
		// becomes a 5xx the phone retries, within a few seconds.
		connectionTimeoutMillis: 3_000,
		query_timeout: 5_000,
	});
	// A pooled connection dropping while idle must not crash the instance.
	pool.on('error', (err) => console.error('Database pool error:', err.message));
	// Releases idle connections before Fluid compute suspends the instance, so
	// suspended instances don't hold pooler clients.
	attachDatabasePool(pool);
	return pool;
}

// Runs one of the statements above and returns its single result, or null
// when there is no row or the function returned null.
export async function dbCall<T>(statement: keyof typeof STATEMENTS, params: unknown[]): Promise<T | null> {
	const { rows } = await getPool().query(STATEMENTS[statement], params);
	return (rows[0]?.result ?? null) as T | null;
}

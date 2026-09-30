// After a few idle minutes Supabase's pooler took 3.3s to accept its first
// connection (measured 2026-09-30), just over the pool's 3s connect limit, and
// the next ones took ~70ms. So the first call after a quiet spell (the daily
// keep-alive, a workshop's first sign-in) failed. That failure is retried once:
// the connection never opened, so the query was never sent and running it again
// can't apply anything twice. A pool that is only busy fails with a different
// message and still fails fast.
const NEW_CONNECTION_TIMED_OUT = 'Connection terminated due to connection timeout';

export async function retryColdConnect<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (err) {
		if (!(err instanceof Error) || err.message !== NEW_CONNECTION_TIMED_OUT) throw err;
		return run();
	}
}

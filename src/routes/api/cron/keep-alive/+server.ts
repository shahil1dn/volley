import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { cronAuthorised } from '$lib/server/cron-auth';
import { dbCall } from '$lib/server/db';
import type { RequestHandler } from './$types';

// Called once a day by the Vercel Cron in vercel.json. Supabase pauses a free
// project after 7 days without activity, and workshops are fortnightly.
// The secret is read at runtime, not build time: it exists only in Production,
// so a Preview build without it still succeeds, and this route refuses there.
export const GET: RequestHandler = async ({ request }) => {
	const headers = { 'cache-control': 'no-store' };
	if (!cronAuthorised(request.headers.get('authorization'), env.CRON_SECRET)) {
		return json({ status: 'unauthorised' }, { status: 401, headers });
	}
	await dbCall('keep_alive', []);
	return json({ status: 'ok' }, { headers });
};

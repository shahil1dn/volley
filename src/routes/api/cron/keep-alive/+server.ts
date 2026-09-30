import { json } from '@sveltejs/kit';
import { CRON_SECRET } from '$env/static/private';
import { cronAuthorised } from '$lib/server/cron-auth';
import { dbCall } from '$lib/server/db';
import type { RequestHandler } from './$types';

// Called once a day by the Vercel Cron in vercel.json. Supabase pauses a free
// project after 7 days without activity, and workshops are fortnightly.
export const GET: RequestHandler = async ({ request }) => {
	const headers = { 'cache-control': 'no-store' };
	if (!cronAuthorised(request.headers.get('authorization'), CRON_SECRET)) {
		return json({ status: 'unauthorised' }, { status: 401, headers });
	}
	await dbCall('keep_alive', []);
	return json({ status: 'ok' }, { headers });
};

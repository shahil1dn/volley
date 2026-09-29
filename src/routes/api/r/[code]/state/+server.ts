import { error, json } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_SECRET_KEY, SUPABASE_URL } from '$env/static/private';
import { CODE_PATTERN } from '$lib/server/host-token';
import type { RequestHandler } from './$types';

const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

// Every device polls this, so it must be identical for all of them: Vercel's CDN
// then answers the room and the function runs about once a second (ADR-003).
export const GET: RequestHandler = async ({ params, setHeaders }) => {
	// A CDN hit never reaches this line, so counting it in the runtime logs counts
	// real function calls. Temporary: proves S1's cache assumption.
	console.log(`STATE_FN_CALL ${params.code}`);

	if (!CODE_PATTERN.test(params.code)) error(404, 'No such room');

	const { data: run, error: dbError } = await db
		.from('runs')
		.select('code, status')
		.eq('code', params.code)
		.maybeSingle();
	if (dbError) error(500, 'Could not load the room');
	if (!run) error(404, 'No such room');

	setHeaders({ 'cache-control': 'public, s-maxage=1, stale-while-revalidate=60' });
	return json({ code: run.code, status: run.status, serverNow: Date.now() });
};

import { error, json } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_SECRET_KEY, SUPABASE_URL } from '$env/static/private';
import { CODE_PATTERN } from '$lib/server/host-token';
import type { RequestHandler } from './$types';

const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

// Every device polls this, so it must be identical for all of them: Vercel's CDN
// then answers most polls without calling the function (ADR-004).
export const GET: RequestHandler = async ({ params, setHeaders }) => {
	if (!CODE_PATTERN.test(params.code)) error(404, 'No such room');

	const { data: state, error: dbError } = await db.rpc('get_state', { p_code: params.code });
	if (dbError) error(500, 'Could not load the room');
	if (!state) error(404, 'No such room');

	setHeaders({ 'cache-control': 'public, s-maxage=1, stale-while-revalidate=60' });
	return json(state);
};

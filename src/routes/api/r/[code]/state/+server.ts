import { error, json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { CODE_PATTERN } from '$lib/server/host-token';
import type { RequestHandler } from './$types';

// Every device polls this, so it must be identical for all of them: Vercel's CDN
// then answers most polls without calling the function (ADR-004).
export const GET: RequestHandler = async ({ params, setHeaders }) => {
	if (!CODE_PATTERN.test(params.code)) error(404, 'No such room');

	const { data: state, error: dbError } = await db.rpc('get_state', { p_code: params.code });
	if (dbError) error(500, 'Could not load the room');
	if (!state) error(404, 'No such room');

	setHeaders({
		// For the CDN only (Vercel reads it before Cache-Control; browsers ignore
		// it): the directives S1 measured (ADR-004).
		'cdn-cache-control': 'public, s-maxage=1, stale-while-revalidate=60',
		// For browsers: never reuse a copy. Given stale-while-revalidate, a browser
		// with no CDN in front (dev, self-hosting) shows each state a poll late.
		'cache-control': 'public, max-age=0, must-revalidate',
	});
	return json(state);
};

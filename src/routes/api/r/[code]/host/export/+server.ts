import { error } from '@sveltejs/kit';
import { dbCall } from '$lib/server/db';
import { CODE_PATTERN } from '$lib/server/host-token';
import { resultsCsv, type RunExport } from '$lib/server/results-csv';
import type { RequestHandler } from './$types';

// Guarded by hooks.server.ts; host_export returns nothing for another host's run.
export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.host) error(403, 'Not a host');
	if (!CODE_PATTERN.test(params.code)) error(404, 'No such room');
	const run = await dbCall<RunExport>('host_export', [locals.host.userId, params.code]);
	if (!run) error(404, 'No such room');
	return new Response(resultsCsv(run), {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="volley-${run.code}-results.csv"`,
			'cache-control': 'no-store',
		},
	});
};

import { error } from '@sveltejs/kit';
import { CODE_PATTERN } from '$lib/server/host-token';
import type { PageServerLoad } from './$types';

// Guarded by hooks.server.ts. Whether this run is the host's is checked by the
// database on every poll and action (host_view, host_action).
export const load: PageServerLoad = ({ locals, params, url }) => {
	if (!locals.host) error(403, 'Not a host');
	if (!CODE_PATTERN.test(params.code)) error(404, 'No such room');
	return { code: params.code, joinUrl: `${url.origin}/j/${params.code}` };
};

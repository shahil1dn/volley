import { error, redirect } from '@sveltejs/kit';
import { endHostSession } from '$lib/server/host-guard';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	// hooks.server.ts guards this path; refusing here too fails closed if the
	// route is ever moved outside the guarded paths.
	if (!locals.host) error(403, 'Not a host');
	return { email: locals.host.email };
};

export const actions: Actions = {
	signOut: ({ cookies }) => {
		endHostSession(cookies);
		redirect(303, '/');
	},
};

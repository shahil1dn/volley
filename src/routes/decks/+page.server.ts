import { error, fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { endHostSession } from '$lib/server/host-guard';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	// hooks.server.ts guards this path; refusing here too fails closed if the
	// route is ever moved outside the guarded paths.
	if (!locals.host) error(403, 'Not a host');
	return { email: locals.host.email };
};

export const actions: Actions = {
	// A one-question word cloud until decks arrive in Milestone 3.
	startRun: async ({ locals, request }) => {
		if (!locals.host) error(403, 'Not a host');
		const prompt = String((await request.formData()).get('prompt') ?? '');
		const { data: result, error: dbError } = await db.rpc('start_test_run', { p_host_id: locals.host.userId, p_prompt: prompt });
		if (dbError || !result) error(500, 'Could not start the run');
		if (result.status !== 'ok') return fail(400, { prompt, message: 'Enter a question of 1 to 140 characters.' });
		redirect(303, `/run/${result.code}/control`);
	},
	signOut: ({ cookies }) => {
		endHostSession(cookies);
		redirect(303, '/');
	},
};

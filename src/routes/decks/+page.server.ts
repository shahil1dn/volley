import { error, fail, redirect } from '@sveltejs/kit';
import { dbCall } from '$lib/server/db';
import { endHostSession } from '$lib/server/host-guard';
import { parseSessionForm } from '$lib/server/session-form';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	// hooks.server.ts guards this path; refusing here too fails closed if the
	// route is ever moved outside the guarded paths.
	if (!locals.host) error(403, 'Not a host');
	return { email: locals.host.email, name: locals.host.name, isAdmin: locals.host.isAdmin };
};

export const actions: Actions = {
	// A session of 1 to MAX_ACTIVITIES activities, in order, under one room code.
	// parseSessionForm enforces the count and each field; the database checks
	// them again.
	startSession: async ({ locals, request }) => {
		if (!locals.host) error(403, 'Not a host');
		const parsed = parseSessionForm(await request.formData());
		if (!parsed.ok) return fail(400, { drafts: parsed.drafts, errors: parsed.errors });

		const result = await dbCall<{ status: string; code?: string }>('start_session', [locals.host.userId, JSON.stringify(parsed.items)]);
		if (!result) error(500, 'Could not start the session');
		if (result.status === 'not_host') error(403, 'Not a host');
		if (result.status !== 'ok') {
			// The form passed our checks but not the database's: the two have drifted.
			return fail(400, {
				drafts: parsed.items.map((item) => ({ type: item.type, prompt: item.prompt, options: item.options ?? [] })),
				errors: { form: 'The session was refused. Check each activity and try again.', drafts: parsed.items.map(() => ({})) },
			});
		}
		redirect(303, `/run/${result.code}/control`);
	},
	signOut: ({ cookies }) => {
		endHostSession(cookies);
		redirect(303, '/');
	},
};

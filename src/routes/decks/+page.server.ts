import { error, fail, redirect } from '@sveltejs/kit';
import { dbCall } from '$lib/server/db';
import { endHostSession } from '$lib/server/host-guard';
import type { Actions, PageServerLoad } from './$types';

const SLOTS = 3;

export const load: PageServerLoad = ({ locals }) => {
	// hooks.server.ts guards this path; refusing here too fails closed if the
	// route is ever moved outside the guarded paths.
	if (!locals.host) error(403, 'Not a host');
	return { email: locals.host.email };
};

export const actions: Actions = {
	// Up to 3 activities in order under one room code, until the deck editor
	// arrives in Milestone 3 (ADR-008). The database checks every field.
	startSession: async ({ locals, request }) => {
		if (!locals.host) error(403, 'Not a host');
		const form = await request.formData();
		const slots = Array.from({ length: SLOTS }, (_, i) => ({
			type: String(form.get(`type${i}`) ?? ''),
			prompt: String(form.get(`prompt${i}`) ?? ''),
			options: String(form.get(`options${i}`) ?? ''),
		}));
		const items = slots
			.filter((slot) => slot.type !== '')
			.map((slot) =>
				slot.type === 'poll'
					? // Blank lines are just spacing.
						{ type: slot.type, prompt: slot.prompt, options: slot.options.split(/\r?\n/).filter((line) => line.trim() !== '') }
					: { type: slot.type, prompt: slot.prompt },
			);
		const result = await dbCall<{ status: string; code?: string }>('start_session', [locals.host.userId, JSON.stringify(items)]);
		if (!result) error(500, 'Could not start the session');
		if (result.status !== 'ok') {
			return fail(400, {
				slots,
				message: 'Each activity needs a question of 1 to 140 characters. A poll needs 2 to 6 different options, each up to 80 characters.',
			});
		}
		redirect(303, `/run/${result.code}/control`);
	},
	signOut: ({ cookies }) => {
		endHostSession(cookies);
		redirect(303, '/');
	},
};

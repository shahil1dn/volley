import { error, fail, redirect } from '@sveltejs/kit';
import { dbCall } from '$lib/server/db';
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
		const result = await dbCall<{ status: string; code?: string }>('start_test_run', [locals.host.userId, prompt]);
		if (!result) error(500, 'Could not start the run');
		if (result.status !== 'ok') return fail(400, { prompt, message: 'Enter a question of 1 to 140 characters.' });
		redirect(303, `/run/${result.code}/control`);
	},
	// A one-question poll, options one per line, until decks arrive in Milestone 3.
	startPoll: async ({ locals, request }) => {
		if (!locals.host) error(403, 'Not a host');
		const form = await request.formData();
		const pollPrompt = String(form.get('prompt') ?? '');
		const optionsText = String(form.get('options') ?? '');
		// Blank lines are just spacing; the database checks everything else.
		const options = optionsText.split(/\r?\n/).filter((line) => line.trim() !== '');
		const result = await dbCall<{ status: string; code?: string }>('start_test_poll', [locals.host.userId, pollPrompt, options]);
		if (!result) error(500, 'Could not start the poll');
		if (result.status !== 'ok') {
			return fail(400, {
				pollPrompt,
				optionsText,
				pollMessage: 'Enter a question of 1 to 140 characters and 2 to 6 different options, each up to 80 characters.',
			});
		}
		redirect(303, `/run/${result.code}/control`);
	},
	signOut: ({ cookies }) => {
		endHostSession(cookies);
		redirect(303, '/');
	},
};

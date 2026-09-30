import { redirect } from '@sveltejs/kit';
import { dbCall } from '$lib/server/db';
import { CODE_PATTERN } from '$lib/server/host-token';
import type { PageServerLoad } from './$types';

// The form submits with GET, so this works before (or without) the page's
// scripts: an empty visit shows the form, a submitted code is checked here.
export const load: PageServerLoad = async ({ url }) => {
	const typed = url.searchParams.get('code');
	if (typed === null) return { typed: '', problem: null };
	// Typed off a projector, so case, spaces and dashes are forgiven.
	const code = typed.toUpperCase().replace(/[\s-]/g, '');
	if (!CODE_PATTERN.test(code)) return { typed, problem: 'format' as const };
	if (!(await dbCall<boolean>('run_exists', [code]))) return { typed, problem: 'unknown' as const };
	redirect(303, `/j/${code}`);
};

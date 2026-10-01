import { error, fail, redirect } from '@sveltejs/kit';
import { dbCall } from '$lib/server/db';
import { startHostSession } from '$lib/server/host-guard';
import { hashToken, passwordProblem, TOKEN_PATTERN } from '$lib/server/invite-token';
import { setPassword } from '$lib/server/invites';
import type { Actions, PageServerLoad } from './$types';

type Peek = { status: 'ok' | 'used' | 'expired' | 'invalid'; email?: string; name?: string; purpose?: 'invite' | 'reset' };

// The token is in the path, so keep it out of other sites' Referer headers and
// out of caches. same-origin, not no-referrer: with no-referrer, browsers send
// "Origin: null" on the page's own form POST, and SvelteKit's CSRF check
// refuses it in production (it skips the check in dev).
function keepPrivate(setHeaders: (headers: Record<string, string>) => void) {
	setHeaders({ 'referrer-policy': 'same-origin', 'cache-control': 'no-store' });
}

async function peek(token: string): Promise<Peek> {
	if (!TOKEN_PATTERN.test(token)) return { status: 'invalid' };
	const result = await dbCall<Peek>('peek_host_invite', [hashToken(token)]);
	if (!result) error(500, 'Could not read the link');
	return result;
}

export const load: PageServerLoad = async ({ params, setHeaders }) => {
	keepPrivate(setHeaders);
	return { invite: await peek(params.token) };
};

const REFUSED: Record<string, string> = {
	used: 'This link has already been used. Ask for a new one.',
	expired: 'This link has expired. Ask for a new one.',
	invalid: 'This link isn’t valid. Ask for a new one.',
	wrong_account: 'This link isn’t valid. Ask for a new one.',
};

export const actions: Actions = {
	default: async ({ params, request, cookies, setHeaders }) => {
		keepPrivate(setHeaders);
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const password = String(form.get('password') ?? '');

		if (!TOKEN_PATTERN.test(params.token)) return fail(400, { name, message: REFUSED.invalid });
		if (name.length < 1 || name.length > 40) return fail(400, { name, message: 'Enter your name, up to 40 characters.' });
		const problem = passwordProblem(password);
		if (problem) return fail(400, { name, message: problem });

		// Claimed (locked and marked used) before any password is set, so a link
		// cancelled or used by someone else meanwhile changes nothing.
		const claimed = await dbCall<{ status: string; id?: string; email?: string }>('claim_host_invite', [hashToken(params.token)]);
		if (!claimed) error(500, 'Could not use the link');
		if (claimed.status !== 'ok' || !claimed.id || !claimed.email) {
			return fail(400, { name, message: REFUSED[claimed.status] ?? REFUSED.invalid });
		}

		const account = await setPassword(claimed.email, password);
		if ('error' in account) {
			// Nothing changed, so the link can be tried again.
			await dbCall('release_host_invite', [claimed.id]);
			const message = account.error === 'weak_password' ? 'Choose a stronger password.' : 'That didn’t work. Try again in a moment.';
			return fail(account.error === 'weak_password' ? 400 : 503, { name, message });
		}

		const finished = await dbCall<{ status: string; sessionsValidAfter?: number }>('finish_host_invite', [claimed.id, account.userId, name]);
		if (!finished) error(500, 'Could not use the link');
		if (finished.status !== 'ok') return fail(400, { name, message: REFUSED[finished.status] ?? REFUSED.invalid });

		startHostSession(cookies, account.userId, finished.sessionsValidAfter ?? 0);
		redirect(303, '/decks');
	},
};

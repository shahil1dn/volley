import { error, fail, redirect } from '@sveltejs/kit';
import { dbCall } from '$lib/server/db';
import { startHostSession } from '$lib/server/host-guard';
import { hashToken, passwordProblem, TOKEN_PATTERN } from '$lib/server/invite-token';
import { setPassword } from '$lib/server/invites';
import type { Actions, PageServerLoad } from './$types';

type Peek = { status: 'ok' | 'used' | 'expired' | 'invalid'; email?: string; name?: string; purpose?: 'invite' | 'reset' };

// The token is in the path, so keep it out of Referer headers and caches.
function keepPrivate(setHeaders: (headers: Record<string, string>) => void) {
	setHeaders({ 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' });
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

		const invite = await peek(params.token);
		if (invite.status !== 'ok' || !invite.email) return fail(400, { name, message: REFUSED[invite.status] ?? REFUSED.invalid });
		if (name.length < 1 || name.length > 40) return fail(400, { name, message: 'Enter your name, up to 40 characters.' });
		const problem = passwordProblem(password);
		if (problem) return fail(400, { name, message: problem });

		const account = await setPassword(invite.email, password);
		if ('error' in account) {
			const message = account.error === 'weak_password' ? 'Choose a stronger password.' : 'That didn’t work. Try again in a moment.';
			return fail(account.error === 'weak_password' ? 400 : 503, { name, message });
		}

		// Checks the link again, locked, and that the account is the invited one.
		const accepted = await dbCall<{ status: string }>('accept_host_invite', [hashToken(params.token), account.userId, name]);
		if (!accepted) error(500, 'Could not use the link');
		if (accepted.status !== 'ok') return fail(400, { name, message: REFUSED[accepted.status] ?? REFUSED.invalid });

		startHostSession(cookies, account.userId);
		redirect(303, '/decks');
	},
};

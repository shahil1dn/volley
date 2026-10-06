import { fail, redirect } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { HOST_SESSION_SECRET, SUPABASE_URL } from '$env/static/private';
import { PUBLIC_SUPABASE_PUBLISHABLE_KEY } from '$env/static/public';
import { dbCall } from '$lib/server/db';
import { hasHostSession, startHostSession } from '$lib/server/host-guard';
import { signInHost } from '$lib/server/host-signin';
import { hashEmail } from '$lib/server/host-session';
import { hashClientIp } from '$lib/server/participant-token';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ cookies }) => {
	if (hasHostSession(cookies)) redirect(303, '/decks');
};

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress }) => {
		const form = await request.formData();
		const email = String(form.get('email') ?? '').trim().toLowerCase();
		const password = String(form.get('password') ?? '');
		if (!email || !password) return fail(400, { email, message: 'Enter your email and password.' });

		// Counted before the password is checked, so guessing costs attempts.
		const allowed = await dbCall<boolean>('allow_sign_in', [
			hashClientIp(HOST_SESSION_SECRET, getClientAddress()),
			hashEmail(HOST_SESSION_SECRET, email),
		]).catch(() => null);
		if (allowed === null) return fail(503, { email, message: 'Sign-in is unavailable. Try again shortly.' });
		if (!allowed) return fail(429, { email, message: 'Too many attempts. Wait 15 minutes, then try again.' });

		// A throwaway client checks the password with Supabase Auth; the Supabase
		// session it gets back is revoked at once, and the host gets our own
		// httpOnly session instead (ADR-005).
		const auth = createClient(SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
			auth: { persistSession: false, autoRefreshToken: false },
		}).auth;
		const result = await signInHost(
			{
				now: () => Math.floor(Date.now() / 1000),
				findUserId: (address) => dbCall<string>('auth_user_id', [address]),
				readProfile: (userId) => dbCall<{ sessionsValidAfter: number }>('host_profile', [userId]),
				checkPassword: async (address, secret) => {
					const { data, error } = await auth.signInWithPassword({ email: address, password: secret });
					if (error?.code === 'invalid_credentials') return { status: 'wrong' };
					if (error || !data.user) return { status: 'unavailable' };
					await auth.signOut({ scope: 'local' });
					return { status: 'ok', userId: data.user.id };
				},
			},
			email,
			password,
		);
		if (result.status === 'wrong_password') return fail(400, { email, message: 'Email or password is incorrect.' });
		if (result.status === 'unavailable') return fail(503, { email, message: 'Sign-in is unavailable. Try again shortly.' });
		if (result.status === 'not_host') return fail(403, { email, message: "That account isn't a host on this Volley." });

		startHostSession(cookies, result.userId, 0, result.issuedAt);
		redirect(303, '/decks');
	},
};

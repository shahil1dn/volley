import { fail, redirect } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { HOST_SESSION_SECRET, SUPABASE_URL } from '$env/static/private';
import { PUBLIC_SUPABASE_PUBLISHABLE_KEY } from '$env/static/public';
import { db } from '$lib/server/db';
import { hasHostSession, startHostSession } from '$lib/server/host-guard';
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
		const { data: allowed, error: limitError } = await db.rpc('allow_sign_in', {
			p_ip_hash: hashClientIp(HOST_SESSION_SECRET, getClientAddress()),
			p_email_hash: hashEmail(HOST_SESSION_SECRET, email),
		});
		if (limitError) return fail(503, { email, message: 'Sign-in is unavailable. Try again shortly.' });
		if (!allowed) return fail(429, { email, message: 'Too many attempts. Wait 15 minutes, then try again.' });

		// A throwaway client checks the password with Supabase Auth; the Supabase
		// session it gets back is revoked at once, and the host gets our own
		// httpOnly session instead (ADR-005).
		const auth = createClient(SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
			auth: { persistSession: false, autoRefreshToken: false },
		}).auth;
		const { data, error } = await auth.signInWithPassword({ email, password });
		if (error?.code === 'invalid_credentials') return fail(400, { email, message: 'Email or password is incorrect.' });
		if (error || !data.user) return fail(503, { email, message: 'Sign-in is unavailable. Try again shortly.' });
		await auth.signOut({ scope: 'local' });

		const { data: host, error: hostError } = await db.from('hosts').select('user_id').eq('user_id', data.user.id).maybeSingle();
		if (hostError) return fail(503, { email, message: 'Sign-in is unavailable. Try again shortly.' });
		if (!host) return fail(403, { email, message: "That account isn't a host on this Volley." });

		startHostSession(cookies, data.user.id);
		redirect(303, '/decks');
	},
};

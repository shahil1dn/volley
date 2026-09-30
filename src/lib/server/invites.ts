import { createClient } from '@supabase/supabase-js';
import { SUPABASE_SECRET_KEY, SUPABASE_URL } from '$env/static/private';
import { dbCall } from '$lib/server/db';

// Supabase Auth's admin API, with the secret key. Server-only ($lib/server).
function authAdmin() {
	return createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
		auth: { persistSession: false, autoRefreshToken: false },
	}).auth.admin;
}

// Sets the password on the Auth account for this email, creating the account
// (already confirmed, so no email is sent) if there isn't one. Returns its id.
export async function setPassword(email: string, password: string): Promise<{ userId: string } | { error: string }> {
	const admin = authAdmin();
	const existing = await dbCall<string>('auth_user_id', [email]);
	if (existing) {
		const { error } = await admin.updateUserById(existing, { password, email_confirm: true });
		return error ? { error: error.code ?? error.message } : { userId: existing };
	}
	const { data, error } = await admin.createUser({ email, password, email_confirm: true });
	return error || !data.user ? { error: error?.code ?? 'unknown' } : { userId: data.user.id };
}

// Best effort after remove_host has already taken hosting away: an Auth
// account left behind can sign in to nothing.
export async function deleteAccount(userId: string): Promise<void> {
	const { error } = await authAdmin().deleteUser(userId);
	if (error) console.error('Could not delete a removed host’s Auth account:', error.message);
}

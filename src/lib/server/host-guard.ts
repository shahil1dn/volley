import type { Cookies } from '@sveltejs/kit';
import { HOST_SESSION_SECRET } from '$env/static/private';
import { db } from '$lib/server/db';
import { HOST_SESSION_SECONDS, makeHostSession, readHostSession } from '$lib/server/host-session';

const COOKIE = 'volley_host';

export type Host = { userId: string; email: string };

const nowSeconds = () => Math.floor(Date.now() / 1000);

// A valid session only proves the password was checked; being a host means a
// row in `hosts`, checked on every request so a removed host is out at once.
export async function currentHost(cookies: Cookies): Promise<Host | 'signed_out' | 'not_host'> {
	const userId = readHostSession(HOST_SESSION_SECRET, cookies.get(COOKIE), nowSeconds());
	if (!userId) return 'signed_out';
	const { data: host, error } = await db.from('hosts').select('email').eq('user_id', userId).maybeSingle();
	if (error) throw new Error('Could not check the host list');
	return host ? { userId, email: host.email } : 'not_host';
}

// Path '/' because host pages and APIs are spread across the app (SPEC routes).
// httpOnly keeps it out of page scripts (A7); `secure` is SvelteKit's default,
// on everywhere except http://localhost.
export function startHostSession(cookies: Cookies, userId: string) {
	cookies.set(COOKIE, makeHostSession(HOST_SESSION_SECRET, userId, nowSeconds()), {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: HOST_SESSION_SECONDS,
	});
}

export function hasHostSession(cookies: Cookies): boolean {
	return readHostSession(HOST_SESSION_SECRET, cookies.get(COOKIE), nowSeconds()) !== null;
}

export function endHostSession(cookies: Cookies) {
	cookies.delete(COOKIE, { path: '/' });
}

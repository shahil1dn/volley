import type { Cookies } from '@sveltejs/kit';
import { HOST_SESSION_SECRET } from '$env/static/private';
import { dbCall } from '$lib/server/db';
import { HOST_SESSION_SECONDS, hostSessionIssuedAt, makeHostSession, readHostSession } from '$lib/server/host-session';

const COOKIE = 'volley_host';

export type Host = { userId: string; email: string; name: string | null; isAdmin: boolean };

const nowSeconds = () => Math.floor(Date.now() / 1000);

// A valid session only proves the password was checked; being a host means a
// row in `hosts`, checked on every request so a removed host is out at once.
export async function currentHost(cookies: Cookies): Promise<Host | 'signed_out' | 'not_host'> {
	const token = cookies.get(COOKIE);
	const userId = readHostSession(HOST_SESSION_SECRET, token, nowSeconds());
	if (!token || !userId) return 'signed_out';
	const profile = await dbCall<Omit<Host, 'userId'> & { sessionsValidAfter: number }>('host_profile', [userId]);
	if (!profile) return 'not_host';
	// A password reset ends every session issued before it (ADR-011).
	if (hostSessionIssuedAt(token) < profile.sessionsValidAfter) return 'signed_out';
	const { sessionsValidAfter: _, ...host } = profile;
	return { userId, ...host };
}

// Path '/' because host pages and APIs are spread across the app (SPEC routes).
// httpOnly keeps it out of page scripts (A7); `secure` is SvelteKit's default,
// on everywhere except http://localhost.
// `issuedAt` (unix seconds) is when the session counts as issued: callers pass
// sessionIssuedAt(...), so it is never older than the host's last reset.
export function startHostSession(cookies: Cookies, userId: string, issuedAt: number) {
	cookies.set(COOKIE, makeHostSession(HOST_SESSION_SECRET, userId, issuedAt), {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: HOST_SESSION_SECONDS,
	});
}

export function hasHostSession(cookies: Cookies): boolean {
	return readHostSession(HOST_SESSION_SECRET, cookies.get(COOKIE), nowSeconds()) !== null;
}

// For a response the guard builds itself, which SvelteKit's cookies don't reach.
// A signed-out visitor's cookie must go: the sign-in page only checks the
// cookie's signature, so a revoked one would bounce the browser straight back.
export function clearedHostCookie(cookies: Cookies): string {
	return cookies.serialize(COOKIE, '', { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 0 });
}

export function endHostSession(cookies: Cookies) {
	cookies.delete(COOKIE, { path: '/' });
}

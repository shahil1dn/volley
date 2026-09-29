import { createHmac, timingSafeEqual } from 'node:crypto';

// A signed-in host's session: `<user id>.<expiry, unix seconds>.<signature>`,
// held in an httpOnly cookie (ADR-005). It proves the password was checked and
// when it runs out. Whether the account is still a host is checked against
// `hosts` on every request, so removing a host takes effect at once.

export const HOST_SESSION_SECONDS = 12 * 60 * 60;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sign(secret: string, message: string): Buffer {
	return createHmac('sha256', secret).update(message).digest();
}

export function makeHostSession(secret: string, userId: string, nowSeconds: number): string {
	const expires = nowSeconds + HOST_SESSION_SECONDS;
	return `${userId}.${expires}.${sign(secret, `host:${userId}:${expires}`).toString('base64url')}`;
}

// The user id, or null for anything expired, forged, tampered with or malformed.
export function readHostSession(secret: string, token: string | undefined, nowSeconds: number): string | null {
	const [userId, expiresText, signature, ...rest] = (token ?? '').split('.');
	if (rest.length > 0 || !UUID_PATTERN.test(userId) || !/^\d{1,12}$/.test(expiresText ?? '') || !signature) return null;
	if (Number(expiresText) <= nowSeconds) return null;
	const expected = sign(secret, `host:${userId}:${expiresText}`);
	const given = Buffer.from(signature, 'base64url');
	return given.length === expected.length && timingSafeEqual(given, expected) ? userId : null;
}

// Sign-in attempts are counted per email without storing the address itself.
export function hashEmail(secret: string, email: string): string {
	return sign(secret, `email:${email.trim().toLowerCase()}`).toString('base64url');
}

// Which requests need a host. Pages send a signed-out visitor to sign in; APIs
// answer 401. Anything added under these paths is guarded automatically, and
// future host APIs belong under /api/host or /api/r/[code]/host.
export function hostArea(pathname: string): 'page' | 'api' | null {
	if (pathname === '/decks' || pathname.startsWith('/decks/')) return 'page';
	if (/^\/run\/[^/]+\/control(\/|$)/.test(pathname)) return 'page';
	if (pathname === '/api/host' || pathname.startsWith('/api/host/')) return 'api';
	if (/^\/api\/r\/[^/]+\/host(\/|$)/.test(pathname)) return 'api';
	return null;
}

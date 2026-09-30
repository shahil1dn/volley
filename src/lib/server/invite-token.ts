import { createHash, randomBytes } from 'node:crypto';

// Invite links (ADR-011): `/invite/<token>`. The token is 32 random bytes and
// only its SHA-256 is stored, so the database alone can't be used to accept.
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('base64url');
}

export function newToken(): { token: string; hash: string } {
	const token = randomBytes(32).toString('base64url');
	return { token, hash: hashToken(token) };
}

// Long enough that the sign-in limits make guessing hopeless; bcrypt, which
// Supabase uses, ignores anything past 72 bytes.
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 72;

export function passwordProblem(password: string): string | null {
	if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
	if (Buffer.byteLength(password) > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
	return null;
}

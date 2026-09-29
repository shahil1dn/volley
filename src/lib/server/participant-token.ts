import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

// A phone's identity in one room: `<participant id>.<signature>`. The signature
// covers the room code too, so a token from one room is worthless in another.
// No accounts and nothing personal: the id is random and lives only in the
// phone's cookie (SPEC 10–11).

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Each use of the secret signs a differently-prefixed message, so a token
// signature can never double as an IP hash, or the other way round.
function sign(secret: string, message: string): Buffer {
	return createHmac('sha256', secret).update(message).digest();
}

export function makeParticipantToken(secret: string, code: string, participantId: string = randomUUID()): string {
	return `${participantId}.${sign(secret, `participant:${code}:${participantId}`).toString('base64url')}`;
}

// The participant id, or null for anything forged, tampered with, from another
// room or malformed.
export function readParticipantToken(secret: string, code: string, token: string | undefined): string | null {
	const [participantId, signature, ...rest] = (token ?? '').split('.');
	if (rest.length > 0 || !UUID_PATTERN.test(participantId) || !signature) return null;
	const expected = sign(secret, `participant:${code}:${participantId}`);
	const given = Buffer.from(signature, 'base64url');
	// Constant-time, so response timing reveals nothing about the right signature.
	return given.length === expected.length && timingSafeEqual(given, expected) ? participantId : null;
}

// Keyed rather than a bare hash: there are only ~4 billion IPv4 addresses, so a
// plain SHA-256 of one could be reversed by trying them all.
export function hashClientIp(secret: string, ip: string): string {
	return sign(secret, `ip:${ip}`).toString('base64url');
}

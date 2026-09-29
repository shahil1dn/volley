import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

// No 0/O or 1/I, which get misread off a projector.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_PATTERN = /^[A-Z0-9]{5}$/;

export function makeJoinCode(): string {
  return Array.from({ length: 5 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
}

// The host keeps the token; the database keeps only its hash.
export function makeHostToken(): string {
  return randomBytes(24).toString('base64url');
}

export function hashHostToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Constant-time, so response timing reveals nothing about the stored hash.
export function hostTokenMatches(token: string, storedHash: string): boolean {
  const given = Buffer.from(hashHostToken(token), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return given.length === stored.length && timingSafeEqual(given, stored);
}

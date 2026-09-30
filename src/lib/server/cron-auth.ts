import { createHash, timingSafeEqual } from 'node:crypto';

// Vercel sends `Authorization: Bearer <CRON_SECRET>` on every cron call.
// Hashing both sides gives equal lengths, so the comparison takes the same time
// however much of a guess is right. An unset or short secret refuses
// everything, so a missing env var can't open the route.
export function cronAuthorised(header: string | null, secret: string | undefined): boolean {
	if (!header || !secret || secret.length < 16) return false;
	const digest = (text: string) => createHash('sha256').update(text).digest();
	return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

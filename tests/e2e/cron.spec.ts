// Going live: the keep-alive route answers only a call carrying CRON_SECRET.
import { expect, test } from '@playwright/test';

const ROUTE = '/api/cron/keep-alive';

test('keep-alive refuses no secret and a wrong one, and runs its query with the right one', async ({ request }) => {
	const secret = process.env.CRON_SECRET ?? '';
	expect(secret.length, 'CRON_SECRET is in .env.local').toBeGreaterThanOrEqual(16);

	const none = await request.get(ROUTE);
	expect(none.status()).toBe(401);
	const wrong = await request.get(ROUTE, { headers: { authorization: `Bearer ${secret}-wrong` } });
	expect(wrong.status()).toBe(401);

	const right = await request.get(ROUTE, { headers: { authorization: `Bearer ${secret}` } });
	expect(right.status()).toBe(200);
	expect(await right.json()).toEqual({ status: 'ok' });
	expect(right.headers()['cache-control']).toBe('no-store');
});

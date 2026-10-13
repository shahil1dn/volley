// The thank-you slide's QR code: made from the brand link, with the address shown under it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thanksQr } from '../src/lib/server/thanks-qr.ts';

test('a link becomes a QR code and a short address under it', async () => {
	const qr = await thanksQr('https://example.org/');
	assert.ok(qr);
	assert.match(qr.svg, /^<svg[\s\S]*<path[\s\S]*<\/svg>\s*$/);
	assert.equal(qr.address, 'example.org');
	assert.equal(qr.link, 'https://example.org/');
	assert.equal((await thanksQr('https://example.org/events'))?.address, 'example.org/events');
});

test('no link, no QR code; a link that fails the check is refused, not drawn', async () => {
	assert.equal(await thanksQr(null), null);
	await assert.rejects(() => thanksQr('http://example.org'), /brand\.thankYou\.link/);
});

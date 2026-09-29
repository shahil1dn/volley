import { error } from '@sveltejs/kit';
import QRCode from 'qrcode';
import { CODE_PATTERN } from '$lib/server/host-token';
import type { PageServerLoad } from './$types';

// Public on purpose: the projector shows only the shared state any phone can
// already read, and guarding it would make hosts type their password on
// shared lecture-theatre PCs. The control view is the guarded one.
export const load: PageServerLoad = async ({ params, url }) => {
	if (!CODE_PATTERN.test(params.code)) error(404, 'No such room');
	const joinUrl = `${url.origin}/j/${params.code}`;
	// The code is checked above and the URL is ours, so the SVG is safe to inline.
	const qrSvg = await QRCode.toString(joinUrl, { type: 'svg', margin: 1, color: { dark: '#1e1622', light: '#ffffff' } });
	return { code: params.code, joinUrl, qrSvg };
};

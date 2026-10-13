// The thank-you slide's QR code and the address printed under it, from the copy's
// brand link (checked by thankYouLink), or null when the copy has no link.
import QRCode from 'qrcode';
import { thankYouLink } from '../theme.ts';

export async function thanksQr(link: string | null): Promise<{ svg: string; address: string; link: string } | null> {
	const checked = thankYouLink(link);
	if (checked === null) return null;
	const svg = await QRCode.toString(checked, { type: 'svg', margin: 1, color: { dark: '#1e1622', light: '#ffffff' } });
	return { svg, address: checked.replace(/^https:\/\//, '').replace(/\/$/, ''), link: checked };
}

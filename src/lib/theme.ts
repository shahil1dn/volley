// Turns the three brand colours into every colour the stylesheet uses, and
// measures the pairs that must stay readable (WCAG 2.2 AA).
import type { Brand } from './brand.ts';

// Not a brand colour: an error should look like an error on any copy. A dark red
// can't be read on a dark page, so a copy with dark paper gets a light red instead.
const ERROR = '#9b1c1c';
const ERROR_ON_DARK = '#ff9e9e';

export type Palette = {
	accent: string;
	onAccent: string;
	ink: string;
	muted: string;
	border: string;
	line: string;
	surface: string;
	paper: string;
	error: string;
};

type Rgb = [number, number, number];

function parseHex(hex: string, name: string): Rgb {
	if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`brand.colours.${name} must be a six-digit hex colour like #0e6f64, not "${hex}"`);
	return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

function toHex(rgb: Rgb): string {
	return `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
}

// The same arithmetic as CSS `color-mix(in srgb, a share%, b)`.
function mix(a: Rgb, b: Rgb, share: number): string {
	return toHex([0, 1, 2].map((i) => a[i] * share + b[i] * (1 - share)) as Rgb);
}

function luminance(hex: string): number {
	const [r, g, b] = parseHex(hex, 'value').map((channel) => {
		const c = channel / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
	const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (light + 0.05) / (dark + 0.05);
}

export function palette(colours: Brand['colours']): Palette {
	const ink = parseHex(colours.ink, 'ink');
	const paper = parseHex(colours.paper, 'paper');
	parseHex(colours.accent, 'accent');
	// Button text takes whichever of ink or paper reads better on the accent.
	const onAccent = contrast(colours.paper, colours.accent) >= contrast(colours.ink, colours.accent) ? colours.paper : colours.ink;
	return {
		accent: colours.accent,
		onAccent,
		ink: colours.ink,
		muted: mix(ink, paper, 0.72),
		border: mix(ink, paper, 0.5),
		line: mix(ink, paper, 0.14),
		surface: mix(ink, paper, 0.06),
		paper: colours.paper,
		error: contrast(ERROR, colours.paper) >= 4.5 ? ERROR : ERROR_ON_DARK,
	};
}

// Each pair the screens rely on, with the ratio it needs: 4.5 for text, 3 for
// input borders, focus rings and the accent on the projector (SC 1.4.3, 1.4.11).
export function contrastChecks(p: Palette): { pair: string; ratio: number; needs: number }[] {
	return [
		{ pair: 'ink on paper', ratio: contrast(p.ink, p.paper), needs: 4.5 },
		{ pair: 'muted on paper', ratio: contrast(p.muted, p.paper), needs: 4.5 },
		{ pair: 'muted on surface', ratio: contrast(p.muted, p.surface), needs: 4.5 },
		{ pair: 'button text on accent', ratio: contrast(p.onAccent, p.accent), needs: 4.5 },
		{ pair: 'accent on paper', ratio: contrast(p.accent, p.paper), needs: 4.5 },
		{ pair: 'error on paper', ratio: contrast(p.error, p.paper), needs: 4.5 },
		{ pair: 'border on paper', ratio: contrast(p.border, p.paper), needs: 3 },
	];
}

export function themeCss(p: Palette): string {
	const vars = Object.entries(p).map(([name, value]) => `--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${value}`);
	// The browser draws its own controls (radio buttons, scrollbars) light unless told the page is dark.
	const scheme = luminance(p.paper) < luminance(p.ink) ? 'dark' : 'light';
	return `:root{${vars.join(';')};color-scheme:${scheme}}`;
}

// This CSS goes into the page through {@html}, so every value must be unable to end
// the rule or the <style> element it sits in.
const FONT_LIST = /^[A-Za-z0-9 "',-]+$/;
const FAMILY = /^[A-Za-z0-9 -]+$/;
const FONT_FILE = /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(woff2|woff|otf|ttf)$/;
const FORMAT: Record<string, string> = { woff2: 'woff2', woff: 'woff', otf: 'opentype', ttf: 'truetype' };

// The thank-you link goes into a QR code the audience is asked to scan, built on every
// projector load: an https address only, no login in it, and short enough to encode.
export function thankYouLink(link: string | null): string | null {
	if (link === null) return null;
	let url: URL;
	try {
		url = new URL(link);
	} catch {
		throw new Error('brand.thankYou.link must be a web address starting with https://');
	}
	if (url.protocol !== 'https:') throw new Error('brand.thankYou.link must start with https://');
	if (url.username || url.password) throw new Error('brand.thankYou.link must not carry a login');
	if (link.length > 500) throw new Error('brand.thankYou.link must be 500 characters or fewer to fit in a QR code');
	return link;
}

// A thank-you picture is an image in static/; the path goes into a CSS url(), so it can't
// carry anything that would end it.
const PICTURE_FILE = /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(webp|avif|jpg|jpeg|png)$/;
type ThankYouBackground = { phone: string; projector: string };

// Both pictures or none: a phone and a projector showing different looks would be a mistake.
export function thankYouBackground(background: ThankYouBackground | null | undefined): ThankYouBackground | null {
	if (background === null || background === undefined) return null;
	if (typeof background.phone !== 'string' || typeof background.projector !== 'string') {
		throw new Error('brand.thankYou.background must set both pictures, phone and projector, or be null');
	}
	for (const which of ['phone', 'projector'] as const) {
		if (!PICTURE_FILE.test(background[which]) || background[which].includes('..')) {
			throw new Error(`brand.thankYou.background.${which} must be a .webp, .avif, .jpg or .png path in static/, starting with /`);
		}
	}
	return background;
}

// The pictures and the shade laid over them, as custom properties: nothing is fetched until
// the thank-you slide draws its backdrop. The shade is the paper colour, so the words, in ink,
// read on it as they do on the paper.
export function thanksBackdropCss(background: ThankYouBackground | null | undefined, p: Palette): string {
	const checked = thankYouBackground(background);
	if (checked === null) return '';
	const shade = parseHex(p.paper, 'paper').join(' ');
	return `:root{--thanks-phone:url("${checked.phone}");--thanks-projector:url("${checked.projector}");--thanks-shade:${shade}}`;
}

// The stylesheet sizes logos for 32px; a copy's height scales every size by the same ratio.
export function logoCss(height: number): string {
	if (!Number.isInteger(height) || height < 16 || height > 96) throw new Error('brand.logoHeight must be a whole number of px from 16 to 96');
	return `:root{--logo-scale:${height / 32}}`;
}

export function fontCss(fonts: Brand['fonts']): string {
	for (const name of ['body', 'display'] as const) {
		if (!FONT_LIST.test(fonts[name])) throw new Error(`brand.fonts.${name} must be a font-family list of letters, digits, spaces, quotes, commas and hyphens`);
	}
	if (!Number.isInteger(fonts.displayWeight) || fonts.displayWeight < 100 || fonts.displayWeight > 900) {
		throw new Error('brand.fonts.displayWeight must be a whole number from 100 to 900');
	}
	const faces = fonts.files.map(({ family, src, weight }, i) => {
		if (!FAMILY.test(family)) throw new Error(`brand.fonts.files[${i}].family must be letters, digits, spaces and hyphens`);
		const file = FONT_FILE.exec(src);
		if (!file) throw new Error(`brand.fonts.files[${i}].src must be a .woff2, .woff, .otf or .ttf path in static/, starting with /`);
		if (weight !== undefined && (!Number.isInteger(weight) || weight < 100 || weight > 900)) {
			throw new Error(`brand.fonts.files[${i}].weight must be a whole number from 100 to 900`);
		}
		return `@font-face{font-family:"${family}";src:url("${src}") format("${FORMAT[file[1]]}");${weight ? `font-weight:${weight};` : ''}font-display:swap}`;
	});
	return `${faces.join('')}:root{--font:${fonts.body};--font-display:${fonts.display};--display-weight:${fonts.displayWeight}}`;
}

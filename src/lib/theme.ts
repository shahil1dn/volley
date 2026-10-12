// Turns the three brand colours into every colour the stylesheet uses, and
// measures the pairs that must stay readable (WCAG 2.2 AA).
import type { Brand } from './brand.ts';

// Not a brand colour: an error should look like an error on any copy.
const ERROR = '#9b1c1c';

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
		error: ERROR,
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
	return `:root{${vars.join(';')}}`;
}

// This CSS goes into the page through {@html}, so every value must be unable to end
// the rule or the <style> element it sits in.
const FONT_LIST = /^[A-Za-z0-9 "',-]+$/;
const FAMILY = /^[A-Za-z0-9 -]+$/;
const FONT_FILE = /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(woff2|woff|otf|ttf)$/;
const FORMAT: Record<string, string> = { woff2: 'woff2', woff: 'woff', otf: 'opentype', ttf: 'truetype' };

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

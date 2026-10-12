// Milestone 4: a copy's name, colours and logo live in src/lib/brand.ts alone
// (SPEC 26, A16), and whatever colours it sets stay readable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { brand } from '../src/lib/brand.ts';
import { contrast, contrastChecks, fontCss, logoCss, palette, themeCss } from '../src/lib/theme.ts';

const SETTINGS = join('src', 'lib', 'brand.ts');

test('A16: "AI Builders" appears nowhere in src/ outside the brand settings', async () => {
	const files = (await readdir('src', { recursive: true, withFileTypes: true }))
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name))
		.filter((path) => path !== SETTINGS);
	assert.ok(files.length > 20, `expected to scan the whole of src/, found ${files.length} files`);
	const offenders = [];
	for (const path of files) if (/ai\s*builders/i.test(await readFile(path, 'utf8'))) offenders.push(path);
	assert.deepEqual(offenders, [], 'move the name into src/lib/brand.ts');
});

test("the brand's colours pass WCAG AA for every pair the screens use", () => {
	for (const { pair, ratio, needs } of contrastChecks(palette(brand.colours))) {
		assert.ok(ratio >= needs, `${pair} is ${ratio.toFixed(2)}:1, needs ${needs}:1. Change brand.colours in src/lib/brand.ts.`);
	}
});

test('contrast matches the WCAG formula at its known points', () => {
	assert.equal(contrast('#000000', '#ffffff'), 21);
	assert.equal(contrast('#777777', '#777777'), 1);
	assert.equal(contrast('#767676', '#ffffff').toFixed(2), '4.54');
});

test('a colour that fails is caught, and button text flips to stay readable', () => {
	const pale = palette({ accent: '#f5c518', ink: '#17191c', paper: '#ffffff' });
	assert.equal(pale.onAccent, '#17191c', 'dark text on a pale accent');
	const failing = contrastChecks(pale).filter(({ ratio, needs }) => ratio < needs).map(({ pair }) => pair);
	assert.deepEqual(failing, ['accent on paper']);
	assert.equal(palette(brand.colours).onAccent, brand.colours.paper);
});

test('palette mixes greys from ink and paper, and refuses a colour that is not six-digit hex', () => {
	const p = palette({ accent: '#0e6f64', ink: '#000000', paper: '#ffffff' });
	assert.equal(p.muted, '#474747');
	assert.equal(p.border, '#808080');
	assert.throws(() => palette({ accent: 'teal', ink: '#000000', paper: '#ffffff' }), /brand\.colours\.accent must be a six-digit hex colour/);
	assert.throws(() => palette({ accent: '#000000', ink: '#000', paper: '#ffffff' }), /brand\.colours\.ink/);
	assert.throws(() => palette({ accent: '#000000', ink: '#000000', paper: '#fff;}body{' }), /brand\.colours\.paper/);
});

test('themeCss writes each colour as a custom property on :root', () => {
	const css = themeCss(palette(brand.colours));
	assert.match(css, /^:root\{.*\}$/);
	assert.ok(css.includes(`--accent:${brand.colours.accent}`));
	assert.ok(css.includes('--on-accent:'));
});

const SYSTEM = { body: 'system-ui, sans-serif', display: 'system-ui, sans-serif', displayWeight: 700, files: [] };

test('fontCss sets the body and heading fonts on :root, and loads nothing when there are no files', () => {
	const css = fontCss(SYSTEM);
	assert.equal(css, ':root{--font:system-ui, sans-serif;--font-display:system-ui, sans-serif;--display-weight:700}');
	assert.doesNotMatch(css, /@font-face/);
});

test('fontCss loads each file with the format its extension names, and its weight', () => {
	const css = fontCss({
		body: '"Body Sans", Arial, sans-serif',
		display: '"Show", Georgia, serif',
		displayWeight: 400,
		files: [
			{ family: 'Body Sans', src: '/fonts/body-500.woff2', weight: 500 },
			{ family: 'Show', src: '/fonts/show.otf' },
		],
	});
	assert.ok(css.includes('@font-face{font-family:"Body Sans";src:url("/fonts/body-500.woff2") format("woff2");font-weight:500;font-display:swap}'));
	assert.ok(css.includes('@font-face{font-family:"Show";src:url("/fonts/show.otf") format("opentype");font-display:swap}'));
	assert.ok(css.endsWith(':root{--font:"Body Sans", Arial, sans-serif;--font-display:"Show", Georgia, serif;--display-weight:400}'));
});

test('fontCss refuses anything that could end the rule or the <style> it is written into', () => {
	const bad: [string, object, RegExp][] = [
		['body', { body: 'x;}body{color:red' }, /brand\.fonts\.body/],
		['display', { display: 'x</style><script>' }, /brand\.fonts\.display/],
		['weight', { displayWeight: 750.5 }, /displayWeight/],
		['weight range', { displayWeight: 1000 }, /displayWeight/],
		['family', { files: [{ family: 'X"}', src: '/f.woff2' }] }, /files\[0\]\.family/],
		['src outside static', { files: [{ family: 'X', src: 'https://evil.example/f.woff2' }] }, /files\[0\]\.src/],
		['src climbing', { files: [{ family: 'X', src: '/fonts/../../f.woff2' }] }, /files\[0\]\.src/],
		['src quote', { files: [{ family: 'X', src: '/f").woff2' }] }, /files\[0\]\.src/],
		['src type', { files: [{ family: 'X', src: '/f.svg' }] }, /files\[0\]\.src/],
		['file weight', { files: [{ family: 'X', src: '/f.woff2', weight: 50 }] }, /files\[0\]\.weight/],
	];
	for (const [why, change, message] of bad) assert.throws(() => fontCss({ ...SYSTEM, ...change }), message, why);
});

test("this copy's own fonts pass the same checks", () => {
	assert.doesNotThrow(() => fontCss(brand.fonts));
});

test('logoCss scales logos from the 32px they are drawn at, and refuses a height outside 16 to 96', () => {
	assert.equal(logoCss(32), ':root{--logo-scale:1}');
	assert.equal(logoCss(48), ':root{--logo-scale:1.5}');
	assert.equal(logoCss(16), ':root{--logo-scale:0.5}');
	assert.equal(logoCss(96), ':root{--logo-scale:3}');
	for (const bad of [15, 97, 40.5, Number.NaN]) assert.throws(() => logoCss(bad), /brand\.logoHeight/, String(bad));
	assert.doesNotThrow(() => logoCss(brand.logoHeight));
});

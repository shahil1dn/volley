// Milestone 4: a copy's name, colours and logo live in src/lib/brand.ts alone
// (SPEC 26, A16), and whatever colours it sets stay readable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { brand } from '../src/lib/brand.ts';
import { contrast, contrastChecks, palette, themeCss } from '../src/lib/theme.ts';

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

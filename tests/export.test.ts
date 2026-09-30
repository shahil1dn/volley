// S8 exports: the results CSV's escaping and the PNG's word layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, resultsCsv } from '../src/lib/server/results-csv.ts';
import { layoutCloud } from '../src/lib/cloud-png.ts';

test('csvCell quotes commas, quotes and line breaks, and defuses formulas', () => {
	assert.equal(csvCell('plain'), 'plain');
	assert.equal(csvCell(3), '3');
	assert.equal(csvCell('a, b'), '"a, b"');
	assert.equal(csvCell('say "hi"'), '"say ""hi"""');
	assert.equal(csvCell('two\nlines'), '"two\nlines"');
	for (const start of ['=', '+', '-', '@', '\t', '\r']) {
		assert.ok(csvCell(`${start}1+1`).replace(/^"/, '').startsWith(`'${start}`), JSON.stringify(start));
	}
	assert.equal(csvCell('=hyperlink("x")'), `"'=hyperlink(""x"")"`);
});

test('resultsCsv: one row per answer per activity, BOM first, CRLF lines', () => {
	const csv = resultsCsv({
		code: 'ABCDE',
		items: [
			{ position: 0, type: 'word_cloud', prompt: 'One word, please?', tallies: [['beta', 2, false], ['rude', 1, true]] },
			{ position: 1, type: 'word_cloud', prompt: null, tallies: [] },
			{ position: 2, type: 'word_cloud', prompt: 'Last', tallies: [['z', 4, false]] },
		],
	});
	assert.equal(
		csv,
		'\uFEFFActivity,Type,Question,Answer,Count,Hidden\r\n' +
			'1,word_cloud,"One word, please?",beta,2,no\r\n' +
			'1,word_cloud,"One word, please?",rude,1,yes\r\n' +
			'3,word_cloud,Last,z,4,no\r\n',
	);
});

// Each character half its type size wide: close enough to test placement.
const measure = (text: string, px: number) => text.length * px * 0.5;
const BOX = { left: 64, top: 200, width: 1472, height: 636 };

test('layoutCloud places every word once, inside the box, biggest flagged', () => {
	const words: [string, number][] = [['robots', 5], ['ethics', 3], ['python', 3], ['data', 1]];
	const placed = layoutCloud(words, BOX, measure);
	assert.deepEqual(placed.map((w) => w.text).sort(), ['data', 'ethics', 'python', 'robots']);
	assert.deepEqual(placed.filter((w) => w.top).map((w) => w.text), ['robots']);
	for (const word of placed) {
		assert.ok(word.x >= BOX.left && word.x + measure(word.text, word.px) <= BOX.left + BOX.width + 0.001, `${word.text} x`);
		assert.ok(word.y - word.px / 2 >= BOX.top - 0.001 && word.y + word.px / 2 <= BOX.top + BOX.height + 0.001, `${word.text} y`);
	}
	assert.ok(placed.find((w) => w.text === 'robots')!.px > placed.find((w) => w.text === 'data')!.px);
});

test('layoutCloud shrinks a crowded cloud to fit, and returns nothing for no words', () => {
	const many: [string, number][] = Array.from({ length: 300 }, (_, i) => [`word number ${i}`, 300 - i]);
	const placed = layoutCloud(many, BOX, measure);
	assert.equal(placed.length, 300);
	const bottom = Math.max(...placed.map((w) => w.y + w.px / 2));
	assert.ok(bottom <= BOX.top + BOX.height + 0.001, `bottom ${bottom}`);
	assert.deepEqual(layoutCloud([], BOX, measure), []);
});

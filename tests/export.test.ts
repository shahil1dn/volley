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

test('resultsCsv: one row per answer or question per activity, BOM first, CRLF lines', () => {
	const csv = resultsCsv({
		code: 'ABCDE',
		items: [
			{ position: 0, type: 'word_cloud', prompt: 'One word, please?', tallies: [['beta', 2, false], ['rude', 1, true]], questions: [] },
			{ position: 1, type: 'word_cloud', prompt: null, tallies: [], questions: [] },
			{ position: 2, type: 'word_cloud', prompt: 'Last', tallies: [['z', 4, false]], questions: [] },
			{ position: 3, type: 'qna', prompt: 'Ask', tallies: [], questions: [['Why?', 3, false, true], ['Rude', 0, true, false]] },
		],
	});
	assert.equal(
		csv,
		'\uFEFFActivity,Type,Question,Answer,Count,Hidden,Answered\r\n' +
			'1,word_cloud,"One word, please?",beta,2,no,\r\n' +
			'1,word_cloud,"One word, please?",rude,1,yes,\r\n' +
			'3,word_cloud,Last,z,4,no,\r\n' +
			'4,qna,Ask,Why?,3,no,yes\r\n' +
			'4,qna,Ask,Rude,0,yes,no\r\n',
	);
});

test("resultsCsv: a feedback form's rows are the forms sent, then each point of each question's scale and its average", () => {
	const csv = resultsCsv({
		code: 'ABCDE',
		items: [
			{
				position: 0,
				type: 'feedback',
				prompt: 'Rate us',
				form: [{ text: 'The talk', scale: 'stars' }, { text: '=Room', scale: 'words' }],
				tallies: [['n', 2, false], ['0:5', 1, false], ['0:4', 1, false], ['1:2', 2, false]],
				questions: [],
			},
		],
	});
	assert.equal(
		csv,
		'\uFEFFActivity,Type,Question,Answer,Count,Hidden,Answered\r\n' +
			'1,feedback,Rate us,Forms sent,2,,\r\n' +
			'1,feedback,The talk,1 star,0,,\r\n' +
			'1,feedback,The talk,2 stars,0,,\r\n' +
			'1,feedback,The talk,3 stars,0,,\r\n' +
			'1,feedback,The talk,4 stars,1,,\r\n' +
			'1,feedback,The talk,5 stars,1,,\r\n' +
			'1,feedback,The talk,Average,4.5,,\r\n' +
			// A question typed like a formula reaches the spreadsheet as text.
			"1,feedback,'=Room,Very bad,0,,\r\n" +
			"1,feedback,'=Room,Bad,2,,\r\n" +
			"1,feedback,'=Room,Okay,0,,\r\n" +
			"1,feedback,'=Room,Good,0,,\r\n" +
			"1,feedback,'=Room,Very good,0,,\r\n" +
			"1,feedback,'=Room,Average,2.0,,\r\n",
	);
	// No raw tally key ("0:5") ever reaches the file.
	assert.doesNotMatch(csv, /\d:\d/);
});

test('resultsCsv: a feedback form nobody answered still lists every point, with no average', () => {
	const csv = resultsCsv({ code: 'ABCDE', items: [{ position: 2, type: 'feedback', prompt: 'Rate', form: [{ text: 'Q', scale: 'ten' }], tallies: [], questions: [] }] });
	const lines = csv.trim().split('\r\n');
	assert.equal(lines[1], '3,feedback,Rate,Forms sent,0,,');
	assert.equal(lines.length, 1 + 1 + 10 + 1);
	assert.equal(lines.at(-1), '3,feedback,Q,Average,,,');
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

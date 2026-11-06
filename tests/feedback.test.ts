// A feedback form's results (ADR-018, A28): each question's counts and its
// average to one decimal, checked against numbers worked out by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedbackResults, formatAverage, formPages, formQuestions, ratingLabel, type FeedbackQuestion } from '../src/lib/feedback.ts';

const QUESTIONS: FeedbackQuestion[] = [
	{ text: 'The talk', scale: 'stars' },
	{ text: 'Come again?', scale: 'ten' },
	{ text: 'The room', scale: 'words' },
];

test('A28: counts and averages match the hand-worked numbers', () => {
	const results = feedbackResults(QUESTIONS, [
		// Stars: one 1, two 3s, three 4s, four 5s. (1 + 6 + 12 + 20) / 10 = 3.9
		['0:1', 1], ['0:3', 2], ['0:4', 3], ['0:5', 4],
		// 1 to 10: two 2s, three 7s, one 10. (4 + 21 + 10) / 6 = 5.833… → 5.8
		['1:2', 2], ['1:7', 3], ['1:10', 1],
		// Words: two Okay (3), one Good (4), one Very good (5). (6 + 4 + 5) / 4 = 3.75 → 3.8, half up
		['2:3', 2], ['2:4', 1], ['2:5', 1],
		['n', 10],
	]);
	assert.deepEqual(results.map((r) => r.counts), [
		[1, 0, 2, 3, 4],
		[0, 2, 0, 0, 0, 0, 3, 0, 0, 1],
		[0, 0, 2, 1, 1],
	]);
	assert.deepEqual(results.map((r) => r.total), [10, 6, 4]);
	assert.deepEqual(results.map((r) => r.averageTenths), [39, 58, 38]);
	assert.deepEqual(results.map((r) => formatAverage(r.averageTenths!)), ['3.9', '5.8', '3.8']);
});

test('A28: a half is rounded up even where floating point would round it down', () => {
	// Thirteen 4s and seven 5s: 87 / 20 = 4.35 exactly. As a float it is 4.3499…, which
	// toFixed(1) shows as 4.3; worked in whole numbers it is 4.4.
	const [result] = feedbackResults([QUESTIONS[0]], [['0:4', 13], ['0:5', 7]]);
	assert.equal((87 / 20).toFixed(1), '4.3', 'the float trap this guards against');
	assert.equal(formatAverage(result.averageTenths!), '4.4');
	// Whole numbers keep their decimal: (2 + 2) / 2 = 2.0, and the top of a scale reads 10.0.
	assert.equal(formatAverage(feedbackResults([QUESTIONS[2]], [['0:2', 2]])[0].averageTenths!), '2.0');
	assert.equal(formatAverage(feedbackResults([QUESTIONS[1]], [['0:10', 3]])[0].averageTenths!), '10.0');
});

test('a question nobody rated has zero counts across its whole scale and no average', () => {
	const [, ten] = feedbackResults(QUESTIONS, [['0:5', 1]]);
	assert.deepEqual(ten.counts, Array(10).fill(0));
	assert.equal(ten.total, 0);
	assert.equal(ten.averageTenths, null);
});

test('keys that are not a rating on this form are ignored, not counted somewhere else', () => {
	const results = feedbackResults(QUESTIONS, [
		['n', 9], ['0:0', 4], ['0:6', 4], ['1:11', 4], ['3:1', 4], ['x:1', 4], ['0:2:1', 4], ['01', 4], ['0:5', 1],
	]);
	assert.deepEqual(results.map((r) => r.total), [1, 0, 0]);
	assert.deepEqual(results[0].counts, [0, 0, 0, 0, 1]);
});

test('ratings read as words people use', () => {
	assert.deepEqual([1, 2, 5].map((n) => ratingLabel('stars', n)), ['1 star', '2 stars', '5 stars']);
	assert.deepEqual([1, 10].map((n) => ratingLabel('ten', n)), ['1 out of 10', '10 out of 10']);
	assert.deepEqual([1, 2, 3, 4, 5].map((n) => ratingLabel('words', n)), ['Very bad', 'Bad', 'Okay', 'Good', 'Very good']);
});

test('formQuestions keeps only questions with text and a known scale', () => {
	assert.deepEqual(formQuestions({ questions: QUESTIONS }), QUESTIONS);
	assert.deepEqual(formQuestions({ questions: [{ text: 'Ok', scale: 'thumbs' }, { text: 3, scale: 'stars' }, null, { text: 'Kept', scale: 'ten' }] }), [{ text: 'Kept', scale: 'ten' }]);
	assert.deepEqual(formQuestions({ questions: [{ text: 'Proto', scale: 'toString' }] }), [], 'an inherited name is not a scale');
	assert.deepEqual(formQuestions(null), []);
	assert.deepEqual(formQuestions({ questions: 'no' }), []);
});

test('formPages: 1 to 3 questions are one phone page; 4 to 6 are two, the longer first, in order', () => {
	assert.deepEqual(formPages(1), [[0, 1]]);
	assert.deepEqual(formPages(3), [[0, 3]]);
	assert.deepEqual(formPages(4), [[0, 2], [2, 4]]);
	assert.deepEqual(formPages(5), [[0, 3], [3, 5]]);
	assert.deepEqual(formPages(6), [[0, 3], [3, 6]]);
	// Past the cap (a form saved before it was 6), still no page holds more than 3.
	assert.deepEqual(formPages(7), [[0, 3], [3, 5], [5, 7]]);
	// No page ever holds more than 3, and together they hold every question once, in order.
	for (let n = 1; n <= 9; n++) {
		const pages = formPages(n);
		assert.ok(pages.every(([from, to]) => to - from >= 1 && to - from <= 3), `${n}: 1 to 3 a page`);
		assert.deepEqual(pages.flatMap(([from, to]) => Array.from({ length: to - from }, (_, i) => from + i)), Array.from({ length: n }, (_, i) => i));
	}
});

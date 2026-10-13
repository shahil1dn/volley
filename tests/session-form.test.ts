// The /decks form's server-side reader: the trust boundary for a session's
// shape. No database here; tests/db-qna.test.ts sends what this accepts
// through start_session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ACTIVITIES, MAX_OPTION_CHARS, MAX_OPTIONS, MAX_PROMPT_CHARS, MIN_OPTIONS } from '../src/lib/session-limits.ts';
import { parseSessionForm } from '../src/lib/server/session-form.ts';

type Activity = { type: string; prompt: string; options?: string[] };

// Builds the post the page makes: parallel type/prompt fields, and options<N> per activity.
function post(activities: Activity[]): FormData {
	const form = new FormData();
	for (const [i, activity] of activities.entries()) {
		form.append('type', activity.type);
		form.append('prompt', activity.prompt);
		for (const option of activity.options ?? []) form.append(`options${i}`, option);
	}
	return form;
}

const cloud = (n = 0): Activity => ({ type: 'word_cloud', prompt: `Question ${n}` });

function refused(form: FormData) {
	const parsed = parseSessionForm(form);
	assert.equal(parsed.ok, false, 'should have been refused');
	if (parsed.ok) throw new Error('unreachable');
	return parsed;
}

test('one activity is enough, and so is the maximum', () => {
	for (const count of [1, MAX_ACTIVITIES]) {
		const parsed = parseSessionForm(post(Array.from({ length: count }, (_, n) => cloud(n))));
		assert.equal(parsed.ok, true, `${count} activities`);
		if (parsed.ok) assert.deepEqual(parsed.items.map((item) => item.prompt), Array.from({ length: count }, (_, n) => `Question ${n}`));
	}
});

test('no activities, or one more than the maximum, is refused with a message for the form', () => {
	assert.match(refused(post([])).errors.form ?? '', /at least one/i);
	const over = refused(post(Array.from({ length: MAX_ACTIVITIES + 1 }, (_, n) => cloud(n))));
	assert.match(over.errors.form ?? '', new RegExp(`at most ${MAX_ACTIVITIES}`));
});

test('a hand-made post can never make the page echo more than the limits', () => {
	const huge = Array.from({ length: 500 }, (_, n) => ({ type: 'poll', prompt: `Q${n}`, options: Array.from({ length: 50 }, (_, j) => `o${j}`) }));
	const parsed = refused(post(huge));
	assert.equal(parsed.drafts.length, MAX_ACTIVITIES);
	assert.ok(parsed.drafts.every((draft) => draft.options.length <= MAX_OPTIONS));
});

test('an enormous string is still refused for its length, but only a capped copy is handed back', () => {
	const huge = 'x'.repeat(100_000);
	const parsed = refused(post([{ type: 'poll', prompt: huge, options: [huge, 'fine'] }, { type: huge, prompt: 'Q?' }]));
	// The checks ran on the whole value...
	assert.match(parsed.errors.drafts[0].prompt ?? '', /140 characters/);
	assert.match(parsed.errors.drafts[0].option?.[0] ?? '', /80 characters/);
	assert.equal(parsed.errors.drafts[1].type, 'Choose a type.');
	// ...and the copy is cut to twice each limit.
	assert.equal(parsed.drafts[0].prompt.length, MAX_PROMPT_CHARS * 2);
	assert.equal(parsed.drafts[0].options[0].length, MAX_OPTION_CHARS * 2);
	assert.ok(parsed.drafts[1].type.length <= 20);
	// A value within twice the limit comes back whole.
	const pasted = 'y'.repeat(MAX_PROMPT_CHARS + 30);
	assert.equal(refused(post([{ type: 'qna', prompt: pasted }])).drafts[0].prompt, pasted);
});

test('a question of exactly the limit and an option of exactly the limit are accepted', () => {
	const prompt = 'q'.repeat(MAX_PROMPT_CHARS);
	const option = 'o'.repeat(MAX_OPTION_CHARS);
	const parsed = parseSessionForm(post([{ type: 'poll', prompt, options: [option, 'short'] }]));
	assert.deepEqual(parsed, { ok: true, items: [{ type: 'poll', prompt, options: [option, 'short'] }] });
	// One more is refused, so the edge sits where the limit says.
	assert.equal(parseSessionForm(post([{ type: 'poll', prompt, options: [`${option}o`, 'short'] }])).ok, false);
	assert.equal(parseSessionForm(post([{ type: 'qna', prompt: `${prompt}q` }])).ok, false);
});

test('type and prompt fields that do not pair up are refused as an incomplete form', () => {
	const form = post([cloud(0), cloud(1)]);
	form.append('type', 'qna');
	assert.match(refused(form).errors.form ?? '', /incomplete/i);
});

test('a file where text belongs counts as empty, not as a crash', () => {
	const form = new FormData();
	form.append('type', 'qna');
	form.append('prompt', new Blob(['not text']), 'x.txt');
	assert.equal(refused(form).errors.drafts[0].prompt, 'Write the question.');
});

test('a wrong type, an empty question and an over-long one each name their own activity', () => {
	const parsed = refused(
		post([
			cloud(0),
			{ type: 'quiz', prompt: 'Fine' },
			{ type: 'qna', prompt: '   ' },
			{ type: 'qna', prompt: 'x'.repeat(MAX_PROMPT_CHARS + 1) },
		]),
	);
	assert.deepEqual(
		parsed.errors.drafts.map((found) => Object.keys(found)),
		[[], ['type'], ['prompt'], ['prompt']],
	);
});

test('the question limit counts characters, as the database does, so an emoji is one', () => {
	assert.equal(parseSessionForm(post([{ type: 'qna', prompt: '🙂'.repeat(MAX_PROMPT_CHARS) }])).ok, true);
	assert.equal(parseSessionForm(post([{ type: 'qna', prompt: '🙂'.repeat(MAX_PROMPT_CHARS + 1) }])).ok, false);
});

test('poll options come back in the order typed, trimmed, and only for polls', () => {
	const parsed = parseSessionForm(
		post([
			{ type: 'word_cloud', prompt: 'One word?' },
			{ type: 'poll', prompt: ' Tea or coffee? ', options: [' Tea', 'Coffee ', 'Neither'] },
			// Options typed for an activity that is not a poll are dropped, not an error.
			{ type: 'qna', prompt: 'Ask us', options: ['stray', 'options'] },
		]),
	);
	assert.deepEqual(parsed, {
		ok: true,
		items: [
			{ type: 'word_cloud', prompt: 'One word?' },
			{ type: 'poll', prompt: 'Tea or coffee?', options: ['Tea', 'Coffee', 'Neither'] },
			{ type: 'qna', prompt: 'Ask us' },
		],
	});
});

test('options are read per activity, by position, not split from one box', () => {
	const form = post([
		{ type: 'poll', prompt: 'First?', options: ['a', 'b'] },
		{ type: 'poll', prompt: 'Second?', options: ['x\ny', 'z'] },
	]);
	const parsed = parseSessionForm(form);
	assert.equal(parsed.ok, true);
	// A newline inside one option stays inside it.
	if (parsed.ok) assert.deepEqual(parsed.items.map((item) => item.options), [['a', 'b'], ['x\ny', 'z']]);
});

test('a poll needs between the minimum and maximum options, counted before anything is trimmed away', () => {
	for (const count of [0, MIN_OPTIONS - 1, MAX_OPTIONS + 1]) {
		const options = Array.from({ length: count }, (_, j) => `option ${j}`);
		const parsed = refused(post([{ type: 'poll', prompt: 'Q?', options }]));
		assert.match(parsed.errors.drafts[0].options ?? '', /needs 2 to 6 options/, `${count} options`);
	}
	for (const count of [MIN_OPTIONS, MAX_OPTIONS]) {
		const options = Array.from({ length: count }, (_, j) => `option ${j}`);
		assert.equal(parseSessionForm(post([{ type: 'poll', prompt: 'Q?', options }])).ok, true, `${count} options`);
	}
});

test('a blank, over-long or repeated option is named on that option', () => {
	const parsed = refused(
		post([{ type: 'poll', prompt: 'Q?', options: ['Yes', '  ', 'x'.repeat(MAX_OPTION_CHARS + 1), 'yes', 'No'] }]),
	);
	const { option, options } = parsed.errors.drafts[0];
	assert.equal(options, undefined);
	assert.deepEqual(Object.keys(option ?? {}), ['1', '2', '3']);
	assert.match(option?.[1] ?? '', /write an option/i);
	assert.match(option?.[2] ?? '', /80 characters/);
	// The repeat points back at the first one.
	assert.match(option?.[3] ?? '', /Same as option 1/);
});

test('a refused form gives back exactly what was typed: untrimmed, in order, with every option', () => {
	const typed: Activity[] = [
		cloud(0),
		{ type: 'poll', prompt: '  Spaced out?  ', options: ['  one ', 'two', 'two', ''] },
		{ type: 'qna', prompt: '' },
	];
	const parsed = refused(post(typed));
	assert.deepEqual(
		parsed.drafts,
		[
			{ type: 'word_cloud', prompt: 'Question 0', options: [] },
			{ type: 'poll', prompt: '  Spaced out?  ', options: ['  one ', 'two', 'two', ''] },
			{ type: 'qna', prompt: '', options: [] },
		],
	);
	assert.equal(parsed.drafts.length, typed.length);
});

test('a thank-you slide is accepted with its message, and any options sent with it are dropped', () => {
	const parsed = parseSessionForm(post([cloud(0), { type: 'thanks', prompt: '  Thank you for joining ', options: ['stray', 'ones'] }]));
	assert.equal(parsed.ok, true);
	if (!parsed.ok) throw new Error('unreachable');
	assert.deepEqual(parsed.items[1], { type: 'thanks', prompt: 'Thank you for joining' });
});

test("a thank-you slide's empty or over-long text is called a message, not a question", () => {
	const parsed = refused(post([{ type: 'thanks', prompt: ' ' }, { type: 'thanks', prompt: 'x'.repeat(MAX_PROMPT_CHARS + 1) }]));
	assert.equal(parsed.errors.drafts[0].prompt, 'Write the message.');
	assert.equal(parsed.errors.drafts[1].prompt, `Keep the message to ${MAX_PROMPT_CHARS} characters or fewer.`);
});

test('a session cannot start with a thank-you slide: it has no answers to open, and opening answers is what starts a session', () => {
	assert.match(refused(post([{ type: 'thanks', prompt: 'Thanks' }, cloud(1)])).errors.drafts[0].type ?? '', /Start with a word cloud, poll or Q&A/);
	assert.equal(refused(post([{ type: 'thanks', prompt: 'Thanks' }])).errors.drafts[0].type !== undefined, true);
});

// Reads the /decks session form. The form is only a convenience: this is where
// the shape and the limits are enforced, and the database checks them again.
// Activities arrive as parallel `type` / `prompt` fields in order; a poll's
// options arrive as `options<N>` for the activity at index N, and a feedback
// form's questions as `questions<N>` with their scales beside them in `scales<N>`.
import { isScale, SCALE_LIST, type FeedbackQuestion } from '../feedback.ts';
import type { Draft, DraftErrors } from '../session-draft.ts';
import {
	ACTIVITY_TYPES,
	MAX_ACTIVITIES,
	MAX_FORM_QUESTION_CHARS,
	MAX_FORM_QUESTIONS,
	MAX_OPTION_CHARS,
	MAX_OPTIONS,
	MAX_PROMPT_CHARS,
	MIN_FORM_QUESTIONS,
	MIN_OPTIONS,
} from '../session-limits.ts';

type SessionItem = { type: string; prompt: string; options?: string[]; questions?: FeedbackQuestion[] };

type ParsedSession =
	| { ok: true; items: SessionItem[] }
	| { ok: false; drafts: Draft[]; errors: { form?: string; drafts: DraftErrors[] } };

// A refused form is handed back so nothing typed is lost, but only up to this
// multiple of each limit: a long paste still shows (and still fails its check,
// which runs on the whole value), without echoing a megabyte.
const ECHO_FACTOR = 2;

const TYPES: ReadonlySet<string> = new Set(ACTIVITY_TYPES.map(([value]) => value));

const text = (entry: FormDataEntryValue | undefined) => (typeof entry === 'string' ? entry : '');
// The database counts characters, not UTF-16 units, so an emoji is one.
const chars = (value: string) => [...value].length;
const cut = (value: string, limit: number) => (chars(value) > limit * ECHO_FACTOR ? [...value].slice(0, limit * ECHO_FACTOR).join('') : value);
const LONGEST_TYPE = Math.max(...ACTIVITY_TYPES.map(([value]) => value.length));
const LONGEST_SCALE = Math.max(...SCALE_LIST.map(([value]) => value.length));
const echoed = (draft: Draft): Draft => ({
	type: cut(draft.type, LONGEST_TYPE),
	prompt: cut(draft.prompt, MAX_PROMPT_CHARS),
	options: draft.options.map((option) => cut(option, MAX_OPTION_CHARS)),
	questions: draft.questions.map((question) => cut(question, MAX_FORM_QUESTION_CHARS)),
	scales: draft.scales.map((scale) => cut(scale, LONGEST_SCALE)),
});

export function parseSessionForm(form: FormData): ParsedSession {
	const types = form.getAll('type');
	const prompts = form.getAll('prompt');
	const count = types.length;

	// Every check below runs on these whole values. What is handed back on a
	// refusal is `echoed(...)` of them: at most MAX_ACTIVITIES activities, MAX_OPTIONS
	// options and MAX_FORM_QUESTIONS questions each, each text cut to ECHO_FACTOR times
	// its limit, so a hand-made post can't make this page return a huge form. The page
	// itself never sends more.
	const full: Draft[] = Array.from({ length: Math.min(count, MAX_ACTIVITIES) }, (_, i) => ({
		type: text(types[i]),
		prompt: text(prompts[i]),
		options: form.getAll(`options${i}`).slice(0, MAX_OPTIONS).map(text),
		questions: form.getAll(`questions${i}`).slice(0, MAX_FORM_QUESTIONS).map(text),
		scales: form.getAll(`scales${i}`).slice(0, MAX_FORM_QUESTIONS).map(text),
	}));
	const drafts = full.map(echoed);

	const refuse = (form_: string) => ({ ok: false as const, drafts, errors: { form: form_, drafts: drafts.map(() => ({})) } });
	if (count === 0) return refuse('Add at least one activity.');
	if (count > MAX_ACTIVITIES) return refuse(`A session has at most ${MAX_ACTIVITIES} activities, so only the first ${MAX_ACTIVITIES} are shown.`);
	if (prompts.length !== count) return refuse('That form was incomplete. Reload the page and try again.');

	const errors: DraftErrors[] = [];
	const items: SessionItem[] = [];
	for (const [i, draft] of full.entries()) {
		const found: DraftErrors = {};
		const prompt = draft.prompt.trim();
		if (!TYPES.has(draft.type)) found.type = 'Choose a type.';
		// A session starts by opening answers on its first activity, and a thank-you slide has none.
		else if (i === 0 && draft.type === 'thanks') found.type = 'Start with a word cloud, poll, Q&A or feedback form. A thank-you slide can come after.';
		const what = draft.type === 'thanks' ? 'message' : draft.type === 'feedback' ? 'title' : 'question';
		if (prompt === '') found.prompt = `Write the ${what}.`;
		else if (chars(prompt) > MAX_PROMPT_CHARS) found.prompt = `Keep the ${what} to ${MAX_PROMPT_CHARS} characters or fewer.`;

		if (draft.type === 'poll') {
			// Counted before the echo's cap, so a hand-made post of 7 is refused, not trimmed to a valid 6.
			const given = form.getAll(`options${i}`).length;
			if (given < MIN_OPTIONS || given > MAX_OPTIONS) found.options = `A poll needs ${MIN_OPTIONS} to ${MAX_OPTIONS} options.`;
			const seen = new Map<string, number>();
			const option: Record<number, string> = {};
			for (const [j, raw] of draft.options.entries()) {
				const value = raw.trim();
				// The database tells options apart ignoring case.
				const first = seen.get(value.toLowerCase());
				if (value === '') option[j] = 'Write an option, or remove this one.';
				else if (chars(value) > MAX_OPTION_CHARS) option[j] = `Keep each option to ${MAX_OPTION_CHARS} characters or fewer.`;
				else if (first !== undefined) option[j] = `Same as option ${first + 1}. Options must differ.`;
				else seen.set(value.toLowerCase(), j);
			}
			if (Object.keys(option).length > 0) found.option = option;
		}

		if (draft.type === 'feedback') {
			// Counted before the echo's cap, like a poll's options.
			const given = form.getAll(`questions${i}`).length;
			if (given < MIN_FORM_QUESTIONS || given > MAX_FORM_QUESTIONS) {
				found.questions = `A feedback form needs ${MIN_FORM_QUESTIONS} to ${MAX_FORM_QUESTIONS} questions.`;
			}
			const question: Record<number, string> = {};
			const scale: Record<number, string> = {};
			for (const [j, raw] of draft.questions.entries()) {
				const value = raw.trim();
				if (value === '') question[j] = 'Write the question, or remove this one.';
				else if (chars(value) > MAX_FORM_QUESTION_CHARS) question[j] = `Keep each question to ${MAX_FORM_QUESTION_CHARS} characters or fewer.`;
				if (!isScale(draft.scales[j])) scale[j] = 'Choose a scale.';
			}
			if (Object.keys(question).length > 0) found.question = question;
			if (Object.keys(scale).length > 0) found.scale = scale;
		}

		errors.push(found);
		if (Object.keys(found).length === 0) {
			// Options belong to polls and questions to feedback forms; whatever else the form carried is dropped.
			if (draft.type === 'poll') items.push({ type: draft.type, prompt, options: draft.options.map((o) => o.trim()) });
			else if (draft.type === 'feedback') {
				items.push({ type: draft.type, prompt, questions: draft.questions.map((q, j) => ({ text: q.trim(), scale: draft.scales[j] as FeedbackQuestion['scale'] })) });
			} else items.push({ type: draft.type, prompt });
		}
	}

	if (errors.some((found) => Object.keys(found).length > 0)) return { ok: false, drafts, errors: { drafts: errors } };
	return { ok: true, items };
}

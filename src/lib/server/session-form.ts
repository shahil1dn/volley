// Reads the /decks session form. The form is only a convenience: this is where
// the shape and the limits are enforced, and the database checks them again.
// Activities arrive as parallel `type` / `prompt` fields in order; a poll's
// options arrive as `options<N>` for the activity at index N.
import type { Draft, DraftErrors } from '../session-draft.ts';
import { ACTIVITY_TYPES, MAX_ACTIVITIES, MAX_OPTION_CHARS, MAX_OPTIONS, MAX_PROMPT_CHARS, MIN_OPTIONS } from '../session-limits.ts';

type SessionItem = { type: string; prompt: string; options?: string[] };

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
const echoed = (draft: Draft): Draft => ({
	type: cut(draft.type, LONGEST_TYPE),
	prompt: cut(draft.prompt, MAX_PROMPT_CHARS),
	options: draft.options.map((option) => cut(option, MAX_OPTION_CHARS)),
});

export function parseSessionForm(form: FormData): ParsedSession {
	const types = form.getAll('type');
	const prompts = form.getAll('prompt');
	const count = types.length;

	// Every check below runs on these whole values. What is handed back on a
	// refusal is `echoed(...)` of them: at most MAX_ACTIVITIES activities, MAX_OPTIONS
	// options each, each text cut to ECHO_FACTOR times its limit, so a hand-made
	// post can't make this page return a huge form. The page itself never sends more.
	const full: Draft[] = Array.from({ length: Math.min(count, MAX_ACTIVITIES) }, (_, i) => ({
		type: text(types[i]),
		prompt: text(prompts[i]),
		options: form.getAll(`options${i}`).slice(0, MAX_OPTIONS).map(text),
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
		if (prompt === '') found.prompt = 'Write the question.';
		else if (chars(prompt) > MAX_PROMPT_CHARS) found.prompt = `Keep the question to ${MAX_PROMPT_CHARS} characters or fewer.`;

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

		errors.push(found);
		if (Object.keys(found).length === 0) {
			// Options belong to polls only; whatever else the form carried is dropped.
			items.push(draft.type === 'poll' ? { type: draft.type, prompt, options: draft.options.map((o) => o.trim()) } : { type: draft.type, prompt });
		}
	}

	if (errors.some((found) => Object.keys(found).length > 0)) return { ok: false, drafts, errors: { drafts: errors } };
	return { ok: true, items };
}

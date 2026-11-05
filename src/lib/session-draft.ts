// The /decks form as it travels between page and server: what the host typed,
// and one message per wrong field. Shared so the page and the reader agree.

/** What the host typed, handed back (within the echo limits) when something is wrong.
 *  `questions` and `scales` are a feedback form's rating questions, side by side. */
export type Draft = { type: string; prompt: string; options: string[]; questions: string[]; scales: string[] };

/** One message per wrong field, shown next to it. `option`, `question` and `scale` are keyed by index. */
export type DraftErrors = {
	type?: string;
	prompt?: string;
	options?: string;
	option?: Record<number, string>;
	questions?: string;
	question?: Record<number, string>;
	scale?: Record<number, string>;
};

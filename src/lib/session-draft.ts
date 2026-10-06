// The /decks form as it travels between page and server: what the host typed,
// and one message per wrong field. Shared so the page and the reader agree.

/** What the host typed, handed back (within the echo limits) when something is wrong. */
export type Draft = { type: string; prompt: string; options: string[] };

/** One message per wrong field, shown next to it. `option` is keyed by option index. */
export type DraftErrors = { type?: string; prompt?: string; options?: string; option?: Record<number, string> };

// A feedback form's scales and results (ADR-018), shared by the builder, the
// phone, the projector, the control page and the CSV so every screen names and
// counts a rating the same way. The database (migration 0019) holds the same
// scales and is the last word on what may be sent.

export const SCALES = {
	stars: { name: 'Stars, 1 to 5', points: 5 },
	ten: { name: '1 to 10', points: 10 },
	words: { name: 'Very bad to Very good', points: 5 },
} as const;
export type Scale = keyof typeof SCALES;
export const SCALE_LIST = Object.entries(SCALES).map(([value, { name }]) => [value as Scale, name] as const);

// The `words` scale, stored as 1 to 5.
const WORDS = ['Very bad', 'Bad', 'Okay', 'Good', 'Very good'];

export const isScale = (value: unknown): value is Scale => typeof value === 'string' && Object.hasOwn(SCALES, value);

/** A rating as people read it: "4 stars", "7 out of 10", "Good". */
export function ratingLabel(scale: Scale, rating: number): string {
	if (scale === 'words') return WORDS[rating - 1] ?? String(rating);
	if (scale === 'stars') return rating === 1 ? '1 star' : `${rating} stars`;
	return `${rating} out of 10`;
}

/** The short name of one point, for a chart's axis: "1"…"10", or the word. */
export const pointLabel = (scale: Scale, rating: number): string => (scale === 'words' ? (WORDS[rating - 1] ?? String(rating)) : String(rating));

export type FeedbackQuestion = { text: string; scale: Scale };

/** The questions in an item's settings; any that aren't a text and a known scale are left out. */
export function formQuestions(settings: unknown): FeedbackQuestion[] {
	const questions = (settings as { questions?: unknown } | null)?.questions;
	if (!Array.isArray(questions)) return [];
	return questions.flatMap((q) => (typeof q?.text === 'string' && isScale(q?.scale) ? [{ text: q.text, scale: q.scale }] : []));
}

// A phone shows at most this many questions at a time; the projector shows them all.
const PER_PAGE = 3;

/**
 * A form split into phone pages, each as [first, end) question numbers: as few pages as hold
 * at most 3 each, as even as can be, the longer first. Up to 3 is one page; 4 to 6 are two
 * (2+2, 3+2, 3+3).
 */
export function formPages(count: number): [number, number][] {
	const pageCount = Math.max(1, Math.ceil(count / PER_PAGE));
	const size = Math.floor(count / pageCount);
	const longer = count % pageCount;
	const pages: [number, number][] = [];
	for (let page = 0, from = 0; page < pageCount; page++) {
		const to = from + size + (page < longer ? 1 : 0);
		pages.push([from, to]);
		from = to;
	}
	return pages;
}

export type QuestionResult = FeedbackQuestion & {
	/** How many gave each rating: `counts[0]` is a 1. */
	counts: number[];
	total: number;
	/** The average in tenths (42 is 4.2), or null when nobody has rated it. */
	averageTenths: number | null;
};

// Rounded half up, in tenths, on whole numbers: 4.25 is 4.3, never a float's 4.2.
function averageTenths(counts: number[]): number | null {
	const total = counts.reduce((sum, n) => sum + n, 0);
	if (total === 0) return null;
	const sum = counts.reduce((acc, n, i) => acc + n * (i + 1), 0);
	return Math.floor((20 * sum + total) / (2 * total));
}

export const formatAverage = (tenths: number): string => `${Math.floor(tenths / 10)}.${tenths % 10}`;

/**
 * Each question's counts and average from the tallies, keyed "<question>:<rating>"
 * with questions numbered from 0. Other keys (the count of forms, "n") are ignored.
 */
export function feedbackResults(questions: FeedbackQuestion[], tallies: readonly (readonly [string, number, ...unknown[]])[]): QuestionResult[] {
	const counts = questions.map((q) => Array<number>(SCALES[q.scale].points).fill(0));
	for (const [key, count] of tallies) {
		const match = /^(\d+):(\d+)$/.exec(key);
		if (!match) continue;
		const row = counts[Number(match[1])];
		const point = Number(match[2]) - 1;
		if (row && point >= 0 && point < row.length) row[point] += count;
	}
	return questions.map((q, i) => ({ ...q, counts: counts[i], total: counts[i].reduce((sum, n) => sum + n, 0), averageTenths: averageTenths(counts[i]) }));
}

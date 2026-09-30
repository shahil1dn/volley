export const MAX_WORD_LENGTH = 25;
export const WORDS_PER_PERSON = 3;

// "  Machine   Learning " and "machine learning" should grow the same word,
// so everything is compared in one form.
export function normaliseWord(raw: string): string | null {
  const word = raw.trim().replace(/\s+/g, ' ').toLowerCase();
  // Counted in characters, as the database counts them: .length would count
  // an emoji as two and refuse words the server accepts.
  const characters = [...word].length;
  if (characters === 0 || characters > MAX_WORD_LENGTH) return null;
  return word;
}

export type WordCount = { text: string; count: number };

// Biggest first, then alphabetical so words with equal counts do not
// shuffle around the screen every time a new one arrives.
export function countWords(texts: string[]): WordCount[] {
  const counts = new Map<string, number>();
  for (const text of texts) counts.set(text, (counts.get(text) ?? 0) + 1);
  return [...counts]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
}

// A word's size in vw, ported from the prototype (measured to fit at 1280×720
// and 1024×768). Many distinct words need smaller type to fit one screen. The
// projector and the PNG export both size words with this.
export function wordSizeVw(count: number, biggest: number, distinct: number): number {
  const smallest = 1.4;
  const largest = Math.max(3.5, 8 - distinct * 0.08);
  return smallest + (largest - smallest) * Math.sqrt(count / biggest);
}

// Places the biggest word in the middle and alternates the rest outwards, so
// the cloud has a centre instead of reading like a sorted list.
export function centreOut<T>(sorted: T[]): T[] {
  const arranged: T[] = [];
  sorted.forEach((item, i) => (i % 2 === 0 ? arranged.push(item) : arranged.unshift(item)));
  return arranged;
}

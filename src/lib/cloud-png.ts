// The word cloud as a PNG, drawn from the host's tallies with the projector's
// sizing rule, so the host can keep it after the run is deleted.
import { centreOut, wordSizeVw } from './words.ts';

export const PNG_WIDTH = 1600;
export const PNG_HEIGHT = 900;
const MARGIN = 64;
const PROMPT_PX = 44;
const WORD_GAP = 0.5; // of the word's own size
const LINE_HEIGHT = 1.15;
const FIT_STEP = 0.9;
const MIN_FIT = 0.2;

export type PlacedWord = { text: string; px: number; x: number; y: number; top: boolean };
type Measure = (text: string, px: number) => number;

// Greedy line-filling in the projector's centre-out order, shrunk together
// until the block fits the box. x and y are each word's centre-left baseline.
export function layoutCloud(
	sorted: [string, number][],
	box: { left: number; top: number; width: number; height: number },
	measure: Measure,
): PlacedWord[] {
	if (sorted.length === 0) return [];
	const biggest = sorted[0][1];
	// On the canvas 1vw is 1% of its width, as on a full-screen projector.
	const basePx = sorted.map(([, count]) => (wordSizeVw(count, biggest, sorted.length) * PNG_WIDTH) / 100);
	const arranged = centreOut(sorted.map(([text, count], i) => ({ text, px: basePx[i], top: count === biggest })));

	for (let fit = 1; ; fit *= FIT_STEP) {
		const lines: { words: { text: string; px: number; width: number; top: boolean }[]; width: number; height: number }[] = [];
		for (const word of arranged) {
			const px = word.px * fit;
			const width = measure(word.text, px);
			const line = lines.at(-1);
			const gap = px * WORD_GAP;
			if (line && line.width + gap + width <= box.width) {
				line.words.push({ text: word.text, px, width, top: word.top });
				line.width += gap + width;
				line.height = Math.max(line.height, px * LINE_HEIGHT);
			} else {
				lines.push({ words: [{ text: word.text, px, width, top: word.top }], width, height: px * LINE_HEIGHT });
			}
		}
		const total = lines.reduce((sum, line) => sum + line.height, 0);
		const widest = Math.max(...lines.map((line) => line.width));
		if ((total <= box.height && widest <= box.width) || fit * FIT_STEP < MIN_FIT) {
			const placed: PlacedWord[] = [];
			let y = box.top + (box.height - total) / 2;
			for (const line of lines) {
				let x = box.left + (box.width - line.width) / 2;
				const baseline = y + line.height / 2;
				for (const word of line.words) {
					placed.push({ text: word.text, px: word.px, x, y: baseline, top: word.top });
					x += word.width + word.px * WORD_GAP;
				}
				y += line.height;
			}
			return placed;
		}
	}
}

function wrap(text: string, width: number, measure: (text: string) => number): string[] {
	const lines: string[] = [];
	for (const word of text.split(' ')) {
		const last = lines.at(-1);
		if (last !== undefined && measure(`${last} ${word}`) <= width) lines[lines.length - 1] = `${last} ${word}`;
		else lines.push(word);
	}
	return lines;
}

// Draws with the page's own font and colours, then hands back the PNG.
export async function cloudPng(prompt: string, visible: [string, number][]): Promise<Blob> {
	const canvas = document.createElement('canvas');
	canvas.width = PNG_WIDTH;
	canvas.height = PNG_HEIGHT;
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('This browser cannot draw images');
	const style = getComputedStyle(document.documentElement);
	const font = getComputedStyle(document.body).fontFamily;
	const ink = style.getPropertyValue('--ink').trim() || '#000';
	const accent = style.getPropertyValue('--accent').trim() || ink;

	ctx.fillStyle = style.getPropertyValue('--paper').trim() || '#fff';
	ctx.fillRect(0, 0, PNG_WIDTH, PNG_HEIGHT);

	ctx.fillStyle = ink;
	ctx.textBaseline = 'alphabetic';
	ctx.font = `600 ${PROMPT_PX}px ${font}`;
	const promptLines = wrap(prompt, PNG_WIDTH - 2 * MARGIN, (text) => ctx.measureText(text).width);
	promptLines.forEach((line, i) => ctx.fillText(line, MARGIN, MARGIN + PROMPT_PX + i * PROMPT_PX * LINE_HEIGHT));

	const top = MARGIN + PROMPT_PX * LINE_HEIGHT * promptLines.length + 32;
	const box = { left: MARGIN, top, width: PNG_WIDTH - 2 * MARGIN, height: PNG_HEIGHT - top - MARGIN };
	const measure = (text: string, px: number) => {
		ctx.font = `600 ${px}px ${font}`;
		return ctx.measureText(text).width;
	};
	ctx.textBaseline = 'middle';
	for (const word of layoutCloud(visible, box, measure)) {
		ctx.font = `600 ${word.px}px ${font}`;
		ctx.fillStyle = word.top ? accent : ink;
		ctx.fillText(word.text, word.x, word.y);
	}

	return new Promise((resolve, reject) =>
		canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not make the image'))), 'image/png'),
	);
}

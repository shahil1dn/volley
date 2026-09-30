// The host's results download: one row per answer per activity, straight from
// the tallies, so its counts are the ones the projector showed.

export type RunExport = {
	code: string;
	items: { position: number; type: string; prompt: string | null; tallies: [string, number, boolean][] }[];
};

const HEADER = ['Activity', 'Type', 'Question', 'Answer', 'Count', 'Hidden'];

// Answers are typed by the public, so a word like "=HYPERLINK(...)" must reach
// a spreadsheet as text, not run as a formula (OWASP CSV injection).
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: string | number): string {
	let text = String(value);
	if (FORMULA_START.test(text)) text = `'${text}`;
	return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function resultsCsv(run: RunExport): string {
	const rows = [HEADER];
	for (const item of run.items) {
		for (const [answer, count, hidden] of item.tallies) {
			rows.push([String(item.position + 1), item.type, item.prompt ?? '', answer, String(count), hidden ? 'yes' : 'no']);
		}
	}
	// The byte-order mark makes Excel read the file as UTF-8, so accents and
	// emoji survive. Lines end in CRLF, as RFC 4180 specifies.
	return '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

import type pg from 'pg';
import { lenientDecode } from './lib/connection-target.ts';

// The London database is production (2026-09-30): tests and ad-hoc scripts
// must never write to it. Every setting is checked, not a chosen few, so a
// production value can't slip in under a name nobody thought to list.
export const PRODUCTION_REF = 'qeheedlsskaurqshmueb';

// Anything a connection could end up reading the ref from: the value as written, percent-decoded until it
// stops changing, and each of those with compatibility letters folded (full-width q, long s) and everything
// that is not a letter or digit removed (tabs and newlines, which new URL() strips, soft hyphens, zero-width
// characters). Where the value is an address, the host and user as a URL parser reads them are checked too.
// It reads the text only: it never opens a file named in it, and a bad part of the value can't hide a good one.
const MAX_DECODES = 32;

function normalised(text: string): string {
	return text.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function decodedReadings(value: string): { texts: string[]; settled: boolean } {
	const texts = [value];
	let current = value;
	for (let round = 0; round < MAX_DECODES; round++) {
		const next = lenientDecode(current);
		if (next === current) return { texts, settled: true };
		texts.push(next);
		current = next;
	}
	return { texts, settled: false };
}

function readings(value: string): { texts: string[]; settled: boolean } {
	const { texts, settled } = decodedReadings(value);
	for (const text of [...texts]) {
		try {
			const url = new URL(text);
			texts.push(url.hostname, url.username);
		} catch {
			// not an address: the readings above are all there is
		}
	}
	return { texts, settled };
}

function mentionsProduction(texts: string[]): boolean {
	return texts.some((text) => normalised(text).includes(PRODUCTION_REF));
}

// The name of the first setting that points at production, or null. A value that is still changing after
// MAX_DECODES decodes is treated as production: nothing real is encoded that deep.
export function productionSetting(env: Record<string, string | undefined>): string | null {
	for (const [name, value] of Object.entries(env)) {
		if (!value) continue;
		const { texts, settled } = readings(value);
		if (!settled || mentionsProduction(texts)) return name;
	}
	return null;
}

// The same test on the fields a connection is actually made with (see addressConfig).
export function refuseProductionConfig(config: pg.ClientConfig, what: string, instead: string) {
	const fields = [config.host, config.user, config.database].filter((part): part is string => Boolean(part));
	if (fields.some((field) => mentionsProduction(readings(field).texts))) {
		throw new Error(`Refusing to run ${what}: the address points at the production database (${PRODUCTION_REF}). ${instead}`);
	}
}

export function refuseProduction(
	env: Record<string, string | undefined>,
	what: string,
	instead = 'Tests run against the test project in .env.local only.',
) {
	const setting = productionSetting(env);
	if (setting) {
		throw new Error(`Refusing to run ${what}: ${setting} points at the production database (${PRODUCTION_REF}). ${instead}`);
	}
}

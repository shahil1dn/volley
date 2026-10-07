import { parse } from 'pg-connection-string';

// The London database is production (2026-09-30): tests and ad-hoc scripts
// must never write to it. Every setting is checked, not a chosen few, so a
// production value can't slip in under a name nobody thought to list.
export const PRODUCTION_REF = 'qeheedlsskaurqshmueb';

// Every way a value can be read that a connection might end up using: as written, percent-decoded (as many
// times as it takes), and as pg itself parses it (pg-connection-string, with ?host= and ?user= applied),
// so the ref can't hide behind %71, an override in the query string or a letter case.
function readings(value: string): string[] {
	const found = new Set<string>();
	let current = value;
	for (let round = 0; round < 4; round++) {
		found.add(current.toLowerCase());
		let next: string;
		try {
			next = decodeURIComponent(current);
		} catch {
			break;
		}
		if (next === current) break;
		current = next;
	}
	try {
		// Without sslmode: parsing that only prints a warning, it can't change the host or user.
		const parsed = parse(value.replace(/([?&])sslmode=[^&]*&?/gi, '$1'));
		for (const part of [parsed.host, parsed.user, parsed.database]) if (part) found.add(String(part).toLowerCase());
	} catch {
		// not an address: the readings above are all there is
	}
	return [...found];
}

// The name of the first setting that points at production, or null.
export function productionSetting(env: Record<string, string | undefined>): string | null {
	for (const [name, value] of Object.entries(env)) {
		if (value && readings(value).some((reading) => reading.includes(PRODUCTION_REF))) return name;
	}
	return null;
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

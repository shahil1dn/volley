// The London database is production (2026-09-30): tests and ad-hoc scripts
// must never write to it. Every setting is checked, not a chosen few, so a
// production value can't slip in under a name nobody thought to list.
export const PRODUCTION_REF = 'qeheedlsskaurqshmueb';

// The name of the first setting that points at production, or null.
export function productionSetting(env: Record<string, string | undefined>): string | null {
	for (const [name, value] of Object.entries(env)) {
		if (value?.toLowerCase().includes(PRODUCTION_REF)) return name;
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

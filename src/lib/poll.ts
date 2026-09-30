// A poll's bars: each visible option with its votes, in the host's order.
// Every option starts at zero (create_run), so an option missing from the
// shared state's tallies has been hidden by the host.
export type PollBar = { label: string; votes: number };

export function pollBars(options: unknown, tallies: [string, number][]): PollBar[] {
	if (!Array.isArray(options)) return [];
	const votes = new Map(tallies);
	return options.flatMap((label) => (typeof label === 'string' && votes.has(label) ? [{ label, votes: votes.get(label)! }] : []));
}

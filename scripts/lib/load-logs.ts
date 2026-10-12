// Counts the function calls a load run caused, from Vercel's runtime logs. Read only: it runs `vercel logs`
// and the same deployment lookup the load test uses, nothing else. Found on the A10 run (CLI 53.0.1):
// - following the logs (`vercel logs <url>`) shows only what the app prints, and the app prints nothing;
// - a historical read (`--no-follow --since --until --json`) returns REQUEST rows, at most 50 a call, whatever
//   --limit says, each with a `cache` field. Background refreshes behind a STALE reply have no row of their own.
// So the state route's function calls lie between two numbers: at least the distinct versions that reached a phone
// (from the run's report), at most every state row that was MISS, STALE or otherwise not a plain cache HIT.
// Run live on the A10 run-2 window (2026-10-12): MISS 1,323, STALE 3,341, REVALIDATED 0, BYPASS 0.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Refusal, vercelDeploymentFacts, verifyNotProduction } from './load-guard.ts';
import { cliReason, type Exec } from './vercel.ts';

export const PAGE_ROWS = 50;
export const MAX_PAGES = 1000; // 50,000 rows: far more than a 10-minute run at 200 phones writes
const HOBBY_LOG_KEEP_MS = 60 * 60 * 1000;
const STATE_ROUTE = '/api/r/CODE/state';

// A HIT never reaches the function. Every other value on the way in can mean it ran. REVALIDATED and BYPASS were
// 0 rows on the A10 run; they are asked for so a change in how the route is cached cannot hide calls.
export const CALLING_CACHE_VALUES = ['MISS', 'STALE', 'REVALIDATED', 'BYPASS'] as const;

export type LogRow = { id: string; timestamp: number; requestPath: string; cache: string | null };
export type Paged = { rows: LogRow[]; calls: number; complete: boolean };

function parseRows(text: string): LogRow[] {
	const rows: LogRow[] = [];
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new Error(`the Vercel CLI printed something that is not a log row: "${line.slice(0, 60)}"`);
		}
		if (typeof parsed?.id !== 'string' || typeof parsed.timestamp !== 'number') throw new Error(`the Vercel CLI printed something that is not a log row: "${line.slice(0, 60)}"`);
		rows.push({
			id: parsed.id,
			timestamp: parsed.timestamp,
			requestPath: typeof parsed.requestPath === 'string' ? parsed.requestPath : '',
			cache: typeof parsed.cache === 'string' ? parsed.cache : null,
		});
	}
	return rows;
}

// Newest rows first, 50 a call. Each next call asks for everything up to one millisecond past the oldest row
// seen, so rows that share that millisecond are fetched again rather than skipped, and the id drops the repeats.
// A page of 50 that adds nothing new (50 rows in one millisecond) cannot be paged past: that is reported as
// incomplete, never as a smaller count.
export function pageLogs(exec: Exec, ask: { deployment: string; since: string; until: string; query: string }): Paged {
	const seen = new Map<string, LogRow>();
	const floor = Date.parse(ask.since);
	let until = ask.until;
	let calls = 0;
	while (calls < MAX_PAGES) {
		const result = exec(['logs', '--deployment', ask.deployment, '--no-follow', '--no-branch', '--since', ask.since, '--until', until, '--json', '--limit', String(PAGE_ROWS), '--query', ask.query]);
		calls++;
		if (result.status !== 0) throw new Error(`the Vercel CLI failed while reading logs (${cliReason(result)})`);
		const rows = parseRows(result.stdout);
		let fresh = 0;
		for (const entry of rows) {
			if (!seen.has(entry.id)) {
				seen.set(entry.id, entry);
				fresh++;
			}
		}
		if (rows.length < PAGE_ROWS) return { rows: [...seen.values()], calls, complete: true };
		if (fresh === 0) return { rows: [...seen.values()], calls, complete: false };
		const next = Math.min(...rows.map((entry) => entry.timestamp)) + 1;
		if (next <= floor) return { rows: [...seen.values()], calls, complete: true };
		until = new Date(next).toISOString();
	}
	return { rows: [...seen.values()], calls, complete: false };
}

const rate = (count: number, seconds: number) => Math.round((count / seconds) * 100) / 100;
const normalise = (path: string) => path.replace(/\/r\/[A-Za-z0-9]+/, '/r/CODE');

type Report = { start: string; end: string; budget: number | null; answersPerSecond: number | null; lowerPerSecond: number | null };

function readReport(path: string): Report {
	let parsed: Record<string, any>;
	try {
		parsed = JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		throw new Refusal(`--report ${path} could not be read as a load-test report (JSON from node scripts/load-test.ts).`);
	}
	const { start, end } = parsed?.measuredWindow ?? {};
	if (typeof start !== 'string' || typeof end !== 'string') throw new Refusal(`--report ${path} has no measuredWindow, so it is not a load-test report.`);
	const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
	return { start, end, budget: num(parsed.budget), answersPerSecond: num(parsed.submits?.answersPerSecond), lowerPerSecond: num(parsed.state?.calls?.generationsPerSecond) };
}

const HELP = `Usage: node scripts/load-logs.ts --deployment <dpl_...> (--report <load-results file> | --since <time> --until <time>)
Counts the function calls of a load run from Vercel's runtime logs (read only, Hobby keeps them for an hour).
  --deployment <id>   the preview's deployment id; refused if Vercel says it is production
  --report <file>     the JSON a load run wrote: gives the window, the budget and the lower bound
  --since / --until   the window as ISO times, if there is no report
Exit codes: 0 counted and within budget (or no budget given), 1 over, unproven or incomplete, 2 refused or could not run.`;

export type Io = { exec: Exec; now: () => number; log: (line: string) => void };

export async function runLoadLogs(argv: string[], io: Io): Promise<number> {
	try {
		return await count(argv, io);
	} catch (error) {
		io.log(`${error instanceof Refusal ? 'Refused' : 'Could not run'}: ${(error as Error).message}`);
		return 2;
	}
}

async function count(argv: string[], io: Io): Promise<number> {
	const { values } = parseArgs({ args: argv, options: { deployment: { type: 'string' }, report: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' }, help: { type: 'boolean', default: false } }, strict: true });
	if (values.help) {
		io.log(HELP);
		return 0;
	}
	const deployment = values.deployment?.trim();
	if (!deployment) throw new Refusal('--deployment is required (the preview\'s id, dpl_...).');
	if (!/^dpl_[A-Za-z0-9]+$/.test(deployment)) throw new Refusal('--deployment must be a Vercel deployment id such as dpl_AbC123, not an address.');

	const report = values.report ? readReport(values.report) : null;
	const sinceRaw = report?.start ?? values.since;
	const untilRaw = report?.end ?? values.until;
	if (!sinceRaw || !untilRaw) throw new Refusal('Give the window with --report, or both --since and --until.');
	const sinceMs = Date.parse(sinceRaw);
	const untilMs = Date.parse(untilRaw);
	if (Number.isNaN(sinceMs)) throw new Refusal(`--since "${sinceRaw}" is not a time (use an ISO time such as 2026-10-12T00:24:43.234Z).`);
	if (Number.isNaN(untilMs)) throw new Refusal(`--until "${untilRaw}" is not a time (use an ISO time such as 2026-10-12T00:28:43.548Z).`);
	if (sinceMs >= untilMs) throw new Refusal('--since must be before --until.');
	const since = new Date(sinceMs).toISOString();
	const until = new Date(untilMs).toISOString();

	await verifyNotProduction(deployment, (id) => vercelDeploymentFacts(id, io.exec));

	const rows = new Map<string, LogRow>();
	let complete = true;
	let pages = 0;
	for (const value of CALLING_CACHE_VALUES) {
		const paged = pageLogs(io.exec, { deployment, since, until, query: `cache:${value}` });
		pages += paged.calls;
		complete &&= paged.complete;
		for (const entry of paged.rows) rows.set(entry.id, { ...entry, cache: entry.cache ?? value });
	}

	const seconds = (untilMs - sinceMs) / 1000;
	const all = [...rows.values()];
	const state = all.filter((entry) => normalise(entry.requestPath) === STATE_ROUTE);
	io.log(`Vercel runtime logs for ${deployment}`);
	io.log(`Window: ${since} to ${until} (${rate(seconds, 1)}s), read in ${pages} calls of up to ${PAGE_ROWS} rows`);
	if (io.now() - sinceMs > HOBBY_LOG_KEEP_MS) io.log('Note: this window is older than an hour. Hobby keeps runtime logs for an hour, so the counts may be short.');
	for (const value of CALLING_CACHE_VALUES) {
		const of = all.filter((entry) => entry.cache === value);
		const byRoute = new Map<string, number>();
		for (const entry of of) byRoute.set(normalise(entry.requestPath), (byRoute.get(normalise(entry.requestPath)) ?? 0) + 1);
		const routes = [...byRoute].sort((a, b) => b[1] - a[1]).map(([route, n]) => `${route} ${n}`).join(', ');
		io.log(`  ${value} ${of.length} (state ${of.filter((entry) => state.includes(entry)).length})${routes ? `: ${routes}` : ''}`);
	}

	const upper = rate(state.length, seconds);
	io.log('State route function calls:');
	if (report?.lowerPerSecond != null) io.log(`  at least ${report.lowerPerSecond} a second (distinct state versions that reached a phone, from the run's report)`);
	io.log(`  at most ${upper} a second (${state.length} state rows that were not a plain cache hit, over ${rate(seconds, 1)}s; each STALE starts at most one background refresh)`);
	io.log(`Other function calls (answers, host pages): ${rate(all.length - state.length, seconds)} a second`);

	let failed = false;
	if (!complete) {
		io.log('INCOMPLETE: a page of 50 rows could not be paged past, or the page cap was hit. The counts above are short; do not use them.');
		failed = true;
	}
	if (report?.budget != null) {
		const limit = report.budget + (report.answersPerSecond ?? 0);
		const budget = `the budget of ${report.budget} a second plus ${report.answersPerSecond ?? 0} answers a second (ADR-004)`;
		if (upper <= limit) io.log(`RESULT: within ${budget}, even at the upper bound.`);
		else if (report.lowerPerSecond != null && report.lowerPerSecond > limit) {
			io.log(`RESULT: OVER ${budget}, even at the lower bound.`);
			failed = true;
		} else {
			io.log(`RESULT: not proven. The upper bound is over ${budget}${report.lowerPerSecond != null ? ' and the lower bound is under it' : ' and there is no lower bound without --report'}.`);
			failed = true;
		}
	}
	return failed ? 1 : 0;
}

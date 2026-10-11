// The load test's arithmetic and its plain-text report. No network, no clock: tests feed it samples.

export type Route = 'page' | 'join' | 'state' | 'answer' | 'host-view' | 'host-action' | 'sign-in' | 'start-session' | 'export';

// One request. `at` is milliseconds since the run's start; `generation` is the `serverNow` of a state body,
// which changes every time the function runs.
export type Sample = { route: Route; status: number; ms: number; cache: string | null; at: number; generation?: number };

// Nearest-rank: the smallest value with at least p% of the data at or below it. `sorted` is ascending.
export function percentile(sorted: number[], p: number): number | null {
	if (sorted.length === 0) return null;
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

export type RouteSummary = { count: number; statuses: Record<string, number>; p50: number | null; p95: number | null; max: number | null; cache: Record<string, number> };

export function summariseRoutes(samples: Sample[]): Record<string, RouteSummary> {
	const byRoute = new Map<string, Sample[]>();
	for (const entry of samples) byRoute.set(entry.route, [...(byRoute.get(entry.route) ?? []), entry]);
	const out: Record<string, RouteSummary> = {};
	for (const [route, list] of byRoute) {
		const sorted = list.map((entry) => entry.ms).sort((a, b) => a - b);
		const statuses: Record<string, number> = {};
		const cache: Record<string, number> = {};
		for (const entry of list) {
			statuses[entry.status] = (statuses[entry.status] ?? 0) + 1;
			const label = entry.cache ?? '(none)';
			cache[label] = (cache[label] ?? 0) + 1;
		}
		out[route] = { count: list.length, statuses, p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted.at(-1) ?? null, cache };
	}
	return out;
}

const CACHED = new Set(['HIT', 'STALE']);

export type CallCount = {
	headerPresent: boolean;
	cached: number; // x-vercel-cache HIT or STALE
	calls: number; // any other x-vercel-cache value: the function ran for this response
	unknown: number; // no x-vercel-cache header
	callsPerSecond: number | null;
	generations: number | null; // distinct serverNow values seen in state bodies
	generationsPerSecond: number | null;
};

// Two counts, and neither is the truth. A response header shows only what a client was told: a STALE reply
// triggers a refresh in the background that no client sees, so `calls` UNDER-counts (S1: 52 MISS responses
// against 1,055 function calls in the runtime logs). Distinct `serverNow` values count each function run whose
// result reached a client, which is much closer; the runtime logs for the printed window are the authority.
export function countFunctionCalls(samples: Sample[], seconds: number): CallCount {
	let cached = 0;
	let calls = 0;
	let unknown = 0;
	const generations = new Set<number>();
	for (const entry of samples) {
		if (entry.cache === null) unknown++;
		else if (CACHED.has(entry.cache.toUpperCase())) cached++;
		else calls++;
		if (entry.generation !== undefined) generations.add(entry.generation);
	}
	const headerPresent = cached + calls > 0;
	const rate = (n: number) => Math.round((n / seconds) * 100) / 100;
	return {
		headerPresent,
		cached,
		calls,
		unknown,
		callsPerSecond: headerPresent ? rate(calls) : null,
		generations: generations.size > 0 ? generations.size : null,
		generationsPerSecond: generations.size > 0 ? rate(generations.size) : null,
	};
}

export type VerdictInput = {
	failedSubmits: number;
	integrityOk: boolean;
	stateCallsPerSecond: number | null;
	answersPerSecond: number;
	budget: number; // ADR-004 (amended 2026-09-30): about 15 state calls a second
	specLine: number; // SPEC A10 as written: under 2 a second, plus answers
	callsRequired?: boolean; // false for a local run, where there is no edge cache to measure (default true)
};

export function verdictFor(input: VerdictInput): { pass: boolean; specLinePass: boolean; reasons: string[] } {
	const reasons: string[] = [];
	if (input.failedSubmits > 0) reasons.push(`${input.failedSubmits} failed submit${input.failedSubmits === 1 ? '' : 's'}`);
	if (!input.integrityOk) reasons.push('stored counts do not match what was acknowledged');
	const callsRequired = input.callsRequired ?? true;
	if (input.stateCallsPerSecond === null) {
		if (callsRequired) reasons.push('function calls could not be measured');
	} else if (callsRequired && input.stateCallsPerSecond > input.budget + input.answersPerSecond) reasons.push(`${input.stateCallsPerSecond} state calls a second is over the budget of ${input.budget} plus ${input.answersPerSecond} answers a second`);
	const specLinePass = (input.callsRequired ?? true) && input.stateCallsPerSecond !== null && input.stateCallsPerSecond <= input.specLine + input.answersPerSecond;
	return { pass: reasons.length === 0, specLinePass, reasons };
}

// ---- the stored-counts check: what the phones were told against what the host's results download holds ----

export type CsvRow = { activity: number; type: string; answer: string; count: number };

// RFC 4180 as resultsCsv writes it: a byte-order mark, CRLF, "" inside quotes.
export function parseResultsCsv(text: string): CsvRow[] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = '';
	let quoted = false;
	const source = text.replace(/^﻿/, '');
	for (let i = 0; i < source.length; i++) {
		const char = source[i];
		if (quoted) {
			if (char === '"' && source[i + 1] === '"') {
				cell += '"';
				i++;
			} else if (char === '"') quoted = false;
			else cell += char;
		} else if (char === '"') quoted = true;
		else if (char === ',') {
			row.push(cell);
			cell = '';
		} else if (char === '\n' || char === '\r') {
			if (char === '\r' && source[i + 1] === '\n') i++;
			row.push(cell);
			rows.push(row);
			row = [];
			cell = '';
		} else cell += char;
	}
	if (cell !== '' || row.length > 0) rows.push([...row, cell]);
	return rows.slice(1).filter((r) => r.length >= 5).map((r) => ({ activity: Number(r[0]), type: r[1], answer: r[3], count: Number(r[4]) }));
}

export type Acked = { word: number; vote: number; question: number; upvote: number };
export type StoredCheck = { ok: boolean; checks: { name: string; expected: number; found: number }[] };

// Every answer the server acknowledged must be in the results exactly once, however often it was resent.
export function checkStoredCounts(rows: CsvRow[], acked: Acked): StoredCheck {
	const sum = (type: string) => rows.filter((r) => r.type === type).reduce((n, r) => n + r.count, 0);
	const checks = [
		{ name: 'words stored (word cloud counts)', expected: acked.word, found: sum('word_cloud') },
		{ name: 'votes stored (poll counts)', expected: acked.vote, found: sum('poll') },
		{ name: 'questions stored (Q&A rows)', expected: acked.question, found: rows.filter((r) => r.type === 'qna').length },
		{ name: 'upvotes stored (Q&A vote counts)', expected: acked.upvote, found: sum('qna') },
	];
	return { ok: checks.every((c) => c.expected === c.found), checks };
}

// ---- the report ----

export type ReportInput = {
	host: string;
	code: string;
	phones: number;
	minutes: number;
	pollMs: number;
	seed: number;
	budget: number;
	local: boolean;
	samples: Sample[];
	submits: { kind: string; outcome: string; replays: number; rateLimited: number }[];
	acked: Acked;
	window: { startMs: number; endMs: number };
	startedAtMs: number;
	endedAtMs: number;
	stored: StoredCheck | null; // null when the results download could not be read
	eventLoop: { p99Ms: number; maxMs: number };
	notes: string[];
};

export function buildReport(input: ReportInput) {
	const from = input.window.startMs - input.startedAtMs;
	const to = input.window.endMs - input.startedAtMs;
	const seconds = Math.max(1, (input.window.endMs - input.window.startMs) / 1000);
	const inWindow = input.samples.filter((s) => s.at >= from && s.at <= to);
	const state = inWindow.filter((s) => s.route === 'state');
	const calls = countFunctionCalls(state, seconds);
	const ackedTotal = input.acked.word + input.acked.vote + input.acked.question + input.acked.upvote;
	const answersPerSecond = Math.round((ackedTotal / seconds) * 100) / 100;
	// An upvote on a question the host had just marked answered is refused by rule (vote_question: "closed"): the
	// phone's list was up to one poll old. Nothing was lost, so it is counted apart, not as a failed submit.
	const raced = input.submits.filter((s) => s.kind === 'upvote' && s.outcome === 'closed');
	const failed = input.submits.filter((s) => s.outcome !== 'ok' && !raced.includes(s));
	const outcomes: Record<string, number> = {};
	for (const s of failed) outcomes[`${s.kind}:${s.outcome}`] = (outcomes[`${s.kind}:${s.outcome}`] ?? 0) + 1;
	const failedSubmits = failed.length;
	// The larger of the two counts: both under-count, and the run should not pass on the smaller one.
	// Without the cache header there is no cache in front (a local server), so every poll ran the function and
	// the count says nothing about the edge: it is left out, not compared with the budget.
	const measured = calls.headerPresent ? [calls.callsPerSecond, calls.generationsPerSecond].filter((n): n is number => n !== null) : [];
	const stateCallsPerSecond = measured.length > 0 ? Math.max(...measured) : null;
	const verdict = verdictFor({ failedSubmits, integrityOk: input.stored?.ok === true, stateCallsPerSecond, answersPerSecond, budget: input.budget, specLine: 2, callsRequired: !input.local });
	return {
		host: input.host,
		local: input.local,
		code: input.code,
		phones: input.phones,
		minutes: input.minutes,
		pollSeconds: input.pollMs / 1000,
		seed: input.seed,
		startedAt: new Date(input.startedAtMs).toISOString(),
		measuredWindow: { start: new Date(input.window.startMs).toISOString(), end: new Date(input.window.endMs).toISOString(), seconds },
		routes: summariseRoutes(input.samples),
		state: { requests: state.length, perSecond: Math.round((state.length / seconds) * 100) / 100, calls },
		submits: {
			total: input.submits.length,
			stored: input.submits.length - failedSubmits - raced.length,
			failed: failedSubmits,
			racedUpvotes: raced.length,
			outcomes,
			replays: input.submits.reduce((n, s) => n + s.replays, 0),
			rateLimitedNotices: input.submits.reduce((n, s) => n + s.rateLimited, 0),
			answersPerSecond,
		},
		stored: input.stored,
		eventLoop: input.eventLoop,
		stateCallsPerSecond,
		budget: input.budget,
		verdict,
		notes: input.notes,
	};
}

export type Report = ReturnType<typeof buildReport>;

const n = (value: number | null, unit = '') => (value === null ? 'n/a' : `${value}${unit}`);

export function reportText(report: Report): string {
	const lines: string[] = [];
	lines.push(`Volley load test: ${report.host}, room ${report.code}`);
	lines.push(`${report.phones} phones for ${report.minutes} minutes, one poll every ${report.pollSeconds}s, seed ${report.seed}`);
	lines.push(`Measured window (first activity opened to last closed): ${report.measuredWindow.start} to ${report.measuredWindow.end} (${Math.round(report.measuredWindow.seconds)}s)`);
	lines.push('  Count Vercel runtime logs between those times. Hobby keeps runtime logs for 1 hour.');
	lines.push('');
	lines.push(`Submits: ${report.submits.total}, stored ${report.submits.stored}, FAILED ${report.submits.failed}` + (report.submits.failed > 0 ? ` (${Object.entries(report.submits.outcomes).filter(([k]) => k !== 'ok').map(([k, v]) => `${k} ${v}`).join(', ')})` : ''));
	if (report.submits.racedUpvotes > 0) lines.push(`  ${report.submits.racedUpvotes} upvote${report.submits.racedUpvotes === 1 ? '' : 's'} reached a question the host had just marked answered: refused by rule (HTTP 409, "closed"), nothing lost, not counted as failed`);
	lines.push(`  ${report.submits.replays} lost replies were resent with the same id; ${report.submits.rateLimitedNotices} "slow down" notices; ${report.submits.answersPerSecond} answers a second`);
	if (report.stored === null) lines.push('Stored counts: could not read the results download, so nothing is proved.');
	else for (const check of report.stored.checks) lines.push(`Stored counts: ${check.name}: expected ${check.expected}, found ${check.found}${check.expected === check.found ? '' : '  <-- MISMATCH'}`);
	lines.push('');
	lines.push('Route                 requests    p50 ms    p95 ms    max ms  statuses');
	for (const [route, summary] of Object.entries(report.routes)) {
		lines.push(`${route.padEnd(20)} ${String(summary.count).padStart(9)} ${n(summary.p50 === null ? null : Math.round(summary.p50)).padStart(9)} ${n(summary.p95 === null ? null : Math.round(summary.p95)).padStart(9)} ${n(summary.max === null ? null : Math.round(summary.max)).padStart(9)}  ${Object.entries(summary.statuses).map(([k, v]) => `${k}:${v}`).join(' ')}`);
	}
	lines.push('');
	const { calls } = report.state;
	lines.push(`State route: ${report.state.requests} requests, ${report.state.perSecond} a second`);
	if (calls.headerPresent) {
		lines.push(`  x-vercel-cache: HIT or STALE ${calls.cached}, anything else ${calls.calls}, no header ${calls.unknown}`);
		lines.push(`  function calls seen in headers: ${n(calls.callsPerSecond)} a second (a LOWER BOUND: background refreshes behind STALE are never seen by a client)`);
	} else lines.push('  no x-vercel-cache header on any state response (not a Vercel deployment): function calls cannot be counted from headers');
	lines.push(`  distinct state versions served (serverNow): ${n(calls.generations)} = ${n(calls.generationsPerSecond)} function runs a second whose result reached a phone (also a lower bound)`);
	lines.push(`  budget: ${report.budget} a second plus ${report.submits.answersPerSecond} answers a second (ADR-004); SPEC A10 as written: 2 plus answers`);
	lines.push(`Event loop lag on this machine: p99 ${report.eventLoop.p99Ms} ms, max ${report.eventLoop.maxMs} ms (high values mean the numbers above are partly this machine)`);
	for (const note of report.notes) lines.push(`Note: ${note}`);
	lines.push('');
	lines.push(`RESULT: ${report.verdict.pass ? 'PASS' : 'FAIL'}${report.verdict.reasons.length > 0 ? ` (${report.verdict.reasons.join('; ')})` : ''}${report.local && report.verdict.pass ? ' (local run: answers and stored counts only; the edge cache and function calls are measured on a deployment)' : ''}`);
	lines.push(`SPEC A10 line (under 2 a second plus answers): ${report.local ? 'not measured locally' : report.verdict.specLinePass ? 'met' : 'not met'}`);
	return lines.join('\n');
}

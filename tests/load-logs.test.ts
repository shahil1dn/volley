// The log counter reads Vercel's runtime logs for a load run (read only) and pages through them, because the
// CLI answers at most 50 rows a call. These tests fake the CLI: it keeps the newest 50 rows in the window,
// whatever --limit says, exactly as the real one did on the A10 run.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Exec } from '../scripts/lib/vercel.ts';
import { MAX_PAGES, PAGE_ROWS, pageLogs, runLoadLogs, type LogRow } from '../scripts/lib/load-logs.ts';

const DPL = 'dpl_DcmoiEqygBVouJw7tUkCZcNnxUfg';
const SINCE = '2026-10-12T00:24:43.234Z';
const UNTIL = '2026-10-12T00:28:43.548Z';
const START = Date.parse(SINCE) + 1000;

const row = (n: number, ts: number, path: string, cache: string): LogRow & Record<string, unknown> => ({
	id: `id${n}`, timestamp: ts, requestPath: path, cache, deploymentId: DPL, requestMethod: 'GET', responseStatusCode: 200, logs: [],
});

// `inclusiveUntil` is how the real boundary behaves; the pager must be right either way.
function fakeCli(rows: ReturnType<typeof row>[], options: { inclusiveUntil?: boolean; deployment?: { target: string | null; alias?: string[] } | 'fail' } = {}) {
	const calls: string[][] = [];
	const exec: Exec = (args) => {
		calls.push(args);
		if (args[0] === 'api') {
			if (options.deployment === 'fail') return { status: 1, stdout: '', stderr: 'Error: not logged in' };
			return { status: 0, stdout: JSON.stringify({ target: options.deployment?.target ?? null, alias: options.deployment?.alias ?? [] }), stderr: '' };
		}
		const flag = (name: string) => args[args.indexOf(name) + 1];
		const since = Date.parse(flag('--since'));
		const until = Date.parse(flag('--until'));
		const wanted = flag('--query')?.replace('cache:', '');
		const hits = rows
			.filter((r) => r.timestamp >= since && (options.inclusiveUntil ? r.timestamp <= until : r.timestamp < until) && (wanted === undefined || r.cache === wanted))
			.sort((a, b) => b.timestamp - a.timestamp);
		return { status: 0, stdout: hits.slice(0, 50).map((r) => JSON.stringify(r)).join('\n'), stderr: '' };
	};
	return { exec, calls };
}

const ask = { deployment: DPL, since: SINCE, until: UNTIL, query: 'cache:STALE' };

test('rows come back 50 a call, newest first, and paging reaches every one, with rows sharing a millisecond across a page boundary', () => {
	// 130 rows, three to a millisecond, so a page boundary falls inside a millisecond.
	const rows = Array.from({ length: 130 }, (_, i) => row(i, START + Math.floor(i / 3), '/api/r/ABCDE/state', 'STALE'));
	for (const inclusiveUntil of [false, true]) {
		const { exec, calls } = fakeCli(rows, { inclusiveUntil });
		const result = pageLogs(exec, ask);
		assert.equal(result.rows.length, 130, `inclusiveUntil=${inclusiveUntil}`);
		assert.equal(new Set(result.rows.map((r) => r.id)).size, 130, 'no row twice');
		assert.equal(result.complete, true);
		assert.equal(result.calls, calls.length);
		assert.ok(result.calls >= 3, 'three pages at least');
	}
});

test('exactly 50 rows takes a second call to find that there are no more; fewer than 50 stops at once', () => {
	const fifty = Array.from({ length: PAGE_ROWS }, (_, i) => row(i, START + i, '/api/r/ABCDE/state', 'STALE'));
	const exact = fakeCli(fifty);
	assert.equal(pageLogs(exact.exec, ask).rows.length, PAGE_ROWS);
	assert.equal(exact.calls.length, 2);
	const few = fakeCli(fifty.slice(0, 49));
	assert.equal(pageLogs(few.exec, ask).rows.length, 49);
	assert.equal(few.calls.length, 1);
	assert.equal(pageLogs(fakeCli([]).exec, ask).rows.length, 0);
});

test('the CLI is asked for a historical read: no follow, no branch filter, JSON, this deployment, this window and this query', () => {
	const { exec, calls } = fakeCli([row(1, START, '/api/r/ABCDE/state', 'STALE')]);
	pageLogs(exec, ask);
	const args = calls[0];
	assert.deepEqual(args.slice(0, 2), ['logs', '--deployment']);
	for (const flag of ['--no-follow', '--no-branch', '--json']) assert.ok(args.includes(flag), flag);
	assert.equal(args[args.indexOf('--deployment') + 1], DPL);
	assert.equal(args[args.indexOf('--since') + 1], SINCE);
	assert.equal(args[args.indexOf('--until') + 1], UNTIL);
	assert.equal(args[args.indexOf('--query') + 1], 'cache:STALE');
});

test('50 rows in one millisecond cannot be paged past: the count is marked incomplete, not silently short', () => {
	const rows = Array.from({ length: 60 }, (_, i) => row(i, START, '/api/r/ABCDE/state', 'STALE'));
	const result = pageLogs(fakeCli(rows).exec, ask);
	assert.equal(result.complete, false);
	assert.equal(result.rows.length, PAGE_ROWS);
	assert.equal(result.calls, 2, 'it gives up as soon as a page adds nothing, not after thousands of calls');
});

test('a runaway read stops at the page cap and says it is incomplete', () => {
	const exec: Exec = (args) => {
		const until = Date.parse(args[args.indexOf('--until') + 1]);
		return { status: 0, stdout: Array.from({ length: 50 }, (_, i) => JSON.stringify(row(until * 100 + i, until - 1 - i, '/api/r/ABCDE/state', 'STALE'))).join('\n'), stderr: '' };
	};
	const result = pageLogs(exec, ask);
	assert.equal(result.complete, false);
	assert.equal(result.calls, MAX_PAGES);
});

test('a CLI failure and a row that is not a log row both stop the count with a reason', () => {
	assert.throws(() => pageLogs(() => ({ status: 1, stdout: '', stderr: 'Error: not logged in' }), ask), /Vercel CLI failed.*not logged in/);
	assert.throws(() => pageLogs(() => ({ status: 0, stdout: 'waiting for new logs...', stderr: '' }), ask), /not a log row/);
	assert.throws(() => pageLogs(() => ({ status: 0, stdout: JSON.stringify({ id: 'x' }), stderr: '' }), ask), /not a log row/);
});

// ---- the command ----

function mixedRun() {
	const rows: ReturnType<typeof row>[] = [];
	let n = 0;
	const add = (count: number, path: string, cache: string) => {
		for (let i = 0; i < count; i++) rows.push(row(n++, START + n, path, cache));
	};
	add(120, '/api/r/ABCDE/answer', 'MISS'); // function calls, not the state route
	add(7, '/r/ABCDE/host', 'MISS');
	add(240, '/api/r/ABCDE/state', 'STALE'); // each may have started one background refresh
	add(6, '/api/r/ABCDE/state', 'MISS'); // a foreground call
	add(500, '/api/r/ABCDE/state', 'HIT'); // never reaches the function
	return rows;
}

function runCommand(argv: string[], cli = fakeCli(mixedRun()), nowMs = Date.parse(UNTIL) + 5 * 60_000) {
	const lines: string[] = [];
	return runLoadLogs(argv, { exec: cli.exec, now: () => nowMs, log: (line) => lines.push(line) }).then((code) => ({ code, text: lines.join('\n'), calls: cli.calls }));
}

test('the count splits MISS from STALE, state from the rest, and gives a lower and an upper bound', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'volley-logs-'));
	const file = join(dir, 'run.json');
	writeFileSync(file, JSON.stringify({ measuredWindow: { start: SINCE, end: UNTIL, seconds: 240.314 }, budget: 15, submits: { answersPerSecond: 4.86 }, state: { calls: { generationsPerSecond: 0.5 } } }));
	const { code, text } = await runCommand(['--deployment', DPL, '--report', file]);
	assert.equal(code, 0, text);
	assert.match(text, /MISS 133 \(state 6\)/);
	assert.match(text, /STALE 240 \(state 240\)/);
	assert.match(text, /\/api\/r\/CODE\/answer 120/);
	assert.match(text, /at least 0\.5 a second/);
	assert.match(text, new RegExp(`at most ${(246 / 240.314).toFixed(2)} a second`));
	assert.match(text, /within the budget of 15 a second plus 4\.86 answers/);
	assert.doesNotMatch(text, /HIT/, 'HIT rows are never asked for: they do not reach the function');
});

test('a count over the budget at its upper bound is a fail (exit 1); a count that is only unproven is said so', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'volley-logs-'));
	const over = join(dir, 'over.json');
	writeFileSync(over, JSON.stringify({ measuredWindow: { start: SINCE, end: new Date(Date.parse(SINCE) + 10_000).toISOString() }, budget: 1, submits: { answersPerSecond: 1 }, state: { calls: { generationsPerSecond: 5 } } }));
	const failing = await runCommand(['--deployment', DPL, '--report', over]);
	assert.equal(failing.code, 1);
	assert.match(failing.text, /OVER the budget/);
	const between = join(dir, 'between.json');
	writeFileSync(between, JSON.stringify({ measuredWindow: { start: SINCE, end: UNTIL, seconds: 240 }, budget: 1, submits: { answersPerSecond: 0 }, state: { calls: { generationsPerSecond: 0.5 } } }));
	const unproven = await runCommand(['--deployment', DPL, '--report', between]);
	assert.equal(unproven.code, 1);
	assert.match(unproven.text, /not proven/);
});

test('--since and --until work without a report, with no budget line', async () => {
	const { code, text } = await runCommand(['--deployment', DPL, '--since', SINCE, '--until', UNTIL]);
	assert.equal(code, 0, text);
	assert.match(text, /at most/);
	assert.doesNotMatch(text, /at least/);
	assert.doesNotMatch(text, /budget/);
});

test('an incomplete page read fails the command even when the counts look fine', async () => {
	const rows = Array.from({ length: 60 }, (_, i) => row(i, START, '/api/r/ABCDE/state', 'STALE'));
	const { code, text } = await runCommand(['--deployment', DPL, '--since', SINCE, '--until', UNTIL], fakeCli(rows));
	assert.equal(code, 1);
	assert.match(text, /INCOMPLETE/);
});

test('logs older than an hour carry a warning, because Hobby keeps an hour', async () => {
	const old = await runCommand(['--deployment', DPL, '--since', SINCE, '--until', UNTIL], fakeCli(mixedRun()), Date.parse(SINCE) + 61 * 60_000);
	assert.match(old.text, /older than an hour/);
	const fresh = await runCommand(['--deployment', DPL, '--since', SINCE, '--until', UNTIL]);
	assert.doesNotMatch(fresh.text, /older than an hour/);
});

test('the same guards as the load test: production, an unanswered lookup, a bad id and a bad window all refuse before any log is read', async () => {
	const refusals: [string[], ReturnType<typeof fakeCli>, RegExp][] = [
		[['--deployment', DPL, '--since', SINCE, '--until', UNTIL], fakeCli([], { deployment: { target: 'production' } }), /production/],
		[['--deployment', DPL, '--since', SINCE, '--until', UNTIL], fakeCli([], { deployment: { target: null, alias: ['AIB-LIVE.vercel.app.'] } }), /production alias/],
		[['--deployment', DPL, '--since', SINCE, '--until', UNTIL], fakeCli([], { deployment: 'fail' }), /could not ask Vercel.*refusing/s],
		[['--deployment', 'https://aib-live.vercel.app', '--since', SINCE, '--until', UNTIL], fakeCli([]), /dpl_/],
		[['--since', SINCE, '--until', UNTIL], fakeCli([]), /--deployment is required/],
		[['--deployment', DPL, '--since', UNTIL, '--until', SINCE], fakeCli([]), /before/],
		[['--deployment', DPL, '--since', 'yesterday', '--until', UNTIL], fakeCli([]), /--since/],
		[['--deployment', DPL], fakeCli([]), /--report, or both --since and --until/],
	];
	for (const [argv, cli, message] of refusals) {
		const { code, text, calls } = await runCommand(argv, cli);
		assert.equal(code, 2, argv.join(' '));
		assert.match(text, message, argv.join(' '));
		assert.ok(calls.every((c) => c[0] === 'api'), `${argv.join(' ')} read logs before refusing`);
	}
});

test('the command only reads: it never calls anything but "logs" and the "api" deployment lookup', async () => {
	const cli = fakeCli(mixedRun());
	await runCommand(['--deployment', DPL, '--since', SINCE, '--until', UNTIL], cli);
	assert.ok(cli.calls.length > 1);
	for (const args of cli.calls) {
		assert.ok(args[0] === 'logs' || (args[0] === 'api' && args.length === 2 && args[1].startsWith('/v13/deployments/')), args.join(' '));
	}
});

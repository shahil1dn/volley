// The report's arithmetic: percentiles, and how function calls are counted from the cache header.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, countFunctionCalls, percentile, reportText, summariseRoutes, verdictFor, type Sample } from '../scripts/lib/load-report.ts';

const sample = (over: Partial<Sample> = {}): Sample => ({ route: 'state', status: 200, ms: 10, cache: null, at: 0, ...over });

test('percentile is nearest-rank: the smallest value with at least p% of the data at or below it', () => {
	const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
	assert.equal(percentile(ten, 50), 5);
	assert.equal(percentile(ten, 95), 10);
	assert.equal(percentile(ten, 90), 9);
	assert.equal(percentile(ten, 100), 10);
	assert.equal(percentile([7], 50), 7);
	assert.equal(percentile([7], 99), 7);
	assert.equal(percentile([], 50), null);
	const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
	assert.equal(percentile(hundred, 95), 95);
	assert.equal(percentile(hundred, 50), 50);
});

test('function calls from the header: HIT and STALE are the cache, every other value is a call, a missing header is unknown', () => {
	const samples = [
		...Array.from({ length: 6 }, () => sample({ cache: 'HIT' })),
		...Array.from({ length: 2 }, () => sample({ cache: 'STALE' })),
		sample({ cache: 'MISS' }),
		sample({ cache: 'BYPASS' }),
		sample({ cache: 'PRERENDER' }),
		sample({ cache: null }),
		sample({ route: 'answer', cache: 'MISS' }),
	];
	const counted = countFunctionCalls(samples.filter((s) => s.route === 'state'), 10);
	assert.deepEqual({ cached: counted.cached, calls: counted.calls, unknown: counted.unknown }, { cached: 8, calls: 3, unknown: 1 });
	assert.equal(counted.callsPerSecond, 0.3);
	assert.equal(counted.headerPresent, true);
});

test('with no x-vercel-cache header anywhere (a local server) nothing is called a call or a hit', () => {
	const counted = countFunctionCalls([sample(), sample(), sample()], 3);
	assert.deepEqual({ cached: counted.cached, calls: counted.calls, unknown: counted.unknown, headerPresent: counted.headerPresent }, { cached: 0, calls: 0, unknown: 3, headerPresent: false });
	assert.equal(counted.callsPerSecond, null);
});

test('distinct generations: each different serverNow in the state bodies is one function run whose result was served', () => {
	const counted = countFunctionCalls([sample({ generation: 1000 }), sample({ generation: 1000 }), sample({ generation: 2000 }), sample({ generation: 3000 }), sample({})], 3);
	assert.equal(counted.generations, 3);
	assert.equal(counted.generationsPerSecond, 1);
});

test('route summaries give count, statuses, p50, p95 and max per route', () => {
	const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((ms) => sample({ ms })).concat([sample({ route: 'answer', status: 429, ms: 50 })]);
	const routes = summariseRoutes(samples);
	assert.equal(routes.state.count, 10);
	assert.equal(routes.state.p50, 5);
	assert.equal(routes.state.p95, 10);
	assert.equal(routes.state.max, 10);
	assert.deepEqual(routes.state.statuses, { 200: 10 });
	assert.deepEqual(routes.answer.statuses, { 429: 1 });
});

test('the verdict needs zero failed submits, intact stored counts and calls under the budget plus answers', () => {
	const base = { failedSubmits: 0, integrityOk: true, stateCallsPerSecond: 8, answersPerSecond: 2, budget: 15 };
	assert.equal(verdictFor(base).pass, true);
	assert.equal(verdictFor({ ...base, failedSubmits: 1 }).pass, false);
	assert.equal(verdictFor({ ...base, integrityOk: false }).pass, false);
	assert.equal(verdictFor({ ...base, stateCallsPerSecond: 17.5 }).pass, false);
	assert.equal(verdictFor({ ...base, stateCallsPerSecond: 17 }).pass, true, 'the line is budget + answers per second, inclusive');
	assert.equal(verdictFor({ ...base, stateCallsPerSecond: null }).pass, false, 'no measurement is not a pass');
	assert.deepEqual(Object.keys(verdictFor(base)).sort(), ['pass', 'reasons'], 'one line only: the ADR-004 budget; SPEC A10 points at it');
});

test('the report names the ADR-004 budget as the one line and no longer prints the old 2-a-second line', () => {
	const input = {
		host: 'x.vercel.app', local: false, code: 'ABCDE', phones: 2, minutes: 1, pollMs: 3000, seed: 1, budget: 15, samples: [sample({ at: 10, cache: 'HIT', generation: 1 })],
		submits: [{ kind: 'word', outcome: 'ok', replays: 0, rateLimited: 0 }], acked: { word: 1, vote: 0, question: 0, upvote: 0 },
		window: { startMs: 1000, endMs: 11000 }, startedAtMs: 1000, endedAtMs: 12000, stored: { ok: true, checks: [] }, eventLoop: { p99Ms: 1, maxMs: 2 }, notes: [],
	};
	const text = reportText(buildReport(input));
	assert.doesNotMatch(text, /SPEC A10/);
	assert.doesNotMatch(text, /under 2 a second/);
	assert.match(text, /budget: 15 a second plus [\d.]+ answers a second \(ADR-004\)/);
});

test('a local run (no cache header) passes on submits and stored counts alone and says the calls were not measured', () => {
	const base = { failedSubmits: 0, integrityOk: true, stateCallsPerSecond: null, answersPerSecond: 1, budget: 15 };
	assert.equal(verdictFor({ ...base, callsRequired: false }).pass, true);
	assert.equal(verdictFor({ ...base, callsRequired: false, failedSubmits: 2 }).pass, false, 'a failed submit still fails a local run');
	assert.equal(verdictFor({ ...base, callsRequired: false, integrityOk: false }).pass, false);
	assert.equal(verdictFor(base).pass, false, 'on a deployment, no measurement is a fail');

	const input = {
		host: 'localhost:5173', code: 'ABCDE', phones: 2, minutes: 1, pollMs: 3000, seed: 1, budget: 15, samples: [sample({ at: 10, generation: 1 }), sample({ at: 20, generation: 2 })],
		submits: [{ kind: 'word', outcome: 'ok', replays: 0, rateLimited: 0 }], acked: { word: 1, vote: 0, question: 0, upvote: 0 },
		window: { startMs: 1000, endMs: 11000 }, startedAtMs: 1000, endedAtMs: 12000,
		stored: { ok: true, checks: [] }, eventLoop: { p99Ms: 1, maxMs: 2 }, notes: [],
	};
	const local = reportText(buildReport({ ...input, local: true }));
	assert.match(local, /RESULT: PASS \(local run/);
	assert.match(local, /function calls are measured on a deployment/);
	const remote = buildReport({ ...input, local: false });
	assert.equal(remote.verdict.pass, false, 'the same samples on a deployment have no cache header, so no measurement');
});

test('an upvote on a question the host just answered is counted apart; any other refusal is a failed submit', () => {
	const submit = (kind: string, outcome: string) => ({ kind, outcome, replays: 0, rateLimited: 0 });
	const input = {
		host: 'x.vercel.app', local: false, code: 'ABCDE', phones: 2, minutes: 1, pollMs: 3000, seed: 1, budget: 15,
		samples: [sample({ at: 10, cache: 'HIT', generation: 1 })], acked: { word: 1, vote: 0, question: 0, upvote: 0 },
		window: { startMs: 1000, endMs: 11000 }, startedAtMs: 1000, endedAtMs: 12000, stored: { ok: true, checks: [] }, eventLoop: { p99Ms: 1, maxMs: 2 }, notes: [],
	};
	const raced = buildReport({ ...input, submits: [submit('word', 'ok'), submit('upvote', 'closed')] });
	assert.equal(raced.submits.failed, 0);
	assert.equal(raced.submits.racedUpvotes, 1);
	assert.equal(raced.submits.stored, 1);
	assert.match(reportText(raced), /refused by rule/);
	const late = buildReport({ ...input, submits: [submit('word', 'closed'), submit('upvote', 'closed'), submit('question', 'network')] });
	assert.equal(late.submits.failed, 2, 'a word that arrived after the item closed, and a lost question, are failures');
	assert.deepEqual(late.submits.outcomes, { 'word:closed': 1, 'question:network': 1 });
	assert.equal(late.verdict.pass, false);
});

// The report's arithmetic: percentiles, and how function calls are counted from the cache header.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countFunctionCalls, percentile, summariseRoutes, verdictFor, type Sample } from '../scripts/lib/load-report.ts';

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
	const base = { failedSubmits: 0, integrityOk: true, stateCallsPerSecond: 8, answersPerSecond: 2, budget: 15, specLine: 2 };
	assert.equal(verdictFor(base).pass, true);
	assert.equal(verdictFor({ ...base, failedSubmits: 1 }).pass, false);
	assert.equal(verdictFor({ ...base, integrityOk: false }).pass, false);
	assert.equal(verdictFor({ ...base, stateCallsPerSecond: 17.5 }).pass, false);
	assert.equal(verdictFor({ ...base, stateCallsPerSecond: 17 }).pass, true, 'the line is budget + answers per second, inclusive');
	assert.equal(verdictFor({ ...base, stateCallsPerSecond: null }).pass, false, 'no measurement is not a pass');
	// SPEC A10's own line (under 2 a second plus answers) is reported next to the ADR-004 budget, not instead of it.
	assert.equal(verdictFor(base).specLinePass, false);
	assert.equal(verdictFor({ ...base, stateCallsPerSecond: 3.9 }).specLinePass, true);
});

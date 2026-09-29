// S1 load test: can Vercel's CDN absorb a room of phones polling the shared state?
// Seeds a throwaway room, polls it from many simulated clients, deletes the room.
//   node --env-file=.env.local scripts/load/poll.mjs <deployment-url> [clients] [seconds] [poll-every-seconds] [run-name]
// The summary is written to scripts/load/run-<run-name>.json.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

const [baseUrl, clientsArg = '200', secondsArg = '120', intervalArg = '1', runName = 'last'] = process.argv.slice(2);
if (!baseUrl?.startsWith('https://')) throw new Error('Pass the deployment URL, starting https://');
const clients = Number(clientsArg);
const seconds = Number(secondsArg);
const intervalMs = Number(intervalArg) * 1000;
const { SUPABASE_URL, SUPABASE_SECRET_KEY, VERCEL_AUTOMATION_BYPASS_SECRET } = process.env;
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) throw new Error('Run with --env-file=.env.local');
if (!VERCEL_AUTOMATION_BYPASS_SECRET) throw new Error('VERCEL_AUTOMATION_BYPASS_SECRET is not set');

const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code = Array.from({ length: 5 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

const tally = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

async function pollAsOneClient(url, startAt, endAt, results) {
	// Ticks are fixed to the client's own clock, so a slow response is followed by
	// the next scheduled poll rather than an immediate catch-up burst.
	for (let tick = startAt; tick < endAt; tick += intervalMs) {
		const wait = tick - Date.now();
		if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
		else if (wait < -intervalMs) {
			results.skippedTicks++;
			continue;
		}
		const sentAt = performance.now();
		try {
			const res = await fetch(url, { headers: { 'x-vercel-protection-bypass': VERCEL_AUTOMATION_BYPASS_SECRET } });
			await res.arrayBuffer();
			results.latencies.push(performance.now() - sentAt);
			tally(results.status, res.status);
			tally(results.cache, res.headers.get('x-vercel-cache') ?? '(none)');
			tally(results.edge, (res.headers.get('x-vercel-id') ?? '(none)').split('::')[0]);
			const age = res.headers.get('age');
			if (age !== null) {
				results.withAge++;
				tally(results.ages, age);
			}
		} catch (err) {
			tally(results.networkErrors, err.cause?.code ?? err.name);
		}
	}
}

const { error: seedError } = await db.from('sessions').insert({
	code,
	question: 'S1 load test (throwaway)',
	host_token_hash: createHash('sha256').update(randomBytes(24)).digest('hex'),
});
if (seedError) throw new Error(`Could not seed the test room: ${seedError.message}`);

try {
	const url = `${baseUrl.replace(/\/$/, '')}/api/r/${code}/state`;
	const results = {
		latencies: [],
		status: new Map(),
		cache: new Map(),
		edge: new Map(),
		ages: new Map(),
		networkErrors: new Map(),
		withAge: 0,
		skippedTicks: 0,
	};
	const runStart = Date.now() + 2000;
	const runEnd = runStart + seconds * 1000;
	console.log(`Room ${code}: ${clients} clients, one poll every ${intervalArg}s, for ${seconds}s`);
	console.log(`RUN_WINDOW ${new Date(runStart).toISOString()} ${new Date(runEnd).toISOString()}`);
	// Real phones don't poll in lockstep, so each client starts at a random point
	// in the first interval.
	await Promise.all(
		Array.from({ length: clients }, () => pollAsOneClient(url, runStart + randomInt(intervalMs), runEnd, results)),
	);

	const sorted = results.latencies.toSorted((a, b) => a - b);
	const summary = {
		code,
		clients,
		seconds,
		pollEverySeconds: Number(intervalArg),
		window: { start: new Date(runStart).toISOString(), end: new Date(runEnd).toISOString() },
		requests: sorted.length + [...results.networkErrors.values()].reduce((a, b) => a + b, 0),
		status: Object.fromEntries(results.status),
		xVercelCache: Object.fromEntries(results.cache),
		edgeRegion: Object.fromEntries(results.edge),
		ageHeaderPresent: results.withAge,
		ageValues: Object.fromEntries(results.ages),
		networkErrors: Object.fromEntries(results.networkErrors),
		skippedTicks: results.skippedTicks,
		latencyMs: { p50: Math.round(percentile(sorted, 50)), p95: Math.round(percentile(sorted, 95)), max: Math.round(sorted.at(-1)) },
	};
	await writeFile(new URL(`./run-${runName}.json`, import.meta.url), JSON.stringify(summary, null, 2));
	console.log(JSON.stringify(summary, null, 2));
} finally {
	const { error: deleteError } = await db.from('sessions').delete().eq('code', code);
	console.log(deleteError ? `CLEANUP FAILED for room ${code}: ${deleteError.message}` : `Room ${code} deleted.`);
}

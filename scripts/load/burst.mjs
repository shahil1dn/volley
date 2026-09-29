// S7 burst test: a room of phones joins, then everyone sends 3 words within a
// few seconds, the way a real room answers a new question.
//   node --env-file=.env.local scripts/load/burst.mjs <base-url> [phones] [run-name]
// Seeds a live room, runs, prints and saves a summary to
// scripts/load/burst-<run-name>.json, then deletes the room.
// Sends x-vercel-protection-bypass when VERCEL_AUTOMATION_BYPASS_SECRET is set.
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { connectAsOwner } from '../pg-connect.ts';
import { makeRun } from '../../tests/db-helpers.ts';

const [baseArg, phonesArg = '200', runName = 'last'] = process.argv.slice(2);
if (!/^https?:\/\//.test(baseArg ?? '')) throw new Error('Pass the base URL, e.g. http://localhost:5173');
const base = baseArg.replace(/\/$/, '');
const phones = Number(phonesArg);
const WORDS_EACH = 3;
const JOIN_SPREAD_MS = 2000;
const BURST_SPREAD_MS = 5000;
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
	? { 'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET }
	: {};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tally = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

// Returns the participant cookie the answer route sets on join.
async function join(code) {
	const response = await fetch(`${base}/api/r/${code}/answer`, { headers: bypass });
	const cookie = response.headers.getSetCookie().find((line) => line.startsWith('volley_participant='));
	if (!response.ok || !cookie) throw new Error(`join failed: HTTP ${response.status}`);
	return cookie.split(';')[0];
}

async function answer(code, cookie, value, results) {
	const sentAt = performance.now();
	try {
		const response = await fetch(`${base}/api/r/${code}/answer`, {
			method: 'POST',
			headers: { ...bypass, cookie, 'content-type': 'application/json' },
			body: JSON.stringify({ submitId: randomUUID(), value }),
		});
		const body = await response.json().catch(() => ({}));
		results.latencies.push(performance.now() - sentAt);
		tally(results.http, response.status);
		tally(results.status, body.status ?? '(no status)');
	} catch (err) {
		tally(results.networkErrors, err.cause?.code ?? err.name);
	}
}

const db = await connectAsOwner();
const startedAt = new Date();
const room = await makeRun(db, { settings: { prompt: 'Burst test (throwaway)' } });
try {
	const results = { latencies: [], http: new Map(), status: new Map(), networkErrors: new Map(), joinFailures: 0 };
	console.log(`Room ${room.code}: ${phones} phones × ${WORDS_EACH} words against ${base}`);

	const cookies = await Promise.all(
		Array.from({ length: phones }, async () => {
			await sleep(Math.random() * JOIN_SPREAD_MS);
			return join(room.code).catch(() => {
				results.joinFailures++;
				return null;
			});
		}),
	);

	const burstStart = performance.now();
	await Promise.all(
		cookies.flatMap((cookie, phone) =>
			cookie
				? Array.from({ length: WORDS_EACH }, async (_, i) => {
						await sleep(Math.random() * BURST_SPREAD_MS);
						await answer(room.code, cookie, `phone ${phone} word ${i}`, results);
					})
				: [],
		),
	);
	const burstSeconds = (performance.now() - burstStart) / 1000;

	const stored = await db.query(
		`select (select count(*) from public.responses where run_id = $1)::int as responses,
		        (select coalesce(sum(count), 0) from public.tallies where run_id = $1)::int as tallied`,
		[room.runId],
	);
	const sorted = results.latencies.toSorted((a, b) => a - b);
	const summary = {
		code: room.code,
		base,
		phones,
		joinFailures: results.joinFailures,
		answersSent: phones * WORDS_EACH,
		burstSeconds: Number(burstSeconds.toFixed(1)),
		byStatus: Object.fromEntries(results.status),
		byHttp: Object.fromEntries(results.http),
		networkErrors: Object.fromEntries(results.networkErrors),
		serverErrors: [...results.http].filter(([code]) => code >= 500).reduce((sum, [, n]) => sum + n, 0),
		stored: stored.rows[0],
		latencyMs: sorted.length
			? { p50: Math.round(percentile(sorted, 50)), p95: Math.round(percentile(sorted, 95)), max: Math.round(sorted.at(-1)) }
			: null,
	};
	await writeFile(new URL(`./burst-${runName}.json`, import.meta.url), JSON.stringify(summary, null, 2));
	console.log(JSON.stringify(summary, null, 2));
} finally {
	await db.query('delete from auth.users where id = $1', [room.userId]);
	await db.query(
		`delete from public.rate_limits where key = $1 or (key like 'ip:%' and window_start >= $2::timestamptz - interval '10 seconds')`,
		[`run:${room.runId}`, startedAt],
	);
	await db.end();
	console.log(`Room ${room.code} deleted.`);
}

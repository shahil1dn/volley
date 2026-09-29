// Why is a burst of answers slow? (S7 follow-up.) Times 600 submit_answer calls
// (200 phones × 3 words, one room) in several variants and samples what the
// database is waiting on while they run. Variants are scratch copies of the
// shipped function in a throwaway schema; the shipped one is only called, never
// changed. Everything made here is deleted at the end.
//   node --env-file=.env.local scripts/load/diagnose-submit.mjs > results.json
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { connectAsOwner } from '../pg-connect.ts';
import { makeRun } from '../../tests/db-helpers.ts';

const PHONES = 200;
const WORDS_EACH = 3;
const DB_WORKERS = 10; // with setup and the sampler, inside the pooler's 15 clients
const SAMPLE_MS = 25;

const migration = await readFile(new URL('../../db/migrations/0004_campus_ip_limit.sql', import.meta.url), 'utf8');
const shipped = migration.slice(migration.indexOf('create or replace function public.submit_answer('), migration.lastIndexOf('$$;') + 3);

const IP_COUNTER = `	insert into public.rate_limits as r (key, window_start, count)
	values ('ip:' || p_ip_hash, v_window, 1)
	on conflict (key, window_start) do update set count = r.count + 1
	returning r.count into v_hits;
	if v_hits > ip_limit then
		return jsonb_build_object('status', 'rate_limited');
	end if;
`;
const RUN_COUNTER = `	insert into public.rate_limits as r (key, window_start, count)
	values ('run:' || v_run.id, v_window, 1)
	on conflict (key, window_start) do update set count = r.count + 1
	returning r.count into v_hits;
	if v_hits > run_limit then
		return jsonb_build_object('status', 'rate_limited');
	end if;
`;
const VERSION_BUMP = `	update public.runs set version = version + 1, last_activity_at = now() where id = v_run.id;
`;
const FINAL_RETURN = `	return jsonb_build_object('status', 'ok', 'left', v_limit - v_used);
end;`;
const COUNTERS_LAST = `	insert into public.rate_limits as r (key, window_start, count) values ('ip:' || p_ip_hash, v_window, 1)
	on conflict (key, window_start) do update set count = r.count + 1;
	insert into public.rate_limits as r (key, window_start, count) values ('run:' || v_run.id, v_window, 1)
	on conflict (key, window_start) do update set count = r.count + 1;
`;

function scratchFunction(name, edits) {
	let sql = shipped.replace('create or replace function public.submit_answer(', `create function volley_diag.submit_${name}(`);
	for (const [from, to] of edits) {
		if (!sql.includes(from)) throw new Error(`variant ${name}: text not found`);
		sql = sql.replace(from, to);
	}
	return sql;
}

// One shared address per variant, so back-to-back variants can't add up past
// the per-IP cap inside one window and pollute each other.
const oneIp = (_phone, tag) => `burst-ip-${tag}`;
const ipPerPhone = (phone, tag) => `phone-ip-${tag}-${phone}`;
const DB_VARIANTS = [
	{ name: 'a_as_shipped', fn: 'volley_diag.submit_a', edits: [], ipFor: oneIp },
	{ name: 'b_ip_per_phone', fn: 'volley_diag.submit_a', edits: null, ipFor: ipPerPhone },
	{ name: 'c_counters_last', fn: 'volley_diag.submit_c', edits: [[IP_COUNTER, ''], [RUN_COUNTER, ''], [VERSION_BUMP, VERSION_BUMP + COUNTERS_LAST]], ipFor: oneIp },
	{ name: 'd_no_version_bump', fn: 'volley_diag.submit_d', edits: [[VERSION_BUMP, '']], ipFor: oneIp },
	{ name: 'e_no_run_counter', fn: 'volley_diag.submit_e', edits: [[RUN_COUNTER, '']], ipFor: oneIp },
	{ name: 'f_no_shared_rows', fn: 'volley_diag.submit_f', edits: [[RUN_COUNTER, ''], [VERSION_BUMP, '']], ipFor: ipPerPhone },
];

const tally = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
const pct = (sorted, p) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);

function jobsFor(room, ipFor, tag) {
	const phones = Array.from({ length: PHONES }, () => randomUUID());
	const jobs = phones.flatMap((participant, phone) =>
		Array.from({ length: WORDS_EACH }, (_, word) => ({ participant, value: `p${phone} w${word}`, ip: ipFor(phone, tag) })),
	);
	// Real phones interleave; shuffling keeps one phone's 3 words from running back to back.
	for (let i = jobs.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[jobs[i], jobs[j]] = [jobs[j], jobs[i]];
	}
	return jobs.map((job) => ({ ...job, code: room.code, submitId: randomUUID() }));
}

async function measure(label, jobs, concurrency, call, sampler) {
	const latencies = [];
	const statuses = new Map();
	let next = 0;
	const stopSampling = sampler?.start();
	const started = performance.now();
	await Promise.all(
		Array.from({ length: concurrency }, async (_, worker) => {
			while (next < jobs.length) {
				const job = jobs[next++];
				const sentAt = performance.now();
				tally(statuses, (await call(job, worker)).status);
				latencies.push(performance.now() - sentAt);
			}
		}),
	);
	const seconds = (performance.now() - started) / 1000;
	const waits = stopSampling ? await stopSampling() : undefined;
	const sorted = latencies.toSorted((a, b) => a - b);
	return {
		label,
		concurrency,
		calls: jobs.length,
		seconds: Number(seconds.toFixed(2)),
		perSecond: Math.round(jobs.length / seconds),
		latencyMs: { p50: pct(sorted, 50), p95: pct(sorted, 95), max: pct(sorted, 100) },
		statuses: Object.fromEntries(statuses),
		...(waits ? { waits } : {}),
	};
}

// Counts, over samples every SAMPLE_MS, what each busy submit call was waiting on.
function lockSampler(client) {
	return {
		start() {
			const seen = new Map();
			let samples = 0;
			let running = true;
			const loop = (async () => {
				while (running) {
					const { rows } = await client.query(
						`select coalesce(wait_event_type || ':' || wait_event, 'running') as waiting_on, count(*)::int as n
						 from pg_stat_activity
						 where datname = current_database() and state = 'active' and pid <> pg_backend_pid()
						   and query like '%submit_%'
						 group by 1`,
					);
					samples++;
					for (const { waiting_on, n } of rows) seen.set(waiting_on, (seen.get(waiting_on) ?? 0) + n);
					await new Promise((resolve) => setTimeout(resolve, SAMPLE_MS));
				}
			})();
			return () => {
				running = false;
				return loop.then(() => ({ samples, busyCallsByWait: Object.fromEntries([...seen].sort((a, b) => b[1] - a[1])) }));
			};
		},
	};
}

const setup = await connectAsOwner();
const sampling = await connectAsOwner();
const workers = await Promise.all(Array.from({ length: DB_WORKERS }, () => connectAsOwner()));
const rest = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const rooms = [];
const startedAt = new Date();
const results = [];
try {
	await setup.query('create schema volley_diag; revoke all on schema volley_diag from public');
	for (const variant of DB_VARIANTS) if (variant.edits) await setup.query(scratchFunction(variant.fn.split('_').pop(), variant.edits));

	// How long one round trip takes from here, to read latencies against.
	const rtt = await measure('baseline: select 1', Array.from({ length: 200 }, () => ({})), DB_WORKERS, async (_, w) => {
		await workers[w].query('select 1');
		return { status: 'ok' };
	});
	results.push(rtt);

	for (const variant of DB_VARIANTS) {
		const room = await makeRun(setup, { settings: { prompt: `diagnose ${variant.name}` } });
		rooms.push(room);
		const sampler = variant.name.startsWith('a_') ? lockSampler(sampling) : null;
		results.push(await measure(`db direct: ${variant.name}`, jobsFor(room, variant.ipFor, variant.name), DB_WORKERS, async (job, w) => {
			const { rows } = await workers[w].query(`select ${variant.fn}($1, $2, $3, $4, $5) as r`, [job.code, job.participant, job.submitId, job.value, job.ip]);
			return rows[0].r;
		}, sampler));
	}

	// The real path: the shipped function through supabase-js → PostgREST.
	for (const [concurrency, ipFor, label] of [[10, oneIp, 'one IP'], [100, oneIp, 'one IP'], [100, ipPerPhone, 'IP per phone']]) {
		const room = await makeRun(setup, { settings: { prompt: 'diagnose rest' } });
		rooms.push(room);
		results.push(await measure(`postgrest rpc, ${label}`, jobsFor(room, ipFor, `rest-${concurrency}-${label}`), concurrency, async (job) => {
			const { data, error } = await rest.rpc('submit_answer', {
				p_code: job.code, p_participant_id: job.participant, p_submit_id: job.submitId, p_value: job.value, p_ip_hash: job.ip,
			});
			return error ? { status: `error:${error.code}` } : data;
		}));
	}
	// Is the ceiling the answer function, or every call through the Data API?
	// A no-op call (no such room) and an endpoint that never touches the database.
	const noop = () => rest.rpc('get_state', { p_code: 'ZZZZZ' }).then(() => ({ status: 'ok' }));
	for (const [calls, concurrency] of [[30, 1], [300, 10], [600, 100]]) {
		results.push(await measure('postgrest rpc: get_state for no room', Array.from({ length: calls }, () => ({})), concurrency, noop));
	}
	results.push(await measure('auth /health (no database)', Array.from({ length: 300 }, () => ({})), 10, () =>
		fetch(`${process.env.SUPABASE_URL}/auth/v1/health`, { headers: { apikey: process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY } })
			.then((response) => response.arrayBuffer())
			.then(() => ({ status: 'ok' })),
	));
	console.log(JSON.stringify(results, null, 2));
} finally {
	await setup.query('drop schema if exists volley_diag cascade');
	for (const room of rooms) await setup.query('delete from auth.users where id = $1', [room.userId]);
	await setup.query(
		`delete from public.rate_limits
		 where key = any($1) or ((key like 'ip:burst-ip-%' or key like 'ip:phone-ip-%') and window_start >= $2::timestamptz - interval '10 seconds')`,
		[rooms.map((room) => `run:${room.runId}`), startedAt],
	);
	await Promise.all([setup, sampling, ...workers].map((client) => client.end()));
	console.error(`Cleaned up ${rooms.length} rooms, the scratch schema and their rate rows.`);
}

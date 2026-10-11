// 200 simulated phones, one host and a projector, driven through the app's real routes with the phone page's
// real poll interval, request shapes and retry rules (src/routes/j/[code]/+page.svelte, which this mirrors:
// POLL_MS 3000, RETRY_DELAYS_MS [1000, 2500], a 401 re-joins once, only a network error or a 5xx is retried,
// and the same submitId rides every retry of one answer). Built-in fetch only. This module never reads a
// file or the environment: everything it needs, including secrets, is handed in, and nothing it returns
// contains one.
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { HostLogin } from './load-guard.ts';
import type { Route, Sample } from './load-report.ts';

export type LoadConfig = {
	base: URL;
	login: HostLogin;
	bypassSecret?: string;
	phones: number;
	minutes: number;
	pollMs: number; // the phone page's POLL_MS
	projectorPollMs: number; // the projector page's POLL_MS
	hostPollMs: number; // the control page's POLL_MS
	projectors: number;
	replayRate: number; // chance a reply is treated as lost, to exercise the retry and its idempotency id
	retryDelaysMs: number[];
	userRepressMs: number; // a person pressing Send again after a notice
	joinSpreadMs: number;
	seed: number;
	log: (line: string) => void;
};

export const DEFAULTS = { phones: 200, minutes: 10, pollMs: 3000, projectorPollMs: 1000, hostPollMs: 2000, projectors: 1, replayRate: 0.01, retryDelaysMs: [1000, 2500], userRepressMs: 4000, joinSpreadMs: 5000 };

export type SubmitKind = 'word' | 'vote' | 'question' | 'upvote';
export type SubmitRecord = { kind: SubmitKind; outcome: string; replays: number; rateLimited: number };

export type RoomState = {
	status: string;
	version: number;
	currentPosition: number;
	itemState: string;
	serverNow: number;
	item: { type: string; settings: Record<string, unknown> } | null;
	questions: [number, string, number][];
};

export type LoadResult = {
	code: string;
	samples: Sample[];
	submits: SubmitRecord[];
	acked: Record<SubmitKind, number>; // answers the server said it stored
	window: { startMs: number; endMs: number }; // epoch ms: first activity opened to last one closed
	startedAtMs: number;
	endedAtMs: number;
	csv: string | null; // the host's results download, for the stored-counts check
	eventLoop: { p99Ms: number; maxMs: number };
	notes: string[];
};

export class LoadError extends Error {}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Small seeded generator (mulberry32) so a run can be repeated.
function generator(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const SYLLABLES = ['ka', 'lo', 'mi', 'ra', 'tu', 'ne', 'so', 'vi', 'ba', 'de', 'fu', 'gi'];
// 48 distinct words: few enough that the word cloud stays readable and under any list cap.
const WORDS = SYLLABLES.flatMap((a, i) => SYLLABLES.slice(i, i + 4).map((b) => `${a}${b}`));
const QUESTIONS = ['How long does this take?', 'Can we see the slides afterwards?', 'What happens if I join late?', 'Who built this?', 'Is this free to use?', 'Will there be a recording?'];

export async function runLoad(config: LoadConfig): Promise<LoadResult> {
	const rng = generator(config.seed);
	const pick = <T>(list: readonly T[]): T => list[Math.floor(rng() * list.length)];
	const between = (low: number, high: number) => low + rng() * (high - low);
	const t0 = Date.now();
	const samples: Sample[] = [];
	const submits: SubmitRecord[] = [];
	const acked: Record<SubmitKind, number> = { word: 0, vote: 0, question: 0, upvote: 0 };
	const notes: string[] = [];
	const lag = monitorEventLoopDelay({ resolution: 10 });
	lag.enable();

	const baseHeaders: Record<string, string> = config.bypassSecret ? { 'x-vercel-protection-bypass': config.bypassSecret } : {};

	type Reply = { status: number; text: string; headers: Headers };
	// One request, timed and recorded. A network failure is recorded as status 0 and thrown.
	async function http(route: Route, path: string, init: RequestInit = {}, generation?: (text: string) => number | undefined): Promise<Reply> {
		const started = performance.now();
		const at = Date.now() - t0;
		try {
			const response = await fetch(new URL(path, config.base), { ...init, headers: { ...baseHeaders, ...(init.headers as Record<string, string>) }, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
			const text = await response.text();
			samples.push({ route, status: response.status, ms: performance.now() - started, cache: response.headers.get('x-vercel-cache'), at, generation: generation?.(text) });
			return { status: response.status, text, headers: response.headers };
		} catch (error) {
			samples.push({ route, status: 0, ms: performance.now() - started, cache: null, at });
			throw error;
		}
	}

	const cookieFrom = (headers: Headers, name: string): string | null => headers.getSetCookie().find((line) => line.startsWith(`${name}=`))?.split(';')[0] ?? null;
	const json = (text: string): any => {
		try {
			return JSON.parse(text);
		} catch {
			return null;
		}
	};

	// ---- the host: sign in, start a session of the three activity types ----
	const origin = config.base.origin;
	const protectionHint = 'The deployment answered 401 from Vercel Deployment Protection. Pass the project\'s Protection Bypass for Automation secret in VERCEL_AUTOMATION_BYPASS_SECRET.';

	const signIn = await http('sign-in', '/', {
		method: 'POST',
		headers: { origin, accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ email: config.login.email, password: config.login.password }).toString(),
	});
	const hostCookie = cookieFrom(signIn.headers, 'volley_host');
	if (signIn.status === 401 && signIn.headers.get('server')?.toLowerCase() === 'vercel') throw new LoadError(protectionHint);
	if (signIn.status === 429) throw new LoadError('Host sign-in is rate limited (10 attempts per email and 30 per address in 15 minutes). Wait 15 minutes; nothing was weakened.');
	if (signIn.status !== 303 || !hostCookie) throw new LoadError(`Host sign-in failed (HTTP ${signIn.status}). The host in the host file must exist on the database this deployment uses (make it with npm run load-host).`);

	const hostSession: string = hostCookie;
	const hostHeaders = (extra: Record<string, string> = {}) => ({ cookie: hostSession, origin, ...extra });
	const session = new URLSearchParams();
	const activities: [string, string, string[]?][] = [
		['word_cloud', 'Load test: one word for how you feel', undefined],
		['poll', 'Load test: pick one', ['Red', 'Green', 'Blue']],
		['qna', 'Load test: ask anything', undefined],
	];
	activities.forEach(([type, prompt, options], index) => {
		session.append('type', type);
		session.append('prompt', prompt);
		for (const option of options ?? []) session.append(`options${index}`, option);
	});
	const started = await http('start-session', '/decks?/startSession', { method: 'POST', headers: hostHeaders({ accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' }), body: session.toString() });
	const code = /\/run\/([A-Z0-9]{5})\/control/.exec(started.headers.get('location') ?? '')?.[1];
	if (started.status !== 303 || !code) throw new LoadError(`Starting the session failed (HTTP ${started.status}).`);
	config.log(`Room ${code}: ${config.phones} phones, ${config.minutes} minute${config.minutes === 1 ? '' : 's'}, one poll every ${config.pollMs / 1000}s`);

	async function hostAction(action: string, key?: string): Promise<{ status: number; body: any }> {
		const reply = await http('host-action', `/api/r/${code}/host`, { method: 'POST', headers: hostHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ action, key }) });
		return { status: reply.status, body: json(reply.text) };
	}
	const hostView = async () => json((await http('host-view', `/api/r/${code}/host`, { headers: hostHeaders(), cache: 'no-store' })).text);

	// ---- the phones ----
	let done = false;
	let phaseMs = (config.minutes * 60_000) / 3;
	const phaseShare = [0.3, 0.3, 0.4];

	async function runPhone() {
		await sleep(rng() * config.joinSpreadMs);
		let cookie = '';
		const join = async () => {
			const reply = await http('join', `/api/r/${code}/answer`, { cache: 'no-store' }).catch(() => null);
			cookie = (reply && cookieFrom(reply.headers, 'volley_participant')) ?? cookie;
		};
		await http('page', `/j/${code}`).catch(() => undefined);
		await join();

		let room: RoomState | null = null;
		const upvoted = new Set<number>();
		const acted = new Set<number>();
		const work: Promise<void>[] = [];

		const post = (body: object) => http('answer', `/api/r/${code}/answer`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });

		async function submitWithRetries(body: object): Promise<{ status: string; voted?: boolean; replays: number }> {
			let replays = 0;
			for (let attempt = 0; attempt <= config.retryDelaysMs.length; attempt++) {
				if (attempt > 0) await sleep(config.retryDelaysMs[attempt - 1]);
				try {
					let reply = await post(body);
					if (reply.status === 401) {
						await join();
						reply = await post(body);
					}
					if (reply.status >= 500) continue;
					// A reply that never arrives: the server did the work, the phone does not know.
					if (rng() < config.replayRate) {
						replays++;
						continue;
					}
					return { ...(json(reply.text) ?? { status: 'bad_reply' }), replays };
				} catch {
					// the request or its answer was lost: try again with the same submit id
				}
			}
			return { status: 'network', replays };
		}

		// Pressing Send, then Send again after a notice (the page keeps the same id after a network
		// failure or a busy room), as a person would.
		async function deliver(kind: SubmitKind, body: object) {
			let rateLimited = 0;
			let replays = 0;
			let last = 'network';
			for (let press = 0; press < 3; press++) {
				if (press > 0) await sleep(config.userRepressMs);
				const result = await submitWithRetries(body);
				replays += result.replays;
				last = result.status;
				if (result.status === 'ok' && (kind !== 'upvote' || result.voted === true)) {
					acked[kind]++;
					break;
				}
				if (result.status === 'ok') last = 'ok_not_stored';
				if (result.status === 'rate_limited') rateLimited++;
				else if (result.status !== 'network') break; // refused for good
			}
			submits.push({ kind, outcome: last, replays, rateLimited });
		}

		function plan(current: RoomState) {
			const type = current.item?.type;
			const window = phaseMs * 0.6;
			if (type === 'word_cloud') {
				const allowed = Number(current.item?.settings.answersPerPerson ?? 3);
				const count = Math.min(allowed, 1 + Math.floor(rng() * 3));
				// Spread over the first part of the phase, a few seconds apart in a 3-minute one.
				let at = between(0.01, 0.4) * window;
				for (let i = 0; i < count; i++) {
					const delay = at;
					work.push(sleep(delay).then(() => deliver('word', { submitId: randomUUID(), value: pick(WORDS) })));
					at += between(0.02, 0.08) * window;
				}
			} else if (type === 'poll') {
				const options = Array.isArray(current.item?.settings.options) ? current.item.settings.options.length : 3;
				work.push(sleep(between(0.01, 0.5) * window).then(() => deliver('vote', { submitId: randomUUID(), value: String(Math.floor(rng() * options)) })));
			} else if (type === 'qna') {
				const asks = rng() < 0.6 ? 1 : rng() < 0.6 ? 2 : 0;
				for (let i = 0; i < asks; i++) {
					work.push(sleep(between(0.01, 0.5) * window).then(() => deliver('question', { submitId: randomUUID(), value: `${pick(QUESTIONS)} (${Math.floor(rng() * 1e6)})` })));
				}
				for (let i = 0; i < 1 + Math.floor(rng() * 3); i++) {
					work.push(sleep(between(0.1, 1) * window).then(async () => {
						const open = (room?.questions ?? []).filter(([id]) => !upvoted.has(id));
						if (open.length === 0) return;
						const [id] = pick(open);
						upvoted.add(id);
						await deliver('upvote', { questionId: id, up: true });
					}));
				}
			}
		}

		// The phone page's poll: immediately, then on a fixed interval; it stops when the session has ended.
		let nextAt = Date.now();
		while (!done) {
			const reply = await http('state', `/api/r/${code}/state`, {}, (text) => json(text)?.serverNow).catch(() => null);
			const next: RoomState | null = reply && reply.status === 200 ? json(reply.text) : null;
			if (next && (!room || next.version >= room.version)) room = next;
			if (room?.status === 'ended') break;
			if (room && room.status === 'live' && room.itemState === 'open' && !acted.has(room.currentPosition)) {
				acted.add(room.currentPosition);
				plan(room);
			}
			nextAt += config.pollMs;
			await sleep(Math.max(0, nextAt - Date.now()));
		}
		await Promise.allSettled(work);
	}

	async function runPoller(everyMs: number, once: () => Promise<unknown>) {
		let nextAt = Date.now();
		while (!done) {
			await once().catch(() => undefined);
			nextAt += everyMs;
			await sleep(Math.max(0, nextAt - Date.now()));
		}
	}

	const phones = Array.from({ length: config.phones }, () => runPhone());
	const projectors = Array.from({ length: config.projectors }, () => runPoller(config.projectorPollMs, () => http('state', `/api/r/${code}/state`, {}, (text) => json(text)?.serverNow)));
	const hostPoller = runPoller(config.hostPollMs, hostView);

	// ---- the host's timeline ----
	await sleep(config.joinSpreadMs + config.pollMs);
	const startMs = Date.now();
	const failures: string[] = [];
	const act = async (action: string, key?: string) => {
		const reply = await hostAction(action, key);
		if (reply.status !== 200) failures.push(`${action} -> HTTP ${reply.status}`);
		return reply;
	};
	phaseMs = (config.minutes * 60_000) / 3;
	for (const [index, share] of phaseShare.entries()) {
		const length = config.minutes * 60_000 * share;
		phaseMs = length;
		await act('open');
		const phaseEnd = Date.now() + length;
		if (index === 2) {
			// Step the questions on the projector, as a host would.
			const every = Math.max(1000, length / 8);
			while (Date.now() + every < phaseEnd) {
				await sleep(every);
				const view = await hostView();
				await act('question_next', view?.shown == null ? '' : String(view.shown));
			}
		}
		await sleep(Math.max(0, phaseEnd - Date.now()));
		await act('close');
		if (index < 2) await act('next');
	}
	const endMs = Date.now();

	const csvReply = await http('export', `/api/r/${code}/host/export`, { headers: hostHeaders() }).catch(() => null);
	const csv = csvReply && csvReply.status === 200 ? csvReply.text : null;
	await act('end');
	await sleep(config.pollMs + 500);
	done = true;
	await Promise.allSettled([...phones, ...projectors, hostPoller]);
	lag.disable();
	if (failures.length > 0) notes.push(`host actions refused: ${failures.join(', ')}`);

	return {
		code,
		samples,
		submits,
		acked,
		window: { startMs, endMs },
		startedAtMs: t0,
		endedAtMs: Date.now(),
		csv,
		eventLoop: { p99Ms: Math.round(lag.percentile(99) / 1e6), maxMs: Math.round(lag.max / 1e6) },
		notes,
	};
}

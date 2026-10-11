// The simulation against a small in-process stand-in for the app: it checks the load script's own
// bookkeeping (what it counts as stored, failed, replayed) and that a retried answer is stored once.
// It is not a test of the app; the app's routes are covered elsewhere.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLoad, type LoadConfig } from '../scripts/lib/load-sim.ts';
import { checkStoredCounts, parseResultsCsv } from '../scripts/lib/load-report.ts';

const SECRET_BYPASS = 'bypass-secret-VALUE-0123';
const PASSWORD = 'host-password-VALUE-4567';

type World = { types: string[]; position: number; itemState: string; status: string; version: number; words: Map<string, number>; votes: Map<string, number>; questions: { id: number; text: string; votes: number }[]; seen: Set<string>; posts: number; shown: number | null; badBypass: number };

function fakeApp(over: { protectionOn?: boolean } = {}) {
	const world: World = { types: ['word_cloud', 'poll', 'qna'], position: 0, itemState: 'closed', status: 'lobby', version: 1, words: new Map(), votes: new Map(), questions: [], seen: new Set(), posts: 0, shown: null, badBypass: 0 };
	let toggle = 0;
	let phones = 0;
	const voted = new Set<string>();
	const read = (request: IncomingMessage) => new Promise<string>((resolve) => {
		let text = '';
		request.on('data', (chunk) => (text += chunk));
		request.on('end', () => resolve(text));
	});
	const send = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) => {
		response.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json', ...headers });
		response.end(typeof body === 'string' ? body : JSON.stringify(body));
	};
	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? '/', 'http://x');
		if (request.headers['x-vercel-protection-bypass'] !== SECRET_BYPASS) world.badBypass++;
		if (over.protectionOn && request.headers['x-vercel-protection-bypass'] !== SECRET_BYPASS) return send(response, 401, 'Authentication Required', { server: 'Vercel' });
		const body = await read(request);
		const hostOk = (request.headers.cookie ?? '').includes('volley_host=h');
		if (request.method === 'POST' && url.pathname === '/') {
			const form = new URLSearchParams(body);
			if (form.get('password') !== PASSWORD || request.headers.origin !== `http://${request.headers.host}`) return send(response, 400, 'no');
			return send(response, 303, '', { location: '/decks', 'set-cookie': 'volley_host=h; Path=/' });
		}
		if (request.method === 'POST' && url.pathname === '/decks' && url.search === '?/startSession') {
			const form = new URLSearchParams(body);
			assert.deepEqual(form.getAll('type'), ['word_cloud', 'poll', 'qna']);
			assert.deepEqual(form.getAll('options1'), ['Red', 'Green', 'Blue']);
			return send(response, 303, '', { location: '/run/ABCDE/control' });
		}
		if (url.pathname === '/j/ABCDE') return send(response, 200, '<html>');
		const match = /^\/api\/r\/ABCDE\/(state|answer|host)(\/export)?$/.exec(url.pathname);
		if (!match) return send(response, 404, 'nope');
		if (match[1] === 'state') {
			toggle++;
			return send(response, 200, {
				status: world.status, version: world.version, currentPosition: world.position, itemState: world.itemState, serverNow: Date.now(),
				item: { type: world.types[world.position], settings: world.types[world.position] === 'poll' ? { options: ['Red', 'Green', 'Blue'] } : {} },
				questions: world.questions.map((q) => [q.id, q.text, q.votes]),
			}, { 'x-vercel-cache': toggle % 4 === 0 ? 'MISS' : 'HIT' });
		}
		if (match[1] === 'answer') {
			if (request.method === 'GET') return send(response, 200, { joined: true }, { 'set-cookie': `volley_participant=p${++phones}; Path=/api/r/ABCDE/answer` });
			if (!(request.headers.cookie ?? '').includes('volley_participant=')) return send(response, 401, { status: 'not_joined' });
			world.posts++;
			const data = JSON.parse(body);
			if (world.itemState !== 'open') return send(response, 409, { status: 'closed' });
			if (data.questionId !== undefined) {
				const question = world.questions.find((q) => q.id === data.questionId);
				if (!question) return send(response, 422, { status: 'invalid' });
				// A vote is set, not added: sending it again changes nothing (the real route's rule).
				const who = `${request.headers.cookie}:${question.id}`;
				if (!voted.has(who)) {
					voted.add(who);
					question.votes++;
				}
				return send(response, 200, { status: 'ok', voted: true, votes: question.votes });
			}
			if (!world.seen.has(data.submitId)) {
				world.seen.add(data.submitId);
				const type = world.types[world.position];
				if (type === 'word_cloud') world.words.set(data.value, (world.words.get(data.value) ?? 0) + 1);
				else if (type === 'poll') world.votes.set(data.value, (world.votes.get(data.value) ?? 0) + 1);
				else world.questions.push({ id: world.questions.length + 1, text: data.value, votes: 0 });
				world.version++;
			}
			return send(response, 200, { status: 'ok', left: 1 });
		}
		if (!hostOk) return send(response, 401, { status: 'signed_out' });
		if (match[2]) {
			const rows = [['Activity', 'Type', 'Question', 'Answer', 'Count', 'Hidden', 'Answered']];
			for (const [word, count] of world.words) rows.push(['1', 'word_cloud', 'q', word, String(count), 'no', '']);
			for (const [option, count] of world.votes) rows.push(['2', 'poll', 'q', option, String(count), 'no', '']);
			for (const q of world.questions) rows.push(['3', 'qna', 'q', q.text, String(q.votes), 'no', 'no']);
			return send(response, 200, '﻿' + rows.map((row) => row.join(',')).join('\r\n') + '\r\n');
		}
		if (request.method === 'GET') return send(response, 200, { shown: world.shown });
		const { action } = JSON.parse(body);
		if (action === 'open') { world.status = 'live'; world.itemState = 'open'; }
		else if (action === 'close') world.itemState = 'closed';
		else if (action === 'next') { world.position++; world.itemState = 'closed'; }
		else if (action === 'end') world.status = 'ended';
		else if (action === 'question_next') world.shown = world.questions[0]?.id ?? null;
		world.version++;
		return send(response, 200, { status: 'ok' });
	});
	return { server, world };
}

const config = (port: number, over: Partial<LoadConfig> = {}): LoadConfig => ({
	base: new URL(`http://127.0.0.1:${port}`), login: { email: 'load@example.com', password: PASSWORD }, bypassSecret: SECRET_BYPASS,
	phones: 8, minutes: 0.1, pollMs: 120, projectorPollMs: 60, hostPollMs: 200, projectors: 1, replayRate: 0.3, retryDelaysMs: [15, 15], userRepressMs: 30, joinSpreadMs: 150, seed: 7, log: () => undefined, ...over,
});

test('the simulation stores every answer exactly once even when replies are lost, and counts nothing failed', async () => {
	const { server, world } = fakeApp();
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		const result = await runLoad(config((server.address() as AddressInfo).port));
		assert.equal(result.code, 'ABCDE');
		const failed = result.submits.filter((s) => s.outcome !== 'ok');
		assert.deepEqual(failed, []);
		assert.ok(result.submits.length > 8, 'phones answered');
		assert.ok(result.submits.reduce((n, s) => n + s.replays, 0) > 0, 'some replies were treated as lost');
		assert.ok(world.posts > result.submits.length, 'a lost reply means the same submit id reaches the server again');
		// Stored exactly once: the server's own counts equal what the phones were told.
		assert.equal([...world.words.values()].reduce((a, b) => a + b, 0), result.acked.word);
		assert.equal([...world.votes.values()].reduce((a, b) => a + b, 0), result.acked.vote);
		assert.equal(world.questions.length, result.acked.question);
		assert.equal(world.questions.reduce((a, q) => a + q.votes, 0), result.acked.upvote);
		assert.equal(checkStoredCounts(parseResultsCsv(result.csv ?? ''), result.acked).ok, true);
		assert.ok(result.samples.some((s) => s.route === 'state' && s.cache === 'HIT'));
		assert.ok(result.samples.some((s) => s.route === 'state' && s.generation !== undefined));
		for (const route of ['sign-in', 'start-session', 'page', 'join', 'state', 'answer', 'host-view', 'host-action', 'export']) assert.ok(result.samples.some((s) => s.route === route), `no ${route} request`);
		assert.equal(world.badBypass, 0, 'every request carried the bypass header');
		assert.equal(world.status, 'ended');
		// Secrets: nothing the script returns holds the password or the bypass secret.
		const everything = JSON.stringify(result);
		assert.ok(!everything.includes(PASSWORD) && !everything.includes(SECRET_BYPASS));
	} finally {
		server.close();
	}
});

test('a deployment that answers 401 from Vercel names Deployment Protection and the bypass variable', async () => {
	const { server } = fakeApp({ protectionOn: true });
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		await assert.rejects(runLoad(config((server.address() as AddressInfo).port, { bypassSecret: undefined })), (error: Error) => /Deployment Protection/.test(error.message) && /VERCEL_AUTOMATION_BYPASS_SECRET/.test(error.message) && !error.message.includes(PASSWORD));
	} finally {
		server.close();
	}
});

test('a wrong host password stops the run without echoing it', async () => {
	const { server } = fakeApp();
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		await assert.rejects(runLoad(config((server.address() as AddressInfo).port, { login: { email: 'a@example.com', password: 'wrong-password-VALUE' } })), (error: Error) => /sign-in failed/i.test(error.message) && !error.message.includes('wrong-password-VALUE'));
	} finally {
		server.close();
	}
});

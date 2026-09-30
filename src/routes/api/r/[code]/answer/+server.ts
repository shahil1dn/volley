import { error, json, type Cookies } from '@sveltejs/kit';
import { PARTICIPANT_SECRET } from '$env/static/private';
import { dbCall } from '$lib/server/db';
import { CODE_PATTERN } from '$lib/server/host-token';
import { hashClientIp, makeParticipantToken, readParticipantToken } from '$lib/server/participant-token';
import type { RequestHandler } from './$types';

const COOKIE = 'volley_participant';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Far above the 25-character word limit; anything longer is not a real answer.
const MAX_RAW_VALUE = 200;

// Every refusal is a normal outcome the phone explains in plain words, so the
// body always carries `status`. The HTTP code says what kind of outcome it is:
// 422 the answer itself was rejected, 409 the room isn't taking it right now,
// 429 slow down. Only network errors and 5xx are worth retrying.
const HTTP_STATUS: Record<string, number> = {
	ok: 200,
	invalid: 422,
	limit: 409,
	closed: 409,
	frozen: 409,
	rate_limited: 429,
};

function roomCode(code: string): string {
	if (!CODE_PATTERN.test(code)) error(404, 'No such room');
	return code;
}

// Scoped to this route by Path, so the phone's identity is sent only with its
// answers: the shared state route stays cookie-free and cacheable (SPEC 11).
function setParticipantCookie(cookies: Cookies, code: string) {
	cookies.set(COOKIE, makeParticipantToken(PARTICIPANT_SECRET, code), {
		path: `/api/r/${code}/answer`,
		httpOnly: true,
		// `secure` is left to SvelteKit's default: on everywhere except
		// http://localhost, where some browsers refuse secure cookies over plain http.
		sameSite: 'lax',
		maxAge: 60 * 60 * 24,
	});
}

// Join: the phone calls this when the room page opens. A cookie scoped to this
// path is invisible to the page itself, so only this route can tell whether the
// phone already has an identity. Issuing one on every page load would reset a
// phone's answer limit each time it reloaded. No database call.
export const GET: RequestHandler = ({ params, cookies, setHeaders }) => {
	const code = roomCode(params.code);
	if (!readParticipantToken(PARTICIPANT_SECRET, code, cookies.get(COOKIE))) setParticipantCookie(cookies, code);
	setHeaders({ 'cache-control': 'no-store' });
	return json({ joined: true });
};

export const POST: RequestHandler = async ({ params, cookies, request, getClientAddress, setHeaders }) => {
	const code = roomCode(params.code);
	setHeaders({ 'cache-control': 'no-store' });

	const participantId = readParticipantToken(PARTICIPANT_SECRET, code, cookies.get(COOKIE));
	if (!participantId) return json({ status: 'not_joined' }, { status: 401 });

	if (!request.headers.get('content-type')?.startsWith('application/json')) {
		return json({ status: 'bad_request' }, { status: 415 });
	}
	const body: unknown = await request.json().catch(() => null);
	const { submitId, value, questionId, up } = (body ?? {}) as { submitId?: unknown; value?: unknown; questionId?: unknown; up?: unknown };

	// An upvote on a Q&A question, or taking one back. Sent here rather than to
	// a route of its own because the participant cookie is scoped to this path.
	if (questionId !== undefined) {
		if (!Number.isSafeInteger(questionId) || (questionId as number) < 1 || typeof up !== 'boolean') {
			return json({ status: 'bad_request' }, { status: 400 });
		}
		const voted = await dbCall<{ status: string; voted?: boolean; votes?: number }>('vote_question', [
			code,
			participantId,
			questionId,
			up,
			hashClientIp(PARTICIPANT_SECRET, getClientAddress()),
		]);
		if (!voted) error(500, 'Could not save the vote');
		return json(voted, { status: HTTP_STATUS[voted.status] ?? 500 });
	}

	if (typeof submitId !== 'string' || !UUID_PATTERN.test(submitId) || typeof value !== 'string' || value.length > MAX_RAW_VALUE) {
		return json({ status: 'bad_request' }, { status: 400 });
	}

	const result = await dbCall<{ status: string; left?: number }>('submit_answer', [
		code,
		participantId,
		submitId.toLowerCase(),
		value,
		// On Vercel this is the x-forwarded-for header, which Vercel overwrites so
		// a client can't choose its own address.
		hashClientIp(PARTICIPANT_SECRET, getClientAddress()),
	]);
	if (!result) error(500, 'Could not save the answer');

	return json(result, { status: HTTP_STATUS[result.status] ?? 500 });
};

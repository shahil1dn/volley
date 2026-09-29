import { error, json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { CODE_PATTERN } from '$lib/server/host-token';
import type { RequestHandler } from './$types';

// Guarded by hooks.server.ts: only a signed-in host reaches here, as
// locals.host. The database functions then refuse runs that aren't theirs.

// 409: the run can't make that move from where it is now (ARCHITECTURE §4).
const HTTP_STATUS: Record<string, number> = { ok: 200, illegal: 409, invalid: 400, not_found: 404 };

function hostAndCode(locals: App.Locals, code: string) {
	if (!locals.host) error(403, 'Not a host');
	if (!CODE_PATTERN.test(code)) error(404, 'No such room');
	return { hostId: locals.host.userId, code };
}

export const GET: RequestHandler = async ({ locals, params, setHeaders }) => {
	const { hostId, code } = hostAndCode(locals, params.code);
	setHeaders({ 'cache-control': 'no-store' });
	const { data: view, error: dbError } = await db.rpc('host_view', { p_host_id: hostId, p_code: code });
	if (dbError) error(500, 'Could not load the room');
	if (!view) error(404, 'No such room');
	return json(view);
};

export const POST: RequestHandler = async ({ locals, params, request, setHeaders }) => {
	const { hostId, code } = hostAndCode(locals, params.code);
	setHeaders({ 'cache-control': 'no-store' });
	if (!request.headers.get('content-type')?.startsWith('application/json')) {
		return json({ status: 'invalid' }, { status: 415 });
	}
	const body: unknown = await request.json().catch(() => null);
	const { action, key } = (body ?? {}) as { action?: unknown; key?: unknown };
	if (typeof action !== 'string' || action.length > 20 || (key !== undefined && (typeof key !== 'string' || key.length > 100))) {
		return json({ status: 'invalid' }, { status: 400 });
	}
	const { data: result, error: dbError } = await db.rpc('host_action', {
		p_host_id: hostId,
		p_code: code,
		p_action: action,
		p_key: key ?? null,
	});
	if (dbError || !result) error(500, 'Could not apply that');
	return json(result, { status: HTTP_STATUS[result.status] ?? 500 });
};

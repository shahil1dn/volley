import { error, fail } from '@sveltejs/kit';
import { dbCall } from '$lib/server/db';
import { newToken } from '$lib/server/invite-token';
import { deleteAccount } from '$lib/server/invites';
import type { Actions, PageServerLoad } from './$types';

type HostRow = { userId: string; email: string; name: string | null; isAdmin: boolean; isYou: boolean };
type InviteRow = { id: string; email: string; name: string; purpose: 'invite' | 'reset'; expiresAt: string };

// Guarded by hooks.server.ts as a host page; list_hosts refuses anyone who
// isn't an admin, and every action's function checks again.
export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.host) error(403, 'Not a host');
	const listed = await dbCall<{ hosts: HostRow[]; invites: InviteRow[] }>('list_hosts', [locals.host.userId]);
	if (!listed) error(403, 'Only an admin can manage hosts.');
	return listed;
};

const MESSAGES: Record<string, string> = {
	already_host: 'That email is already a host.',
	invalid: 'Enter a name (up to 40 characters) and a valid email.',
	not_found: 'That host no longer exists.',
	self: 'You can’t do that to your own account here.',
	not_admin: 'Only an admin can manage hosts.',
};

// Creates a link and hands it back once; only its hash is stored.
async function makeLink(hostId: string, origin: string, email: string, name: string, purpose: 'invite' | 'reset') {
	const { token, hash } = newToken();
	const result = await dbCall<{ status: string; expiresAt?: string }>('create_host_invite', [hostId, email, name, purpose, hash]);
	if (!result) error(500, 'Could not create the link');
	if (result.status !== 'ok') return fail(400, { purpose, name, email, message: MESSAGES[result.status] ?? MESSAGES.invalid });
	return { link: { url: `${origin}/invite/${token}`, name, email: email.trim().toLowerCase(), purpose, expiresAt: result.expiresAt } };
}

export const actions: Actions = {
	invite: async ({ locals, request, url }) => {
		if (!locals.host) error(403, 'Not a host');
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const email = String(form.get('email') ?? '');
		return makeLink(locals.host.userId, url.origin, email, name, 'invite');
	},
	reset: async ({ locals, request, url }) => {
		if (!locals.host) error(403, 'Not a host');
		const form = await request.formData();
		return makeLink(locals.host.userId, url.origin, String(form.get('email') ?? ''), String(form.get('name') ?? ''), 'reset');
	},
	remove: async ({ locals, request }) => {
		if (!locals.host) error(403, 'Not a host');
		const userId = String((await request.formData()).get('userId') ?? '');
		if (!/^[0-9a-f-]{36}$/.test(userId)) return fail(400, { message: MESSAGES.not_found });
		const result = await dbCall<{ status: string }>('remove_host', [locals.host.userId, userId]);
		if (!result) error(500, 'Could not remove the host');
		if (result.status !== 'ok') return fail(400, { message: MESSAGES[result.status] ?? MESSAGES.not_found });
		await deleteAccount(userId);
		return { removed: true };
	},
	cancel: async ({ locals, request }) => {
		if (!locals.host) error(403, 'Not a host');
		const inviteId = String((await request.formData()).get('inviteId') ?? '');
		if (!/^[0-9a-f-]{36}$/.test(inviteId)) return fail(400, { message: MESSAGES.not_found });
		const result = await dbCall<{ status: string }>('cancel_host_invite', [locals.host.userId, inviteId]);
		if (!result) error(500, 'Could not cancel the link');
		return result.status === 'ok' ? { cancelled: true } : fail(400, { message: MESSAGES[result.status] ?? MESSAGES.not_found });
	},
};

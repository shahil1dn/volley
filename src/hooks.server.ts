import type { Handle } from '@sveltejs/kit';
import { clearedHostCookie, currentHost } from '$lib/server/host-guard';
import { hostArea } from '$lib/server/host-session';

// The one place hosts are checked (A6). Runs before routing, so a host path is
// guarded even before its route exists.
export const handle: Handle = async ({ event, resolve }) => {
	const area = hostArea(event.url.pathname);
	if (!area) return resolve(event);

	const host = await currentHost(event.cookies);
	if (host === 'signed_out') {
		const clear = { 'set-cookie': clearedHostCookie(event.cookies) };
		// A form posted by the page's script (use:enhance) can't follow a redirect to the
		// sign-in page: it would read that page as an error. Say what happened instead.
		if (area === 'page' && event.request.method === 'POST' && event.request.headers.get('x-sveltekit-action') === 'true') {
			return Response.json({ type: 'error', error: { message: 'signed_out' } }, { status: 401, headers: clear });
		}
		return area === 'api'
			? Response.json({ status: 'signed_out' }, { status: 401, headers: clear })
			: new Response(null, { status: 303, headers: { location: '/', ...clear } });
	}
	if (host === 'not_host') {
		return area === 'api'
			? Response.json({ status: 'not_host' }, { status: 403 })
			: new Response("This account isn't a host on this Volley.", { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
	}
	event.locals.host = host;
	return resolve(event);
};

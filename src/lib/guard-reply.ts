// What the host guard (hooks.server.ts) tells a form posted by the page's script
// (use:enhance), which can't follow a redirect or read a text reply: the host's
// session ended, or the account is no longer a host. Anything else is null.
export type GuardReply = 'signed_out' | 'not_host';

export function guardReply(result: { type: string; error?: unknown }): GuardReply | null {
	if (result.type !== 'error') return null;
	const message = (result.error as { message?: unknown } | undefined)?.message;
	return message === 'signed_out' || message === 'not_host' ? message : null;
}

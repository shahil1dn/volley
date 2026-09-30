<script lang="ts">
	import { enhance } from '$app/forms';
	import Brand from '$lib/Brand.svelte';
	import { brand } from '$lib/brand';
	import type { SubmitFunction } from '@sveltejs/kit';

	let { data, form } = $props();
	type Link = { url: string; name: string; email: string; purpose: 'invite' | 'reset'; expiresAt?: string };
	// A new link is shown once, so it stays on screen until the next link
	// replaces it, whatever else is pressed meanwhile.
	let link = $state<Link | null>(null);
	let copied = $state(false);

	const keepLink: SubmitFunction = () => async ({ result, update }) => {
		if (result.type === 'success' && result.data?.link) {
			link = result.data.link as Link;
			copied = false;
		}
		await update();
	};

	// Asked inside enhance, whose cancel() stops the request; an onsubmit
	// preventDefault doesn't, because enhance submits by fetch regardless.
	const confirmRemove =
		(who: string): SubmitFunction =>
		({ cancel }) => {
			if (!confirm(`Remove ${who} as a host? They can't sign in any more, and their sessions are deleted.`)) cancel();
		};

	const day = (iso: string) =>
		new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/London' });

	async function copy(url: string) {
		try {
			await navigator.clipboard.writeText(url);
			copied = true;
		} catch {
			// No clipboard access: the link is selected in its box to copy by hand.
		}
	}

</script>

<svelte:head>
	<title>Hosts · {brand.name}</title>
</svelte:head>

<main class="control">
	<header class="masthead"><Brand /><p class="label"><a href="/decks">← Back to sessions</a></p></header>
	<h1>Hosts</h1>
	<p class="hint">Hosts can start sessions. Invite someone and send them the link: they choose their own password.</p>

	{#if link}
		<section class="stack" aria-live="polite">
			<h2>{link.purpose === 'invite' ? `Invite link for ${link.name}` : `Password reset link for ${link.name}`}</h2>
			<p class="hint">
				Send this to {link.email}. It works once and expires on {day(link.expiresAt ?? '')}. It won't be shown again.
			</p>
			<label class="field">
				<span class="hint">Link</span>
				<input readonly value={link.url} onfocus={(event) => event.currentTarget.select()} />
			</label>
			<button type="button" class="btn" onclick={() => copy(link?.url ?? '')}>{copied ? 'Copied' : 'Copy link'}</button>
		</section>
	{/if}

	<h2>Invite a host</h2>
	<form method="POST" action="?/invite" class="stack" use:enhance={keepLink}>
		<label class="field">
			<span class="hint">Name, as shown on the big screen</span>
			<input name="name" maxlength="40" required autocomplete="off" defaultValue={form?.purpose === 'invite' ? (form?.name ?? '') : ''} />
		</label>
		<label class="field">
			<span class="hint">Email</span>
			<input name="email" type="email" required autocomplete="off" defaultValue={form?.purpose === 'invite' ? (form?.email ?? '') : ''} />
		</label>
		<button class="btn btn--block">Create invite link</button>
	</form>
	{#if form?.message}<p class="error" role="alert">{form.message}</p>{/if}

	<h2>Current hosts</h2>
	<ul class="control__words">
		{#each data.hosts as host (host.userId)}
			<li>
				<span>
					{host.name ?? host.email}
					<span class="hint">{[host.name ? host.email : '', host.isYou ? 'you' : '', host.isAdmin ? 'admin' : ''].filter(Boolean).join(' · ')}</span>
				</span>
				<!-- Admins, you included, are managed from the terminal (ADR-011). -->
				{#if !host.isYou && !host.isAdmin}
					<div class="control__buttons">
						<form method="POST" action="?/reset" use:enhance={keepLink}>
							<input type="hidden" name="email" value={host.email} />
							<button class="btn btn--quiet" aria-label="Reset password: {host.name ?? host.email}">Reset password</button>
						</form>
						<form method="POST" action="?/remove" use:enhance={confirmRemove(host.name ?? host.email)}>
							<input type="hidden" name="userId" value={host.userId} />
							<button class="btn btn--quiet" aria-label="Remove: {host.name ?? host.email}">Remove</button>
						</form>
					</div>
				{/if}
			</li>
		{/each}
	</ul>

	{#if data.invites.length > 0}
		<h2>Links not used yet</h2>
		<ul class="control__words">
			{#each data.invites as invite (invite.id)}
				<li>
					<span>
						{invite.name}
						<span class="hint">{invite.email} · {invite.purpose === 'invite' ? 'invite' : 'password reset'} · expires {day(invite.expiresAt)}</span>
					</span>
					<form method="POST" action="?/cancel" use:enhance>
						<input type="hidden" name="inviteId" value={invite.id} />
						<button class="btn btn--quiet" aria-label="Cancel link: {invite.name}">Cancel link</button>
					</form>
				</li>
			{/each}
		</ul>
	{/if}
</main>

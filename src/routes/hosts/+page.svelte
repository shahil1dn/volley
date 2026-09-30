<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();
	let copied = $state(false);

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

	function confirmRemove(event: SubmitEvent, who: string) {
		if (!confirm(`Remove ${who} as a host? They can't sign in any more, and their sessions are deleted.`)) event.preventDefault();
	}
</script>

<svelte:head>
	<title>Hosts</title>
</svelte:head>

<main class="control">
	<p class="label"><a href="/decks">← Back to sessions</a></p>
	<h1>Hosts</h1>
	<p class="hint">Hosts can start sessions. Invite someone and send them the link: they choose their own password.</p>

	{#if form?.link}
		<section class="stack" aria-live="polite">
			<h2>{form.link.purpose === 'invite' ? `Invite link for ${form.link.name}` : `Password reset link for ${form.link.name}`}</h2>
			<p class="hint">
				Send this to {form.link.email}. It works once and expires on {day(form.link.expiresAt ?? '')}. It won't be shown again.
			</p>
			<label class="field">
				<span class="hint">Link</span>
				<input readonly value={form.link.url} onfocus={(event) => event.currentTarget.select()} />
			</label>
			<button type="button" class="btn" onclick={() => copy(form.link?.url ?? '')}>{copied ? 'Copied' : 'Copy link'}</button>
		</section>
	{/if}

	<h2>Invite a host</h2>
	<form method="POST" action="?/invite" class="stack" use:enhance={() => { copied = false; return ({ update }) => update(); }}>
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
				{#if !host.isYou}
					<div class="control__buttons">
						<form method="POST" action="?/reset" use:enhance={() => { copied = false; return ({ update }) => update(); }}>
							<input type="hidden" name="email" value={host.email} />
							<input type="hidden" name="name" value={host.name ?? host.email} />
							<button class="btn btn--quiet" aria-label="Reset password: {host.name ?? host.email}">Reset password</button>
						</form>
						<form method="POST" action="?/remove" use:enhance onsubmit={(event) => confirmRemove(event, host.name ?? host.email)}>
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

<script lang="ts">
	import Brand from '$lib/Brand.svelte';
	import { brand } from '$lib/brand';

	let { data, form } = $props();
	let showPassword = $state(false);

	const invite = $derived(data.invite);
	const isReset = $derived(invite.purpose === 'reset');
	const GONE: Record<string, [string, string]> = {
		used: ['This link has been used', 'Each link works once. Ask whoever sent it for a new one.'],
		expired: ['This link has expired', 'Links last 7 days. Ask whoever sent it for a new one.'],
		invalid: ['This link isn’t valid', 'Check you copied all of it, or ask for a new one.'],
	};
</script>

<svelte:head>
	<title>{isReset ? 'New password' : 'Host invite'} · {brand.name}</title>
	<meta name="referrer" content="same-origin" />
</svelte:head>

<main class="phone">
	<header class="masthead"><Brand /></header>
	{#if invite.status === 'ok'}
		<h1>{isReset ? 'Choose a new password' : 'You’re invited to host'}</h1>
		<p class="hint">
			{isReset ? 'Once it’s saved, you’re signed in.' : 'Set up your login. You’ll use it to start sessions for your audience.'}
		</p>
		<form method="POST" class="stack">
			<label class="field">
				<span class="hint">Email</span>
				<input class="field__static" type="email" autocomplete="username" readonly value={invite.email} />
			</label>
			<label class="field">
				<span class="hint">Your name, as shown on the big screen</span>
				<input name="name" autocomplete="name" required maxlength="40" defaultValue={form?.name ?? invite.name ?? ''} />
			</label>
			<label class="field">
				<span class="hint">{isReset ? 'New password' : 'Choose a password'} (at least 10 characters)</span>
				<input
					name="password"
					type={showPassword ? 'text' : 'password'}
					autocomplete="new-password"
					required
					minlength="10"
					maxlength="72"
					aria-describedby={form?.message ? 'invite-problem' : undefined}
					aria-invalid={form?.message ? 'true' : undefined}
				/>
			</label>
			<label class="hint"><input type="checkbox" bind:checked={showPassword} /> Show password</label>
			<button class="btn btn--block">{isReset ? 'Save new password' : 'Create my login'}</button>
			{#if form?.message}<p class="error" id="invite-problem" role="alert">{form.message}</p>{/if}
		</form>
	{:else}
		<h1>{(GONE[invite.status] ?? GONE.invalid)[0]}</h1>
		<p class="hint">{(GONE[invite.status] ?? GONE.invalid)[1]}</p>
		<p class="hint"><a href="/">Go to host sign-in</a></p>
	{/if}
</main>

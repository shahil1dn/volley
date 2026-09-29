<script lang="ts">
	let { form } = $props();
</script>

<svelte:head>
	<title>Host sign-in</title>
</svelte:head>

<main class="phone">
	<p class="label">Volley</p>
	<h1>Host sign-in</h1>
	<form method="POST" class="stack">
		<label class="field">
			<span class="hint">Email</span>
			<!-- defaultValue, not value: `value` resets the box when the page finishes
			     loading, wiping anything typed on a slow connection before then. -->
			<input name="email" type="email" autocomplete="username" required defaultValue={form?.email ?? ''} />
		</label>
		<label class="field">
			<span class="hint">Password</span>
			<input name="password" type="password" autocomplete="current-password" required />
		</label>
		<button class="btn btn--block">Sign in</button>
		{#if form?.message}<p class="error" role="alert">{form.message}</p>{/if}
	</form>
</main>

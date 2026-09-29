<script lang="ts">
	let { data, form } = $props();
</script>

<svelte:head>
	<title>Your decks</title>
</svelte:head>

<main class="phone">
	<p class="label">Signed in as {data.email}</p>
	<h1>Your decks</h1>
	<p class="hint">Decks arrive in Milestone 3. For now, start a one-question word cloud.</p>
	<form method="POST" action="?/startRun" class="stack">
		<label class="field">
			<span class="hint">Question</span>
			<input name="prompt" maxlength="140" required defaultValue={form?.prompt ?? ''} placeholder="One word for AI?" />
		</label>
		<button class="btn btn--block">Start a test run</button>
		{#if form?.message}<p class="error" role="alert">{form.message}</p>{/if}
	</form>
	<form method="POST" action="?/signOut" class="stack">
		<button class="btn btn--block btn--quiet">Sign out</button>
	</form>
</main>

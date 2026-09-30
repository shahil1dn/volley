<script lang="ts">
	let { data, form } = $props();
</script>

<svelte:head>
	<title>Your decks</title>
</svelte:head>

<main class="phone">
	<p class="label">Signed in as {data.email}</p>
	<h1>Your decks</h1>
	<p class="hint">Decks arrive in Milestone 3. For now, start a one-question word cloud or poll.</p>
	<form method="POST" action="?/startRun" class="stack">
		<label class="field">
			<span class="hint">Question</span>
			<input name="prompt" maxlength="140" required defaultValue={form?.prompt ?? ''} placeholder="One word for AI?" />
		</label>
		<button class="btn btn--block">Start a test run</button>
		{#if form?.message}<p class="error" role="alert">{form.message}</p>{/if}
	</form>
	<form method="POST" action="?/startPoll" class="stack">
		<label class="field">
			<span class="hint">Poll question</span>
			<input name="prompt" maxlength="140" required defaultValue={form?.pollPrompt ?? ''} placeholder="Tea or coffee?" />
		</label>
		<label class="field">
			<span class="hint">Options, one per line (2 to 6)</span>
			<textarea
				name="options"
				rows="4"
				required
				defaultValue={form?.optionsText ?? ''}
				aria-invalid={form?.pollMessage ? 'true' : undefined}
				aria-describedby={form?.pollMessage ? 'poll-problem' : undefined}
			></textarea>
		</label>
		<button class="btn btn--block">Start a test poll</button>
		{#if form?.pollMessage}<p class="error" id="poll-problem" role="alert">{form.pollMessage}</p>{/if}
	</form>
	<form method="POST" action="?/signOut" class="stack">
		<button class="btn btn--block btn--quiet">Sign out</button>
	</form>
</main>

<script lang="ts">
	import Brand from '$lib/Brand.svelte';
	import { brand } from '$lib/brand';

	let { data, form } = $props();

	const TYPES = [
		['word_cloud', 'Word cloud'],
		['poll', 'Poll'],
		['qna', 'Q&A'],
	] as const;
	// The first activity defaults to a word cloud; the others start empty.
	const slots = Array.from({ length: 3 }, (_, i) => form?.slots?.[i] ?? { type: i === 0 ? 'word_cloud' : '', prompt: '', options: '' });
</script>

<svelte:head>
	<title>Start a session · {brand.name}</title>
</svelte:head>

<main class="phone">
	<header class="masthead"><Brand /><p class="label">Signed in as {data.email}</p></header>
	<h1>Start a session</h1>
	<p class="hint">Up to 3 activities, in order, under one room code. Saved decks arrive in Milestone 3.</p>
	<form method="POST" action="?/startSession" class="stack">
		{#each slots as slot, i (i)}
			<fieldset class="activity">
				<legend>Activity {i + 1}</legend>
				<label class="field">
					<span class="hint">Activity {i + 1} type</span>
					<select name="type{i}" value={slot.type}>
						{#if i > 0}<option value="">None</option>{/if}
						{#each TYPES as [value, name] (value)}<option {value}>{name}</option>{/each}
					</select>
				</label>
				<label class="field">
					<span class="hint">Activity {i + 1} question</span>
					<input name="prompt{i}" maxlength="140" defaultValue={slot.prompt} />
				</label>
				<label class="field">
					<span class="hint">Activity {i + 1} poll options, one per line (polls only)</span>
					<textarea name="options{i}" rows="3" defaultValue={slot.options}></textarea>
				</label>
			</fieldset>
		{/each}
		<button class="btn btn--block">Start session</button>
		{#if form?.message}<p class="error" role="alert">{form.message}</p>{/if}
	</form>
	<form method="POST" action="?/signOut" class="stack">
		<button class="btn btn--block btn--quiet">Sign out</button>
	</form>
</main>

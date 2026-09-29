<script lang="ts">
	import { onMount } from 'svelte';

	let { data } = $props();

	type HostView = {
		status: 'lobby' | 'live' | 'frozen' | 'ended';
		version: number;
		currentPosition: number;
		itemCount: number;
		itemState: string;
		item: { type: string; settings: Record<string, unknown> } | null;
		tallies: [string, number, boolean][];
	};

	const POLL_MS = 2000;
	const REFUSED: Record<number, string> = {
		409: "That can't be done right now. The screen below shows where the session is.",
		404: "This session isn't yours, or it no longer exists.",
	};

	let view = $state<HostView | null>(null);
	let missing = $state(false);
	let busy = $state(false);
	let notice = $state('');

	const live = $derived(view?.status === 'live');
	const ended = $derived(view?.status === 'ended');
	const prompt = $derived(typeof view?.item?.settings.prompt === 'string' ? view.item.settings.prompt : '');

	async function refresh() {
		try {
			const response = await fetch(`/api/r/${data.code}/host`, { cache: 'no-store' });
			if (response.status === 404) missing = true;
			if (response.ok) view = await response.json();
		} catch {
			// Offline for a moment: keep the last view and try again next tick.
		}
	}

	async function act(action: string, key?: string) {
		if (action === 'end' && !confirm('End this session? Answers close for good.')) return;
		busy = true;
		notice = '';
		try {
			const response = await fetch(`/api/r/${data.code}/host`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action, key }),
			});
			if (!response.ok) notice = REFUSED[response.status] ?? 'That didn’t work. Try again.';
		} catch {
			notice = 'No connection. Try again.';
		}
		await refresh();
		busy = false;
	}

	onMount(() => {
		refresh();
		const timer = setInterval(refresh, POLL_MS);
		return () => clearInterval(timer);
	});
</script>

<svelte:head>
	<title>Control · {data.code}</title>
</svelte:head>

<main class="control">
	<p class="label">Room {data.code} · control</p>
	{#if missing}
		<h1>We can't find that session</h1>
	{:else if !view}
		<p class="hint" aria-live="polite">Loading…</p>
	{:else}
		<h1>{prompt}</h1>
		<p class="hint" aria-live="polite">
			Session: {view.status}. Answers: {view.itemState}. Activity {view.currentPosition + 1} of {view.itemCount}.
		</p>
		<p class="hint">
			Projector: <a href="/run/{data.code}" target="_blank" rel="noopener">open the projector view</a>. Phones join at
			{data.joinUrl}
		</p>

		<div class="control__actions">
			{#if view.itemState === 'open'}
				<button class="btn" disabled={busy || ended} onclick={() => act('close')}>Close answers</button>
			{:else}
				<button class="btn" disabled={busy || ended || view.status === 'frozen'} onclick={() => act('open')}>Open answers</button>
			{/if}
			<button class="btn btn--quiet" disabled={busy || !live || view.currentPosition === 0} onclick={() => act('back')}>Previous</button>
			<button class="btn btn--quiet" disabled={busy || !live || view.currentPosition >= view.itemCount - 1} onclick={() => act('next')}>Next</button>
			{#if view.status === 'frozen'}
				<button class="btn btn--quiet" disabled={busy} onclick={() => act('unfreeze')}>Unfreeze input</button>
			{:else}
				<button class="btn btn--quiet" disabled={busy || !live} onclick={() => act('freeze')}>Freeze input</button>
			{/if}
			<button class="btn btn--quiet" disabled={busy || ended} onclick={() => act('end')}>End session</button>
		</div>
		{#if notice}<p class="error" role="alert">{notice}</p>{/if}

		<h2>Words</h2>
		{#if view.tallies.length === 0}
			<p class="hint">No answers yet.</p>
		{:else}
			<ul class="control__words">
				{#each view.tallies as [word, count, hidden] (word)}
					<li class:control__word--hidden={hidden}>
						<span>{word} <span class="hint">× {count}{hidden ? ', hidden' : ''}</span></span>
						<button class="btn btn--quiet" disabled={busy || ended} onclick={() => act(hidden ? 'unhide' : 'hide', word)} aria-label="{hidden ? 'Unhide' : 'Hide'} “{word}”">
							{hidden ? 'Unhide' : 'Hide'}
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</main>

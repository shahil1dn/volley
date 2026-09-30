<script lang="ts">
	import { onMount } from 'svelte';
	import { isNewer, type RoomState } from '$lib/room-client';
	import { centreOut, wordSizeVw } from '$lib/words';

	let { data } = $props();

	const POLL_MS = 1000;
	// Each shrink step, and the floor below which words would be unreadable anyway.
	const FIT_STEP = 0.9;
	const MIN_FIT = 0.2;

	let room = $state<RoomState | null>(null);
	let missing = $state(false);
	let cloud = $state<HTMLUListElement>();

	const words = $derived(room?.tallies ?? []);
	const biggest = $derived(words[0]?.[1] ?? 1);
	const answers = $derived(words.reduce((sum, [, count]) => sum + count, 0));
	const prompt = $derived(typeof room?.item?.settings.prompt === 'string' ? room.item.settings.prompt : '');
	const note = $derived(
		room?.status === 'ended' ? 'Session ended'
		: room?.status === 'frozen' ? 'Answers paused'
		: room?.status === 'lobby' ? 'Starting soon'
		: room?.itemState === 'closed' ? 'Answers closed'
		: '',
	);

	// Shrinks every word together until the cloud fits its box. Runs after the
	// DOM updates and before the browser paints, so no overflowing frame shows.
	function fitToBox(box: HTMLElement) {
		let fit = 1;
		box.style.setProperty('--fit', String(fit));
		const overflows = () => box.scrollHeight > box.clientHeight || box.scrollWidth > box.clientWidth;
		while (overflows() && fit > MIN_FIT) {
			fit *= FIT_STEP;
			box.style.setProperty('--fit', String(fit));
		}
	}

	$effect(() => {
		if (!cloud || words.length === 0) return;
		const box = cloud;
		fitToBox(box);
		const observer = new ResizeObserver(() => fitToBox(box));
		observer.observe(box);
		return () => observer.disconnect();
	});

	async function poll() {
		try {
			const response = await fetch(`/api/r/${data.code}/state`);
			if (response.status === 404) {
				missing = true;
				return;
			}
			if (!response.ok) return;
			const next: RoomState = await response.json();
			if (isNewer(room, next)) room = next;
		} catch {
			// Offline for a moment: keep the last cloud on screen.
		}
	}

	onMount(() => {
		poll();
		const timer = setInterval(() => (missing || room?.status === 'ended' ? clearInterval(timer) : poll()), POLL_MS);
		return () => clearInterval(timer);
	});
</script>

<svelte:head>
	<title>Room {data.code}</title>
</svelte:head>

<main class="host">
	<header class="host__top">
		<div>
			<p class="label">Room {data.code}{note ? ` · ${note}` : ''}</p>
			<h1 class="host__question">{missing ? "We can't find that room" : prompt}</h1>
		</div>
		<div class="host__join">
			<div class="host__qr" role="img" aria-label="QR code to join at {data.joinUrl}">{@html data.qrSvg}</div>
			<div>
				<p class="host__joinText">Scan, or go to</p>
				<p class="host__url">{data.joinUrl.replace(/^https?:\/\//, '')}</p>
				<p class="host__code">{data.code}</p>
				<p class="host__count" aria-live="polite">{answers} {answers === 1 ? 'answer' : 'answers'}</p>
			</div>
		</div>
	</header>

	{#if words.length === 0}
		<p class="cloud__empty">Answers will appear here as they come in.</p>
	{:else}
		<ul class="cloud" aria-label="Word cloud" bind:this={cloud}>
			{#each centreOut(words) as [word, count] (word)}
				<li
					class="cloud__word"
					class:cloud__word--top={count === biggest}
					class:cloud__word--quiet={count !== biggest && word.length % 2 === 1}
					style:font-size="calc(var(--fit, 1) * {wordSizeVw(count, biggest, words.length)}vw)"
				>
					{word}
				</li>
			{/each}
		</ul>
	{/if}
</main>

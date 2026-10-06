<script lang="ts">
	import { onMount } from 'svelte';
	import { connectionLost, isNewer, waitingCount, type RoomState } from '$lib/room-client';
	import { pollBars } from '$lib/poll';
	import { centreOut, wordSizeVw } from '$lib/words';
	import Brand from '$lib/Brand.svelte';
	import { brand } from '$lib/brand';

	let { data } = $props();

	const POLL_MS = 1000;
	// Each shrink step, and the floor below which words would be unreadable anyway.
	const FIT_STEP = 0.9;
	const MIN_FIT = 0.2;

	let room = $state<RoomState | null>(null);
	let missing = $state(false);
	let failedPolls = $state(0);
	let cloud = $state<HTMLUListElement>();
	let questionBox = $state<HTMLElement>();

	const words = $derived(room?.tallies ?? []);
	const biggest = $derived(words[0]?.[1] ?? 1);
	// Tallies arrive most first, so the last is the fewest.
	const fewest = $derived(words.at(-1)?.[1] ?? 1);
	const answers = $derived(words.reduce((sum, [, count]) => sum + count, 0));
	const isPoll = $derived(room?.item?.type === 'poll');
	const bars = $derived(isPoll ? pollBars(room?.item?.settings.options, words) : []);
	const mostVotes = $derived(Math.max(1, ...bars.map((bar) => bar.votes)));
	const isQna = $derived(room?.item?.type === 'qna');
	// The projector shows one question at a time, chosen by the host; phones see the whole list.
	const shown = $derived(room?.shown ?? null);
	const waiting = $derived(room?.waiting ?? 0);
	const waitingLabel = $derived(`${waitingCount(waiting)} more waiting`);
	const count = $derived(isQna ? (room?.questions ?? []).length : answers);
	const countNoun = $derived(
		isQna ? (count === 1 ? 'question' : 'questions') : isPoll ? (count === 1 ? 'vote' : 'votes') : count === 1 ? 'answer' : 'answers',
	);
	const prompt = $derived(typeof room?.item?.settings.prompt === 'string' ? room.item.settings.prompt : '');
	// Ended takes over the join box instead, so nobody scans into a finished room.
	const ended = $derived(room?.status === 'ended');
	const note = $derived(
		ended ? ''
		: connectionLost(failedPolls) ? 'Reconnecting…'
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

	// A long question shrinks to fit its box the same way the cloud does.
	$effect(() => {
		if (!questionBox || !shown) return;
		const box = questionBox;
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
			if (!response.ok) {
				failedPolls++;
				return;
			}
			failedPolls = 0;
			const next: RoomState = await response.json();
			if (isNewer(room, next)) room = next;
		} catch {
			// Offline for a moment: keep the last cloud on screen, and say so once it lasts.
			failedPolls++;
		}
	}

	onMount(() => {
		poll();
		const timer = setInterval(() => (missing || room?.status === 'ended' ? clearInterval(timer) : poll()), POLL_MS);
		return () => clearInterval(timer);
	});
</script>

<svelte:head>
	<title>Room {data.code} · {brand.name}</title>
</svelte:head>

<main class="host">
	<header class="host__top">
		<div>
			<div class="host__meta"><Brand /><p class="label">Room {data.code}{room?.hostName ? ` · ${room.hostName} hosting` : ''}{note ? ` · ${note}` : ''}</p></div>
			<h1 class="host__question">{missing ? "We can't find that room" : prompt}</h1>
		</div>
		{#if ended}
			<div class="host__join host__join--ended">
				<p class="host__ended">Session ended</p>
				<p class="host__count">{count} {countNoun}</p>
			</div>
		{:else if room}
			<div class="host__join">
				<div class="host__qr" role="img" aria-label="QR code to join at {data.joinUrl}">{@html data.qrSvg}</div>
				<div>
					<p class="host__joinText">Scan, or go to</p>
					<p class="host__url">{data.joinUrl.replace(/^https?:\/\//, '')}</p>
					<p class="host__code">{data.code}</p>
					<p class="host__count" aria-live="polite">{count} {countNoun}</p>
				</div>
			</div>
		{/if}
	</header>

	{#if !room && !missing}
		<p class="cloud__empty" aria-live="polite">Loading…</p>
	{:else if missing}
		<p class="cloud__empty">Check the code and try again.</p>
	{:else if isPoll}
		<ol class="poll" aria-label="Poll results">
			{#each bars as bar (bar.label)}
				<li class="poll__row">
					<span>{bar.label}</span>
					<span class="poll__count">{bar.votes} {bar.votes === 1 ? 'vote' : 'votes'}</span>
					<span class="poll__track" aria-hidden="true"><span class="poll__bar" style:width="{(bar.votes / mostVotes) * 100}%"></span></span>
				</li>
			{/each}
		</ol>
	{:else if isQna}
		{#if shown}
			<section class="qna1" aria-label="Question on screen">
				<div class="qna1__body" bind:this={questionBox} aria-live="polite">
					<p class="qna1__text">{shown[1]}</p>
					<p class="qna1__votes">{shown[2]} {shown[2] === 1 ? 'vote' : 'votes'}</p>
				</div>
				<p class="qna1__more">{waiting > 0 ? waitingLabel : 'No more questions waiting'}</p>
			</section>
		{:else if waiting > 0}
			<section class="qna1" aria-label="Questions waiting">
				<div class="qna1__body" aria-live="polite">
					<p class="qna1__count">{waitingCount(waiting)} {waiting === 1 ? 'question' : 'questions'} waiting</p>
					<p class="qna1__hint">Questions come up one at a time, when the host is ready.</p>
				</div>
			</section>
		{:else}
			<p class="cloud__empty">{ended ? 'No questions were asked.' : 'Questions will appear here as they come in.'}</p>
		{/if}
	{:else if words.length === 0}
		<p class="cloud__empty">{ended ? 'No answers were sent.' : 'Answers will appear here as they come in.'}</p>
	{:else}
		<ul class="cloud" aria-label="Word cloud" bind:this={cloud}>
			{#each centreOut(words) as [word, count] (word)}
				<li
					class="cloud__word"
					class:cloud__word--top={count === biggest}
					class:cloud__word--quiet={count === fewest && count !== biggest}
					style:font-size="calc(var(--fit, 1) * {wordSizeVw(count, biggest, words.length)}vw)"
				>
					{word}
				</li>
			{/each}
		</ul>
	{/if}
</main>

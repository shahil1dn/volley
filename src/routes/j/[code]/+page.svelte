<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { normaliseWord } from '$lib/words';
	import {
		isNewer,
		loadSent,
		MESSAGES,
		newSubmitId,
		saveSent,
		serverClockOffset,
		type RoomState,
		type SentByItem,
	} from '$lib/room-client';

	const POLL_MS = 3000;
	// Waits before the 2nd and 3rd attempt at the same answer after a network failure.
	const RETRY_DELAYS_MS = [1000, 2500];
	// Matches submit_answer's default when an item doesn't set answersPerPerson.
	const DEFAULT_ANSWERS = 3;

	const code = (page.params.code ?? '').toUpperCase();
	const answerUrl = `/api/r/${code}/answer`;

	let room = $state<RoomState | null>(null);
	let missing = $state(false);
	// Read by the quiz countdown in Milestone 2; tracked from the first poll so
	// the offset is settled by the time a quiz starts.
	let clockOffsetMs = $state(0);
	let sent = $state<SentByItem>({});
	let draft = $state('');
	// The chosen poll option's position, as the server expects it.
	let choice = $state('');
	let busy = $state(false);
	let notice = $state('');
	// The answer being sent, kept with its id until the server has decided on it,
	// so pressing Send again after a failure retries the same submit (SPEC 12).
	let pending: { submitId: string; value: string } | null = null;

	const item = $derived(room?.item ?? null);
	const position = $derived(room?.currentPosition ?? 0);
	const prompt = $derived(typeof item?.settings.prompt === 'string' ? item.settings.prompt : 'Share a word or short phrase');
	const isPoll = $derived(item?.type === 'poll');
	const options = $derived(isPoll && Array.isArray(item?.settings.options) ? item.settings.options.map(String) : []);
	const allowed = $derived(Number(item?.settings.answersPerPerson ?? DEFAULT_ANSWERS));
	const mine = $derived(sent[position] ?? { words: [], left: allowed });
	const accepting = $derived(room?.status === 'live' && room.itemState === 'open' && (item?.type === 'word_cloud' || isPoll));

	async function poll() {
		try {
			const response = await fetch(`/api/r/${code}/state`);
			if (response.status === 404) {
				missing = true;
				return;
			}
			if (!response.ok) return;
			const next: RoomState = await response.json();
			if (!isNewer(room, next)) return;
			clockOffsetMs = serverClockOffset(next.serverNow, response.headers.get('age'), Date.now());
			room = next;
		} catch {
			// Offline for a moment: keep showing the last state and try again next tick.
		}
	}

	// Asks the server for this phone's participant cookie, if it hasn't got one.
	async function join() {
		await fetch(answerUrl, { cache: 'no-store' }).catch(() => undefined);
	}

	function post(answer: { submitId: string; value: string }) {
		return fetch(answerUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(answer),
		});
	}

	async function submitWithRetries(answer: { submitId: string; value: string }): Promise<{ status: string; left?: number }> {
		for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
			if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]));
			try {
				let response = await post(answer);
				if (response.status === 401) {
					await join();
					response = await post(answer);
				}
				if (response.status >= 500) continue;
				return await response.json();
			} catch {
				// The request or its answer was lost: try again with the same submit id.
			}
		}
		return { status: 'network' };
	}

	function record(word: string | null, left: number) {
		const entry = sent[position] ?? { words: [], left };
		sent[position] = { words: word ? [...entry.words, word] : entry.words, left };
		saveSent(code, $state.snapshot(sent));
	}

	// Sends one answer (a word, or a poll option's position) and records what the
	// phone shows for it. True when the server accepted it.
	async function deliver(value: string, shown: string): Promise<boolean> {
		if (pending?.value !== value) pending = { submitId: newSubmitId(), value };

		busy = true;
		notice = '';
		const result = await submitWithRetries(pending);
		busy = false;

		if (result.status === 'ok' || result.status === 'limit') {
			record(result.status === 'ok' ? shown : null, result.left ?? 0);
			pending = null;
			return result.status === 'ok';
		}
		notice = MESSAGES[result.status] ?? MESSAGES.network;
		// Refused for good: the next Send is a new answer. After a network failure or
		// a busy room, the same answer keeps its id.
		if (result.status !== 'network' && result.status !== 'rate_limited') pending = null;
		return false;
	}

	async function send(event: SubmitEvent) {
		event.preventDefault();
		const value = draft.trim();
		if (busy || !value) return;
		if (normaliseWord(value) === null) {
			notice = MESSAGES.invalid;
			return;
		}
		if (await deliver(value, value)) draft = '';
	}

	async function vote(event: SubmitEvent) {
		event.preventDefault();
		if (busy || choice === '') return;
		await deliver(choice, options[Number(choice)] ?? '');
	}

	onMount(() => {
		sent = loadSent(code);
		join();
		poll();
		const timer = setInterval(() => {
			if (missing || room?.status === 'ended') clearInterval(timer);
			else poll();
		}, POLL_MS);
		return () => clearInterval(timer);
	});
</script>

<svelte:head>
	<title>Room {code}</title>
</svelte:head>

<main class="phone" data-clock-offset={clockOffsetMs}>
	<p class="label">Room {code}</p>

	{#if missing}
		<h1>We can't find that room</h1>
		<p class="hint">Check the code on the big screen and try again.</p>
	{:else if !room}
		<p class="hint phone__foot" aria-live="polite">Joining…</p>
	{:else if room.status === 'ended'}
		<h1>That's a wrap</h1>
		<p class="hint">This session has ended. Thanks for joining in.</p>
	{:else if accepting && isPoll && mine.left > 0}
		<h1 id="poll-question">{prompt}</h1>
		<form class="stack" onsubmit={vote}>
			<fieldset class="choices" aria-labelledby="poll-question">
				{#each options as option, i (i)}
					<label class="choice"><input type="radio" name="choice" value={String(i)} bind:group={choice} />{option}</label>
				{/each}
			</fieldset>
			<button class="btn btn--block" disabled={busy || choice === ''}>{busy ? 'Sending…' : 'Vote'}</button>
			{#if notice}<p class="error" role="alert">{notice}</p>{/if}
		</form>
	{:else if accepting && mine.left > 0}
		<h1>{prompt}</h1>
		<form class="stack" onsubmit={send}>
			<label class="field">
				<input
					bind:value={draft}
					maxlength="100"
					autocomplete="off"
					autocapitalize="none"
					enterkeyhint="send"
					placeholder="A word or short phrase"
					aria-label="Your answer"
				/>
			</label>
			<button class="btn btn--block" disabled={busy || !draft.trim()}>{busy ? 'Sending…' : 'Send'}</button>
			{#if notice}<p class="error" role="alert">{notice}</p>{/if}
			<p class="hint" aria-live="polite">
				{#if mine.words.length === 0}
					You can send up to {mine.left}.
				{:else}
					Sent: {mine.words.join(', ')}. {mine.left} left.
				{/if}
			</p>
		</form>
	{:else if accepting}
		<h1>{prompt}</h1>
		<p class="hint phone__foot" aria-live="polite">
			{#if isPoll}
				{mine.words.length > 0 ? `You voted: ${mine.words[0]}.` : "You've already voted on this one."} Results are on the big screen.
			{:else}
				{MESSAGES.limit}
				{#if mine.words.length > 0}Yours ({mine.words.join(', ')}) are on the big screen.{/if}
			{/if}
		</p>
	{:else if room.status === 'frozen'}
		<h1>Answers are paused</h1>
		<p class="hint">The host will open them again in a moment. Keep this page open.</p>
	{:else}
		<h1>{room.status === 'lobby' ? "You're in" : 'Waiting for the next question'}</h1>
		<p class="hint">Keep this page open. It updates by itself.</p>
	{/if}
</main>

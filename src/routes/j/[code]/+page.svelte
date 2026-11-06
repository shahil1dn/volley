<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { page } from '$app/state';
	import { normaliseWord } from '$lib/words';
	import { formPages, formQuestions, ratingLabel, SCALES } from '$lib/feedback';
	import Brand from '$lib/Brand.svelte';
	import ThanksBackdrop from '$lib/ThanksBackdrop.svelte';
	import { brand } from '$lib/brand';
	import {
		connectionLost,
		isNewer,
		loadSent,
		loadUpvoted,
		MESSAGES,
		newSubmitId,
		saveSent,
		keepOwnCount,
		saveUpvoted,
		serverClockOffset,
		stateMadeAt,
		type OwnCount,
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
	// Polls that failed in a row; a reply, even an old one, resets it.
	let failedPolls = $state(0);
	// Read by the quiz countdown in Milestone 2; tracked from the first poll so
	// the offset is settled by the time a quiz starts.
	let clockOffsetMs = $state(0);
	let sent = $state<SentByItem>({});
	let draft = $state('');
	// The chosen poll option's position, as the server expects it.
	let choice = $state('');
	let busy = $state(false);
	let notice = $state('');
	// Q&A: the questions this phone has upvoted, and those with a vote in flight.
	let upvoted = $state<number[]>([]);
	let voting = $state<number[]>([]);
	// The count the server returned for each of this phone's own votes, until a newer state replaces it.
	let ownCounts = $state<Record<number, OwnCount>>({});
	// The answer being sent, kept with its id until the server has decided on it,
	// so pressing Send again after a failure retries the same submit (SPEC 12).
	let pending: { submitId: string; value: string } | null = null;

	const item = $derived(room?.item ?? null);
	const position = $derived(room?.currentPosition ?? 0);
	const prompt = $derived(typeof item?.settings.prompt === 'string' ? item.settings.prompt : 'Share a word or short phrase');
	const isPoll = $derived(item?.type === 'poll');
	const isQna = $derived(item?.type === 'qna');
	const isThanks = $derived(item?.type === 'thanks');
	const isFeedback = $derived(item?.type === 'feedback');
	const formItems = $derived(isFeedback ? formQuestions(item?.settings) : []);
	const questions = $derived(room?.questions ?? []);
	// The question the host has put on the big screen, if it is still in the list.
	const onScreenId = $derived(room?.shown?.[0] ?? null);
	const options = $derived(isPoll && Array.isArray(item?.settings.options) ? item.settings.options.map(String) : []);
	const allowed = $derived(Number(item?.settings.answersPerPerson ?? DEFAULT_ANSWERS));
	const mine = $derived(sent[position] ?? { words: [], left: allowed });
	const accepting = $derived(room?.status === 'live' && room.itemState === 'open' && (item?.type === 'word_cloud' || isPoll || isQna || isFeedback));

	// A feedback form's ratings so far, one per question (null: not rated yet), and the phone
	// page it is on. Started afresh only when the activity or its number of questions changes,
	// not on every poll. Kept in memory only, like any answer not yet sent: a reload starts again.
	let ratings = $state<(number | null)[]>([]);
	let formPage = $state(0);
	let ratingsFor: number | null = null;
	$effect(() => {
		if (ratingsFor === position && ratings.length === formItems.length) return;
		ratingsFor = position;
		ratings = formItems.map(() => null);
		formPage = 0;
	});
	// Counted against the questions, not the list, so it is never 0 before the list is made.
	const unrated = $derived(formItems.filter((_, q) => ratings[q] == null).length);
	// Up to 3 questions a page (ADR-018). Next waits for every question on its page, as Send
	// waits for every question on the form.
	const pages = $derived(formPages(formItems.length));
	const pageRange = $derived(pages[formPage] ?? [0, 0]);
	const pageQuestions = $derived(formItems.slice(pageRange[0], pageRange[1]));
	const pageUnrated = $derived(pageQuestions.filter((_, i) => ratings[pageRange[0] + i] == null).length);
	const onLastPage = $derived(formPage >= pages.length - 1);
	let formTop = $state<HTMLElement>();

	async function poll() {
		try {
			const sentAt = Date.now();
			const response = await fetch(`/api/r/${code}/state`);
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
			if (!isNewer(room, next)) return;
			const receivedAt = Date.now();
			clockOffsetMs = serverClockOffset(next.serverNow, response.headers.get('age'), receivedAt);
			room = next;
			const madeAt = stateMadeAt(sentAt, receivedAt, response.headers.get('age'));
			for (const [id, own] of Object.entries(ownCounts)) {
				if (!keepOwnCount(own, madeAt, receivedAt)) delete ownCounts[Number(id)];
			}
		} catch {
			// Offline for a moment: keep showing the last state, say so once it lasts, and try again next tick.
			failedPolls++;
		}
	}

	// Asks the server for this phone's participant cookie, if it hasn't got one.
	async function join() {
		await fetch(answerUrl, { cache: 'no-store' }).catch(() => undefined);
	}

	// An answer ({submitId, value}) or an upvote ({questionId, up}). Both are safe
	// to send again: an answer by its submit id, an upvote because it sets a vote.
	type Outcome = { status: string; left?: number; voted?: boolean; votes?: number };

	function post(body: object) {
		return fetch(answerUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
	}

	async function submitWithRetries(body: object): Promise<Outcome> {
		for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
			if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]));
			try {
				let response = await post(body);
				if (response.status === 401) {
					await join();
					response = await post(body);
				}
				if (response.status >= 500) continue;
				return await response.json();
			} catch {
				// The request or its answer was lost: try again with the same submit id.
			}
		}
		return { status: 'network' };
	}

	function record(words: string[], left: number) {
		const entry = sent[position] ?? { words: [], left };
		sent[position] = { words: [...entry.words, ...words], left };
		saveSent(code, $state.snapshot(sent));
	}

	// Sends one answer (a word, a poll option's position, or a whole feedback form)
	// and records what the phone shows for it. True when the server accepted it.
	async function deliver(value: string, shown: string[]): Promise<boolean> {
		if (pending?.value !== value) pending = { submitId: newSubmitId(), value };

		busy = true;
		notice = '';
		const result = await submitWithRetries(pending);
		busy = false;

		if (result.status === 'ok' || result.status === 'limit') {
			record(result.status === 'ok' ? shown : [], result.left ?? 0);
			pending = null;
			return result.status === 'ok';
		}
		const invalid = isQna ? MESSAGES.questionInvalid : isFeedback ? MESSAGES.formInvalid : MESSAGES.invalid;
		notice = (result.status === 'invalid' ? invalid : MESSAGES[result.status]) ?? MESSAGES.network;
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
		if (await deliver(value, [value])) draft = '';
	}

	async function ask(event: SubmitEvent) {
		event.preventDefault();
		const value = draft.trim();
		if (busy || !value) return;
		if ([...value].length > 280) {
			notice = MESSAGES.questionInvalid;
			return;
		}
		if (await deliver(value, [value])) draft = '';
	}

	async function upvote(id: number) {
		if (voting.includes(id)) return;
		voting = [...voting, id];
		notice = '';
		const result = await submitWithRetries({ questionId: id, up: !upvoted.includes(id) });
		voting = voting.filter((other) => other !== id);
		if (result.status !== 'ok') {
			notice = MESSAGES[result.status] ?? MESSAGES.network;
			return;
		}
		upvoted = result.voted ? [...new Set([...upvoted, id])] : upvoted.filter((other) => other !== id);
		saveUpvoted(code, upvoted);
		if (typeof result.votes === 'number') ownCounts[id] = { votes: result.votes, at: Date.now() };
	}

	async function vote(event: SubmitEvent) {
		event.preventDefault();
		if (busy || choice === '') return;
		await deliver(choice, [options[Number(choice)] ?? '']);
	}

	// Another page of the form: its top in view, and the keyboard on its first question
	// (on the point already chosen, if there is one), as a tab into the group would land.
	async function turnPage(to: number) {
		formPage = to;
		await tick();
		formTop?.scrollIntoView({ block: 'start' });
		const first = formTop?.parentElement?.querySelector('fieldset');
		(first?.querySelector<HTMLInputElement>('input:checked') ?? first?.querySelector<HTMLInputElement>('input'))?.focus({ preventScroll: true });
	}

	// The whole form at once, as the list of ratings in question order. What the
	// phone keeps is the ratings themselves, so it can show them back.
	async function rate(event: SubmitEvent) {
		event.preventDefault();
		if (busy || unrated > 0 || !onLastPage) return;
		const form = formItems.map((_, q) => ratings[q]);
		await deliver(JSON.stringify(form), form.map(String));
	}

	onMount(() => {
		sent = loadSent(code);
		upvoted = loadUpvoted(code);
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
	<title>Room {code} · {brand.name}</title>
</svelte:head>

<main class="phone" data-clock-offset={clockOffsetMs}>
	<header class="masthead"><Brand /><p class="label">Room {code}</p></header>

	{#if room && !missing && connectionLost(failedPolls)}
		<p class="notice" role="status">Connection lost. What's below may be out of date. Trying again…</p>
	{/if}

	{#if missing}
		<h1>We can't find that room</h1>
		<p class="hint">Check the code on the big screen and try again.</p>
	{:else if !room}
		<p class="hint phone__foot" aria-live="polite">{connectionLost(failedPolls) ? "Can't reach the session. Trying again…" : 'Joining…'}</p>
	{:else if room.status === 'ended'}
		<h1>That's a wrap</h1>
		<p class="hint">This session has ended. Thanks for joining in.</p>
	{:else if isThanks}
		<ThanksBackdrop picture="phone" />
		<section class="phone-slide">
			<h1 class="phone-slide__message">{prompt}</h1>
			<p class="phone-slide__hint">You can close this page now.</p>
		</section>
	{:else if isFeedback && mine.words.length > 0}
		<!-- Shown whatever the host does next with this form: what this phone sent, never the room's results. -->
		<section class="phone-thanks">
			<h1 class="phone-thanks__message">Thanks for your feedback</h1>
			<h2 class="sent-form__title">What you sent</h2>
			<ul class="sent-form">
				{#each formItems as question, q (q)}
					<li><span>{question.text}</span> <strong>{ratingLabel(question.scale, Number(mine.words[q]))}</strong></li>
				{/each}
			</ul>
		</section>
	{:else if accepting && isFeedback && mine.left > 0}
		<h1 id="form-title">{prompt}</h1>
		<p class="hint">Rate each one{pages.length > 1 ? ', page by page,' : ','} then send. You can send it once.</p>
		<form class="stack" aria-labelledby="form-title" onsubmit={rate}>
			{#if pages.length > 1}<p class="hint form-progress" aria-live="polite" bind:this={formTop}><span class="visually-hidden">Page</span> {formPage + 1} of {pages.length}</p>{/if}
			{#each pageQuestions as question, i (pageRange[0] + i)}
				{@const q = pageRange[0] + i}
				<fieldset class="rating">
					<legend class="rating__question">{question.text}</legend>
					<div class="rating__scale rating__scale--{question.scale}">
						{#each Array.from({ length: SCALES[question.scale].points }, (_, n) => n + 1) as point (point)}
							<label class="rating__point" class:rating__point--lit={question.scale === 'stars' && (ratings[q] ?? 0) >= point}>
								<input
									class="visually-hidden"
									type="radio"
									name="rating-{q}"
									value={point}
									checked={ratings[q] === point}
									onchange={() => (ratings[q] = point)}
								/>
								{#if question.scale === 'stars'}
									<svg class="rating__star" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z" /></svg>
									<span class="visually-hidden">{ratingLabel('stars', point)}</span>
								{:else if question.scale === 'ten'}
									{point} <span class="visually-hidden">out of 10</span>
								{:else}
									{ratingLabel('words', point)}
								{/if}
							</label>
						{/each}
					</div>
					{#if question.scale === 'stars'}<p class="rating__chosen" aria-hidden="true">{ratings[q] ? ratingLabel('stars', ratings[q]) : 'Not rated yet'}</p>{/if}
				</fieldset>
			{/each}
			<div class="form-nav">
				{#if formPage > 0}<button type="button" class="btn btn--quiet" disabled={busy} onclick={() => turnPage(formPage - 1)}>Back</button>{/if}
				{#if onLastPage}
					<button class="btn" disabled={busy || unrated > 0}>{busy ? 'Sending…' : 'Send'}</button>
				{:else}
					<button type="button" class="btn" disabled={pageUnrated > 0} onclick={() => turnPage(formPage + 1)}>Next</button>
				{/if}
			</div>
			<!-- Always on the page, so a screen reader hears it change, including when the form is ready. -->
			<p class="hint" aria-live="polite">
				{onLastPage
					? unrated > 0 ? `Rate every question to send. ${unrated} to go.` : 'Ready to send.'
					: pageUnrated > 0 ? `Rate these to go on. ${pageUnrated} to go.` : 'Ready for the next page.'}
			</p>
			{#if notice}<p class="error" role="alert">{notice}</p>{/if}
		</form>
	{:else if accepting && isFeedback}
		<h1>{prompt}</h1>
		<p class="sent" aria-live="polite">You've already sent this form. Thanks for your feedback.</p>
	{:else if accepting && isQna}
		<h1>{prompt}</h1>
		{#if mine.left > 0}
			<form class="stack" onsubmit={ask}>
				<label class="field">
					<span class="hint">Your question (anonymous)</span>
					<textarea bind:value={draft} rows="3" maxlength="400" enterkeyhint="send"></textarea>
				</label>
				<button class="btn btn--block" disabled={busy || !draft.trim()}>{busy ? 'Sending…' : 'Ask'}</button>
			</form>
		{:else}
			<p class="hint">You've asked as many questions as this allows. You can still upvote.</p>
		{/if}
		{#if notice}<p class="error" role="alert">{notice}</p>{/if}
		<h2>Questions</h2>
		{#if questions.length === 0}
			<p class="hint">No questions yet. Ask the first one.</p>
		{:else}
			<ol class="questions">
				{#each questions as [id, text, votes] (id)}
					{@const votesNow = ownCounts[id]?.votes ?? votes}
					<li class="question">
						<span>{text}</span>
						<span class="question__votes">{votesNow} {votesNow === 1 ? 'vote' : 'votes'}{#if id === onScreenId}{' · On screen now'}{/if}</span>
						<button
							class="btn btn--quiet"
							aria-pressed={upvoted.includes(id)}
							aria-label="Upvote “{text}”"
							disabled={voting.includes(id)}
							onclick={() => upvote(id)}
						>
							<!-- Pressed shows a tick as well as the fill, so it doesn't depend on colour. -->
							{#if upvoted.includes(id)}<svg class="btn__tick" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3 8.5l3.2 3.2L13 4.8" /></svg>{/if}
							Upvote
						</button>
					</li>
				{/each}
			</ol>
		{/if}
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
		<p class="sent" aria-live="polite">
			{#if mine.words.length === 0}
				You can send up to {mine.left}.
			{:else}
				Sent: <strong>{mine.words.join(', ')}</strong>. {mine.left} left.
			{/if}
		</p>
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
		</form>
	{:else if accepting}
		<h1>{prompt}</h1>
		<p class="sent" aria-live="polite">
			{#if isPoll}
				{#if mine.words.length > 0}You voted: <strong>{mine.words[0]}</strong>.{:else}You've already voted on this one.{/if} Results are on the big screen.
			{:else}
				{MESSAGES.limit}
				{#if mine.words.length > 0}Yours (<strong>{mine.words.join(', ')}</strong>) are on the big screen.{/if}
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

<script lang="ts">
	import { onMount } from 'svelte';
	import { cloudPng } from '$lib/cloud-png';
	import Brand from '$lib/Brand.svelte';
	import { brand } from '$lib/brand';

	let { data } = $props();

	type HostView = {
		status: 'lobby' | 'live' | 'frozen' | 'ended';
		version: number;
		currentPosition: number;
		itemCount: number;
		itemState: string;
		item: { type: string; settings: Record<string, unknown> } | null;
		tallies: [string, number, boolean][];
		// Q&A: [id, text, votes, hidden, answered, turn], the main list first. The
		// turn is when it was first put on the projector (null: not yet).
		questions: [number, string, number, boolean, boolean, number | null][];
		// Q&A: the id of the question on the projector now.
		shown: number | null;
	};

	const POLL_MS = 2000;
	// Why a Next or Previous question moved nothing (the database says which).
	const UNMOVED: Record<string, string> = {
		none_left: 'No more questions are waiting.',
		first: 'That is the first question shown.',
		stale: 'The projector had already moved. The page now shows where it is.',
	};
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
	// Ending leaves the item's own state as it was, but nothing is accepted after
	// the end (submit_answer checks the status), so say so.
	const answers = $derived(ended ? 'closed' : view?.itemState);
	const SESSION_LABELS: Record<string, string> = { lobby: 'Not started', live: 'Live', frozen: 'Frozen', ended: 'Ended' };
	const ANSWER_LABELS: Record<string, string> = { open: 'Open', closed: 'Closed', revealed: 'Shown' };
	const isPoll = $derived(view?.item?.type === 'poll');
	const isQna = $derived(view?.item?.type === 'qna');
	// "3 of 12": this question's turn among every visible question asked so far,
	// and how many others are waiting (unanswered, not on screen).
	const asked = $derived((view?.questions ?? []).filter(([, , , hidden]) => !hidden));
	const turn = $derived(asked.find(([id]) => id === view?.shown)?.[5] ?? null);
	const position = $derived(turn === null ? 0 : asked.filter((q) => q[5] !== null && q[5] <= turn).length);
	const waitingCount = $derived(asked.filter(([id, , , , answered]) => !answered && id !== view?.shown).length);
	const screenLine = $derived(
		view?.shown == null ? `Nothing on screen · ${waitingCount} waiting` : `On screen: ${position} of ${asked.length} · ${waitingCount} waiting`,
	);
	const prompt = $derived(typeof view?.item?.settings.prompt === 'string' ? view.item.settings.prompt : '');
	// What the projector shows: hidden words stay out of the image too.
	const visible = $derived((view?.tallies ?? []).filter(([, , hidden]) => !hidden).map(([word, count]): [string, number] => [word, count]));

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
			else if (action.startsWith('question_')) {
				const reply = await response.json().catch(() => ({}));
				if (reply.moved === false) notice = UNMOVED[reply.reason] ?? '';
			}
		} catch {
			notice = 'No connection. Try again.';
		}
		await refresh();
		busy = false;
	}

	async function downloadPng() {
		notice = '';
		try {
			const url = URL.createObjectURL(await cloudPng(prompt, visible));
			const link = document.createElement('a');
			link.href = url;
			link.download = `volley-${data.code}-word-cloud.png`;
			link.click();
			// Freed later, not at once: some browsers start the download after click() returns.
			setTimeout(() => URL.revokeObjectURL(url), 10_000);
		} catch {
			notice = 'Could not make the image in this browser.';
		}
	}

	onMount(() => {
		refresh();
		const timer = setInterval(refresh, POLL_MS);
		return () => clearInterval(timer);
	});
</script>

<svelte:head>
	<title>Control · {data.code} · {brand.name}</title>
</svelte:head>

<main class="control">
	<header class="masthead"><Brand /><p class="label">Room {data.code} · control</p></header>
	{#if missing}
		<h1>We can't find that session</h1>
	{:else if !view}
		<p class="hint" aria-live="polite">Loading…</p>
	{:else}
		<h1>{prompt}</h1>
		<dl class="status" aria-live="polite">
			<div class="status__item"><dt>Session</dt><dd>{SESSION_LABELS[view.status] ?? view.status}</dd></div>
			<div class="status__item"><dt>Answers</dt><dd>{ANSWER_LABELS[answers ?? ''] ?? answers}</dd></div>
			<div class="status__item"><dt>Activity</dt><dd>{view.currentPosition + 1} of {view.itemCount}</dd></div>
		</dl>
		<p class="hint">
			Projector: <a href="/run/{data.code}" target="_blank" rel="noopener">open the projector view</a>. Phones join at
			{data.joinUrl}
		</p>

		<div class="control__bar">
			{#if isQna}
				<div class="control__group" role="group" aria-labelledby="group-question">
					<span class="label" id="group-question">Question on screen</span>
					<div class="control__row">
						<button class="btn btn--quiet" disabled={busy || !live} onclick={() => act('question_back', String(view?.shown ?? ''))}>Previous question</button>
						<button class="btn" disabled={busy || !live} onclick={() => act('question_next', String(view?.shown ?? ''))}>Next question</button>
					</div>
				</div>
			{/if}
			<div class="control__group" role="group" aria-labelledby="group-answers">
				<span class="label" id="group-answers">Answers</span>
				<div class="control__row">
					{#if answers === 'open'}
						<button class={isQna ? 'btn btn--quiet' : 'btn'} disabled={busy || ended} onclick={() => act('close')}>Close answers</button>
					{:else}
						<button class={isQna ? 'btn btn--quiet' : 'btn'} disabled={busy || ended || view.status === 'frozen'} onclick={() => act('open')}>Open answers</button>
					{/if}
				</div>
			</div>
			<div class="control__group" role="group" aria-labelledby="group-activity">
				<span class="label" id="group-activity">Activity</span>
				<div class="control__row">
					<button class="btn btn--quiet" disabled={busy || !live || view.currentPosition === 0} onclick={() => act('back')}>Previous</button>
					<button class="btn btn--quiet" disabled={busy || !live || view.currentPosition >= view.itemCount - 1} onclick={() => act('next')}>Next</button>
				</div>
			</div>
			<div class="control__group" role="group" aria-labelledby="group-input">
				<span class="label" id="group-input">Input</span>
				<div class="control__row">
					{#if view.status === 'frozen'}
						<button class="btn btn--quiet" disabled={busy} onclick={() => act('unfreeze')}>Unfreeze input</button>
					{:else}
						<button class="btn btn--quiet" disabled={busy || !live} onclick={() => act('freeze')}>Freeze input</button>
					{/if}
				</div>
			</div>
		</div>
		<!-- Apart from the rest, and the only red button: it can't be undone. -->
		<div class="control__end">
			<button class="btn btn--danger" disabled={busy || ended} onclick={() => act('end')}>End session</button>
			<p class="hint">Ends it for everyone. Answers close for good.</p>
		</div>
		{#if notice}<p class="error" role="alert">{notice}</p>{/if}

		{#if isQna}
			<h2>Questions</h2>
			<p class="hint" aria-live="polite">{screenLine}</p>
			{#if view.questions.length === 0}
				<p class="hint">No questions yet.</p>
			{:else}
				<ul class="control__words">
					{#each view.questions as [id, text, votes, hidden, answered] (id)}
						<li class:control__word--hidden={hidden} class:control__word--shown={id === view.shown} aria-current={id === view.shown ? 'true' : undefined}>
							<span>{#if id === view.shown}<strong class="control__badge">On screen</strong> {/if}{text} <span class="hint">× {votes}{hidden ? ', hidden' : ''}{answered ? ', answered' : ''}</span></span>
							<div class="control__buttons">
								<button class="btn btn--quiet" disabled={busy || ended} onclick={() => act(answered ? 'unanswer' : 'answer', String(id))} aria-label="{answered ? 'Back to list:' : 'Mark answered:'} “{text}”">
									{answered ? 'Back to list' : 'Mark answered'}
								</button>
								<button class="btn btn--quiet" disabled={busy || ended} onclick={() => act(hidden ? 'unhide' : 'hide', String(id))} aria-label="{hidden ? 'Unhide' : 'Hide'} “{text}”">
									{hidden ? 'Unhide' : 'Hide'}
								</button>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		{:else}
			<h2>{isPoll ? 'Votes' : 'Words'}</h2>
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

		<h2>Export</h2>
		<p class="hint">Everyone's answers are deleted 24 hours after the session ends. Download what you need before then.</p>
		<div class="control__actions">
			<a class="btn btn--quiet" href="/api/r/{data.code}/host/export" download>Download results (CSV)</a>
			{#if view.item?.type === 'word_cloud'}
				<button class="btn btn--quiet" disabled={visible.length === 0} onclick={downloadPng}>Download word cloud (PNG)</button>
			{/if}
		</div>
	{/if}
</main>

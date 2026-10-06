<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import Brand from '$lib/Brand.svelte';
	import { brand } from '$lib/brand';
	import type { Draft, DraftErrors } from '$lib/session-draft';
	import { ACTIVITY_TYPES, MAX_ACTIVITIES, MAX_OPTIONS, MIN_OPTIONS } from '$lib/session-limits';

	let { data, form } = $props();

	type Option = { id: number; value: string; error?: string };
	type Row = { id: number; type: string; prompt: string; options: Option[]; typeError?: string; promptError?: string; optionsError?: string };

	// Ids are only for keeping each row's inputs together as others come and go.
	let nextId = 0;
	// Every poll keeps at least MIN_OPTIONS boxes, so choosing Poll shows them ready to fill.
	function makeRow(draft?: Draft, errors?: DraftErrors): Row {
		const count = Math.max(MIN_OPTIONS, draft?.options.length ?? 0);
		return {
			id: nextId++,
			type: draft?.type ?? 'word_cloud',
			prompt: draft?.prompt ?? '',
			options: Array.from({ length: count }, (_, j) => ({ id: nextId++, value: draft?.options[j] ?? '', error: errors?.option?.[j] })),
			typeError: errors?.type,
			promptError: errors?.prompt,
			optionsError: errors?.options,
		};
	}

	type Refusal = { drafts: Draft[]; errors: { form?: string; drafts: DraftErrors[] } };
	const rowsFrom = (refusal?: Refusal): Row[] => (refusal?.drafts.length ? refusal.drafts.map((draft, i) => makeRow(draft, refusal.errors.drafts[i])) : [makeRow()]);

	// Without script a refused post comes back as a whole new page, and `form`
	// holds exactly what was typed: it is the starting point, read once, and
	// from then on the host's edits are the truth.
	// svelte-ignore state_referenced_locally
	let rows = $state<Row[]>(rowsFrom(form ?? undefined));
	// svelte-ignore state_referenced_locally
	let formError = $state(form?.errors?.form);
	let starting = $state(false);
	// The host's session ended while they were filling in the form.
	let signedOut = $state(false);

	// The add and remove buttons need the page's script; until it runs they stay
	// disabled rather than doing nothing.
	let ready = $state(false);
	onMount(() => {
		// A type chosen before this script ran is in the page but not yet in `rows`.
		for (const row of rows) {
			const select = document.getElementById(`type-${row.id}`);
			if (select instanceof HTMLSelectElement) row.type = select.value;
		}
		ready = true;
		focusFirstProblem();
	});

	const focusFirstProblem = () => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();

	// Posts without leaving the page, so a refusal keeps everything on screen as
	// typed and only adds the messages. Without script the form posts normally.
	const submit: SubmitFunction = () => {
		starting = true;
		formError = undefined;
		signedOut = false;
		return async ({ result, update }) => {
			// A dropped connection or a server error: keep the form as typed instead of replacing the page.
			if (result.type === 'error') {
				signedOut = (result.error as { message?: string } | undefined)?.message === 'signed_out';
				// The reply may be what was lost, not the request: the session may exist.
				if (!signedOut) formError = "We couldn't confirm the session started. Check your connection, then press Start again. If the first try did go through, you'll end up with two rooms. What you typed is still here.";
				starting = false;
				return;
			}
			if (result.type !== 'failure') {
				await update();
				// A redirect leaves the page, so the button stays busy until it does.
				if (result.type !== 'redirect') starting = false;
				return;
			}
			const refusal = result.data as Refusal;
			if (refusal.drafts.length === rows.length) {
				for (const [i, row] of rows.entries()) showErrors(row, refusal.errors.drafts[i]);
			} else {
				// A hand-made post the page could never send: show what the server kept.
				rows = rowsFrom(refusal);
			}
			formError = refusal.errors.form;
			starting = false;
			await tick();
			focusFirstProblem();
		};
	};

	function showErrors(row: Row, errors: DraftErrors) {
		row.typeError = errors.type;
		row.promptError = errors.prompt;
		row.optionsError = errors.options;
		for (const [j, option] of row.options.entries()) option.error = row.type === 'poll' ? errors.option?.[j] : undefined;
	}
	// An option's message can point at another option ("Same as option 1"), so any
	// edit, add or removal in a poll drops all of that poll's option messages.
	function clearOptionErrors(row: Row) {
		row.optionsError = undefined;
		for (const option of row.options) option.error = undefined;
	}

	const focusSoon = async (id: string) => {
		await tick();
		document.getElementById(id)?.focus();
	};

	function addRow() {
		if (rows.length >= MAX_ACTIVITIES) return;
		const row = makeRow();
		rows.push(row);
		focusSoon(`prompt-${row.id}`);
	}
	function removeRow(i: number) {
		if (rows.length <= 1) return;
		rows.splice(i, 1);
		focusSoon('add-activity');
	}
	function addOption(row: Row) {
		if (row.options.length >= MAX_OPTIONS) return;
		const option = { id: nextId++, value: '' };
		row.options.push(option);
		clearOptionErrors(row);
		focusSoon(`option-${option.id}`);
	}
	function removeOption(row: Row, j: number) {
		if (row.options.length <= MIN_OPTIONS) return;
		row.options.splice(j, 1);
		clearOptionErrors(row);
		focusSoon(`add-option-${row.id}`);
	}
</script>

<svelte:head>
	<title>Start a session · {brand.name}</title>
</svelte:head>

<main class="phone phone--wide">
	<header class="masthead">
		<Brand />
		<form method="POST" action="?/signOut"><button class="btn btn--link">Sign out</button></form>
	</header>
	<!-- The one line that can be long (an email), so it truncates instead of wrapping. -->
	<p class="account label">
		<span>Signed in as</span>
		<span class="account__who" title={data.name ?? data.email}>{data.name ?? data.email}</span>
		{#if data.isAdmin}<span>·</span> <a href="/hosts">Manage hosts</a>{/if}
	</p>
	<h1>Start a session</h1>
	<p class="hint">Add up to {MAX_ACTIVITIES} activities. They run in order, all under one room code.</p>
	<form method="POST" action="?/startSession" class="stack" use:enhance={submit}>
		<ol class="activities">
			{#each rows as row, i (row.id)}
				<li>
				<div class="activity" role="group" aria-labelledby="activity-{row.id}">
					<div class="activity__head">
						<h2 id="activity-{row.id}">Activity {i + 1}</h2>
						<button type="button" class="btn btn--link" aria-label="Remove activity {i + 1}" disabled={!ready || rows.length === 1} onclick={() => removeRow(i)}>Remove</button>
					</div>
					<div class="activity__main">
						<div class="field">
							<label class="label" for="type-{row.id}">Type</label>
							<select
								id="type-{row.id}"
								name="type"
								aria-invalid={row.typeError ? 'true' : undefined}
								aria-describedby={row.typeError ? `type-error-${row.id}` : undefined}
								onchange={(event) => {
									row.type = event.currentTarget.value;
									row.typeError = undefined;
								}}
							>
								<!-- `selected` on each option, not `bind:value` on the select: binding
								     overwrites a choice made before this page's script ran. -->
								{#each ACTIVITY_TYPES as [value, name] (value)}<option {value} selected={row.type === value}>{name}</option>{/each}
							</select>
							{#if row.typeError}<p class="error" id="type-error-{row.id}">{row.typeError}</p>{/if}
						</div>
						<div class="field">
							<!-- No maxlength on the question or the options: the browser counts UTF-16
							     units and the limit counts characters (an emoji is one), so it would be
							     stricter than the server. The server's message beside the field is the limit. -->
							<label class="label" for="prompt-{row.id}">Question</label>
							<input
								id="prompt-{row.id}"
								name="prompt"
								bind:value={row.prompt}
								aria-invalid={row.promptError ? 'true' : undefined}
								aria-describedby={row.promptError ? `prompt-error-${row.id}` : undefined}
								oninput={() => (row.promptError = undefined)}
							/>
							{#if row.promptError}<p class="error" id="prompt-error-{row.id}">{row.promptError}</p>{/if}
						</div>
					</div>
					{#if row.type === 'poll'}
						<div class="options" role="group" aria-labelledby="options-{row.id}">
							<div class="options__head">
								<h3 id="options-{row.id}">Poll options</h3>
								<p class="hint">{MIN_OPTIONS} to {MAX_OPTIONS}, each different</p>
							</div>
							{#each row.options as option, j (option.id)}
								<div class="field">
									<label class="label" for="option-{option.id}">Option {j + 1}</label>
									<div class="option__row">
										<input
											id="option-{option.id}"
											name="options{i}"
											bind:value={option.value}
											aria-invalid={option.error ? 'true' : undefined}
											aria-describedby={option.error ? `option-error-${option.id}` : undefined}
											oninput={() => clearOptionErrors(row)}
										/>
										<button type="button" class="btn btn--link" aria-label="Remove option {j + 1}" disabled={!ready || row.options.length <= MIN_OPTIONS} onclick={() => removeOption(row, j)}>Remove</button>
									</div>
									{#if option.error}<p class="error" id="option-error-{option.id}">{option.error}</p>{/if}
								</div>
							{/each}
							{#if row.optionsError}<p class="error" role="alert">{row.optionsError}</p>{/if}
							<div class="adder">
								<button type="button" class="btn btn--quiet btn--small" id="add-option-{row.id}" disabled={!ready || row.options.length >= MAX_OPTIONS} onclick={() => addOption(row)}>Add option</button>
								<p class="hint">{row.options.length} of {MAX_OPTIONS}</p>
							</div>
						</div>
					{/if}
				</div>
				</li>
			{/each}
		</ol>
		<div class="adder adder--ruled">
			<button type="button" class="btn btn--quiet" id="add-activity" disabled={!ready || rows.length >= MAX_ACTIVITIES} onclick={addRow}>Add activity</button>
			<p class="hint">{rows.length} of {MAX_ACTIVITIES}{#if rows.length >= MAX_ACTIVITIES} · that's the most a session can hold{/if}</p>
		</div>
		{#if signedOut}<p class="error" role="alert">You've been signed out, so the session wasn't started. <a href="/" target="_blank" rel="noopener">Sign in again</a> in a new tab, then press Start here; what you typed is still here.</p>{/if}
		{#if formError}<p class="error" role="alert">{formError}</p>{/if}
		<button class="btn btn--block" disabled={starting}>{starting ? 'Starting…' : 'Start session'}</button>
	</form>
</main>

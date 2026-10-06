<script lang="ts">
	import { onMount, tick } from 'svelte';
	import Brand from '$lib/Brand.svelte';
	import { brand } from '$lib/brand';
	import { ACTIVITY_TYPES, MAX_ACTIVITIES, MAX_OPTION_CHARS, MAX_OPTIONS, MAX_PROMPT_CHARS, MIN_OPTIONS } from '$lib/session-limits';

	let { data, form } = $props();

	type Option = { id: number; value: string; error?: string };
	type Row = { id: number; type: string; prompt: string; options: Option[]; typeError?: string; promptError?: string; optionsError?: string };

	// Ids are only for keeping each row's inputs together as others come and go.
	let nextId = 0;
	// Every poll keeps at least MIN_OPTIONS boxes, so choosing Poll shows them ready to fill.
	function makeRow(draft?: { type: string; prompt: string; options: string[] }, errors?: { type?: string; prompt?: string; options?: string; option?: Record<number, string> }): Row {
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

	// After a refused submit the server hands back exactly what was typed. It is
	// read once, as the starting point: from then on the host's edits are the truth.
	// svelte-ignore state_referenced_locally
	let rows = $state<Row[]>(form?.drafts?.length ? form.drafts.map((draft, i) => makeRow(draft, form.errors.drafts[i])) : [makeRow()]);
	// svelte-ignore state_referenced_locally
	const formError = form?.errors?.form;

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
		document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
	});

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
		row.optionsError = undefined;
		focusSoon(`option-${option.id}`);
	}
	function removeOption(row: Row, j: number) {
		if (row.options.length <= MIN_OPTIONS) return;
		row.options.splice(j, 1);
		row.optionsError = undefined;
		focusSoon(`add-option-${row.id}`);
	}
</script>

<svelte:head>
	<title>Start a session · {brand.name}</title>
</svelte:head>

<main class="phone phone--wide">
	<header class="masthead"><Brand /><p class="label">Signed in as {data.name ?? data.email}{#if data.isAdmin} · <a href="/hosts">Manage hosts</a>{/if}</p></header>
	<h1>Start a session</h1>
	<p class="hint">Add up to {MAX_ACTIVITIES} activities. They run in order, all under one room code.</p>
	<form method="POST" action="?/startSession" class="stack">
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
							<label class="label" for="prompt-{row.id}">Question</label>
							<input
								id="prompt-{row.id}"
								name="prompt"
								maxlength={MAX_PROMPT_CHARS}
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
											maxlength={MAX_OPTION_CHARS}
											bind:value={option.value}
											aria-invalid={option.error ? 'true' : undefined}
											aria-describedby={option.error ? `option-error-${option.id}` : undefined}
											oninput={() => (option.error = undefined)}
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
		{#if formError}<p class="error" role="alert">{formError}</p>{/if}
		<button class="btn btn--block">Start session</button>
	</form>
	<form method="POST" action="?/signOut" class="stack">
		<button class="btn btn--block btn--quiet">Sign out</button>
	</form>
</main>

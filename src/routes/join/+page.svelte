<script lang="ts">
	import Brand from '$lib/Brand.svelte';
	import { brand } from '$lib/brand';

	let { data } = $props();

	const PROBLEMS = {
		format: 'Room codes are 5 letters and numbers, like K7Q2M. Check the big screen.',
		unknown: "There's no session with that code right now. Check the code on the big screen.",
	};
</script>

<svelte:head>
	<title>Join a session · {brand.name}</title>
</svelte:head>

<main class="phone">
	<header class="masthead"><Brand /></header>
	<h1>Join a session</h1>
	<form method="GET" class="stack">
		<label class="field">
			<span class="hint">Room code</span>
			<input
				name="code"
				defaultValue={data.typed}
				required
				maxlength="12"
				autocomplete="off"
				autocapitalize="characters"
				autocorrect="off"
				spellcheck="false"
				enterkeyhint="go"
				aria-invalid={data.problem ? 'true' : undefined}
				aria-describedby={data.problem ? 'code-problem' : undefined}
			/>
		</label>
		{#if data.problem}<p class="error" id="code-problem" role="alert">{PROBLEMS[data.problem]}</p>{/if}
		<button class="btn btn--block">Join</button>
	</form>
</main>

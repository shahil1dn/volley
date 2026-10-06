<script lang="ts">
	import { page } from '$app/state';
	import Brand from '$lib/Brand.svelte';
	import { brand } from '$lib/brand';

	const notFound = $derived(page.status === 404);
</script>

<svelte:head>
	<title>{notFound ? 'Page not found' : 'Something went wrong'} · {brand.name}</title>
</svelte:head>

<main class="phone">
	<header class="masthead"><Brand /></header>
	<h1>{notFound ? "We can't find that page" : 'Something went wrong'}</h1>
	<p class="hint">
		{notFound ? 'The link may be mistyped or out of date.' : "That's on our side, not yours. Try again in a moment."}
	</p>
	<div class="stack">
		<a class="btn btn--block" href="/join">Join a session</a>
		<p class="hint"><a href="/">Host sign-in</a></p>
	</div>
</main>

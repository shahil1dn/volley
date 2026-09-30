<script lang="ts">
	import '../app.css';
	import { brand } from '$lib/brand';
	import { palette, themeCss } from '$lib/theme';

	let { children } = $props();

	// Built from src/lib/brand.ts, never from anything a visitor sends.
	const colours = `<style>${themeCss(palette(brand.colours))}</style>`;
</script>

<svelte:head>
	{@html colours}
</svelte:head>

{@render children()}

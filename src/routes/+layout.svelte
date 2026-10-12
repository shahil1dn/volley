<script lang="ts">
	import '../app.css';
	import { brand } from '$lib/brand';
	import { fontCss, palette, themeCss } from '$lib/theme';

	let { children } = $props();

	// Built from src/lib/brand.ts, never from anything a visitor sends.
	const theme = `<style>${themeCss(palette(brand.colours))}${fontCss(brand.fonts)}</style>`;
</script>

<svelte:head>
	{@html theme}
</svelte:head>

{@render children()}

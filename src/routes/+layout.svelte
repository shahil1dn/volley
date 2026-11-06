<script lang="ts">
	import '../app.css';
	import { brand } from '$lib/brand';
	import { fontCss, logoCss, palette, thanksBackdropCss, themeCss } from '$lib/theme';

	let { children } = $props();

	// Built from src/lib/brand.ts, never from anything a visitor sends.
	const colours = palette(brand.colours);
	const theme = `<style>${themeCss(colours)}${fontCss(brand.fonts)}${logoCss(brand.logoHeight)}${thanksBackdropCss(brand.thankYou.background, colours)}</style>`;
</script>

<svelte:head>
	{@html theme}
</svelte:head>

{@render children()}

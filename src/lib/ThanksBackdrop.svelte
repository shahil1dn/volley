<script lang="ts">
	import { brand } from '$lib/brand';

	// The thank-you slide's picture, if the copy has one: the tall one on a phone, the
	// wide one on the projector. Drawn only while the slide is on screen, so the picture
	// is never fetched anywhere else.
	let { picture }: { picture: 'phone' | 'projector' } = $props();
</script>

{#if brand.thankYou.background}<div class="thanks-backdrop thanks-backdrop--{picture}" aria-hidden="true"></div>{/if}

<script lang="ts">
	import { brand } from '$lib/brand';
</script>

{#if brand.logo}
	<img class="brand brand--logo" src={brand.logo} alt={brand.name} />
{:else}
	<span class="brand">{brand.name}</span>
{/if}

<script lang="ts">
	let { data } = $props();
</script>

<svelte:head>
	<title>Your decks</title>
</svelte:head>

<main class="phone">
	<p class="label">Signed in as {data.email}</p>
	<h1>Your decks</h1>
	<p class="hint">Decks arrive in Milestone 3.</p>
	<form method="POST" action="?/signOut" class="stack">
		<button class="btn btn--block">Sign out</button>
	</form>
</main>

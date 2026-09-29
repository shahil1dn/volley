import adapter from '@sveltejs/adapter-vercel';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		// The adapter defaults to US East; functions sit beside the London database (ADR-002).
		// Without a pinned runtime the adapter copies the build machine's Node, and refuses
		// anything but 20/22/24, so a laptop on a newer Node could not build at all.
		adapter: adapter({ regions: ['lhr1'], runtime: 'nodejs24.x' })
	}
};

export default config;

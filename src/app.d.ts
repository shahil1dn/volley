// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
	namespace App {
		interface Locals {
			// Set by hooks.server.ts on host pages and APIs only.
			host?: { userId: string; email: string };
		}
	}
}

export {};

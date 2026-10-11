// What the load script will and will not point 200 phones at. Everything here runs before a single request
// is sent, and refuses with a plain sentence. Nothing in a refusal repeats the address it was given (it can
// carry a password) or anything from the host file.
import { statSync, readFileSync } from 'node:fs';
import { cliReason, type Exec } from './vercel.ts';

export class Refusal extends Error {}

// The production alias of this project. Any other production address is caught by asking Vercel (below).
export const PRODUCTION_HOSTS = ['aib-live.vercel.app'] as const;

const normaliseHost = (host: string): string => host.toLowerCase().replace(/\.$/, '');
const isLocalHost = (host: string): boolean => host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]';
const VERCEL_APP = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.vercel\.app$/;

export type Target = { url: URL; local: boolean };

export function parseTarget(raw: string | undefined, options: { local: boolean }): Target {
	const text = (raw ?? '').trim();
	if (!text) throw new Refusal('--target is required: the address of a Vercel preview deployment (or localhost, with --local).');
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		throw new Refusal("--target isn't a web address.");
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Refusal("--target isn't a web address.");
	if (url.username || url.password) throw new Refusal('--target must not carry credentials. Protection bypass and host sign-in are passed separately.');

	const host = normaliseHost(url.hostname);
	if ((PRODUCTION_HOSTS as readonly string[]).includes(host)) throw new Refusal(`${host} is the production address. The load test never runs against production.`);

	const localHost = isLocalHost(host);
	if (localHost && !options.local) throw new Refusal(`${host} is a local address: a local target needs --local.`);
	if (options.local && !localHost) throw new Refusal('--local is for localhost only. A remote target must be a Vercel preview, without --local.');
	if (!options.local) {
		if (url.protocol !== 'https:') throw new Refusal('A remote --target must use https.');
		if (!VERCEL_APP.test(host)) throw new Refusal('A remote --target must be a Vercel preview address ending in .vercel.app.');
	}
	if (url.pathname !== '/' || url.search || url.hash) throw new Refusal("--target must be only the site's address, with no path, query or fragment.");
	return { url: new URL(`${url.protocol}//${url.host}`), local: options.local };
}

export type DeploymentFacts = { target: string | null; aliases: string[] };

// Fails closed: a deployment Vercel cannot vouch for is treated as production.
export async function verifyNotProduction(host: string, lookup: (host: string) => Promise<DeploymentFacts>): Promise<void> {
	let facts: DeploymentFacts;
	try {
		facts = await lookup(host);
	} catch (error) {
		throw new Refusal(`The load test could not ask Vercel whether ${host} is a production deployment (${(error as Error).message}); refusing.`);
	}
	if (facts.target === 'production') throw new Refusal(`Vercel says ${host} is a production deployment. The load test never runs against production.`);
	const alias = facts.aliases.map(normaliseHost).find((name) => (PRODUCTION_HOSTS as readonly string[]).includes(name));
	if (alias) throw new Refusal(`${host} carries the production alias ${alias}. The load test never runs against production.`);
}

// Read only: GET /v13/deployments/{idOrUrl} through the Vercel CLI, which already holds the login.
// Field names (`target`, `alias`) are from Vercel's REST reference; not yet run against a live deployment.
export async function vercelDeploymentFacts(host: string, exec: Exec): Promise<DeploymentFacts> {
	const result = exec(['api', `/v13/deployments/${encodeURIComponent(host)}`]);
	if (result.status !== 0) throw new Error(`the Vercel CLI failed while reading the deployment (${cliReason(result)})`);
	let record: { target?: unknown; alias?: unknown };
	try {
		record = JSON.parse(result.stdout);
	} catch {
		throw new Error("Vercel's answer about the deployment wasn't JSON");
	}
	return {
		target: typeof record.target === 'string' ? record.target : null,
		aliases: Array.isArray(record.alias) ? record.alias.filter((name): name is string => typeof name === 'string') : [],
	};
}

export type HostLogin = { email: string; password: string };

// `email=…` and `password=…` lines in a file only the owner can read. Errors say what is wrong with the
// file, never what is in it.
export function readHostFile(path: string): HostLogin {
	let mode: number;
	try {
		mode = statSync(path).mode;
	} catch {
		throw new Refusal(`The host file ${path} doesn't exist. Make one on the TEST database with: npm run load-host`);
	}
	if ((mode & 0o077) !== 0) throw new Refusal(`The host file ${path} has permissions other than owner-only (0600); fix them or make a new one.`);
	const found: Record<string, string> = {};
	for (const line of readFileSync(path, 'utf8').split('\n')) {
		const at = line.indexOf('=');
		if (at > 0) found[line.slice(0, at).trim()] = line.slice(at + 1).trim();
	}
	if (!found.email) throw new Refusal(`The host file ${path} has no email= line.`);
	if (!found.password) throw new Refusal(`The host file ${path} has no password= line.`);
	return { email: found.email, password: found.password };
}

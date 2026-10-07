// What this app reads from its environment, in one place: doctor checks it, setup
// fills it in, .env.example documents it, and tests/doctor.test.ts fails if
// src/ reads a name that is missing here (found by grepping, not from memory).
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';

export type VarSpec = {
	name: string;
	// generated: setup makes it. supabase: comes from the Supabase project (via the Vercel
	// store or the dashboard). optional: only some commands read it.
	origin: 'generated' | 'supabase' | 'optional';
	// true: the app can't run without it. 'production': only the production deployment needs it.
	required: boolean | 'production';
	minLength?: number;
	what: string;
	where: string;
};

export const VARS: VarSpec[] = [
	{ name: 'HOST_SESSION_SECRET', origin: 'generated', required: true, minLength: 32, what: 'Signs host session cookies and sign-in rate-limit keys.', where: 'Made by `npm run setup`. Keep it private; changing it signs every host out.' },
	{ name: 'PARTICIPANT_SECRET', origin: 'generated', required: true, minLength: 32, what: "Signs the anonymous participant cookie and hashes phones' IP addresses.", where: 'Made by `npm run setup`. Keep it private; changing it makes phones look like new people.' },
	{ name: 'CRON_SECRET', origin: 'generated', required: 'production', minLength: 16, what: 'Lets Vercel Cron call /api/cron/keep-alive. Only the production deployment reads it.', where: 'Made by `npm run setup`; Vercel sends it as a Bearer token when it is set in the Production environment.' },
	{ name: 'SUPABASE_URL', origin: 'supabase', required: true, what: "The Supabase project's API address, https://<ref>.supabase.co.", where: 'Supabase dashboard → Project Settings → API, or the Vercel Supabase store (it sets this name).' },
	{ name: 'SUPABASE_SECRET_KEY', origin: 'supabase', required: true, what: 'Server-only key for the Auth admin API (creating hosts, invites). Never goes to a browser.', where: 'Supabase dashboard → Project Settings → API Keys (the secret key), or the Vercel Supabase store.' },
	{ name: 'POSTGRES_URL', origin: 'supabase', required: true, what: "The app's database connection: Supabase's TRANSACTION POOLER (host …pooler.supabase.com, port 6543).", where: 'Supabase dashboard → Connect → Transaction pooler, or the Vercel Supabase store (it sets this name).' },
	{ name: 'POSTGRES_URL_NON_POOLING', origin: 'supabase', required: true, what: 'Direct database connection, used only by scripts (migrations, first host), never by the running app.', where: 'Supabase dashboard → Connect → Direct connection, or the Vercel Supabase store.' },
	{ name: 'PUBLIC_SUPABASE_PUBLISHABLE_KEY', origin: 'supabase', required: true, what: "The project's publishable (anon) key, used for the sign-in password check. Safe to expose.", where: 'Supabase dashboard → Project Settings → API Keys. The Vercel store names it NEXT_PUBLIC_…; SvelteKit needs the PUBLIC_ prefix (`npm run setup` copies it).' },
	{ name: 'SUPABASE_ACCESS_TOKEN', origin: 'optional', required: false, what: 'A Supabase personal access token, only for `npm run setup -- --disable-signup`.', where: 'Supabase dashboard → Account → Access Tokens.' },
	{ name: 'VERCEL_AUTOMATION_BYPASS_SECRET', origin: 'optional', required: false, what: 'Lets the load-test scripts through a protected Vercel preview. Not read by the app.', where: 'Vercel dashboard → Project → Settings → Deployment Protection → Protection Bypass for Automation.' },
];

export const parse = (text: string): Record<string, string> =>
	Object.fromEntries(Object.entries(parseEnv(text)).filter((entry): entry is [string, string] => entry[1] !== undefined));

// Never print a value, only that it is there and how long it is.
export const mask = (value: string | undefined): string => (value ? `set (${value.length} chars)` : 'not set');

// 48 random bytes: far past guessing, and well over every minLength above.
export const makeSecret = (): string => randomBytes(48).toString('base64url');

// SvelteKit reads PUBLIC_…; the Vercel Supabase store hands out NEXT_PUBLIC_….
export const publicName = (name: string): string => name.replace(/^NEXT_PUBLIC_/, 'PUBLIC_');
export const nextPublicNames = (env: Record<string, string | undefined>): string[] =>
	Object.keys(env).filter((name) => name.startsWith('NEXT_PUBLIC_') && env[name]);

// A setting name as setup reads and writes it: nothing a RegExp or a shell would treat specially.
export const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

// What to write after `NAME=` so that `parse` reads exactly `value` back, or null when no form
// of quoting can carry it (a line break, or all three kinds of quote). Each candidate is proved
// by parsing it, not assumed: Node's parser does not process backslash escapes, for example.
export function quoteValue(value: string): string | null {
	if (/[\r\n\0]/.test(value)) return null;
	const plain = /^[A-Za-z0-9_@%+=:,./~-]*$/.test(value) ? [value] : [];
	return [...plain, `'${value}'`, `"${value}"`, `\`${value}\``].find((form) => parseEnv(`A=${form}`).A === value) ?? null;
}

// Replaces the line for `name` (keeping an `export ` prefix and the file's line endings), or
// appends one. Every other line is left as it was. A name that appears twice is collapsed to one
// line, so the file says what `parse` reads (the last one wins there).
export function setLine(text: string, name: string, value: string): string {
	if (!ENV_NAME.test(name)) throw new Error(`"${name}" isn't a valid setting name.`);
	const quoted = quoteValue(value);
	if (quoted === null) throw new Error(`The value for ${name} can't be stored safely in an env file (it has a line break, or quotes of every kind), so it was not written.`);
	// `name` passed ENV_NAME above: letters, digits and _ only, so it can't change the pattern.
	const pattern = new RegExp(`^(\\s*(?:export\\s+)?)${name}\\s*=`);
	const lines = text.split('\n');
	let placed = false;
	const out: string[] = [];
	for (const line of lines) {
		const found = pattern.exec(line);
		if (!found) {
			out.push(line);
			continue;
		}
		if (placed) continue;
		placed = true;
		out.push(`${found[1]}${name}=${quoted}${line.endsWith('\r') ? '\r' : ''}`);
	}
	if (placed) return out.join('\n');
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	return `${text}${text === '' || text.endsWith('\n') ? '' : eol}${name}=${quoted}${eol}`;
}

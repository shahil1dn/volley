// The Vercel side of doctor and setup, through the Vercel CLI only (it already holds the login).
// Everything goes through `exec` so tests can fake the CLI. Only ever the project linked in
// .vercel/ in the current folder: this module never takes a project name or id as input.
// Not verified against a live project: shapes follow Vercel's documented `vercel env ls
// --format json` and project API (ssoProtection.deploymentType); parsing is tolerant.
import { spawnSync } from 'node:child_process';
import type { VercelProbe } from './checks.ts';
import { redact } from './env.ts';

export type Exec = (args: string[], input?: string) => { status: number; stdout: string; stderr: string };

export const realExec = (cwd: string, timeoutMs = 60_000): Exec => (args, input) => {
	const run = spawnSync('vercel', [...args, '--non-interactive'], { cwd, input, encoding: 'utf8', timeout: timeoutMs });
	// No status means the CLI never ran to an end. That is not "a command that failed", and the fix is different.
	if ((run.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') throw new Error("the Vercel CLI isn't installed (install it with: npm i -g vercel)");
	const code = (run.error as NodeJS.ErrnoException | undefined)?.code;
	if (code === 'ETIMEDOUT' || (run.status === null && run.signal)) throw new Error(`the Vercel CLI did not finish within ${timeoutMs / 1000} seconds${run.signal ? ` (stopped by ${run.signal})` : ''}`);
	if (run.error) throw new Error(`the Vercel CLI could not be run (${code ?? run.error.message})`);
	if (run.status === null) throw new Error('the Vercel CLI stopped without an exit code');
	return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
};

export const TARGETS = ['production', 'preview', 'development'] as const;

// Lines the CLI prints that say nothing about why it failed: Claude Code's hint tag, spinner and
// progress lines ("Retrieving project…"), and the pointer to its docs. A line that starts with "Error" is
// never noise, even when it trails off with "…".
const NOISE = [/<claude-code-hint\b/i, /^[⠀-⣿]/, /^learn more\b/i, /^vercel cli \d/i];
const PROGRESS = /(…|\.\.\.)\s*$/;
const isError = (line: string) => /^error\b/i.test(line);
const CONTINUATION_CAP = 3;

// The reason a failed CLI call gives, for a person to read: its own JSON message when it printed one
// (non-interactive mode answers `action_required` on stdout), else the last "Error" line with the indented lines
// under it (a few), else the last meaningful line(s), else the exit code. The first line is not enough: it is
// usually progress. Redacted.
export function cliReason(result: ReturnType<Exec>, secrets: string[] = []): string {
	let reason = '';
	try {
		const answer = JSON.parse(result.stdout.trim()) as { reason?: unknown; message?: unknown };
		if (typeof answer.message === 'string') reason = typeof answer.reason === 'string' ? `${answer.reason}: ${answer.message}` : answer.message;
	} catch {
		// not JSON: read the text
	}
	if (!reason) {
		const lines = `${result.stderr}\n${result.stdout}`
			.split('\n')
			.filter((line) => {
				const text = line.trim();
				return text && !NOISE.some((noise) => noise.test(text)) && (isError(text) || !PROGRESS.test(text));
			});
		const lastError = lines.map((line) => isError(line.trim())).lastIndexOf(true);
		if (lastError >= 0) {
			const under: string[] = [];
			for (const line of lines.slice(lastError + 1)) {
				if (!/^\s/.test(line) || under.length === CONTINUATION_CAP) break;
				under.push(line.trim());
			}
			reason = [lines[lastError].trim(), ...under].join(' / ');
		} else reason = lines.slice(-2).map((line) => line.trim()).join(' / ');
	}
	return redact(reason || `exit ${result.status}`, secrets.filter(Boolean));
}

function json(result: ReturnType<Exec>, what: string): unknown {
	if (result.status !== 0) throw new Error(`the Vercel CLI failed while ${what} (${cliReason(result)})`);
	try {
		return JSON.parse(result.stdout);
	} catch {
		throw new Error(`the Vercel CLI's answer while ${what} wasn't JSON`);
	}
}

// Names by target. Accepts a bare array or { envs: [...] }; each entry's name is `key` or `name`
// and its targets are `target` / `targets` (an array or a single string).
export function parseEnvNames(parsed: unknown): Record<string, string[]> {
	const list = Array.isArray(parsed) ? parsed : ((parsed as { envs?: unknown })?.envs ?? []);
	const names: Record<string, string[]> = {};
	for (const entry of list as Record<string, unknown>[]) {
		const name = String(entry.key ?? entry.name ?? '');
		const raw = entry.target ?? entry.targets ?? [];
		for (const target of Array.isArray(raw) ? raw : [raw]) if (name && target) (names[String(target)] ??= []).push(name);
	}
	return names;
}

export function vercelProbe(exec: Exec, readLink: () => { projectId: string; orgId: string } | null): VercelProbe {
	const query = (link: { orgId: string }) => (link.orgId.startsWith('team_') ? `?teamId=${link.orgId}` : '');
	return {
		linked: readLink,
		async envNames() {
			return parseEnvNames(json(exec(['env', 'ls', '--format', 'json']), 'listing environment variables'));
		},
		async protection() {
			const link = readLink();
			if (!link) throw new Error('this folder is not linked to a Vercel project');
			const project = json(exec(['api', `/v9/projects/${link.projectId}${query(link)}`]), 'reading the project') as { ssoProtection?: { deploymentType?: string } | null };
			return project.ssoProtection?.deploymentType ?? null;
		},
	};
}

// Writes: only called by setup, only with its explicit flags.
export function setProtectionPreviewOnly(exec: Exec, link: { projectId: string; orgId: string }) {
	const query = link.orgId.startsWith('team_') ? `?teamId=${link.orgId}` : '';
	const result = exec(['api', `/v9/projects/${link.projectId}${query}`, '-X', 'PATCH', '--input', '-'], JSON.stringify({ ssoProtection: { deploymentType: 'preview' } }));
	if (result.status !== 0) throw new Error(`the Vercel CLI refused to change the protection (${cliReason(result)})`);
}

// The value goes in on stdin, so it never appears in a process list or a log.
export function addEnv(exec: Exec, name: string, target: string, value: string, sensitive: boolean) {
	// Preview wants a Git branch. Non-interactive, Vercel CLI 53.0.1 stops with git_branch_required unless the
	// third argument is there; an empty one is its own prompt's "leave empty for all Preview branches"
	// (dist/commands/env/index.js). Not run against a live project: the empty argument is read from the CLI's source.
	const branch = target === 'preview' ? [''] : [];
	const result = exec(['env', 'add', name, target, ...branch, '--yes', ...(sensitive ? ['--sensitive'] : [])], value);
	if (result.status !== 0) throw new Error(`the Vercel CLI could not add ${name} to ${target} (${cliReason(result, [value])})`);
}

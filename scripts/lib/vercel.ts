// The Vercel side of doctor and setup, through the Vercel CLI only (it already holds the login).
// Everything goes through `exec` so tests can fake the CLI. Only ever the project linked in
// .vercel/ in the current folder: this module never takes a project name or id as input.
// Not verified against a live project: shapes follow Vercel's documented `vercel env ls
// --format json` and project API (ssoProtection.deploymentType); parsing is tolerant.
import { spawnSync } from 'node:child_process';
import type { VercelProbe } from './checks.ts';

export type Exec = (args: string[], input?: string) => { status: number; stdout: string; stderr: string };

export const realExec = (cwd: string, timeoutMs = 60_000): Exec => (args, input) => {
	const run = spawnSync('vercel', [...args, '--non-interactive'], { cwd, input, encoding: 'utf8', timeout: timeoutMs });
	// No status means the CLI never ran to an end. That is not "a command that failed", and the fix is different.
	if ((run.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') throw new Error("the Vercel CLI isn't installed (install it with: npm i -g vercel)");
	if (run.status === null) throw new Error(`the Vercel CLI did not finish within ${timeoutMs / 1000} seconds${run.signal ? ` (stopped by ${run.signal})` : ''}`);
	return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
};

export const TARGETS = ['production', 'preview', 'development'] as const;

function json(result: ReturnType<Exec>, what: string): unknown {
	if (result.status !== 0) throw new Error(`the Vercel CLI failed while ${what} (${result.stderr.trim().split('\n')[0] || `exit ${result.status}`})`);
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
	if (result.status !== 0) throw new Error(`the Vercel CLI refused to change the protection (${result.stderr.trim().split('\n')[0] || `exit ${result.status}`})`);
}

// The value goes in on stdin, so it never appears in a process list or a log.
export function addEnv(exec: Exec, name: string, target: string, value: string, sensitive: boolean) {
	const result = exec(['env', 'add', name, target, '--yes', ...(sensitive ? ['--sensitive'] : [])], value);
	if (result.status !== 0) throw new Error(`the Vercel CLI could not add ${name} to ${target} (${result.stderr.trim().split('\n')[0] || `exit ${result.status}`})`);
}

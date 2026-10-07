// How doctor's results are printed: plain text for a person, JSON for an agent. Same content.
import { exitCode, type Check } from './checks.ts';

export const EXIT_HELP = [
	'Exit codes:',
	'  0  everything is ok (warnings and skipped checks never fail a run)',
	'  1  something failed that you, the agent, can fix by running a command or editing a file;',
	'     do that and run doctor again',
	'  2  something failed that only a person can do (a dashboard click, a password, a login);',
	'     the next action is marked HUMAN: with the exact place to go. Ask them, then run doctor again',
	'  If both kinds fail, the exit code is 1: do your own fixes first, then the run reports the human ones.',
].join('\n');

export function toJson(checks: Check[]) {
	const counts = { ok: 0, fail: 0, warn: 0, skipped: 0 };
	for (const check of checks) counts[check.status]++;
	const code = exitCode(checks);
	return { ok: code === 0, exitCode: code, counts, checks };
}

const MARK = { ok: 'ok  ', fail: 'FAIL', warn: 'warn', skipped: 'skip' } as const;

export function toText(checks: Check[]): string {
	const lines: string[] = [];
	for (const check of checks) {
		lines.push(`[${MARK[check.status]}] ${check.id}: ${check.summary}`);
		if (check.status === 'fail' || check.status === 'warn' || (check.status === 'skipped' && check.next.length > 0)) {
			for (const next of check.next) lines.push(`        -> ${next.text}`);
		}
	}
	const { counts, exitCode: code } = toJson(checks);
	lines.push('', `${counts.ok} ok, ${counts.fail} failed, ${counts.warn} warnings, ${counts.skipped} skipped.`);
	lines.push(
		code === 0
			? 'Verdict: ready. Nothing to fix.'
			: code === 1
				? 'Verdict: not ready. Exit 1: there is at least one fix you can make yourself (run the commands marked above), then run `npm run doctor` again.'
				: 'Verdict: not ready. Exit 2: what is left needs a person (steps marked HUMAN:). Ask them, then run `npm run doctor` again.',
	);
	return lines.join('\n');
}

// The A10 load test: simulated phones polling and answering for minutes against a deployed PREVIEW (or a
// local server with --local), driven through the app's real routes. Plain report on screen, JSON in
// load-results/ (git-ignored). Never reads or prints a secret: the host login comes from a private file
// (npm run load-host), the Protection Bypass secret from VERCEL_AUTOMATION_BYPASS_SECRET.
//   node scripts/load-test.ts --target https://<preview>.vercel.app [--phones 200] [--minutes 10]
//   node scripts/load-test.ts --target http://localhost:5173 --local --phones 20 --minutes 1
// Exit codes: 0 passed, 1 ran and failed, 2 refused or could not start.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Refusal, parseTarget, readHostFile, vercelDeploymentFacts, verifyNotProduction } from './lib/load-guard.ts';
import { buildReport, checkStoredCounts, parseResultsCsv, reportText } from './lib/load-report.ts';
import { DEFAULTS, LoadError, runLoad } from './lib/load-sim.ts';
import { realExec } from './lib/vercel.ts';

const HELP = `Usage: node scripts/load-test.ts --target <url> [options]
  --target <url>        required: a Vercel preview address, or localhost with --local
  --local               allow a localhost target (and only that)
  --phones <n>          simulated phones, 1 to 500 (default ${DEFAULTS.phones})
  --minutes <m>         length of the three activities together, 0.05 to 30 (default ${DEFAULTS.minutes})
  --poll-seconds <s>    the phone page's poll interval (default ${DEFAULTS.pollMs / 1000})
  --host-file <path>    the host login, made by npm run load-host (default .load-test-host)
  --budget <n>          state function calls a second allowed, plus answers (default 15, ADR-004)
  --replay-rate <p>     chance a reply is treated as lost and resent (default ${DEFAULTS.replayRate})
  --seed <n>            repeat a run
  --out <dir>           where the JSON goes (default load-results)
  --check-only          run the guards and the host-file check, send nothing, exit
Secrets: VERCEL_AUTOMATION_BYPASS_SECRET is read from the environment when the preview is protected.
Exit codes: 0 passed, 1 ran and failed, 2 refused or could not start.`;

function number(name: string, raw: string | undefined, fallback: number, low: number, high: number): number {
	const value = raw === undefined ? fallback : Number(raw);
	if (!Number.isFinite(value) || value < low || value > high) throw new Refusal(`--${name} must be a number from ${low} to ${high}.`);
	return value;
}

async function main(): Promise<number> {
	const { values } = parseArgs({
		options: {
			target: { type: 'string' }, local: { type: 'boolean', default: false }, phones: { type: 'string' }, minutes: { type: 'string' },
			'poll-seconds': { type: 'string' }, 'host-file': { type: 'string' }, budget: { type: 'string' }, 'replay-rate': { type: 'string' },
			seed: { type: 'string' }, out: { type: 'string' }, 'check-only': { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
		},
		strict: true,
	});
	if (values.help) {
		console.log(HELP);
		return 0;
	}

	const target = parseTarget(values.target, { local: values.local });
	const phones = number('phones', values.phones, DEFAULTS.phones, 1, 500);
	const minutes = number('minutes', values.minutes, DEFAULTS.minutes, 0.05, 30);
	const pollSeconds = number('poll-seconds', values['poll-seconds'], DEFAULTS.pollMs / 1000, 0.5, 30);
	const budget = number('budget', values.budget, 15, 1, 1000);
	const replayRate = number('replay-rate', values['replay-rate'], DEFAULTS.replayRate, 0, 0.5);
	const seed = number('seed', values.seed, Math.floor(Math.random() * 2 ** 31), 0, 2 ** 32);

	if (!target.local) await verifyNotProduction(target.url.hostname, (host) => vercelDeploymentFacts(host, realExec(process.cwd())));
	const login = readHostFile(values['host-file'] ?? '.load-test-host');
	const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET || undefined;

	if (values['check-only']) {
		console.log(`Guards passed for ${target.url.host}${target.local ? ' (local)' : ' (not production, per Vercel)'}; host file readable; bypass secret ${bypassSecret ? 'set' : 'not set'}. Nothing was sent.`);
		return 0;
	}

	const result = await runLoad({
		base: target.url, login, bypassSecret, phones, minutes, pollMs: pollSeconds * 1000, projectorPollMs: DEFAULTS.projectorPollMs, hostPollMs: DEFAULTS.hostPollMs,
		projectors: DEFAULTS.projectors, replayRate, retryDelaysMs: DEFAULTS.retryDelaysMs, userRepressMs: DEFAULTS.userRepressMs, joinSpreadMs: DEFAULTS.joinSpreadMs, seed, log: console.log,
	});
	const report = buildReport({
		host: target.url.host, code: result.code, phones, minutes, pollMs: pollSeconds * 1000, seed, budget, samples: result.samples, submits: result.submits, acked: result.acked,
		window: result.window, startedAtMs: result.startedAtMs, endedAtMs: result.endedAtMs, stored: result.csv === null ? null : checkStoredCounts(parseResultsCsv(result.csv), result.acked),
		eventLoop: result.eventLoop, notes: result.notes,
	});
	console.log(`\n${reportText(report)}`);

	const dir = values.out ?? 'load-results';
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${new Date(result.startedAtMs).toISOString().replace(/[:.]/g, '-')}-${target.url.hostname}.json`);
	writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 });
	console.log(`JSON written to ${file}`);
	return report.verdict.pass ? 0 : 1;
}

main().then(
	(code) => process.exit(code),
	(error: unknown) => {
		const known = error instanceof Refusal || error instanceof LoadError;
		console.error(`${known ? 'Refused' : 'Could not run'}: ${(error as Error).message}`);
		process.exit(2);
	},
);

// Gets a copy of Volley ready. Safe to run again. Built for an AI agent first: see --help.
import { createClient } from '@supabase/supabase-js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact, secretValues } from './lib/env.ts';
import { toJson, toText, EXIT_HELP } from './lib/report.ts';
import { connectOwnerWith, readVercelLink, realContext } from './lib/context.ts';
import { realExec } from './lib/vercel.ts';
import { realDeps, runSetup, summaryText, type Options } from './lib/setup.ts';

const HELP = `npm run setup [-- <flags>]

Gets this copy ready, in order: copies NEXT_PUBLIC_… names to the PUBLIC_… names SvelteKit reads,
generates the secrets (HOST_SESSION_SECRET, PARTICIPANT_SECRET, CRON_SECRET), applies the database
migrations (which also turns on pg_cron and schedules the hourly purge), and, if asked, makes the
first admin host. It ends by running \`npm run doctor\` and printing its verdict.

It never asks a question: everything comes from the environment (.env.local) and these flags.
It never overwrites a value it did not make unless you pass --force, never prints a secret value
(only "set (N chars)"), and refuses to touch this repo's production database.

Flags:
  --dry-run                 show what would happen; change nothing
  --force                   allow overwriting: regenerates the secrets (signs every host out) and lets
                            --first-admin-email reset an existing account's password or make an existing
                            host an admin
  --yes                     accepted and ignored: setup never prompts
  --from-env-file <path>    fill missing settings from another env file (e.g. one \`vercel env pull\` made)
  --env-out <path>          the file setup writes to (default .env.local)
  --first-admin-email <e>   make this person the first admin host; the first password goes to
                            .volley-first-admin.txt (0600), never to the screen
  --first-admin-name <n>    their display name, 1 to 40 characters
  --skip-migrate            don't touch the database schema
  --push-vercel-env         add the settings to the Vercel project linked in .vercel/ (never overwrites
                            without --force). WARNING: these are THIS machine's Supabase values and they go
                            to Production (and Preview) as they are: if .env.local points at a test
                            Supabase project, production would use the test database. Check with
                            \`npm run doctor\` first.
  --vercel-env <list>       which targets for --push-vercel-env (default production,preview)
  --vercel-protection       set Vercel Authentication to preview deployments only (so the cron gets through)
  --disable-signup          switch Supabase public sign-up off via the Management API (needs
                            SUPABASE_ACCESS_TOKEN; otherwise doctor tells a person where to click)
  --json                    print the summary and doctor's results as JSON
  --help                    this text

${EXIT_HELP}
Setup's exit code is doctor's, or 1 / 2 if one of setup's own steps failed in the same way.`;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
	console.log(HELP);
	process.exit(0);
}

const FLAGS_WITH_VALUE = ['--from-env-file', '--env-out', '--first-admin-email', '--first-admin-name', '--vercel-env'];
const FLAGS = ['--dry-run', '--force', '--yes', '--skip-migrate', '--push-vercel-env', '--vercel-protection', '--disable-signup', '--json', ...FLAGS_WITH_VALUE];
const value = (flag: string): string | undefined => {
	const at = args.indexOf(flag);
	if (at < 0) return undefined;
	const given = args[at + 1];
	if (given === undefined || given.startsWith('--')) {
		console.error(`${flag} needs a value, for example ${flag} <value>. Run \`npm run setup -- --help\`.`);
		process.exit(1);
	}
	return given;
};
const unknown = args.filter((arg, at) => arg.startsWith('--') && !FLAGS.includes(arg) && !FLAGS_WITH_VALUE.includes(args[at - 1] ?? ''));
if (unknown.length > 0) {
	console.error(`Unknown option ${unknown[0]}. Run \`npm run setup -- --help\`.`);
	process.exit(1);
}

const options: Options = {
	dryRun: args.includes('--dry-run'),
	force: args.includes('--force'),
	envFile: value('--env-out') ?? '.env.local',
	fromEnvFile: value('--from-env-file'),
	firstAdminEmail: value('--first-admin-email'),
	firstAdminName: value('--first-admin-name'),
	skipMigrate: args.includes('--skip-migrate'),
	pushVercelEnv: args.includes('--push-vercel-env'),
	vercelTargets: (value('--vercel-env') ?? 'production,preview').split(',').map((target) => target.trim()).filter(Boolean),
	vercelProtection: args.includes('--vercel-protection'),
	disableSignup: args.includes('--disable-signup'),
};
if (options.firstAdminName !== undefined && (options.firstAdminName.length < 1 || options.firstAdminName.length > 40)) {
	console.error('--first-admin-name must be 1 to 40 characters.');
	process.exit(1);
}
if (options.vercelTargets.some((target) => !['production', 'preview'].includes(target))) {
	console.error('--vercel-env takes production, preview, or both separated by a comma.');
	process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const deps = realDeps(root, process.env, {
	connectOwner: connectOwnerWith,
	authAdmin: (env) =>
		createClient(env.SUPABASE_URL ?? '', env.SUPABASE_SECRET_KEY ?? '', { auth: { persistSession: false, autoRefreshToken: false } }).auth.admin,
	exec: realExec(root),
	vercelLink: () => readVercelLink(root),
	doctor: async (env) => realContext(root, env, options.pushVercelEnv || options.vercelProtection),
});

try {
	const result = await runSetup(options, deps);
	if (args.includes('--json')) console.log(JSON.stringify({ dryRun: options.dryRun, steps: result.steps, doctor: toJson(result.checks), exitCode: result.exitCode }, null, 2));
	else console.log(`${summaryText(result.steps, options)}\n\nDoctor, run just now${options.dryRun ? ' (on the current state: a dry run changes nothing)' : ''}:\n${toText(result.checks)}`);
	process.exitCode = result.exitCode;
} catch (error) {
	console.error(`Setup stopped: ${redact((error as Error).message, secretValues(process.env))}`);
	process.exitCode = 1;
}

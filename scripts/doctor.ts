// Read-only checks that a copy of Volley is set up right. Built for an AI agent first:
//   npm run doctor              plain-English report
//   npm run doctor -- --json    the same, as JSON
//   npm run doctor -- --vercel  also check the Vercel project linked in .vercel/ (read-only)
// Reads the environment (npm loads .env.local; to check another file run
// `node --env-file=<file> scripts/doctor.ts`). Never prints a secret value.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitCode, runChecks } from './lib/checks.ts';
import { realContext } from './lib/context.ts';
import { EXIT_HELP, toJson, toText } from './lib/report.ts';

const HELP = `npm run doctor [-- --json] [-- --vercel]

Checks the environment, the database (pooler, region, migrations, pg_cron), Supabase Auth
(public sign-up must be off) and the first host. Read-only. Every check has a stable id, a
status (ok / fail / warn / skipped), one plain sentence, and exact next actions: a command or file
edit you can do yourself, or a step marked HUMAN: that only a person can do.

Flags:
  --json     print machine-readable JSON instead of text
  --vercel   also check the Vercel project linked in .vercel/ (env names, deployment protection)
  --help     this text

${EXIT_HELP}`;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
	console.log(HELP);
	process.exit(0);
}
const unknown = args.filter((arg) => !['--json', '--vercel'].includes(arg));
if (unknown.length > 0) {
	console.error(`Unknown option ${unknown[0]}. Run \`npm run doctor -- --help\`.`);
	process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { ctx, close } = realContext(root, process.env, args.includes('--vercel'));
try {
	const checks = await runChecks(ctx);
	console.log(args.includes('--json') ? JSON.stringify(toJson(checks), null, 2) : toText(checks));
	process.exitCode = exitCode(checks);
} finally {
	await close();
}

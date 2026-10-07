// Wipes Volley's test Supabase project (ref gzwzfjukswcifikbsufm) back to "brand new", for a setup
// trial. Deliberately NOT an npm script. Refuses any other project, and production by name.
//   node --env-file=.env.local scripts/reset-test-db.ts --yes-wipe-volley-test-db
import { redact, secretValues } from './lib/env.ts';
import { CONFIRM_FLAG, TEST_REF, resetTestDb } from './lib/reset-test-db.ts';

try {
	const left = await resetTestDb(process.env, process.argv.slice(2));
	console.log(`Wiped the test project (${TEST_REF}). Left: ${left.objects} Volley objects in public, ${left.users} auth users, ${left.jobs} Volley cron jobs.`);
	process.exitCode = left.objects + left.users + left.jobs === 0 ? 0 : 1;
} catch (error) {
	console.error(`Not wiped: ${redact((error as Error).message, secretValues(process.env))}`);
	console.error(`(Needs ${CONFIRM_FLAG}, and every address in the environment must be the test project's.)`);
	process.exitCode = 1;
}

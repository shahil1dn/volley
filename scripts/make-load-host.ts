// Makes (or removes) the host the load test signs in as, on the TEST database only. The password goes to a
// private file (0600, git-ignored) and is never printed.
//   npm run load-host              make the host and write .load-test-host
//   npm run load-host -- --remove  delete that host (its sessions and runs go with it) and the file
import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createClient } from '@supabase/supabase-js';
import { refuseProduction } from './production-guard.ts';
import { connectOwnerWith } from './lib/context.ts';
import { readHostFile } from './lib/load-guard.ts';
import { makeHost } from './lib/make-host.ts';
import { TEST_REF } from './lib/reset-test-db.ts';
import { writePrivate } from './lib/private-file.ts';
import { projectRefOf } from './lib/checks.ts';

const { values } = parseArgs({ options: { remove: { type: 'boolean', default: false }, file: { type: 'string', default: '.load-test-host' } }, strict: true });
const file = values.file as string;

refuseProduction(process.env, 'making a load-test host', 'The load test host lives on the test database only.');
const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY must be set (.env.local).');
if (projectRefOf(SUPABASE_URL.toLowerCase()) !== TEST_REF) throw new Error(`SUPABASE_URL is not the test project (${TEST_REF}), so no load-test host was made or removed.`);

const db = await connectOwnerWith(process.env);
try {
	if (values.remove) {
		const { email } = readHostFile(file);
		const { rowCount } = await db.query('delete from auth.users where lower(email) = $1', [email.toLowerCase()]);
		rmSync(file, { force: true });
		console.log(`Removed the load-test host (${rowCount ?? 0} account) and ${file}.`);
	} else {
		if (existsSync(file)) throw new Error(`${file} already exists. Remove the old host first: npm run load-host -- --remove`);
		const email = `load-${randomBytes(6).toString('hex')}@example.com`;
		const password = randomBytes(24).toString('base64url');
		const admin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } }).auth.admin;
		await makeHost(db, admin, email, password);
		writePrivate(file, `email=${email}\npassword=${password}\n`);
		console.log(`Load-test host made on the test database; its login is in ${file} (permissions 0600, git-ignored). Nothing was printed.`);
	}
} finally {
	await db.end();
}

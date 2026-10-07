// Names a host, or makes them an admin who can invite others (ADR-011),
// without touching their password. Run it after add-host for the first host.
//   npm run set-host -- <email> [--name "Your name"] [--admin]
import { connectAsOwner } from './pg-connect.ts';
import { setHost } from './lib/make-host.ts';

const args = process.argv.slice(2);
const email = (args[0] ?? '').trim().toLowerCase();
const nameAt = args.indexOf('--name');
const name = nameAt >= 0 ? (args[nameAt + 1] ?? '').trim() : null;
const makeAdmin = args.includes('--admin');

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || (name !== null && (name.length < 1 || name.length > 40)) || (name === null && !makeAdmin)) {
	console.error('Usage: npm run set-host -- <email> [--name "Your name"] [--admin]   (a name is 1 to 40 characters)');
	process.exit(1);
}

const db = await connectAsOwner();
try {
	if (!(await setHost(db, email, { name, admin: makeAdmin }))) {
		console.error(`${email} isn't a host yet. Add them first with npm run add-host.`);
		process.exitCode = 1;
	} else {
		console.log(`Updated ${email}${name ? `: name "${name}"` : ''}${makeAdmin ? ', admin' : ''}.`);
	}
} finally {
	await db.end();
}

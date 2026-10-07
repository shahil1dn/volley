// Creates a host, or resets an existing host's password, from the terminal:
// how the first host is made (then `npm run set-host -- <email> --admin`), and
// how an admin resets their own password. Everyone else is invited from the
// app's Hosts page (ADR-011). No public sign-up, no email sent.
//   npm run add-host <email>
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { connectAsOwner } from './pg-connect.ts';
import { makeHost } from './lib/make-host.ts';

const email = (process.argv[2] ?? '').trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
	console.error('Usage: npm run add-host <email>');
	process.exit(1);
}
const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY must be set in .env.local');

const admin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
	auth: { persistSession: false, autoRefreshToken: false },
}).auth.admin;
// 32 characters from 24 random bytes: far beyond guessing within the sign-in limits.
const password = randomBytes(24).toString('base64url');

const db = await connectAsOwner();
try {
	const { created } = await makeHost(db, admin, email, password);
	console.log(`Host ready: ${email} (${created ? 'new account' : 'password reset'})`);
	console.log(`Password: ${password}`);
	console.log('Shown once. Pass it to the host; they sign in at the site root (/).');
} finally {
	await db.end();
}

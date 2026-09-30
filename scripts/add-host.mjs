// Creates a host, or resets an existing host's password, from the terminal:
// how the first host is made (then `npm run set-host -- <email> --admin`), and
// how an admin resets their own password. Everyone else is invited from the
// app's Hosts page (ADR-011). No public sign-up, no email sent.
//   npm run add-host <email>
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { connectAsOwner } from './pg-connect.ts';

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
	const existing = await db.query('select id from auth.users where lower(email) = $1', [email]);
	let userId = existing.rows[0]?.id;
	if (userId) {
		const { error } = await admin.updateUserById(userId, { password, email_confirm: true });
		if (error) throw new Error(`Could not reset the password: ${error.message}`);
	} else {
		// Created already confirmed, so Supabase sends no confirmation email.
		const { data, error } = await admin.createUser({ email, password, email_confirm: true });
		if (error) throw new Error(`Could not create the account: ${error.message}`);
		userId = data.user.id;
	}
	await db.query(
		`insert into public.hosts (user_id, email) values ($1, $2)
		 on conflict (user_id) do update set email = excluded.email`,
		[userId, email],
	);
	console.log(`Host ready: ${email} (${existing.rows[0] ? 'password reset' : 'new account'})`);
	console.log(`Password: ${password}`);
	console.log('Shown once. Pass it to the host; they sign in at the site root (/).');
} finally {
	await db.end();
}

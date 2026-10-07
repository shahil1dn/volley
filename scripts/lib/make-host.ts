// How a host account is made, shared by `npm run add-host` and `npm run setup` so there is
// one way to do it (ADR-011). No public sign-up, no email sent.
import type pg from 'pg';

type AuthAdmin = {
	createUser(attrs: { email: string; password: string; email_confirm: boolean }): Promise<{ data: { user: { id: string } | null }; error: { message: string } | null }>;
	updateUserById(id: string, attrs: { password: string; email_confirm: boolean }): Promise<{ error: { message: string } | null }>;
};

// Plain addresses only: no quote, space, `$ ( ) ; | & < >` or backslash, so an email can't carry shell
// syntax into a suggested command or anywhere else it is shown.
export const EMAIL = /^(?=.{3,254}$)[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

// Creates the account (already confirmed) or resets the password of an existing one, then makes it
// a host. A new password ends every older session (ADR-011).
export async function makeHost(db: pg.Client, admin: AuthAdmin, email: string, password: string): Promise<{ userId: string; created: boolean }> {
	const existing = await db.query('select id from auth.users where lower(email) = $1', [email]);
	let userId = existing.rows[0]?.id;
	if (userId) {
		const { error } = await admin.updateUserById(userId, { password, email_confirm: true });
		if (error) throw new Error(`Could not reset the password: ${error.message}`);
	} else {
		const { data, error } = await admin.createUser({ email, password, email_confirm: true });
		if (error || !data.user) throw new Error(`Could not create the account: ${error?.message ?? 'no user returned'}`);
		userId = data.user.id;
	}
	await db.query(
		`insert into public.hosts (user_id, email, sessions_valid_after) values ($1, $2, now())
		 on conflict (user_id) do update set email = excluded.email, sessions_valid_after = now()`,
		[userId, email],
	);
	return { userId, created: !existing.rows[0] };
}

// Names a host and/or makes them an admin, without touching the password. False if they aren't a host.
export async function setHost(db: pg.Client, email: string, options: { name?: string | null; admin?: boolean }): Promise<boolean> {
	const { rowCount } = await db.query('update public.hosts set name = coalesce($2, name), is_admin = is_admin or $3 where email = $1', [email, options.name ?? null, options.admin ?? false]);
	return (rowCount ?? 0) > 0;
}

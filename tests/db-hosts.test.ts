// Inviting and managing hosts (ADR-011). Every test is rolled back.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { connectAsOwner } from '../scripts/pg-connect.ts';
import { inRolledBackTransaction, makeRun, skipWithoutDatabase as skip } from './db-helpers.ts';
import { hostSessionIssuedAt, makeHostSession } from '../src/lib/server/host-session.ts';

let db: pg.Client;
before(async () => {
	if (!skip) db = await connectAsOwner();
});
after(async () => {
	await db?.end();
});

const newToken = () => randomBytes(32).toString('base64url');
const hashOf = (token: string) => createHash('sha256').update(token).digest('base64url');

async function call(sql: string, params: unknown[]) {
	return (await db.query(`select ${sql} as result`, params)).rows[0].result;
}

// A host made admin, as `set-host --admin` does.
async function makeAdmin() {
	const { userId } = await makeRun(db);
	await db.query(`update public.hosts set is_admin = true, name = 'Owner' where user_id = $1`, [userId]);
	return userId;
}

// An Auth account for an email, as the server's admin API call makes.
async function authUser(email: string) {
	const id = randomUUID();
	await db.query('insert into auth.users (id, email) values ($1, $2)', [id, email]);
	return id;
}

const invite = (admin: string, email: string, name: string, purpose: string, token = newToken()) =>
	call('public.create_host_invite($1, $2, $3, $4, $5)', [admin, email, name, purpose, hashOf(token)]).then((result) => ({ ...result, token }));
const peek = (token: string) => call('public.peek_host_invite($1)', [hashOf(token)]);
const claim = (token: string) => call('public.claim_host_invite($1)', [hashOf(token)]);
const finish = (inviteId: string, userId: string, name: string) => call('public.finish_host_invite($1, $2, $3)', [inviteId, userId, name]);
// What the server does: claim the link, (set the password), then finish.
async function accept(token: string, userId: string, name: string) {
	const claimed = await claim(token);
	return claimed.status === 'ok' ? finish(claimed.id, userId, name) : { status: claimed.status };
}

test('an admin invites; the link shows who it is for; accepting makes a named host, once', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const admin = await makeAdmin();
		const made = await invite(admin, '  Sam@Example.org ', 'Sam', 'invite');
		assert.equal(made.status, 'ok');
		const days = (new Date(made.expiresAt).getTime() - Date.now()) / 86_400_000;
		assert.ok(days > 6.99 && days <= 7.01, `expires in ${days} days`);
		assert.deepEqual(await peek(made.token), { status: 'ok', email: 'sam@example.org', name: 'Sam', purpose: 'invite' });

		const sam = await authUser('sam@example.org');
		assert.equal((await accept(made.token, sam, ' Sam K ')).status, 'ok');
		const row = await db.query('select email, name, is_admin from public.hosts where user_id = $1', [sam]);
		assert.deepEqual(row.rows, [{ email: 'sam@example.org', name: 'Sam K', is_admin: false }]);

		assert.deepEqual(await accept(made.token, sam, 'Sam'), { status: 'used' }, 'a link works once');
		assert.deepEqual(await peek(made.token), { status: 'used' }, 'a used link shows nothing else');
	});
});

test('only an admin can invite, list, remove or cancel', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const { userId: plainHost } = await makeRun(db);
		assert.equal((await invite(plainHost, 'x@example.org', 'X', 'invite')).status, 'not_admin');
		assert.equal(await call('public.list_hosts($1)', [plainHost]), null);
		assert.equal((await call('public.remove_host($1, $2)', [plainHost, randomUUID()])).status, 'not_admin');
		assert.equal((await call('public.cancel_host_invite($1, $2)', [plainHost, randomUUID()])).status, 'not_admin');
		assert.equal((await invite(randomUUID(), 'x@example.org', 'X', 'invite')).status, 'not_admin', 'not a host at all');
	});
});

test('an invite refuses an existing host, a bad email, a missing name and a malformed token', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const admin = await makeAdmin();
		const { userId: existing } = await makeRun(db);
		const existingEmail = (await db.query('select email from public.hosts where user_id = $1', [existing])).rows[0].email;
		assert.equal((await invite(admin, existingEmail, 'Dup', 'invite')).status, 'already_host');
		for (const [email, name] of [['not-an-email', 'N'], ['a@b', 'N'], ['ok@example.org', '  '], ['ok@example.org', 'x'.repeat(41)]]) {
			assert.equal((await invite(admin, email, name, 'invite')).status, 'invalid', `${email} / ${name.length}`);
		}
		assert.equal((await invite(admin, 'ok@example.org', 'Ok', 'promote')).status, 'invalid');
		const bad = await call('public.create_host_invite($1, $2, $3, $4, $5)', [admin, 'ok@example.org', 'Ok', 'invite', 'short']);
		assert.equal(bad.status, 'invalid');
	});
});

test('a newer link for the same email replaces the older one', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const admin = await makeAdmin();
		const first = await invite(admin, 'sam@example.org', 'Sam', 'invite');
		const second = await invite(admin, 'sam@example.org', 'Sam', 'invite');
		assert.deepEqual(await peek(first.token), { status: 'invalid' });
		assert.equal((await peek(second.token)).status, 'ok');
	});
});

test('an expired link is refused and shows only that', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const admin = await makeAdmin();
		const made = await invite(admin, 'late@example.org', 'Late', 'invite');
		await db.query(`update public.host_invites set expires_at = now() - interval '1 second' where email = 'late@example.org'`);
		assert.deepEqual(await peek(made.token), { status: 'expired' });
		assert.deepEqual(await accept(made.token, await authUser('late@example.org'), 'Late'), { status: 'expired' });
		assert.equal((await db.query(`select count(*) from public.hosts where email = 'late@example.org'`)).rows[0].count, '0');
	});
});

test("a link can't make a different account a host", { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const admin = await makeAdmin();
		const made = await invite(admin, 'sam@example.org', 'Sam', 'invite');
		const intruder = await authUser('intruder@example.org');
		assert.deepEqual(await accept(made.token, intruder, 'Sam'), { status: 'wrong_account' });
		assert.equal((await db.query('select count(*)::int as n from public.hosts where user_id = $1', [intruder])).rows[0].n, 0);
		assert.deepEqual(await accept(newToken(), intruder, 'X'), { status: 'invalid' });
	});
});

test("a reset link works for another host, keeps them a host, and can't target the admin", { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const admin = await makeAdmin();
		const { userId: host } = await makeRun(db);
		const email = (await db.query(`update public.hosts set name = 'Jo' where user_id = $1 returning email`, [host])).rows[0].email;
		await db.query('update auth.users set email = $2 where id = $1', [host, email]);

		const reset = await invite(admin, email, 'ignored', 'reset');
		assert.equal(reset.status, 'ok');
		assert.deepEqual(await peek(reset.token), { status: 'ok', email, name: 'Jo', purpose: 'reset' });
		assert.equal((await accept(reset.token, host, 'Jo')).status, 'ok');

		const adminEmail = (await db.query('select email from public.hosts where user_id = $1', [admin])).rows[0].email;
		assert.equal((await invite(admin, adminEmail, '', 'reset')).status, 'self');
		assert.equal((await invite(admin, 'nobody@example.org', '', 'reset')).status, 'not_found');
	});
});

test('the list shows hosts and live links only; remove and cancel work, but not on yourself', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const admin = await makeAdmin();
		const { userId: host, deckId } = await makeRun(db);
		const live = await invite(admin, 'live@example.org', 'Live', 'invite');
		const stale = await invite(admin, 'stale@example.org', 'Stale', 'invite');
		await db.query(`update public.host_invites set expires_at = now() - interval '1 second' where email = 'stale@example.org'`);

		const listed = await call('public.list_hosts($1)', [admin]);
		const mine = listed.hosts.filter((h: { userId: string }) => h.userId === admin || h.userId === host);
		assert.deepEqual(mine.map((h: { isAdmin: boolean; isYou: boolean }) => [h.isAdmin, h.isYou]), [[true, true], [false, false]]);
		assert.deepEqual(listed.invites.map((i: { email: string }) => i.email).filter((e: string) => e.endsWith('@example.org') && e !== 'stale@example.org'), ['live@example.org']);
		assert.ok(!listed.invites.some((i: { email: string }) => i.email === 'stale@example.org'));
		assert.equal(stale.status, 'ok');

		assert.equal((await call('public.remove_host($1, $2)', [admin, admin])).status, 'self');
		assert.equal((await call('public.remove_host($1, $2)', [admin, host])).status, 'ok');
		assert.equal((await db.query('select count(*) from public.decks where id = $1', [deckId])).rows[0].count, '0', 'their decks go too');
		assert.equal((await call('public.remove_host($1, $2)', [admin, host])).status, 'not_found');

		const inviteId = listed.invites.find((i: { email: string }) => i.email === 'live@example.org').id;
		assert.equal((await call('public.cancel_host_invite($1, $2)', [admin, inviteId])).status, 'ok');
		assert.deepEqual(await peek(live.token), { status: 'invalid' });
	});
});

test('host_profile gives the guard email, name and admin flag; the state carries the host name', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const admin = await makeAdmin();
		const profile = await call('public.host_profile($1)', [admin]);
		assert.equal(profile.name, 'Owner');
		assert.equal(profile.isAdmin, true);
		assert.equal(await call('public.host_profile($1)', [randomUUID()]), null);

		const { userId, code } = await makeRun(db);
		await db.query(`update public.hosts set name = 'Shahil' where user_id = $1`, [userId]);
		assert.equal((await call('public.get_state($1)', [code])).hostName, 'Shahil');
	});
});

test('a link is claimed before any password is set: a second claim is refused, and a released claim can be tried again', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const admin = await makeAdmin();
		const made = await invite(admin, 'sam@example.org', 'Sam', 'invite');
		const first = await claim(made.token);
		assert.equal(first.status, 'ok');
		assert.deepEqual(await claim(made.token), { status: 'used' }, 'the second submit stops before any password');
		assert.deepEqual(await peek(made.token), { status: 'used' });

		await call('public.release_host_invite($1)', [first.id]);
		const again = await claim(made.token);
		assert.equal(again.status, 'ok', 'released after a failed password step');
		const sam = await authUser('sam@example.org');
		assert.equal((await finish(again.id, sam, 'Sam')).status, 'ok');
		assert.deepEqual(await finish(again.id, sam, 'Sam'), { status: 'invalid' }, 'finished once');
		await call('public.release_host_invite($1)', [again.id]);
		assert.deepEqual(await peek(made.token), { status: 'used' }, 'a finished link is never reopened');
	});
});

test('finishing needs a claim first', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const admin = await makeAdmin();
		await invite(admin, 'sam@example.org', 'Sam', 'invite');
		const { id } = (await db.query(`select id from public.host_invites where email = 'sam@example.org'`)).rows[0];
		assert.deepEqual(await finish(id, await authUser('sam@example.org'), 'Sam'), { status: 'invalid' });
	});
});

test('a reset and an accepted invite end older sessions', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const admin = await makeAdmin();
		const { userId: host } = await makeRun(db);
		const email = (await db.query('select email from public.hosts where user_id = $1', [host])).rows[0].email;
		await db.query('update auth.users set email = $2 where id = $1', [host, email]);
		const before = (await call('public.host_profile($1)', [host])).sessionsValidAfter;
		assert.equal(Number(before), 1, "existing hosts keep their sessions (the 1970 default, plus the one second)");

		const reset = await invite(admin, email, '', 'reset');
		assert.equal((await accept(reset.token, host, 'Jo')).status, 'ok');
		const now = Math.floor(Date.now() / 1000);
		const after = Number((await call('public.host_profile($1)', [host])).sessionsValidAfter);
		assert.ok(Math.abs(after - now) < 120, `reset bumps it to now (${after} vs ${now})`);

		const made = await invite(admin, 'new@example.org', 'New', 'invite');
		const fresh = await authUser('new@example.org');
		await accept(made.token, fresh, 'New');
		assert.ok(Number((await call('public.host_profile($1)', [fresh])).sessionsValidAfter) >= now - 120);
	});
});

// The guard (host-guard.ts) refuses a session when hostSessionIssuedAt < sessionsValidAfter.
// Sessions have whole-second stamps, so one made in the reset's own second must
// still be refused: the reported value is the first second AFTER the reset.
test("a reset ends a session issued in the same second; the next second's is valid", { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const admin = await makeAdmin();
		const { userId: host } = await makeRun(db);
		const email = (await db.query('select email from public.hosts where user_id = $1', [host])).rows[0].email;
		await db.query('update auth.users set email = $2 where id = $1', [host, email]);
		const reset = await invite(admin, email, '', 'reset');
		const claimed = await claim(reset.token);
		const finished = await finish(claimed.id, host, 'Jo');
		const stamp = Number((await db.query('select floor(extract(epoch from sessions_valid_after))::bigint as s from public.hosts where user_id = $1', [host])).rows[0].s);

		const reported = Number((await call('public.host_profile($1)', [host])).sessionsValidAfter);
		assert.equal(reported, stamp + 1, 'host_profile reports the first whole second after the reset');
		assert.equal(Number(finished.sessionsValidAfter), stamp + 1, 'finish_host_invite agrees, so the session it starts is valid');

		const refused = (issuedAt: number) => hostSessionIssuedAt(makeHostSession('s', host, issuedAt)) < reported;
		assert.equal(refused(stamp), true, 'issued in the reset second: refused');
		assert.equal(refused(stamp + 1), false, 'issued one second later: accepted');
	});
});

test("admins can't reset or remove other admins", { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const admin = await makeAdmin();
		const other = await makeAdmin();
		const otherEmail = (await db.query('select email from public.hosts where user_id = $1', [other])).rows[0].email;
		assert.equal((await invite(admin, otherEmail, '', 'reset')).status, 'admin');
		assert.equal((await call('public.remove_host($1, $2)', [admin, other])).status, 'admin');
	});
});

test("removing a host kills their unused links; a reset link for someone no longer a host is dead", { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const admin = await makeAdmin();
		const { userId: host } = await makeRun(db);
		const email = (await db.query('select email from public.hosts where user_id = $1', [host])).rows[0].email;
		const reset = await invite(admin, email, '', 'reset');
		assert.equal((await peek(reset.token)).status, 'ok');
		assert.equal((await call('public.remove_host($1, $2)', [admin, host])).status, 'ok');
		const left = await db.query('select count(*)::int as n from public.host_invites where email = $1 and used_at is null', [email]);
		assert.equal(left.rows[0].n, 0, 'their unused links are deleted, not just refused');
		assert.deepEqual(await peek(reset.token), { status: 'invalid' });
		assert.deepEqual(await claim(reset.token), { status: 'invalid' });
	});
});

// The host can vanish without remove_host: deleting their Auth account (in
// Supabase's dashboard, say) cascades to `hosts` and leaves the link row.
test('a reset link is dead once its host is gone some other way', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const admin = await makeAdmin();
		const { userId: host } = await makeRun(db);
		const email = (await db.query('select email from public.hosts where user_id = $1', [host])).rows[0].email;
		const reset = await invite(admin, email, '', 'reset');
		await db.query('delete from auth.users where id = $1', [host]);
		assert.deepEqual(await peek(reset.token), { status: 'invalid' });
		assert.deepEqual(await claim(reset.token), { status: 'invalid' });
	});
});

test('a second reset link replaces the first; a reset link carries the host’s own name', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const admin = await makeAdmin();
		const { userId: host } = await makeRun(db);
		const email = (await db.query(`update public.hosts set name = 'Jo' where user_id = $1 returning email`, [host])).rows[0].email;
		const first = await invite(admin, email, 'what the page sent', 'reset');
		assert.equal(first.name, 'Jo');
		const second = await invite(admin, email, '', 'reset');
		assert.deepEqual(await peek(first.token), { status: 'invalid' });
		assert.equal((await peek(second.token)).status, 'ok');
	});
});

test("a non-admin can't make a reset link; cancelling a used link finds nothing", { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const admin = await makeAdmin();
		const { userId: plain } = await makeRun(db);
		const email = (await db.query('select email from public.hosts where user_id = $1', [admin])).rows[0].email;
		assert.equal((await invite(plain, email, '', 'reset')).status, 'not_admin');

		const made = await invite(admin, 'sam@example.org', 'Sam', 'invite');
		const claimed = await claim(made.token);
		assert.equal((await call('public.cancel_host_invite($1, $2)', [admin, claimed.id])).status, 'not_found');
	});
});

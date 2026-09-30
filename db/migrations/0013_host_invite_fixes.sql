-- Fixes from the review of 0012 (ADR-011), before any of it reached
-- production.
-- 1. A link is claimed (locked and marked used) BEFORE any password is set,
--    so a link cancelled or used by someone else meanwhile can't change a
--    password. Accepting is now claim → set the password → finish; a claim
--    whose password step fails is released.
-- 2. A password reset, and accepting an invite, end every older session.
-- 3. Admins can't reset or remove other admins; the owner manages admins from
--    the terminal.
-- 4. Removing a host deletes their unused links, and a reset link for someone
--    who is no longer a host is dead.

-- Sessions issued before this moment are refused by the guard. Existing hosts
-- keep their sessions (1970).
alter table public.hosts add column sessions_valid_after timestamptz not null default '1970-01-01T00:00:00Z';

-- Who finished accepting a claimed link; null while claimed but unfinished.
alter table public.host_invites add column accepted_by uuid;

drop function public.accept_host_invite(text, uuid, text);

create or replace function public.host_profile(p_user_id uuid) returns jsonb
language sql stable
security definer
set search_path = ''
return (
	select jsonb_build_object(
		'email', email,
		'name', name,
		'isAdmin', is_admin,
		-- Whole seconds, as the session cookie counts time.
		'sessionsValidAfter', floor(extract(epoch from sessions_valid_after))::bigint
	)
	from public.hosts where user_id = p_user_id
);

-- 0012's, plus: a reset can't target an admin, and the result carries the
-- name the link will greet them with.
create or replace function public.create_host_invite(
	p_admin uuid,
	p_email text,
	p_name text,
	p_purpose text,
	p_token_hash text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_email text := lower(btrim(coalesce(p_email, '')));
	v_name text := btrim(coalesce(p_name, ''));
	v_host public.hosts;
	v_expires timestamptz := now() + interval '7 days';
begin
	if not public.is_admin(p_admin) then
		return jsonb_build_object('status', 'not_admin');
	end if;
	if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' or char_length(v_email) > 254 or coalesce(p_token_hash, '') !~ '^[A-Za-z0-9_-]{43}$' then
		return jsonb_build_object('status', 'invalid');
	end if;

	select * into v_host from public.hosts where email = v_email;
	case p_purpose
		when 'invite' then
			if found then
				return jsonb_build_object('status', 'already_host');
			end if;
			if char_length(v_name) not between 1 and 40 then
				return jsonb_build_object('status', 'invalid');
			end if;
		when 'reset' then
			if not found then
				return jsonb_build_object('status', 'not_found');
			end if;
			if v_host.user_id = p_admin then
				return jsonb_build_object('status', 'self');
			end if;
			if v_host.is_admin then
				return jsonb_build_object('status', 'admin');
			end if;
			v_name := coalesce(v_host.name, split_part(v_email, '@', 1));
		else
			return jsonb_build_object('status', 'invalid');
	end case;

	delete from public.host_invites where email = v_email and used_at is null;
	insert into public.host_invites (token_hash, email, name, purpose, created_by, expires_at)
	values (p_token_hash, v_email, left(v_name, 40), p_purpose, p_admin, v_expires);
	return jsonb_build_object('status', 'ok', 'expiresAt', v_expires, 'name', left(v_name, 40));
end;
$$;

-- 0012's, plus: a reset link for someone no longer a host is invalid.
create or replace function public.peek_host_invite(p_token_hash text) returns jsonb
language sql stable
security definer
set search_path = ''
return coalesce((
	select case
		when i.used_at is not null then jsonb_build_object('status', 'used')
		when i.expires_at <= now() then jsonb_build_object('status', 'expired')
		when i.purpose = 'reset' and not exists (select 1 from public.hosts h where h.email = i.email) then jsonb_build_object('status', 'invalid')
		else jsonb_build_object('status', 'ok', 'email', i.email, 'name', i.name, 'purpose', i.purpose)
	end
	from public.host_invites i where i.token_hash = p_token_hash
), jsonb_build_object('status', 'invalid'));

-- Step 1 of accepting: lock the link, check it, and mark it used, before the
-- server touches any password.
create or replace function public.claim_host_invite(p_token_hash text) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_invite public.host_invites;
begin
	-- Locked, so the same link submitted twice at once is claimed once.
	select * into v_invite from public.host_invites where token_hash = p_token_hash for update;
	if not found then
		return jsonb_build_object('status', 'invalid');
	end if;
	if v_invite.used_at is not null then
		return jsonb_build_object('status', 'used');
	end if;
	if v_invite.expires_at <= now() then
		return jsonb_build_object('status', 'expired');
	end if;
	if v_invite.purpose = 'reset' and not exists (select 1 from public.hosts where email = v_invite.email) then
		return jsonb_build_object('status', 'invalid');
	end if;
	update public.host_invites set used_at = now() where id = v_invite.id;
	return jsonb_build_object('status', 'ok', 'id', v_invite.id, 'email', v_invite.email, 'purpose', v_invite.purpose);
end;
$$;

-- Step 3: the password is set on the Auth account for the invite's email; make
-- (or keep) that account a host and end its older sessions. Only for a
-- claimed, unfinished link, and only for the invited account.
create or replace function public.finish_host_invite(p_invite_id uuid, p_user_id uuid, p_name text) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_invite public.host_invites;
	v_name text := btrim(coalesce(p_name, ''));
begin
	select * into v_invite from public.host_invites where id = p_invite_id for update;
	if not found or v_invite.used_at is null or v_invite.accepted_by is not null then
		return jsonb_build_object('status', 'invalid');
	end if;
	if char_length(v_name) not between 1 and 40 then
		return jsonb_build_object('status', 'invalid');
	end if;
	if not exists (select 1 from auth.users where id = p_user_id and lower(email) = v_invite.email and not is_sso_user) then
		return jsonb_build_object('status', 'wrong_account');
	end if;

	if v_invite.purpose = 'invite' then
		insert into public.hosts (user_id, email, name, sessions_valid_after) values (p_user_id, v_invite.email, v_name, now())
		on conflict (user_id) do update set email = excluded.email, name = excluded.name, sessions_valid_after = now();
	else
		update public.hosts set name = v_name, sessions_valid_after = now()
		where user_id = p_user_id and email = v_invite.email;
		if not found then
			return jsonb_build_object('status', 'invalid');
		end if;
	end if;
	update public.host_invites set accepted_by = p_user_id where id = v_invite.id;
	-- The new session must not predate this, whatever the server's clock says.
	return jsonb_build_object('status', 'ok', 'sessionsValidAfter', floor(extract(epoch from now()))::bigint);
end;
$$;

-- Undoes a claim whose password step failed, so the link can be tried again.
-- Never reopens a finished link.
create or replace function public.release_host_invite(p_invite_id uuid) returns jsonb
language sql
security definer
set search_path = ''
begin atomic
	update public.host_invites set used_at = null where id = p_invite_id and accepted_by is null;
	select jsonb_build_object('status', 'ok');
end;

-- 0012's, plus: an admin can't be removed here, and the removed host's unused
-- links go with them.
create or replace function public.remove_host(p_admin uuid, p_user_id uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_host public.hosts;
begin
	if not public.is_admin(p_admin) then
		return jsonb_build_object('status', 'not_admin');
	end if;
	if p_user_id = p_admin then
		return jsonb_build_object('status', 'self');
	end if;
	select * into v_host from public.hosts where user_id = p_user_id;
	if not found then
		return jsonb_build_object('status', 'not_found');
	end if;
	if v_host.is_admin then
		return jsonb_build_object('status', 'admin');
	end if;
	delete from public.host_invites where email = v_host.email and used_at is null;
	delete from public.hosts where user_id = p_user_id;
	return jsonb_build_object('status', 'ok');
end;
$$;

revoke execute on function public.claim_host_invite(text) from public, anon, authenticated;
revoke execute on function public.finish_host_invite(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.release_host_invite(uuid) from public, anon, authenticated;
grant execute on function public.claim_host_invite(text) to service_role;
grant execute on function public.finish_host_invite(uuid, uuid, text) to service_role;
grant execute on function public.release_host_invite(uuid) to service_role;

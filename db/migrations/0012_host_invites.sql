-- Inviting hosts from the app (ADR-011): an admin creates a one-time link, the
-- invitee opens it and chooses their own password. The same link resets a
-- host's password. Every function checks the admin itself, so a mistake in a
-- route can't widen who may invite.

-- The name the projector shows ("Shahil hosting"), and who may manage hosts.
alter table public.hosts add column name text check (char_length(name) between 1 and 40);
alter table public.hosts add column is_admin boolean not null default false;

-- Only a hash of each link's token is stored: a copy of this table can't be
-- used to accept an invite.
create table public.host_invites (
	id uuid primary key default gen_random_uuid(),
	token_hash text not null unique,
	email text not null check (email = lower(email) and char_length(email) between 3 and 254),
	name text not null check (char_length(name) between 1 and 40),
	purpose text not null check (purpose in ('invite', 'reset')),
	created_by uuid not null references public.hosts (user_id) on delete cascade,
	created_at timestamptz not null default now(),
	expires_at timestamptz not null,
	used_at timestamptz
);
create index host_invites_email_idx on public.host_invites (email);

alter table public.host_invites enable row level security;
alter table public.host_invites force row level security;
revoke all on public.host_invites from anon, authenticated;

-- What the host guard needs, in one lookup. Null if the account isn't a host.
create or replace function public.host_profile(p_user_id uuid) returns jsonb
language sql stable
security definer
set search_path = ''
return (
	select jsonb_build_object('email', email, 'name', name, 'isAdmin', is_admin)
	from public.hosts where user_id = p_user_id
);

create or replace function public.is_admin(p_user_id uuid) returns boolean
language sql stable
set search_path = ''
return coalesce((select is_admin from public.hosts where user_id = p_user_id), false);

-- A new link, valid for 7 days. An invite is for someone not yet a host; a
-- reset is for an existing host other than the admin (the owner resets their
-- own password from the terminal, with add-host). A newer link for the same
-- email replaces any older unused one, so only one link is ever live.
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
			v_name := coalesce(v_host.name, split_part(v_email, '@', 1));
		else
			return jsonb_build_object('status', 'invalid');
	end case;

	delete from public.host_invites where email = v_email and used_at is null;
	insert into public.host_invites (token_hash, email, name, purpose, created_by, expires_at)
	values (p_token_hash, v_email, left(v_name, 40), p_purpose, p_admin, v_expires);
	return jsonb_build_object('status', 'ok', 'expiresAt', v_expires);
end;
$$;

-- What the link's page shows before the invitee sets a password. A used or
-- expired link shows only that.
create or replace function public.peek_host_invite(p_token_hash text) returns jsonb
language sql stable
security definer
set search_path = ''
return coalesce((
	select case
		when used_at is not null then jsonb_build_object('status', 'used')
		when expires_at <= now() then jsonb_build_object('status', 'expired')
		else jsonb_build_object('status', 'ok', 'email', email, 'name', name, 'purpose', purpose)
	end
	from public.host_invites where token_hash = p_token_hash
), jsonb_build_object('status', 'invalid'));

-- Uses the link, once. The server has already set the password on the Auth
-- account for the invite's email; this makes (or keeps) that account a host.
-- The account must be the one with the invite's email, so a link can't be
-- spent on anyone else.
create or replace function public.accept_host_invite(p_token_hash text, p_user_id uuid, p_name text) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_invite public.host_invites;
	v_name text := btrim(coalesce(p_name, ''));
begin
	-- Locked, so the same link opened twice at once is used once.
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
	if char_length(v_name) not between 1 and 40 then
		return jsonb_build_object('status', 'invalid');
	end if;
	if not exists (select 1 from auth.users where id = p_user_id and lower(email) = v_invite.email) then
		return jsonb_build_object('status', 'wrong_account');
	end if;

	if v_invite.purpose = 'invite' then
		insert into public.hosts (user_id, email, name) values (p_user_id, v_invite.email, v_name)
		on conflict (user_id) do update set email = excluded.email, name = excluded.name;
	else
		update public.hosts set name = v_name where user_id = p_user_id;
		if not found then
			return jsonb_build_object('status', 'invalid');
		end if;
	end if;
	update public.host_invites set used_at = now() where id = v_invite.id;
	return jsonb_build_object('status', 'ok');
end;
$$;

-- The admin page: every host, and the links not yet used or expired.
create or replace function public.list_hosts(p_admin uuid) returns jsonb
language sql stable
security definer
set search_path = ''
return case when public.is_admin(p_admin) then jsonb_build_object(
	'hosts', coalesce((
		select jsonb_agg(jsonb_build_object('userId', user_id, 'email', email, 'name', name, 'isAdmin', is_admin, 'isYou', user_id = p_admin)
			order by is_admin desc, lower(coalesce(name, email)))
		from public.hosts
	), '[]'::jsonb),
	'invites', coalesce((
		select jsonb_agg(jsonb_build_object('id', id, 'email', email, 'name', name, 'purpose', purpose, 'expiresAt', expires_at)
			order by created_at desc)
		from public.host_invites where used_at is null and expires_at > now()
	), '[]'::jsonb)
) end;

-- Takes away hosting at once: the guard checks `hosts` on every request. The
-- server then deletes the Auth account too. The host's decks, and any run of
-- them, go with the row (ON DELETE CASCADE).
create or replace function public.remove_host(p_admin uuid, p_user_id uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
	if not public.is_admin(p_admin) then
		return jsonb_build_object('status', 'not_admin');
	end if;
	if p_user_id = p_admin then
		return jsonb_build_object('status', 'self');
	end if;
	delete from public.hosts where user_id = p_user_id;
	if not found then
		return jsonb_build_object('status', 'not_found');
	end if;
	return jsonb_build_object('status', 'ok');
end;
$$;

create or replace function public.cancel_host_invite(p_admin uuid, p_invite_id uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
	if not public.is_admin(p_admin) then
		return jsonb_build_object('status', 'not_admin');
	end if;
	delete from public.host_invites where id = p_invite_id and used_at is null;
	return jsonb_build_object('status', case when found then 'ok' else 'not_found' end);
end;
$$;

-- 0010's state plus `hostName`, for the projector's "… hosting" line.
create or replace function public.get_state(p_code text) returns jsonb
language sql stable
security definer
set search_path = ''
return (
	select jsonb_build_object(
		'code', r.code,
		'status', r.status,
		'version', r.version,
		'currentPosition', r.current_position,
		'itemState', r.item_state,
		'opensAt', r.opens_at,
		'closesAt', r.closes_at,
		'serverNow', (extract(epoch from now()) * 1000)::bigint,
		'hostName', (select h.name from public.decks d join public.hosts h on h.user_id = d.host_id where d.id = r.deck_id),
		'item', case when i.id is null then null else jsonb_build_object(
			'type', i.type,
			-- Keys that are secret until the host reveals the item. The quiz adds
			-- to this list in Milestone 2 if it needs more than `correct`.
			'settings', case when r.item_state = 'revealed' then i.settings
				else public.without_keys(i.settings, array['correct']) end
		) end,
		'tallies', coalesce((
			select jsonb_agg(jsonb_build_array(t.key, t.count) order by t.count desc, t.key)
			from (
				select key, count from public.tallies
				where run_id = r.id and item_id = i.id and not hidden
				order by count desc, key
				limit 100
			) t
		), '[]'::jsonb),
		'questions', case when i.type = 'qna' then coalesce((
			select jsonb_agg(jsonb_build_array(q.id, q.text, q.votes) order by q.votes desc, q.created_at, q.id)
			from (
				select id, text, votes, created_at from public.questions
				where run_id = r.id and item_id = i.id and not hidden and not answered
				order by votes desc, created_at, id
				limit 40
			) q
		), '[]'::jsonb) else '[]'::jsonb end,
		'players', coalesce((
			select jsonb_agg(jsonb_build_array(p.nickname, p.score) order by p.score desc, p.nickname)
			from (
				select nickname, score from public.players
				where run_id = r.id
				order by score desc, nickname
				limit 10
			) p
		), '[]'::jsonb)
	)
	from public.runs r
	left join public.deck_items i on i.deck_id = r.deck_id and i.position = r.current_position
	where r.code = p_code
);

revoke execute on function public.host_profile(uuid) from public, anon, authenticated;
revoke execute on function public.is_admin(uuid) from public, anon, authenticated;
revoke execute on function public.create_host_invite(uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.peek_host_invite(text) from public, anon, authenticated;
revoke execute on function public.accept_host_invite(text, uuid, text) from public, anon, authenticated;
revoke execute on function public.list_hosts(uuid) from public, anon, authenticated;
revoke execute on function public.remove_host(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.cancel_host_invite(uuid, uuid) from public, anon, authenticated;
grant execute on function public.host_profile(uuid) to service_role;
grant execute on function public.create_host_invite(uuid, text, text, text, text) to service_role;
grant execute on function public.peek_host_invite(text) to service_role;
grant execute on function public.accept_host_invite(text, uuid, text) to service_role;
grant execute on function public.list_hosts(uuid) to service_role;
grant execute on function public.remove_host(uuid, uuid) to service_role;
grant execute on function public.cancel_host_invite(uuid, uuid) to service_role;

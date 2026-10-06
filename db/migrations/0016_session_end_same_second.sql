-- ADR-011: a password reset must end sessions issued in the same second.
-- The stamp is whole seconds and a session is refused only when issued BEFORE
-- it, so one made in the reset's own second slipped through. Reporting the
-- stamp as the first whole second AFTER the reset closes that: a session
-- stamped floor(reset) is refused, floor(reset)+1 is accepted.
-- Both functions are 0013's, with only that one number changed.

create or replace function public.host_profile(p_user_id uuid) returns jsonb
language sql stable
security definer
set search_path = ''
return (
	select jsonb_build_object(
		'email', email,
		'name', name,
		'isAdmin', is_admin,
		'sessionsValidAfter', floor(extract(epoch from sessions_valid_after))::bigint + 1
	)
	from public.hosts where user_id = p_user_id
);

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
	return jsonb_build_object('status', 'ok', 'sessionsValidAfter', floor(extract(epoch from now()))::bigint + 1);
end;
$$;

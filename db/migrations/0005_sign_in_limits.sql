-- Brute-force guard for host sign-in (S6). Counts every attempt, successful or
-- not, per hashed IP and per hashed email, in the same unlogged rate_limits
-- table the answer path uses. True means go ahead and check the password.
create or replace function public.allow_sign_in(p_ip_hash text, p_email_hash text) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
	-- Per 15-minute window. Per email, 10: a host who mistypes gets several goes,
	-- and a guesser gets at most ~960 tries a day against a 32-character random
	-- password, which is hopeless. Per IP, 30: higher because a campus shares
	-- one address and a society has a few hosts; it stops one address trying
	-- many emails.
	email_limit constant int := 10;
	ip_limit constant int := 30;
	v_window timestamptz := date_bin('15 minutes', now(), timestamptz '2000-01-01 00:00:00+00');
	v_ip_hits int;
	v_email_hits int;
begin
	if coalesce(p_ip_hash, '') = '' or coalesce(p_email_hash, '') = '' then
		return false;
	end if;

	insert into public.rate_limits as r (key, window_start, count)
	values ('signin-ip:' || p_ip_hash, v_window, 1)
	on conflict (key, window_start) do update set count = r.count + 1
	returning r.count into v_ip_hits;

	insert into public.rate_limits as r (key, window_start, count)
	values ('signin-email:' || p_email_hash, v_window, 1)
	on conflict (key, window_start) do update set count = r.count + 1
	returning r.count into v_email_hits;

	return v_ip_hits <= ip_limit and v_email_hits <= email_limit;
end;
$$;

revoke execute on function public.allow_sign_in(text, text) from public, anon, authenticated;
grant execute on function public.allow_sign_in(text, text) to service_role;

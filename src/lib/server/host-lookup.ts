// One statement for every sign-in email, so an unknown email, a non-host and a
// host all cost the same single database round trip: the account for the email
// (Supabase keeps emails unique only among non-SSO accounts) and its host
// profile, which is null when the account is not a host. No row: no account.
export const HOST_LOOKUP_SQL = `
	select jsonb_build_object('userId', u.id, 'profile', public.host_profile(u.id)) as result
	from (select id from auth.users where lower(email) = $1 and not is_sso_user limit 1) u`;

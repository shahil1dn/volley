-- Runs the retention purge (0007) at the top of every hour (SPEC 23). Switching
-- on pg_cron is an owner-approved change, so it has its own migration.
-- Supabase's documented install: https://supabase.com/docs/guides/cron/install
-- Only when it is missing: Supabase runs an event trigger on every CREATE EXTENSION pg_cron, even an
-- `if not exists` one that does nothing, and that trigger fails ("grant options cannot be granted back to
-- your own grantor") when pg_cron is already installed, for example after someone enabled it in the dashboard.
do $$
begin
	if not exists (select 1 from pg_extension where extname = 'pg_cron') then
		create extension pg_cron with schema pg_catalog;
	end if;
end
$$;

grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

-- A named job is updated in place if this ever runs again, never duplicated.
select cron.schedule('volley-purge-expired', '0 * * * *', 'select public.purge_expired()');

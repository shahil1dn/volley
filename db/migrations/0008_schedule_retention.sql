-- Runs the retention purge (0007) at the top of every hour (SPEC 23). Switching
-- on pg_cron is an owner-approved change, so it has its own migration.
-- Supabase's documented install: https://supabase.com/docs/guides/cron/install
create extension if not exists pg_cron with schema pg_catalog;

grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

-- A named job is updated in place if this ever runs again, never duplicated.
select cron.schedule('volley-purge-expired', '0 * * * *', 'select public.purge_expired()');

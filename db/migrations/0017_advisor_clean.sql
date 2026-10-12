-- Clears the Supabase Security Advisor's INFO rows (A13): `rls_enabled_no_policy` on every table. It also adds the
-- indexes the Performance Advisor's `unindexed_foreign_keys` flags on six columns (that lint is not a security one).
-- Neither changes what the app can do.
--
-- 1. Explicit deny-all policies. Every table already has row-level security enabled AND forced, no policy, and
--    no privileges for anon or authenticated: three layers that each say "the Data API reaches nothing" (ADR-006).
--    With no policy the third layer is implicit, which the Advisor reports. A policy that matches nothing makes it
--    explicit. It is scoped `to anon, authenticated`, the two roles the Data API runs as:
--      - `postgres`, the role the app connects as (the pooler's `postgres.<ref>` user), has BYPASSRLS on Supabase
--        (pg_roles.rolbypassrls = true, not a superuser), and Postgres says a BYPASSRLS role skips row security
--        even when it is forced on the table. So no policy, this one included, is ever evaluated for the app. The
--        app's functions are SECURITY DEFINER and owned by postgres, so they bypass it too.
--      - `service_role` has BYPASSRLS as well. No other login role touches these tables.
--    `using (false)` / `with check (false)` can never allow a row: policies only ever add access, and this adds none.
--    Not `to public`: that would also name roles this has nothing to do with.
-- 2. Indexes on the six foreign-key columns that no index starts with. A composite index that has the column
--    second does not count (questions, quotas and tallies lead with run_id). They make a cascading delete of a deck
--    item or a host find its child rows by index instead of scanning. `responses` is the hot table: each answer
--    now writes one more small index entry.
--
-- Re-runnable: policies are dropped before they are created, indexes are `if not exists`.

do $$
declare
	t text;
begin
	foreach t in array array[
		'deck_items', 'decks', 'host_invites', 'hosts', 'moderation', 'players', 'question_votes',
		'questions', 'quotas', 'rate_limits', 'responses', 'runs', 'schema_migrations', 'tallies'
	] loop
		execute format('drop policy if exists deny_all_public_roles on public.%I', t);
		execute format('create policy deny_all_public_roles on public.%I as permissive for all to anon, authenticated using (false) with check (false)', t);
	end loop;
end
$$;

create index if not exists host_invites_created_by_idx on public.host_invites (created_by);
create index if not exists moderation_item_id_idx on public.moderation (item_id);
create index if not exists questions_item_id_idx on public.questions (item_id);
create index if not exists quotas_item_id_idx on public.quotas (item_id);
create index if not exists responses_item_id_idx on public.responses (item_id);
create index if not exists tallies_item_id_idx on public.tallies (item_id);

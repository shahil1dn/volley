-- Retention (SPEC 23, A12) and the host's results export (SPEC 5). The hourly
-- schedule that calls purge_expired() is in 0008, because switching on pg_cron
-- is a separate, owner-approved change.

-- The prune below finds old windows by start time alone, which the primary key
-- (key first) can't serve. Updates to a window's count leave this index alone.
create index if not exists rate_limits_window_start_idx on public.rate_limits (window_start);

-- Deletes every run that ended more than 24 hours ago or has been idle that
-- long, with everything under it (responses, tallies, quotas, moderation and
-- players cascade from runs). Decks are kept. Every host action and accepted
-- answer moves last_activity_at, so an ended run is also idle from its end; the
-- ended_at test is kept so the rule reads as the spec states it.
create or replace function public.purge_expired() returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	run_cutoff constant timestamptz := now() - interval '24 hours';
	-- The longest rate-limit window is sign-in's 15 minutes, so nothing still
	-- counting is older than this.
	window_cutoff constant timestamptz := now() - interval '1 hour';
	v_runs int;
	v_windows int;
begin
	delete from public.runs where ended_at < run_cutoff or last_activity_at < run_cutoff;
	get diagnostics v_runs = row_count;
	delete from public.rate_limits where window_start < window_cutoff;
	get diagnostics v_windows = row_count;
	return jsonb_build_object('runs', v_runs, 'rateLimitWindows', v_windows);
end;
$$;

-- Every activity of a run with its full tallies, hidden words included and
-- marked, for the host's CSV. Null for a run that isn't this host's.
create or replace function public.host_export(p_host_id uuid, p_code text) returns jsonb
language sql stable
security definer
set search_path = ''
return (
	select jsonb_build_object(
		'code', r.code,
		'items', coalesce((
			select jsonb_agg(jsonb_build_object(
				'position', i.position,
				'type', i.type,
				'prompt', i.settings ->> 'prompt',
				'tallies', coalesce((
					select jsonb_agg(jsonb_build_array(t.key, t.count, t.hidden) order by t.count desc, t.key)
					from public.tallies t
					where t.run_id = r.id and t.item_id = i.id
				), '[]'::jsonb)
			) order by i.position)
			from public.deck_items i
			where i.deck_id = r.deck_id
		), '[]'::jsonb)
	)
	from public.runs r
	join public.decks d on d.id = r.deck_id and d.host_id = p_host_id
	where r.code = p_code
);

revoke execute on function public.purge_expired() from public, anon, authenticated;
revoke execute on function public.host_export(uuid, text) from public, anon, authenticated;
grant execute on function public.purge_expired() to service_role;
grant execute on function public.host_export(uuid, text) to service_role;

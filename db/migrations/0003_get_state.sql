-- get_state: the one shared state every phone, projector and control view polls
-- (docs/ARCHITECTURE.md §7). It's cached at the edge and identical for everyone,
-- so it must never carry anything personal or secret.

-- Removes the named keys at any depth. A quiz may keep its answer inside each
-- option (options[].correct) as well as at the top level, so a top-level-only
-- strip would leak it.
create or replace function public.without_keys(doc jsonb, secret_keys text[]) returns jsonb
language plpgsql immutable
set search_path = ''
as $$
begin
	case jsonb_typeof(doc)
		when 'object' then
			return coalesce(
				(select jsonb_object_agg(k, public.without_keys(v, secret_keys))
				 from jsonb_each(doc) as e(k, v) where k <> all (secret_keys)),
				'{}'::jsonb);
		when 'array' then
			return coalesce(
				(select jsonb_agg(public.without_keys(v, secret_keys) order by i)
				 from jsonb_array_elements(doc) with ordinality as e(v, i)),
				'[]'::jsonb);
		else
			return doc;
	end case;
end;
$$;

-- Top visible words, read straight off the index in the order the state sends
-- them, so the top 100 never needs a sort. Replaces S2's index, which couldn't
-- skip hidden words or order ties.
drop index if exists public.tallies_run_id_item_id_count_idx;
create index tallies_visible_top_idx on public.tallies (run_id, item_id, count desc, key) where not hidden;

-- Null for an unknown code. Tallies and players are [key, count] and
-- [nickname, score] pairs to keep the response small.
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

revoke execute on function public.without_keys(jsonb, text[]) from public, anon, authenticated;
revoke execute on function public.get_state(text) from public, anon, authenticated;
grant execute on function public.get_state(text) to service_role;

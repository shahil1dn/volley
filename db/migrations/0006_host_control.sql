-- Host control (S7): starting a test run, the actions the control view sends,
-- and the host's own view of a run. Each takes the host id that the guard in
-- hooks.server.ts has already checked against `hosts`, and treats a run that
-- isn't that host's exactly like a run that doesn't exist.

-- A one-item word-cloud deck and a run of it, until real decks arrive in
-- Milestone 3.
create or replace function public.start_test_run(p_host_id uuid, p_prompt text) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	v_prompt text := btrim(coalesce(p_prompt, ''));
	v_deck uuid;
	v_code text;
begin
	if not exists (select 1 from public.hosts where user_id = p_host_id) then
		return jsonb_build_object('status', 'not_host');
	end if;
	if char_length(v_prompt) not between 1 and 140 then
		return jsonb_build_object('status', 'invalid');
	end if;

	insert into public.decks (host_id, title) values (p_host_id, 'Test run') returning id into v_deck;
	insert into public.deck_items (deck_id, position, type, settings)
	values (v_deck, 0, 'word_cloud', jsonb_build_object('prompt', v_prompt));

	-- Join codes are shown on the projector, so they needn't be unguessable.
	-- A collision is retried rather than checked for first, which could race.
	for attempt in 1..5 loop
		v_code := (select string_agg(substr(alphabet, 1 + floor(random() * 32)::int, 1), '') from generate_series(1, 5));
		begin
			insert into public.runs (deck_id, code) values (v_deck, v_code);
			return jsonb_build_object('status', 'ok', 'code', v_code);
		exception when unique_violation then
			-- Taken: try another code.
		end;
	end loop;
	raise exception 'Could not find a free join code';
end;
$$;

-- One entry point for every control action, so the ownership check, the state
-- machine (docs/ARCHITECTURE.md §4) and the version bump live in one place.
create or replace function public.host_action(p_host_id uuid, p_code text, p_action text, p_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_run public.runs;
	v_item public.deck_items;
	v_item_count int;
	v_status text;
	v_item_state text;
	v_position int;
	v_ended_at timestamptz;
	v_version bigint;
	illegal constant jsonb := jsonb_build_object('status', 'illegal');
begin
	-- Locked, so two control tabs pressing buttons at once apply in turn.
	select r.* into v_run
	from public.runs r join public.decks d on d.id = r.deck_id
	where r.code = p_code and d.host_id = p_host_id
	for update of r;
	if not found then
		return jsonb_build_object('status', 'not_found');
	end if;
	if v_run.status = 'ended' then
		return illegal;
	end if;

	select * into v_item from public.deck_items where deck_id = v_run.deck_id and position = v_run.current_position;
	select count(*) into v_item_count from public.deck_items where deck_id = v_run.deck_id;
	v_status := v_run.status;
	v_item_state := v_run.item_state;
	v_position := v_run.current_position;
	v_ended_at := v_run.ended_at;

	case p_action
		when 'open' then
			-- Opening the first activity is also what starts the run.
			-- A quiz opens through a scheduled start, which arrives in Milestone 2.
			if v_status not in ('lobby', 'live')
				or v_item_state <> 'closed'
				or (v_item.type is distinct from 'word_cloud' and v_item.type is distinct from 'poll') then
				return illegal;
			end if;
			v_status := 'live';
			v_item_state := 'open';
		when 'close' then
			if v_status not in ('live', 'frozen') or v_item_state <> 'open' then
				return illegal;
			end if;
			v_item_state := 'closed';
		when 'reveal' then
			if v_status <> 'live' or v_item_state <> 'closed' then
				return illegal;
			end if;
			v_item_state := 'revealed';
		when 'next', 'back' then
			v_position := v_position + case p_action when 'next' then 1 else -1 end;
			if v_status <> 'live' or v_position < 0 or v_position >= v_item_count then
				return illegal;
			end if;
			v_item_state := 'closed';
		when 'freeze' then
			if v_status <> 'live' then
				return illegal;
			end if;
			v_status := 'frozen';
		when 'unfreeze' then
			if v_status <> 'frozen' then
				return illegal;
			end if;
			v_status := 'live';
		when 'end' then
			v_status := 'ended';
			v_ended_at := now();
		when 'hide', 'unhide' then
			-- The log row and the flag change together (SPEC 20).
			update public.tallies set hidden = (p_action = 'hide')
			where run_id = v_run.id and item_id = v_item.id and key = p_key;
			if not found then
				return jsonb_build_object('status', 'invalid');
			end if;
			insert into public.moderation (run_id, item_id, key, action) values (v_run.id, v_item.id, p_key, p_action);
		else
			return jsonb_build_object('status', 'invalid');
	end case;

	update public.runs
	set status = v_status,
		item_state = v_item_state,
		current_position = v_position,
		opens_at = case when v_position <> v_run.current_position then null else opens_at end,
		closes_at = case when v_position <> v_run.current_position then null else closes_at end,
		ended_at = v_ended_at,
		version = version + 1,
		last_activity_at = now()
	where id = v_run.id
	returning version into v_version;

	return jsonb_build_object('status', 'ok', 'version', v_version);
end;
$$;

-- What the control view shows: the public state plus hidden words (so they can
-- be unhidden) and the item's full settings. Null for another host's run.
create or replace function public.host_view(p_host_id uuid, p_code text) returns jsonb
language sql stable
security definer
set search_path = ''
return (
	select jsonb_build_object(
		'code', r.code,
		'status', r.status,
		'version', r.version,
		'currentPosition', r.current_position,
		'itemCount', (select count(*) from public.deck_items where deck_id = r.deck_id),
		'itemState', r.item_state,
		'item', case when i.id is null then null else jsonb_build_object('type', i.type, 'settings', i.settings) end,
		'tallies', coalesce((
			select jsonb_agg(jsonb_build_array(t.key, t.count, t.hidden) order by t.count desc, t.key)
			from (
				select key, count, hidden from public.tallies
				where run_id = r.id and item_id = i.id
				order by count desc, key
				limit 300
			) t
		), '[]'::jsonb)
	)
	from public.runs r
	join public.decks d on d.id = r.deck_id and d.host_id = p_host_id
	left join public.deck_items i on i.deck_id = r.deck_id and i.position = r.current_position
	where r.code = p_code
);

revoke execute on function public.start_test_run(uuid, text) from public, anon, authenticated;
revoke execute on function public.host_action(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.host_view(uuid, text) from public, anon, authenticated;
grant execute on function public.start_test_run(uuid, text) to service_role;
grant execute on function public.host_action(uuid, text, text, text) to service_role;
grant execute on function public.host_view(uuid, text) to service_role;

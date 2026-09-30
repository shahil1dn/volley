-- The poll (Milestone 2, ADR-007): 2–6 options, one vote per participant, live
-- bars. It shares every rule in submit_answer with the word cloud; only what an
-- answer counts as and how many a person may send differ, and those two now
-- live in answer_key and answer_limit.

-- The tally key for an answer to an item, or null if the value isn't a valid
-- answer to it.
create or replace function public.answer_key(p_type text, p_settings jsonb, p_value text) returns text
language plpgsql immutable
set search_path = ''
as $$
declare
	v_word text;
begin
	case p_type
		when 'word_cloud' then
			v_word := public.normalise_word(p_value);
			return case when char_length(v_word) between 1 and 25 then v_word end;
		when 'poll' then
			-- The phone sends the option's position; the tally counts its text, so
			-- the CSV and the host's hide buttons show what people chose.
			if p_value !~ '^[0-5]$' then
				return null;
			end if;
			return p_settings -> 'options' ->> p_value::int;
		else
			return null;
	end case;
end;
$$;

-- How many answers one participant may send to an item.
create or replace function public.answer_limit(p_type text, p_settings jsonb) returns int
language sql immutable
set search_path = ''
return case p_type
	when 'poll' then 1
	else coalesce((p_settings ->> 'answersPerPerson')::int, 3)
end;

create or replace function public.answers_left(p_run_id uuid, p_item_id uuid, p_participant_id uuid) returns int
language sql stable
set search_path = ''
return (
	select greatest(0, public.answer_limit(i.type, i.settings) - coalesce(q.used, 0))
	from public.deck_items i
	left join public.quotas q
		on q.run_id = p_run_id and q.item_id = i.id and q.participant_id = p_participant_id
	where i.id = p_item_id
);

-- Unchanged from 0004 except where the answer is checked: answer_key and
-- answer_limit replace the word-cloud-only code.
create or replace function public.submit_answer(
	p_code text,
	p_participant_id uuid,
	p_submit_id uuid,
	p_value text,
	p_ip_hash text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	-- Rate limits per 10-second window. The per-run cap is the real guard: it
	-- bounds what any one room can cost, at ~30x the ~2 writes/s expected at peak
	-- (ADR-002). The per-IP cap only has to stop one address spreading a flood
	-- across many rooms. A whole campus can share one public IP (eduroam), so it
	-- sits well above any real crowd: 2,000 is 3 full rooms at their own cap,
	-- while still holding one script to ~200 writes/s in total.
	ip_limit constant int := 2000;
	run_limit constant int := 600;
	v_window timestamptz := date_bin('10 seconds', now(), timestamptz '2000-01-01 00:00:00+00');
	v_hits int;
	v_run public.runs;
	v_item public.deck_items;
	v_prior public.responses;
	v_limit int;
	v_key text;
	v_used int;
begin
	if p_code is null or p_participant_id is null or p_submit_id is null or coalesce(p_ip_hash, '') = '' then
		return jsonb_build_object('status', 'invalid');
	end if;

	-- Counted before anything else, so retries and refusals cost budget too.
	insert into public.rate_limits as r (key, window_start, count)
	values ('ip:' || p_ip_hash, v_window, 1)
	on conflict (key, window_start) do update set count = r.count + 1
	returning r.count into v_hits;
	if v_hits > ip_limit then
		return jsonb_build_object('status', 'rate_limited');
	end if;

	select * into v_run from public.runs where code = p_code;
	if not found then
		return jsonb_build_object('status', 'closed');
	end if;

	-- Keyed by the run found above rather than the code sent, so made-up codes
	-- can't fill this table.
	insert into public.rate_limits as r (key, window_start, count)
	values ('run:' || v_run.id, v_window, 1)
	on conflict (key, window_start) do update set count = r.count + 1
	returning r.count into v_hits;
	if v_hits > run_limit then
		return jsonb_build_object('status', 'rate_limited');
	end if;

	-- A repeat of an accepted submit gets the answer it got the first time, even
	-- if the item has closed since (SPEC 12). Checked before the open/closed
	-- rules for exactly that reason.
	select * into v_prior from public.responses
	where participant_id = p_participant_id and submit_id = p_submit_id;
	if found then
		return jsonb_build_object('status', 'ok',
			'left', public.answers_left(v_prior.run_id, v_prior.item_id, p_participant_id));
	end if;

	if v_run.status = 'frozen' then
		return jsonb_build_object('status', 'frozen');
	end if;
	if v_run.status <> 'live' then
		return jsonb_build_object('status', 'closed');
	end if;

	select * into v_item from public.deck_items
	where deck_id = v_run.deck_id and position = v_run.current_position;
	if not found
		or v_run.item_state <> 'open'
		or (v_run.opens_at is not null and now() < v_run.opens_at)
		or (v_run.closes_at is not null and now() > v_run.closes_at) then
		return jsonb_build_object('status', 'closed');
	end if;

	v_key := public.answer_key(v_item.type, v_item.settings, p_value);
	if v_key is null then
		return jsonb_build_object('status', 'invalid');
	end if;
	v_limit := public.answer_limit(v_item.type, v_item.settings);

	-- The response and the quota succeed or fail together. A full quota rolls
	-- back only this block, so the rate-limit counts above still stand: a
	-- script can't retry past its quota for free.
	begin
		insert into public.responses (run_id, item_id, participant_id, submit_id, value)
		values (v_run.id, v_item.id, p_participant_id, p_submit_id, v_key)
		on conflict (participant_id, submit_id) do nothing;
		if not found then
			-- The same submit arrived twice at once, and the other copy won.
			return jsonb_build_object('status', 'ok',
				'left', public.answers_left(v_run.id, v_item.id, p_participant_id));
		end if;

		-- Conditional upsert: under concurrent submits, the row lock makes each
		-- one re-check `used` against the latest committed count.
		insert into public.quotas as q (run_id, item_id, participant_id, used)
		values (v_run.id, v_item.id, p_participant_id, 1)
		on conflict (run_id, item_id, participant_id) do update set used = q.used + 1
		where q.used < v_limit
		returning q.used into v_used;
		if not found or v_used > v_limit then
			raise exception 'answer limit reached' using errcode = 'VQ001';
		end if;
	exception when sqlstate 'VQ001' then
		return jsonb_build_object('status', 'limit', 'left', 0);
	end;

	-- `hidden` is left untouched: a word the host hid stays hidden when someone
	-- sends it again, but it still counts, so un-hiding it later is accurate.
	insert into public.tallies as t (run_id, item_id, key, count)
	values (v_run.id, v_item.id, v_key, 1)
	on conflict (run_id, item_id, key) do update set count = t.count + 1;

	update public.runs set version = version + 1, last_activity_at = now() where id = v_run.id;

	return jsonb_build_object('status', 'ok', 'left', v_limit - v_used);
end;
$$;

-- A run of a deck with a fresh join code. Every poll option starts at zero, so
-- the shared state lists all visible options, voted for or not, and a hidden
-- option simply drops out of it.
create or replace function public.create_run(p_deck uuid) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
	alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	v_code text;
	v_run uuid;
begin
	-- Join codes are shown on the projector, so they needn't be unguessable.
	-- A collision is retried rather than checked for first, which could race.
	for attempt in 1..5 loop
		v_code := (select string_agg(substr(alphabet, 1 + floor(random() * 32)::int, 1), '') from generate_series(1, 5));
		begin
			insert into public.runs (deck_id, code) values (p_deck, v_code) returning id into v_run;
			exit;
		exception when unique_violation then
			-- Taken: try another code.
		end;
	end loop;
	if v_run is null then
		raise exception 'Could not find a free join code';
	end if;

	insert into public.tallies (run_id, item_id, key, count)
	select v_run, i.id, option.label, 0
	from public.deck_items i
	cross join lateral jsonb_array_elements_text(i.settings -> 'options') as option(label)
	where i.deck_id = p_deck and i.type = 'poll';

	return v_code;
end;
$$;

-- Unchanged from 0006 except that the run comes from create_run.
create or replace function public.start_test_run(p_host_id uuid, p_prompt text) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_prompt text := btrim(coalesce(p_prompt, ''));
	v_deck uuid;
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
	return jsonb_build_object('status', 'ok', 'code', public.create_run(v_deck));
end;
$$;

-- A one-item poll deck and a run of it, until real decks arrive in Milestone 3.
create or replace function public.start_test_poll(p_host_id uuid, p_prompt text, p_options text[]) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_prompt text := btrim(coalesce(p_prompt, ''));
	v_options text[] := (select array_agg(btrim(o) order by n) from unnest(p_options) with ordinality as u(o, n));
	v_deck uuid;
begin
	if not exists (select 1 from public.hosts where user_id = p_host_id) then
		return jsonb_build_object('status', 'not_host');
	end if;
	-- Options are told apart by their text, so two that differ only in case
	-- would be confusing on a phone and are refused.
	if char_length(v_prompt) not between 1 and 140
		or coalesce(cardinality(v_options), 0) not between 2 and 6
		or exists (select 1 from unnest(v_options) o where o is null or char_length(o) not between 1 and 80)
		or (select count(distinct lower(o)) from unnest(v_options) o) <> cardinality(v_options) then
		return jsonb_build_object('status', 'invalid');
	end if;

	insert into public.decks (host_id, title) values (p_host_id, 'Test poll') returning id into v_deck;
	insert into public.deck_items (deck_id, position, type, settings)
	values (v_deck, 0, 'poll', jsonb_build_object('prompt', v_prompt, 'options', to_jsonb(v_options)));
	return jsonb_build_object('status', 'ok', 'code', public.create_run(v_deck));
end;
$$;

revoke execute on function public.answer_key(text, jsonb, text) from public, anon, authenticated;
revoke execute on function public.answer_limit(text, jsonb) from public, anon, authenticated;
revoke execute on function public.create_run(uuid) from public, anon, authenticated;
revoke execute on function public.start_test_poll(uuid, text, text[]) from public, anon, authenticated;
grant execute on function public.start_test_poll(uuid, text, text[]) to service_role;

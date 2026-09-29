-- submit_answer: the only way an answer gets in (docs/ARCHITECTURE.md §6).
-- Every rule is checked in this one transaction, so two phones submitting at the
-- same instant can't slip past a limit.

-- The one definition of a word's cleaned-up form. It lives here, not in the
-- route, so it can't be bypassed and the stored word always equals its tally
-- key. src/lib/words.ts mirrors it for the phone; the database tests check
-- that the two agree.
create or replace function public.normalise_word(raw text) returns text
language sql immutable strict parallel safe
set search_path = ''
return lower(regexp_replace(regexp_replace(raw, '^\s+|\s+$', '', 'g'), '\s+', ' ', 'g'));

-- How many more answers a participant may send to one item of one run.
create or replace function public.answers_left(p_run_id uuid, p_item_id uuid, p_participant_id uuid) returns int
language sql stable
set search_path = ''
return (
	select greatest(0, coalesce((i.settings ->> 'answersPerPerson')::int, 3) - coalesce(q.used, 0))
	from public.deck_items i
	left join public.quotas q
		on q.run_id = p_run_id and q.item_id = i.id and q.participant_id = p_participant_id
	where i.id = p_item_id
);

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
	-- Rate limits per 10-second window. A whole room often shares one IP (campus
	-- Wi-Fi), and 200 people each sending up to 3 words in the first seconds of
	-- a question is ~600 submits, so the per-IP cap must fit a room, not a
	-- person: it stops one script flooding from one address. The per-run cap
	-- bounds what any single room can cost, at ~30x the ~2 writes/s expected at
	-- peak (ADR-002). Starting values; revisit after the first real workshop.
	ip_limit constant int := 300;
	run_limit constant int := 600;
	v_window timestamptz := date_bin('10 seconds', now(), timestamptz '2000-01-01 00:00:00+00');
	v_hits int;
	v_run public.runs;
	v_item public.deck_items;
	v_prior public.responses;
	v_limit int;
	v_word text;
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

	-- Poll and quiz arrive in Milestone 2 with their own rules.
	if v_item.type <> 'word_cloud' then
		return jsonb_build_object('status', 'invalid');
	end if;

	v_word := public.normalise_word(p_value);
	if v_word is null or char_length(v_word) not between 1 and 25 then
		return jsonb_build_object('status', 'invalid');
	end if;

	v_limit := coalesce((v_item.settings ->> 'answersPerPerson')::int, 3);

	-- The response and the quota succeed or fail together. A full quota rolls
	-- back only this block, so the rate-limit counts above still stand: a
	-- script can't retry past its quota for free.
	begin
		insert into public.responses (run_id, item_id, participant_id, submit_id, value)
		values (v_run.id, v_item.id, p_participant_id, p_submit_id, v_word)
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
	values (v_run.id, v_item.id, v_word, 1)
	on conflict (run_id, item_id, key) do update set count = t.count + 1;

	update public.runs set version = version + 1, last_activity_at = now() where id = v_run.id;

	return jsonb_build_object('status', 'ok', 'left', v_limit - v_used);
end;
$$;

-- Called only by the server with the secret key (service_role). Postgres grants
-- EXECUTE to everyone by default, so each function is locked down explicitly.
revoke execute on function public.normalise_word(text) from public, anon, authenticated;
revoke execute on function public.answers_left(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.submit_answer(text, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.submit_answer(text, uuid, uuid, text, text) to service_role;

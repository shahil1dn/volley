-- A feedback form ('feedback', ADR-018): a title (stored as `prompt`, 1 to 140
-- characters) and 1 to 8 rating questions of 1 to 80 characters, each with its
-- own scale: 'stars' (1 to 5), 'ten' (1 to 10) or 'words' (Very bad to Very
-- good, stored as 1 to 5). A phone sends the whole form once, as a JSON list of
-- whole numbers, one per question in order.
--
-- Its ratings are secret until the host shows them: get_state, which is public
-- and cached, carries only how many forms were sent until the item is revealed.
-- host_view and host_export are host-only and carry everything.
--
-- Tallies, kept on write (SPEC 19): key '<question number>:<rating>' (numbers
-- from 0) and key 'n', the count of forms sent.
--
-- Each function replaced here is its newest version (submit_answer 0010,
-- get_state, host_view and host_action 0015, host_export 0010, start_session
-- 0018) plus the feedback form, and nothing else.

alter table public.deck_items drop constraint deck_items_type_check;
alter table public.deck_items add constraint deck_items_type_check check (type in ('word_cloud', 'poll', 'quiz', 'qna', 'thanks', 'feedback'));

-- The top of a scale (every scale starts at 1), or null for an unknown one.
create or replace function public.feedback_scale_max(p_scale text) returns int
language sql immutable
set search_path = ''
return case p_scale when 'stars' then 5 when 'ten' then 10 when 'words' then 5 end;

-- The ratings of one whole form as a JSON list, or null unless the value is a
-- list of exactly one rating per question, each a plain whole number inside its
-- question's scale. Read as `json`, not `jsonb`, so each rating's own text is
-- tested: jsonb would turn 1e1 into 10 and keep 5.0 as a number.
create or replace function public.feedback_ratings(p_settings jsonb, p_value text) returns jsonb
language plpgsql immutable
set search_path = ''
as $$
declare
	v_form json;
	v_questions jsonb := p_settings -> 'questions';
	v_ratings int[];
begin
	begin
		v_form := p_value::json;
	exception when invalid_text_representation then
		return null;
	end;
	-- Two steps: SQL does not promise to test an OR left to right, and the length of
	-- something that is not a list is an error, not a refusal.
	if json_typeof(v_form) is distinct from 'array' or jsonb_typeof(v_questions) is distinct from 'array' then
		return null;
	end if;
	if json_array_length(v_form) <> jsonb_array_length(v_questions) then
		return null;
	end if;

	-- Anything but digits (a gap, a string, 4.5, -1, 1e1) becomes null here and is
	-- refused below. CASE, so the cast only ever sees digits.
	select array_agg(case when json_typeof(r.rating) = 'number' and r.rating::text ~ '^[0-9]{1,2}$'
			then r.rating::text::int end order by r.n)
	into v_ratings
	from json_array_elements(v_form) with ordinality as r(rating, n);

	if exists (
		select 1
		from unnest(v_ratings) with ordinality as c(rating, n)
		join jsonb_array_elements(v_questions) with ordinality as q(question, n) on q.n = c.n
		where c.rating is null or c.rating not between 1 and coalesce(public.feedback_scale_max(q.question ->> 'scale'), 0)
	) then
		return null;
	end if;
	return to_jsonb(v_ratings);
end;
$$;

-- 0010's rules plus the feedback form, whose key is its checked list of ratings.
create or replace function public.answer_key(p_type text, p_settings jsonb, p_value text) returns text
language plpgsql immutable
set search_path = ''
as $$
declare
	v_text text;
begin
	case p_type
		when 'word_cloud' then
			v_text := public.normalise_word(p_value);
			return case when char_length(v_text) between 1 and 25 then v_text end;
		when 'poll' then
			-- The phone sends the option's position; the tally counts its text, so
			-- the CSV and the host's hide buttons show what people chose.
			if p_value !~ '^[0-5]$' then
				return null;
			end if;
			return p_settings -> 'options' ->> p_value::int;
		when 'qna' then
			v_text := regexp_replace(regexp_replace(p_value, '^\s+|\s+$', '', 'g'), '\s+', ' ', 'g');
			return case when char_length(v_text) between 1 and 280 then v_text end;
		when 'feedback' then
			return public.feedback_ratings(p_settings, p_value)::text;
		else
			return null;
	end case;
end;
$$;

-- One form per person, like one vote per person on a poll: it can't be changed.
create or replace function public.answer_limit(p_type text, p_settings jsonb) returns int
language sql immutable
set search_path = ''
return case p_type
	when 'poll' then 1
	when 'feedback' then 1
	when 'qna' then 5
	else coalesce((p_settings ->> 'answersPerPerson')::int, 3)
end;

-- Unchanged from 0010 except for a feedback form: it holds the run while it is
-- counted, and adds one to each of its ratings and to the count of forms sent.
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
	v_rating int;
	v_question int;
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

	-- Show results makes a form's results public in one step, so no form may be counted
	-- after it. The run above was read without a lock, so take it now and check again:
	-- a press already made refuses this form, and a press made now waits for it.
	if v_item.type = 'feedback' then
		perform 1 from public.runs
		where id = v_run.id and status = 'live' and item_state = 'open' and current_position = v_run.current_position
		for update;
		if not found then
			return jsonb_build_object('status', 'closed');
		end if;
	end if;

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

	if v_item.type = 'qna' then
		insert into public.questions (run_id, item_id, text) values (v_run.id, v_item.id, v_key);
	elsif v_item.type = 'feedback' then
		-- In question order, then the count of forms, so every form takes its row
		-- locks in the same order.
		for v_rating, v_question in
			select r.value::int, r.n - 1 from jsonb_array_elements_text(v_key::jsonb) with ordinality as r(value, n) order by r.n
		loop
			insert into public.tallies as t (run_id, item_id, key, count)
			values (v_run.id, v_item.id, v_question || ':' || v_rating, 1)
			on conflict (run_id, item_id, key) do update set count = t.count + 1;
		end loop;
		insert into public.tallies as t (run_id, item_id, key, count)
		values (v_run.id, v_item.id, 'n', 1)
		on conflict (run_id, item_id, key) do update set count = t.count + 1;
	else
		-- `hidden` is left untouched: a word the host hid stays hidden when someone
		-- sends it again, but it still counts, so un-hiding it later is accurate.
		insert into public.tallies as t (run_id, item_id, key, count)
		values (v_run.id, v_item.id, v_key, 1)
		on conflict (run_id, item_id, key) do update set count = t.count + 1;
	end if;

	update public.runs set version = version + 1, last_activity_at = now() where id = v_run.id;

	return jsonb_build_object('status', 'ok', 'left', v_limit - v_used);
end;
$$;

-- 0015's state, except that a feedback form's ratings are left out until the
-- host reveals them, and `responses` says how many forms were sent (0 for any
-- other type).
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
		'hostName', (select h.name from public.decks d join public.hosts h on h.user_id = d.host_id where d.id = r.deck_id),
		'item', case when i.id is null then null else jsonb_build_object(
			'type', i.type,
			-- Keys that are secret until the host reveals the item. The quiz adds
			-- to this list in Milestone 2 if it needs more than `correct`.
			'settings', case when r.item_state = 'revealed' then i.settings
				else public.without_keys(i.settings, array['correct']) end
		) end,
		-- Absent, not just undrawn: this state is public and cached, so a feedback
		-- form's ratings must not be in it before the host shows them (ADR-018).
		'tallies', case when i.type = 'feedback' and r.item_state <> 'revealed' then '[]'::jsonb else coalesce((
			select jsonb_agg(jsonb_build_array(t.key, t.count) order by t.count desc, t.key)
			from (
				select key, count from public.tallies
				where run_id = r.id and item_id = i.id and not hidden
					-- The count of forms is sent as `responses`, not as a rating.
					and not (i.type = 'feedback' and key = 'n')
				order by count desc, key
				limit 100
			) t
		), '[]'::jsonb) end,
		'responses', case when i.type = 'feedback' then coalesce((
			select t.count from public.tallies t where t.run_id = r.id and t.item_id = i.id and t.key = 'n'
		), 0) else 0 end,
		'questions', case when i.type = 'qna' then coalesce((
			select jsonb_agg(jsonb_build_array(q.id, q.text, q.votes) order by q.votes desc, q.created_at, q.id)
			from (
				select id, text, votes, created_at from public.questions
				where run_id = r.id and item_id = i.id and not hidden and not answered
				order by votes desc, created_at, id
				limit 40
			) q
		), '[]'::jsonb) else '[]'::jsonb end,
		-- The question the host has put on the projector (null if none, or if it was
		-- hidden since), and how many others are still waiting their turn.
		'shown', case when i.type = 'qna' then (
			select jsonb_build_array(q.id, q.text, q.votes) from public.questions q
			where q.run_id = r.id and q.item_id = i.id and q.on_screen and not q.hidden
		) end,
		-- Counted up to 101 (the page shows 100+ above 100) and read through the
		-- main-list index, so a room with thousands of questions costs no more than
		-- one with a hundred.
		'waiting', case when i.type = 'qna' then (
			select count(*) from (
				select 1 from public.questions q
				where q.run_id = r.id and q.item_id = i.id and not q.hidden and not q.answered and not q.on_screen
				order by q.votes desc, q.created_at, q.id
				limit 101
			) w
		) else 0 end,
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

-- 0015's host view plus `responses`, the count of forms sent on a feedback form.
-- Its ratings are in `tallies` whether or not they are on the projector yet.
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
		), '[]'::jsonb),
		'responses', case when i.type = 'feedback' then coalesce((
			select t.count from public.tallies t where t.run_id = r.id and t.item_id = i.id and t.key = 'n'
		), 0) else 0 end,
		'shown', case when i.type = 'qna' then (
			select q.id from public.questions q where q.run_id = r.id and q.item_id = i.id and q.on_screen
		) end,
		'questions', case when i.type = 'qna' then coalesce((
			select jsonb_agg(jsonb_build_array(q.id, q.text, q.votes, q.hidden, q.answered, q.shown_seq)
				order by q.answered, q.votes desc, q.created_at, q.id)
			from (
				select id, text, votes, hidden, answered, shown_seq, created_at from public.questions
				where run_id = r.id and item_id = i.id
				order by answered, votes desc, created_at, id
				limit 300
			) q
		), '[]'::jsonb) else '[]'::jsonb end
	)
	from public.runs r
	join public.decks d on d.id = r.deck_id and d.host_id = p_host_id
	left join public.deck_items i on i.deck_id = r.deck_id and i.position = r.current_position
	where r.code = p_code
);

-- 0015's host_action with three changes for the feedback form: 'open' accepts
-- it; 'reveal' (Show results) also works while its answers are open, closing
-- them in the same step; and 'hide'/'unhide' refuse it, since a hidden rating
-- would change the average without saying so.
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
	v_expected bigint;
	v_cur public.questions;
	v_target bigint;
	v_renew boolean := false;
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
			-- A quiz opens through a scheduled start, which is out of scope (ADR-007).
			if v_status not in ('lobby', 'live')
				or v_item_state <> 'closed'
				or v_item.type is null
				or v_item.type not in ('word_cloud', 'poll', 'qna', 'feedback') then
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
			-- One press on a feedback form closes its answers and shows the results.
			if v_status <> 'live'
				or not (v_item_state = 'closed' or (v_item_state = 'open' and v_item.type = 'feedback')) then
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
			if v_item.type = 'feedback' then
				return jsonb_build_object('status', 'invalid');
			end if;
			-- The log row and the flag change together (SPEC 20).
			if v_item.type = 'qna' then
				if coalesce(p_key, '') !~ '^[0-9]{1,18}$' then
					return jsonb_build_object('status', 'invalid');
				end if;
				-- Hiding the question on the projector takes it off at once, and
				-- unhiding it later does not put it back.
				update public.questions set hidden = (p_action = 'hide'), on_screen = on_screen and p_action <> 'hide'
				where id = p_key::bigint and run_id = v_run.id and item_id = v_item.id;
			else
				update public.tallies set hidden = (p_action = 'hide')
				where run_id = v_run.id and item_id = v_item.id and key = p_key;
			end if;
			if not found then
				return jsonb_build_object('status', 'invalid');
			end if;
			insert into public.moderation (run_id, item_id, key, action) values (v_run.id, v_item.id, p_key, p_action);
		when 'question_next', 'question_back' then
			-- The key is the question the host believes is on the projector ('' for
			-- none). If that is no longer so (a retried request, a double click, a
			-- second control tab), nothing moves, so a repeat can never skip one.
			if v_item.type is distinct from 'qna' or v_status not in ('live', 'frozen')
				or p_key is null or (p_key <> '' and p_key !~ '^[0-9]{1,18}$') then
				return illegal;
			end if;
			v_expected := nullif(p_key, '')::bigint;
			select * into v_cur from public.questions q where q.run_id = v_run.id and q.item_id = v_item.id and q.on_screen;
			if v_cur.id is distinct from v_expected then
				return jsonb_build_object('status', 'ok', 'version', v_run.version, 'moved', false, 'reason', 'stale');
			end if;

			if p_action = 'question_next' then
				-- After a Previous, forward through what was shown before.
				if v_cur.id is not null then
					select q.id into v_target from public.questions q
					where q.run_id = v_run.id and q.item_id = v_item.id and not q.hidden and q.shown_seq > v_cur.shown_seq
					order by q.shown_seq
					limit 1;
				end if;
				-- Otherwise whatever was shown and left unanswered (a question hidden
				-- and unhidden, say), then the top-voted one never shown. One shown
				-- before takes a fresh turn at the end of the history, so walking
				-- forward later cannot land on something already answered.
				if v_target is null then
					select q.id into v_target from public.questions q
					where q.run_id = v_run.id and q.item_id = v_item.id and not q.hidden and not q.answered and q.id is distinct from v_cur.id
					order by q.shown_seq nulls last, q.votes desc, q.created_at, q.id
					limit 1;
					v_renew := true;
				end if;
			else
				select q.id into v_target from public.questions q
				where q.run_id = v_run.id and q.item_id = v_item.id and not q.hidden and q.shown_seq is not null
					and (v_cur.id is null or q.shown_seq < v_cur.shown_seq)
				order by q.shown_seq desc
				limit 1;
			end if;
			if v_target is null then
				return jsonb_build_object('status', 'ok', 'version', v_run.version, 'moved', false,
					'reason', case when p_action = 'question_next' then 'none_left' else 'first' end);
			end if;

			-- Moving on is done with it. Going back leaves the one we left as it was.
			if p_action = 'question_next' and v_cur.id is not null then
				update public.questions set answered = true where id = v_cur.id and not hidden;
			end if;
			update public.questions set on_screen = false where run_id = v_run.id and item_id = v_item.id and on_screen;
			update public.questions set on_screen = true,
				shown_seq = case when shown_seq is null or v_renew
					then (select coalesce(max(s.shown_seq), 0) + 1 from public.questions s where s.run_id = v_run.id and s.item_id = v_item.id)
					else shown_seq end
			where id = v_target;
		when 'answer', 'unanswer' then
			if v_item.type is distinct from 'qna' or coalesce(p_key, '') !~ '^[0-9]{1,18}$' then
				return jsonb_build_object('status', 'invalid');
			end if;
			update public.questions set answered = (p_action = 'answer')
			where id = p_key::bigint and run_id = v_run.id and item_id = v_item.id;
			if not found then
				return jsonb_build_object('status', 'invalid');
			end if;
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

	if p_action in ('question_next', 'question_back') then
		return jsonb_build_object('status', 'ok', 'version', v_version, 'moved', true);
	end if;
	return jsonb_build_object('status', 'ok', 'version', v_version);
end;
$$;

-- 0010's export plus `form`, a feedback form's questions and scales (null for
-- other types), so the CSV can name each question and every point of its scale.
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
				'form', case when i.type = 'feedback' then i.settings -> 'questions' end,
				'tallies', coalesce((
					select jsonb_agg(jsonb_build_array(t.key, t.count, t.hidden) order by t.count desc, t.key)
					from public.tallies t
					where t.run_id = r.id and t.item_id = i.id
				), '[]'::jsonb),
				'questions', coalesce((
					select jsonb_agg(jsonb_build_array(q.text, q.votes, q.hidden, q.answered) order by q.votes desc, q.created_at, q.id)
					from public.questions q
					where q.run_id = r.id and q.item_id = i.id
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

-- 0018's start_session plus the feedback form: [{type: 'feedback', prompt,
-- questions: [{text, scale}]}], 1 to 8 questions. It may come first.
create or replace function public.start_session(p_host_id uuid, p_items jsonb) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_deck uuid;
	v_item jsonb;
	v_position int;
	v_type text;
	v_prompt text;
	v_options text[];
	v_settings jsonb;
begin
	if not exists (select 1 from public.hosts where user_id = p_host_id) then
		return jsonb_build_object('status', 'not_host');
	end if;
	if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 10 then
		return jsonb_build_object('status', 'invalid');
	end if;

	insert into public.decks (host_id, title) values (p_host_id, 'Session') returning id into v_deck;
	for v_item, v_position in select value, ordinality - 1 from jsonb_array_elements(p_items) with ordinality loop
		v_type := v_item ->> 'type';
		-- A session starts by opening answers on its first activity, and a
		-- thank-you slide has none, so it cannot come first.
		if v_position = 0 and v_type = 'thanks' then
			raise exception 'invalid item' using errcode = 'VQ002';
		end if;
		v_prompt := btrim(coalesce(v_item ->> 'prompt', ''));
		if char_length(v_prompt) not between 1 and 140 then
			raise exception 'invalid item' using errcode = 'VQ002';
		end if;
		case v_type
			when 'word_cloud', 'qna', 'thanks' then
				v_settings := jsonb_build_object('prompt', v_prompt);
			when 'poll' then
				if jsonb_typeof(v_item -> 'options') is distinct from 'array' then
					raise exception 'invalid item' using errcode = 'VQ002';
				end if;
				v_options := (
					select array_agg(btrim(o) order by n)
					from jsonb_array_elements_text(v_item -> 'options') with ordinality as u(o, n)
				);
				-- Options are told apart by their text, so two that differ only in
				-- case would be confusing on a phone and are refused.
				if coalesce(cardinality(v_options), 0) not between 2 and 6
					or exists (select 1 from unnest(v_options) o where char_length(o) not between 1 and 80)
					or (select count(distinct lower(o)) from unnest(v_options) o) <> cardinality(v_options) then
					raise exception 'invalid item' using errcode = 'VQ002';
				end if;
				v_settings := jsonb_build_object('prompt', v_prompt, 'options', to_jsonb(v_options));
			when 'feedback' then
				-- Questions are told apart by their place, not their text, so two
				-- alike are allowed.
				-- A list first, on its own: SQL does not promise to test an OR left to right.
				if jsonb_typeof(v_item -> 'questions') is distinct from 'array' then
					raise exception 'invalid item' using errcode = 'VQ002';
				end if;
				if jsonb_array_length(v_item -> 'questions') not between 1 and 8
					or exists (
						select 1 from jsonb_array_elements(v_item -> 'questions') q
						where jsonb_typeof(q -> 'text') is distinct from 'string'
							or char_length(btrim(q ->> 'text')) not between 1 and 80
							or jsonb_typeof(q -> 'scale') is distinct from 'string'
							or public.feedback_scale_max(q ->> 'scale') is null
					) then
					raise exception 'invalid item' using errcode = 'VQ002';
				end if;
				v_settings := jsonb_build_object('prompt', v_prompt, 'questions', (
					select jsonb_agg(jsonb_build_object('text', btrim(q ->> 'text'), 'scale', q ->> 'scale') order by n)
					from jsonb_array_elements(v_item -> 'questions') with ordinality as u(q, n)
				));
			else
				raise exception 'invalid item' using errcode = 'VQ002';
		end case;
		insert into public.deck_items (deck_id, position, type, settings) values (v_deck, v_position, v_type, v_settings);
	end loop;

	return jsonb_build_object('status', 'ok', 'code', public.create_run(v_deck));
exception when sqlstate 'VQ002' then
	-- Leaving this block undoes the deck and any items already added.
	return jsonb_build_object('status', 'invalid');
end;
$$;

-- Helpers run only inside the functions above; the server calls the rest with
-- the secret key (service_role), as before.
revoke execute on function public.feedback_scale_max(text) from public, anon, authenticated;
revoke execute on function public.feedback_ratings(jsonb, text) from public, anon, authenticated;
revoke execute on function public.answer_key(text, jsonb, text) from public, anon, authenticated;
revoke execute on function public.answer_limit(text, jsonb) from public, anon, authenticated;
revoke execute on function public.submit_answer(text, uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.get_state(text) from public, anon, authenticated;
revoke execute on function public.host_view(uuid, text) from public, anon, authenticated;
revoke execute on function public.host_action(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.host_export(uuid, text) from public, anon, authenticated;
revoke execute on function public.start_session(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.submit_answer(text, uuid, uuid, text, text) to service_role;
grant execute on function public.get_state(text) to service_role;
grant execute on function public.host_view(uuid, text) to service_role;
grant execute on function public.host_action(uuid, text, text, text) to service_role;
grant execute on function public.host_export(uuid, text) to service_role;
grant execute on function public.start_session(uuid, jsonb) to service_role;

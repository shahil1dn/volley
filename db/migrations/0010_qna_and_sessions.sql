-- Q&A (ADR-008) and multi-activity sessions. Additive for the code already
-- deployed: every function it calls keeps its signature, and the ones replaced
-- here only gain fields. start_test_run and start_test_poll stay until the next
-- deploy stops calling them.

alter table public.deck_items drop constraint deck_items_type_check;
alter table public.deck_items add constraint deck_items_type_check check (type in ('word_cloud', 'poll', 'quiz', 'qna'));

-- Who asked is in `responses` (insert-only, like every answer); a question
-- itself carries nothing personal, so it can go in the shared state.
create table public.questions (
	id bigint generated always as identity primary key,
	run_id uuid not null references public.runs (id) on delete cascade,
	item_id uuid not null references public.deck_items (id) on delete cascade,
	text text not null check (char_length(text) between 1 and 280),
	votes int not null default 0 check (votes >= 0),
	hidden boolean not null default false,
	answered boolean not null default false,
	created_at timestamptz not null default now()
);
-- The main list, read straight off the index in the order the state sends it.
create index questions_main_list_idx on public.questions (run_id, item_id, votes desc, created_at, id)
	where not hidden and not answered;
create index questions_run_id_item_id_idx on public.questions (run_id, item_id);

-- One row per upvote. Taking a vote back deletes its row.
create table public.question_votes (
	question_id bigint not null references public.questions (id) on delete cascade,
	participant_id uuid not null,
	primary key (question_id, participant_id)
);

alter table public.questions enable row level security;
alter table public.questions force row level security;
alter table public.question_votes enable row level security;
alter table public.question_votes force row level security;
revoke all on public.questions, public.question_votes from anon, authenticated;
revoke all on sequence public.questions_id_seq from anon, authenticated;

-- 0009's rules plus Q&A: a question is tidied like a word (ends trimmed, runs
-- of spaces collapsed) but keeps its case, up to 280 characters.
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
		else
			return null;
	end case;
end;
$$;

create or replace function public.answer_limit(p_type text, p_settings jsonb) returns int
language sql immutable
set search_path = ''
return case p_type
	when 'poll' then 1
	when 'qna' then 5
	else coalesce((p_settings ->> 'answersPerPerson')::int, 3)
end;

-- Unchanged from 0009 except the last step: a Q&A answer becomes a question
-- instead of a tally.
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

	if v_item.type = 'qna' then
		insert into public.questions (run_id, item_id, text) values (v_run.id, v_item.id, v_key);
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

-- An upvote, or taking one back. It sets the vote rather than toggling it, so
-- a retried request lands the same and can never double count or undo itself.
-- The same rate limits as answers, and the same run and item checks.
create or replace function public.vote_question(
	p_code text,
	p_participant_id uuid,
	p_question_id bigint,
	p_up boolean,
	p_ip_hash text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	ip_limit constant int := 2000;
	run_limit constant int := 600;
	v_window timestamptz := date_bin('10 seconds', now(), timestamptz '2000-01-01 00:00:00+00');
	v_hits int;
	v_run public.runs;
	v_question public.questions;
	v_changed int;
	v_votes int;
begin
	if p_code is null or p_participant_id is null or p_question_id is null or p_up is null or coalesce(p_ip_hash, '') = '' then
		return jsonb_build_object('status', 'invalid');
	end if;

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

	insert into public.rate_limits as r (key, window_start, count)
	values ('run:' || v_run.id, v_window, 1)
	on conflict (key, window_start) do update set count = r.count + 1
	returning r.count into v_hits;
	if v_hits > run_limit then
		return jsonb_build_object('status', 'rate_limited');
	end if;

	if v_run.status = 'frozen' then
		return jsonb_build_object('status', 'frozen');
	end if;
	if v_run.status <> 'live' or v_run.item_state <> 'open' then
		return jsonb_build_object('status', 'closed');
	end if;

	-- Only a question on the item being shown now, and still in the main list.
	select q.* into v_question
	from public.questions q
	join public.deck_items i on i.id = q.item_id
	where q.id = p_question_id and q.run_id = v_run.id and i.position = v_run.current_position;
	if not found or v_question.hidden or v_question.answered then
		return jsonb_build_object('status', 'closed');
	end if;

	if p_up then
		insert into public.question_votes (question_id, participant_id) values (p_question_id, p_participant_id)
		on conflict do nothing;
	else
		delete from public.question_votes where question_id = p_question_id and participant_id = p_participant_id;
	end if;
	get diagnostics v_changed = row_count;

	-- The count moves only when the vote itself changed.
	if v_changed > 0 then
		update public.questions set votes = votes + case when p_up then 1 else -1 end
		where id = p_question_id
		returning votes into v_votes;
		update public.runs set version = version + 1, last_activity_at = now() where id = v_run.id;
	else
		v_votes := v_question.votes;
	end if;

	return jsonb_build_object('status', 'ok', 'voted', p_up, 'votes', v_votes);
end;
$$;

-- 0003's state plus `questions`: a Q&A item's top 40 visible, unanswered
-- questions as [id, text, votes], most votes first, then oldest.
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
		'questions', case when i.type = 'qna' then coalesce((
			select jsonb_agg(jsonb_build_array(q.id, q.text, q.votes) order by q.votes desc, q.created_at, q.id)
			from (
				select id, text, votes, created_at from public.questions
				where run_id = r.id and item_id = i.id and not hidden and not answered
				order by votes desc, created_at, id
				limit 40
			) q
		), '[]'::jsonb) else '[]'::jsonb end,
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

-- 0006's host_action plus Q&A: on a Q&A item, hide and unhide take a
-- question's id as the key, and answer and unanswer move a question out of
-- the main list and back.
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
			-- A quiz opens through a scheduled start, which is out of scope (ADR-007).
			if v_status not in ('lobby', 'live')
				or v_item_state <> 'closed'
				or v_item.type is null
				or v_item.type not in ('word_cloud', 'poll', 'qna') then
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
			if v_item.type = 'qna' then
				if coalesce(p_key, '') !~ '^[0-9]{1,18}$' then
					return jsonb_build_object('status', 'invalid');
				end if;
				update public.questions set hidden = (p_action = 'hide')
				where id = p_key::bigint and run_id = v_run.id and item_id = v_item.id;
			else
				update public.tallies set hidden = (p_action = 'hide')
				where run_id = v_run.id and item_id = v_item.id and key = p_key;
			end if;
			if not found then
				return jsonb_build_object('status', 'invalid');
			end if;
			insert into public.moderation (run_id, item_id, key, action) values (v_run.id, v_item.id, p_key, p_action);
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

	return jsonb_build_object('status', 'ok', 'version', v_version);
end;
$$;

-- 0006's host view plus every question on a Q&A item, hidden and answered
-- ones included (so they can be undone), as [id, text, votes, hidden, answered].
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
		'questions', case when i.type = 'qna' then coalesce((
			select jsonb_agg(jsonb_build_array(q.id, q.text, q.votes, q.hidden, q.answered)
				order by q.answered, q.votes desc, q.created_at, q.id)
			from (
				select id, text, votes, hidden, answered, created_at from public.questions
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

-- 0007's export plus each Q&A item's questions as [text, votes, hidden, answered].
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

-- A session of 1 to 3 activities, in order, each typed by the host:
-- [{type, prompt, options?}]. Replaces the one-question test starters.
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
	if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 3 then
		return jsonb_build_object('status', 'invalid');
	end if;

	insert into public.decks (host_id, title) values (p_host_id, 'Session') returning id into v_deck;
	for v_item, v_position in select value, ordinality - 1 from jsonb_array_elements(p_items) with ordinality loop
		v_type := v_item ->> 'type';
		v_prompt := btrim(coalesce(v_item ->> 'prompt', ''));
		if char_length(v_prompt) not between 1 and 140 then
			raise exception 'invalid item' using errcode = 'VQ002';
		end if;
		case v_type
			when 'word_cloud', 'qna' then
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

revoke execute on function public.vote_question(text, uuid, bigint, boolean, text) from public, anon, authenticated;
revoke execute on function public.start_session(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.vote_question(text, uuid, bigint, boolean, text) to service_role;
grant execute on function public.start_session(uuid, jsonb) to service_role;

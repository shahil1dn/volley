-- Q&A on the projector, one question at a time (ADR-013). The host puts a
-- question on screen; the projector shows only that one and a count of those
-- waiting. Most votes first; moving on marks the question answered (done), so
-- phones drop what has been discussed. A question's turn is `shown_seq` (null
-- until it is first put up); `on_screen` marks the one on the projector now, at
-- most one per activity of a run.
alter table public.questions
	add column shown_seq int check (shown_seq > 0),
	add column on_screen boolean not null default false,
	add constraint questions_on_screen_was_shown check (not on_screen or shown_seq is not null);
create unique index questions_on_screen_idx on public.questions (run_id, item_id) where on_screen;
create unique index questions_shown_seq_idx on public.questions (run_id, item_id, shown_seq) where shown_seq is not null;

-- 0012's state plus `shown` ([id, text, votes] of the question on the
-- projector, null if none) and `waiting` (visible, unanswered, not on screen;
-- at most 101).
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

-- 0010's host view plus `shown` (the question on the projector) and each
-- question's turn as a sixth element.
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

-- 0010's host_action plus question_next and question_back, and hiding the
-- question on the projector takes it off.
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

revoke execute on function public.host_action(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.host_view(uuid, text) from public, anon, authenticated;
revoke execute on function public.get_state(text) from public, anon, authenticated;
grant execute on function public.host_action(uuid, text, text, text) to service_role;
grant execute on function public.host_view(uuid, text) to service_role;
grant execute on function public.get_state(text) to service_role;

-- A session now holds 1 to 10 activities (it held 1 to 3). Everything else in
-- start_session is exactly as 0010 left it. The app repeats the cap as
-- MAX_ACTIVITIES in src/lib/session-limits.ts; a test starts a session at 10
-- and at 11 to keep the two in step.
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

revoke execute on function public.start_session(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.start_session(uuid, jsonb) to service_role;

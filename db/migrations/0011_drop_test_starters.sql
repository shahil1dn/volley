-- The one-question test starters, replaced by start_session (0010). Kept until
-- a production deploy stopped calling them (dpl_GgbyG7z7MjnXkCZWHT98dcVgwNAZ,
-- 2026-09-30).
drop function public.start_test_run(uuid, text);
drop function public.start_test_poll(uuid, text, text[]);

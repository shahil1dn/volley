-- Word-cloud sessions. Safe to re-run: every statement is idempotent.

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9]{5}$'),
  question text not null check (char_length(question) between 1 and 140),
  -- sha256 of the host's secret, so a database leak does not hand out hosting rights
  host_token_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.words (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.sessions (id) on delete cascade,
  -- stored already lowercased and trimmed, so "AI" and "ai " count as one word
  text text not null check (char_length(text) between 1 and 25),
  hidden boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists words_session_id_idx on public.words (session_id);

-- Every write goes through the app's server with the secret key. The public
-- key can only read visible words, which is what live updates need.
alter table public.sessions enable row level security;
alter table public.words enable row level security;
revoke all on public.sessions, public.words from anon, authenticated;
grant select on public.words to anon;

drop policy if exists "anyone can read visible words" on public.words;
create policy "anyone can read visible words" on public.words
  for select to anon using (not hidden);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'words'
  ) then
    alter publication supabase_realtime add table public.words;
  end if;
end $$;

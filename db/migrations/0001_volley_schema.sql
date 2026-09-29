-- Volley's schema (docs/ARCHITECTURE.md §5). Replaces the word-cloud prototype's
-- tables, which held test data only.
drop table if exists public.words;
drop table if exists public.sessions;

-- Host content: kept until the host deletes it.

create table public.hosts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now()
);

create table public.decks (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references public.hosts (user_id) on delete cascade,
  title text not null check (char_length(title) between 1 and 140),
  updated_at timestamptz not null default now()
);
create index decks_host_id_updated_at_idx on public.decks (host_id, updated_at desc);

create table public.deck_items (
  id uuid primary key default gen_random_uuid(),
  deck_id uuid not null references public.decks (id) on delete cascade,
  position int not null check (position >= 0),
  type text not null check (type in ('word_cloud', 'poll', 'quiz')),
  settings jsonb not null default '{}',
  unique (deck_id, position)
);

-- Participant data: everything below `runs` is deleted with its run.

create table public.runs (
  id uuid primary key default gen_random_uuid(),
  deck_id uuid not null references public.decks (id) on delete cascade,
  -- No 0/O or 1/I, which get misread off a projector.
  code text not null unique check (code ~ '^[A-HJ-NP-Z2-9]{5}$'),
  status text not null default 'lobby' check (status in ('lobby', 'live', 'frozen', 'ended')),
  current_position int not null default 0,
  item_state text not null default 'closed' check (item_state in ('closed', 'scheduled', 'open', 'revealed')),
  opens_at timestamptz,
  closes_at timestamptz,
  version bigint not null default 0,
  last_activity_at timestamptz not null default now(),
  ended_at timestamptz
);
create index runs_deck_id_idx on public.runs (deck_id);
create index runs_ended_at_idx on public.runs (ended_at);
create index runs_last_activity_at_idx on public.runs (last_activity_at);

create table public.responses (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.runs (id) on delete cascade,
  item_id uuid not null references public.deck_items (id) on delete cascade,
  participant_id uuid not null,
  -- One per submit attempt, so a retried request is stored once.
  submit_id uuid not null,
  value text not null,
  received_at timestamptz not null default now(),
  unique (participant_id, submit_id)
);
create index responses_run_id_idx on public.responses (run_id);

-- Keyed by run as well as item: a deck shown twice must not share its counts.
create table public.tallies (
  run_id uuid not null references public.runs (id) on delete cascade,
  item_id uuid not null references public.deck_items (id) on delete cascade,
  key text not null,
  count int not null default 0 check (count >= 0),
  hidden boolean not null default false,
  primary key (run_id, item_id, key)
);
create index tallies_run_id_item_id_count_idx on public.tallies (run_id, item_id, count desc);

create table public.quotas (
  run_id uuid not null references public.runs (id) on delete cascade,
  item_id uuid not null references public.deck_items (id) on delete cascade,
  participant_id uuid not null,
  used int not null default 0 check (used >= 0),
  primary key (run_id, item_id, participant_id)
);

create table public.moderation (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.runs (id) on delete cascade,
  item_id uuid not null references public.deck_items (id) on delete cascade,
  key text not null,
  action text not null check (action in ('hide', 'unhide')),
  created_at timestamptz not null default now()
);
create index moderation_run_id_idx on public.moderation (run_id);

create table public.players (
  run_id uuid not null references public.runs (id) on delete cascade,
  participant_id uuid not null,
  nickname text not null check (char_length(nickname) between 1 and 24),
  score int not null default 0,
  primary key (run_id, participant_id)
);
create index players_run_id_score_idx on public.players (run_id, score desc);

-- Per-key request counters (key = hashed IP or run plus the action). Unlogged:
-- skips the write-ahead log, and losing it in a crash costs nothing.
create unlogged table public.rate_limits (
  key text not null,
  window_start timestamptz not null,
  count int not null default 0,
  primary key (key, window_start)
);

-- Nothing is reachable with the public key. Every read and write goes through
-- the server with the secret key; later slices add functions, never policies.
alter table public.hosts enable row level security;
alter table public.hosts force row level security;
alter table public.decks enable row level security;
alter table public.decks force row level security;
alter table public.deck_items enable row level security;
alter table public.deck_items force row level security;
alter table public.runs enable row level security;
alter table public.runs force row level security;
alter table public.responses enable row level security;
alter table public.responses force row level security;
alter table public.tallies enable row level security;
alter table public.tallies force row level security;
alter table public.quotas enable row level security;
alter table public.quotas force row level security;
alter table public.moderation enable row level security;
alter table public.moderation force row level security;
alter table public.players enable row level security;
alter table public.players force row level security;
alter table public.rate_limits enable row level security;
alter table public.rate_limits force row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

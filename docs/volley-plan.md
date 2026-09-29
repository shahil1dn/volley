# Volley build plan

From `SPEC.md` (acceptance checks A1–A17) and `docs/ARCHITECTURE.md`. Four
milestones. Only Milestone 1 is sliced in detail; the rest are sliced when
Milestone 1 lands, because what it proves may change them.

Each slice leaves the app working and ends with its proof. Tick a slice with
the commit and the command output that proved it.

**How the database is tested.** Database tests run against the London dev
database, each inside a transaction that is rolled back, using Node's test
runner and `pg`. No second database is needed.

## Milestone 1: one word cloud, end to end, hardened

The riskiest assumption goes first: that Vercel's edge cache absorbs the
polling. If it does not, the delivery design changes and every later slice with it.

- [x] **S0. SvelteKit skeleton replaces Next.js.** Rename the folder to `volley`.
  SvelteKit + TypeScript + Vercel adapter pinned to `lhr1`. Remove the Next.js
  app; keep `db/`, `scripts/migrate.mjs`, `tests/`.
  *verify:* `npm run build` and `npm test` pass with exit codes intact; the
  existing 5 unit tests still pass.
  *done:* `1a357bf`. `npm run build` EXIT=0 (function config: `lhr1`,
  `nodejs24.x`); `npm run check` EXIT=0, 0 errors, 0 warnings; `npm test`
  EXIT=0, 5 pass, 0 fail; dev server serves `/` and `/fonts/*` with no
  console errors. Folder not renamed yet (see below).

- [x] **S1. Prove the edge cache (riskiest).** A `GET /api/r/[code]/state` route
  returning a real row from the database with `s-maxage=1,
  stale-while-revalidate=1`, deployed as a protected preview in `lhr1`. A script
  runs 200 simulated clients polling every second for 2 minutes.
  *verify:* the function's call count from Vercel logs stays under 2 a second
  (must-verify 1), and the response headers show whether `Age` is present
  (must-verify 2).
  *needs owner OK:* a deployment-protection bypass secret so the load script can
  reach the protected preview.
  *result 2026-09-29: FAILED, left unticked for an owner decision.* Run with
  `node --env-file=.env.local scripts/load/poll.mjs <url> 200 120`; summary in
  `scripts/load/last-run.json`. 23,645 requests: 23,644 × 200 plus 1 connect
  timeout, all served at the `lhr1` edge. `x-vercel-cache`: HIT 12,596,
  STALE 7,993, MISS 3,055. **Function calls from the runtime logs: 3,394 in
  120s, about 28 a second** (per second: median 31, max 44), against a pass
  line of under 2. `Age` was present on every response (values 0 or 1), which
  answers must-verify 2. Latency p50 75 ms, p95 488 ms, measured from one
  laptop running all 200 clients. The cache absorbs about 86% of polls, not
  the ~99% ADR-003 assumed.
  *re-test 2026-09-29, `stale-while-revalidate=60`, clients start at random
  points in the first interval: still FAILED, left unticked.* Summaries in
  `scripts/load/run-A.json` and `run-B.json`. Function calls come from a log
  stream running during both runs; its last line is 0.08s after run B ended.

  | Run | Poll every | Requests | HIT / STALE / MISS | Function calls | Calls/s avg, median, max | p50 / p95 |
  | --- | --- | --- | --- | --- | --- | --- |
  | Original (SWR 1s) | 1s | 23,645 | 12,596 / 7,993 / 3,055 | 3,394 | 28.3, 31, 44 | 75 / 488 ms |
  | A (SWR 60s) | 1s | 24,000 | 11,102 / 12,845 / 52 | 1,055 | 8.8, 10, 13 | 86 / 180 ms |
  | B (SWR 60s) | 3s | 8,000 | 4,399 / 3,563 / 38 | 832 | 6.9, 8, 35 | 81 / 164 ms |

  A longer stale window almost removes MISSes, but background refreshes still
  reach the function 7–9 times a second. Cutting traffic by two-thirds (A to B)
  cut calls by only a fifth. Vercel's request-collapsing docs list only ISR and
  Image Optimization as supported, not function responses cached with
  `Cache-Control`. That fits the refreshes not being merged, but no run here
  isolates the cause.
  *done:* the owner accepted the measured cost as a budget, **ADR-004** (at most
  about 10 calls/s at 200 phones polling every 3s). Measured runs in `8daf4c5`.

- [x] **S2. The real schema.** Migration for `hosts`, `decks`, `deck_items`,
  `runs`, `responses`, `tallies`, `quotas`, `moderation`, `players`, unlogged
  `rate_limits`; indexes from ARCHITECTURE §10; RLS enabled and forced
  everywhere; every privilege revoked from the public roles.
  *verify:* the permission probe (A4) fails on the old schema and passes on the
  new one.
  *done:* `db/migrations/0001_volley_schema.sql`, applied by
  `scripts/migrate.mjs`, which records each file in `schema_migrations`.
  Receipts: on the old schema, `npm test` EXIT=1, 5 of 5 database tests red for
  the right reasons (tables missing; RLS not forced on `sessions`; `anon` could
  read `words` and use `words_id_seq`; the publishable key read `words` over
  the API, HTTP 200). Migrate run 1 EXIT=0, "Applied 0001_volley_schema.sql";
  run 2 EXIT=0, "Up to date: no migrations to apply". Then `npm run build`
  EXIT=0, `npm run check` EXIT=0 (0 errors, 0 warnings), `npm test` EXIT=0, 10
  pass, 0 fail. The API refuses with 401 `42501` "permission denied", not 404.
  The state route now reads `runs`: an unknown code returns 404 through the
  secret key. The success path is untested until a run can exist (needs a host
  and a deck).
  Changed from the original ARCHITECTURE §5 (now updated to match): `tallies`
  and `quotas` are keyed by `run_id` as well, because a deck shown twice would otherwise share its
  counts. `item_id` columns reference `deck_items`, and `runs(deck_id)`,
  `responses(run_id)` and `moderation(run_id)` are indexed so cascading
  deletes use an index.

- [x] **S3. `submit_answer` for the word cloud.** One transaction: rate limit, run
  and item open, duplicate submit id, quota by conditional upsert, tally,
  `version`.
  *verify:* database tests A1 (4th word refused; 10 concurrent submits store
  exactly 3) and A3 (same submit id stored once), written first and seen red.
  *done:* `db/migrations/0002_submit_answer.sql`, tested in
  `tests/db-submit-answer.test.ts`. Receipts: before the migration, `npm test`
  EXIT=1, all 11 new tests red ("function public.submit_answer(...) does not
  exist"). Migrate run 1 EXIT=0 "Applied 0002_submit_answer.sql"; run 2 EXIT=0
  "Up to date". The first run after that caught a real mismatch: `words.ts`
  counted an emoji as 2 characters, so 13 emoji were refused on the phone but
  accepted by the database. Fixed, and pinned by a unit test. Then `npm test`
  EXIT=0, 22 pass, 0 fail; `npm run check` EXIT=0; `npm run build` EXIT=0.
  Mutation check, each restored after: removing the quota guard turned 5 tests
  red, including both A1s; removing the early repeat check turned red "a
  retried submit is still answered ok after the item closes"; un-hiding on
  submit turned the hidden-word test red; ignoring the IP limit turned the
  rate-limit test red. The state route returns 200
  `{code, status: "live", serverNow}` with the cache header for a real run.
  Decisions: the word is cleaned up in SQL (it can't be bypassed, and the stored
  word always equals its tally key); a repeat answers `ok` with the current
  answers-left, not a separate `duplicate` (SPEC 12, A3), and is checked before
  the open/closed rules; a full quota rolls back the response and quota but
  keeps the rate count; a hidden word still counts but stays hidden; limits are
  300 per 10s per IP and 600 per 10s per run.

- [x] **S4. `get_state` behind the cached route.** Returns version, current item
  without secrets, top 100 visible tallies, `serverNow`.
  *verify:* `EXPLAIN` on its queries shows index scans only (A11); a test proves
  a hidden tally is absent.
  *done:* `db/migrations/0003_get_state.sql`, tested in
  `tests/db-get-state.test.ts`. Receipts: before the migration, 8 of 8 new tests
  red ("function public.get_state(unknown) does not exist"). Migrate run 1
  EXIT=0 "Applied 0003_get_state.sql", run 2 EXIT=0 "Up to date". Then
  `npm test` EXIT=0, 30 pass, 0 fail; `npm run check` EXIT=0; `npm run build`
  EXIT=0. Mutation check, each restored after: no hidden filter, sort by key
  only, cap raised to 1000, secrets not stripped, secrets stripped at top level
  only, no index on `runs.code`, and `anon` allowed to call it. All 7 turned
  their tests red. The route returned a real run as 306 bytes, with no
  `correct` and no hidden word.
  A11 method: it checks what `get_state` actually ran, not `EXPLAIN` on a copy
  of its SQL. Inside a rolled-back transaction it seeds 2,000 runs, 300 deck
  items, 6,000 tallies and 4,000 players, runs `ANALYZE`, calls `get_state` on
  a fresh connection, and reads `pg_stat_xact_user_tables`: no sequential scan
  on `runs`, `deck_items`, `tallies` or `players`, and at least one index scan
  on each. S2's `tallies` index is replaced by a partial index on visible
  words, in the order the state sends them, so the top 100 needs no sort.
  Secrets: settings keys named `correct` are removed at any depth until the
  item is revealed; the quiz adds names to that list in Milestone 2.

- [x] **S5. A phone can join and answer.** Signed participant token in a cookie
  scoped to the answer route; `/j/[code]` polls state; retry-safe submit with a
  one-time id; answers-left kept on the phone.
  *verify:* browser test: 3 phones join and answer; a forced retry of one submit
  does not change the count.
  *done:* `src/routes/j/[code]/+page.svelte`, `src/routes/api/r/[code]/answer/+server.ts`,
  `src/lib/server/participant-token.ts`; browser test `tests/e2e/phone.spec.ts`
  (`npm run test:e2e`). Receipts: `npm test` EXIT=0, 37 pass, 0 fail;
  `npm run check` EXIT=0; `npm run build` EXIT=0; `npm run test:e2e` EXIT=0,
  5 passed: 3 phones answer and are held to 3 each; a phone waits, then sees the
  question open; a lost reply is retried with the same submit id and stored once
  (the dropped attempt is shown to have reached the server with a 200); a phone
  with a clock an hour fast still gets the server's time; an unknown room gets a
  friendly page. Mutation checks: a new submit id per retry turns the retry test
  red; unbinding the token from the room, skipping the signature check, an IP
  hash without the secret, and showing older states each turn a unit test red.
  Test rooms were deleted afterwards (checked: 0 users, runs, tallies, rate rows).
  Screens at 375×812 are in `screenshots/s5/` (git-ignored).
  How joining works: the page calls `GET /api/r/{code}/answer`, which sets the
  signed participant cookie only if the phone doesn't already have one. A cookie
  scoped to the answer route is invisible to the page, so setting it on the page
  load would issue a new participant, and a fresh 3 answers, on every reload.
  Answer replies: 200 ok, 422 invalid, 409 limit/closed/frozen, 429
  rate-limited, 400/415 bad request, 401 not joined (the phone joins and retries
  once); network errors and 5xx are retried with the same submit id after 1s and
  2.5s. The IP is hashed with HMAC under `PARTICIPANT_SECRET`, not bare SHA-256.

- [x] **S6. Host sign-in.** `npm run add-host <email>` creates the account;
  password sign-in with an `httpOnly` cookie session; every host route guarded.
  Check the current Supabase + SvelteKit auth guide first (must-verify 3).
  *verify:* A6 (403 without a host session, or as a non-host), A7
  (`document.cookie` does not contain the session).
  *done:* ADR-005 (our own signed httpOnly session; `@supabase/ssr` rejected
  because its cookies default to non-httpOnly). `scripts/add-host.mjs`,
  `src/hooks.server.ts`, `src/lib/server/host-guard.ts`,
  `src/lib/server/host-session.ts`, `db/migrations/0005_sign_in_limits.sql`.
  Receipts: migrate run 1 EXIT=0 "Applied 0004_campus_ip_limit.sql, Applied
  0005_sign_in_limits.sql"; run 2 EXIT=0 "Up to date"; `npm test` EXIT=0, 45
  pass; `npm run test:e2e` EXIT=0, 11 passed; `npm run check` EXIT=0; `npm run
  build` EXIT=0. Browser tests: add-host creates a host and a second run resets
  the password (the old one then fails); sign in, see `/decks`, sign out;
  `document.cookie` lacks the session, which is httpOnly, Lax, Path=/ and ~12h
  (A7); a confirmed non-host can't sign in, and a valid session for it gets 403
  on `/decks` and on host APIs (A6); no session: pages redirect to `/`, APIs 401;
  the 11th attempt for one email is refused. Mutation check: letting non-hosts
  through, a non-httpOnly cookie, skipping the sign-in limit and ignoring expiry
  each turned a test red. Test accounts were deleted (checked: 0 left).
  A6 as built: signed out, pages redirect to sign-in and APIs answer 401; not a
  host, 403. SPEC A6 is updated to match.
  Also in this slice, **migration 0004 raises the per-IP answer cap from 300 to
  2,000 per 10s**: a 200-person room on one campus IP sends ~600 answers at
  once. Test written first: 600 answers from 200 participants on one IP in one
  window, only 300 accepted before the change, all 600 after.

- [ ] **S7. Projector and host control for a word cloud.** Start a run from a
  hard-coded one-item deck; projector at `/run/[code]` polls every second and fits
  the cloud to the screen (ported from the prototype); control view opens,
  closes, hides, freezes and ends.
  *verify:* A8 browser test (result on the projector within 3s; hide removes it
  within 3s); screenshot of the projector at 1280×720 with 120 words.
  *paused 2026-09-29, in progress on local branch `s7-host-control`
  (`feaab25`), not on main.* Written and checked locally (`npm run check`
  EXIT=0, `npm run build` EXIT=0, unit tests 16/16): migration
  `0006_host_control.sql` (`start_test_run`, a single `host_action` dispatcher
  for open/close/reveal/next/back/freeze/unfreeze/end/hide/unhide, `host_view`);
  `GET`/`POST /api/r/[code]/host`; "Start a test run" on `/decks`; the projector
  `/run/[code]` (public: it shows only the shared state, and guarding it would
  mean typing a password on shared PCs) and the guarded control view
  `/run/[code]/control`; DB tests; the A8 and projector-fit browser tests; and
  `scripts/load/burst.mjs`. **Nothing has touched the database yet.** To finish:
  (1) with the owner's OK, run `tests/db-host-control.test.ts` red, then apply
  0006 and migrate twice; (2) restart the dev server so it loads
  `HOST_SESSION_SECRET`; (3) `npm test` and `npm run test:e2e` (throwaway host
  and rooms, deleted after), including the fit screenshots in `screenshots/s7/`;
  (4) dry-run `burst.mjs` with 50 phones against the local dev server; (5)
  merge to main, tick. The branch's DB and browser tests fail until 0006 is
  applied; that's the intended red step.

- [ ] **S8. Retention and export.** Hourly `pg_cron` job; CSV and PNG export
  before deletion.
  *verify:* A12 (a run ended 25 hours ago is gone with everything under it, one
  ended 23 hours ago is not, the deck survives); the downloaded CSV matches the
  tallies.

## Going live: just before the first real workshop

Moved out of Milestone 1 on 2026-09-29. Vercel calls cron jobs on "your
project's production deployment URL" (Vercel cron docs), and the owner doesn't
want a public production app yet. So the keep-alive can't run until going
live, which must happen before the first real workshop anyway.

- [ ] **Keep-alive** (was S2b). Supabase free projects
  pause after 7 days without activity, and workshops are fortnightly. The repo
  isn't on GitHub, so the keep-alive is a Vercel Cron Job in `vercel.json`
  calling a route that runs one tiny query, secured with `CRON_SECRET` (Vercel
  sends it as `Authorization: Bearer <secret>`). Hobby limits (Vercel cron docs,
  checked 2026-09-29): at most once a day, fired anywhere within the scheduled
  hour, no retries, delivery best effort. Daily is well inside 7 days.
  Check before building: cron jobs don't follow redirects, and this project's
  production addresses currently redirect to Vercel's login (deployment
  protection). Confirm the cron call reaches the function on the hidden
  production deploy.
  *verify:* the route refuses a call without the secret; after deploying, the
  cron's run shows in the logs with a 200.

## Milestone 2: poll and quiz, then the shared template

- Poll activity (one vote per participant, live bars).
- Quiz: scheduled start, server-clock countdown, refusal outside the window,
  speed bands, nicknames, leaderboard, reveal. Proves A2 and A9.
  **Nicknames (owner decision, 2026-09-29):** asked only when the run contains a
  quiz, and then required ("nickname or first name", not a full name). Shown on
  the projector leaderboard. The host can remove a nickname from the control
  view, like hiding a word. A duplicate gets a number added ("Sam 2"). Deleted
  with the run after 24 hours. The `players.nickname` check allows 1–24
  characters: SPEC's 20, plus room for " 12".
- Extract `defineActivity` from the three activities; `npm run new-activity`.
  Proves A5.

## Milestone 3: decks

- Deck list and deck editor with forms generated from each activity's settings
  schema. Replaces the hard-coded deck from S7.

## Milestone 4: ready for strangers

- Settings for name, colours and logo; remove AI Builders from `src/` (A16).
- `npm run setup` and `npm run doctor` (A14).
- `AGENTS.md`; Deploy button with the `stores` parameter (must-verify 4).
- Full load test: 200 phones for 10 minutes, measured numbers replace the
  estimates in ARCHITECTURE §10 (A10).
- Supabase Security Advisor clean (A13).
- One gate command: build, typecheck, all tests, exit code intact (A17).
- A fresh AI agent sets up a copy from `AGENTS.md` alone (A15).

## Found along the way

(New tasks discovered while building go here.)

- **Folder rename to `volley` still to do.** It was left out of S0 because the
  build ran from inside the folder. Rename it between sessions, then re-link
  anything that points at the old path.
- **Vercel project's framework preset: done in S1** through `vercel.json`
  (below). Renaming the project from `aib-live` is still open.
- **Adapter runtime pinned to `nodejs24.x`.** The Vercel adapter otherwise
  copies the build machine's Node and refuses anything but 20, 22 or 24, so it
  failed on a Node 25 laptop. The docs mark `runtime` as deprecated in favour of
  the dashboard's Node setting. When it is removed, set Node 24 on the
  dashboard and add an `engines` field instead.
- **TypeScript held at 5.9.** The latest release is 7.0, but SvelteKit 2.70.3
  supports only `^5.3.3 || ^6.0.0`.
- **`npm run typecheck` replaced by `npm run check`** (svelte-check). Plain
  `tsc` cannot read `.svelte` files.
- **esbuild's install script was not run.** npm's `allowScripts` list does not
  include it. The build works without it (the prebuilt binary package installs
  normally), but `npm install-scripts ls` will keep flagging it.
- **A project's first deploy is always production**, even with
  `--target=preview` (Vercel CLI docs, `vercel deploy` → Prod). Two
  accidental public deploys to `aib-live.vercel.app` were removed. The project
  now has one production deploy made with `--prod --skip-domain`: it is not on
  `aib-live.vercel.app` (still 404), and its own addresses need the bypass.
  From now on, plain `vercel deploy` makes previews.
- **Framework preset set in the repo**: `vercel.json` has
  `"framework": "sveltekit-1"`, which overrides the dashboard's Next.js preset.
  Plain `"sveltekit"` is the legacy v0 preset.
- **Hobby keeps runtime logs for 1 hour.** Count function calls straight after
  a load run, or stream them during it (`vercel logs <url> --json`).
- **Hobby allowances** (Vercel fair-use guidelines, checked 2026-09-29): 1M
  function calls, 100 GB data transfer, 4 hours of active CPU a month. No
  request-count allowance is listed, so cache hits cost only data transfer.
- **The log stream stops after 5 minutes** ("Exceeded query duration limit of 5
  minutes"). Keep a counted run inside that, or restart the stream between runs.
- **Later optimisation: ISR for the state route** (ADR-004). Vercel's docs say
  request collapsing, including for stale refreshes, is supported for ISR, and
  adapter-vercel has an `isr` route option. Unverified whether it works on a
  `+server.ts` GET with a 1-second expiry. Worth trying only if the budget gets
  tight.
- **`pg_cron` is not enabled** on the London database (checked 2026-09-29, S2).
  S8's hourly clean-up needs it switched on first.
- **The database A4 test takes about 33s**: every table × 2 roles × 5
  statements, each a round trip to London. Fine for now; batch the probes if
  the suite gets slow.
- **`rate_limits` only grows**: one row per IP and per run every 10 seconds of
  activity. S8's hourly clean-up should also delete windows older than an hour.
- **Each accepted answer updates its run's row** (`version`), so answers to one
  run are written one at a time. Fine at ADR-002's ~2 writes/s; a bottleneck at
  hundreds a second.
- **`npm test` takes over a minute** (the database A4 test ~35s, plus the
  submit tests). Fine for now; batch the A4 probes if it gets in the way.
- **`STATE_FN_CALL` log line removed in S4.** ADR-004 settled the delivery
  design it was measuring. A10's load test will need another way to count calls
  (Vercel's function metrics, or add the line back for the run).
- **A cached state can be a few seconds old**, so `serverNow` is too. Clients
  should add the response's `Age` header (always present, S1) to `serverNow`
  before timing a quiz countdown, and ignore any state whose `version` is lower
  than one they've already shown. Matters for S5 and the quiz.
- **Design is deferred (owner, 2026-09-29).** Order: a working MVP, then the
  open-source template with a generic default theme, then the AI Builders
  version. The society look in `src/app.css` is a placeholder. S5's vibe audit
  found two things, left for the theming work: (1) the column is vertically
  centred, so the label and question jump about 110px between states; pin it
  near the top. (2) After sending, a faded Send button outweighs what you sent;
  show "your words" as a clear line under the question.
- **`PARTICIPANT_SECRET` must be added to Vercel before the next deploy.** It is
  read through `$env/static/private`, so a build without it fails. It's only in
  `.env.local` so far; adding it to Vercel needs the owner's OK.
- **Playwright's browser (Chrome for Testing 153, ~550 MB) is in
  `~/Library/Caches/ms-playwright`.** Installing it removed two older cached
  builds (`chromium_headless_shell-1228`, `webkit-2272`), which Playwright does
  for builds it considers unused.
- **Owner action: turn off public sign-up in Supabase.** The public settings
  endpoint (`GET /auth/v1/settings` with the publishable key, no management
  token needed) shows `disable_signup: false`: anyone can create a Supabase
  account (email confirmation is required). The guard makes such an account
  useless (tested), but switch it off: Supabase dashboard → the project →
  Authentication → Sign In / Providers → turn off "Allow new users to sign up"
  → Save (label as best known; not confirmed in the docs). For M4's
  `npm run doctor`: fail if that endpoint reports `disable_signup: false`.
- **`HOST_SESSION_SECRET` joins `PARTICIPANT_SECRET` as a deploy blocker.** Both
  are read through `$env/static/private`, so a Vercel build fails until both are
  added there. **Status 2026-09-29: NOT added yet.** The owner approved adding
  both to the Preview environment of Vercel project `aib-live`, but the CLI
  attempts (from the other session) returned `git_branch_required` and changed
  nothing. Retry next session, probably with an explicit Git branch or via the
  dashboard, and generate fresh values per environment rather than copying the
  laptop's.
- **Test files run one at a time** (`--test-concurrency=1`). Supabase's
  connection pooler (session mode) allows 15 clients, not the database's 60;
  test files running in parallel alongside the 10-phone test went over it.
- **Page start-up wiped typed text.** An input with `value={...}` is reset when
  the page finishes loading, so an email typed on a slow connection before then
  was lost (reproduced on a cold dev server). The sign-in form uses
  `defaultValue`. Use `defaultValue` or `bind:value` for any pre-filled input.
- **The per-run answer cap is now the tighter one**: 600 per 10s is exactly 200
  people × 3 words. A bigger room answering all at once would see some
  "Lots of answers are arriving" messages; the phone keeps the answer to resend.
- **`ANALYZE` after a rolled-back seed**: the A11 test re-runs `ANALYZE` after
  its rollback, because Postgres's row estimates survive a rollback.

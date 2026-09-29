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

- [ ] **S1. Prove the edge cache (riskiest).** A `GET /api/r/[code]/state` route
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

- [ ] **S2. The real schema.** Migration for `hosts`, `decks`, `deck_items`,
  `runs`, `responses`, `tallies`, `quotas`, `moderation`, `players`, unlogged
  `rate_limits`; indexes from ARCHITECTURE §10; RLS enabled and forced
  everywhere; every privilege revoked from the public roles.
  *verify:* the permission probe (A4) fails on the old schema and passes on the
  new one.

- [ ] **S3. `submit_answer` for the word cloud.** One transaction: rate limit, run
  and item open, duplicate submit id, quota by conditional upsert, tally,
  `version`.
  *verify:* database tests A1 (4th word refused; 10 concurrent submits store
  exactly 3) and A3 (same submit id stored once), written first and seen red.

- [ ] **S4. `get_state` behind the cached route.** Returns version, current item
  without secrets, top 100 visible tallies, `serverNow`.
  *verify:* `EXPLAIN` on its queries shows index scans only (A11); a test proves
  a hidden tally is absent.

- [ ] **S5. A phone can join and answer.** Signed participant token in a cookie
  scoped to the answer route; `/j/[code]` polls state; retry-safe submit with a
  one-time id; answers-left kept on the phone.
  *verify:* browser test: 3 phones join and answer; a forced retry of one submit
  does not change the count.

- [ ] **S6. Host sign-in.** `npm run add-host <email>` creates the account;
  password sign-in with an `httpOnly` cookie session; every host route guarded.
  Check the current Supabase + SvelteKit auth guide first (must-verify 3).
  *verify:* A6 (403 without a host session, or as a non-host), A7
  (`document.cookie` does not contain the session).

- [ ] **S7. Projector and host control for a word cloud.** Start a run from a
  hard-coded one-item deck; projector at `/run/[code]` polls every second and fits
  the cloud to the screen (ported from the prototype); control view opens,
  closes, hides, freezes and ends.
  *verify:* A8 browser test (result on the projector within 3s; hide removes it
  within 3s); screenshot of the projector at 1280×720 with 120 words.

- [ ] **S8. Retention and export.** Hourly `pg_cron` job; CSV and PNG export
  before deletion.
  *verify:* A12 (a run ended 25 hours ago is gone with everything under it, one
  ended 23 hours ago is not, the deck survives); the downloaded CSV matches the
  tallies.

## Milestone 2: poll and quiz, then the shared template

- Poll activity (one vote per participant, live bars).
- Quiz: scheduled start, server-clock countdown, refusal outside the window,
  speed bands, nicknames, leaderboard, reveal. Proves A2 and A9.
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
- **Vercel project needs its framework preset changed.** The linked project
  (`aib-live`) was created for Next.js. Switch the preset to SvelteKit (and
  consider renaming the project) before the first deploy in S1.
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
- **The state route logs `STATE_FN_CALL` on every call.** It's there so load
  runs can be counted. Remove it once the delivery design is settled.

# Handoff (2026-09-30, end of day)

A pointer to now, not a log. Reasons live in `docs/DECISIONS.md`, scope in
`SPEC.md`, design in `docs/ARCHITECTURE.md`, progress in `docs/volley-plan.md`.
`git log --oneline` shows the trail. Nothing is pushed; there is no GitHub
remote yet.

## How this project is run

- **Two sessions.** An orchestrator session talks to Shahil in plain English and
  briefs a build session opened in this folder
  (`~/Documents/projects/menti-pilot`). Each brief ends with: send results back
  to the orchestrator session by title, using
  `mcp__ccd_session_mgmt__send_message` (`SendMessage` does not cross sessions).
- **Every claim is checked.** The orchestrator re-runs the receipts below before
  telling Shahil.
- **Approvals happen in the session that acts.** Production database writes,
  deploys, Vercel or Supabase settings and account actions need Shahil's OK,
  asked there. An approval never travels between sessions.
- **Standing direction from Shahil: MVP first.** No visual polish; accessibility
  and breakage still get fixed.

## 1. Where things stand

- **v1 is live at https://aib-live.vercel.app**: word cloud, poll and Q&A
  (ADR-008), sessions of up to 3 activities under one room code (`/decks`), and
  `/join` for typing a code. Production deploy
  `dpl_GgbyG7z7MjnXkCZWHT98dcVgwNAZ`, built from `0995704`; later commits are
  migration 0011, its tests and docs.
- **Shahil's dry run on the live site passed** on 2026-09-30 ("all worked!").
  He has a host login (created with `scripts/add-host.mjs` in his own terminal;
  the password never entered a transcript).
- **Two Supabase projects, both London** (ADR-010): production `aib-live-db`
  (ref `qeheedlsskaurqshmueb`), connected to Vercel's **Production** only; test
  `volley-test-db` (ref `gzwzfjukswcifikbsufm`), connected to **Preview and
  Development**. `.env.local` holds only the test project. Both databases are
  at the same migration; `node --env-file=.env.local scripts/migrate.mjs`
  prints "Up to date" for the test one.
- **Rules in force:** any write to production needs Shahil's OK (ADR-010).
  `npm test`, the browser tests and `migrate` refuse production
  (`scripts/production-guard.ts`); `migrate --production` is the deliberate way
  in.
- **Hourly purge** (`pg_cron`, `volley-purge-expired`) runs on both databases.
  **Daily keep-alive** (Vercel Cron, `0 9 * * *`) is registered to the
  production deployment.
- **MIT licence**, copyright Shahil Rahman (ADR-009).
- **Receipts**, all against the test project: `npm test`, `npm run test:e2e`,
  `npm run check`, `npm run build`. Redirect each to a file and capture `$?`.

## 2. What is open

- **The first keep-alive cron run is unchecked.** It was due 09:00–09:59 UTC on
  2026-09-30. See §3.
- **The cold-pooler retry hasn't been seen working live.** After a few idle
  minutes the pooler took 3.3s to accept its first connection, over the pool's
  3s limit. `src/lib/server/cold-connect.ts` retries that one error once. It is
  proven by unit and mutation tests only; the live cold case didn't recur when
  tried.
- **The A11 index test for the purge may be flaky.** Once in four runs it
  stayed green with the `rate_limits(window_start)` index dropped; the other
  three went red. The cause was not found (`tests/db-retention.test.ts`).
- **The folder rename to `volley`.** It can only happen between sessions, then
  `vercel link` again. Now step 5 of Milestone 4.
- **The diagrams artifact** (https://claude.ai/artifact/73x7gxAHiXBawJLvJcK4gj)
  is stale (it predates ADR-004 onwards). Republish it from
  `docs/ARCHITECTURE.md`. It is private to Shahil.
- **The pooler logs in as `postgres`**, which bypasses row-level security. A
  least-privilege database role is a follow-up (ADR-006).

## 3. Exact next pickup point

1. **Check the keep-alive run.** In the Vercel dashboard: project `aib-live` →
   Logs, filtered to path `/api/cron/keep-alive`. Expect one request with a 200
   during 09:00–09:59 UTC. Hobby keeps logs for about an hour, so if that
   window has passed with no record, watch the next day's run instead.
   Without the secret, the route answers 401 (as smoke-tested); a 401 from the
   cron itself would mean `CRON_SECRET` is wrong in Production.
2. **Shahil picks the next slice** (`docs/volley-plan.md`, "Next: the owner
   picks one"):
   - **(a) Invite a host:** an admin-only page, so committee members and
     workshop leads get their own logins without the terminal and the pasted
     production settings. Each host already sees only their own runs.
   - **(b) Milestone 4, in order:** generic theme and settings → `setup` +
     `doctor` (removing today's snags) → `AGENTS.md` and a fresh-agent dry run →
     a 10-minute, 200-phone load test and the Security Advisor → the rename and
     a public GitHub repository (needs his OK).

## 4. What will bite

- **Production's Vercel settings are write-only** (type `sensitive`, since the
  store was reconnected). Any production write needs Shahil to paste
  `aib-live-db`'s `.env.local` snippet (Vercel → Storage → `aib-live-db` →
  `.env.local` tab → Show secret) into `.env.production.local`, which is git-
  and deploy-ignored. Delete it straight afterwards and check it's gone. The
  snippet has `PUBLIC_SUPABASE_URL` but not `SUPABASE_URL`; `add-host` needs the
  latter, with the same value.
- **`add-host` bypasses the test guard**, by design: it's how production hosts
  are made. Point it at the right file.
- **The test store names its public settings `NEXT_PUBLIC_…`.**
  `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_PUBLISHABLE_KEY` were added by hand
  to Preview and Development; if the test store's keys rotate, update them.
- **The test project allows public sign-up** (Supabase's default); production
  has it off. Nothing deployed uses the test project's keys.
- **Hobby runtime logs last about an hour**, and the log stream stops at 5
  minutes. Check a cron or count calls during the window, not after.
- **Test commands never pipe a verdict into `tail`.** Redirect to a file and
  capture `$?`. The Stop hook blocks claims made without a command run in the
  same turn.
- **`npm test` runs its files one at a time** (the session pooler allows 15
  clients) and takes over a minute.
- **Vercel CLI is v53.** `vercel env add … preview` fails non-interactively
  (`git_branch_required`); env vars go through the REST API with the CLI's own
  token. Store connections can't be edited in place: the dashboard offers only
  Disconnect and Connect Project. Upgrading the CLI needs Shahil's OK.
- **Previews are protected** (Vercel Authentication, previews only). Load
  scripts need `VERCEL_AUTOMATION_BYPASS_SECRET` from `.env.local`; previews
  now write to the test project.
- **Scripts use `rejectUnauthorized:false`**; the app itself verifies the
  pinned CA.
- **Remote Control is on.** Shahil may follow from his phone. Once, a command
  written next to a question box wasn't seen; put anything he must read or copy
  inside the question itself.

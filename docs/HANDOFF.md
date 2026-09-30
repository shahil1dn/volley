# Handoff (2026-09-30)

A pointer to now, not a log. Reasons live in `docs/DECISIONS.md`, scope in
`SPEC.md`, design in `docs/ARCHITECTURE.md`, progress in `docs/volley-plan.md`.

## How this project is run

- **Two sessions.** An orchestrator session talks to Shahil in plain English and
  briefs a build session opened in this folder
  (`~/Documents/projects/menti-pilot`). Each brief covers one plan slice in one
  turn and ends with: send results back to the orchestrator session by title,
  using `mcp__ccd_session_mgmt__send_message` (`SendMessage` does not cross
  sessions).
- **Every claim is checked.** When the build session reports, the orchestrator
  re-runs `npm test`, `npm run test:e2e`, `npm run check` and `npm run build`,
  and reads any load-test JSON, before telling Shahil.
- **Approvals happen in the build session.** Database changes, deploys and account
  actions need Shahil's OK in the session that runs them. The orchestrator must
  never carry a blocked action into its own session (permission laundering).
- **Standing direction from Shahil: MVP first.** No visual polish. Accessibility
  and breakage still get fixed. Order: working MVP → open-source template with a
  generic theme → AI Builders branding.

## 1. Where things stand

- `main` holds Milestone 1 steps S0–S7, ADR-001 to ADR-007, and this file.
  `git log --oneline -12` shows the trail. Nothing is pushed; there is no
  GitHub remote yet.
- **Proven, with receipts in the plan:** a word cloud runs end to end (host signs
  in, starts a test run, phones answer, projector updates, hide, freeze, end).
- **Load, measured on a Vercel preview** (files in `scripts/load/`): a
  200-phone answer burst stored every answer exactly once and stayed fast
  (`burst-preview-200-direct.json`). State polling costs about 11 function calls
  a second at 200 phones (`run-C-direct.json`), inside ADR-004's budget.
- **Scope:** v1 is word cloud + poll (ADR-007). Quiz is later. Joining is fully
  anonymous.
- **Accounts and infrastructure:**
  - Supabase in London (`eu-west-2`), linked through the Vercel project `aib-live`.
  - Public sign-up is off, confirmed through `/auth/v1/settings`.
  - The pinned CA is confirmed against the dashboard copy (ADR-006).
  - `PARTICIPANT_SECRET` and `HOST_SESSION_SECRET` are on Vercel for **Preview
    only**, with fresh values. Production has none yet.
  - `aib-live.vercel.app` returns 404, so nothing is public.

## 2. What is open

- Nothing is waiting on Shahil right now.
- **Deferred design** is logged under "Found along the way" in the plan. It is
  deliberately parked by the MVP-first direction.
- **The diagrams artifact** (https://claude.ai/artifact/73x7gxAHiXBawJLvJcK4gj)
  predates ADR-004 to ADR-007. Republish it from `docs/ARCHITECTURE.md` at the end
  of Milestone 1. It is private to Shahil.
- **The pooler URL logs in as `postgres`**, which bypasses row-level security. It
  is equivalent to the old service key. A least-privilege role is a follow-up
  (ADR-006).
- **The folder rename** to `volley` is outstanding. It can only happen between
  sessions, then `vercel link` again. See the plan.

## 3. Exact next pickup point

Open `docs/volley-plan.md` at **S8. Retention and export** and brief the build
session for it. The plan entry has the details. Known prerequisites:

- `pg_cron` is available but **not enabled** on the London database. Enabling it
  is a database change, so Shahil approves it in the build session.
- The hourly job deletes runs 24h after they end, or after 24h idle. Decks are
  kept. It also prunes `rate_limits` windows older than an hour.
- Proof: A12 (a run ended 25h ago is gone with everything under it; one ended
  23h ago is not; its deck survives). Export CSV matches tallies. Plus PNG.

After S8 comes **"Going live"**, just before the first real workshop:
- A keep-alive Vercel Cron. The plan notes that crons need production and do not
  follow redirects.
- Production env vars.
- Shahil's go-ahead to make it public.

## 4. What will bite

- **Test commands never pipe a verdict into `tail`.** Redirect to a file and
  capture `$?`. The Stop hook blocks claims made without a command run in the
  same turn.
- **`npm test` runs its files one at a time.** The session pooler allows 15
  clients. It takes over a minute because the DB tests make many round trips to
  London.
- **Vercel CLI is v53** (current is v60). `vercel env add … preview` fails
  non-interactively with `git_branch_required`. Env vars were added through
  the REST API with the CLI's own token. Upgrading needs Shahil's OK
  (global install).
- **Hobby runtime logs last about an hour**, and the log stream stops at 5
  minutes. Count function calls during a run, not after.
- **Previews are protected.** Load scripts need `VERCEL_AUTOMATION_BYPASS_SECRET`,
  which is in `.env.local`.
- **The migrate and test scripts use `rejectUnauthorized:false`.** The app
  itself verifies the pinned CA.
- **Remote Control is on for both sessions.** Shahil may follow from his phone.

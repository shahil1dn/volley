# Handoff (2026-10-01)

A pointer to now, not a log. Reasons live in `docs/DECISIONS.md`, scope in
`SPEC.md`, design in `docs/ARCHITECTURE.md`, progress in `docs/volley-plan.md`.
`git log --oneline` shows the trail. Nothing is pushed; there is no GitHub
remote yet.

## How this project is run

- **An orchestrator session and build sessions.** The orchestrator talks to
  Shahil in plain English and briefs build sessions in this folder
  (`~/Documents/projects/menti-pilot`). Every brief ends with a reply clause:
  send results back to the orchestrator by title and id, using
  `mcp__ccd_session_mgmt__send_message` (`SendMessage` does not cross sessions).
- **Parallel builds use worktrees**, one per session, under `.claude/worktrees/`
  on their own branch (`git worktree add .claude/worktrees/<name> -b <name> main`,
  then copy `.env.local` in and run `npm ci`). The orchestrator merges into
  `main`. Reserve migration and ADR numbers in each brief: two branches both
  wrote an ADR-011 on 2026-09-30.
- **The test lock.** Build sessions share the test database, dev-server port
  5174 and a 15-client pooler, so every `npm test` / `npm run test:e2e` runs
  inside `until mkdir /tmp/volley-tests.lock 2>/dev/null; do sleep 10; done; …;
  rmdir /tmp/volley-tests.lock`.
- **Every claim is checked.** The orchestrator re-runs the receipts on the
  merged code before telling Shahil.
- **Approvals happen in the session that acts.** Production database writes,
  deploys, Vercel or Supabase settings and account actions need Shahil's OK,
  asked there. An approval never travels between sessions.
- **Security-sensitive work gets the 3-reviewer check** (code, security, tests)
  before it goes live; every finding is verified before acting. On invite-host
  it caught a real bug that the tests had missed.

## 1. Where things stand

- **Live at https://aib-live.vercel.app** (deploy `dpl_Ag1UVbBrpvySv6b82p6N5xN3k2F3`,
  built from `main` at `aedf8a1` on 2026-10-06):
  - word cloud, poll and Q&A (ADR-008); the projector shows one Q&A question
    at a time, stepped by the host with Next/Previous question (ADR-013);
  - sessions of 1 to 10 activities under one room code (`/decks`, reworked
    2026-10-06: add/remove activities, poll options as separate fields shown
    only for polls, errors beside each field; migration 0014);
  - polish (2026-10-06): labelled control-page status, grouped controls, a
    separate End session, an upvote tick and instant vote count, one disabled
    style, and a token guard test against hard-coded colours;
  - a password reset ends sessions issued in the same second (ADR-011 note,
    migration 0016), and sign-in reads the reset stamp before the password
    check, using a single lookup for every email;
  - layouts (Shahil's pick, 2026-10-06): `/decks` has two columns from 960px,
    with a sticky live "Your session" summary; the control page pins its status
    and main action to the top (on a Q&A: Open answers, then Previous/Next
    question);
  - empty, loading, offline and error states say what is happening, including
    a branded error page and signed-out / no-longer-a-host messages;
  - `/join` for typing a code;
  - the new neutral look, with name, colours and logo in `src/lib/brand.ts`
    (ADR-012);
  - **admins invite hosts by link** (`/hosts`; ADR-011).
- **Shahil is an admin** named "Shahil" on production (via `set-host`; his
  password is unchanged). The first real invite (the society's VP, Ryan) hit
  two bugs, both fixed and deployed on 2026-10-01: every invite was refused live
  ("Cross-site POST form submissions are forbidden", caused by Referrer-Policy
  no-referrer), and the invite was saved under Shahil's name (browser autofill).
  With a fresh link, Ryan's invite worked end to end (Shahil, 2026-10-01).
- **Two Supabase projects, both London** (ADR-010). Production `aib-live-db`
  (ref `qeheedlsskaurqshmueb`) is connected to Vercel's **Production** only.
  Test `volley-test-db` (ref `gzwzfjukswcifikbsufm`) is connected to
  **Preview and Development**. Both are at the same migration; `.env.local`
  holds only the test project.
- **Rules in force:** any write to production needs Shahil's OK. `npm test`,
  the browser tests and `migrate` refuse production
  (`scripts/production-guard.ts`); `migrate --production` is the deliberate way
  in.
- **Keep-alive** (Vercel Cron, daily at `0 9 * * *` UTC) works end to end: a
  manual Run on 2026-09-30 at 13:28 UTC got 200s.
- **Hourly purge** (`pg_cron`) runs on both databases.
- **Receipts**, all against the test project: `npm test`, `npm run test:e2e`,
  `npm run check`, `npm run build`. Redirect each to a file and capture `$?`.

## 2. What is open

- **A scheduled keep-alive run hasn't been seen**, only a manual one. Check the
  Vercel logs during 09:00–09:59 UTC (Hobby keeps about an hour).
- **Polish judgement calls left as they are:**
  - the phone says "Waiting for the next question" both between activities and
    when answers close;
  - there's no "Working…" label on slow host actions;
  - `/join` offline shows the browser's own page;
  - a host whose session expires mid-typing on `/decks` loses the form;
  - Mark answered / Hide stack vertically on a 375px control page.
- **The cold-pooler retry** (`src/lib/server/cold-connect.ts`) is proven by
  tests only; the live cold case hasn't recurred.
- **The purge's A11 index test may be flaky**: once green with its index
  dropped, three times red (`tests/db-retention.test.ts`).
- **The merged worktrees** `.claude/worktrees/invite-host` and `m4-theme` can be
  removed (`git worktree remove …`, then `git branch -d …`). Both branches are
  in `main`.
- **Later:** the folder rename to `volley` (Milestone 4 step 5); the stale
  diagrams artifact (https://claude.ai/artifact/73x7gxAHiXBawJLvJcK4gj; republish
  it from ARCHITECTURE); a least-privilege database role (ADR-006).

## 3. Exact next pickup point

1. **Milestone 4 step 4: the 10-minute, 200-phone load test, with measured numbers replacing
   the estimates in ARCHITECTURE §10 (A10), and the Supabase Security Advisor clean (A13).**
   Milestone 4 step 3 is done: A15 PASSED (trial 2, 2026-10-12, `docs/trial-A15-record-2.md`;
   trial 1 is `docs/trial-A15-record.md`). Still unverified: the cron's reachability under
   Standard Protection (read the first scheduled run's log), that the Deploy button works (click it
   once the repo is public, step 5), and `--disable-signup` (tested only against fakes).

## 4. What will bite

- **Production's Vercel settings are write-only.** Any production write needs
  Shahil to paste `aib-live-db`'s `.env.local` snippet (Vercel → Storage →
  `aib-live-db` → `.env.local` tab → Show secret) into `.env.production.local`.
  That file is git- and deploy-ignored. Delete it straight afterwards and check
  it's gone. The snippet lacks `SUPABASE_URL`; `add-host` needs it, with the
  value of `PUBLIC_SUPABASE_URL`.
- **`add-host` and `set-host` bypass the test guard** by design: they are how
  production hosts are made. Point them at the right file. `add-host` resets
  the password and ends older sessions; `set-host` never touches the password.
- **A password reset ends sessions**, through `hosts.sessions_valid_after`. New
  sessions are stamped no earlier than it (ADR-011). Don't issue a host session
  without passing `sessionIssuedAt(...)` to `startHostSession`: sign-in uses
  `host-signin.ts`, the invite page passes `sessionIssuedAt(now, sessionsValidAfter)`.
- **`use:enhance` ignores `onsubmit`'s preventDefault.** Put confirmations in
  the enhance callback and call `cancel()`.
- **The guard's own redirects** don't carry SvelteKit's cookie changes. Set
  `set-cookie` on them explicitly (`clearedHostCookie`).
- **The test store names its public settings `NEXT_PUBLIC_…`.**
  `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_PUBLISHABLE_KEY` were added by hand
  to Preview and Development; update them if the test store's keys rotate.
- **The test project allows public sign-up**; production has it off.
- **Hobby runtime logs last about an hour.**
- **Test commands never pipe a verdict into `tail`.** Redirect to a file and
  capture `$?`.
- **`npm test` runs its files one at a time**, and the suites take a few minutes
  in all.
- **Vercel CLI is v53.** Env vars go through the REST API with the CLI's own
  token. Store connections can't be edited in place, only disconnected and
  reconnected. Upgrading needs Shahil's OK.
- **Remote Control is on.** Shahil may follow from his phone. Put anything he
  must read or copy inside the question box itself.

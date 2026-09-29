# Spec: first open-source release

Decisions this builds on are settled in `docs/DECISIONS.md` (ADR-001, ADR-002)
and are not reopened here.

## Target

A rebuild of this repository (`~/Documents/projects/menti-pilot`) on SvelteKit,
replacing the Next.js prototype. Screens: `/` (host start), `/host/[code]`
(projector), `/host/[code]/control` (host panel), `/j/[code]` (participant),
`/join` (enter code), `/decks` (host's sessions). Server routes under
`src/routes/api/`. Rules in `db/` as Postgres functions. Activity types in
`src/lib/server/activities/<type>/`.

## Objective

A society committee member signs in, builds a session of a few activities
(word cloud, multiple-choice poll, timed quiz) and runs it from a laptop on a
projector. Up to 200 people join by QR code with no account and answer from any
phone. Results update live on the projector, the host can hide anything
instantly, and everything is deleted 24 hours after the session ends, with an
export first. Anyone else can run their own copy by telling an AI agent to
follow `AGENTS.md`.

## In scope

**Hosting**
1. Host sign-in by email link, limited to an approved email list set per copy.
2. Create a session: title, then an ordered list of activities, each configured
   by a form generated from that activity's settings schema.
3. Run a session: projector view plus a separate host control view (next / back,
   open / close answers, hide, freeze input, end session).
4. A live room is controlled by a host session cookie (`httpOnly`, `Secure`,
   `SameSite=Lax`), never a value in browser storage. A late sign-in email must
   never stop a room that is already running.
5. Export results (image of the projector view, and CSV) until deletion.

**Activities**
6. Word cloud: up to N answers per participant (host sets N, default 3), words
   normalised and merged.
7. Multiple-choice poll: 2–6 options, one vote per participant, live bars.
8. Timed quiz: questions with 2–4 options and one correct answer, host-set time
   limit. Start is scheduled about 3 seconds ahead; phones count down against
   server time; answers after close are rejected by the database; speed scored in
   coarse bands from server receive time. Leaderboard of anonymous nicknames.
9. All three built against one in-repo `defineActivity` contract (settings
   schema, validate, tally/reduce, phone view, projector view), extracted after
   the three exist. `npm run new-activity` scaffolds a new folder with a test.

**Participants**
10. Join by QR or code; no account, no name or email (quiz asks for an optional
    nickname, not stored beyond the session).
11. Phones poll the current state (about every 3s, about 1s while an activity is
    open); they never hold a live connection.
12. Each phone gets a server-issued signed participant token on join.
13. Submits are retry-safe: each carries a one-time id and repeats are ignored.
14. Leaving and coming back (sleep, lost Wi-Fi, tab switch) resumes the current
    activity with previous answers remembered.

**Rules (Postgres functions, cannot be bypassed)**
15. Per-participant answer limits, answers only while an activity is open,
    insert-only answers stamped with server time, moderation as inserted rows.
16. Rate limits per IP and per session for joining, submitting and session
    creation.
17. Row-level security on every table, forced; public key reads nothing it does
    not need.

**Live updates**
18. Projector and host control view receive server-sent Supabase Broadcast (at
    most one snapshot a second), and fall back to polling if the connection drops.
19. Hiding or freezing reaches every projector and phone within 3 seconds.

**Data and privacy**
20. Sessions and all answers deleted 24 hours after the session ends, or after 24
    hours with no activity. Saved sessions (the activity list, no answers) are
    kept until the host deletes them.
21. Everything stored in London; server functions run in London.
22. Privacy notice template covering what is stored and for how long.

**Self-hosting**
23. Nothing hard-coded to AI Builders: name, colours, logo and approved hosts
    come from settings.
24. `AGENTS.md`: ordered commands, expected output, clearly marked human-only
    steps (creating accounts, accepting terms).
25. `npm run setup` (idempotent) and `npm run doctor` (plain-English health
    check with fixes).
26. No analytics or usage pings.

## Out of scope

- Q&A, ranking, scales, open text answers, image activities.
- Deck starter packs, deck import/export, sharing decks between copies.
- Per-host theming beyond the copy-wide name, colours and logo.
- A public SDK or loading activities from outside the repo; activity gallery;
  AI-generated activities.
- A shared public instance anyone can sign up to; multi-organisation tenancy.
- Participant accounts, profiles or history.
- Native apps; offline/local-network mode.
- Docker self-hosting (follows after the Vercel path works).
- Deploying the owner's copy publicly (a separate decision).

## Constraints

- Stack per ADR-002: SvelteKit + TypeScript on Vercel Functions pinned to
  `lhr1`; Supabase Postgres and Broadcast in `eu-west-2`; MIT licence.
- Secrets only in `$env/static/private` and `$lib/server`; the secret key never
  reaches the browser.
- Free tiers: 200 realtime connections (only projector and host views connect),
  1M function invocations a month, no database backups.
- New dependencies must name what they are for and why nothing installed does it.

## Acceptance criteria

Each is a check that fails if the behaviour is missing.

| # | Check |
|---|---|
| A1 | Database test: a participant's 4th word when N=3 is rejected; two concurrent 3rd-word submits produce exactly one accepted. |
| A2 | Database test: an answer after the activity's close time is rejected. |
| A3 | Database test: the same submit id sent twice stores one answer. |
| A4 | Permission probe with the public key: cannot read sessions, hosts or hidden answers; cannot insert, update or delete anything. |
| A5 | Unit tests: word-cloud merge and ordering, poll tally, quiz scoring bands, each shown to fail when the logic is broken. |
| A6 | Browser test: a non-approved email cannot create a session; an approved one can. |
| A7 | Browser test: host control actions without the host cookie are rejected (403). |
| A8 | Browser test: 3 simulated phones submit; projector shows the result within 3s without reload; hide removes it from projector and phones within 3s. |
| A9 | Browser test: quiz countdown starts on all phones within 1s of each other (server-time aligned), and a late answer is refused. |
| A10 | Load check: 200 simulated participants polling and submitting for 10 minutes; zero failed submits, projector stays connected. |
| A11 | Retention job test: a session ended 25 hours ago is gone with its answers; one ended 23 hours ago is not. |
| A12 | `npm run doctor` on a copy with the database in the wrong region, or no approved host, names the problem in plain English. |
| A13 | A fresh AI agent with only `AGENTS.md` and new accounts reaches a working copy; the human-only steps it stopped at are listed. |
| A14 | `grep` for "AI Builders" in `src/` returns nothing outside defaults read from settings. |
| A15 | Build, typecheck and all tests pass in one command with a surviving exit code. |

## Open questions

1. **Project name.** The code can't say "AI Builders" (point 23), so the
   open-source project needs its own name. AI Builders Live is just your copy.
2. **Must-verify items** carried from the ADRs (run before planning slices that
   depend on them): pg_cron on the free plan; whether the Vercel deploy button
   can provision Supabase; the Supabase Auth email rate limit on the default
   mail sender; whether server-sent Broadcast counts toward 100 messages a second.

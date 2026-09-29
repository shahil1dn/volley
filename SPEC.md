# Spec: Volley, first open-source release

Settled decisions are in `docs/DECISIONS.md` (ADR-001 to ADR-003) and are not
reopened here. The design is drawn out in `docs/ARCHITECTURE.md`.

## Target

A rebuild of this repository (`~/Documents/projects/menti-pilot`, to be renamed
`volley`) on SvelteKit, replacing the Next.js prototype.

| Path | Screen or module |
|---|---|
| `/` | Host sign-in |
| `/decks`, `/decks/[id]` | Host's decks and the deck editor |
| `/run/[code]` | Projector view |
| `/run/[code]/control` | Host control view |
| `/j/[code]`, `/join` | Participant view, enter-a-code |
| `src/routes/api/r/[code]/state/+server.ts` | Shared, cached state (GET) |
| `src/routes/api/r/[code]/answer/+server.ts` | Submit an answer (POST) |
| `src/routes/api/r/[code]/host/+server.ts` | Host actions (POST) |
| `src/lib/server/activities/<type>/` | One folder per activity type |
| `db/migrations/` | Tables, Postgres functions, policies, scheduled job |
| `scripts/` | `setup`, `doctor`, `add-host`, `new-activity` |

## Objective

A society committee member signs in, builds a deck of a few activities (word
cloud, multiple-choice poll, timed quiz) and runs it from a laptop on a
projector. Up to 200 people join by QR code with no account and answer from any
phone. Results appear on the projector within about 2 seconds, the host can hide
anything, and all participant data is deleted 24 hours after the run ends, with
an export first. It runs entirely on free tiers, and anyone can stand up their
own copy by telling an AI agent to follow `AGENTS.md`.

## In scope

**Hosts**
1. Password sign-in (Supabase Auth). Host accounts are created only by
   `npm run add-host <email>`, which needs the database secret key. There is no
   public sign-up and no email sending.
2. Login session held in an `httpOnly`, `Secure`, `SameSite=Lax` cookie. Nothing
   sensitive in browser storage.
3. Decks: a title plus an ordered list of activities, each configured by a form
   generated from that activity's settings schema. Decks are kept until deleted.
4. Runs: starting a deck creates a run with a join code. The projector and control
   views are separate. Control actions: open, close, reveal, next, back, hide or
   unhide a word, freeze or unfreeze input, end.
5. Export after or during a run: PNG of the projector view and CSV of tallies.

**Activities**
6. Word cloud: up to N answers per participant (host sets N, 1–5, default 3);
   answers trimmed, lower-cased, spaces collapsed, 1–25 characters.
7. Poll: 2–6 options, one vote per participant.
8. Timed quiz: 2–4 options, one correct, host-set limit (5–60s). The start is
   scheduled 3 seconds ahead, devices count down on server time, the database
   refuses answers outside the window, and speed is scored in 4 coarse bands from
   server receive time. Leaderboard of optional nicknames (1–20 characters).
9. All three share an in-repo `defineActivity` contract (settings schema,
   validate, tally rule, phone view, projector view), extracted once the three
   exist. `npm run new-activity <name>` scaffolds a folder with a failing test.

**Participants**
10. Join by QR or code. No account, no name or email; the quiz nickname is
    optional and deleted with the run.
11. The server issues a signed participant token in a cookie scoped to the answer
    route, so the shared state route stays cacheable.
12. Each submit carries a one-time id; a repeat is stored once and answered with
    the same result.
13. Coming back after sleep, lost Wi-Fi or a tab switch resumes the current
    activity. What a phone has sent is kept on the phone.

**Delivery (no live connections)**
14. Phones, projector and control view all read one state response per run. It
    is identical for everyone, carries nothing personal, and is cached at the edge
    for 1 second (`s-maxage=1, stale-while-revalidate=60`; see ADR-004).
15. Polling: projector and control every 1s; phones every 3s, and every 1s while a
    quiz is running.
16. State includes `version` and `serverNow`. It never includes a quiz's correct
    answer before the host reveals it.

**Rules, all inside Postgres functions**
17. Each request makes at most one database call. Every call is served by an
    index; no full-table scans.
18. `submit_answer` checks, in one transaction: rate limit, run live and not
    frozen, item open and inside its time window, duplicate submit id, per-person
    quota (conditional upsert, safe under concurrent submits), then updates the
    tally, the quiz score and `runs.version`.
19. Tallies are kept up to date on write, so reads never count raw answers.
20. `responses` and `moderation` are insert-only. Hiding writes a moderation row
    and flips the tally's `hidden` flag in the same transaction.
21. Rate limits per hashed IP and per run, in an unlogged table.
22. Row-level security enabled and forced on every table. The public key can read
    nothing. Supabase's Security Advisor shows no warnings.

**Data and privacy**
23. Runs and everything under them are deleted by an hourly `pg_cron` job 24 hours
    after the run ends, or after 24 hours with no activity. Decks are kept.
24. Database in `eu-west-2`, functions in `lhr1`.
25. Privacy notice template: what is stored, why, for how long, who controls it.

**Self-hosting**
26. Nothing hard-coded to AI Builders: name, colours and logo come from settings.
27. `AGENTS.md` with ordered commands, expected output and clearly marked
    human-only steps (creating accounts, accepting terms).
28. `npm run setup` is safe to re-run. `npm run doctor` checks region, keys,
    migrations, at least one host and the lockdown, and explains any failure in
    plain English.
29. README Deploy button using Vercel's `stores` parameter to create the Supabase
    database, if the slugs work. Otherwise `AGENTS.md` covers the manual path.
30. No analytics and no usage pings. MIT licence.

## Out of scope

- Q&A, ranking, scales, open text, images.
- Starter packs, deck import/export, sharing decks between copies.
- Per-host theming beyond the copy-wide name, colours and logo.
- A public SDK, loading activities from outside the repo, an activity gallery,
  AI-generated activities.
- Supabase Realtime or any other live connection.
- Email sign-in links, password reset by email, public sign-up.
- A shared public instance; multi-organisation tenancy.
- Participant accounts or history.
- Native apps, offline or local-network mode.
- Docker self-hosting (after the Vercel path works).
- Deploying the owner's copy publicly (a separate decision).

## Constraints

- Stack: SvelteKit + TypeScript on Vercel Functions in `lhr1`; Supabase Postgres
  in `eu-west-2`; MIT.
- Secrets only in `$env/static/private` and under `$lib/server`.
- Free-tier budgets and the per-event estimate are in `docs/ARCHITECTURE.md` §10.
  They are estimates until A10 replaces them with measured numbers.
- Supabase free plan has no backups; decks are the only lasting data, so deck
  JSON export is on the roadmap as the backup path.
- Every new dependency states what it is for and why nothing installed does it.

## Acceptance criteria

Each check fails if the behaviour is missing.

| # | Check |
|---|---|
| A1 | DB test: with N=3, a 4th word is refused; 10 concurrent submits from one participant store exactly 3. |
| A2 | DB test: an answer before `opens_at` or after `closes_at` plus grace is refused. |
| A3 | DB test: the same `submit_id` sent twice stores one row and returns the same result both times. |
| A4 | Permission probe with the public key: cannot select, insert, update or delete on any table. |
| A5 | Unit tests: word normalising and ordering, poll tally, quiz speed bands; each shown to fail when the logic is broken. |
| A6 | A host route called without a host cookie, or with a non-host account, returns 403. `add-host` is the only way to create a host. |
| A7 | The host cookie is `httpOnly`: `document.cookie` in the browser does not contain it. |
| A8 | Browser test: 3 phones answer; the projector shows the result within 3s without reload. Hide removes it from the projector within 3s. |
| A9 | Browser test: the quiz state never contains the correct answer before reveal; an answer after close is refused. |
| A10 | Load test: 200 simulated phones polling and answering for 10 minutes against a deployed preview. Zero failed submits. Measured function calls stay under 2 a second plus answers, which proves the edge cache works. Measured numbers replace the estimates in ARCHITECTURE §10. |
| A11 | `EXPLAIN` on each database function's queries shows index scans only. |
| A12 | Retention test: a run ended 25 hours ago is deleted with everything under it; one ended 23 hours ago remains; its deck remains. |
| A13 | Supabase Security Advisor shows no warnings. |
| A14 | `npm run doctor` on a copy with the database in the wrong region, or with no host, names the problem in plain English. |
| A15 | A fresh AI agent with only `AGENTS.md` and new accounts reaches a working copy; the steps it had to hand to a human are listed. |
| A16 | `grep` for "AI Builders" in `src/` finds nothing outside the default settings. |
| A17 | Build, typecheck and all tests pass in one command with the exit code intact. |

## Must verify before the slice that needs it

1. Vercel's CDN caches a SvelteKit `+server.ts` GET with `s-maxage=1` and does
   not call the function on a hit. Proven by A10.
2. Whether the cached response carries an `Age` header, so devices can correct
   `serverNow` for cache age. If not, quiz clocks allow up to 1s of error, which
   the coarse speed bands absorb.
3. Supabase Auth password sign-in with cookie sessions in SvelteKit, using the
   current official guide.
4. The Supabase `integrationSlug` and `productSlug` for the Deploy button's
   `stores` parameter.

## Open questions

None. Name (Volley) and host sign-in (password, added by command) settled in
ADR-003.

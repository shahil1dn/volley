# Decisions

## ADR-001: Architecture for the open-source release (2026-09-29)

Decided by a five-voice council with an independent judge, after the word-cloud
prototype worked end to end.

**Decision.** Keep Next.js + Supabase. Every rule lives in Postgres behind one
write path. Phones never hold a live connection; they submit through server
routes and poll a short-cached state endpoint. Only the projector and host panel
receive live Broadcast. Activities share an in-repo `defineActivity` contract.
MIT licence.

**Why.** Supabase Free allows 200 concurrent realtime connections, so phones
holding sockets breaks at a 300-person event. Every known prototype gap (answer
limit checked only in the browser, hide updating one screen) comes from rules
living in the wrong place, and moving them into the database fixes them together.

**Details**
- Delivery per activity: word cloud, poll and Q&A poll every ~3s (~1s while open).
  Timed quiz: the server schedules the start ~3s ahead, phones count down against
  the server clock, the database rejects late answers, and speed is scored in
  coarse bands from server receive time. Projector: at most one Broadcast
  snapshot per second, sent after commit. Replaces postgres_changes, which is
  single-threaded and checks permissions per subscriber.
- Rules in Postgres command functions: unique/quota key on (session,
  participant, activity), answers only while open, insert-only responses stamped
  with server time, participant identity a server-issued signed token.
- Plugin contract `defineActivity({ schema, validate, reduce, views })` stays
  inside the repo. Hand-build word cloud, poll and quiz first; publish an external
  contract only after the third activity. No gallery, AI-generated activities or
  swappable transport yet.
- Host accounts (Supabase Auth) to create and save sessions ahead of time; a live
  room always runs on the hashed host token, so a late sign-in email never blocks
  an event.
- Moderation is an inserted row, server-written then broadcast, plus a "freeze
  input" panic button.
- Abuse: per-IP and per-session counters in Postgres limit session creation and
  submissions; caps on words and session size.
- Privacy: no participant accounts, names or emails; London/EU region; automatic
  deletion after 30 days.
- Self-hosting: Docker Compose with the Supabase images; weekly keep-alive so a
  free project does not pause; README states Vercel Hobby is non-commercial.

**Rejected.** Elixir or a custom WebSocket server (a second runtime for one
maintainer). AGPL (Claper already fills that niche, and MIT is simpler to
contribute to). Polling uncached (one 500-person hour at 1s is 1.8M requests,
against a 1M monthly allowance).

**Must verify before building**
1. Whether Vercel CDN cache hits count against the 1M function invocations, and
   whether a 1s `s-maxage` is honoured on Next.js 16 route handlers.
2. Whether server-sent Broadcast counts toward the 100 msgs/s free limit.
3. The Supabase Auth free-tier email rate limit for sign-in links.
4. Whether Vercel Hobby's non-commercial rule covers a free society tool.

**Key risk.** The plan is only free if polling is cheap. If cache hits count as
invocations, split the shared cached state from a small per-person endpoint
called only on submit, or self-host.

## ADR-002: Scale, framework, region, retention and self-hosting (2026-09-29)

Refines ADR-001 after the owner set the real scale and goals.

- **Scale is 20–100 people, 200 at a big event.** Peak load is about 2 writes a
  second. No reverse proxy, load balancer, queue or Redis: Vercel's edge already
  terminates HTTPS and routes. Phones still poll instead of holding a live
  connection, because 200 phones alone would use the whole free realtime cap.
  Uncached polling (200 phones every 3s for an hour ≈ 240k requests) fits the
  1M monthly allowance, so the CDN-cache question drops from blocking to nice to
  know.
- **Correctness concerns that do matter at this scale:** server is the source of
  truth; retry-safe submits (a one-time id per submit, repeats ignored);
  reconnect and resume; rate limits against scripts; server clock for timers;
  projector falls back to polling if its live connection drops.
- **Framework: SvelteKit** (replaces Next.js). Smaller and simpler for an app
  that is mostly live client screens; `$env/static/private` and `$lib/server`
  keep secrets out of the browser natively. The owner chose it knowing it means a
  rebuild of the screens and routes; the database, rules and tests carry over.
- **Region: London.** Database recreated in `eu-west-2` (the first was created in
  US East by default and deleted). Server functions pinned to `lhr1` via the
  SvelteKit Vercel adapter's `regions`.
- **Where logic lives:** rules in Postgres functions (atomic, cannot be
  bypassed); SvelteKit server routes are a thin front desk (validate shape,
  identify host or participant, rate-limit by IP, call the function, broadcast);
  activity maths in pure TypeScript for testing.
- **Retention: delete a session and all its answers 24 hours after it ends**, or
  after 24 hours with no activity if never ended. Hosts get an "Export results"
  button before that. Saved decks are host content and are kept. Replaces the
  30 days in ADR-001.
- **Two levels of "template".** Activity types are code: one self-contained
  folder per type (settings schema, rules, tally, screens), scaffolded by
  `npm run new-activity`, contributed by pull request. No uploading of code
  into a running site. Hosts build presentations in a no-code deck editor whose
  forms are generated from each activity's settings schema; saved decks, starter
  packs and deck import/export follow.
- **Every copy is independent.** Self-hosters run their own Vercel and Supabase
  free tiers; nothing reaches the owner's servers. Nothing is hard-coded to AI
  Builders (name, colours, logo, approved hosts all come from settings). No
  analytics or usage pings. Host sign-in limited to an approved email list per
  copy. The privacy notice ships as a template.
- **Audience for self-hosting: one tech-comfortable person per society**, who
  sets it up once; everyone after is Menti-easy. Made agent-ready: an
  `AGENTS.md` with exact ordered commands, expected output and clearly marked
  human-only steps; an idempotent `npm run setup`; a plain-English
  `npm run doctor` health check. A fresh agent following the guide from scratch
  is a release gate. A public shared instance is out of scope for now.

**Added to must-verify:** whether Vercel's deploy button can provision the
Supabase integration; whether pg_cron (for the 24-hour deletion) is available on
the Supabase free plan.

## ADR-003: Name, host sign-in and polling everywhere (2026-09-30)

- **Name: Volley.** Rapid back-and-forth between host and room. Plain-word
  names are all taken on npm and `.app`; neither matters, since Volley is an app
  people deploy rather than a package they install, and each copy lives at its
  own address. Repository lives under the owner's GitHub account.
- **Host sign-in: password, accounts created only by `npm run add-host`.**
  Supabase's built-in email sender sends 2 emails an hour and only to the
  project's own team (supabase.com/docs/guides/auth/rate-limits,
  .../auth-smtp), so email links would force every self-hoster to set up a mail
  service. The command creates the account directly with the secret key; there is
  no public sign-up and no email is ever sent. Supersedes the magic-link host
  sign-in in ADR-001.
- **No live connections at all; everything polls one shared, cached state.**
  Found while designing the queries: if the state response is identical for every
  device and personal data stays on the phone, Vercel's edge cache answers all
  devices with about one function call a second per run. The projector can then
  poll too (every 1s), so Supabase Realtime is no longer needed. That removes the
  200-connection ceiling, the Broadcast quota and a moving part for self-hosters,
  at the cost of results arriving within about 2 seconds instead of instantly.
  Supersedes the projector Broadcast in ADR-001 and ADR-002. Whether the cache
  behaves as assumed is proven by the spec's load test (A10).
- **Data model split into decks and runs.** Decks (host content) are kept; runs
  (one live showing, with every participant answer) are deleted 24 hours after
  ending. Tallies are maintained on write so reads never count raw answers.

## ADR-004: A function-call budget replaces "about one call a second" (2026-09-29)

S1 measured the shared, cached state route under load (runs in
`docs/volley-plan.md`, S1). Vercel's CDN does not keep function calls near one
a second: with `Cache-Control: public, s-maxage=1, stale-while-revalidate=60`,
200 phones produced 6.9 calls a second when polling every 3s (run B) and 8.8
a second when polling every 1s (run A).

- **Decision: accept the measured cost.** The pass line becomes a budget: at
  most about 10 function calls a second with 200 phones polling every 3s
  (about 36k an hour). The header stays at `s-maxage=1,
  stale-while-revalidate=60`.
- **Why it fits.** The owner's usage is a 20–40-person workshop every fortnight
  and one 200-person event every 1–3 months. That's about 160k function calls a
  month in the worst case, 16% of Hobby's 1M.
- **Why the cache can't do better as built.** Vercel documents request
  collapsing (merging simultaneous refreshes into one call) only for ISR and
  Image Optimization, not for function responses cached with `Cache-Control`.
- **Later optimisation, not a blocker:** serve the state route through ISR,
  where collapsing is documented. Unverified whether that works on a
  `+server.ts` GET with a 1-second expiry.
- Supersedes ADR-003's "about one function call a second per run". Polling
  everywhere, with no live connections, stands.
- **Amended 2026-09-29 (S7):** the same directives now travel in
  `CDN-Cache-Control` (Vercel reads it before `Cache-Control`; browsers ignore
  it), and browsers get `Cache-Control: public, max-age=0, must-revalidate`.
  With the old single header, a browser with no CDN in front served every state
  one poll late (proven; see volley-plan.md, S7). The CDN directives are
  unchanged, but S1 measured the old header, so the rate is re-measured on the
  next preview. **Re-measured the same day (run C, `scripts/load/run-C.json`):**
  200 phones polling every 3s for 120s → 8,000 × HTTP 200, HIT 4,319 / STALE
  3,623 / MISS 58, 848 function calls = **7.07 a second** (median 7, max 14),
  against run B's 6.9. The split leaves the CDN's behaviour unchanged and within
  this budget.
- **Amended 2026-09-30 (owner): the budget is now about 15 function calls a
  second** with 200 phones polling every 3s (about 54k an hour). After ADR-006
  the measured rate was 11.39 a second (`scripts/load/run-C-direct.json`), up
  from 7.07; the owner accepted it. Worst-case month about 264k calls, 26% of
  Hobby's 1M. ISR and a longer `s-maxage` stay later optimisations, not
  blockers.

## ADR-005: Host sessions are our own signed cookie, not Supabase's (2026-09-29)

Host sign-in (S6) checks the password with Supabase Auth, then issues Volley's
own session cookie. It doesn't use `@supabase/ssr`'s cookie sessions.

- **Why not `@supabase/ssr`.** Its cookies are written with `httpOnly: false`
  by default, "so browser JavaScript can read the token cookies" (its
  DEFAULT_COOKIE_OPTIONS), and Supabase's SvelteKit guide copies those options
  onto every cookie. That breaks A7. They can be forced to httpOnly, but they
  would still put Supabase's access and refresh tokens (valid 400 days by
  default) in the browser, and need refresh-token handling on every request.
- **What we do.** The sign-in action checks the password with `supabase-js`
  (`signInWithPassword` on a throwaway server-side client), revokes the
  Supabase session it gets back straight away, then sets `volley_host`:
  `<user id>.<expiry>.<HMAC-SHA256>`, signed with `HOST_SESSION_SECRET`,
  httpOnly, SameSite=Lax, Secure (SvelteKit's default outside
  http://localhost), Path=/, lasting 12 hours. The same pattern as the
  participant token (S5), with its own secret, so a leaked participant secret
  can't forge a host session.
- **Being a host is checked every time.** A valid cookie only proves the
  password was checked. `hooks.server.ts` also looks the user up in `hosts` on
  every host page and API, so removing a host takes effect at once. A
  confirmed Supabase account with no `hosts` row gets 403 (tested). Host paths:
  `/decks…`, `/run/[code]/control…`, `/api/host…`, `/api/r/[code]/host…`.
  Signed out: pages redirect to `/`, APIs answer 401. Not a host: 403.
- **Brute force.** `allow_sign_in` counts every attempt per hashed IP (30 per
  15 min) and per hashed email (10 per 15 min) before the password is checked.
- **Accepted costs.** A session can't be ended early except by signing out, by
  removing the host, or by rotating `HOST_SESSION_SECRET`. A host request makes
  one `hosts` lookup before its own work; later host actions can fold that check
  into their database function so each request still makes one call.
- **Path=/** because host routes are spread across the app (SPEC's route table),
  so the cookie also goes along on the cached state route when a host's
  projector polls it. The state route ignores cookies, and Vercel's documented
  cache rules don't exclude requests that carry one. Whether the cache
  still holds with the cookie present gets checked at S7's deploy.

## ADR-006: The server talks to Postgres through the transaction pooler (2026-09-29)

**Decision.** Every server-side database call goes over a direct Postgres
connection through Supabase's transaction pooler (`POSTGRES_URL`, port 6543),
from one place: `src/lib/server/db.ts`. Nothing server-side uses the Data API
(PostgREST). `supabase-js` stays only for the password check at sign-in (the
Auth API) and for `npm run add-host` (the Auth admin API).
`tests/no-data-api.test.ts` fails if app code calls `.rpc(` or `.from('…')`.

**Why.** Measured in `scripts/load/diagnose-submit.mjs` (44d7267): every call
through the Data API topped out at ~44 a second, even a no-op, while the
database took `submit_answer` at 321–342 a second. On a protected preview, 200
phones × 3 words within ~5s:

| | p50 | p95 | max | stored = tallied | 5xx |
| --- | --- | --- | --- | --- | --- |
| Data API (before) | 6,692 ms | 9,855 ms | 10,576 ms | 600 = 600 | 0 |
| Transaction pooler (after) | 57 ms | 269 ms | 368 ms | 600 = 600 | 0 |

(`scripts/load/burst-preview-200.json`, `…-200-direct.json`.) No error-level
or pool-error log lines during the runs.

**Later (2026-09-30, ADR-010):** the connection strings in `.env.local` are
now the separate test project's. Production's live only on Vercel, and
`scripts/migrate.mjs` refuses production without `--production`. The pool also
retries once when a *new* connection times out
(`src/lib/server/cold-connect.ts`): after a few idle minutes the pooler took
3.3s to accept its first connection, just over the 3s limit.

**Details**
- One `pg.Pool` per function instance, created lazily, **max 3 connections**.
  Fluid compute runs many requests on one instance, and a call holds a
  connection for ~20 ms, so 3 carry ~150 calls a second per instance.
  Supabase advises 1–5 for serverless, and every instance's connections count
  against the pooler's client limit. That limit for the free plan wasn't in the
  docs checked (so: unverified); 3 per instance stays under any limit of 200 or
  more up to ~65 live instances. `attachDatabasePool` (`@vercel/functions`)
  releases idle connections before Fluid suspends an instance.
- Fail fast: 3s to get a connection, 5s per query, 5s idle. A stuck pooler
  becomes a 5xx that the phone retries with the same submit id.
- Only fixed statements, with values always as parameters. Transaction mode
  doesn't support named prepared statements; node-postgres sends parameterised
  queries as unnamed ones, which worked through the pooler in every test and
  load run.
- **TLS is verified, not skipped.** The pooler's certificate chains to Supabase
  Root 2021 CA, which Node doesn't trust by default
  (`SELF_SIGNED_CERT_IN_CHAIN`). That root is pinned in
  `src/lib/server/supabase-ca.ts` (SHA-256 `80:70:25:AD:…:E6:CA:FA`, valid to
  2031). The chain and hostname are checked: connecting by IP address is
  refused (`ERR_TLS_CERT_ALTNAME_INVALID`). The root was taken from the live
  chain; **owner to confirm** it matches the certificate from the Supabase
  dashboard (Database Settings → SSL Configuration). The one-off scripts keep
  `rejectUnauthorized: false` for now.
- The pooler URL logs in as `postgres`, which bypasses RLS like the
  service-role key it replaces. Anyone holding the server's environment had
  full database access either way. A least-privilege login role would need a
  new secret: a follow-up.

**Consequence, accepted by the owner on 2026-09-30 (ADR-004 amended to a ~15/s
budget).** The cached state route made **11.39 function calls a second** with 200 phones polling every 3s (`run-C-direct.json`), against 7.07
before (`run-C.json`), which is above ADR-004's ~10/s budget. The CDN served
more fresh hits (HIT 5,811, up from 4,319; STALE 2,183, down from 3,623), yet
more refreshes reached the function. A likely reason, unproven, is that faster
answers let the CDN start more refresh cycles. At this rate the owner's
worst-case month is ~264k function calls, 26% of Hobby's 1M. Options: accept
and raise the budget, a 2-second `s-maxage`, or ISR (logged in the plan).

**CA confirmed (2026-09-30).** The pinned root was taken from the live chain,
so the owner downloaded Supabase's official certificate from the dashboard
(Database → Settings → SSL Configuration). `openssl x509 -fingerprint -sha256`
on the download printed the same SHA-256 as the pinned root, "Supabase Root 2021
CA" (80:70:25:AD:…:E6:CA:FA). Trust-on-first-use is closed.

**Amendment, A13 (2026-10-12): "no Data API access" is now explicit (migration 0017).** Every table already
had row-level security enabled and forced, no policy, and no privileges for `anon` or `authenticated`. The
Security Advisor reports the missing policy as `rls_enabled_no_policy` (INFO, 14 rows). 0017 adds one
`deny_all_public_roles` policy per table, `for all to anon, authenticated using (false) with check (false)`,
so the third layer is written down instead of implied. It cannot change what the app does: the app logs in
as `postgres`, which has `rolbypassrls = true` on Supabase (read from `pg_roles` on the test project,
Postgres 17.6; not a superuser), and a BYPASSRLS role skips row security even when it is forced on the table
(Postgres docs, "Row Security Policies"). The app's functions are `SECURITY DEFINER` and owned by `postgres`.
`using (false)` can never allow a row, and the policy is scoped to the two Data API roles, not `public`. The
same migration indexes the six foreign keys flagged by `unindexed_foreign_keys` (a Performance Advisor lint, not a security one) (`host_invites.created_by`
and `item_id` on `moderation`, `questions`, `quotas`, `responses`, `tallies`); `responses` takes one more
index entry per answer. `tests/db-advisor-clean.test.ts` fails if a table has no policy, a policy is not a
deny-all for those two roles, or one of those foreign keys loses its index. The Advisor's one remaining WARN, leaked-password protection, is accepted: ADR-015.

## ADR-007: The first release ships word cloud and poll; no quiz (2026-09-30)

Owner decision. *Amended by ADR-008: Q&A joins v1.*

- **The first release has two activities, word cloud and multiple-choice poll.**
  These are Mentimeter's core. The timed quiz moves to "later, or a community
  contribution" through the activity contract (`defineActivity`).
- **Joining is fully anonymous again.** The quiz nickname (recorded 2026-09-29,
  SPEC 8) goes with the quiz: no name of any kind is asked for in v1.
- **What already exists stays, unused and harmless:** the `scheduled` item
  state and the `opens_at`/`closes_at` window in `submit_answer` (it still
  refuses answers outside a window if one is set, tested in S3); `get_state`
  stripping secret settings until reveal (tested in S4); the phone's `Age` +
  `serverNow` clock offset (S5); the `players` table and its index. No table or
  migration is dropped.
- **Contract timing:** ADR-001 said to publish the activity contract after the
  third activity. With two in v1, `defineActivity` is extracted from word cloud
  and poll and stays internal until a third activity (possibly the quiz) proves
  it.

## ADR-008: Q&A joins v1, for the first workshop (2026-09-30)

Owner decision. Amends ADR-007.

- **v1 is word cloud, poll and Q&A.** The first workshop runs its lesson from
  Google Slides or PowerPoint (nothing to build), then a word cloud, then
  anonymous Q&A with upvotes. Q&A moves from "Out of scope" to "In scope".
- **Q&A, as built:** anyone in the room asks a question anonymously (1–280
  characters, up to 5 each, the same rate limits as answers). Each participant
  can upvote any question once and take it back. The list sorts by votes, then
  oldest first. The host can hide a question and mark it answered; answered
  questions leave the main list.
- **Same architecture, no exceptions.** Asking goes through `submit_answer`
  (a `qna` item's answer is a question). Voting is a new SECURITY DEFINER
  function, `vote_question`, reached through the existing answer route, so the
  participant cookie and its path don't change. An upvote *sets* a vote rather
  than toggling it, so a retried request can't double count or undo itself, and
  no submit id is needed. The shared cached state carries the top 40 visible,
  unanswered questions: bounded, and nothing personal.
- **The host builds a session of up to 3 activities in order** (type, question,
  and options for a poll) on `/decks`, replacing the two one-question test
  forms. The smallest step toward Milestone 3's deck editor, not the editor.
  **Later (2026-10-06):** the list now starts at 1 activity and grows to 10
  (`MAX_ACTIVITIES` in `src/lib/session-limits.ts`, and `start_session` in
  migration 0014); a poll takes 2 to 6 separate options. The server action
  checks the shape itself. Ten is the builder session's choice; the owner can
  change it in those two places.
- **The activity contract** now has a third activity. `defineActivity` is still
  not extracted; see the plan's Milestone 2 note on its two halves.

## ADR-009: MIT licence (2026-09-30)

Owner decision. Volley is released under the MIT licence, as SPEC 30 and the
Constraints already assumed. The `LICENSE` file is added once the owner confirms
the name on the copyright line.

## ADR-010: A separate test database; production changes need the owner's OK (2026-09-30)

Owner decision, taken once the app went public.

- **The London project `aib-live-db` (ref `qeheedlsskaurqshmueb`) is
  production.** Applying a migration to it, or running anything that writes to
  it (the database test suite included), needs the owner's approval, asked in
  the session that does it.
- **Tests use their own free Supabase project**, `volley-test-db` (ref
  `gzwzfjukswcifikbsufm`, London), created through the Vercel Marketplace and
  connected to no Vercel project. It is built from `db/migrations/` alone, so it
  also proves the migrations rebuild the schema from nothing. Supabase
  branching needs the Pro plan, so it isn't used. The free plan allows two
  active free projects per person, and these two use both.
- **`.env.local` holds the test project's values only.** Production's database
  settings live only on Vercel.
- **Machines, not memory, keep tests off production.** `npm test` preloads
  `tests/refuse-production.ts`, and `playwright.config.ts` checks before the
  dev server starts. Either refuses to run if any setting mentions production's
  ref. `migrate` refuses production unless given `--production`.
  `tests/production-guard.test.ts` proves each of these, and each was
  mutation-checked.
- **Vercel environments (2026-09-30, owner-approved):** `aib-live-db` is
  connected to aib-live's **Production only**; `volley-test-db` to **Preview
  and Development**. So previews and `vercel env pull` can't reach production.
  The test store names its public settings `NEXT_PUBLIC_…`, so
  `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_PUBLISHABLE_KEY` were added by hand
  to Preview and Development with the test project's values; if that store's
  keys ever rotate, update these two. Setting the dashboard framework to
  SvelteKit did not change the names.
- **Production's settings are write-only.** Moving the connection
  (disconnect, then reconnect on Production) made them `sensitive`, so they
  can't be pulled. **To migrate production** (with approval): the owner copies
  `aib-live-db`'s `.env.local` snippet from the Vercel store page into a
  git- and deploy-ignored `.env.production.local`, the session runs
  `node --env-file=.env.production.local scripts/migrate.mjs --production`,
  then deletes the file. Used this way once for a read-only check.

## ADR-011: Admins invite hosts by link (2026-09-30)

Owner decision (option (a) of the plan's "Next: the owner picks one").
Supersedes SPEC 1's "hosts are created only by `add-host`".

- **Committee members and workshop leads get their own logins without the
  terminal.** An admin types a name and email on the Hosts page (`/hosts`)
  and gets a one-time link to send by hand (WhatsApp, etc.). The invitee opens
  it, chooses their own password and display name, and is signed straight in.
  Nobody else ever sees the password. No email is sent (SPEC: no email sending).
- **Links:** 32 random bytes in the path (`/invite/<token>`); only the token's
  SHA-256 is stored (`host_invites.token_hash`). Valid 7 days, used once, and
  only for the Auth account with the invited email (`accept_host_invite` checks
  `auth.users`). A newer link for the same email replaces an older unused one.
  The page sends `Referrer-Policy: same-origin` and `no-store`. (It first sent
  `no-referrer`, which makes browsers send `Origin: null` on the page's own form
  post; SvelteKit's production CSRF check then refused every invite, on
  2026-10-01. The dev server skips that check, so the browser test now checks
  the Origin the browser actually sends.) A token in a
  path does appear in Vercel's request logs (kept about an hour on Hobby);
  accepted, because the link is single-use and short-lived, and the logs are
  the owner's.
- **Accepting is claim → set password → finish** (migration 0013). The link is
  locked and marked used before any password is set, so a link cancelled,
  expired or used by someone else meanwhile changes nothing; if setting the
  password fails, the claim is released so the link can be tried again.
- **A reset ends every older session.** `hosts.sessions_valid_after` moves on a
  reset, an accepted invite and `add-host`; the guard refuses a session cookie
  issued before it and clears it. New sessions are stamped no earlier than
  that time, so a clock difference can't refuse the session a reset just made.
  Existing hosts started at 1970, so nobody was signed out by the change.
  **Later (2026-10-06, migration 0016):** a session made in the same whole
  second as a reset was not refused, because the stamp is whole seconds and
  the guard refuses only sessions issued *before* it. The database now reports
  the stamp as the first whole second after the reset (`floor(epoch) + 1`) in
  `host_profile` and `finish_host_invite`, so a session stamped in the reset's
  own second is refused and one a second later is accepted. `add-host` needed
  no change: it stamps `now()`, and everything reads it through `host_profile`.
  Still true: the guard compares the app server's clock with the database's,
  so a gap of a second or more between them can shift that boundary.
  **Later (2026-10-06, sign-in order):** sign-in used to read the reset stamp
  *after* the password check, so a sign-in with the old password that was
  being checked while a reset landed got a session newer than the reset.
  `host-signin.ts` now reads the stamp before the password is checked and
  stamps the session no later than that moment, so a reset that lands during
  the check ends the session however long the check takes. The password is
  checked for every email, host or not, so a wrong password gets one answer
  for all emails; "That account isn't a host" is only said to someone who
  proved the password, as before.
- **Resets:** an admin can make a reset link for another host, but not for
  another admin. An admin can't reset or remove themselves, or other admins,
  on the page; the owner's own reset stays
  `npm run add-host <email>` from the terminal (with the production paste,
  ADR-010), so the owner keeps their password safe.
- **Removal** deletes the `hosts` row (the guard checks it on every request, so
  access ends at once; their decks and runs go with it), their unused links,
  and then the Auth account, best effort. A reset link for someone no longer a
  host is dead however they went.
- **Admins:** a boolean on `hosts`, set by `npm run set-host -- <email> --admin`
  (which also sets `--name` and never touches the password). Only the owner is
  an admin for now; making others admin from the page is left out.
- **Names:** every host has a display name, shown on the projector as
  "Name hosting" (`get_state.hostName`). Names are shown to the room anyway, so
  the shared state stays free of anything private.
- **Every rule lives in the database**, as elsewhere: each SECURITY DEFINER
  function checks the caller is an admin itself, so a mistake in a route can't
  widen who may invite. The app now holds Supabase's secret key at runtime
  (already on Vercel as the store's `SUPABASE_SECRET_KEY`), used only in
  `src/lib/server/invites.ts` to set passwords and delete accounts.

## ADR-012: Name, colours and logo live in one built-in file (2026-09-30)

Milestone 4 step 1, SPEC 26 and A16.

- **One file, `src/lib/brand.ts`:** the name, three colours (accent, ink,
  paper) and an optional logo path in `static/`. Chosen over environment
  variables because a copy is a fork of the repository anyway, the settings
  are typed and reviewed like code, and nothing needs the database or a
  deploy-time setting. Changing them means a redeploy.
- **Every other colour is derived** (`src/lib/theme.ts`): the softer greys,
  lines and fills are mixed from ink and paper, and button text takes
  whichever of ink or paper reads better on the accent. So three choices
  can't produce an unreadable pair unnoticed: `tests/brand.test.ts` measures
  each pair the screens use against WCAG AA and names the one that fails.
- **The default look is neutral** so a copy's own brand leads: white page,
  near-black text, a deep teal accent kept to buttons, focus rings, the most
  popular word and the poll bars; system fonts, so there is nothing to
  download or license.
- **The society's fonts (Zarathustra, Switzer) and plum were removed** from
  the template. They stay in git history for the AI Builders copy.

## ADR-013: The projector shows one Q&A question at a time, chosen by the host (2026-10-06)

Owner decision (Shahil): questions should not appear on the big screen all at
once; the host walks through them one by one. Migration 0015.

- **One question on screen, the host's choice.** The projector shows that
  question large, with its votes and a quiet "N more waiting". Before the host
  puts one up it shows only the count and an "up next" hint, never a list.
  Phones are unchanged: they still see the whole list and can upvote, plus a
  small "On screen now" on the question being shown.
- **Most votes first, read at the moment of choosing.** Next question brings,
  in this order: after a Previous, the next one in the order they were shown;
  otherwise a question that was shown and left unanswered (one hidden and then
  unhidden, say), which takes a fresh turn at the end of the history; otherwise
  the top-voted question never shown (equal votes: asked first, then lowest id).
  The question on screen does not change while votes shift or better-voted ones
  arrive; only the next pick reads the latest votes. When nothing is left, Next
  changes nothing: the last question stays on screen and is not marked answered,
  and the page says so.
- **Moving on marks the question answered.** The existing `answered` flag fits:
  an answered question already leaves the phones' list and the waiting count, so
  what has been discussed stops asking for votes. Previous goes back through the
  questions in the order they were shown and un-answers nothing; Next after a
  Previous goes forward through them again before it brings anything new.
- **Where it lives.** Two columns on `questions`: `shown_seq` (its turn: null
  until first put up, then 1, 2, 3 within the activity) and `on_screen` (at most
  one per activity of a run, by a partial unique index). The shared state gains
  `shown` ([id, text, votes], or null) and `waiting` (counted to 101 through the
  existing index, shown as "100+" above 100); the host view gains the on-screen id and each
  question's turn. Nothing personal is added; question text was already public.
- **Safe to retry.** The host's `question_next` / `question_back` go through the
  existing locked `host_action` and carry the id the host believes is on screen
  as their key. If that no longer matches (a lost reply pressed again, a second
  control tab), nothing moves and the reply says `moved: false, reason: stale`,
  so a repeat can never skip a question. At the ends the same reply says
  `none_left` or `first`, and the page says so. Hiding the question on screen
  takes it off at once and unhiding does not put it back. Each Q&A activity
  keeps its own on-screen question, so switching activity and coming back finds
  it where it was left.
- **Not done:** reordering by hand, picking a question out of order, and a
  "show this one" button per row. Next/Previous is the whole control for now.

## ADR-014: `npm run setup` and `npm run doctor` are built for an AI agent first (2026-10-07)

**Decision.** Setting up a copy is two commands, designed so an agent can run them and a
person need not read the output.

- **No prompts, ever.** Everything comes from the environment or a flag. A missing
  value is an error that names the flag or variable, never a question; with no TTY
  nothing waits.
- **`npm run doctor`** is read-only. Each check has a stable id (`env.public_names`,
  `db.region`, `db.migrations`, `auth.signup_disabled`, `hosts.first_admin`,
  `vercel.protection` …), a status (ok / fail / warn / skipped), one plain sentence and
  next actions. A next action is a command or file edit the agent can do itself, or a
  step marked `HUMAN:` with the exact place to click. Exit 0 ready; 1 the agent can fix
  something (it does that first); 2 only a person can. `--json` is the same data.
- **`npm run setup`** is idempotent. It copies `NEXT_PUBLIC_…` names to `PUBLIC_…`,
  generates the three secrets, applies migrations (0008 turns on `pg_cron`), and with
  `--first-admin-email` makes the first admin. It never replaces a value it didn't make
  without `--force` (secrets, values already on Vercel), and ends by running doctor. Vercel (`--push-vercel-env`,
  `--vercel-protection`) and Supabase (`--disable-signup`) changes happen only with their
  own flag, through the Vercel CLI for the project linked in `.vercel/`.
- **Secrets are never printed**: output says `set (64 chars)`. The env file is written
  0600. The first admin's password goes to `.volley-first-admin.txt` (0600, git- and
  deploy-ignored), and handing it over is a `HUMAN:` step. This differs from
  `add-host`, which prints the password once.
- **One list of settings** (`scripts/lib/env.ts`) drives doctor, setup and
  `.env.example`; a test greps `src/` and fails if the app reads a name that isn't in it.
- **No new dependency**: Node's own `util.parseEnv`, `pg`, `supabase-js` and the Vercel CLI.
  `add-host`, `set-host` and `migrate` now share their code with setup
  (`scripts/lib/`), so there is one way to make a host and to migrate.
- **Safety.** Setup refuses this repo's production database (the existing guard) and
  has no flag to override it. The guard runs on the final values (after `--from-env-file`
  and the renames), again before any database connection, and doctor skips its database
  checks instead of connecting. Secret files go only to paths git ignores (`.env*` except
  `.env.example`; `--env-out` refuses any other), are written to a 0600 temp file and
  renamed into place, and every report string is scrubbed of known secret values.
- **Failure behaviour.** The first admin's password file is written before the account
  is touched and removed if the account step fails. Anything that acts on an account that
  already exists (reset its password, make an existing non-admin host an admin, replace
  the password file) needs its own flag, `--reset-first-admin`. `--force` never touches the
  first admin, and `--reset-first-admin` never regenerates secrets: `--force` signs every
  host out and makes phones look new, so no printed advice for the account case may
  suggest it. `--dry-run` only reads. `--vercel-protection` rewrites only
  `all` (All Deployments), the one mode Vercel documents as covering production domains;
  the older `prod_deployment_urls_and_all_previews` and unknown modes are a warning for a
  person (`all_except_custom_domains` is ok: see the A15 amendment below). A command that needs
  a person's input (an email) is a `human` step with a separate `template` field, never a
  `run` command; a setup step only a person can fix exits 2 even if doctor says "run setup".

**Amendment after the A15 trial (2026-10-11).** Preview settings are added with an empty
git-branch argument (`vercel env add NAME preview "" --yes`; verified live in trial 2): Vercel CLI 53.0.1 in
non-interactive mode stops with `git_branch_required` unless the third argument is given, and
its own prompt says an empty branch means all Preview branches. A failed CLI call reports the
last meaningful line(s) (or its JSON message), not the first line, which is usually a hint tag
or a progress line. A push that stops part-way says what went up and what did not.
`all_except_custom_domains` (Vercel's Standard Protection, which the docs say leaves production
domains open) is ok for the site; the keep-alive cron is confirmed by a person reading its first
scheduled run. Setup also refuses to act when the Supabase addresses it holds (including
`PUBLIC_` and `NEXT_PUBLIC_SUPABASE_URL`) name different projects: nothing is written, connected to
or sent, and a person removes the stale one. Two different `PUBLIC_` and `NEXT_PUBLIC_` addresses are
refused rather than one winning.

**Confirmed live in the A15 trials** (2026-10-12, `docs/trial-A15-record-2.md`): `vercel env ls
--format json`, `vercel env add … --sensitive` over stdin for Production and Preview (the latter
with the empty branch argument above), and the project read for
`ssoProtection.deploymentType`. **Not confirmed against live services** (checked only with
fakes or the docs): `vercel env update`, the protection PATCH, the Supabase Management API
`PATCH /v1/projects/{ref}/config/auth` body (`disable_signup`), and the Vercel Supabase
store's exact `NEXT_PUBLIC_…` names (both the publishable and the older anon name are
accepted). The region table pairs Vercel and AWS regions from Vercel's region list. Doctor
reads the database region from the pooler host only.

## Exception: migration 0008 was edited after it was applied (2026-10-07)

**Rule broken.** Never edit an applied migration. **Why this once.** Running the setup trial
(reset, then setup) on the test project showed that `create extension if not exists pg_cron`
fails whenever pg_cron is already installed: Supabase has an event trigger on every
`CREATE EXTENSION pg_cron`, firing even when the statement does nothing, and it re-grants
to `postgres` with grant option, which Postgres refuses ("grant options cannot be granted
back to your own grantor"). A person who enables pg_cron in the dashboard first, which
doctor tells them to do when setup cannot create it, would then hit that error on every
setup. The migration now creates the extension only when `pg_extension` lacks it.
**Why production and test are unaffected.** Both already recorded 0008 in
`schema_migrations`, and the migrator applies each file once, so neither re-runs it; the
change only matters to a database that has not applied 0008 yet. The statement's effect on
a fresh database is the same. `tests/migration-pg-cron.test.ts` runs the file over an
installed pg_cron in a rolled-back transaction.

## ADR-015: A13 passes with one accepted warning, leaked-password protection (2026-10-12)

**Decision (owner, 2026-10-12).** Accept the Supabase Security Advisor's one WARN on `aib-live-db`,
`auth_leaked_password_protection` ("Leaked Password Protection Disabled", EXTERNAL, entity Auth), and write down
why. A13 ("no warnings") passes with that one exception. It is not an error in the code: the switch does not
exist on the free plan. Supabase's docs (https://supabase.com/docs/guides/auth/password-security): "Leaked
password protection is available on the Pro Plan and above." It makes Auth reject a password found in the
HaveIBeenPwned.org Pwned Passwords list when it is set.

**What the Advisor showed before migration 0017 reached production (owner's dashboard read, 2026-10-12):** this
WARN, plus 14 INFO `rls_enabled_no_policy` rows, one per table, which 0017 clears (ADR-006 amendment). The
dashboard's Security list did not show `unindexed_foreign_keys`: that is a lint of the **Performance** Advisor,
not a security one. 0017 still adds those six indexes. The owner's re-check of the Security list after 0017 is
not recorded here yet.

**Why accepting it is reasonable.** A leaked password matters only where a person chooses a password, and
here that is rare and guarded:
- Hosts are made only by `add-host` (a random 24-byte password, `scripts/add-host.mjs:23`) or an admin's
  invite link; there is no public sign-up. Setup's `auth.signup_disabled` check reads Supabase's setting
  and fails if sign-up is on (`scripts/lib/checks.ts`, `disable_signup`).
- The one place a person types a new password is the invite page, which requires at least 10 characters and
  at most 72 bytes (`PASSWORD_MIN`, `passwordProblem`, `src/lib/server/invite-token.ts:18`; used in
  `src/routes/invite/[token]/+page.server.ts:47`).
- Sign-in through the app is limited to 10 attempts per email and 30 per address in 15 minutes, counted
  before the password is checked (`allow_sign_in`, migration 0005; `src/routes/+page.server.ts:23`).
  A list of leaked passwords is only useful at a rate far above that.

**What these do not cover.** The app's limits apply to sign-in through the app. Someone who calls Supabase
Auth directly with the public key is limited only by Supabase's own Auth rate limits: by default 150 requests
per 5 minutes per IP on `/auth/v1/token`, password grants included, with no per-account limit
(https://supabase.com/docs/guides/auth/rate-limits, read 2026-10-12; adjustable under Authentication → Rate
Limits). The production project's own setting was not checked.
The 10-character minimum is length only: it does not stop a long, common password.

**A copy on the Pro plan can switch it on:** Supabase's docs say it is configured in the project's Auth
settings (the password-security page above). The exact dashboard path, "Authentication → Attack Protection /
Password security → Prevent use of leaked passwords", is **UNCONFIRMED**: that page does not give a menu path
and the dashboard is behind a login. Look for the "Prevent use of leaked passwords" option.

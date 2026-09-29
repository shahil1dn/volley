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

## ADR-007: The first release ships word cloud and poll; no quiz (2026-09-30)

Owner decision.

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

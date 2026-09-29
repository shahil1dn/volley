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

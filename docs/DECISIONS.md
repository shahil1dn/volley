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

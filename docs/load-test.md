# The A10 load test

SPEC A10: 200 simulated phones polling and answering for 10 minutes against a deployed preview, zero
failed submits, function calls within budget, measured numbers into ARCHITECTURE §10. This is how to run it.
The script is `scripts/load-test.ts` (`npm run load-test`); its logic is in `scripts/lib/load-*.ts`.

## What it does

One host signs in through the real form, starts a session of a word cloud, a poll and a Q&A, and steps
through them (open, close, next, Q&A question-next, end). Phones join (page, join cookie), poll the state
route every 3 s like the phone page, and answer: 1 to 3 words, one vote, 0 to 2 questions, 1 to 3 upvotes,
with the page's retry rules and one submit id per answer. A projector polls every second and the host's
control page every 2 s. 1% of replies are treated as lost and resent with the same id, to prove a resend is
stored once. At the end the host's results download is compared with what the phones were told.

## Before a run (these are Shahil's steps, not the script's)

1. **A preview deployment** connected to the TEST Supabase project (a deploy and its env settings are
   [ACCOUNT] steps). Never `aib-live.vercel.app`; the script refuses it and any deployment Vercel reports as
   production.
2. **Protection bypass.** A preview is behind Deployment Protection, so an unauthenticated script is turned
   away. Vercel's "Protection Bypass for Automation" (project Settings, Deployment Protection) creates a
   secret; send it as `x-vercel-protection-bypass`. Creating or regenerating it is a **project settings
   change** and regenerating it invalidates earlier deployments. The script reads it from
   `VERCEL_AUTOMATION_BYPASS_SECRET` and puts it on every request; it never prints it.
3. **A host on the test database:** `npm run load-host` writes `.load-test-host` (0600, git-ignored; the
   password is never printed). `npm run load-host -- --remove` deletes it afterwards.
4. `node scripts/load-test.ts --target https://<preview>.vercel.app --check-only` runs the guards and sends
   nothing.

## Reading the result

- **Failed submits** must be zero, and the four stored-count lines must match.
- **Function calls.** The script prints two counts from the responses, and **both are lower bounds**. The
  `x-vercel-cache` header shows HIT, STALE, MISS and so on, but a STALE reply starts a refresh in the
  background that no client ever sees: in S1 run A there were 52 MISS responses and 1,055 function calls in
  the runtime logs. Distinct `serverNow` values in the state bodies are closer. **The runtime logs for the
  printed window are the authority**, and Hobby keeps them for **1 hour**: pull them straight after the run
  (`vercel logs --json --since … --until …` with a `--limit` above the default 100, or the dashboard Logs
  tab filtered to the window).
- **The pass line is ADR-004's budget, not SPEC A10's "under 2 a second".** S1 measured 6.9 to 11.4 calls a
  second with 200 phones (ADR-004, amended to about 15 a second); "under 2" was already failed and
  superseded. The report prints both lines. SPEC A10's wording needs the owner's OK to change.
- Latency is measured from the machine running the script; the report prints that machine's event-loop lag.

## What can stand in the way

- **Per-IP limits in the app** (all 200 phones share one address): answers and votes are counted per
  address, 2,000 per 10 s window (migration 0004), and per run, 600 per 10 s. A realistic spread stays far
  under both; a burst where every phone sends three words inside 10 s reaches exactly 600. Every call counts,
  retries included. Nothing was loosened. Sign-in allows 10 attempts per email and 30 per address in 15
  minutes: one sign-in per run, but repeated runs inside 15 minutes share the budget.
- **Vercel's own protection** against floods from one address is not documented with numbers. A bypass secret
  does not override active DDoS mitigation. Watch for 403 and 429 in the report's status columns.
- **Supabase free plan:** Nano compute, 60 direct connections, 200 pooler clients. The app holds 3
  connections per function instance (`POOL_MAX`), each instance counts against the 200.

## Sources (read 2026-10-12; UNCONFIRMED where marked)

- Deployment Protection and Standard Protection: https://vercel.com/docs/deployment-protection
- Protection Bypass for Automation (all plans; header, env var, cookie option):
  https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation
- Get a deployment by id or URL (`target`: production, staging or null; `alias`):
  https://vercel.com/docs/rest-api/deployments/get-a-deployment-by-id-or-url
- `x-vercel-cache` values: https://vercel.com/docs/headers/response-headers and
  https://vercel.com/docs/caching/cache-status. STALE regenerates in the background; that refresh is an
  invocation: https://vercel.com/kb/guide/optimize-function-invocations
- Runtime logs, Hobby retention 1 hour: https://vercel.com/docs/logs/runtime; CLI: https://vercel.com/docs/cli/logs
- Hobby allowances (1M function invocations, 4 h active CPU, 1M CDN requests, 100 GB fast data transfer):
  https://vercel.com/docs/limits/fair-use-guidelines and https://vercel.com/docs/pricing. A per-IP or
  per-deployment request-rate limit: UNCONFIRMED, none is documented there.
- Supabase compute, connection and pooler limits: https://supabase.com/docs/guides/platform/compute-and-disk,
  https://supabase.com/docs/guides/database/connection-management. The default pooler pool size on the free
  plan: UNCONFIRMED (the dashboard's Database Settings shows it).
- The run needs about 41,000 polls plus a few thousand answers: about 4% of the monthly CDN requests and under
  1% of the monthly function invocations at the measured call rates.

## A13: the Security Advisor

Ways to get its list: the dashboard (Advisors, Security) is a person step; the Management API
`GET /v1/projects/{ref}/advisors/security` needs a Supabase access token (experimental endpoint,
https://supabase.com/docs/reference/api/v1-get-security-advisors); Supabase publishes the lints as SQL,
`splinter.sql` in https://github.com/supabase/splinter, which reads only the catalogues and runs in one
transaction (`psql -X -1`). That repository shows **no licence file**, so its SQL is not copied into this
repo. The lints that need project settings (such as anonymous sign-ins) exist only in the dashboard and API.

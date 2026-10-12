# A10 load test: measured results

**A10 PASSED, 2026-10-12.** This file owns the measured numbers. ARCHITECTURE §10 uses them for the
free-tier budget and points here; `docs/volley-plan.md` ticks A10 and points here. How to run the test again
is `docs/load-test.md`.

What was run: `scripts/load-test.ts` (200 simulated phones, polling every 3 s like the phone page, answering
with the page's retry rules, a projector polling every second, a host polling every 2 s) against one Vercel
preview, `dpl_DcmoiEqygBVouJw7tUkCZcNnxUfg`, in `lhr1`, on the **test** Supabase database. Not production.
Hobby keeps runtime logs for an hour, so the windows below are the record: the logs they point at can no
longer be pulled.

## Pass line

ADR-004's budget (as amended 2026-09-30): about **15 state-route function calls a second**, plus the answers
a second. SPEC A10 points at it. Zero failed submits and every stored count matching what the phones were
told are also required.

## The two runs

| | Run 1 | Run 2 |
|---|---|---|
| Length | 10 minutes | 4 minutes |
| Measured window (first activity opened to last closed) | 2026-10-12T00:09:08.512Z to 00:19:09.123Z (600.6 s) | 2026-10-12T00:24:43.234Z to 00:28:43.548Z (240.3 s) |
| Seed | 239067982 | 378874967 |
| Submits | 1,204, stored 1,204, **failed 0** | 1,171, stored 1,169, **failed 0** |
| Refused by rule (upvote on a question the host had just answered, HTTP 409) | 0 | 2 |
| Lost replies resent with the same id | 13, each stored once | 9, each stored once |
| "Slow down" notices | 0 | 0 |
| Answers a second | 2.00 | 4.86 |
| Stored counts: words, votes, questions, upvotes | 404/404, 200/200, 215/215, 385/385 | 377/377, 200/200, 231/231, 361/361 |
| State requests in the window, a second | 40,627, 67.64 | 16,254, 67.64 |
| State requests answered from the cache (header HIT or STALE) | 40,627 of 40,627 | 16,254 of 16,254 |
| Distinct state versions that reached a phone (`serverNow`) | 6,323 = 10.53 a second | 2,599 = 10.82 a second |
| Event-loop lag on the test machine, p99 / max | 12 ms / 27 ms | 13 ms / 22 ms |
| Result | **PASS** | **PASS** |

Latency from the machine running the script (milliseconds):

| Route | Run 1 requests | p50 / p95 / max | Run 2 requests | p50 / p95 / max |
|---|---|---|---|---|
| state | 41,326 | 32 / 113 / 794 | 16,946 | 30 / 46 / 3,214 |
| answer | 1,217 | 43 / 123 / 361 | 1,180 (1,178 ok, 2 refused 409) | 40 / 64 / 274 |
| page | 200 | 47 / 207 / 769 | 200 | 40 / 76 / 466 |
| join | 200 | 38 / 117 / 565 | 200 | 36 / 54 / 87 |
| host-view | 314 | 46 / 128 / 224 | 133 | 44 / 73 / 142 |
| host-action | 16 | 48 / 168 / 168 | 16 | 43 / 67 / 67 |
| sign-in | 1 | 858 | 1 | 468 |
| export | 1 | 40 | 1 | 52 |

Every response was a 2xx or a 303, apart from run 2's two 409s. One state request in run 2 took 3.2 s; it is
the slowest request of either run and the only one over a second.

## Function calls: how they were counted, and why it is a range

The response header `x-vercel-cache` does **not** give the number. A STALE reply is served from the cache
while a refresh runs in the background, and no client ever sees that refresh; in S1 there were 52 MISS
responses and 1,055 function calls in the logs. So the test's own count (headers: zero MISS on the state
route) is a floor, not a result.

The authority is Vercel's runtime logs for the window. Found on this run (Vercel CLI 53.0.1):

- Following the logs (`vercel logs <url>`, the way the S1 runs did it) shows only what the app prints. The
  app prints nothing, so the stream stayed empty ("waiting for new logs...").
- A historical read (`--no-follow --since --until --json`) returns one **request row** per request, each with
  a `cache` field, at most **50 rows a call** whatever `--limit` says. Background refreshes have no row of
  their own (asked for `cache:REVALIDATED`, `PRERENDER`, `BYPASS`: 0 rows). `--query "cache:MISS"` and
  `"cache:STALE"` filter. Paging backwards (next `--until` = oldest timestamp + 1 ms, rows deduplicated by
  id) reaches every row. `npm run load-logs` does this (checked live against the run-2 window: same counts as the hand-made pager).

So the state route's function calls lie between two numbers:

- **At least** the distinct state versions that reached a phone: each is one function run (10.82 a second in
  run 2).
- **At most** every state row that was MISS or STALE: a MISS is a foreground call, and each STALE starts at
  most one background refresh (Vercel's guide to optimising function invocations). There were no state MISS rows.

Run 2, full count from the logs (the 240.3 s window):

| Cache value in the log | Rows | Of which state | Rest |
|---|---|---|---|
| MISS | 1,323 | 0 | answer 1,180 + host 143 |
| STALE | 3,341 | 3,341 | none |

The 1,180 answer rows equal the 1,180 answer requests the script sent, which is the check that the paging
lost no rows.

| | State calls a second | Budget plus answers (15 + 4.86) |
|---|---|---|
| Lower bound (run 2) | 10.82 | within |
| **Upper bound (run 2)** | **13.92** (3,341 / 240.3 s) | within, 1.08 a second under the budget before adding answers |
| Run 1 | at least 10.53; **upper bound not counted** | the logs were paged for run 2 only |

Other function calls in run 2: answers 4.9 a second and host pages 0.6 a second.

## What this proves, and what it does not

- The edge cache works at 200 phones: every state request was answered from the cache (header HIT or STALE),
  and the function ran between 10.5 and 13.9 times a second, under ADR-004's 15. Whether that rate stays flat
  with more than 200 phones was not tested.
- Run 1's upper bound is not measured. Its lower bound (10.53 a second) is in line with run 2's.
- The tests ran from one machine, so all 200 phones shared one address. The app's per-address limits were
  not tripped (0 "slow down" notices).
- **Not measured:** Vercel Active CPU, bytes transferred, and Supabase egress. The test records neither.
  ARCHITECTURE §10 keeps those as estimates, now scaled from these call counts.
- Vercel's own flood protection and the monthly allowances were not tested; the run used a small fraction
  of the allowances (about 58,000 state requests and 2,400 answers across both runs).

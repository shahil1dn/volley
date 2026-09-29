# Volley architecture

How Volley is put together, drawn out. Decisions behind it are in
`docs/DECISIONS.md`; what the first release does is in `SPEC.md`.

## 1. The system

Everything runs in London. Phones and the projector never talk to the database
directly and never hold a live connection: they read one shared, cached state
response and send answers through the server.

```mermaid
flowchart LR
  subgraph Room["The room"]
    P["Phones<br/>(up to 200)"]
    PR["Projector<br/>(host laptop)"]
    HC["Host control<br/>(laptop or phone)"]
  end

  subgraph Vercel["Vercel, London (lhr1)"]
    CDN["CDN cache<br/>state cached 1s"]
    FN["SvelteKit server routes<br/>thin front desk"]
  end

  subgraph Supabase["Supabase, London (eu-west-2)"]
    RPC["Postgres functions<br/>all rules live here"]
    DB[("Tables")]
    CRON["pg_cron<br/>hourly clean-up"]
    AUTH["Supabase Auth<br/>host passwords"]
  end

  P -- "GET state (every 1-3s)" --> CDN
  PR -- "GET state (every 1s)" --> CDN
  CDN -- "cache miss or stale refresh: under 10 a second (§10)" --> FN
  P -- "POST answer" --> FN
  HC -- "POST next / open / hide / end" --> FN
  FN -- "one function call per request" --> RPC
  RPC --> DB
  CRON -- "delete runs 24h after end" --> DB
  HC -. "sign in" .-> AUTH
```

## 2. The participant's journey

```mermaid
flowchart TD
  A["Scan QR or type code"] --> B{"Run exists<br/>and not ended?"}
  B -- no --> X["'This session has ended'"]
  B -- yes --> C["Server issues signed participant token<br/>(cookie, no account, no name)"]
  C --> D["Waiting screen<br/>polls shared state every 3s"]
  D --> E{"Current activity<br/>open?"}
  E -- no --> D
  E -- yes --> F{"Quiz?"}
  F -- yes --> G["Optional nickname,<br/>countdown on server time"]
  F -- no --> H["Answer form"]
  G --> H
  H --> I["Submit with one-time id"]
  I --> J{"Accepted?"}
  J -- "yes" --> K["'Sent' + answers left<br/>(kept on the phone)"]
  J -- "limit reached / closed / too fast" --> L["Plain-English reason"]
  J -- "network dropped" --> M["Retry same id<br/>(stored once, never twice)"]
  M --> J
  K --> D
  L --> D
```

## 3. The host's journey

```mermaid
flowchart TD
  A["Sign in (password)"] --> B{"On approved<br/>host list?"}
  B -- no --> X["Refused"]
  B -- yes --> C["My decks"]
  C --> D["Build or edit a deck<br/>forms generated from each activity's settings"]
  D --> C
  C --> E["Start a run<br/>gets a join code + QR"]
  E --> F["Projector view on the big screen"]
  E --> G["Host control view"]
  G --> H{"Action"}
  H -- "open / close answers" --> G
  H -- "next / back" --> G
  H -- "hide a word" --> G
  H -- "freeze input (panic)" --> G
  H -- "end" --> I["Ended: results frozen"]
  I --> J["Export PNG / CSV"]
  I --> K["Auto-deleted 24h later<br/>deck itself is kept"]
```

## 4. Run and activity states

A run is one live showing of a deck. Only the server moves it between states.

```mermaid
stateDiagram-v2
  [*] --> lobby: host starts run
  lobby --> live: host opens first activity
  live --> live: next / back
  live --> frozen: freeze input
  frozen --> live: unfreeze
  live --> ended: host ends
  frozen --> ended: host ends
  lobby --> ended: host ends
  ended --> [*]: deleted 24h after end
  lobby --> [*]: deleted after 24h idle
  live --> [*]: deleted after 24h idle
```

```mermaid
stateDiagram-v2
  [*] --> closed
  closed --> scheduled: host opens (quiz)
  scheduled --> open: start time reached (~3s)
  closed --> open: host opens (word cloud, poll)
  open --> closed: host closes / quiz timer ends
  closed --> revealed: host reveals (quiz answer, results)
  revealed --> [*]
```

## 5. The database

Decks are the host's content and are kept. Everything under `runs` is
participant data and is deleted 24 hours after the run ends.

```mermaid
erDiagram
  hosts ||--o{ decks : owns
  decks ||--|{ deck_items : "ordered list of"
  decks ||--o{ runs : "shown as"
  runs ||--o{ responses : receives
  runs ||--o{ tallies : "counts into"
  runs ||--o{ quotas : "limits via"
  runs ||--o{ moderation : "hides via"
  runs ||--o{ players : "quiz scores"

  hosts {
    uuid user_id PK "= auth.users.id"
    text email
    timestamptz created_at
  }
  decks {
    uuid id PK
    uuid host_id FK
    text title
    timestamptz updated_at
  }
  deck_items {
    uuid id PK
    uuid deck_id FK
    int position "unique per deck"
    text type "word_cloud | poll | quiz"
    jsonb settings "validated by the activity's schema"
  }
  runs {
    uuid id PK
    uuid deck_id FK
    text code UK "5 chars, no 0/O/1/I"
    text status "lobby | live | frozen | ended"
    int current_position
    text item_state "closed | scheduled | open | revealed"
    timestamptz opens_at "quiz: server-scheduled start"
    timestamptz closes_at
    bigint version "bumped on every change"
    timestamptz last_activity_at
    timestamptz ended_at
  }
  responses {
    bigint id PK
    uuid run_id FK
    uuid item_id
    uuid participant_id
    uuid submit_id "unique with participant: retry-safe"
    text value
    timestamptz received_at "server clock"
  }
  tallies {
    uuid item_id PK
    text key PK "word or option"
    uuid run_id FK
    int count
    bool hidden
  }
  quotas {
    uuid item_id PK
    uuid participant_id PK
    uuid run_id FK
    int used
  }
  moderation {
    bigint id PK
    uuid run_id FK
    uuid item_id
    text key
    text action "hide | unhide"
    timestamptz created_at
  }
  players {
    uuid run_id PK
    uuid participant_id PK
    text nickname
    int score
  }
```

Not shown: `rate_limits` (an **unlogged** table of per-IP-hash counters. It
skips the write-ahead log because losing it in a crash costs nothing).

**Why `tallies` exists.** Counting raw `responses` on every read would scan every
answer every second. Instead each accepted answer adds one to its tally row in the
same transaction, so reading the cloud is a small indexed read of already-counted
rows, whatever the number of answers.

## 6. Sending an answer

One request, one database call, one transaction. Every rule is checked inside it,
so two phones submitting at the same instant cannot sneak past a limit.

```mermaid
sequenceDiagram
  autonumber
  participant Ph as Phone
  participant Fn as SvelteKit route
  participant Db as Postgres: submit_answer()

  Ph->>Fn: POST /api/r/{code}/answer {submitId, value}<br/>cookie: signed participant token
  Fn->>Fn: verify token signature, check shape, hash IP
  Fn->>Db: submit_answer(code, participant, submitId, value, ipHash)
  Note over Db: single transaction
  Db->>Db: rate limit: upsert counter, reject if over
  Db->>Db: run live, not frozen, item open, now() within opens_at..closes_at?
  Db->>Db: insert response ON CONFLICT (participant, submit_id) DO NOTHING
  alt repeat of an earlier submit
    Db-->>Fn: {status: "duplicate", left}
  else new submit
    Db->>Db: quota: upsert used+1 WHERE used < limit
    alt limit reached
      Db-->>Fn: {status: "limit"} (whole transaction rolled back)
    else within limit
      Db->>Db: tally +1, quiz score if correct, runs.version +1
      Db-->>Fn: {status: "ok", left, score?}
    end
  end
  Fn-->>Ph: 200 {status, left}
```

## 7. Reading state: why 200 phones cost a few calls a second

```mermaid
sequenceDiagram
  participant P1 as Phone 1
  participant P2 as Phones 2..200
  participant PR as Projector
  participant CDN as Vercel CDN
  participant Fn as SvelteKit route
  participant Db as Postgres: get_state()

  P1->>CDN: GET /api/r/{code}/state
  CDN->>Fn: cache miss
  Fn->>Db: get_state(code)
  Db-->>Fn: {version, item, tallies top 100, serverNow}
  Fn-->>CDN: 200, Cache-Control: s-maxage=1, stale-while-revalidate=60
  CDN-->>P1: state
  P2->>CDN: same URL within the second
  CDN-->>P2: cached copy (no function call, no database call)
  PR->>CDN: same URL
  CDN-->>PR: cached copy
  Note over P1,Db: The response is identical for everyone, never personal.<br/>What a phone has sent lives on the phone,<br/>and the answer response returns "answers left".
```

The state never includes a quiz's correct answer before the host reveals it.

## 8. A fair timed quiz without live connections

```mermaid
sequenceDiagram
  participant H as Host control
  participant Db as Postgres
  participant CDN as Cached state
  participant P as Phones
  participant PR as Projector

  H->>Db: open_item() for a quiz question
  Db->>Db: opens_at = now() + 3s, closes_at = opens_at + limit
  P->>CDN: poll (every 1s while a quiz is running)
  CDN-->>P: question + opens_at + closes_at + serverNow
  PR->>CDN: poll
  CDN-->>PR: same
  Note over P,PR: Each device works out its clock offset from serverNow,<br/>shows 3-2-1, then counts down to closes_at on server time.
  P->>Db: answer (via server route)
  Db->>Db: accept only if opens_at <= now() <= closes_at + grace
  Db->>Db: speed band from received_at - opens_at (4 coarse bands)
  H->>Db: reveal
  Db->>CDN: next state carries correct answer + leaderboard
```

Because every device waited out the same scheduled start, a phone that polled
0.9s later still saw the question before it opened. Speed is measured on the
server's clock, never the phone's.

## 9. Where data goes, and when it leaves

```mermaid
flowchart LR
  A["Run started"] --> B["Answers stored<br/>(no names, no emails)"]
  B --> C["Run ended<br/>or 24h idle"]
  C --> D["Host exports PNG / CSV<br/>(optional)"]
  C --> E["pg_cron hourly job<br/>deletes run 24h later"]
  E --> F["Run, responses, tallies,<br/>quotas, players, moderation gone<br/>(one cascade delete)"]
  G["Deck"] -. "kept until host deletes it" .-> G
```

## 10. Query catalogue and free-tier budget

Every request makes **at most one database call**, and every call is served by
an index.

| Request | Database call | Rows touched | Index |
|---|---|---|---|
| Phone or projector reads state | `get_state(code)` on cache miss only | 1 run, 1 item, ≤100 tallies, ≤10 players | `runs(code)` unique, `tallies(item_id, count desc)`, `players(run_id, score desc)` |
| Phone sends an answer | `submit_answer(...)` | 1 rate row, 1 response, 1 quota, 1 tally, 1 run | primary keys, `responses(participant_id, submit_id)` unique |
| Phone joins | none (token signed by the server) | 0 | – |
| Host action (open, next, hide, end) | one function per action | 1 run, plus the item's tallies for hide | primary keys |
| Host opens decks | `list_decks(host)` | the host's decks | `decks(host_id, updated_at desc)` |
| Hourly clean-up | `delete from runs where ...` | expired runs, cascading | `runs(ended_at)`, `runs(last_activity_at)` |

**One 200-person, 60-minute event, phones polling every 3s.** Measured rows
come from S1 (`docs/volley-plan.md`); the budget they're held to is ADR-004.

| Budget (free) | Usage | Measured or estimated | Why |
|---|---|---|---|
| Vercel function calls, 1M/month | ~25,000 | **measured**: 6.9 state calls/s (S1 run B) × 3,600s | the CDN doesn't merge stale refreshes for function responses (ADR-004) |
| | + ~600 | estimated | answers and host actions |
| Vercel Active CPU, 4h/month | a few minutes | estimated | thin handlers, mostly waiting on the database |
| Vercel data transfer, 100 GB/month | ~0.5 GB | estimated | 200 phones × 1,200 polls × ~2 KB |
| Supabase database, 500 MB | < 5 MB per event | estimated | deleted after 24h |
| Supabase egress, 5 GB/month | ~50 MB | estimated from the measured call count | ~25,000 state reads × ~2 KB |
| Supabase realtime | 0 | by design | not used |

At 1s polling the measured rate is 8.8 calls/s (S1 run A), about 32,000 an
hour. The S1 runs lasted 2 minutes. The 10-minute load check in `SPEC.md` (A10)
replaces the remaining estimates.

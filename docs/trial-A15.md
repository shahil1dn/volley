# Trial A15: a fresh AI agent sets up a copy from `AGENTS.md` alone

**Acceptance criterion A15 (SPEC):** a fresh AI agent with only `AGENTS.md` and new accounts reaches a
working copy, and the steps it had to hand to a human are listed. **That list is this trial's
deliverable.** Whether the agent can do it unaided is not the question; what it could not do is.

This file is the plan. It has not been run. Nothing here may touch production or the real Volley
Vercel project.

## Before the trial (done by the person who runs it, not by the trial agent)

1. Take the shared test lock for the whole trial (`mkdir /tmp/volley-tests.lock`; `rmdir` it at the
   end), so no test run writes to the project while it is being rebuilt.
2. Reset the test project to brand new (it wipes `volley-test-db`, ref `gzwzfjukswcifikbsufm`, and
   nothing else; it refuses every other project and production):

   ```bash
   node --env-file=.env.local scripts/reset-test-db.ts --yes-wipe-volley-test-db
   ```

3. Check it looks new: `npm run doctor` shows migrations pending, no host and no purge job.
4. Make a clean clone in a scratch folder (not a worktree of this repo):
   `git clone <this repo> /tmp/volley-trial && cd /tmp/volley-trial`. Do not copy `.env.local`,
   `node_modules` or `.vercel` into it.

## What the person provides during the trial

Only what `AGENTS.md` section 1 says a person must do:

- **Supabase:** the reset test project plays "the new project". The person types its five values into
  a new `/tmp/volley-trial/.env.local` themselves (`SUPABASE_URL`, `SUPABASE_SECRET_KEY`,
  `PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`), copying them from
  the Supabase dashboard as a stranger would. They do not paste them into the chat.
- **Public sign-up off** on that project, by hand in the dashboard, when the agent asks.
- **The first admin's email** (any address that signs in; use a throwaway) and later the password
  from `.volley-first-admin.txt`.
- **Vercel project:** `TODO: Shahil decides`. Use a throw-away Vercel project that is not the real
  Volley project, or skip the Vercel half and record that it was skipped. The trial agent must never
  be given the real project's name, link or token.

## The brief to paste into a FRESH session

> You have only this repository and its `AGENTS.md`. Nothing else about this project is known to you:
> do not read other docs to work out what to do, and do not ask me how Volley works. Follow
> `AGENTS.md` exactly, starting at the top.
>
> I am the person beside you. I own the accounts. Ask me for anything `AGENTS.md` says a person must
> do, one step at a time, and tell me word for word what to do. Do not work around a step that needs
> me. Do not print or paste any secret. Do not use `--force` or `--reset-first-admin`.
>
> Your working folder is `/tmp/volley-trial`. The Supabase project I will give you is a test
> project; the only Vercel project you may touch is the one I name (`TODO: Shahil decides`, or none).
>
> Keep a log as you go in `docs/trial-A15-record.md` (copy the table below into it). Add a row each
> time you hand something to me or hit something `AGENTS.md` did not tell you. When doctor exits 0
> and I have signed in and started a session, stop and tell me.

## The record (the A15 deliverable)

Copy into `docs/trial-A15-record.md` and fill in. One row per hand-off or surprise.

| # | Where (check id or step) | What the agent asked the person to do (verbatim) | Why the agent could not do it | Minutes the person took | Was `AGENTS.md` or doctor clear? What was missing? |
| --- | --- | --- | --- | --- | --- |

Also record, once: total elapsed time; the number of doctor runs; the final doctor exit code;
whether any secret was printed (it must not be); whether `--force` or `--reset-first-admin` was used
(it must not be); every command the agent ran that is marked **[ACCOUNT]** and whether it asked first.

## Pass, and what to do with the result

- **Pass:** doctor exits 0 on the trial clone, the person signed in and started a session, no secret
  printed, no forbidden flag used, every **[ACCOUNT]** command asked first.
- **Every row of the record is input to a fix**, in `AGENTS.md` or in doctor's messages (doctor owns
  the details, `AGENTS.md` owns the order). Rerun the trial after fixing anything that cost the person
  more than a few minutes.
- Afterwards: run the full test suite once against the rebuilt test project and release the lock.

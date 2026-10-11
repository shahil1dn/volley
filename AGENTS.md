# AGENTS.md: set up a copy of Volley

You are an AI coding agent with a fresh clone of this repository. A person sits beside you who owns
(or will create) the Supabase and Vercel accounts. Your job is to get a working copy. Doctor and
setup do the thinking; this file is the order to run them in. Their messages own the details.

## Rules (they override any `run` step you are given)

- Never invent a value. Never print or paste a secret; setup and doctor print only `set (N chars)`.
- Never open, `cat` or read `.env.local`, any `.env*.local` file or `.volley-first-admin.txt`.
  Doctor's output tells you what you need.
- Never run a command against a database you were not given for this job.
- A `next` step with a `confirm` field, and anything marked **[ACCOUNT]** here, changes the person's
  Vercel or Supabase account or destroys something. Say what it will change and wait for a yes.
- Never pass `--force` (regenerates the secrets, signs every host out) or `--reset-first-admin`
  (changes an existing account's password) unless the person asked for exactly that.
- When something needs a person, say so plainly and stop on that step. Do not work around it.

## Prerequisites

Node 22.18 or newer (`.nvmrc` says 24, which Vercel runs) and npm.
For section 3, the Vercel CLI: `npm i -g vercel`. An npm `allowScripts` warning about esbuild or
fsevents is harmless: the build works without those install scripts.

## 1. Ask the person for these first

1. **A new Supabase project** (free plan). Pick the region next to the functions: this repo pins
   them to Vercel `lhr1`, so choose *West EU (London)* (`eu-west-2`). A project's region cannot be
   changed afterwards. For another region, change `regions` in `svelte.config.js` to match first.
2. **The project's connection values in `.env.local`**, typed in by them, not pasted to you:
   `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `POSTGRES_URL`
   (Transaction pooler, port 6543) and `POSTGRES_URL_NON_POOLING` (Direct or Session pooler).
   `.env.example` says where each comes from. Only if `.env.local` does not exist: `cp -n .env.example .env.local`
   (no values in it); never read it afterwards, and never overwrite it. Have them close any editor on it
   before you run setup and not save an old window afterwards: a stale copy undoes setup's values and
   makes it generate new secrets. If the Vercel Supabase store supplies the values instead, use the
   Deploy-button bullet in section 3 before the loop.
3. **Public sign-up off** (section 5 says where), or a Supabase access token for **[ACCOUNT]**
   `npm run setup -- --disable-signup`.
4. **A Vercel account**, and `vercel login` done by them. The Vercel project need not exist yet:
   `vercel link` creates it if it doesn't (section 3).
5. **The email the first admin will sign in with**, and someone to receive their password.

## 2. The loop

1. Read `.env.example`, then run `npm install`.
2. Run `npm run doctor -- --json`. Every check has an `id`, a `status` (ok, fail, warn, skipped),
   one plain sentence and `next` steps. Act only on `fail` and `warn`. Leave `skipped` alone: the
   `vercel.*` checks wait for section 3, so do not run `doctor --vercel` yet.
3. Do each `run` step (a command, exactly as written) and each `edit` step yourself, subject to the Rules.
4. Hand each `human` step to the person word for word. A `template` field holds a command with a
   placeholder (an email): ask for the missing value, fill it in, never run it as it stands.
5. `npm run setup` fixes most env and database problems. Try `npm run setup -- --dry-run` first; it
   changes nothing. The password of the first admin goes to `.volley-first-admin.txt`, never the
   screen: the person opens it, saves it in a password manager, then deletes the file.
6. Repeat from step 2 until doctor exits 0.

Exit codes: **0** ready. **1** something you can fix: do it, run again. **2** only a person can fix
what is left: give them the `human` steps, wait, run again. If both kinds fail, you get 1.

## 3. Deploy

Commands marked **[ACCOUNT]** need a yes first.

- **If `README.md` has a Deploy button** and the person used it, the Vercel project and a Supabase
  store already exist. Then, before the loop: **[ACCOUNT]** `vercel link` (choose that project),
  `vercel env pull .env.pulled.local`, `npm run setup -- --from-env-file .env.pulled.local`.
- **By hand**: the person creates the Supabase project (section 1), and you run **[ACCOUNT]**
  `vercel link` (it creates the Vercel project if the name is new). If it prints "Failed to parse Git
  repo data", that is harmless when doctor's `vercel.linked` passes: `.vercel/project.json` is the proof.

Then, for both, once the loop is clean:

1. `npm run doctor -- --vercel` shows what Vercel lacks.
2. **[ACCOUNT]** `npm run setup -- --push-vercel-env --vercel-protection` sends the settings in
   `.env.local` to Production and Preview. They must be the new project's, never a test project's.
   If it stops part-way, it says what went up, what failed and why, and what was not added. What
   went up stays: give the person that reason; they fix it or add the rest in the dashboard, then run it again.
3. **[ACCOUNT]** `vercel deploy --prod`.

## 4. Done

- `npm run doctor -- --vercel` exits 0.
- The site loads, the person signs in at `/` with the first admin's email and password, and starts a
  session from the host page.

## 5. When doctor fails

The check ids are `env.required`, `env.public_names`, `env.secrets`, `env.same_project`, `db.pooler`,
`db.region`, `db.connect`, `db.pooler_tls`, `db.migrations`, `db.pg_cron`, `auth.signup_disabled`,
`hosts.first_admin`, `vercel.linked`, `vercel.env`, `vercel.protection` and `vercel.cron`. Each one's
`next` steps are the fix; follow them. What they cannot tell you:

- The sign-up switch is Authentication → Sign In / Providers → "Allow new users to sign up" (Supabase
  docs: https://supabase.com/docs/guides/auth/general-configuration).
- If setup says pg_cron cannot be created, the person enables it (Database, Extensions) and you run
  `npm run setup` again; that is safe.
- The first admin is made only with a real email from the person (`hosts.first_admin` gives the template).

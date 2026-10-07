# AGENTS.md: set up a copy of Volley

You are an AI coding agent with a fresh clone of this repository. A person sits beside you who owns
(or will create) the Supabase and Vercel accounts. Your job is to get a working copy. Doctor and
setup do the thinking; this file is the order to run them in. Their messages own the details.

## Rules

- Never invent a value. Never print or paste a secret; setup and doctor print only `set (N chars)`.
- Never run a command against a database you were not given for this job.
- Never pass `--force` (regenerates the secrets, signs every host out) or `--reset-first-admin`
  (changes an existing account's password) unless the person asked for exactly that.
- A command marked **[ACCOUNT]** changes the person's Vercel or Supabase account. Say what it will
  change and wait for a yes before running it.
- When something needs a person, say so plainly and stop on that step. Do not work around it.

## 1. Ask the person for these first (they can do all of it in one sitting)

1. **A new Supabase project** (free plan). Pick the region next to the functions: this repo pins
   them to Vercel `lhr1`, so choose *West EU (London)* (`eu-west-2`). A project's region cannot be
   changed afterwards. For another region, change `regions` in `svelte.config.js` to match first.
2. **The project's connection values in `.env.local`**, typed in by them, not pasted to you:
   `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `POSTGRES_URL`
   (Transaction pooler, port 6543) and `POSTGRES_URL_NON_POOLING` (Direct or Session pooler).
   `.env.example` says where each comes from. If the Vercel Supabase store supplies them, see section 3.
3. **Public sign-up off**: Supabase dashboard, Authentication, Sign In / Providers, turn off
   "Allow new users to sign up". (Or give a Supabase access token and use `--disable-signup`.)
4. **A Vercel account**, and `vercel login` done by them.
5. **The email the first admin will sign in with**, and someone to receive their password.

## 2. The loop

1. Read `.env.example`, then run `npm install`.
2. Run `npm run doctor -- --json`. Every check has an `id`, a `status` (ok, fail, warn, skipped),
   one plain sentence and `next` steps.
3. Do each `run` step (a command, exactly as written) and each `edit` step yourself.
4. Hand each `human` step to the person word for word. A `template` field holds a command with a
   placeholder (an email): ask for the missing value, fill it in, never run it as it stands.
5. `npm run setup` fixes most env and database problems. Try `npm run setup -- --dry-run` first;
   it changes nothing. Make the first admin with `npm run setup -- --first-admin-email <EMAIL>`.
   The password goes to `.volley-first-admin.txt`, never the screen. The person reads it, saves it
   in a password manager, then deletes the file.
6. Repeat from step 2 until doctor exits 0.

Exit codes: **0** ready. **1** something you can fix: do it, run again. **2** only a person can fix
what is left: give them the `human` steps, wait, run again. If both kinds fail, you get 1.

## 3. Deploy

Either path ends the same way. Commands marked **[ACCOUNT]** need a yes first.

**With the Deploy button** (in `README.md`): the person clicks it. It clones the repo, creates the
Vercel project and a Supabase store. Then, in your clone:

1. **[ACCOUNT]** `vercel link` (choose that project).
2. `vercel env pull .env.pulled.local`, then `npm run setup -- --from-env-file .env.pulled.local`.

**By hand**: the person creates the Supabase project (section 1) and a Vercel project, and you run
**[ACCOUNT]** `vercel link`.

Then, for both:

3. `npm run doctor -- --vercel` shows what Vercel lacks.
4. **[ACCOUNT]** `npm run setup -- --push-vercel-env --vercel-protection` sends the settings in
   `.env.local` to Production and Preview. They must be the person's new project's, not a test one.
5. **[ACCOUNT]** `vercel deploy --prod`.

## 4. Done

- `npm run doctor` exits 0 (with `--vercel` after deploying).
- The site loads, the person signs in at `/` with the first admin's email and password, and starts a
  session from the host page.

## 5. When doctor fails

| Check id | Usually |
| --- | --- |
| `env.required`, `env.public_names`, `env.secrets` | `npm run setup` |
| `env.same_project` | the three Supabase values came from different projects; person fixes `.env.local` |
| `db.pooler`, `db.region` | wrong connection string, or wrong region (section 1) |
| `db.connect`, `db.pooler_tls` | the address or password is wrong; the person copies it again |
| `db.migrations`, `db.pg_cron` | `npm run setup`; if pg_cron cannot be created, the person enables it (Database, Extensions) |
| `auth.signup_disabled` | person step 3 above |
| `hosts.first_admin` | `npm run setup -- --first-admin-email <EMAIL>` with their email |
| `vercel.linked`, `vercel.env`, `vercel.protection` | section 3 |
| `vercel.cron` | an `edit` to `vercel.json` |

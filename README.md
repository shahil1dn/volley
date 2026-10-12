# Volley

Live word clouds, polls and Q&A for workshops, talks and society meetings. The host starts a
session, everyone joins by code or QR code and answers from their phone (no account, no app), and
the results grow on the big screen.

- **Activities:** word cloud, multiple-choice poll, and anonymous Q&A with upvotes. A session holds
  1 to 10 of them under one room code.
- **Private by design:** participants give no name or email. All answers are deleted 24 hours after
  a session ends. Only hosts have accounts, and setup checks that public sign-up is switched off.
- **Cheap to run:** SvelteKit on Vercel (London) and Supabase, both on their free plans. A load test
  with 200 simulated phones stayed within the function-call budget the free plans allow (`docs/load-test-results.md`).
- **Yours to brand:** the name, colours and logo live in one file, `src/lib/brand.ts`.
- **Open source, MIT licence** (see [`LICENSE`](LICENSE)). Design decisions and the reasons for them
  are in [`docs/DECISIONS.md`](docs/DECISIONS.md); what it does is in [`SPEC.md`](SPEC.md).

## Set up your own copy

You need a free [Supabase](https://supabase.com) project (choose *West EU (London)*) and a free
[Vercel](https://vercel.com) account. Two ways in:

**Deploy button** (creates the Vercel project and a Supabase store for you; you then finish the setup
with the commands below; the button has not been tried end to end yet, so if it misbehaves use the
agent route):

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fshahil1dn%2Fvolley&project-name=volley&repository-name=volley&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22supabase%22%2C%22productSlug%22%3A%22supabase%22%7D%5D)

**An AI coding agent:** give it this repository and tell it to follow [`AGENTS.md`](AGENTS.md). It is an
ordered list, and it hands you the steps only a person can do (creating accounts, accepting terms,
reading a password). A fresh agent has done this end to end from `AGENTS.md` alone
(`docs/trial-A15-record-2.md`).

The setup is two commands with no prompts, so a person or an agent can run them:

```bash
npm install
npm run doctor              # what is wrong, in plain English, with the exact fix for each
npm run setup               # does the fixes it can, safe to run again; ends by running doctor
npm run setup -- --first-admin-email you@example.com   # makes the first admin host
```

Both print only what is set or not (never a value). `npm run doctor -- --json` is the
same in JSON. Exit code 0 means ready, 1 means the agent can fix something (run the
command shown), 2 means a person has to do a step marked `HUMAN:` (a dashboard click,
a password). `.env.example` lists every setting and where it comes from; `npm run
setup -- --help` lists every flag. Setup never changes Vercel unless you pass
`--push-vercel-env` or `--vercel-protection`, and only for the project linked in `.vercel/`.

Two flags overwrite things, and each does one job: `--force` regenerates the generated secrets
(this signs every host out) and, with `--push-vercel-env`, replaces settings already on Vercel;
`--reset-first-admin` lets `--first-admin-email` act on an account
that already exists (new password, or admin for an existing host). Neither does the other's job.

Setup writes secrets only to files git ignores (every `.env*` name except `.env.example`);
to bring in another file's values, name it `.env.pulled.local` and pass `--from-env-file`.

To run locally with the Vercel store's settings instead: `vercel env pull .env.local --yes`,
then `npm run setup` (it copies the store's `NEXT_PUBLIC_…` names to the `PUBLIC_…` names
SvelteKit reads and makes `PARTICIPANT_SECRET`, `HOST_SESSION_SECRET` and `CRON_SECRET`),
then `npm run dev`.

## Hosts

Hosts sign in at `/`. The only way to make one (or reset their password):

```bash
npm run add-host someone@example.com
```

It prints a new password once; pass it to the host.

On Supabase's Pro plan, also turn on "Prevent use of leaked passwords" in the project's Auth settings
(free-plan projects cannot; ADR-015).

## Name, colours and logo

All three live in `src/lib/brand.ts`: the name (shown on every screen and in
tab titles), an accent, text and background colour, and an optional logo file
in `static/`. They are built in, so redeploy after changing them. `npm test`
fails, naming the pair, if a colour would make text unreadable (WCAG AA).

## Database

Migrations live in `db/migrations/` and apply in filename order. Each is
recorded in `schema_migrations`, so re-running applies only new ones:

```bash
node --env-file=.env.local scripts/migrate.mjs
```

## Checks

```bash
npm test
npm run check
npm run build
npm run test:e2e   # browser test; first run: node_modules/.bin/playwright install chromium
```

## Licence

MIT. The code is free to use, change and run for your own group. See [`LICENSE`](LICENSE).
The app ships no fonts: it uses each visitor's system fonts.

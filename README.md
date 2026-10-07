# Volley

Live word clouds, polls and Q&A for workshops and talks: the host starts a
session, everyone answers from their phone, and the results grow on the big
screen. Name, colours and logo are yours to set (see below).

SvelteKit on Vercel (London), Supabase for the database.

## Set up a copy (made for an AI agent)

**An AI coding agent: follow [`AGENTS.md`](AGENTS.md).** It is the ordered list; the rest of this
section is for people.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FTODO-OWNER%2FTODO-REPO&project-name=volley&repository-name=volley&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22supabase%22%2C%22productSlug%22%3A%22supabase%22%7D%5D)

<!-- TODO (Milestone 4 step 5): the repository-url above is a placeholder. Replace
     https://github.com/TODO-OWNER/TODO-REPO with the real public repository once it exists, in this link.
     Format and the stores JSON: https://vercel.com/docs/deploy-button/source (store product integration).
     The Supabase slugs (integrationSlug "supabase", productSlug "supabase") are the ones the deploy button on
     https://vercel.com/marketplace/supabase carries. Not yet tried end to end. -->
The button (not live until the repository is public) creates the Vercel project and a Supabase
store in one go; then follow `AGENTS.md` for the rest.

You can hand this repository to an AI coding agent: it needs only this repository, a Supabase
project and (to deploy) a Vercel project. Everything is a command with no prompts.

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

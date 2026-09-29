# AI Builders Live

Live word clouds for AI Builders Society sessions: the host asks a question,
everyone answers from their phone, and the cloud grows on the big screen.

SvelteKit on Vercel (London), Supabase for the database.

## Run locally

```bash
vercel env pull .env.local --yes
npm install
npm run dev
```

## Database

Tables and permissions live in `db/schema.sql`. Apply (safe to re-run):

```bash
node --env-file=.env.local scripts/migrate.mjs
```

## Checks

```bash
npm test
npm run check
npm run build
```

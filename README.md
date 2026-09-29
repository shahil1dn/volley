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
```

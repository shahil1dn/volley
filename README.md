# AI Builders Live

Live word clouds for AI Builders Society sessions: the host asks a question,
everyone answers from their phone, and the cloud grows on the big screen.

SvelteKit on Vercel (London), Supabase for the database.

## Run locally

```bash
vercel env pull .env.local --yes
echo "PARTICIPANT_SECRET=\"$(openssl rand -base64 48)\"" >> .env.local
echo "HOST_SESSION_SECRET=\"$(openssl rand -base64 48)\"" >> .env.local
npm install
npm run dev
```

`PARTICIPANT_SECRET` signs each phone's participant cookie and
`HOST_SESSION_SECRET` signs host sessions. Keep both out of git.

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

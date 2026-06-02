

# NextGen SEO

NextGen SEO is a full-stack SEO analytics and monitoring dashboard for Google Search Console, GA4, crawl inventory, rank tracking, Bing, and AI-assisted analysis.

## Run Locally

**Prerequisites:** Node.js

1. Install dependencies:
   `npm install`
2. Copy [.env.example](</Z:/GSCPLUS/.env.example>) to `.env.local` or `.env`
3. For persistent Google Search Console and GA4 access, set:
   `GOOGLE_OAUTH_CLIENT_ID`
   `GOOGLE_OAUTH_CLIENT_SECRET`
   `APP_BASE_URL`
   `GOOGLE_OAUTH_REDIRECT_URI`
4. Add your local callback URI to the Google OAuth client:
   `http://localhost:3000/api/google/oauth/callback`
5. Run the app:
   `npm run dev`

## Production Build

Production deploys should build both the Vite client and the Express server:

`npm run build`

Then start the compiled server:

`npm start`

`npm start` expects `dist/` and `.server-dist/` to already exist. In `NODE_ENV=production`, startup fails fast if `dist/index.html` is missing.

Health checks:

- `/api/health` verifies the HTTP process is responding.
- `/api/ready` verifies the HTTP process can query the database.

## Required Production Environment

Set these before starting with `NODE_ENV=production`:

```env
NODE_ENV=production
APP_BASE_URL=https://your-app.example.com
GOOGLE_OAUTH_REDIRECT_URI=https://your-app.example.com/api/google/oauth/callback
DATABASE_URL=postgresql://...
GOOGLE_OAUTH_STATE_SECRET=<32+ character random value>
GOOGLE_TOKEN_ENCRYPTION_KEY=<32+ character random value>
```

If Google OAuth is enabled, also set:

```env
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
```

Generate strong secret values with:

`npm run secrets:generate`

Add the exact production callback URI to the Google OAuth client.

## Docker

Build a production image:

`docker build -t gsc-plus .`

Run it with production environment variables:

```bash
docker run --rm -p 3000:3000 \
  --env-file .env.production \
  gsc-plus
```

The image runs `npm run verify` during build, starts with `npm start`, and includes the system libraries needed by Puppeteer crawl rendering.
For container deploys, `DATABASE_URL` must use a hostname reachable from inside the container, such as a managed database host or a Compose service name.

Run a production-like Docker smoke test with an internal Postgres service:

`npm run verify:docker`

The smoke command removes its containers and volume when it finishes.

After deploying to the real production HTTPS URL, run:

`npm run verify:production-url -- https://your-app.example.com`

This verifies health, database readiness, SPA serving, security headers, built asset cache headers, and OAuth callback route availability.
For local Compose smoke tests only, set `PRODUCTION_VERIFY_ALLOW_HTTP=true` when checking `http://127.0.0.1:3010`.

## PostgreSQL

By default the app still falls back to `sqlite.db` so local development does not break.

To run on PostgreSQL, set `DATABASE_URL` in `.env.local`:

`DATABASE_URL="postgresql://postgres:postgres@localhost:5432/nextgen_seo"`

Then start the app normally:

`npm run dev`

To copy existing local SQLite data into PostgreSQL:

`npm run db:migrate:postgres`

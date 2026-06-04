# NextGen SEO

NextGen SEO is a full-stack SEO analytics and monitoring platform for Google Search Console, GA4 and Bing with technical analysis, rank tracking, and AI-assisted SEO analysis. Built-in data warehouse: sync your data into your own SQLite or PostgreSQL database, keep it long-term, and report from saved history instead of depending on live API calls, export limits, or short retention windows.

## Features

- **SEO data warehouse**: persist GSC, GA4, Bing, crawl, rank tracking, and workspace-site data in your own database.
- **Google Search Console dashboards**: analyze queries, pages, countries, visible queries, historical trends, filters, and CSV exports.
- **GA4 reporting**: review acquisition, page performance, demographics, events, and LLM/referral traffic signals.
- **Blended SEO analytics**: combine search demand, engagement, crawl evidence, and indexing signals into page-level decisions.
- **Crawl inventory**: crawl sites, track indexability, canonicals, titles, headings, links, render modes, and crawl freshness.
- **Rank tracking**: monitor keywords by site, country, device, position, landing page, and movement.
- **Bing data support**: bring Bing Webmaster data into the same reporting surface.
- **AI-assisted analysis**: generate SEO insights and content-audit briefs from connected site evidence.

## Tech Stack

- React 19, TypeScript, Vite, Tailwind CSS v4, shadcn/ui
- Express API server with local session authentication
- SQLite for local development, PostgreSQL for production
- Docker production image and CI smoke checks

## Run Locally

**Prerequisites:** Node.js 22+

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env.local` or `.env`.
3. For persistent Google Search Console and GA4 access, set:
   ```env
   GOOGLE_OAUTH_CLIENT_ID=...
   GOOGLE_OAUTH_CLIENT_SECRET=...
   APP_BASE_URL=http://localhost:3000
   GOOGLE_OAUTH_REDIRECT_URI=http://localhost:3000/api/google/oauth/callback
   ```
4. Add your local callback URI to the Google OAuth client:
   ```text
   http://localhost:3000/api/google/oauth/callback
   ```
5. Run the app:
   ```bash
   npm run dev
   ```

## Production Build

Production deploys should build both the Vite client and the Express server:

```bash
npm run build
```

Then start the compiled server:

```bash
npm start
```

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

```bash
npm run secrets:generate
```

Add the exact production callback URI to the Google OAuth client.

## Docker

Build a production image:

```bash
docker build -t nextgen-seo .
```

Run it with production environment variables:

```bash
docker run --rm -p 3000:3000 \
  --env-file .env.production \
  nextgen-seo
```

The image runs `npm run verify` during build, starts with `npm start`, and includes the system libraries needed by Puppeteer crawl rendering.
For container deploys, `DATABASE_URL` must use a hostname reachable from inside the container, such as a managed database host or a Compose service name.

Run a production-like Docker smoke test with an internal Postgres service:

```bash
npm run verify:docker
```

The smoke command removes its containers and volume when it finishes.

After deploying to the real production HTTPS URL, run:

```bash
npm run verify:production-url -- https://your-app.example.com
```

This verifies health, database readiness, SPA serving, security headers, built asset cache headers, and OAuth callback route availability.
For local Compose smoke tests only, set `PRODUCTION_VERIFY_ALLOW_HTTP=true` when checking `http://127.0.0.1:3010`.

## Data Warehouse Storage

NextGen SEO uses a warehouse-first model. Dashboards and exports should read from stored data wherever possible, so reports stay fast, repeatable, and independent of live provider availability.

Local development falls back to `sqlite.db` by default. For production, use PostgreSQL.

To run on PostgreSQL, set `DATABASE_URL` in `.env.local`:

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/nextgen_seo"
```

Then start the app normally:

```bash
npm run dev
```

To copy existing local SQLite data into PostgreSQL:

```bash
npm run db:migrate:postgres
```

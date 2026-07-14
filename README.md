<img width="1672" height="941" alt="nextgenseo" src="https://github.com/user-attachments/assets/dee154be-c5b5-4004-ad1f-2c6f8b262a94" />

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.0-0f766e?style=for-the-badge" alt="version 0.1.0" />
  <img src="https://img.shields.io/badge/license-AGPL--3.0-16a34a?style=for-the-badge" alt="license AGPL-3.0" />
  <img src="https://img.shields.io/badge/react-19-61dafb?style=for-the-badge&logo=react&logoColor=111827" alt="React 19" />
  <img src="https://img.shields.io/badge/typescript-5-3178c6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/vite-powered-646cff?style=for-the-badge&logo=vite&logoColor=white" alt="Vite" />
  <img src="https://img.shields.io/badge/tailwind-v4-38bdf8?style=for-the-badge&logo=tailwindcss&logoColor=111827" alt="Tailwind CSS v4" />
  <img src="https://img.shields.io/badge/express-api-111827?style=for-the-badge&logo=express&logoColor=white" alt="Express API" />
  <img src="https://img.shields.io/badge/database-SQLite%20%2B%20PostgreSQL-2563eb?style=for-the-badge&logo=postgresql&logoColor=white" alt="SQLite and PostgreSQL" />
  <img src="https://img.shields.io/badge/docker-ready-2496ed?style=for-the-badge&logo=docker&logoColor=white" alt="Docker ready" />
</p>

<p align="center">
  <strong>Open-source SEO analytics platform with long-term data retention and AI-assisted analysis.</strong>
</p>
<br>

# NextGen SEO
*v0.1.0-alpha*

NextGen SEO is a full-stack SEO analytics and monitoring platform for Google Search Console, GA4 and Bing featuring technical analysis, rank tracking, LLM tracking and AI-assisted SEO analysis. 

Built-in data warehouse: No more 16-month/1k rows limit. Sync your (unlimited) data into your own SQLite or PostgreSQL database, keep it long-term, and report from saved history instead of depending on live API calls, export limits, or short retention windows.

<br>

## Features

- **SEO data warehouse**: persist GSC, GA4, Bing, crawl, rank tracking, and workspace-site data in your own database.
- **Google Search Console dashboards**: analyze performance, queries and query count, pages, countries, indexing, historical trends - custom filters, and CSV exports. No data limits.
- **GA4 reporting**: review acquisition, page performance, demographics, events, and LLM/referral traffic signals.
- **Blended Data View**: combine search demand, engagement, crawl evidence, and search signals into page-level decisions (GSC+GA4+Crawl data).
- **Bing data support**: bring Bing Webmaster data into the same reporting surface.
- **Crawl inventory**: crawl sites, track indexability, canonicals, titles, headings, links, render modes, and crawl freshness.
- **Contextual internal links**: rank sentence-level opportunities with built-in BGE-M3 embeddings, pgvector retrieval, exact anchor placement, editorial review, exports, and implementation annotations.
- **Rank tracking**: monitor keywords by site, country, device, position, landing page, and movement.
- **Content anylsis**: monitor and audit your content and it's performance
- **AI-assisted analysis**: generate SEO insights and content audits.
- *and many more to come*
<br>

## Tech Stack

- React 19, TypeScript, Vite, Tailwind CSS v4, shadcn/ui
- Express API server with local session authentication
- SQLite for local development, PostgreSQL for production
- Docker production image and CI smoke checks
<br>

## Run Locally

**Prerequisites:** Node.js 22+ and Docker Desktop (or Docker Engine with Compose)

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

The development command starts PostgreSQL/pgvector and the managed BGE-M3 embedding worker through Docker. On the first run, the official BAAI/bge-m3 model downloads into a persistent Docker volume; later starts reuse it. Ollama is not required for the default Built-in BGE-M3 provider.
<br>

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

<br>

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

<br>

## Docker

The supported production deployment runs separate web, warehouse, scheduler, crawl, and internal-link processes. This is required for automatic history imports and daily data refreshes.

Create the production environment file and start the complete stack:

```bash
cp .env.production.example .env.production
# Replace every CHANGE_ME value before continuing.
docker compose --env-file .env.production -f docker-compose.production.yml up -d --build
```

To build or inspect only the web image, you can still use:

```bash
docker build -t nextgen-seo .
docker run --rm -p 3000:3000 \
  --env-file .env.production \
  nextgen-seo
```

The standalone `docker run` command starts the web role only. It does not run the scheduler or warehouse worker, so it must not be used as the complete production deployment.

The image runs `npm run verify` during build and includes the system libraries needed by Puppeteer crawl rendering.
For container deploys, `DATABASE_URL` must use a hostname reachable from inside the container, such as a managed database host or a Compose service name.

Run a production-like Docker smoke test with internal PostgreSQL, web, warehouse-worker, and scheduler services:

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

<br>

## Data Warehouse Storage

NextGen SEO uses a warehouse-first model. Dashboards and exports should read from stored data wherever possible, so reports stay fast, repeatable, and independent of live provider availability.

Local development falls back to `sqlite.db` by default. For production, use PostgreSQL. For realistic warehouse performance testing, use PostgreSQL locally too.

Start the local PostgreSQL service:

```bash
npm run db:postgres:up
```

Then set `DATABASE_URL` in `.env.local`:

```env
DATABASE_URL="postgresql://nextgen_seo:nextgen_seo_dev_password@localhost:5432/nextgen_seo"
```

Then start the app normally:

```bash
npm run dev
```

To copy existing local SQLite data into PostgreSQL:

```bash
npm run db:migrate:postgres
```

The health endpoints expose the active database backend without exposing credentials:

```bash
curl http://localhost:3000/api/health
curl http://localhost:3000/api/ready
```

Both responses include `database.dialect`, which should be `postgres` when `DATABASE_URL` is set.
<br>

## License

NextGen SEO is licensed under the GNU Affero General Public License v3.0.

See the [LICENSE](./LICENSE) file for details.

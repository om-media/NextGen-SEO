<p align="center">
  <strong>NextGen SEO</strong><br>
  Open-source SEO analytics with long-term, self-hosted data storage.
</p>

NextGen SEO combines Google Search Console, GA4, Bing, crawl inventory, rank tracking, internal-link analysis, and AI-assisted review in one workspace. It stores imported data in a database you control, so reports do not depend on a provider's short retention window.

## Project status

This repository contains the AGPL-3.0 open-source core. It is self-hostable without a hosted account. The repository is under a feature freeze: current work focuses on existing behavior, defect fixes, accessibility, security, reliability, tests, documentation, and validation.

The hosted SaaS boundary is documented in [docs/open-source-saas-boundary.md](docs/open-source-saas-boundary.md). The SaaS contract is a proposed integration seam; this repository does not implement a hosted control plane.

## Implemented areas

- GSC performance, queries, query counts, pages, countries, indexing, historical trends, filters, and CSV exports.
- GA4 acquisition, page performance, demographics, events, and LLM/referral traffic views.
- Page-level blended reporting across GSC, GA4, crawl, and search signals.
- Bing Webmaster data stored and read through a warehouse-backed path.
- Crawl inventory with indexability, canonicals, titles, headings, links, render mode, and crawl freshness.
- Internal-link opportunities using local BGE-M3 embeddings, pgvector retrieval, editorial review, and implementation annotations.
- Rank tracking, server-log analysis, reconciliation, topical authority, visual semantics, and content-authority views.

The warehouse removes the application's dependence on provider retention limits. Your database size, provider quotas, API availability, and crawl resources still limit what the system can collect.

## Stack

- React 19, TypeScript, Vite, Tailwind CSS v4, and shadcn/ui.
- Express API with local session authentication.
- SQLite for local fallback; PostgreSQL with pgvector for production and realistic warehouse testing.
- Docker Compose for local PostgreSQL/BGE services and the production role topology.

## Run locally

Prerequisites: Node.js 22+ and Docker Desktop or Docker Engine with Compose.

Copy `.env.example` to `.env.local`, then run:

```bash
npm install
npm run dev
```

`npm run dev` starts the local PostgreSQL/BGE Compose services, builds the client and server, and starts the compiled server. The first BGE start downloads `BAAI/bge-m3` into a persistent Docker volume. Ollama is optional.

For Google data, set these values in `.env.local` and register the same callback URL in Google Cloud:

```env
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
APP_BASE_URL=http://localhost:3000
GOOGLE_OAUTH_REDIRECT_URI=http://localhost:3000/api/google/oauth/callback
```

The app can use SQLite when `DATABASE_URL` is empty. If Docker is unavailable, `npm run dev` cannot start its Compose prerequisite; `npm run build` and SQLite-backed checks can still run.

## Build and checks

```bash
npm run build
npm run lint
npm run verify
```

`npm run build` writes `dist/` and `.server-dist/`. `npm start` serves the compiled application and expects both artifacts. `npm run verify` is the full repository gate. It includes public-file checks, TypeScript, API and data contracts, lifecycle checks, the production dependency audit, the build, and runtime-role verification. Some checks need PostgreSQL, Docker, or external services.

Health endpoints:

- `GET /api/health` checks that the HTTP process responds and reports the database dialect.
- `GET /api/ready` runs a database query and returns failure when the database is unavailable.

## PostgreSQL

Start local PostgreSQL/pgvector and point the app at it:

```bash
npm run db:postgres:up
```

```env
DATABASE_URL=postgresql://nextgen_seo:nextgen_seo_dev_password@localhost:5432/nextgen_seo
```

To migrate an existing SQLite database:

```bash
npm run db:migrate:postgres
```

## Production

Production requires PostgreSQL and HTTPS. Set these values in `.env.production`:

```env
NODE_ENV=production
APP_BASE_URL=https://your-app.example.com
GOOGLE_OAUTH_REDIRECT_URI=https://your-app.example.com/api/google/oauth/callback
DATABASE_URL=postgresql://...
GOOGLE_OAUTH_STATE_SECRET=<32+ random characters>
GOOGLE_TOKEN_ENCRYPTION_KEY=<32+ random characters>
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
```

Generate the two application secrets with:

```bash
npm run secrets:generate
```

The supported Compose deployment runs a gateway, web replicas, one database-preparation job, crawl worker, internal-link worker, warehouse worker, scheduler, PostgreSQL/pgvector, and the BGE-M3 worker:

Copy `.env.production.example` to `.env.production`, replace its placeholder values, then run:

```bash
docker compose --env-file .env.production -f docker-compose.production.yml up -d --build
```

The standalone image starts the web role only. Use the full Compose file for scheduled imports, crawl processing, internal-link processing, and warehouse jobs. Run the production-like smoke test with:

```bash
npm run verify:docker
```

After deployment, check a real HTTPS origin with:

```bash
npm run verify:production-url -- https://your-app.example.com
```

See [docs/production-scaling.md](docs/production-scaling.md) for the load harness and its safety gates, and [docs/adr/production-worker-architecture.md](docs/adr/production-worker-architecture.md) for the runtime decision.

## License

NextGen SEO is licensed under the GNU Affero General Public License v3.0. See [LICENSE](LICENSE).

# MAD — Music Artist Dashboard

Analytics platform for tracking music-artist performance across streaming and
social platforms, analysing concert history, and predicting concert revenue and
demand with a trained ML engine.

Built around a daily [Viberate](https://www.viberate.com/) ingestion pipeline
that feeds artist popularity scoring, TOPSIS-based touring feasibility, and
revenue prediction.

---

## Architecture at a glance

Three processes run side by side in development. The frontend needs both the
backend and the Python analytics service to be fully functional.

| Service | Port | Stack | Purpose |
|---|---|---|---|
| Frontend | 5173 | React 19, Vite, Zustand, React Query, Tailwind, Recharts | Dashboard UI |
| Backend API | 3001 | Node 20, Express 5, TypeScript, Prisma | REST API, auth, ingestion, scrapers |
| ML Analytics | 8001 | Python, FastAPI, scikit-learn | Revenue / demand / popularity / venue models |
| PostgreSQL | 5432 | Prisma ORM | Primary datastore |
| Redis | — | Redis (optional) | Caching; the app runs without it |

`Analysis.jsx` and several dashboard panels call the Python service on `:8001`.
If it is not running, those views degrade or error — start all three.

### ⚠️ There are three analytics engines, not one

This is the single most confusing thing about the codebase. Three separate
implementations compute overlapping metrics with different formulas:

1. **TypeScript, in-process** — `backend/src/utils/concertRevenue.ts`,
   `backend/src/services/validation/hybridValidation.service.ts` and
   `concertIntelligence.service.ts`. The older V1 entropy popularity service has
   been retired to `legacy/backend/src/services/analytics/popularityV2.service.ts`.
2. **`backend/ml_engine/`** — one surviving Python CLI script, `embeddings.py`
   (MiniLM), spawned by `backend/src/services/deduplication/embedding.service.ts`
   for concert de-duplication. `processor.py` sits alongside it but is no longer
   wired into anything. **Not** a server.
3. **`mad_analytics/`** — the current, real ML engine. A standalone FastAPI
   service on `:8001` with a trained GradientBoosting revenue model, demand,
   growth, popularity and venue-capacity modules, pytrends, its own scrapers and
   scheduler. Reached over HTTP from `backend/src/services/madAnalytics.service.ts`.

Before changing a formula, confirm which engine actually serves the number you
are looking at. See [CLAUDE.md](./CLAUDE.md) and
[MASTER_PROJECT.md](./MASTER_PROJECT.md) for the full picture.

---

## Quick start

Full step-by-step instructions — including Google Search API setup and ML model
training — are in **[HOW_TO_RUN.md](./HOW_TO_RUN.md)**. Short version:

**Prerequisites:** Node.js 18+ (20 recommended), Python 3.11+, a PostgreSQL
database. Redis is optional.

```bash
# 1. Install dependencies
npm run install:all                          # root + backend
pip install -r mad_analytics/requirements.txt

# 2. Configure environment
cp backend/.env.example backend/.env         # set DATABASE_URL, JWT secrets

# 3. Prepare the database
cd backend
npx prisma generate
npx prisma db push
npm run db:seed
cd ..
```

Then start the services in two terminals:

```bash
# Terminal 1 — Python ML analytics
python -m uvicorn mad_analytics.server:app --port 8001

# Terminal 2 — frontend + backend together
npm run dev
```

App: <http://localhost:5173> · API: <http://localhost:3001> · ML docs: <http://localhost:8001/docs>

Local seed logins (development only): `admin@mad.com` / `admin123` and
`viewer@mad.com` / `viewer123`.

> Docker alternative: `backend/docker-compose.yml` can bring up Postgres, Redis
> and n8n locally instead of using hosted instances.

---

## Project layout

```
.
├── src/                    React frontend
│   ├── pages/              Dashboard, Artists, ArtistProfile, Concerts,
│   │                       Venues, Analysis, MapView, Demographics, Admin*
│   ├── components/         Shared UI (incl. components/viberate/)
│   ├── api/client.js       Axios client (VITE_API_URL or /api/v1 proxy)
│   └── hooks/  store/      React Query hooks, Zustand stores
├── backend/                Express + TypeScript API
│   ├── src/routes/         artist, concert, analytics, dashboard, auth,
│   │                       user, ingestion, scraping
│   ├── src/services/       Business logic, scrapers, madAnalytics client
│   ├── prisma/             Schema, migrations, seed
│   ├── ingestion/          n8n workflow definitions
│   └── ml_engine/          Legacy Python CLI scripts (see note above)
├── mad_analytics/          Python FastAPI ML service (the real engine)
│   ├── revenue/ demand/ popularity/ engagement/ feasibility/
│   ├── trends/ audience_city/ touring_history/ venue_capacity/
│   ├── training/           Model training + enrichment scripts
│   ├── models/             Trained artifacts (e.g. revenue_model.joblib)
│   └── server.py           FastAPI app
├── docs/                   Canonical engineering docs (see docs/INDEX.md)
└── legacy/                 Quarantined dead code
```

---

## Common commands

```bash
# Development
npm run dev                 # frontend + backend concurrently
npm run dev:frontend        # Vite only
npm run dev:backend         # Express only
npm run build               # production frontend build
npm run lint                # ESLint (frontend)

# Database (run from backend/)
npm run db:push             # sync schema
npm run db:seed             # seed base data
npm run db:bootstrap        # seed + import artists + assign slugs
npm run db:studio           # Prisma Studio

# Viberate data pipeline (from backend/)
npm run db:collect          # scrape Viberate -> viberate_metrics_daily
npm run db:sync             # copy totals into Artist + platform_metrics
npm run viberate:refresh    # both of the above, as the daily cron runs them

# ML training (needs DATABASE_URL)
python -m mad_analytics.training.train_revenue --db "$DATABASE_URL"
python -m mad_analytics.training.update_artist_popularity --db "$DATABASE_URL"
python -m mad_analytics.training.enrich_venues --db "$DATABASE_URL" --dry-run
```

### Tests

```bash
cd backend && npm test                      # Jest: controllers, services, middleware, integration
python -m pytest mad_analytics/tests/ -v    # Python analytics tests
```

---

## Data pipeline

A daily cron at 06:00 IST
(`backend/src/services/scrapers/viberate/scheduler.ts`) runs
`runCollection() → runSync()`:

1. **collect** — scrapes the Viberate REST API using Playwright session cookies
   (`viberate-session.json`, 30-day lookback) into `viberate_metrics_daily`.
2. **sync** — copies latest totals into `Artist` columns and backfills
   `platform_metrics` with rate-of-growth fields vs. 1 / 7 / 30 days prior.

Popularity scoring is **no longer part of this cron**. It now lives on the
Python side (`mad_analytics/popularity/calculator.py`) and is refreshed by
`python -m mad_analytics.training.update_artist_popularity`. Entropy-weighted
reach × a log-compressed engagement multiplier, blended 70/30 with Google
Trends and scaled 5–100.

In production the collector runs **only** as a dedicated Render Cron Job (see
[render.yaml](./render.yaml)) — never in the public API service.

---

## Deployment

Frontend on Vercel, backend and ML analytics on Render, PostgreSQL on Neon,
Redis on Upstash. Config lives in [vercel.json](./vercel.json) and
[render.yaml](./render.yaml).

Full runbook: **[DEPLOYMENT.md](./DEPLOYMENT.md)**

---

## Documentation map

| Document | What it covers |
|---|---|
| [HOW_TO_RUN.md](./HOW_TO_RUN.md) | Full local setup, training, troubleshooting |
| [CLAUDE.md](./CLAUDE.md) | Project context, key facts and gotchas — read first |
| [MASTER_PROJECT.md](./MASTER_PROJECT.md) | Full system architecture |
| [ARCHITECTURE_AUDIT.md](./ARCHITECTURE_AUDIT.md) | Architecture review findings |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Production deployment runbook |
| [FORMULAS.md](./FORMULAS.md) | Metric and scoring formula definitions |
| [PATCH_NOTES.md](./PATCH_NOTES.md) | Change log |
| [docs/INDEX.md](./docs/INDEX.md) | Catalogue of canonical engineering docs |
| [backend/README.md](./backend/README.md) | Backend API reference |
| [backend/GETTING_STARTED.md](./backend/GETTING_STARTED.md) | Backend-only setup |
| [mad_analytics/README.md](./mad_analytics/README.md) | ML modules and endpoints |

---

## Gotchas

- **Line endings are CRLF.** Preserve them when editing.
- `npx prisma generate` fails with `EPERM` while the dev server is running —
  stop it first (the query-engine DLL is locked).
- `DATABASE_URL` must use the `postgresql://` scheme, not `postgres://`.
- In `backend/src/routes/artist.routes.ts`, `/leaderboard` **must** stay
  registered before `/:id`.
- API responses use a `{ success, data }` envelope; the BigInt JSON patch lives
  in `backend/src/server.ts`.
- The `Platform` enum has no `TIKTOK` value — TikTok data exists only in
  `viberate_metrics_daily`. Adding it needs a deliberate migration.
- Never commit `viberate-session.json`.

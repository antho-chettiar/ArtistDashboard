# myBACKEND_AUDIT.md — Sprint 4.1 Backend Cleanup & Technical-Debt Audit

**Scope:** `backend/` (Node/TS + Prisma), `mad_analytics/` (Python ML service), `backend/ml_engine/` (spawned Python), root Python scripts. **Read-only** — no code was modified. Frontend is out of scope (cross-referenced only).

**Method:** static import/usage scans (services imported 0×, npm deps referenced 0× in `src`, empty files, route inventory vs frontend calls) combined with the Sprint-3 DB-architecture and population-script audits.

**Legend:** 🟢 Safe to Remove · 🟡 Needs Review · 🔵 Keep

---

## 1. Unused code (verified 0 usages)

| Item | Evidence | Category |
|---|---|---|
| `src/services/analytics/popularityV2.service.ts` | **0 bytes**, 0 imports | 🟢 |
| `src/services/analytics/trends.service.ts` | **0 bytes**, 0 imports | 🟢 |
| `src/services/currency/currencyConversion.service.ts` | imported 0× anywhere in `src` | 🟡 (verify no dynamic use, then remove) |
| npm: **cheerio, csv-parser, express-validator, swagger-jsdoc, swagger-ui-express, redis** | referenced 0× in `src` (validation uses `zod`; cache uses `ioredis`; swagger not mounted in `server.ts`) | 🟡 (remove from `package.json` after confirming no build step needs them) |
| `backend/scripts/venv/`, `backend/scripts/.idea/` | committed dev artifacts (Python venv, IDE config) | 🟢 |

> `prisma` (CLI) shows 0 code imports but **is used** by npm scripts (`prisma generate/migrate`) → **Keep**. `@prisma/client` is the runtime → Keep.

## 2. Dead / one-off scripts

| Script | Purpose | Category |
|---|---|---|
| `scripts/test-predictions.ts`, `scripts/test-engagement.ts` | dev harnesses (3-artist test / console only) | 🟢 |
| `src/services/scrapers/viberate/test-collect.ts`, `test-fetch.ts` | manual test harnesses | 🟢 |
| `scripts/simple-test.py`, `scripts/test_trends.py`, `scripts/googletrends1.py` | dev experiments (CSV/console output, not DB) | 🟢 |
| root `check_dashboard.py`, `check_data.py`, `check_data2.py`, `check_ranking.py`, `check_stored.py`, `check_subs.py`, `check_taylor_drake.py`, `check_yt_cols.py` | ad-hoc read-only diagnostics | 🟡 (move to `scripts/diagnostics/` or remove) |
| `scripts/update-predictions.ts`, `scripts/update-all-predictions.ts` | **superseded** by `update-all-predictions-with-coords.ts` | 🟡 (retire the two older ones) |
| `backend/export-viberate.py` | ad-hoc Viberate→xlsx export | 🟡 |
| `fix_rog.py` (root) | RoG backfill, part of pipeline | 🔵 Keep |
| `prisma/seed-new-artists.ts` | already marked DEPRECATED (Sprint 3); dev fallback | 🟡 Keep-as-dev-fallback |

## 3. Duplicate implementations (the #1 debt)

**Popularity — 4 live implementations + 2 empty stubs + 3 storage sinks:**
- `backend/src/utils/artistPopularity.ts` (V1 entropy)
- `backend/src/services/scrapers/viberate/scorer.ts` (Viberate V2 — **the active production scorer**)
- dashboard composite (in `dashboard.controller.ts`)
- `mad_analytics/popularity/calculator.py` (Python)
- stubs: `analytics/popularityV2.service.ts`, `analytics/trends.service.ts` (empty)
- stored in: `artists.popularity`, `artist_popularity_v2_snapshots.finalScore`, **and** raw `artist_popularity_scores` (non-Prisma table). → **Converge on Viberate V2.**

**Demand — ≥2:** `mad_analytics/demand/scorer.py` (active) + TS `features/featureEngineering.service.ts` signals. Stored in `concerts.demandScore` **and** `prediction_outputs.demandScore`.

**Revenue — 3–4 paths + currency inconsistency:** `mad_analytics/revenue/predictor.py` (signal), the trained GBM model, `backend/ml_engine/processor.py` (heuristic pricing), `backend/src/utils/concertRevenue.ts` (display read-model), `services/predictions/revenuePrediction.service.ts`. FX assumptions diverge (USD vs local).

**Two Python engines:** `backend/ml_engine/` (spawned CLI: `processor.py`, `embeddings.py`) vs `mad_analytics/` (FastAPI HTTP service) — different formulas **and** FX → same concert can yield different numbers by entry path.

**Ingestion — parallel paths:** `ingestion.controller.ts` (Excel upload) vs `concertIntelligence.service.ts` / `ingestion/concertScraperIngestion.service.ts` (scraper pipeline) vs TS scrapers. No single authoritative concert writer.

## 4. Dead / unreachable APIs

| Endpoint | Why dead/unreachable | Category |
|---|---|---|
| `/analytics/demographics/{age,gender,geo}`, `/artists/:id/demographics` | `audience_demographics` is **never populated** → always empty | 🟡 (implement or remove) |
| `/ingestion/enrich`, `/ingestion/enrich/:id` | backed by `artistEnrichment.service.ts`, a **no-op stub** | 🟡 |
| `/ingestion/sync/:platform` | only `SPOTIFY` supported; routes into the enrichment stub | 🟡 |
| `/concerts/predictions/revenue` (orphan TS revenue) | no frontend caller | 🟡 |
| `/analytics/ml/popularity/all/save`, `/concerts/pipeline/sources` | not called by any frontend page | 🟡 |

## 5. Dead / write-only / never-populated Prisma models (from Sprint-3 DB audit)

- **Never written & never read → 🟢:** `concert_research_jobs`, `duplicate_group_members`, `prediction_models`.
- **Write-only (never read) → 🟡:** `duplicate_groups`, `validation_logs`, `feature_snapshots`, `prediction_training_data`.
- **Never populated → 🟡:** `audience_demographics`, `artist_trend_scores` (the latter is *read* by the scorer → causes the reach-only "Trends split-brain").
- **Schema drift → 🟡:** `artist_popularity_scores`, `venue_capacity_records` exist in the DB (written by raw SQL in `mad_analytics/`) but are **absent from `schema.prisma`**.

## 6. Migrations

`prisma/migrations/` has **4 applied migrations** (`…add_workflow_fields`, `…add_concert_pricing_pipeline_fields`, `…add_concert_intelligence_layer`, `…add_google_trends_score`). Applied migration history must **not** be deleted (it baselines the DB). → 🔵 Keep all. Future schema trims become *new* migrations.

## 7. Core — keep (actively used, production path)

Auth (`auth.controller`, `users`, `refresh_tokens`), `artist.controller`, `dashboard.controller`, `analytics.controller` (rog/trends/genres/ml), `madAnalytics.service.ts`, the **Viberate pipeline** (`collector`/`sync`/`scorer`), `import-artist-baseline.ts`, `seed.ts`, `viberate-slugs.ts`; models `artists, genres, artist_genres, platform_metrics, viberate_metrics_daily, artist_popularity_v2_snapshots, concerts, users, refresh_tokens, ingestion_jobs`; deps `@prisma/client, express, ioredis, jsonwebtoken, bcryptjs, zod, xlsx, playwright, dotenv, helmet, cors, morgan, compression, express-rate-limit, winston, multer, node-cron, cookie-parser`.

---

*See `myREMOVAL_LIST.md` for the itemized decisions, `myCLEANUP_PLAN.md` for sequencing, and `myDEPENDENCY_GRAPH.md` for active-vs-legacy wiring.*

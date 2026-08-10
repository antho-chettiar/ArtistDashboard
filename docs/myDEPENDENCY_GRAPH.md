# myDEPENDENCY_GRAPH.md — Active vs Legacy Backend Wiring

Derived from static import/usage scans + the Sprint-3 API-read and formula-column mappings. **🟢 = active production path · ⚪ = legacy/dead/write-only.**

---

## Active production path (🟢)

```
EXTERNAL: Viberate (Playwright session) ─┐   YouTube/Instagram/pytrends (mad_analytics providers, optional)
                                         ▼
INGEST/SCRIPTS
  seed.ts ──────────────► users, genres
  import-artist-baseline.ts ─► artists            (single source of truth)
  viberate-slugs.ts ─► artists.viberateSlug
  collector.ts ─► viberate_metrics_daily
        │
        ▼
  sync.ts ─► artists.{metric cols}, platform_metrics
        │
        ▼
  scorer.ts ─► artist_popularity_v2_snapshots      (Viberate V2 = canonical popularity)
        │
        ▼
FORMULA ENGINE
  mad_analytics/  ── Popularity · PlatformSize · CityAffinity · Demand · Revenue · Risk · Confidence
        ▲  (HTTP via madAnalytics.service.ts)
        │
CONTROLLERS ─► ROUTES ─► FRONTEND PAGES
  auth.controller        /auth/*                     Login
  artist.controller      /artists, /artists/leaderboard, /artists/:id[/score|/metrics|/viberate-metrics]   Artists, ArtistProfile
  dashboard.controller   /dashboard/{kpis,top-artists}                                                      Dashboard
  analytics.controller   /analytics/{trends,rog,genres,ml/*}                                                Analysis
  concert.controller     /concerts, /concerts/{cities,venues,:id}   (empty until concert data)              Concerts, MapView
  ingestion.controller   /ingestion/{excel/upload,jobs,rog/recalculate}                                     AdminIngestion
  user.controller        /users*                                                                            AdminUsers

DB (core, populated): users, refresh_tokens, artists, genres, artist_genres,
  viberate_metrics_daily, platform_metrics, artist_popularity_v2_snapshots,
  concerts(0 rows), ingestion_jobs
```

**Active services:** `madAnalytics.service.ts`, `features/featureEngineering.service.ts`, `concertIntelligence.service.ts`, `concertPipeline.service.ts`, `predictions/revenuePrediction.service.ts`, `normalization/eventNormalization.service.ts`, `deduplication/*`, `validation/hybridValidation.service.ts`, `ingestion/concertScraperIngestion.service.ts`, `analytics/engagement.service.ts` — but several only fire on the (currently unused) concert-scraper/prediction paths (see legacy notes).

---

## Legacy / dead / write-only (⚪)

```
EMPTY STUBS ─────► (nothing)
  analytics/popularityV2.service.ts, analytics/trends.service.ts        [0 bytes]

NO-OP / UNUSED SERVICES
  artistEnrichment.service.ts ──► /ingestion/enrich* (endpoints live, logic no-op)
  currency/currencyConversion.service.ts ──► (imported 0×)

DUPLICATE POPULARITY BRAINS (only Viberate V2 is canonical)
  utils/artistPopularity.ts (V1 entropy) ─┐
  dashboard composite recompute            ├─► overlap → artists.popularity / v2_snapshots / artist_popularity_scores(raw)
  mad_analytics/popularity/calculator.py ─┘

DUPLICATE REVENUE/DEMAND ENGINES (different formulas + FX)
  backend/ml_engine/processor.py (spawned)  ⟷  mad_analytics/revenue/predictor.py + trained GBM
  utils/concertRevenue.ts (display)  +  services/predictions/revenuePrediction.service.ts

DEAD APIs (reachable route, empty/no-op result)
  /analytics/demographics/*  /artists/:id/demographics   → audience_demographics (never populated)
  /ingestion/enrich*  /ingestion/sync/:platform          → enrichment stub
  /concerts/predictions/revenue  /analytics/ml/popularity/all/save  /concerts/pipeline/sources → no caller

DB tables not on the active path:
  never used     → concert_research_jobs, duplicate_group_members, prediction_models
  write-only     → duplicate_groups, validation_logs, feature_snapshots, prediction_training_data
  never populated→ audience_demographics, artist_trend_scores(*read by scorer → Trends split-brain)
  schema drift   → artist_popularity_scores, venue_capacity_records (raw SQL, not in Prisma)

DEAD SCRIPTS / ARTIFACTS
  scripts/{test-predictions,test-engagement,update-predictions,update-all-predictions}.ts
  viberate/{test-collect,test-fetch}.ts
  scripts/{simple-test,test_trends,googletrends1}.py ; root check_*.py ; export-viberate.py
  scripts/venv/ ; scripts/.idea/

UNUSED npm DEPS: cheerio, csv-parser, express-validator, swagger-jsdoc, swagger-ui-express, redis
```

---

## One-line reading
The **live product** runs on: Viberate pipeline → `artist_popularity_v2_snapshots` → `artist`/`dashboard`/`analytics` controllers → Dashboard/Artists/Analysis pages, plus `mad_analytics` over HTTP for the ML scores. **Everything under "Legacy"** is either an alternate metric brain that should be consolidated (Phase 4), a concert/scraper/prediction path that is dormant until concert data exists, or provably-dead code/deps/tables (Phases 0–3, 5). See `myCLEANUP_PLAN.md`.

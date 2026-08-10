# MASTER_PROJECT.md — The Definitive Project Bible

**Project:** MAD — Music Artist Dashboard (a.k.a. ArtistDashboard / "Artist IQ")
**Compiled:** 2026-07-21 by reverse-engineering the full repository and all documentation.
**Status of this document:** Single source of truth. Supersedes scattered docs where they conflict.

---

## How to read this document

This Bible follows one rule throughout, taken from the task brief:

> **Documentation = intended architecture. Code = current implementation.**

Where the two disagree — and they disagree a lot — both are stated, and the **verified code reality wins** for "current status." Every claim here was checked against source files, not assumed from docs.

### The single most important thing to understand about this repo

There is **no one analytics engine**. There are **three parallel "brains,"** built at different times by different approaches, that compute overlapping metrics and are wired to different parts of the UI:

| # | Brain | Where | How reached | Runs today? |
|---|-------|-------|-------------|-------------|
| **1** | **TypeScript in-process services** | `backend/src/services/{predictions,features,validation,...}` + `backend/src/utils/artistPopularity.ts` | Direct function calls inside Express | Yes (in the API process) |
| **2** | **`backend/ml_engine/` spawned scripts** | `backend/ml_engine/processor.py`, `embeddings.py` | `child_process.spawn(python, [...])` per call, stdin→stdout JSON | Yes, on demand (needs Python on PATH) |
| **3** | **`mad_analytics/` FastAPI service** | top-level `mad_analytics/` package | HTTP to `ANALYTICS_URL` (`http://localhost:8001`) | Only if the FastAPI server is separately started |

On top of that, the **actual daily production pipeline** that the codebase most recently converged on is a **fourth thing** the older docs barely mention: the **Viberate scraper + scorer** (`backend/src/services/scrapers/viberate/`), which powers the artist popularity score shown on the Artist Profile page and is the subject of `CLAUDE.md`.

The documentation set describes at least **four mutually-inconsistent intended designs** for the same formulas (detailed in §7). Reconciling these into one is the project's central technical debt.

---

# 1. Product Vision

## What problem does this platform solve?

MAD helps **concert promoters, booking agents, and music-label analysts** answer money questions about live music in India (with some global artists tracked for comparison):

- *How popular is this artist right now, relative to others?*
- *If we book Artist X in City Y at Venue Z, how much revenue will it make, and how confident are we?*
- *What should tickets cost, and how many will sell?*
- *Which artists are rising vs. declining?*
- *Which cities have the most untapped demand?*

It replaces gut-feel booking decisions and manual spreadsheet tracking with a data pipeline that continuously ingests social/streaming metrics and concert listings, then runs analytics and ML predictions on top.

## Who are the users?

Access is gated by JWT auth with two roles (`UserRole` enum):

- **ADMIN** — full access, including the ingestion console (`/admin/ingestion`), user management (`/admin/users`), and the ability to trigger scraping/prediction pipelines.
- **VIEWER** — read-only dashboard, artist profiles, concerts, analysis, and map.

The *ultimate beneficiary* (not a system user) is the **promoter/label decision-maker** whose booking and pricing choices the Analysis page is designed to inform.

## What are the final outputs?

1. **Artist popularity leaderboard / scores** (0–100).
2. **Growth trends & forecasts** (RoG per platform, rising/stable/declining).
3. **Concert revenue predictions** with confidence range and currency.
4. **Demand scores** per artist-city-date (0–100).
5. **Ticket pricing tiers** (VIP/Tier1/Tier2/Tier3) and predicted sell-through.
6. **Venue capacity resolution** with a confidence/source trail.
7. **Audience demographics** (age/gender/geography breakdowns).
8. **Deduplicated, fraud-scored concert event registry** (canonical events).

## Business value per module

| Module | Value delivered |
|--------|-----------------|
| Social/streaming ingestion | Removes manual data collection; keeps artist metrics fresh daily |
| Popularity scoring | Objective, comparable artist ranking for shortlisting |
| Growth/RoG | Distinguishes momentum from raw size — a rising mid-tier artist may be a better booking than a plateaued star |
| Demand scoring | Localizes booking decisions to the right city/date |
| Revenue prediction | Core deliverable — quantifies the financial bet of a booking |
| Ticket pricing | Optimizes yield across audience tiers |
| Venue capacity resolution | Fills the single most important revenue feature when data is missing |
| Concert intelligence (dedupe/validation) | Keeps the training/analytics data clean and trustworthy |

---

# 2. System Architecture

## Intended pipeline (from the task brief and docs), annotated with reality

```
External APIs            n8n (social: IG/YT/Spotify/FB/Twitter/Apple), Viberate REST,
                         setlist.fm, BookMyShow, District, Songkick, Apify(IG),
                         Google Trends(pytrends), YouTube Data API, SerpAPI/Google CSE, Wikidata
        │
        ▼
Scrapers                 [RUNNING]  Viberate collector (TS, Playwright, daily 6AM IST)
                         [RUNNING]  concertPipeline setlist.fm (TS, axios)
                         [BUILT]    BookMyShow + District (TS, Playwright) → ingestion layer
                         [PARALLEL] mad_analytics/scrapers/* (Python: BMS/District/Songkick/Setlist/IG)
        │
        ▼
Normalization            [COMPLETE] eventNormalization.service.ts (pure, canonical_key + normalized_*)
        │
        ▼
Validation               [COMPLETE] hybridValidation.service.ts (confidence + fraud risk + status)
        │                           + duplicateDetection / duplicateMerge (embeddings via ml_engine)
        ▼
Database                 [COMPLETE] PostgreSQL (Prisma, 20+ models) + Redis cache
        │
        ▼
Feature Engineering      [COMPLETE-TS] featureEngineering.service.ts (12 features)
                         [COMPLETE-PY] mad_analytics/utils/feature_engineering.py
        │
        ▼
Analytics Engine         [FRAGMENTED] 3 brains compute popularity/demand/growth (see §7)
        │
        ▼
Prediction Engine        [PY]  mad_analytics/revenue/predictor.py (real GradientBoosting joblib, 0.55/0.45 blend)
                         [TS]  revenuePrediction.service.ts (hybrid-revenue-v1) — orphan endpoint
                         [PY]  ml_engine/processor.py (spawned heuristic) — used by concertPipeline
        │
        ▼
Business Intelligence    dashboard KPIs, top-artists composite, analytics/trends/demographics
        │
        ▼
Frontend                 React 19 + Vite (:5173), React Query, Zustand, Tailwind, Recharts, Leaflet
```

## Runtime topology (what actually talks to what)

```
┌─────────────────────────────────────────────────────────────────┐
│ FRONTEND  React/Vite  :5173                                       │
│   hooks: useArtists, useConcerts, useDashboardData, usePredictions,│
│          useViberate  →  axios client (/api/v1, Bearer JWT)        │
└───────────────────────────────┬───────────────────────────────────┘
                                 │ REST
┌───────────────────────────────▼───────────────────────────────────┐
│ BACKEND  Express + TypeScript  :3001   ({ success, data } envelope) │
│  Controllers → Services                                             │
│   ├─ analytics/dashboard/artist/concert/ingestion/auth/user         │
│   ├─ madAnalytics.service ──HTTP──────────────┐                     │
│   ├─ concertPipeline.service ──spawn python──┐ │                    │
│   ├─ embedding.service ──spawn python──────┐ │ │                    │
│   └─ viberate/{collector,sync,scorer,scheduler} (node-cron 06:00 IST)│
└──────────┬──────────────────────────────┬─┬─┬──────────────────────┘
           │ Prisma                        │ │ │
┌──────────▼──────────┐   ┌────────────────▼─▼─▼───────────────┐
│ PostgreSQL + Redis  │   │ ml_engine/processor.py (heuristic)  │  ← spawned CLI
│ (20+ Prisma models) │   │ ml_engine/embeddings.py (MiniLM)    │  ← spawned CLI
└─────────────────────┘   └─────────────────────────────────────┘
           ▲
           │ direct SQL (SQLAlchemy) + HTTP
┌──────────┴───────────────────────────────────────────────────────┐
│ mad_analytics/ FastAPI  :8001  (SEPARATE PROCESS, optional)         │
│  /revenue /demand /growth /popularity /llm-predict /venue-capacity  │
│  + background scheduler: scrape 12h · retrain 24h · trends 7d       │
│  + models/revenue_model.joblib (REAL trained GradientBoosting)      │
└─────────────────────────────────────────────────────────────────────┘
```

**Key consequence:** if the `mad_analytics` FastAPI process is **not running**, the Analysis page's ML calls fail and fall back to a client-side heuristic (`predictRevenue()` in `Analysis.jsx`), while the concert pipeline still works because it spawns `ml_engine/processor.py` directly. The two Python paths are independent and use **different formulas and different FX rates**.

---

# 3. Complete Repository Map

Top-level: `src/` (frontend), `backend/` (API + TS services + `ml_engine/` + Prisma), `mad_analytics/` (Python ML service), `dist/` (build output), plus docs.

## Frontend — `src/`

| Folder/File | Purpose | Important files | Status |
|-------------|---------|-----------------|--------|
| `src/pages/` | Route-level screens | Dashboard, Artists, ArtistProfile, Concerts, ConcertDetail, Analysis, MapView, AdminIngestion, AdminUsers, Login, NotFound | COMPLETE (Demographics = PLACEHOLDER/unrouted) |
| `src/pages/Artists1.jsx`, `ArtistProfile1.jsx` | — | — | **DEPRECATED / DEAD** (never imported or routed) |
| `src/hooks/` | React Query data hooks | useArtists, useConcerts, useDashboardData, usePredictions, useViberate, useDemographics, useDashboard | Mostly COMPLETE; `useDemographics.js` targets a non-existent endpoint (dead); `useDashboard.js` superseded by `useDashboardData.js` |
| `src/components/` | UI | `viberate/ScoreBreakdown.jsx`, `viberate/ViberateTrends.jsx`, `charts/*`, `layout/*`, `ui/*` | COMPLETE |
| `src/api/client.js` | axios instance, JWT + refresh interceptor | | COMPLETE |
| `src/store/` | Zustand stores | useAuthStore, useFilterStore, useThemeStore | COMPLETE |
| `src/utils/` | helpers | `mockData.js` (feeds only the dead Demographics page), `formatters.js`, `exportCsv.js` | COMPLETE; mockData is legacy |

## Backend — `backend/src/`

| Folder | Purpose | Important files | Status |
|--------|---------|-----------------|--------|
| `controllers/` | HTTP handlers | auth, user, ingestion, dashboard, analytics, madAnalytics, concert, artist | COMPLETE |
| `routes/` | Express routers | auth, user, ingestion, dashboard, analytics, concert, artist, scraping | COMPLETE (`scraping.routes.ts` is a legacy alias) |
| `services/analytics/` | popularity V2 + engagement | `engagement.service.ts` (real), `popularityV2.service.ts` **(EMPTY 0-byte stub)**, `trends.service.ts` **(EMPTY stub)**, `types.ts` | PARTIAL — two dead stubs |
| `services/predictions/` | TS revenue model | `revenuePrediction.service.ts` (`hybrid-revenue-v1`) | COMPLETE but **orphan** (no frontend caller) |
| `services/features/` | feature assembly | `featureEngineering.service.ts` (12 features) | COMPLETE |
| `services/validation/` | event validation | `hybridValidation.service.ts` | COMPLETE |
| `services/normalization/` | raw→canonical | `eventNormalization.service.ts` | COMPLETE |
| `services/deduplication/` | dedupe + embeddings | `duplicateDetection`, `duplicateMerge`, `embedding.service.ts` (spawns Python) | COMPLETE |
| `services/currency/` | FX resolution | `currencyConversion.service.ts` | COMPLETE but **barely used** (1 caller) |
| `services/` (root) | orchestration | `concertPipeline.service.ts` (setlist.fm+Wikidata+spawn python), `concertIntelligence.service.ts`, `concertScraperIngestion.service.ts`, `madAnalytics.service.ts` (HTTP proxy), `artistEnrichment.service.ts` **(STUB)** | Mixed — see notes |
| `services/scrapers/viberate/` | **the live daily pipeline** | collector, sync, scorer, scheduler, sessionHealth, mapper, login | COMPLETE (scheduler queue is scaffolding; email alerts disabled) |
| `services/scrapers/bookmyshow/`, `district/` | TS concert scrapers | scraper + mapper + types | COMPLETE (built this session) |
| `services/scrapers/` (shared) | infra | `jobQueue.ts`, `retry.ts`, `rateLimiter.ts`, `types.ts` | COMPLETE |
| `utils/` | helpers | `artistPopularity.ts` (V1 entropy), `concertRevenue.ts` (display reconciliation), `database.ts` (Prisma+Redis), `logger.ts` | COMPLETE; several `*_test.js`/`*_example.ts` are dev scaffolding |
| `prisma/` | schema + migrations + seed | `schema.prisma`, `viberate-slugs.ts`, 4 migrations | COMPLETE |

## `backend/ml_engine/` — spawned Python scripts (NOT a server)

| File | Purpose | Status |
|------|---------|--------|
| `processor.py` | Heuristic pricing/demand (`heuristic-demand-v4-improved`); reads JSON arg, prints JSON. Used by `concertPipeline.service.ts`. Hardcoded FX (USD=83). | COMPLETE (heuristic only; has typo city keys `"bisbane"`, `"milano"`) |
| `embeddings.py` | Loads `sentence-transformers/all-MiniLM-L6-v2`, returns 384-dim vector. Used by `embedding.service.ts`. | COMPLETE |
| `requirements.txt` | only `sentence-transformers>=2.7.0` | — |

## `mad_analytics/` — the real Python ML service (FastAPI :8001)

| Folder/File | Purpose | Status |
|-------------|---------|--------|
| `server.py` | FastAPI app + background scheduler (scrape 12h / retrain 24h / trends 7d / IG 5d) | COMPLETE |
| `revenue/predictor.py` | GradientBoosting + heuristic **0.55/0.45 blend** | COMPLETE (real model present) |
| `revenue/llm_model.py` | Deterministic pricing heuristic — **not an LLM** | COMPLETE |
| `demand/scorer.py` | Composite demand 0–100 | COMPLETE |
| `popularity/calculator.py` | Entropy 0.50 + Trends 0.25 + RoG 0.25 (reads DB directly) | COMPLETE (docstring wrong; engagement funcs are dead code) |
| `growth/rog_calculator.py` | RoG + Holt forecast + PELT breakpoints + tanh cross-platform | COMPLETE (degrades gracefully w/o statsmodels/ruptures) |
| `venue_capacity/` | resolver + web_search(SerpAPI) + known_venues(~144) + pipeline | COMPLETE |
| `trends/google_trends.py` | pytrends → writes `artists.googleTrendsScore` | COMPLETE |
| `provider/youtube_api.py` | YouTube Data API v3 | COMPLETE |
| `scrapers/` | bookmyshow, district, setlistfm, songkick, instagram(Apify), run_scraper | COMPLETE (parallel to the TS scrapers) |
| `training/` | train_revenue, enrich_venues, update_artist_popularity, validate/verify_concerts | COMPLETE |
| `models/revenue_model.joblib` (+ preprocessor) | **REAL trained GradientBoosting** (300 est, depth 5), trained on 100+ rows | PRESENT |
| `utils/` | schemas (Pydantic), feature_engineering, db, currency, model_store | COMPLETE (currency handling internally inconsistent) |
| `tests/` | pytest suites (popularity, instagram, venue, sell-through) | COMPLETE |

---

# 4. Database

PostgreSQL via Prisma. Envelope note: BigInt columns are JSON-patched in `server.ts`. Below are the major models with read/write ownership.

| Model (table) | Purpose | Key relationships | Written by | Read by | Exposed via API |
|---------------|---------|-------------------|-----------|---------|-----------------|
| **Artist** (`artists`) | Master artist record + legacy denormalized follower columns, `popularity`, `googleTrendsScore`, `viberateSlug`, top cities | 1-N to metrics, concerts, demographics, snapshots, viberateMetrics | n8n; `sync.ts`; `mad_analytics` popularity/trends; artist CRUD | almost everything | `/artists`, `/artists/:id`, dashboard, leaderboard |
| **PlatformMetric** (`platform_metrics`) | Daily per-platform time series (followers/likes/shares/comments/streams + rogDaily/Weekly/Monthly) | N-1 Artist | n8n; Excel import; `sync.ts`; RoG recalc | featureEngineering, dashboard, analytics, growth | `/artists/:id/metrics`, `/analytics/rog`, `/analytics/trends` |
| **Concert** (`concerts`) | Concert events with ticket tiers, revenue, capacity, `demandScore`, `artistCityPopularity`, geo | N-1 Artist; 1-N predictions, demographics, validationLogs; N-1 canonical | Excel import; `concertPipeline`; `mad_analytics` scrapers | dashboard, concerts pages, revenue calc | `/concerts`, `/concerts/:id`, `/concerts/cities`, `/concerts/venues` |
| **Venue** (`venues`) | Curated venue DB (capacity min/max/avg, price ranges, verified) | referenced by name from Concert | `concertPipeline` upsert; `mad_analytics` venue resolver | featureEngineering, validation, venue resolver | (indirect) |
| **AudienceDemographic** (`audience_demographics`) | Age/gender/geography/genre breakdowns | N-1 Artist/Concert | Excel/n8n | featureEngineering (city demand), analytics demographics | `/analytics/demographics/*`, `/artists/:id/demographics` |
| **CanonicalEvent** (`canonical_events`) | Deduplicated event registry + embedding, `confidenceScore`, `fraudRiskScore`, `validationStatus`, `canonicalKey` | 1-N sourceRefs, dupGroups, validationLogs, predictions; N-1 Concert | duplicateMerge, hybridValidation | dedupe, intelligence pipeline | (internal; no direct GET) |
| **SourceEventReference** (`source_event_references`) | Per-source provenance for a canonical event | N-1 CanonicalEvent | duplicateMerge upsert | validation (confirmation count) | (internal) |
| **DuplicateGroup / DuplicateGroupMember** | Clusters of duplicate events + similarity | N-1 CanonicalEvent | duplicateMerge / duplicateDetection | intelligence pipeline | (internal) |
| **ValidationLog** (`validation_logs`) | Audit trail of every validation (rule scores, ML signals) | N-1 CanonicalEvent/Concert | hybridValidation | audit | (internal) |
| **PredictionOutput** (`prediction_outputs`) | Stored predictions (expectedRevenue/Attendance, selloutProbability, demandScore, features JSON, modelVersion) | N-1 Concert/CanonicalEvent | revenuePrediction.service; concertIntelligence | artist/concert revenue reconciliation | (via concert revenue calc) |
| **FeatureSnapshot** (`feature_snapshots`) | Immutable feature sets used per prediction | N-1 Artist/Concert/CanonicalEvent | featureEngineering | reproducibility | (internal) |
| **ArtistTrendScore** (`artist_trend_scores`) | Normalized Google Trends time series | N-1 Artist | (intended: a trends writer) | Viberate `scorer.ts` Layer 3 | (internal) |
| **ArtistPopularityV2Snapshot** (`artist_popularity_v2_snapshots`) | Viberate V2 score history (`v2.1-viberate`: reach/engagement/adjustedReach/trends/final) | N-1 Artist | Viberate `scorer.ts` | leaderboard, artist score | `/artists/leaderboard`, `/artists/:id/score` |
| **ViberateMetricDaily** (`viberate_metrics_daily`) | Raw Viberate daily metrics (incl. tiktok) | N-1 Artist | Viberate `collector.ts` | `sync.ts`, `scorer.ts`, viberate-metrics API | `/artists/:id/viberate-metrics` |
| **PredictionTrainingData / PredictionModel** | ML training rows + model registry | — | revenuePrediction.service; (intended: Python training) | training | (internal) |
| **User / RefreshToken** | Auth | 1-N | auth controller | auth middleware | `/auth/*`, `/users/*` |
| **IngestionJob / ConcertResearchJob** | Job bookkeeping | — | ingestion/concert controllers | admin console | `/ingestion/jobs` |

**Enums of note:** `Platform` has **no TIKTOK** (TikTok data lives only in `viberate_metrics_daily`); `MetricSource = {API, EXCEL_IMPORT}`; `JobType` includes an unused `CONCERT_SCRAPE`; `EventValidationStatus`, `DuplicateGroupStatus`, `ConcertVerificationStatus`.

---

# 5. Data Sources

| Source | Purpose | Implementation status | Data collected | Missing data | Refresh strategy | Confidence |
|--------|---------|----------------------|----------------|--------------|------------------|-----------|
| **Viberate REST** (TS, Playwright session) | Daily social/streaming metrics for 10 slugged artists | **LIVE** (`collector.ts`) | spotify/youtube/instagram/facebook/tiktok followers, listeners, likes, comments, views | Only 10 artists have `viberateSlug`; some artists lack YT/FB/TikTok | Daily 06:00 IST via node-cron | High (authenticated API) |
| **n8n social workflows** | Multi-platform social scrape → `platform_metrics`/`artists` | **INTENDED / EXTERNAL** (docs + `ACHIEVEMENT_REPORT`); not in this repo's runtime code | IG/YT/Spotify/FB/Twitter/Apple via RapidAPI + Gemini enrichment | n8n workflows live outside this repo (`backend/ingestion/n8n-workflows/`) | Daily 2 AM (per docs) | Medium (depends on external n8n) |
| **setlist.fm REST** | Historical concert backfill | **LIVE** (`concertPipeline.service.ts`) | date, venue, city, country, lat/long, tour | ticket price, capacity, revenue (not provided by source) | On-demand via pipeline; from 2021 | Medium (setlist data, no financials) |
| **BookMyShow** | India event discovery | **BUILT (TS)** + **PARALLEL (Python)** | event name, venue, city, date, ticket price range, url | artist normalization is heuristic | On-demand (TS ingestion) / 12h (Python scheduler) | Medium |
| **District (Zomato)** | India event discovery | **BUILT (TS)** + **PARALLEL (Python)** | JSON-LD Event items (name, venue, city, date, price) | city is server-resolved (not selectable) | On-demand / 12h | Medium |
| **Songkick** | Event discovery | **PARALLEL (Python only)** | tour/event listings | — | 12h scheduler | Medium |
| **Instagram (Apify)** | IG profile metrics | **PARALLEL (Python only)** | followers, avg likes/comments, posts | reach/impressions (not public) | Every 5 days | Medium |
| **Google Trends (pytrends)** | Search-interest demand signal | **LIVE (Python)** (`trends/google_trends.py`) writes `artists.googleTrendsScore` | 0–100 relative interest (geo=IN) | Relative within batch; rate-limit fragile | Every 7 days | Medium (unofficial API) |
| **YouTube Data API v3** | Channel subscriber/view counts | **LIVE (Python)** (`provider/youtube_api.py`) | subs, views | API-key dependent | Weekly | High |
| **SerpAPI / Google CSE** | Venue capacity web search | **IMPLEMENTED, key-gated** | capacity from search snippets | needs `GOOGLE_SEARCH_API_KEY`/`CX` | On venue resolution | Medium (0.78–0.92) |
| **Wikidata** | Venue capacity (property P1083) | **LIVE (TS)** (`concertPipeline`) | capacity, venue metadata | sparse coverage | On venue research (toggle env) | Medium |
| **Excel import** | Manual bulk metrics/concerts | **LIVE** (`ingestion.controller.ts`) | Artist_Metrics + Concerts sheets | manual, error-prone | Ad-hoc upload | Depends on file |

---

# 6. Scraping Layer

Two scraper families exist in parallel: **TypeScript** (inside the Express process, share `retry.ts`/`rateLimiter.ts`/`jobQueue.ts`) and **Python** (`mad_analytics/scrapers/`). They overlap on BookMyShow/District.

## TypeScript scrapers

| Scraper | Inputs | Outputs | Retry | Rate limit | Validation | Normalization | Coverage | Known limits |
|---------|--------|---------|-------|-----------|------------|---------------|----------|--------------|
| **Viberate** (`collector.ts`) | slugged artists | `ViberateMetricDaily` rows | 3× backoff (1s→8s), 401/403 = fatal session death | 1.5s+jitter/request, 3s+jitter/artist | session-health precheck | `mapper.ts` | 10 artists, 30-day lookback | Session cookie can expire (email alert disabled — console only); scheduler queue is scaffolding |
| **setlist.fm** (`concertPipeline.service.ts`) | artist name, year range | `ScrapedConcert` → `Concert` | 250ms/page, 404 = "no data" | maxPagesPerYear (default 10) | `validateHybrid` (Jaccard name match ≥0.72, conf ≥0.75) | in-pipeline | from 2021 | no financials from source |
| **BookMyShow** (`bookmyshow/`) | city/artist/date query | `RawConcertEvent[]` | shared `retry.ts` | shared `rateLimiter.ts` | via ingestion → hybridValidation | `district/bookmyshow mapper.ts` + `eventNormalization` | India | artist match is title-substring heuristic |
| **District** (`district/`) | query (city is post-filter) | `RawConcertEvent[]` (JSON-LD) | shared retry | shared limiter | via ingestion | mapper + normalization | India (server-resolved city) | no pagination, city not selectable |

**Ingestion path (TS):** `concertScraperIngestion.service.ts` → `concertIntelligence.ingestRawEvents()` → normalize → `duplicateDetection.detect()` (embedding cosine + heuristics, threshold 0.86) → `duplicateMerge.persistNormalizedEvent()` (create/update/merge into `CanonicalEvent`) → `hybridValidation.validate()` (ValidationLog + confidence/fraud). Predictions/Concert persistence are **off by default** in this phase.

## Python scrapers (`mad_analytics/scrapers/`, driven by the FastAPI scheduler)

`bookmyshow.py`, `district.py`, `setlistfm.py`, `songkick.py`, `instagram.py` (Apify), orchestrated by `run_scraper.store_concerts` and the 12h scheduler in `server.py`. These write concerts directly to Postgres and feed the 24h retrain. This is the pipeline the older docs (`FORMULAS_SIMPLE.md`, `ANALYSIS_PAGE.md`) describe as the production path.

> **Duplication risk:** BookMyShow and District exist as *both* TS and Python scrapers. Which one is authoritative is unresolved — see §13.

---

# 7. Analytics Engine

This is where the "three brains + competing specs" problem is most acute. For each score: business definition, formula(s), inputs, dependencies, storage, consumers, and **implementation status across all implementations found**.

## 7.1 Popularity

**Business definition:** How popular an artist is (0–100) relative to the tracked cohort.

**Implementations found (FOUR + two dead stubs):**

| Impl | File | Formula | Storage | Consumer | Status |
|------|------|---------|---------|----------|--------|
| **V1 entropy (TS)** | `utils/artistPopularity.ts` | `5 + 95·Σ(norm·entropyWeight)`, log1p, Spotify-floor | (returned inline) | featureEngineering `global_popularity`; concertPipeline city popularity | LIVE (internal input) |
| **V2 Viberate (TS)** | `scrapers/viberate/scorer.ts` | reach × engagement × trends, 70/30, `v2.1-viberate` | `ArtistPopularityV2Snapshot` | **ArtistProfile "Score" tab** (`/artists/:id/score`), leaderboard | LIVE (user-facing) |
| **Composite (TS)** | `dashboard.controller.ts` | base followers 0.50 + googleTrends 0.25 + RoG 0.25 | (computed per request; reads `Artist.popularity`) | **Dashboard top-artists** | LIVE |
| **Entropy+Trends+RoG (Python)** | `mad_analytics/popularity/calculator.py` | base 0.50 + Trends 0.25 + RoG 0.25 (writes `Artist.popularity`) | `artists.popularity` | `/analytics/ml/popularity`; Analysis page | LIVE if :8001 up |
| `analytics/popularityV2.service.ts` | — | — | — | — | **EMPTY 0-byte STUB** |

**Doc vs code:** Python docstring claims 55% base + 25% Trends + 20% **Instagram engagement**, but the code uses 50/25/25 with **RoG** — the engagement functions are **dead code**. The `POPULARITY_UPGRADE.md`/`DILJIT_RANKING_PLAN.md` "Option B+D" (make Diljit #1) is what actually shipped in the 50/25/25 Python blend. `artist-iq-popularity-analysis.md` proposes yet another (log10 followers + engagement) formula that is **not implemented**.

## 7.2 Demand

**Business definition:** Audience appetite (0–100) for an artist in a city on a date.

| Impl | File | Formula |
|------|------|---------|
| **Python (canonical per docs)** | `mad_analytics/demand/scorer.py` | `social_velocity·0.40 + ticket_velocity·0.30 + seasonality·0.20 + recency·0.10` ×100 |
| **TS feature blend** | `revenuePrediction.service.ts` `calculateDemandScore` | 8-feature weighted sum (0.18 global + 0.24 local + …) |
| **TS pipeline fallback** | `concertPipeline.service.ts` `calculateFallbackPricing` | `cityPop·0.72 + artistPop·0.18 + cityMarketBoost` |
| **ml_engine heuristic** | `ml_engine/processor.py` | `city_pop·0.65 + artist_pop·0.25 + boost·0.3` |

Storage: `concerts.demandScore`, `prediction_outputs.demandScore` (no field records **which** impl wrote a given row). Consumer: Analysis page (Python `/ml/demand`), revenue prediction. **Docx spec** proposes a *fifth* demand formula (platform 0.35 + momentum 0.35 + Trends 0.20 + city 0.10) — not implemented.

## 7.3 Revenue

**Business definition:** Predicted gross revenue for a concert.

| Impl | File | Method | Consumer | Status |
|------|------|--------|----------|--------|
| **Python ML (documented primary)** | `mad_analytics/revenue/predictor.py` | `0.55·GradientBoosting + 0.45·heuristic`; real `revenue_model.joblib` present | `/analytics/ml/revenue` → Analysis page | LIVE if :8001 up |
| **TS hybrid** | `revenuePrediction.service.ts` | attendance × price via feature-derived sellout prob; `hybrid-revenue-v1` | `POST /concerts/predictions/revenue` | LIVE but **ORPHAN** (no frontend caller) |
| **ml_engine heuristic** | `ml_engine/processor.py` | pricing tiers × sell-through; `typescript-fallback-v1` counterpart in TS | `concertPipeline` (setlist.fm path) | LIVE (spawned) |
| **display reconciliation** | `utils/concertRevenue.ts` | not a predictor — reconciles stored vs predicted for UI | concert/artist pages | LIVE |
| **frontend fallback** | `Analysis.jsx predictRevenue()` | client-side heuristic when ML down | Analysis page | LIVE |

**Flag:** even with the trained model, ~45% of the "ML" number is the rule-based heuristic. Currency handling is **internally inconsistent** across `currency.py` (says USD), `predictor.py` (assumes local), and `train_revenue.py` (mixed local) — see §13.

## 7.4 Risk

**Business definition (two conflicting intents):**
- *Event fraud risk* — is this scraped listing fake? → **implemented** as `fraudRiskScore` in `hybridValidation.service.ts` (`risk = 0.5 − trusted − ticketUrl·0.75 − venue·0.7 − confirmations·0.6 + duplicate + stale + missing`). Stored on `canonical_events`/`validation_logs`. **Not surfaced in the UI.**
- *Prediction/portfolio risk* — how uncertain is the revenue forecast? → **spec only** (`Prediction_Formula.docx` §5: market-saturation + momentum-volatility + trends-gap flags; `ARCHITECTURE_AUDIT.md` proposes a 5-component 0–100 risk). **No implementation exists** under this meaning.

## 7.5 Confidence

**Business definition:** How trustworthy a value is.

- **Event confidence** — `hybridValidation.service.ts` `calculateConfidence` (baseline + extraction confidence + field completeness + rule scores). Stored on `canonical_events`/`validation_logs`. LIVE.
- **Revenue confidence interval** — `mad_analytics/revenue/predictor.py` (10th/90th percentile of staged predictions). LIVE if :8001 up; shown on Analysis page.
- **Confidence *tiers*** (docx §6: High/Medium/Low by signal completeness) — **spec only, not implemented.**
- A second, simpler confidence lives inline in `concertPipeline.service.ts` (setlist.fm validation) — a duplicate of the hybridValidation concept.

## 7.6 CMAS (City Market Attractiveness Score)

**Business definition (inferred):** how attractive a city's live-music market is.

**Status: DOES NOT EXIST.** No formula, acronym, function, or DB column named CMAS anywhere in code or docs. The nearest analogues are `city_demand` (featureEngineering), `city_affinity_score` (docx spec, unimplemented), the hardcoded `cityMarketBoost` lists, and city-tier multipliers in `Analysis.jsx`/`llm_model.py`. CMAS is a **spec gap**, not an implementation gap — it cannot be built without a definition.

---

# 8. Feature Engineering

**TypeScript** — `featureEngineering.service.ts` `buildFeatures()` (Redis-cached 15 min, snapshotted to `feature_snapshots`, version `concert-intelligence-features-v1`):

| Feature | Raw inputs | Calculation | Consumers | Implemented? | Missing deps |
|---------|-----------|-------------|-----------|--------------|--------------|
| `artist_momentum` | `platform_metrics.rog{Daily,Weekly,Monthly}` | `clamp(50 + avgRog·9)` | demand, local_popularity | ✅ | needs RoG populated (Viberate sync) |
| `city_demand` | concerts sell-through, artist city history, geo demographics | weighted blend + cityMarketBoost | demand, local_popularity | ✅ | sparse concert history; demographics rows |
| `venue_performance` | concerts at venue, `venues.verified` | avg sell-through·76 + count | demand | ✅ | flat fallback if no history |
| `ticket_pricing_intelligence` | comparable `concerts.avgTicketPrice` | ratio-to-market bands | demand | ✅ | needs ≥3 comparable concerts |
| `seasonal_trends` | event date | month-boost map + weekend | demand, sellout | ✅ | pure function |
| `engagement_velocity` | `platform_metrics` likes/comments/shares/streams | growth of engagement | demand | ✅ | needs metric history |
| `global_popularity` | Artist follower columns | V1 entropy (`artistPopularity.ts`) | demand, local | ✅ | — |
| `local_popularity` | global + city_demand + momentum | `0.52·g + 0.32·c + 0.16·m` | demand | ✅ | — |
| `venue_capacity` | `venues.*` or fallback 5000 | resolver / default | attendance, revenue | ⚠️ | venue coverage |
| `avg_ticket_price` | `concerts.avgTicketPrice` or fallback | market avg / ₹1,250/$45 | revenue | ⚠️ | comparable concerts |
| `days_until_event`, `is_weekend` | event date | derived | sellout | ✅ | — |

**Python** — `mad_analytics/utils/feature_engineering.py` mirrors much of this (RoG, sell-through, Holt forecast, venue-capacity wrapper) and additionally provides the model features for the GradientBoosting revenue model (`venue_capacity`, `avg_ticket_price`, `price_range`, `max_revenue_naive`, `is_weekend`, `month`, `season`, `city`, `country`, `artist_tier`, `demand_score`, `best_rog_30d`, `cross_platform_score`).

**Not implemented (spec only):** `festival_flag`, artist-specific city tiering, genre-seasonal fit, artist stability/volatility (all proposed in `NEXT_ACHIEVABLES.md`/`ARCHITECTURE_AUDIT.md`).

---

# 9. Prediction Engine

## Revenue prediction
- **Current:** Python `predictor.py` (GradientBoosting 0.55 + heuristic 0.45) via `/analytics/ml/revenue`, consumed by the Analysis page; TS `revenuePrediction.service.ts` exists but is orphaned; `concertPipeline` uses spawned `ml_engine/processor.py` for the setlist.fm path. Confidence interval from staged-prediction percentiles.
- **Future (documented):** ensemble + calibrated uncertainty, scenario analysis, expanded feature set (`ARCHITECTURE_AUDIT.md` Formula 3 V2).

## Sell-through
- **Current:** heuristic `clamp((0.25 + demand_factor·0.5)·venue_factor, 0.15, 0.90)` in both Python `llm_model.py`/`predictor.py` and TS fallback; a popularity-based `min(0.95, 0.30 + pop/100·0.65)` variant documented in `ANALYSIS_PAGE.md`.
- **Future:** per-artist sell-through curves (`NEXT_ACHIEVABLES.md`).

## Venue recommendation
- **Current:** venue *capacity resolution* exists (`venue_capacity/resolver.py`, 6-tier priority, known-venues DB of ~144). Venue *size recommendation* ("what capacity should we book?") is **not implemented**.
- **Future:** optimal-venue-size per city, multi-city tour optimizer (`NEXT_ACHIEVABLES.md` Phase 2/3).

## Ticket pricing
- **Current:** `llm_model.py` dynamic tiers (VIP 4.5× / Tier1 2.2× / Tier2 1× / Tier3 0.5×) with city-market/scarcity/venue-type multipliers, via `/analytics/ml/llm-predict`. TS `calculateFallbackPricing` is a parallel, differently-tuned copy.
- **Future:** artist-tier premium pricing (Superstar/National/Regional).

---

# 10. Frontend

Base: axios `/api/v1`, Bearer JWT, auto-refresh on 401. All pages use live API data **except Demographics** (mock).

| Page | What it shows | Hooks | Endpoints | Ultimate backend source | Status |
|------|---------------|-------|-----------|-------------------------|--------|
| **Dashboard** | KPIs, growth-trend chart, top-10 artists, revenue-by-city, demographics pies, genres, recent concerts | `useDashboardData`, `useFilterStore` | `/dashboard/kpis`, `/dashboard/top-artists`, `/analytics/trends`, `/analytics/genres`, `/artists`, `/concerts`, `/analytics/demographics/{age,gender}` | dashboard + analytics controllers (composite popularity) | COMPLETE (bug: hardcoded chart `yDomain`) |
| **Artists** | Searchable artist grid | `useArtists` | `/artists`, `/concerts` | artist controller (raw `Artist.popularity`) | COMPLETE |
| **ArtistProfile** | Hero + 6 tabs (Platforms, Growth, Concerts, Viberate Trends, **Score**, Demographics) | inline `useQuery`, `useViberate` (via ScoreBreakdown/ViberateTrends) | `/artists/:id[/concerts,/metrics,/demographics]`, `/artists/:id/{viberate-metrics,score}` | artist controller + **Viberate V2 scorer** | COMPLETE (bug: MAX-across-history follower) |
| **Concerts** | Infinite list + metric cards, INR conversion | `useConcerts` | `/concerts` (paginated) | concert controller + `concertRevenue.ts` | COMPLETE |
| **ConcertDetail** | Sell-through ring, revenue breakdown, sponsors, map | `useConcertDetail` | `/concerts/:id` | concert controller | COMPLETE (sponsor split is client-side 0.15 heuristic; sponsors always empty) |
| **Analysis** | Profitability predictor + artist comparison | `usePredictions` (all 6 ML hooks), `useArtists`, `useConcerts` | `POST /analytics/ml/{revenue,growth,demand,popularity,llm-predict,venue-capacity}` | **mad_analytics :8001** (else client fallback) | COMPLETE (graceful fallback; hardcoded CITIES) |
| **MapView** | Leaflet concert map | `useConcerts` | `/concerts` | concert controller | COMPLETE (Leaflet assets from unpkg.com) |
| **Demographics** | pies/bars | none | none | **mockData.js** | **PLACEHOLDER + UNROUTED** |
| **AdminIngestion** | Excel upload, enrich, platform sync, scraper trigger, job log | inline query/mutation | `/ingestion/*`, `/artists`, `/concerts/intelligence` | ingestion + concert controllers | COMPLETE (UI shows 5 sync platforms; backend supports only SPOTIFY) |
| **AdminUsers** | user CRUD | inline | `/users/*` | user controller | COMPLETE |
| **Login** | auth | `useAuthStore` | `/auth/login` | auth controller | COMPLETE |
| **NotFound** | 404 | none | none | — | COMPLETE |

**Dead frontend:** `Artists1.jsx`, `ArtistProfile1.jsx` (never imported), `Demographics.jsx` (unrouted), `useDemographics.js` (calls a non-existent `/analytics/demographics` bare path), `useDashboard.js` (superseded).

---

# 11. API Map

All under `/api/v1`. Envelope `{ success, data }`. Auth = JWT unless noted.

## Auth (`auth.routes.ts`)
| Endpoint | Purpose | Service/Tables | Frontend |
|----------|---------|----------------|----------|
| `POST /auth/login` | issue access+refresh | user, refreshToken | Login |
| `POST /auth/refresh` | rotate access token | refreshToken | axios interceptor |
| `POST /auth/logout` (auth) | revoke | refreshToken | — |
| `GET /auth/me` (auth) | current user | JWT | — |

## Users (`user.routes.ts`, admin-only)
`GET /users`, `POST /users`, `PATCH /users/:id`, `DELETE /users/:id` → user controller → `users` table → AdminUsers.

## Artists (`artist.routes.ts`)
| Endpoint | Purpose | Tables | Frontend |
|----------|---------|--------|----------|
| `GET /artists` | list/search | artist, genres, metrics | Artists, Dashboard |
| `GET /artists/leaderboard` | V2 popularity ranking | `ArtistPopularityV2Snapshot` | (hook exists, unused) |
| `GET /artists/:id` | profile | artist + relations | ArtistProfile |
| `POST/PUT/DELETE /artists[/:id]` | CRUD (admin) | artist | — |
| `GET /artists/:id/metrics` | platform metrics | platformMetric | ArtistProfile |
| `GET /artists/:id/concerts` | artist concerts | concert (+revenue calc) | ArtistProfile |
| `GET /artists/:id/demographics` | demographics | audienceDemographic | ArtistProfile |
| `GET /artists/:id/score` | V2 score breakdown | V2Snapshot | ArtistProfile Score tab |
| `GET /artists/:id/viberate-metrics` | daily series | viberateMetricDaily | Viberate Trends tab |

> Route order: `/leaderboard` **must** precede `/:id` (Express matching).

## Concerts (`concert.routes.ts`)
`GET /` (list), `POST /` `PUT /:id` (admin), `GET /cities`, `GET /venues`, `GET /:id`; pipelines: `GET /pipeline/sources`, `POST /pipeline`, `POST /pipeline/all`, `POST /pipeline/artist`, `POST /intelligence`, `POST /intelligence/queue`, `POST /ingest/scrapers`, `POST /predictions/revenue`. Tables: concert, canonical events, predictions. Frontend: Concerts, ConcertDetail, MapView, AdminIngestion (`/intelligence`). Note: `/predictions/revenue` (TS revenue) has **no frontend caller**.

## Dashboard (`dashboard.routes.ts`, auth, 1h cache)
`GET /kpis` (totals, YTD, avg RoG, top-by-streams), `GET /top-artists` (composite popularity). → Dashboard.

## Analytics (`analytics.routes.ts`, auth)
`GET /rog`, `GET /trends`, `GET /demographics/{age,gender,geo}`, `GET /genres` (analytics controller); `POST /ml/{growth,demand,revenue,llm-predict,venue-capacity,popularity,popularity/all/save}` (madAnalytics controller → **mad_analytics :8001**). Frontend: Dashboard (trends/genres/demographics), Analysis (all ml/*). `demographics/geo` returns coordinates hardcoded to `[0,0]`.

## Ingestion (`ingestion.routes.ts`, admin)
`POST /excel/upload`, `POST /sync/:platform` (SPOTIFY only), `GET /jobs`, `POST /rog/recalculate`, `POST /enrich[/:id]` (enrich is a stub). Frontend: AdminIngestion.

## Scraping (`scraping.routes.ts`, admin)
`POST /scraping/start` → `runIntelligencePipeline` (legacy alias; frontend uses `/concerts/intelligence` instead).

---

# 12. Current Project Status

| Module | Status | Notes |
|--------|--------|-------|
| Auth / Users | ✅ Completed | JWT + refresh, RBAC |
| Prisma schema + DB | ✅ Completed | 20+ models, 4 migrations, in sync |
| Viberate daily pipeline (collect→sync→score) | ✅ Completed | The live production data pipeline; powers ArtistProfile score |
| Concert intelligence (normalize→dedupe→validate) | ✅ Completed | TS ingestion; predictions off by default |
| TS scrapers (BookMyShow, District) + ingestion layer | ✅ Completed | Built recently; parallel to Python scrapers |
| `mad_analytics` FastAPI ML engine | ✅ Completed (as a service) | Real trained model; but requires being run separately |
| Feature engineering (TS + Py) | ✅ Completed | Two parallel implementations |
| Revenue / Demand / Popularity / Growth | 🟡 In Progress | Work, but **fragmented across 3–4 implementations** each |
| Dashboard / Artists / Concerts / Analysis / Map | ✅ Completed | Live data |
| Confidence (event) / Fraud risk | ✅ Completed | Computed + stored, **not surfaced in UI** |
| n8n social ingestion | 🟡 External | Lives outside this repo; assumed running |
| Google Trends / YouTube / Instagram (Python) | ✅ Completed | Inside `mad_analytics` scheduler |
| Prediction/portfolio **Risk Score** | ⛔ Planned | Spec only (docx §5, audit Formula 4) |
| Confidence **tiers** | ⛔ Planned | Spec only (docx §6) |
| **CMAS** | ⛔ Planned | No definition anywhere |
| Venue-size recommendation / tour optimizer | ⛔ Planned | `NEXT_ACHIEVABLES` Phase 2/3 |
| What-if simulator / comparison / heatmap | ⛔ Planned | `NEXT_ACHIEVABLES` Phase 3 |
| `analytics/popularityV2.service.ts`, `trends.service.ts` | ⚠️ Deprecated | Empty 0-byte stubs — delete |
| `artistEnrichment.service.ts` | ⚠️ Deprecated | Stub (does nothing) but wired to live endpoints |
| `Artists1.jsx`, `ArtistProfile1.jsx`, `Demographics.jsx`, `useDemographics.js`, `useDashboard.js` | ⚠️ Deprecated | Dead / unrouted / broken |
| `/concerts/predictions/revenue` (TS revenue) | ⚠️ Orphan | No consumer; decide keep-or-cut |
| CI/CD, prediction-accuracy tracking | ⛔ Planned | `NEXT_ACHIEVABLES` Phase 4 |

---

# 13. Gap Analysis

## Critical (blocks correctness / trust)

1. **Metric fragmentation — 3–4 implementations per score, no source-of-truth tag.** Popularity (4), Demand (4), Revenue (3+) all write the same columns with no `modelVersion`/source discriminator on many paths. *Why it matters:* the number a user sees depends on which brain answered, and historical rows are not comparable. This is the #1 correctness risk.
2. **`mad_analytics` :8001 is a hard, unmonitored dependency for the Analysis page.** If it is not running, ML calls fail and the UI silently drops to a client-side heuristic — with no indication the "prediction" is now a guess. *Why:* production predictions can silently degrade.
3. **Revenue "ML" is half heuristic + currency is internally inconsistent.** The 0.55/0.45 blend plus contradictory local/USD assumptions across `currency.py`/`predictor.py`/`train_revenue.py` means revenue figures may be systematically off, especially for non-INR concerts. *Why:* revenue is the flagship output.
4. **Two independent Python engines with different formulas/FX** (`ml_engine/processor.py` vs `mad_analytics`) produce different revenue/pricing for the same concert depending on the entry path (concertPipeline vs Analysis). *Why:* inconsistent answers for identical inputs.

## High (blocks documented features)

5. **Risk Score (prediction/portfolio) not implemented** — only event-fraud risk exists; the docx/audit risk spec has no code.
6. **Confidence tiers not implemented** — only a numeric confidence exists; the High/Medium/Low signal-completeness tiers are spec-only.
7. **Google Trends writer split-brain** — Python writes `artists.googleTrendsScore`, but the Viberate V2 scorer reads `ArtistTrendScore` (a different table nothing populates in TS), so V2 Trends layer silently falls back to reach-only.
8. **BookMyShow/District scraper duplication** — TS and Python both scrape them; no decision on which is authoritative → double maintenance, possible double-ingestion.

## Medium (quality / coverage)

9. **`artistEnrichment.service.ts` is a stub** wired to live `/ingestion/enrich` endpoints — the buttons do nothing.
10. **AdminIngestion sync UI advertises 5 platforms; backend supports only SPOTIFY** (others 400).
11. **Demographics is entirely mock** and its geo endpoint returns `[0,0]` coordinates — no real geocoding.
12. **Venue coverage thin** — capacity is the top revenue feature; `NEXT_ACHIEVABLES` calls for 500+ Indian venues vs ~144/206 today.
13. **CMAS undefined** — cannot be built without a spec; requirement should be clarified or dropped.

## Low (hygiene)

14. Dead files: empty stubs (`popularityV2/trends.service.ts`), `Artists1/ArtistProfile1.jsx`, unrouted `Demographics.jsx`, broken `useDemographics.js`, orphan `/concerts/predictions/revenue`, `*_test.js` scaffolding in `utils/`.
15. Known UI bugs (from `CLAUDE.md`): Dashboard hardcoded `yDomain`, ArtistProfile MAX-across-history follower, orphaned blank Artist row.
16. External asset dependencies embedded in-app (`ui-avatars.com`, `unpkg.com` Leaflet) — offline/CSP fragility.
17. Session-expiry alerting for Viberate is console-only (nodemailer path commented out).

---

# 14. Recommended Development Roadmap

Ordered to de-risk correctness first, then consolidate, then extend. No new speculative redesigns — every phase is grounded in what already exists.

### Phase 0 — Instrument & decide (foundation)
- **Goal:** Make the current system observable and pick canonical implementations before changing behavior.
- **Tasks:** Add a `source`/`modelVersion` tag to every write of popularity/demand/revenue/confidence; add a health-gate + visible "degraded/heuristic" flag when `mad_analytics` :8001 is down; confirm in production which of the two Python engines is actually deployed.
- **Dependencies:** none.
- **Complexity:** Low.
- **DoD:** Every stored score is attributable to a producer; the Analysis page visibly distinguishes ML vs fallback.
- **Risk:** Low. (Highest-leverage, lowest-risk step.)

### Phase 1 — Consolidate Popularity → one implementation
- **Goal:** Single popularity number everywhere.
- **Tasks:** Choose canonical (recommend **Viberate V2** for display, keep V1 entropy renamed as an internal `reachScore` input); repoint Dashboard composite and Analysis to the canonical source (same response field names); populate the Trends table the V2 scorer reads (fix the split-brain in gap #7); delete the empty stubs and wire/remove `useLeaderboard`.
- **Dependencies:** Phase 0 tagging.
- **Complexity:** Medium.
- **DoD:** Dashboard, Artists, ArtistProfile, Analysis all show the same popularity for a given artist; only one code path computes it.
- **Risk:** Medium (user-visible ranking changes — validate against `POPULARITY_UPGRADE` expected rankings).

### Phase 2 — Consolidate Revenue + Demand behind one interface
- **Goal:** One predictor, one demand score, consistent currency.
- **Tasks:** Define a single prediction interface; based on Phase 0's answer, make either the Python model or the TS service primary with the other as explicit fallback (tagged `model_version`); route `/analytics/ml/revenue`, `/concerts/predictions/revenue`, and `concertPipeline` through it; **fix the currency inconsistency** (pick one: train and predict in a single base currency, convert only for display); retire `calculateFallbackPricing` as an independent third formula; keep `concertRevenue.ts` as the display read-model.
- **Dependencies:** Phase 0, Phase 1 (popularity feeds demand).
- **Complexity:** High.
- **DoD:** Same concert inputs yield the same revenue regardless of entry path; non-INR concerts verified correct; one demand formula.
- **Risk:** High (flagship number changes — regression-test against known concerts).

### Phase 3 — Consolidate Confidence + implement Risk
- **Goal:** One validation confidence; deliver the documented Risk score.
- **Tasks:** Make `concertPipeline`'s inline confidence call `hybridValidation.service.ts`; implement prediction-Risk (docx §5 / audit Formula 4) as a new service consuming existing features + prediction bounds; add confidence tiers (docx §6); surface confidence/risk in the UI (ConcertDetail/Analysis).
- **Dependencies:** Phase 2 (risk needs prediction bounds).
- **Complexity:** Medium.
- **DoD:** One confidence path; a Risk score computed, stored, and displayed; tiers shown as badges.
- **Risk:** Medium.

### Phase 4 — Scraper & data-source consolidation
- **Goal:** One authoritative scraper per source; broaden coverage.
- **Tasks:** Decide TS vs Python for BookMyShow/District and retire the loser; enable/repair `artistEnrichment`; fix AdminIngestion platform-sync mismatch (or implement the missing syncs); expand venue DB toward 500+ Indian venues (`NEXT_ACHIEVABLES` Phase 1/2); add festival/Setlist backfill.
- **Dependencies:** Phase 0.
- **Complexity:** Medium–High.
- **DoD:** No duplicated scraper for a source; enrich endpoints do real work; venue coverage target met.
- **Risk:** Medium (scraper brittleness).

### Phase 5 — Fill product gaps & harden
- **Goal:** Ship the promoter-facing decision tools and quality infra.
- **Tasks:** Real Demographics (route it + geocode, or remove); venue-size recommendation + tour optimizer; what-if simulator / comparison / heatmap (`NEXT_ACHIEVABLES` Phase 3); CI/CD + test suite + prediction-accuracy tracking (Phase 4); resolve CMAS (define or drop); clean up dead files and known UI bugs.
- **Dependencies:** Phases 1–4.
- **Complexity:** High (breadth).
- **DoD:** Demographics is real or gone; promoter tools live; CI green on push; accuracy tracked per artist.
- **Risk:** Medium.

---

*End of MASTER_PROJECT.md — the single source of truth. When code and docs diverge, this document reflects verified code reality as of 2026-07-21; update it as consolidation lands.*

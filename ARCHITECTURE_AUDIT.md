# ANALYTICS ARCHITECTURE AUDIT REPORT
**Generated:** 2025-06-23  
**Scope:** Backend Services, Controllers, Routes, Database Schema, Python Analytics Modules, Frontend Hooks  
**Status:** PRODUCTION-GRADE ARCHITECTURE (Ready for Enhancement)

---

## TABLE OF CONTENTS
1. [Executive Summary](#executive-summary)
2. [Architecture Overview](#architecture-overview)
3. [Dependency Mapping](#dependency-mapping)
4. [Analytics-Related Files Inventory](#analytics-related-files-inventory)
5. [Formula Inventory](#formula-inventory)
6. [Replacement Impact Analysis](#replacement-impact-analysis)
7. [Implementation Roadmap](#implementation-roadmap)

---

## EXECUTIVE SUMMARY

### Current State
The Artist Analytics Dashboard operates on a **hybrid architecture** combining:
- **Frontend Layer:** React hooks consuming REST API endpoints
- **Backend Layer:** TypeScript services (ExpressJS) with calculations and caching
- **Analytics Layer:** Python modules (mad_analytics) for complex ML/statistical models
- **Data Layer:** PostgreSQL + Redis (caching)

### Key Findings
✅ **Well-Organized Stack Separation**
- REST API layer cleanly separated from business logic
- Database queries isolated in services
- Redis caching implemented for high-traffic endpoints
- Python analytics decoupled from Node backend via HTTP calls

⚠️ **Formula Maturity Status**
- Basic formulas: Demand Score, Revenue Prediction, Popularity Score (V1)
- Advanced formulas: Growth (RoG) Calculator, Venue Capacity Resolution
- Validation system: Hybrid validation (rule-based + ML signals)
- **Missing:** Risk Score, Confidence Score (V2), advanced confidence metrics

⚠️ **Integration Points**
- Frontend → Backend: REST API via React Query
- Backend → Python Analytics: HTTP POST to `http://localhost:8001`
- Database → Services: Prisma ORM
- Caching: Redis with TTL-based invalidation

---

## ARCHITECTURE OVERVIEW

### System Stack

```
┌─────────────────────────────────────────────────────────┐
│          FRONTEND (React)                                │
│  useDashboard, usePredictions, useConcerts              │
│  useAnalytics, useDemographics, useDemand               │
└──────────────────┬──────────────────────────────────────┘
                   │ REST API (axios client)
                   ▼
┌─────────────────────────────────────────────────────────┐
│    BACKEND (Node.js / Express)                          │
│                                                         │
│  Routes:                                                │
│  ├─ /api/v1/analytics/* (RoG, Trends, Demographics)    │
│  ├─ /api/v1/dashboard/* (KPIs, Top Artists)           │
│  ├─ /api/v1/concerts/* (List, Create, Intelligence)    │
│                                                         │
│  Controllers:                                           │
│  ├─ analytics.controller.ts (RoG, Trends, Demographics)│
│  ├─ dashboard.controller.ts (KPIs, Top Artists)        │
│  ├─ madAnalytics.controller.ts (ML endpoints)          │
│  ├─ concert.controller.ts (Concert CRUD + Pipeline)    │
│                                                         │
│  Services:                                              │
│  ├─ Feature Engineering Service                        │
│  ├─ Revenue Prediction Service                         │
│  ├─ Concert Pipeline Service                           │
│  ├─ Concert Intelligence Service                       │
│  ├─ Validation Service (Hybrid)                        │
│  ├─ Artist Enrichment Service                          │
└──────────────────┬──────────────────────────────────────┘
                   │ HTTP POST to Python
                   ▼
┌─────────────────────────────────────────────────────────┐
│    PYTHON ANALYTICS (mad_analytics)                     │
│    http://localhost:8001                                │
│                                                         │
│  Modules:                                               │
│  ├─ demand/scorer.py (Demand Score V1)                 │
│  ├─ growth/rog_calculator.py (Growth Forecast)         │
│  ├─ popularity/calculator.py (Popularity Score V1)     │
│  ├─ revenue/predictor.py (Revenue Prediction ML)       │
│  ├─ revenue/llm_model.py (Heuristic Revenue Model)    │
│  ├─ venue_capacity/pipeline.py (Venue Capacity)        │
└──────────────────┬──────────────────────────────────────┘
                   │ SQL Queries
                   ▼
┌─────────────────────────────────────────────────────────┐
│    DATA LAYER                                           │
│                                                         │
│  PostgreSQL:                                            │
│  ├─ artists, platform_metrics, concerts                │
│  ├─ audience_demographics, prediction_outputs          │
│  ├─ canonical_events, validation_logs                  │
│  └─ venues, feature_snapshots                          │
│                                                         │
│  Redis Cache:                                           │
│  ├─ rog:*, trends:*, demo:*, dashboard:*              │
│  └─ artist-popularity:entropy-weights:v1              │
└─────────────────────────────────────────────────────────┘
```

### Tech Stack Details

| Layer | Technology | Version | Purpose |
|-------|-----------|---------|---------|
| **Frontend** | React 18 | - | Dashboard UI & analytics visualization |
| **State Management** | TanStack Query (React Query) | - | Server state caching & synchronization |
| **Backend** | Express.js + TypeScript | Node 18+ | REST API, business logic, orchestration |
| **ORM** | Prisma | 5.x | Type-safe database access |
| **Database** | PostgreSQL | 14+ | Relational data storage |
| **Cache** | Redis | 7+ | Query result caching (1hr TTL typical) |
| **Analytics** | Python (mad_analytics) | 3.9+ | Complex ML models & calculations |
| **ML Libs** | sklearn, pandas, numpy | Latest | ML models, dataframe operations |
| **API HTTP** | axios (frontend), fetch (backend) | - | REST communication |

---

## DEPENDENCY MAPPING

### Data Flow: Database → Calculation → Controller → Route → Frontend Hook → Component

#### 1. **Demand Score Path**

```
Database
├─ artists.id, platform_metrics.*
├─ concerts (city, date, capacity)
└─ audience_demographics

      ↓ (Python HTTP POST)

mad_analytics/demand/scorer.py
├─ Input: DemandInput (artist_id, city, platform_metrics, recent_concerts)
├─ Calculation:
│  ├─ social_velocity (40%) = platform followers growth rate
│  ├─ ticket_velocity (30%) = past concert sell-through
│  ├─ seasonality (20%) = month + weekend factor
│  └─ recency (10%) = days since last show in city
├─ Output: DemandOutput { score: 0-100, components }
└─ Return: HTTP 200 JSON

      ↓ (Backend orchestration)

backend/src/services/madAnalytics.service.ts
├─ getDemandScore(): aggregates payload + calls Python
├─ Caches result locally for 5 min
└─ Returns to controller

      ↓

backend/src/controllers/madAnalytics.controller.ts
├─ Route: POST /api/v1/analytics/ml/demand
├─ Handler: getDemandScore()
├─ Response: { success: true, data: { score, components } }
└─ Status: 200

      ↓

backend/src/routes/analytics.routes.ts
├─ Endpoint: POST /api/v1/analytics/ml/demand
└─ Authentication: Required (authenticate middleware)

      ↓

src/hooks/usePredictions.js
├─ Hook: useMadDemand(artistId, city, enabled, options)
├─ Query: POST /api/v1/analytics/ml/demand
├─ Caching: 5 min stale time
└─ Refetch: On manual trigger or stale

      ↓

src/pages/ConcertDetail.jsx (or similar)
├─ Display: Demand Score badge
├─ Color: Green (>70), Yellow (40-70), Red (<40)
└─ Alongside: Predicted revenue, attendance
```

#### 2. **Revenue Prediction Path**

```
Database
├─ artists (popularity metrics)
├─ platform_metrics (growth data)
├─ concerts (venue, capacity, prices)
└─ prediction_outputs (historical)

      ↓ (TypeScript Feature Engineering)

backend/src/services/features/featureEngineering.service.ts
├─ buildFeatures(): assembles rich feature set
├─ Calculates:
│  ├─ artist_momentum (from RoG data)
│  ├─ city_demand (from concert history + demographics)
│  ├─ venue_performance (historical capacity fills)
│  ├─ ticket_pricing_intelligence (market analysis)
│  ├─ seasonal_trends (month-based boost/penalty)
│  ├─ engagement_velocity (social media trends)
│  ├─ global_popularity (entropy-weighted score)
│  └─ local_popularity (global + city + momentum weighted)
├─ Returns: ConcertFeatureSet
└─ Caches: 15 min Redis TTL

      ↓

backend/src/services/predictions/revenuePrediction.service.ts
├─ predict(): runs hybrid model
├─ Calculates:
│  ├─ demand_score (weighted feature average)
│  ├─ sellout_probability (demand + capacity + timing)
│  └─ expected_revenue (attendance * avg_ticket_price)
├─ Model: hybrid-revenue-v1
├─ Stores: PredictionOutput + PredictionTrainingData
└─ Returns: RevenuePredictionResult

      ↓ (Backend orchestration)

backend/src/controllers/madAnalytics.controller.ts
├─ Route: POST /api/v1/analytics/ml/revenue
├─ Handler: getRevenuePrediction()
├─ Payload: { artist_id, city, capacity, avg_ticket_price, event_date }
└─ Response: { expected_revenue, expected_attendance, demand_score, features }

      ↓

backend/src/routes/analytics.routes.ts
├─ Endpoint: POST /api/v1/analytics/ml/revenue
└─ Authentication: Required

      ↓

src/hooks/usePredictions.js
├─ Hook: useAutoPredict(artistId, city, capacity, enabled, options)
├─ Query: POST /api/v1/analytics/ml/revenue
├─ Caching: Infinite stale time (one-shot query)
└─ Refetch: On manual trigger only

      ↓

src/pages/ConcertDetail.jsx or ConcertCreate.jsx
├─ Display: Revenue forecast card
├─ Show: Ticket breakdown, attendance prediction, confidence
└─ Action: Allow user to accept/adjust prediction
```

#### 3. **Popularity Score Path**

```
Database
├─ artists (spotify, youtube, instagram, facebook, twitter followers)
└─ platform_metrics (time series data)

      ↓ (Python entropy calculation)

mad_analytics/popularity/calculator.py
├─ _build_platform_matrix(): time series per platform
├─ _entropy_weights(): compute diversity-based weights
│  ├─ Spotify floor: 40% (core music metric)
│  ├─ Twitter cap: 25% (missing data common)
│  └─ Others: entropy-weighted
├─ normalize_to_score(): map to 0-100 range
└─ Returns: PopularityOutput { score, platform_weights }

      ↓ OR (TypeScript fallback calculation)

backend/src/utils/artistPopularity.ts
├─ calculateArtistPopularity(): TypeScript version
├─ getEntropyArtistPopularityModel(): builds entropy model from active artists
├─ Uses same algorithm as Python for consistency
└─ Caches: 1 hour Redis TTL (cache key: artist-popularity:entropy-weights:v1)

      ↓

backend/src/services/madAnalytics.service.ts
├─ getPopularityScore(): calls Python OR TypeScript version
├─ saveAllPopularityScores(): batch update for all artists
└─ Stores: Artist.popularity field

      ↓

backend/src/controllers/madAnalytics.controller.ts
├─ Route: POST /api/v1/analytics/ml/popularity
├─ Handler: getPopularityScore()
└─ Response: { score: 0-100, platform_breakdown }

      ↓

src/hooks/usePredictions.js
├─ Hook: useMadPopularity(artistId, enabled)
├─ Query: POST /api/v1/analytics/ml/popularity
├─ Caching: 5 min stale time
└─ Refetch: On demand or periodic

      ↓

src/pages/ArtistProfile.jsx
├─ Display: Popularity score gauge
├─ Show: Platform breakdown pie chart
└─ Context: Relative to top artists
```

#### 4. **Growth (RoG) Path**

```
Database
└─ platform_metrics.rog{Daily|Weekly|Monthly}
   (calculated during ingestion)

      ↓ (Python RoG calculation)

mad_analytics/growth/rog_calculator.py
├─ Input: GrowthInput { artist_id, platform_metrics }
├─ For each platform:
│  ├─ Calculate 30-day RoG: (current - 30d_ago) / 30d_ago
│  ├─ Forecast 90 days ahead (Holt exponential smoothing)
│  ├─ Detect trend (rising/stable/declining)
│  └─ Flag anomalies (>3σ from baseline)
├─ Cross-platform score: weighted average
│  ├─ Spotify 25%, YouTube 20%, Instagram 20%
│  ├─ Twitter 10%, Facebook 10%, Apple Music 15%
│  └─ Result normalized to 0-100
└─ Returns: GrowthOutput { per-platform forecasts, cross_platform_score }

      ↓

backend/src/controllers/analytics.controller.ts
├─ Route: GET /api/v1/analytics/rog
├─ Query params: ?artistId=X&platform=Y&period=daily|weekly|monthly
├─ Caches: 1 hour Redis TTL
└─ Response: { results: [{ artistId, platform, rog, metricDate }] }

      ↓

backend/src/routes/analytics.routes.ts
├─ Endpoint: GET /api/v1/analytics/rog
└─ Authentication: Required

      ↓

src/hooks/usePredictions.js
├─ Hook: useMadGrowth(artistId, enabled)
├─ Query: POST /api/v1/analytics/ml/growth
├─ Caching: 5 min stale time
└─ Shows: Platform-specific growth trends

      ↓

src/pages/Dashboard.jsx
├─ Display: "Platform Growth Trends" line chart
├─ Axes: Time (x), Followers/Streams aggregated (y)
└─ Breakdown: Per-platform line colors
```

#### 5. **Analytics Dashboard Path (KPIs)**

```
Database (Multiple queries)
├─ artists (count active)
├─ concerts (count total, YTD totals)
├─ platform_metrics (RoG last 30 days)
└─ prediction_outputs (latest per concert)

      ↓

backend/src/controllers/dashboard.controller.ts
├─ Route: GET /api/v1/dashboard/kpis
├─ Calculations:
│  ├─ totalArtists: COUNT(artists WHERE active=true)
│  ├─ totalConcerts: COUNT(concerts)
│  ├─ concertsYTD: SUM(revenue, tickets) WHERE date >= Jan 1
│  ├─ avgRoGDaily: AVG(rog_daily) WHERE date >= 30 days ago
│  └─ topArtistByStreams: Artist with max streams last month
├─ Caches: 1 hour Redis TTL
└─ Response: { totalArtists, totalConcerts, ticketsSoldYTD, revenueYTD, avgRoGDaily, topArtistByStreams }

      ↓

backend/src/routes/dashboard.routes.ts
├─ Endpoint: GET /api/v1/dashboard/kpis
└─ Authentication: Required

      ↓

src/hooks/useDashboardData.js
├─ Hook: useDashboardData()
├─ Query: GET /api/v1/dashboard/kpis
├─ Caching: 5 min stale time
└─ Queries: Also fetches trends, genres, top artists

      ↓

src/pages/Dashboard.jsx
├─ Display: KPI cards (total artists, concerts, revenue YTD)
├─ Show: Top artist card with photo
└─ Context: Year-to-date metrics
```

---

## ANALYTICS-RELATED FILES INVENTORY

### Backend Services (`backend/src/services/`)

#### Core Analytics Services

| File | Purpose | Functions Exported | Inputs | Outputs | Database Tables | Redis Cache |
|------|---------|-------------------|--------|---------|-----------------|-------------|
| `madAnalytics.service.ts` | Orchestration layer for Python analytics | `getGrowthForecast()`, `getDemandScore()`, `getRevenuePrediction()`, `getLlmPrediction()`, `getVenueCapacity()`, `getPopularityScore()`, `saveAllPopularityScores()` | Payload objects (artist_id, metrics, city, capacity) | Growth forecast, demand score, revenue prediction | Artists, PlatformMetrics | ✗ (calls Python which caches) |
| `artistEnrichment.service.ts` | Artist metadata & social enrichment | `enrichArtistProfile()` | Artist ID or name | Enriched artist data | Artists, PlatformMetrics | Likely yes |
| `concertPipeline.service.ts` | Concert discovery & processing | `runPipeline()`, `runPipelineForAllArtists()` | Artist ID or all active | Processed concerts | Concerts, CanonicalEvents | ✗ |
| `concertIntelligence.service.ts` | Multi-layer concert intelligence | `runDiscoveryPipeline()`, `ingestRawEvents()`, `predictForEvent()`, `persistPredictedConcert()` | Raw events, options | Validated & predicted concerts | CanonicalEvents, Concerts, ValidationLogs, DuplicateGroups, PredictionOutputs | ✗ |
| `features/featureEngineering.service.ts` | Feature assembly for ML models | `buildFeatures()` | Event details (artist, city, capacity, price, date) | 12-feature set (momentum, demand, seasonality, etc.) | Artists, PlatformMetrics, Concerts, AudienceDemographics | Yes (15 min TTL) |
| `predictions/revenuePrediction.service.ts` | Revenue & attendance prediction | `predict()` | Event + feature input | Expected revenue, attendance, sellout probability, demand score | PredictionOutputs, PredictionTrainingData | ✗ (features cached) |
| `validation/hybridValidation.service.ts` | Event validation (rule + ML signals) | `validate()` | Normalized event + context | Confidence score, fraud risk, validation status, reasons | ValidationLogs, CanonicalEvents | ✗ |
| `deduplication/duplicateDetection.service.ts` | Duplicate event detection | `detect()` | Normalized event | List of similar events + similarity scores | CanonicalEvents, DuplicateGroups | ✗ |
| `deduplication/duplicateMerge.service.ts` | Merge duplicate events | `persistNormalizedEvent()` | Normalized event + duplicates | Canonical event + merge action | CanonicalEvents, DuplicateGroups, DuplicateGroupMembers | ✗ |
| `normalization/eventNormalization.service.ts` | Raw event standardization | `normalizeBatch()`, `normalize()` | Raw event from scraper | Normalized event | ✗ | ✗ |

### Backend Controllers (`backend/src/controllers/`)

| File | Routes Handled | Main Endpoints | Database Queries | Cache TTL | Purpose |
|------|------------------|-----------------|------------------|-----------|---------|
| `analytics.controller.ts` | `/api/v1/analytics/*` | `getRoG`, `getTrends`, `getDemographicsAge`, `getDemographicsGender`, `getDemographicsGeo`, `getGenres` | PlatformMetrics, AudienceDemographics | 1 hour | Core analytics metrics & trends |
| `dashboard.controller.ts` | `/api/v1/dashboard/*` | `getKPIs`, `getTopArtists` | Artists, Concerts, PlatformMetrics, PredictionOutputs | 1 hour | Dashboard homepage aggregates |
| `madAnalytics.controller.ts` | `/api/v1/analytics/ml/*` | `getGrowthForecast`, `getDemandScore`, `getRevenuePrediction`, `getLlmPrediction`, `getVenueCapacity`, `getPopularityScore`, `saveAllPopularityScores` | Delegates to madAnalytics.service | 5 min (Python) | ML model endpoints |
| `concert.controller.ts` | `/api/v1/concerts*` | `list`, `create`, `update`, `getCities`, `getVenues`, `runPipeline`, `runIntelligencePipeline` | Concerts, Artists, PredictionOutputs | Varies | Concert CRUD & intelligence pipelines |
| `analytics.controller.ts` (demographics) | `/api/v1/analytics/demographics*` | `getDemographicsAge`, `getDemographicsGender`, `getDemographicsGeo` | AudienceDemographics | 1 hour | Audience breakdown analytics |

### Backend Routes (`backend/src/routes/`)

| File | Base Path | Key Routes | Auth Required | Purpose |
|------|-----------|-----------|---------------|---------|
| `analytics.routes.ts` | `/api/v1/analytics` | `GET /rog`, `GET /trends`, `POST /ml/growth`, `POST /ml/demand`, `POST /ml/revenue`, `GET /demographics/*`, `POST /ml/popularity` | Yes | Analytics & ML endpoints |
| `dashboard.routes.ts` | `/api/v1/dashboard` | `GET /kpis`, `GET /top-artists` | Yes | Dashboard aggregates |
| `concert.routes.ts` | `/api/v1/concerts` | `GET /`, `POST /`, `PUT /:id`, `GET /cities`, `POST /pipeline`, `POST /intelligence` | Varies | Concert management & intelligence |
| `artist.routes.ts` | `/api/v1/artists` | `GET /`, `POST /`, `GET /:id`, `PUT /:id` | Varies | Artist CRUD |

### Backend Utilities (`backend/src/utils/`)

| File | Purpose | Key Exports | Usage |
|------|---------|------------|-------|
| `artistPopularity.ts` | Entropy-weighted popularity calculation | `calculateArtistPopularity()`, `getEntropyArtistPopularityModel()`, `buildEntropyArtistPopularityModel()` | Used in feature engineering & dashboard |
| `concertRevenue.ts` | Revenue reconciliation | `calculateConcertMetrics()`, `calculateConcertRevenue()` | Concert list & detail views |
| `database.ts` | Prisma client + Redis | `prisma`, `redis` | Global DB & cache access |
| `logger.ts` | Logging utility | `logger` | Service-wide logging |

### Frontend Hooks (`src/hooks/`)

| File | Key Hooks | API Endpoints Called | Cache Strategy | Used By |
|------|-----------|------------------|-----------------|---------|
| `usePredictions.js` | `useAutoPredict()`, `useMadGrowth()`, `useMadDemand()`, `useMadPopularity()`, `useMadLlmPrediction()` | POST `/ml/revenue`, `/ml/growth`, `/ml/demand`, `/ml/popularity` | 5 min stale (growth, demand), Infinite (auto-predict) | ConcertDetail, ConcertCreate |
| `useDashboardData.js` | `useDashboardData()` | GET `/dashboard/kpis`, `/dashboard/top-artists`, `/analytics/trends`, `/analytics/genres` | 5-10 min stale | Dashboard page |
| `useConcerts.js` | Concert query hooks | GET `/concerts`, `/concerts/:id` | Varies | Concert list, detail pages |
| `useArtists.js` | Artist query hooks | GET `/artists`, `/artists/:id` | Varies | Artist list, profile pages |
| `useDemographics.js` | Demographics queries | GET `/analytics/demographics/*` | 5-10 min stale | Demographics page |

### Python Analytics Modules (`mad_analytics/`)

| Module | File | Purpose | Input Schema | Output Schema | Database Access | ML Model |
|--------|------|---------|--------------|---------------|-----------------|----------|
| **demand** | `scorer.py` | Composite demand score (0-100) | `DemandInput` | `DemandOutput` | Reads platform_metrics, concerts | Rule-based: social_velocity (40%) + ticket_velocity (30%) + seasonality (20%) + recency (10%) |
| **growth** | `rog_calculator.py` | Rate-of-Growth + forecast | `GrowthInput` | `GrowthOutput` | Reads platform_metrics | Time-series: RoG calculation + Holt exponential smoothing + cross-platform weighting |
| **popularity** | `calculator.py` | Entropy-weighted popularity (0-100) | Artist object | `PopularityOutput` | Reads artists table | Information entropy: Spotify floor 40%, Twitter cap 25%, others by entropy |
| **revenue** | `predictor.py` | ML revenue prediction | `RevenueInput` | `RevenueOutput` | Reads concerts, platform_metrics, venues | sklearn GradientBoostingRegressor (trained model in `models/revenue_model.joblib`) |
| **revenue** | `llm_model.py` | Heuristic revenue prediction | `LlmPredictorPayload` | `LlmPredictorOutput` | Reads artists, venues | Rule-based: artist_popularity + city_boost + venue_type + scarcity multipliers |
| **venue_capacity** | `pipeline.py`, `resolver.py` | Venue capacity resolution | `VenueCapacityInput` | `VenueCapacityOutput` | Reads/writes concerts, venues | Multi-source: concert history aggregation + web search + known venue DB |

### Database Schema (`backend/prisma/schema.prisma`)

#### Relevant Tables for Analytics

| Table | Columns | Purpose | Related Tables |
|-------|---------|---------|-----------------|
| `artists` | id, artistName, popularity, spotifyMonthlyListeners, youtubeSubscribers, instagramFollowers, facebookFollowers, twitterFollowers, topCity1-5 | Artist master data | platformMetrics, concerts, audienceDemographics |
| `platform_metrics` | id, artistId, platform, metricDate, followers, likes, shares, comments, streams, rogDaily, rogWeekly, rogMonthly | Daily platform growth metrics | artists |
| `concerts` | id, artistId, concertDate, city, capacity, ticketsSold, avgTicketPrice, totalRevenue, demandScore | Concert event data | artists, predictionOutputs, audienceDemographics, validationLogs |
| `audience_demographics` | id, artistId, concertId, dimension (AGE_GROUP|GENDER|LOCATION), dimensionValue, percentage, absoluteCount, metricDate | Demographic breakdown | artists, concerts |
| `prediction_outputs` | id, concertId, canonicalEventId, modelVersion, expectedRevenue, expectedAttendance, selloutProbability, demandScore, features, createdAt | ML predictions per concert | concerts, canonicalEvents |
| `feature_snapshots` | id, artistId, concertId, canonicalEventId, features, featureSetVersion | Feature sets used for predictions | artists, concerts, canonicalEvents |
| `canonical_events` | id, artistName, venueName, eventDate, confidenceScore, fraudRiskScore, validationStatus | Deduplicated event records | duplicateGroups, sourceEventReferences, validationLogs |
| `validation_logs` | id, canonicalEventId, confidenceScore, fraudRiskScore, validationStatus, validationReasons, ruleScores, mlSignals | Validation audit trail | canonicalEvents, concerts |
| `venues` | id, name, city, capacityMin, capacityMax, avgCapacity, verified | Venue master data | (referenced by concerts via venueName) |
| `prediction_training_data` | id, concertId, features, actualRevenue, predictedRevenue, accuracy, modelVersion | Training data for ML models | (used by data scientists) |

---

## FORMULA INVENTORY

### Currently Implemented Formulas

#### 1. **POPULARITY SCORE V1**
- **File Location:** 
  - Frontend calculation: `backend/src/utils/artistPopularity.ts`
  - Python calculation: `mad_analytics/popularity/calculator.py`
- **Mathematical Logic:**
  ```
  entropy_weights = compute_entropy_across_platforms(artist_followers)
  weights: {
    spotify: max(0.40, entropy_weight) -- minimum 40% (core metric)
    youtube: entropy_weight
    instagram: entropy_weight
    facebook: entropy_weight
    twitter: min(0.25, entropy_weight) -- capped at 25% (unreliable data)
  }
  
  normalized_values = for each platform:
    (artist_followers[platform] / max_observed_followers[platform])
  
  score = clamp(5 + sum(weights[p] * normalized_values[p]) * 95, 5, 100)
  ```
- **Variables Used:**
  - `spotifyMonthlyListeners`, `youtubeSubscribers`, `instagramFollowers`, `facebookFollowers`, `twitterFollowers`
  - Entropy calculated from active artist population (sample size)
- **Database Fields Used:**
  - `artists.{spotifyMonthlyListeners, youtubeSubscribers, instagramFollowers, facebookFollowers, twitterFollowers}`
  - Cache key: `artist-popularity:entropy-weights:v1` (1 hour TTL)
- **Endpoint Exposed:**
  - `POST /api/v1/analytics/ml/popularity` (madAnalytics controller)
  - Also: `POST /api/v1/analytics/ml/popularity/all/save` (batch update all artists)
- **Frontend Hook:** `useMadPopularity(artistId, enabled)`

---

#### 2. **DEMAND SCORE V1**
- **File Location:** `mad_analytics/demand/scorer.py`
- **Mathematical Logic:**
  ```
  Components (each returns 0-1 float):
  
  1. social_velocity = platform_growth_rate(last_14_days)
     For each platform: (current_followers - 14d_ago_followers) / 14d_ago_followers
     Take average across platforms
  
  2. ticket_velocity = concert_sell_through_rate(last_90_days)
     For each concert: tickets_sold / venue_capacity
     Average for concerts in target city
  
  3. seasonality = month_bonus + weekend_bonus
     month_bonus = seasonal_multiplier[month]
     weekend_bonus = +0.1 if event_date is Fri-Sun else 0
  
  4. recency = days_since_last_city_show()
     if < 30 days: 0.2 (saturation risk)
     if 30-90 days: 0.5
     if 90-180 days: 0.8
     if > 180 days: 0.9 (strong anticipation)
  
  Weighted Score = 0.40 * social_velocity
                 + 0.30 * ticket_velocity
                 + 0.20 * seasonality
                 + 0.10 * recency
  
  Final Score = min(100, max(0, weighted_score * 100))
  ```
- **Variables Used:**
  - `artist_id`, `city`, `country`, `target_date`, `platform_metrics` (follower/stream data)
  - `recent_concerts` (past concert history)
- **Database Fields Used:**
  - `platform_metrics.{followers, streams, metricDate}`
  - `concerts.{ticketsSold, capacity, city, concertDate}`
  - `artists.{id, artistName}`
- **Endpoint Exposed:**
  - `POST /api/v1/analytics/ml/demand` (madAnalytics controller)
  - Input validation: `artist_id`, `city`, `country`, `target_date` required
- **Frontend Hook:** `useMadDemand(artistId, city, enabled, options)`
- **Used By:** Concert detail pages, revenue prediction input

---

#### 3. **GROWTH FORECAST (RoG - Rate of Growth)**
- **File Location:** `mad_analytics/growth/rog_calculator.py`
- **Mathematical Logic:**
  ```
  For each platform:
  
  1. RoG Calculation (30-day, 90-day):
     rog_30d = ((current_value - value_30d_ago) / value_30d_ago) * 100
     rog_90d = ((current_value - value_90d_ago) / value_90d_ago) * 100
  
  2. Trend Classification:
     if rog_30d > 5% OR rog_90d > 10%: "rising"
     if rog_30d < -5% OR rog_90d < -10%: "declining"
     else: "stable"
  
  3. Anomaly Detection:
     smoothed = exponential_smooth(series, alpha=0.3)
     residuals = series - smoothed
     z_score = (last_residual - mean(residuals)) / std(residuals)
     if z_score > 3.0: flag as anomaly
  
  4. Forecast (90 days ahead):
     model = Holt(smoothed_series, linear_trend)
     forecast_value = model.predict(90_days_out)
  
  5. Cross-Platform Score (weighted average):
     weights = {spotify: 0.25, youtube: 0.20, instagram: 0.20, twitter: 0.10, facebook: 0.10, apple_music: 0.15}
     For each platform:
       score_p = 50 + 50 * tanh(rog_30d / 20)  -- sigmoid-like normalization
     cross_platform = sum(weights[p] * score_p) / sum_weights
     clamped to [0, 100]
  ```
- **Variables Used:**
  - `artist_id`, `platform_metrics` (time series data)
- **Database Fields Used:**
  - `platform_metrics.{metricDate, followers, streams, views, platform}`
  - `artists.{id, artistName}`
- **Endpoint Exposed:**
  - `POST /api/v1/analytics/ml/growth` (madAnalytics controller)
  - Also: `GET /api/v1/analytics/rog?artistId=X&platform=Y&period=daily|weekly|monthly`
- **Frontend Hook:** `useMadGrowth(artistId, enabled)`
- **Used By:** Dashboard trends chart, artist profile growth section

---

#### 4. **REVENUE PREDICTION (HYBRID MODEL)**

##### V1a: Feature Engineering Service (TypeScript)
- **File Location:** `backend/src/services/features/featureEngineering.service.ts`
- **12-Feature Set Generated:**
  ```
  1. artist_momentum = avg(rog_daily, rog_weekly/7, rog_monthly/30) * 9 + 50
     Range: [0, 100]
  
  2. city_demand = weighted average:
     - Concert count in city (0.3)
     - Artist's past concert sell-through in city (0.4)
     - City audience demographics alignment (0.3)
     Range: [0, 100]
  
  3. venue_performance = historical attendance rate for venue type/capacity
     Range: [0, 100]
  
  4. ticket_pricing_intelligence = market analysis
     - Comparable venue prices in city
     - Artist tier adjustments
     - Scarcity multipliers
     Range: [0, 100]
  
  5. seasonal_trends = month + day-of-week bonuses
     Weekends +0.10, summer months +0.05, etc.
     Range: [0, 100]
  
  6. engagement_velocity = social engagement growth rate
     (likes + comments + shares) momentum
     Range: [0, 100]
  
  7. global_popularity = entropy-weighted (see Popularity Score V1)
     Range: [0, 100]
  
  8. local_popularity = 0.52 * global_popularity + 0.32 * city_demand + 0.16 * artist_momentum
     Range: [0, 100]
  
  9. venue_capacity = resolved from venue DB or estimated
  
  10. avg_ticket_price = resolved from concert or estimated
  
  11. days_until_event = event_date - today
  
  12. is_weekend = bool(day_of_week in [Fri, Sat, Sun])
  ```

##### V1b: Revenue Prediction Service (TypeScript)
- **File Location:** `backend/src/services/predictions/revenuePrediction.service.ts`
- **Mathematical Logic:**
  ```
  Demand Score = weighted feature combination:
    0.18 * global_popularity
  + 0.24 * local_popularity
  + 0.14 * artist_momentum
  + 0.16 * city_demand
  + 0.11 * venue_performance
  + 0.08 * ticket_pricing_intelligence
  + 0.06 * seasonal_trends
  + 0.03 * engagement_velocity
  Clamped to [0, 100]
  
  Sellout Probability:
    base = 0.18 + (demand_score / 115)
    capacity_pressure = -0.08 if capacity > 20k else +0.08 if capacity < 1k else 0
    timing_penalty = -0.05 if event_date < today else 0
    weekend_boost = +0.04 if is_weekend else 0
    
    final = base + capacity_pressure + timing_penalty + weekend_boost
    clamped to [0.05, 0.99]
  
  Expected Attendance = min(venue_capacity, 
                            max(0, round(venue_capacity * sellout_probability)))
  
  Expected Revenue = expected_attendance * avg_ticket_price
  ```
- **Model Version:** `hybrid-revenue-v1`
- **Variables Used:**
  - Features assembled above (12 total)
  - `artistId` or `artistName`
  - `city`, `country`, `venueName`, `venueCapacity`, `avgTicketPrice`, `eventDate`
- **Database Fields Used:**
  - All tables referenced by Feature Engineering Service
  - `prediction_outputs` table for storage
  - `prediction_training_data` for ML training validation
- **Endpoint Exposed:**
  - `POST /api/v1/analytics/ml/revenue` (madAnalytics controller)
  - Input: Revenue payload with artist + concert details
- **Frontend Hook:** `useAutoPredict(artistId, city, capacity, enabled, options)`
- **Used By:** Concert creation/detail forms, revenue forecast dashboard

##### V1c: LLM Model (Python - Heuristic)
- **File Location:** `mad_analytics/revenue/llm_model.py`
- **Mathematical Logic (Deterministic):**
  ```
  Demand Score Calculation:
    = city_popularity * 0.65 + artist_popularity * 0.25 + city_market_boost * 0.3
    Clamped to [10, 95]
  
  Base Sell-Through Rate:
    = 0.25 (default) + (demand_score - 10) / 85 * base_sell_through_variance
  
  Venue Capacity Factor:
    if capacity < 1000: 1.3 (intimate - easier to fill)
    if capacity < 5000: 1.1
    if capacity < 20000: 1.0
    else: 0.85 (stadium - harder to fill)
  
  Pricing Tiers (dynamic per market):
    base_price = max(500, (800 + artist_popularity*12 + city_popularity*8)
                            * market_multiplier * scarcity_multiplier * venue_mult)
    
    tiers = {
      vip: base * 4.5,
      tier1: base * 2.2,
      tier2: base * 1.0,
      tier3: base * 0.5
    }
    
    weighted_avg_price = 0.10*vip + 0.20*tier1 + 0.40*tier2 + 0.30*tier3
  
  Predicted Attendance:
    base_sell_through * venue_capacity * venue_factor
  
  Revenue = attendance * weighted_avg_price
  ```
- **City Market Boosts:** Hardcoded database (Mumbai 40%, Delhi 38%, NYC 50%, etc.)
- **Venue Type Multipliers:** Stadium 1.4, Arena 1.2, Club 0.7, etc.
- **Used By:** Fallback when ML model unavailable, heuristic-only predictions

---

#### 5. **VALIDATION SCORE (HYBRID - Confidence + Fraud Risk)**
- **File Location:** `backend/src/services/validation/hybridValidation.service.ts`
- **Mathematical Logic:**

##### Confidence Score (0-1):
  ```
  Rule Scores (sum of components):
  - trusted_source: 0.22 if source in BOOKMYSHOW|SONGKICK|BANDSINTOWN|EVENTBRITE
  - official_ticket_url: 0.18 if URL present and from trusted domain
  - venue_existence: 0.18 if venue verified in DB, else 0.05
  - verified_artist_account: 0.12 if artist account verified
  - multiple_confirmations: min(0.22, max(0, (confirmations-1)*0.11))
  - duplicate_penalty: -0.12 if duplicate detected
  
  Field Completeness = 6 fields present / 6 total
    (artist_name, venue_name, city, country, event_date, source_url)
  
  Baseline = 0.22 if trusted_source else 0.12
  
  confidence = clamp(
    baseline 
    + event.confidence_score * 0.20
    + field_completeness * 0.12
    + sum(rule_scores),
    0, 1
  )
  ```

##### Fraud Risk Score (0-1):
  ```
  risk = 0.5
  risk -= trusted_source * 1.0
  risk -= official_ticket_url * 0.75
  risk -= venue_existence * 0.70
  risk -= multiple_confirmations * 0.60
  risk += duplicate_detected * 0.08
  risk += event_date_in_past * 0.05
  risk += missing_source_url * 0.08
  risk += missing_ticket_price * 0.03
  
  fraud_risk = clamp(risk, 0, 1)
  ```

##### Validation Status Resolution:
  ```
  if duplicate_detected: DUPLICATE
  if confidence >= 0.76 && fraud_risk <= 0.38: VALIDATED
  if confidence < 0.42 || fraud_risk >= 0.72: REJECTED
  else: REVIEW_REQUIRED
  ```
- **Database Fields Used:**
  - `canonical_events.{confidenceScore, fraudRiskScore, validationStatus}`
  - `source_event_references.{sourcePlatform, sourceUrl}`
  - `venues.{name, city, country}` for existence check
  - `validation_logs` for audit trail
- **Endpoint Exposed:**
  - Runs internally during concert intelligence pipeline
  - Results stored in: `validation_logs`, `canonical_events`
- **Used By:** Event deduplication, concert pipeline quality gates

---

#### 6. **VENUE CAPACITY RESOLUTION**
- **File Location:** `mad_analytics/venue_capacity/pipeline.py`, `resolver.py`
- **Mathematical Logic:**
  ```
  Multi-source resolution:
  
  1. Historical Data (highest priority):
     - Aggregate capacity from past concerts with venue
     - min_capacity = MIN(concert.capacity) where venue_name matches
     - max_capacity = MAX(concert.capacity)
     - avg_capacity = AVG(concert.capacity)
     - confidence = 0.9 if 3+ concerts observed else 0.6
  
  2. Known Venue Database:
     - Pre-populated capacity for major venues
     - confidence = 0.8
  
  3. Web Search:
     - If no historical data, search venue website/ticketing sites
     - Heuristic extraction from search results
     - confidence = 0.5-0.7 depending on source
  
  4. Artist Tier Estimation:
     - Artist tier (micro/rising/mid/major/superstar)
     - Typical venue size for tier in city
     - confidence = 0.4
  
  Final Selection:
    Choose highest confidence source
    Default fallback: 5000 (generic indoor venue)
  ```
- **Variables Used:**
  - `venue_name`, `city`, `country`, `venue_type`
  - `artist_tier` (inferred from follower count)
  - `supplied_capacity` (if provided)
- **Database Fields Used:**
  - `venues.{capacityMin, capacityMax, avgCapacity}`
  - `concerts.{venueName, capacity, city}` (for aggregation)
- **Output Fields:**
  ```
  {
    capacity: int,
    confidence: 0-1,
    status: "validated" | "estimated" | "review_required",
    capacity_min: int,
    capacity_max: int
  }
  ```
- **Endpoint Exposed:**
  - `POST /api/v1/analytics/ml/venue-capacity` (madAnalytics controller)
- **Used By:** Feature engineering, revenue prediction, concert details

---

#### 7. **RATE OF GROWTH (STORED IN DB)**
- **File Location:** Calculated during platform metrics ingestion
- **Database Fields:**
  - `platform_metrics.rogDaily` (last 1-day growth %)
  - `platform_metrics.rogWeekly` (last 7-day growth %)
  - `platform_metrics.rogMonthly` (last 30-day growth %)
- **Calculation Timing:** During scheduled ingestion job, NOT on-demand
- **Usage:** 
  - Aggregated in dashboard KPIs
  - Used by feature engineering (artist_momentum)
  - Exposed via `GET /api/v1/analytics/rog` endpoint

---

### Summary Table: Current Formulas

| Formula | Version | Type | Location | API Endpoint | Complexity | Status |
|---------|---------|------|----------|-------------|-----------|--------|
| Popularity Score | V1 | Entropy-weighted | Python/TS | `POST /ml/popularity` | Medium | ✅ Active |
| Demand Score | V1 | Rule-based composite | Python | `POST /ml/demand` | Medium | ✅ Active |
| Growth Forecast | V1 | Time-series + ML | Python | `POST /ml/growth` | High | ✅ Active |
| Revenue Prediction | V1 (Hybrid) | TS features + ML | TS + Python | `POST /ml/revenue` | High | ✅ Active |
| Revenue Prediction | V1 (Heuristic) | Rule-based | Python | Internal | Medium | ✅ Active |
| Validation Score | V1 (Hybrid) | Rule + signals | TS | Internal | Medium | ✅ Active |
| Venue Capacity | V1 | Multi-source | Python | `POST /ml/venue-capacity` | Medium | ✅ Active |
| RoG (Rate of Growth) | V1 | Percentage change | TS/DB | `GET /rog` | Low | ✅ Active |

---

## REPLACEMENT IMPACT ANALYSIS

### Proposed New Formulas Implementation Plan

#### **FORMULA 1: Popularity Score V2**

**Motivation:** Current V1 lacks time-series momentum and platform-specific trend weighting.

**Which files MUST be modified:**

1. **`mad_analytics/popularity/calculator.py`** ✏️ MODIFY
   - Add time-series weighting (recent metrics higher weight)
   - Implement platform volatility adjustment
   - Add correlation analysis between platforms
   - Lines to modify: entropy weighting logic, platform matrix building

2. **`backend/src/utils/artistPopularity.ts`** ✏️ MODIFY
   - Mirror Python changes to maintain TypeScript parity
   - Update entropy model building
   - Add volatility calculations

3. **`backend/src/services/features/featureEngineering.service.ts`** ✏️ MINOR CHANGE
   - Update `globalPopularity` calculation to use V2 weights
   - Cache key may need update: `artist-popularity:entropy-weights:v2`

4. **`backend/src/services/madAnalytics.service.ts`** ✏️ MODIFY
   - Update `getPopularityScore()` to call V2 endpoint if available
   - Handle backward compatibility (fallback to V1)
   - Version routing: `popularity_score_version` param or header

**Which files CAN be reused:**

- `backend/src/controllers/madAnalytics.controller.ts` ✅ REUSE
  - Same endpoint, same controller handler
  - Response structure compatible
  
- `backend/src/routes/analytics.routes.ts` ✅ REUSE
  - Same endpoint: `POST /api/v1/analytics/ml/popularity`
  
- `src/hooks/usePredictions.js` ✅ REUSE
  - Same hook `useMadPopularity()` can work with both versions
  
- Database schema ✅ REUSE
  - `artists.popularity` field stores either V1 or V2 (same numeric type)
  - No new tables needed

**Which files should be DEPRECATED:**

- None - V1 should remain for historical data compatibility
- Instead: Create new Python module `popularity/calculator_v2.py`
- Or: Add version parameter to existing calculator

**Which NEW files should be created:**

1. **`mad_analytics/popularity/calculator_v2.py`**
   - Implement V2 algorithm
   - Export: `calculate_v2(payload: PopularityInput) -> PopularityOutput`
   - Add docstring with algorithm explanation

2. **`backend/src/utils/artistPopularity.v2.ts`** (optional)
   - TypeScript mirror of V2 for offline fallback

3. **Database migration** (if schema changes needed)
   - Add `artists.popularityScoreVersion` field
   - Default to 'v1' for existing artists
   - Script to backfill V2 scores

**Implementation Sequence:**

```
1. Create mad_analytics/popularity/calculator_v2.py
2. Test V2 algorithm against existing artists
3. Update madAnalytics.service.ts to support version routing
4. Create TS mirror (optional)
5. Add version parameter to POST /api/v1/analytics/ml/popularity
6. Update frontend hook to pass version param if needed
7. Add database migration to track version
8. Batch update artists with V2 scores
9. Document V2 algorithm in FORMULAS_V2.md
```

**Backward Compatibility:**

```
GET /api/v1/analytics/ml/popularity?version=v2
GET /api/v1/analytics/ml/popularity (default: v1)

POST /api/v1/analytics/ml/popularity/all/save?version=v2
POST /api/v1/analytics/ml/popularity/all/save (default: v1)
```

---

#### **FORMULA 2: Demand Score V2**

**Motivation:** V1 is static rule-based; V2 should incorporate artist's past demand correlation + city-specific seasonality patterns.

**Which files MUST be modified:**

1. **`mad_analytics/demand/scorer.py`** ✏️ MAJOR REVISION
   - Add ML-based demand prediction (gradient boosting)
   - Incorporate artist-city historical correlations
   - Add multi-month seasonality patterns (not just month)
   - Increase weight for recent data (exponential weighting)
   - Lines: entire `calculate()` function, new component calculations

2. **`mad_analytics/utils/feature_engineering.py`** ✏️ MODIFY
   - Add `demand_correlation_score()` function
   - Add `city_seasonality_pattern()` function
   - Add historical demand aggregation helpers

3. **`backend/src/services/madAnalytics.service.ts`** ✏️ MODIFY
   - Route version requests: `getDemandScore()` → check version param
   - Load appropriate Python endpoint
   - Handle new input requirements (historical data needed)

4. **`backend/src/services/features/featureEngineering.service.ts`** ✏️ MINOR
   - Update `calculateCityDemand()` to use V2 if available
   - Pass historical concert list to new scorer

**Which files CAN be reused:**

- `backend/src/controllers/madAnalytics.controller.ts` ✅ REUSE
  - Same endpoint handler
  - Existing validation logic OK

- `backend/src/routes/analytics.routes.ts` ✅ REUSE
  - Same: `POST /api/v1/analytics/ml/demand`

- `src/hooks/usePredictions.js` ✅ REUSE
  - Hook signature unchanged: `useMadDemand(artistId, city, enabled, options)`

- Database schema ✅ REUSE
  - `concerts.demandScore` field compatible with both versions

**Which files should be DEPRECATED:**

- `mad_analytics/demand/scorer.py` → Move to `scorer_v1.py` or keep as backup
- Add version routing logic to dispatch to correct module

**Which NEW files should be created:**

1. **`mad_analytics/demand/scorer_v2.py`**
   - New ML-based scorer
   - Export: `calculate_v2(payload: DemandInputV2) -> DemandOutput`
   - Include artist-city correlation model

2. **`mad_analytics/demand/models/demand_model_v2.joblib`** (pickle)
   - Pre-trained gradient boosting model for demand
   - Generated by: `mad_analytics/training/train_demand_v2.py`

3. **`mad_analytics/training/train_demand_v2.py`**
   - Script to train demand model from historical concerts
   - Uses `prediction_training_data` + concert outcomes

4. **Optional database migration:**
   - `backends/prisma/migrations/xxx_add_demand_version.sql`
   - Add `concerts.demandScoreVersion` tracking field

**Implementation Sequence:**

```
1. Create training dataset: mad_analytics/training/train_demand_v2.py
   - Feature extraction from historical concerts
   - Output: models/demand_model_v2.joblib

2. Create scorer: mad_analytics/demand/scorer_v2.py
   - Import model
   - Implement V2 logic with ML inference

3. Update utils: mad_analytics/utils/feature_engineering.py
   - Add helper functions

4. Update backend: backend/src/services/madAnalytics.service.ts
   - Version routing in getDemandScore()

5. Update feature engineering: 
   - backend/src/services/features/featureEngineering.service.ts
   - Use new demand calculation if available

6. Add database migration (optional)

7. Test against sample concerts
   - Compare V1 vs V2 predictions
   - Validate accuracy improvements

8. Gradual rollout:
   - Support both versions via query param
   - Batch update existing predictions with V2
```

**API Changes:**

```
POST /api/v1/analytics/ml/demand?version=v2
{
  "artist_id": "...",
  "city": "Mumbai",
  "country": "India",
  "target_date": "2025-07-15",
  "platform_metrics": [...],
  "recent_concerts": [...],  // More data needed for V2
  "historical_correlation": true  // Optional: include correlation analysis
}

Response:
{
  "score": 75.5,
  "version": "v2",
  "components": {
    "social_velocity": 0.65,
    "ticket_velocity": 0.72,
    "seasonality": 0.58,
    "recency": 0.80,
    "correlation_score": 0.68,  // NEW
    "city_pattern_score": 0.71   // NEW
  }
}
```

---

#### **FORMULA 3: Revenue Prediction V2**

**Motivation:** V1 is deterministic; V2 should use confidence intervals, uncertainty quantification, and handle multiple concert scenarios.

**Which files MUST be modified:**

1. **`mad_analytics/revenue/predictor.py`** ✏️ MAJOR REVISION
   - Implement ensemble models (gradient boosting + neural net)
   - Add prediction uncertainty (confidence intervals)
   - Add scenario analysis (best/worst case)
   - Use improved feature engineering
   - Incorporate demand score V2

2. **`backend/src/services/predictions/revenuePrediction.service.ts`** ✏️ MAJOR REVISION
   - Update `RevenuePredictionResult` interface to include:
     - `expected_revenue_lower_bound` (10th percentile)
     - `expected_revenue_upper_bound` (90th percentile)
     - `prediction_uncertainty` (std dev / confidence range)
     - `scenario_analysis` { optimistic, pessimistic, baseline }
   - Update demand score calculation to use V2

3. **`backend/src/services/features/featureEngineering.service.ts`** ✏️ MODIFY
   - Add new features for V2:
     - `artist_stability` (rog volatility)
     - `city_market_maturity` (years of concert history)
     - `genre_seasonal_pattern` (genre-specific seasonality)
     - `artist_genre_fit` (how popular genre is in city)
   - Expand feature set from 12 to 16+ features

4. **`backend/src/controllers/madAnalytics.controller.ts`** ✏️ MODIFY
   - Handle version routing in `getRevenuePrediction()`
   - Map old request format to new

5. **`backend/src/services/concertIntelligence.service.ts`** ✏️ MODIFY
   - Use V2 predictions if version flag set
   - Store prediction version in `prediction_outputs.modelVersion`

**Which files CAN be reused:**

- `backend/src/routes/analytics.routes.ts` ✅ REUSE
  - Same: `POST /api/v1/analytics/ml/revenue`
  - Query param for version: `?version=v2`

- `src/hooks/usePredictions.js` ✅ REUSE
  - Hook `useAutoPredict()` works with V2
  - Frontend checks response structure for new fields

- Database schema ✅ REUSE
  - `prediction_outputs.{features, expectedRevenue}` compatible
  - `modelVersion` field already exists for versioning
  - `features` JSON can store extended set

**Which files should be DEPRECATED:**

- `mad_analytics/revenue/llm_model.py` → Optional: keep as fallback
- Only deprecate if V2 performance satisfactory

**Which NEW files should be created:**

1. **`mad_analytics/revenue/predictor_v2.py`**
   - New ensemble-based predictor
   - Export: `predict_v2(payload: RevenueInput) -> RevenueOutputV2`

2. **`mad_analytics/revenue/models/revenue_ensemble_v2.joblib`**
   - Primary ensemble model (gradient boosting + neural net)
   - Generated by: `training/train_revenue_v2.py`

3. **`mad_analytics/revenue/models/revenue_calibration_v2.joblib`**
   - Uncertainty calibration model
   - Maps raw predictions to confidence intervals

4. **`mad_analytics/training/train_revenue_v2.py`**
   - Training script for V2 models
   - Uses `prediction_training_data` + concert outcomes
   - Outputs ensemble model + calibration model

5. **Database schema migration:**
   - Add `prediction_outputs.predictionLowerBound` (Decimal)
   - Add `prediction_outputs.predictionUpperBound` (Decimal)
   - Add `prediction_outputs.predictionUncertainty` (Decimal)

6. **Frontend component updates:**
   - New confidence interval visualization
   - Scenario tabs (best/worst/baseline)

**Implementation Sequence:**

```
1. Expand features: backend/src/services/features/featureEngineering.service.ts
   - Add new feature calculations
   - Update cache key: concert-intelligence-features-v2

2. Create training pipeline: mad_analytics/training/train_revenue_v2.py
   - Feature extraction from concert history
   - Ensemble training
   - Uncertainty calibration

3. Create predictor: mad_analytics/revenue/predictor_v2.py
   - Load ensemble + calibration models
   - Implement V2 prediction logic
   - Output with bounds

4. Create database migration:
   - Add new fields to prediction_outputs

5. Update backend services:
   - RevenuePredictionService.predict() → handle V2 logic
   - Store extended results in new fields

6. Update controllers:
   - madAnalytics.controller.ts version routing

7. Update frontend:
   - useAutoPredict() handles new response shape
   - New UI components for confidence intervals
   - Scenario tabs

8. Create API documentation:
   - Response schema for V2
   - Example payloads
```

**Response Schema (V2):**

```typescript
{
  // V1 fields (backward compatible)
  expected_revenue: 450000,
  expected_attendance: 3000,
  sellout_probability: 0.75,
  demand_score: 72.5,
  model_version: "hybrid-revenue-v2",
  features: { ... },  // Now 16+ features
  
  // V2 new fields
  revenue_bounds: {
    lower: 380000,    // 10th percentile
    upper: 520000,    // 90th percentile
    confidence: 0.80  // 80% confidence in range
  },
  uncertainty: {
    std_dev: 35000,
    cv: 0.078,  // coefficient of variation
    method: "ensemble_calibration"
  },
  scenario_analysis: {
    optimistic: 550000,   // +15% from base
    pessimistic: 350000,  // -20% from base
    baseline: 450000,
    confidence_note: "High demand, proven venue"
  },
  model_components: {
    primary_model: "gradient_boosting",
    secondary_model: "neural_network",
    ensemble_weight_primary: 0.70,
    ensemble_weight_secondary: 0.30
  }
}
```

---

#### **FORMULA 4: Risk Score (NEW)**

**Motivation:** Quantify downside risk for concert revenue / attendance forecasts.

**Which files MUST be modified:**

- **`backend/src/services/predictions/revenuePrediction.service.ts`** ✏️ MODIFY
  - Add `calculateRiskScore()` method
  - Return risk score in prediction result

**Which files CAN be reused:**

- Everything else can be reused

**Which files should be DEPRECATED:**

- None (new feature, not replacement)

**Which NEW files should be created:**

1. **`mad_analytics/risk/scorer.py`**
   - Risk calculation module
   - Export: `calculate_risk(features, demand_score, prediction_bounds) -> RiskOutput`

2. **`backend/src/services/risk/riskScoring.service.ts`**
   - TypeScript wrapper for risk module
   - Cache risk scores

3. Optional database fields:
   - `prediction_outputs.riskScore` (Decimal)
   - `prediction_outputs.riskFactors` (JSON)

**Mathematical Logic:**

```
Risk Score = 0-100 scale where 100 = highest risk

Components:

1. Revenue Volatility Risk (30%):
   = coefficient_of_variation * 100
   = (std_dev / expected_revenue) * 100
   Clamped to [0, 100]

2. Artist Stability Risk (25%):
   = inverse of artist momentum
   If momentum > 50: stability_risk = 0
   If momentum < 30: stability_risk = 100
   Linear interpolation in between

3. Market/City Risk (20%):
   = inverse of city_demand score
   High city_demand → low risk

4. Venue/Capacity Risk (15%):
   = abs(expected_attendance - venue_capacity) / venue_capacity
   If attendance > 90% capacity: risk = +20 (risk of oversold)
   If attendance < 30% capacity: risk = +40 (risk of underutilized)
   Else: risk = low

5. Macro/Seasonality Risk (10%):
   = inverse of seasonality score
   Off-season → higher risk

Raw Risk = 0.30 * volatility_risk
         + 0.25 * stability_risk
         + 0.20 * market_risk
         + 0.15 * venue_risk
         + 0.10 * seasonality_risk

Final Risk Score = clamp(raw_risk, 0, 100)

Risk Level Classification:
  0-20: LOW (confidence > 80%)
  21-40: MEDIUM-LOW
  41-60: MEDIUM
  61-80: MEDIUM-HIGH
  81-100: HIGH (confidence < 50%)
```

**API Integration:**

```
POST /api/v1/analytics/ml/revenue
Response includes:
{
  ...existing fields...,
  risk_score: 35,
  risk_level: "MEDIUM-LOW",
  risk_factors: {
    volatility: 28,
    artist_stability: 15,
    market: 32,
    venue: 20,
    seasonality: 25
  }
}
```

---

#### **FORMULA 5: Confidence Score V2 (ENHANCEMENT)**

**Current V1:** Uses rule-based scoring for event validation (in `hybridValidation.service.ts`)

**Motivation:** Incorporate ML signals, prediction accuracy history, data source quality.

**Which files MUST be modified:**

1. **`backend/src/services/validation/hybridValidation.service.ts`** ✏️ MODIFY
   - Update `calculateConfidence()` to use V2 algorithm
   - Add ML signal weighting
   - Incorporate source quality history
   - Add data completeness ML scoring

2. **`backend/src/services/features/featureEngineering.service.ts`** ✏️ MINOR
   - Optionally pass feature confidence back to validation

**Which files CAN be reused:**

- Database tables ✅
- All validation endpoints ✅
- Controller routing ✅

**Which NEW files should be created:**

1. **Optional: `mad_analytics/validation/confidence_v2.py`**
   - ML-based confidence scoring
   - Train model on historical validation outcomes

2. **Optional: `backend/src/utils/confidenceCalibration.ts`**
   - Calibrate confidence scores based on actual outcomes
   - Compute calibration curve

**Mathematical Logic (V2):**

```
Confidence Score = weighted combination

Rule Scores (as before):
- trusted_source, official_ticket_url, venue_existence, etc.

New ML Signals:
- extraction_quality = model probability from scraper
- source_historical_accuracy = past accuracy of this source/platform
- data_completeness_ml = NN model on field patterns
- similar_event_agreement = if multiple sources agree, boost confidence

Base Calculation:
confidence = 0.50 * rule_total
           + 0.25 * extraction_quality
           + 0.15 * source_historical_accuracy
           + 0.10 * data_completeness_ml

Calibration:
- Query historical validation_logs for this source/platform
- Compute: of events marked VALIDATED, what % were actually confirmed?
- Apply calibration multiplier

final_confidence = confidence * calibration_multiplier
clamped to [0, 1]

Uncertainty Quantification:
- Compute std_dev of past accuracies for similar events
- confidence_interval = [final_confidence - 2*std_dev, final_confidence + 2*std_dev]
```

**API Impact:**

```
Existing validation pipeline unchanged
But returned confidence_score is now V2 (calibrated + ML-informed)

Response now includes:
{
  confidence_score: 0.82,           // More reliable estimate
  confidence_interval: [0.76, 0.88],// +/- 3% range
  ml_signals: {
    extraction_quality: 0.85,
    source_accuracy: 0.78,
    completeness_score: 0.88,
    agreement_score: 0.92
  },
  validation_status: "VALIDATED",
  ...
}
```

---

## IMPLEMENTATION ROADMAP

### Phase 1: Infrastructure & Preparation (Week 1-2)

**Objectives:**
- Set up version routing infrastructure
- Create model training pipelines
- Database schema ready for versioning

**Tasks:**

1. **Backend Version Routing** ✏️
   - File: `backend/src/services/madAnalytics.service.ts`
   - Add method to route requests by version param
   - Add fallback logic (V2 → V1 if unavailable)
   - Example:
     ```typescript
     async getDemandScore(payload, version = 'v1') {
       if (version === 'v2' && this.hasV2Module) {
         return this.callPythonV2(payload);
       }
       return this.callPythonV1(payload);
     }
     ```

2. **Database Migrations**
   - Create migration files for new fields:
     ```sql
     ALTER TABLE prediction_outputs 
     ADD COLUMN predictionLowerBound DECIMAL(14,2),
     ADD COLUMN predictionUpperBound DECIMAL(14,2),
     ADD COLUMN predictionUncertainty DECIMAL(8,4),
     ADD COLUMN modelVersionDetails JSONB;
     ```

3. **Python Project Setup**
   - Create new modules structure:
     ```
     mad_analytics/
     ├── demand/
     │   ├── scorer_v1.py (existing)
     │   └── scorer_v2.py (NEW)
     ├── popularity/
     │   ├── calculator.py (refactor for v1/v2)
     │   └── calculator_v2.py (NEW)
     ├── revenue/
     │   ├── predictor_v1.py (refactor existing)
     │   ├── predictor_v2.py (NEW)
     │   └── models/
     │       ├── revenue_model_v1.joblib (existing)
     │       └── revenue_model_v2.joblib (NEW)
     └── risk/
         └── scorer.py (NEW)
     ```

4. **Training Data Pipeline**
   - Create: `mad_analytics/training/prepare_training_data.py`
   - Exports historical concert data with outcomes to CSV
   - Used by all V2 training scripts

**Deliverables:**
- Version routing infrastructure
- DB migrations ready
- Python module structure
- Training data export script

---

### Phase 2: Model Development (Week 3-4)

**Objectives:**
- Develop and validate V2 models
- Benchmark against V1
- Generate model artifacts

**Tasks:**

1. **Demand Score V2**
   - File: `mad_analytics/training/train_demand_v2.py`
   - Train gradient boosting model on historical concerts
   - Validate: RMSE, MAE, cross-validation
   - Create: `mad_analytics/demand/scorer_v2.py`
   - Benchmark: Compare V1 vs V2 predictions on holdout set

2. **Revenue Prediction V2**
   - File: `mad_analytics/training/train_revenue_v2.py`
   - Engineer 16+ features
   - Train ensemble: gradient boosting + neural net
   - Train uncertainty calibration model
   - Create: `mad_analytics/revenue/predictor_v2.py`
   - Benchmark against historical concert data

3. **Risk Scoring Module**
   - File: `mad_analytics/risk/scorer.py`
   - Implement rule-based risk calculation
   - Test with sample predictions

4. **Popularity Score V2**
   - File: `mad_analytics/popularity/calculator_v2.py`
   - Add time-series weighting
   - Implement volatility adjustment
   - Test on artist sample

**Deliverables:**
- Trained models (joblib files)
- V2 Python modules
- Benchmark reports (accuracy, latency)
- Model cards with assumptions

---

### Phase 3: Backend Integration (Week 5-6)

**Objectives:**
- Integrate V2 models into backend services
- Update controllers & services
- Maintain backward compatibility

**Tasks:**

1. **Update Core Services**
   - `backend/src/services/features/featureEngineering.service.ts`
     - Add 16+ features for V2
     - Update `buildFeatures()` method
     - New cache key for V2: `concert-intelligence-features-v2`

   - `backend/src/services/predictions/revenuePrediction.service.ts`
     - Add V2 logic branch in `predict()`
     - Return extended result with confidence bounds
     - Store uncertainty metrics

   - `backend/src/services/madAnalytics.service.ts`
     - Add version routing in all methods
     - Support backward compatibility

2. **Update Controllers**
   - `backend/src/controllers/madAnalytics.controller.ts`
     - Pass version param to services
     - Map version query param to service calls
     - Error handling for unsupported versions

3. **Database Integration**
   - Run migrations
   - Update Prisma schema
   - Generate Prisma client

4. **Error Handling**
   - Graceful fallback V2 → V1
   - Clear error messages for missing models
   - Logging for version usage

**Deliverables:**
- Updated backend services
- Version routing working
- Database migrations applied
- Backward compatibility verified

---

### Phase 4: Frontend Integration (Week 7)

**Objectives:**
- Update frontend to consume V2 data
- Visualize confidence intervals & scenarios
- Version selection controls

**Tasks:**

1. **Update Hooks**
   - `src/hooks/usePredictions.js`
     - Add optional `version` param to hooks
     - Example: `useAutoPredict(..., { version: 'v2' })`
     - Handle new response fields gracefully

2. **Update Components**
   - Revenue Forecast Card
     - Display confidence interval as range bar
     - Show scenario tabs (best/worst/baseline)
     - Visualize risk score with color coding
   
   - Demand Score Display
     - Show new components (correlation, city_pattern)
     - Add version label
   
   - Validation Score Display
     - Show ML signals breakdown
     - Confidence interval visualization

3. **Version Selection UI**
   - Optional: Add version selector in Admin panel
   - Query params: `?predictionVersion=v2`
   - Local storage preference

**Deliverables:**
- Updated React hooks
- New UI components
- Frontend tests passing

---

### Phase 5: Testing & Validation (Week 8)

**Objectives:**
- Comprehensive testing across stack
- Performance validation
- User acceptance testing

**Tasks:**

1. **Unit Tests**
   - Python models: test predict() functions
   - Backend services: test version routing
   - Frontend hooks: test new response handling

2. **Integration Tests**
   - End-to-end: API call → response → UI display
   - Version fallback: V2 unavailable → V1
   - Database: predictions stored correctly

3. **Performance Tests**
   - Measure V1 vs V2 latency
   - Monitor memory usage
   - Model load times

4. **Accuracy Validation**
   - Compare predictions to actual concert outcomes
   - Confidence interval calibration check
   - Risk score correlation with actual risk

5. **User Testing**
   - QA team validates UI displays
   - Internal stakeholders preview V2 scores
   - Collect feedback before rollout

**Deliverables:**
- Test suite with 80%+ coverage
- Performance benchmarks
- Validation report
- UAT sign-off

---

### Phase 6: Gradual Rollout (Week 9-10)

**Objectives:**
- Staged deployment
- Monitoring & validation
- Documentation

**Tasks:**

1. **Internal Rollout**
   - Deploy to staging environment
   - Enable V2 for admin-only users
   - Monitor logs for errors
   - Collect initial feedback

2. **Canary Deployment**
   - Enable V2 for 10% of API requests
   - Monitor prediction accuracy
   - Check for errors/latency issues
   - Gradually increase: 10% → 25% → 50% → 100%

3. **Parallel Run**
   - Run both V1 and V2 side-by-side
   - Store both predictions
   - Compare in dashboard
   - Document differences

4. **Documentation**
   - Update FORMULAS.md with V2 algorithms
   - API documentation with version examples
   - Migration guide for consumers
   - Model card for each V2 formula

5. **Monitoring**
   - Set up alerts for V2 model failures
   - Track prediction accuracy over time
   - Monitor performance metrics
   - Set up dashboards in observability tool

**Deliverables:**
- Production deployment
- Monitoring dashboards
- Migration guide
- Updated documentation

---

### Phase 7: Optimization & Maintenance (Week 11+)

**Objectives:**
- Fine-tune V2 models
- Retire V1 when confident
- Plan V3 improvements

**Tasks:**

1. **Performance Tuning**
   - Model optimization (pruning, quantization)
   - Cache optimization
   - Query optimization

2. **Model Retraining**
   - Set up monthly retraining pipeline
   - Incorporate latest concert data
   - A/B testing framework for future models

3. **V1 Deprecation Planning**
   - Analyze V1 usage
   - Plan sunset date
   - Create migration path for consumers

**Deliverables:**
- Optimized V2 models
- Retraining pipeline
- V1 deprecation timeline

---

## IMPLEMENTATION CHECKLIST

### Pre-Implementation
- [ ] Stakeholder alignment on V2 changes
- [ ] Data labeling for training (actual concert outcomes)
- [ ] Environment setup (Python 3.9+, sklearn, pytorch, etc.)
- [ ] Access to production data (anonymized if needed)

### Core Implementation
- [ ] Phase 1: Infrastructure ✅
- [ ] Phase 2: Model Development ✅
- [ ] Phase 3: Backend Integration ✅
- [ ] Phase 4: Frontend Integration ✅
- [ ] Phase 5: Testing & Validation ✅
- [ ] Phase 6: Gradual Rollout ✅
- [ ] Phase 7: Optimization ✅

### Post-Implementation
- [ ] Gather stakeholder feedback
- [ ] Plan V3 enhancements
- [ ] Document lessons learned
- [ ] Update team training materials

---

## APPENDIX: File Modification Matrix

### Summary Table: What Changes Where

| File/Module | Current State | V2 Pop | V2 Demand | V2 Revenue | Risk Score | Conf V2 | Action |
|---|---|---|---|---|---|---|---|
| `artistPopularity.ts` | V1 impl | MODIFY | - | - | - | - | Update entropy calc |
| `popularity/calculator.py` | V1 impl | CREATE V2 | - | - | - | - | New `_v2.py` file |
| `demand/scorer.py` | V1 impl | - | CREATE V2 | - | - | - | New `_v2.py` file |
| `revenue/predictor.py` | V1 impl | - | - | CREATE V2 | - | - | New `_v2.py` file |
| `featureEngineering.service.ts` | Base | MINOR | MINOR | MODIFY | - | - | Add features |
| `revenuePrediction.service.ts` | V1 impl | - | - | MODIFY | MODIFY | - | Handle V2 + risk |
| `madAnalytics.service.ts` | V1 | MODIFY | MODIFY | MODIFY | MODIFY | - | Version routing |
| `madAnalytics.controller.ts` | V1 | REUSE | REUSE | REUSE | REUSE | - | No change needed |
| `hybridValidation.service.ts` | V1 | - | - | - | - | MODIFY | Enhanced confidence |
| `usePredictions.js` | V1 | REUSE | REUSE | REUSE | REUSE | REUSE | Optional version param |
| Database schema | Current | - | - | MODIFY | MODIFY | - | New fields + migrations |
| `prediction_outputs` table | - | - | - | Add bounds | Add risk | - | New columns |

---

## DOCUMENT VERSIONING

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2025-06-23 | Initial architecture audit |

---

**END OF ARCHITECTURE AUDIT REPORT**

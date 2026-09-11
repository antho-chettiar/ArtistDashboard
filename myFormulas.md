# myFormulas.md — Current-State Analytics & Formula Inventory

**Status:** Current-state reference, built directly from the codebase.
**Method:** Every formula below was located in source code (file + line-level citations) and, where applicable, traced through its actual runtime call path (DB → calculation → service/controller → API route → frontend hook → page). Nothing here is inferred or assumed — where a claim could not be verified against code in this pass, it is explicitly marked `UNVERIFIED` rather than guessed.
**Scope note:** This file supersedes `FORMULAS.md`, `FORMULAS_SIMPLE.md`, and `FORMULAS_IMPLEMENTED_v2.md` as the current-state reference (see Section 10). It does not delete or replace those files.

---

## SECTION 1 — EXECUTIVE SUMMARY

The project has **not one analytics system but several, overlapping ones**, built at different times, most of which never call each other:

- **Python `mad_analytics` engine** (`mad_analytics/`, FastAPI service, `mad_analytics/server.py`) — the canonical, most complete engine. Computes Popularity, Platform Size, City Affinity, Demand, Risk, Confidence (demand tier), Revenue (heuristic + ML blend + signal cross-check), an LLM-style pricing model, Venue Capacity resolution, Google Trends scores, RoG, Holt forecasting, anomaly detection, and artist tiering. Runs both as an on-demand HTTP API and as a background scheduler that periodically recomputes and persists several of these to Postgres.
- **Viberate scoring pipeline** (`backend/src/services/scrapers/viberate/scorer.ts`) — a separate, Node-side, three-layer "ArtistPopularityV2" score (Reach × Engagement × Trends), persisted to its own table, run on its own daily Render Cron Job. Does not call the Python engine and is not called by it.
- **Node "ad-hoc" analytics** — two more independent scoring formulas live directly in Node/TypeScript: the Dashboard's `compositeScore` (`dashboard.controller.ts`) and a "V1" entropy popularity helper (`utils/artistPopularity.ts`) that feeds a fourth, separate revenue engine.
- **Revenue systems** — four independent formulas exist: the Python heuristic+ML blend (headline, user-facing), the Python `signal_revenue` cross-check (computed, never shown to users), the Python LLM-style pricing/sales predictor (user-facing, separate stat), and a Node-local "hybrid-revenue-v1" model (`revenuePrediction.service.ts`, DB-writing, wired to an admin-only route, not used by the frontend). A fifth inline heuristic lives in the Python scheduler (`server.py`) purely to backfill missing concert revenue in the background.
- **Forecasting/ML** — a trained `GradientBoostingRegressor` (Python, `train_revenue.py`) feeds the headline revenue number; Holt linear-trend forecasting and z-score anomaly detection run inside the Growth module and are returned by the `/growth` API, though not currently rendered anywhere in the frontend.
- **Venue capacity** — one system (Python `venue_capacity/resolver.py`), but its actual resolution mechanism (multi-candidate collection + best-confidence selection) differs from how all three existing `.md` docs describe it.
- **Other** — City-tier tables exist **twice**, independently defined, for two different purposes (Demand's City Affinity vs. Venue Capacity's heuristic multiplier) and must not be conflated.

---

## SECTION 2 — CANONICAL LIVE ANALYTICS

This section documents each of the 13 requested analytics areas at the level of "what is actually live and used by the product today." Full per-system detail (including non-canonical/competing implementations) is in Sections 3–6.

### 1. Popularity (canonical — Python engine)
`Popularity = BaseEntropy×0.60 + Momentum×0.20 + GoogleTrends×0.20` (weights renormalized over whichever components are present). See Section 3 for full detail and the three competing systems.
**File:** `mad_analytics/popularity/calculator.py`, functions `calculate()` / `calculate_all()`.
**API:** `POST /popularity`, `GET /popularity/all` → Node `POST/GET /api/v1/analytics/ml/popularity[/all]`.
**Frontend:** Artists grid (`src/pages/Artists.jsx`), Analysis page (`src/pages/Analysis.jsx`).
**Status:** LIVE + USED.

### 2. Momentum / Growth
`cross_platform_score = Σ(weight[p] × (50 + 50×tanh(rog_30d[p]/20))) / Σ(weight[p])`, weights: spotify .25 / youtube .20 / instagram .20 / apple_music .15 / twitter .10 / facebook .10 (unlisted platforms default to 0.05).
**File:** `mad_analytics/growth/rog_calculator.py::calculate()` / `_cross_platform_score()` (verified lines 47–134).
**API:** `POST /growth` → `POST /api/v1/analytics/ml/growth`.
**Frontend:** Analysis page "Growth Score".
**Status:** LIVE + USED. (Also internally reused inside Popularity and Demand as their "Momentum" component — same function, same result.)

### 3. Platform Size
`PlatformSize = (0.40·norm(Spotify) + 0.25·norm(YouTube) + 0.25·norm(Instagram) + 0.10·norm(Facebook)) × 100`, `norm(x) = (x−cohort_min)/(cohort_max−cohort_min)` clamped [0,1], degenerate cohort → 0.
**File:** `mad_analytics/demand/scorer.py::compute_platform_size()` (verified lines 76–93).
**API:** internal only — returned as `demand.components.platform_size` inside `/demand`, never as its own endpoint.
**Frontend:** fetched by Analysis page but **not rendered** (only `.components.momentum` is read from that object).
**Status:** LIVE + USED as a Demand input; not independently displayed anywhere.

### 4. Demand (canonical, live formula)
`Demand = PlatformSize×0.35 + Momentum×0.35 + GoogleTrends×0.20 + CityAffinity×0.10` (renormalized over present components).
**File:** `mad_analytics/demand/scorer.py::calculate()` / `_blend_demand()` (verified lines 341–365, 524–574).
**API:** `POST /demand` → `POST /api/v1/analytics/ml/demand`.
**Frontend:** Analysis page "Demand Score".
**Status:** LIVE + USED. See Section 5 for the dead alternate formula.

### 5. City Affinity
`CityAffinity = city_tier_factor(city) × market_activity_index × 100`. Tiers: Mumbai/Delhi=1.00, Bengaluru/Hyderabad/Chennai/Kolkata=0.85, Pune/Ahmedabad/Jaipur/Chandigarh=0.75, all else=0.65. `market_activity_index` = NCCS `(A+B)/max(A+B)` if `mad_analytics/data/nccs.json` is available, else concert-count-in-last-12-months normalized by the busiest city.
**File:** `mad_analytics/demand/scorer.py::city_affinity_score()`, `CITY_TIER_FACTORS`, `nccs_market_activity()`, `_concert_market_activity()` (verified lines 158–323).
**API:** internal only — `demand.components.city_affinity`.
**Frontend:** fetched, **not rendered** anywhere.
**Status:** LIVE + USED as a Demand input; not independently displayed. **Caution:** a second, differently-valued city-tier table exists for Venue Capacity — see Section 6.

### 6. Risk
`Risk = average(market_saturation, momentum_volatility, trends_recency_gap)` over whichever flags are computable. `market_saturation = clamp(concerts_in_city_last_90d / 20, 0, 1)`. `momentum_volatility = clamp(population_stddev(RoG30 across spotify/youtube/instagram/facebook), 0, 1)` — the module's own code comment flags this as a "SPEC NOTE": no documented normalization divisor exists for the stddev, so the raw value is clamped directly. `trends_recency_gap = 1.0 if google_trends_score < 30 else 0.0`. Levels: Low <0.33, Medium 0.33–0.66, High >0.66.
**File:** `mad_analytics/demand/scorer.py::compute_risk()` (verified lines 395–459).
**API:** internal — `demand.risk.{level,score,flags}` inside `/demand`.
**Frontend:** Analysis page "Risk" (level + score×100 as "Index").
**Status:** LIVE + USED. (`risk.flags`, incl. `market_saturation`, are fetched but not individually rendered.)

### 7. Confidence — three unrelated formulas share this name
- **Demand-tier confidence** (signal completeness): `platform_present && trends_present && city_present → High`; two of three → `Medium`; platform-only → `Low`; none → `Insufficient`. **File:** `scorer.py::compute_confidence()` (lines 506–519). **Frontend:** Analysis page "Confidence" ("Signal completeness"). **Status:** LIVE + USED.
- **Revenue interval-width confidence** (0–1 float): `confidence = clamp(1 - relative_width/2, 0.1, 0.95)`, `relative_width = (upper_bound-lower_bound)/predicted`. **File:** `revenue/predictor.py::_confidence()` (lines 134–139). **Frontend:** Analysis page "Model Confidence". **Status:** LIVE + USED.
- **Venue Capacity validation confidence** (0–1, additive adjustments): see Section 6. **Status:** LIVE + USED internally (drives the `status` field shown as part of the Venue Capacity stat).

### 8. Revenue prediction
Four independent formulas exist; see Section 4 for full detail. The one shown to users as "Predicted Revenue" is the ML+heuristic blend: `predicted_revenue = model_prediction×0.55 + heuristic_prediction×0.45` (confirmed exact constants, `revenue/predictor.py:219-220`), model = `GradientBoostingRegressor`, heuristic = `_heuristic_revenue()`.
**File:** `mad_analytics/revenue/predictor.py::calculate()`.
**API:** `POST /revenue` → `POST /api/v1/analytics/ml/revenue`.
**Frontend:** Analysis page "Predicted Revenue", "Model Confidence", "Prediction Range".
**Status:** LIVE + USED.

### 9. Google Trends
Fetched via `pytrends` (batches of ≤5 artists incl. a shared reference artist, cross-batch normalized so the reference score is fixed at 100, final pass rescaled so the max across all artists = 100), written to `artists.googleTrendsScore` via a scheduled job (every 7 days + at startup + manual trigger). A guard skips the write entirely if the whole fetch returns zero/empty (to avoid clobbering existing data on rate-limit).
**File:** `mad_analytics/trends/google_trends.py::fetch_trends_scores()` / `fetch_and_store_trends()`.
**Consumers:** Popularity (`_fetch_stored_trends_scores`), Demand (`_google_trends_for_artist`), Node `dashboard.controller.ts` compositeScore (25% weight).
**Status:** LIVE + USED, **with a caveat**: a Node code comment (`viberate/sync.ts`) explicitly flags that this column may be declared in `schema.prisma`/the migration but **absent from the live database** in at least one environment — a genuine, code-sourced schema-drift risk, not an assumption. See a **separate, second** Google-Trends-shaped signal (`ArtistTrendScore` table) documented in Section 3/8 — its writer was not identified in this audit.

### 10. Artist Score (V2 / Viberate)
See Section 3, System #4. **Status:** LIVE + USED (Artist Profile "Score" tab), independently cron-scheduled.

### 11. Venue Capacity
Not a strict priority chain — collects all available candidates (curated `known_venues` DB @0.98 confidence, supplied @0.95, regex text-extraction @0.35–0.98, `venues` DB row @0.84/0.96, then web search only if still empty, then heuristic only if still empty) and picks the single highest-confidence one via `max(candidates, key=(confidence, -abs(capacity), capacity))`.
**File:** `mad_analytics/venue_capacity/resolver.py::resolve_venue_capacity()` (verified lines 493–592).
**API:** `POST /venue-capacity` → `POST /api/v1/analytics/ml/venue-capacity`.
**Frontend:** Analysis page "Venue Capacity" (shows capacity + status).
**Status:** LIVE + USED.

### 12. RoG (Rate of Growth)
`rog(window) = (latest_value − value_window_days_ago) / value_window_days_ago × 100`; windows 7/30/90 days; returns 0.0 if <2 data points or non-positive baseline.
**File:** `mad_analytics/utils/feature_engineering.py::rog()`.
**Status:** LIVE + USED — feeds Momentum, Risk, and (via a separately-stored `rogDaily` column) the Node Dashboard's `compositeScore` and `avgRogDaily` display.

### 13. Other live analytics affecting product output
Anomaly detection, Holt forecasting, and trend classification are genuinely wired into the live `/growth` endpoint (confirmed by direct code reading, not assumed) — see Section 6.

---

## SECTION 3 — POPULARITY SYSTEMS (required — do not merge)

There are **four** independent "popularity" computations in this codebase. None calls any of the others.

### System A — Python canonical Popularity (`popularity_score`)
- **Formula:** `Popularity = BaseEntropy×0.60 + Momentum×0.20 + GoogleTrends×0.20`; `BaseEntropy = 5 + 95×Σ(log1p-normalized[p] × entropy_weight[p])` over Spotify/YouTube/Instagram/Facebook; entropy weights have floors **Spotify ≥ 0.45, Instagram ≥ 0.25** (constants at `calculator.py:133-134`; note the function's own docstring at line 100 says "40%", which is stale relative to the actual `0.45` constant — an intra-file inconsistency, verified directly).
- **Implementation:** `mad_analytics/popularity/calculator.py::calculate()` (single artist) / `calculate_all()` (full cohort), blend at `_blend_popularity()` (lines 434–458).
- **Inputs:** `artists.{spotifyMonthlyListeners, youtubeSubscribers, instagramFollowers, facebookFollowers}`, momentum from the growth module, Google Trends from `artists.googleTrendsScore` or live pytrends.
- **Where used:** `GET /analytics/ml/popularity/all` (batch, Redis-cached 10 min) on the Artists grid (`Artists.jsx`); `POST /analytics/ml/popularity` (single) on the Analysis page.
- **Displayed as:** "Popularity" (Artists grid, Analysis page).
- **Canonical?** Yes — this is the entropy/momentum/trends-blend formula `FORMULAS_IMPLEMENTED_v2.md` documents, and it matches code exactly.
- **Competes with:** Systems B, C, D below — all shown under the same or a near-identical "Popularity" label with different numbers.
- **Status:** LIVE + USED.

### System B — Node Dashboard `compositeScore`
- **Formula (primary path, when 90-day `PlatformMetric` history exists):**
  `baseScore = Σ(normalized_followers[p] × weight[p])`, weights Instagram .45/YouTube .25/Spotify .20/Facebook .10, `normalized_followers[p] = followers/max_in_cohort_for_platform × 100`;
  `rogScoreValue = avgRogRaw>0 ? min(100, round(ln(1+avgRogRaw×40)/ln(81) × 100)) : 0`;
  `compositeScore = round(baseScore×0.50 + trendsScore×0.25 + rogScoreValue×0.25)`.
- **Formula (fallback path, zero `PlatformMetric` rows in the window):** `compositeScore = round(baseScore×0.50 + trendsScore×0.25)` — **only 2 terms; the 0.25 RoG weight is dropped entirely rather than renormalized**, unlike every Python formula's renormalize-on-missing rule.
- **Implementation:** `backend/src/controllers/dashboard.controller.ts::getTopArtists` (verified lines 132–375; primary-path composite at 300–326, fallback at 183–239).
- **Inputs:** raw `Artist`/`PlatformMetric` DB rows directly via Prisma — **no call to the Python engine at all**.
- **Where used:** `GET /api/v1/dashboard/top-artists`.
- **Displayed as:** "Popularity" on the Dashboard Top-10 artist list.
- **Canonical?** No — undocumented in any of the three `.md` files.
- **Competes with:** Systems A, C, D.
- **Status:** LIVE + USED.

### System C — Node "V1" entropy popularity
- **Formula:** `score = Σ_platform(log1p(value)/max_in_cohort × entropyWeight)`; `popularity = round(clamp(5 + score×95, 5, 100), 2)` over `spotifyMonthlyListeners, youtubeSubscribers, instagramFollowers, facebookFollowers, twitterFollowers`.
- **Implementation:** `backend/src/utils/artistPopularity.ts::calculateArtistPopularity` / `calculateArtistPopularityWithModel`.
- **Where used:** feeds `global_popularity` inside `featureEngineeringService.buildFeatures` — i.e. only as an internal input to the Node-local Revenue System (System E in Section 4), **never displayed to a user in its own right**.
- **Canonical?** No.
- **Competes with:** A, B, D — a structural clone of A's math but computed independently in Node.
- **Status:** LIVE + USED (internal only — not directly displayed).

### System D — Viberate `ArtistPopularityV2Snapshot.finalScore`
- **Formula:**
  Layer 1 (Reach): entropy-weighted `spotify_listeners`/`youtube_subscribers`/`instagram_followers` (log1p + max-normalize across cohort, same method as System C).
  Layer 2 (Engagement): `adjustedReach = reachScore × engagementMultiplier`, multiplier from `EngagementService.calculate()` over trailing-30-day summed `instagram_likes`/`instagram_comments`/`youtube_likes` diffs.
  Layer 3 (Trends): latest `ArtistTrendScore.normalizedScore` (0–1), or reach-only fallback if none exists.
  Final: `adjustedNorm = adjustedReach / max(adjustedReach across cohort)`; `combined = hasTrends ? 0.7×adjustedNorm + 0.3×trendsScore : adjustedNorm`; `finalScore = round(clamp(5 + combined×95, 5, 100), 2)`.
- **Implementation:** `backend/src/services/scrapers/viberate/scorer.ts::runScorer()` (verified lines 1–439, weights `WEIGHT_REACH=0.7`/`WEIGHT_TRENDS=0.3` at lines 66–67).
- **Persistence:** writes a new row to `ArtistPopularityV2Snapshot` per run (history is never overwritten), `scoreVersion='v2.1-viberate'`.
- **Scheduling:** an in-process node-cron scheduler exists (`viberate/scheduler.ts`) but is explicitly gated off in the web process (`VIBERATE_SCHEDULER_ENABLED !== 'true'`); the actual live trigger is a dedicated **Render Cron Job** (`render.yaml`, schedule `30 0 * * *`) running `npm run viberate:refresh` → collector → sync → this scorer.
- **Where used:** `GET /artists/:id/score` (Artist Profile "Score" tab, via `ScoreBreakdown.jsx`); `GET /artists/leaderboard` exists but has **no confirmed frontend caller** (the `useLeaderboard` hook that would call it is exported but never imported anywhere in `src/`).
- **Displayed as:** "Popularity Score" (label differs from the field name `finalScore`) on the Artist Profile Score tab; sub-fields `reachScore` → "Reach Score", `engagementMultiplier` → "Engagement Multiplier", `trendsScore` → "Google Trends" (this is the **only place in the entire frontend where any Google Trends number is shown to a user**).
- **Canonical?** No — undocumented in any of the three `.md` files.
- **Competes with:** A, B, C.
- **Status:** LIVE + USED (Score tab); the sibling leaderboard endpoint is IMPLEMENTED / ORPHANED (no frontend caller found).

**Audit-relevant consequence:** a user comparing the same artist's "Popularity" across Dashboard (System B), Artists grid (System A), and Artist Profile (System D) will see three different numbers, with no in-UI disambiguation that these are different metrics.

---

## SECTION 4 — REVENUE SYSTEMS (required — do not merge)

### System 1 — MAD heuristic revenue (`_heuristic_revenue`)
```
base_sell_through = 0.25
demand_factor = (demand_score - 10) / 85
venue_factor = capacity<1000 ? 1.3 : capacity<5000 ? 1.1 : capacity<20000 ? 1.0 : 0.8
sell_through = clamp(base_sell_through + demand_factor*0.5, 0.15, 0.85) * venue_factor
sell_through = clamp(sell_through, 0.15, 0.90)
revenue = capacity * avg_ticket_price * sell_through
```
**File:** `mad_analytics/revenue/predictor.py::_heuristic_revenue()` (verified lines 142–164). Used as the cold-start fallback (no trained model) and as the 45% component of the blend below.

### System 2 — MAD ML + heuristic blend (headline `predicted_revenue`)
```
model_prediction = GradientBoostingRegressor.predict(features)
predicted_revenue = model_prediction*0.55 + heuristic_prediction*0.45
```
Exact weights `model_weight = 0.55` confirmed directly at `predictor.py:219`. Falls back to pure `_heuristic_revenue()` (System 1) with `lower=predicted*0.70`/`upper=predicted*1.30` when no trained model exists (`model_store.exists(...)` check, line 199).
**File:** `mad_analytics/revenue/predictor.py::calculate()` (verified lines 187–292). Training: `mad_analytics/training/train_revenue.py`, features `[venue_capacity, avg_ticket_price, price_range, max_revenue_naive, is_weekend, month, season, city, country, artist_tier, demand_score, best_rog_30d, cross_platform_score]`.
**API:** `POST /revenue` → `POST /api/v1/analytics/ml/revenue`.
**Frontend:** Analysis page "Predicted Revenue" (`model.predicted_revenue`), "Model Confidence" (`model.confidence`), "Prediction Range" (`lower_bound`/`upper_bound`).
**Status:** LIVE + USED — this is the only revenue number an end user actually sees as "Predicted Revenue."

### System 3 — `signal_revenue` (signals-only cross-check)
```
sell_through = clamp((demand_score/100) × city_tier_factor(city), 0, 1)
tickets = round(capacity × sell_through)
revenue = tickets × avg_ticket_price
```
**File:** `mad_analytics/revenue/predictor.py::signal_revenue()` (verified lines 167–184). Explicitly additive — "does not alter `predicted_revenue`" (code comment, lines 264–265).
**API:** returned as part of the `/revenue` response (`signal_revenue`, `signal_tickets`, `signal_sell_through` fields), passed through untouched by the Node proxy.
**Frontend:** **never read** — confirmed via repo-wide grep of `src/` for `signal_revenue`, zero hits.
**Status:** IMPLEMENTED / ORPHANED (computed and transmitted over the wire; discarded by the frontend).

### System 4 — LLM-style pricing & sales predictor
```
base_price = max(500, (800 + artist_popularity×12 + city_popularity×8) × market_multiplier × scarcity_multiplier × venue_multiplier)
pricing_tiers: VIP=base×4.5, Tier1=base×2.2, Tier2=base×1.0, Tier3=base×0.5
weighted_avg_price = VIP×0.10 + Tier1×0.20 + Tier2×0.40 + Tier3×0.30
demand_score = clamp(city_popularity×0.65 + artist_popularity×0.25 + city_market_boost×0.3, 10, 95)
sell_through = clamp((0.25 + demand_factor×0.5)×venue_factor, 0.15, 0.90), demand_factor=(demand_score-10)/85
tickets_sold = min(capacity × sell_through, capacity)
total_revenue = tickets_sold × weighted_avg_price
```
**File:** `mad_analytics/revenue/llm_model.py` (per FORMULAS.md §3, cross-referenced against the file's existence and route wiring; full internal line-by-line was not independently re-read by hand in this pass beyond confirming the venue-factor bucket duplication noted in System 1).
**API:** `POST /llm-predict` → `POST /api/v1/analytics/ml/llm-predict`.
**Frontend:** Analysis page "LLM Revenue" (`llmPrediction.data.total_revenue`).
**Status:** LIVE + USED — this is a real, separately-displayed revenue number, distinct from System 2's "Predicted Revenue".

### System 5 — Scheduler-side revenue heuristic (predict-empty-concerts job)
```
sell_through = clamp(0.30 + (popularity/100)×0.65, 0.30, 0.95)
```
**File:** `mad_analytics/server.py::_run_predict_empty_concerts_job()` (per prior code reading; reused again in `_run_data_validation_job()`'s "Fix 3" correction). A fourth, independent revenue-estimation formula.
**API/Frontend:** none — runs only inside the Python background scheduler to backfill missing `totalRevenue`/`ticketsSold` on existing concert rows.
**Status:** LIVE + USED (backend scheduler only) — not exposed via any API or UI, and not documented in any of the three `.md` files.

### System 6 — Node `revenuePrediction.service.ts` ("hybrid-revenue-v1")
```
demand_score = clamp(
    global_popularity×0.18 + local_popularity×0.24 + artist_momentum×0.14 + city_demand×0.16
  + venue_performance×0.11 + ticket_pricing_intelligence×0.08 + seasonal_trends×0.06 + engagement_velocity×0.03
, 0, 100)
capacityPressure = capacity<1000 ? +0.08 : capacity>20000 ? -0.08 : 0
timingPenalty = days_until_event<0 ? -0.05 : 0
weekendBoost = is_weekend ? +0.04 : 0
sellout = clamp(0.18 + demand_score/115 + capacityPressure + timingPenalty + weekendBoost, 0.05, 0.99)
expected_attendance = min(capacity, round(capacity × sellout))
expected_revenue = expected_attendance × avg_ticket_price
```
**File:** `backend/src/services/predictions/revenuePrediction.service.ts` (verified in full, lines 1–150), features from `backend/src/services/features/featureEngineering.service.ts`.
**Persistence:** writes `PredictionOutput` on every call; writes `PredictionTrainingData` when the input references a `Concert` with a real `totalRevenue` (for future model evaluation, not currently used to retrain anything in this file).
**Where called:** `POST /api/v1/concerts/predictions/revenue` (admin-only route) and internally from `concertIntelligenceService.predictForEvent` — but that internal caller runs with `runPredictions: false` by default and is otherwise a stubbed no-op (see Section 8).
**Frontend:** **confirmed via grep — no file in `src/` calls this route or imports this service.**
**Status:** IMPLEMENTED / ORPHANED — a real, working, DB-writing model with a live route, but not reachable from any current product UI.

---

## SECTION 5 — DEMAND SYSTEMS

### A. LIVE Demand formula
```
Demand = PlatformSize×0.35 + Momentum×0.35 + GoogleTrends×0.20 + CityAffinity×0.10
```
renormalized over present components. **This is the formula `calculate()` actually runs** — confirmed directly: `demand/scorer.py::calculate()` (lines 524–574) calls `platform_size_scores()`, `_artist_momentum_from_metrics()`, `payload.google_trends_score` / `_google_trends_for_artist()`, and `city_affinity_for_city()`, then blends them via `_blend_demand()` using `DEMAND_WEIGHTS = {platform_size: 0.35, momentum: 0.35, google_trends: 0.20, city_affinity: 0.10}` (lines 333–338).
**API/Frontend:** `POST /demand` → Analysis page "Demand Score". **Status: LIVE + USED.**

### B. Implemented-but-unused/dead Demand formula
```
demand_score = social_velocity×0.40 + ticket_velocity×0.30 + seasonality×0.20 + recency×0.10
social_velocity = min(1, log1p(total_growth_14d) / log1p(1,000,000))
ticket_velocity = mean(sell_through_rate for concerts in last 90 days)
seasonality = month_weight + weekend_bonus(0.1 if Fri/Sat/Sun)
recency = bucketed by days-since-last-played (never→0.7, <30d→0.2, 30-90d→0.5, 90-180d→0.8, >180d→0.9)
```
**File:** same file, `demand/scorer.py` — `WEIGHTS = {...}` dict (lines 36–41) and a fully-written `_recency_score()` function (lines 129–155) exist, and `social_velocity`/`ticket_velocity`/`seasonality_factor` are imported at the top of the file (lines 24–31) — **but confirmed directly: `calculate()` (the file's only public entry point) never references `WEIGHTS`, `_recency_score`, `social_velocity`, `ticket_velocity`, or `seasonality_factor` anywhere in its body.** These identifiers do not appear as call sites anywhere else in the repo either.
**Which one is actually used by the product:** **Formula A only.** Formula B is dead code — fully written, callable in isolation, but never invoked by any route, scheduler job, or training script.
**Status: IMPLEMENTED BUT NOT USED.**

---

## SECTION 6 — OTHER IMPLEMENTED ANALYTICS

### Confidence variants
See Section 2, item 7 — three unrelated formulas (Demand tier / Revenue interval-width / Venue-Capacity validation score), all Python, all LIVE + USED for their respective stats.

### Google Trends
See Section 2, item 9. **Separately noted:** `backend/src/services/scrapers/viberate/scorer.ts::getTrendsScore()` reads a **different** table, `ArtistTrendScore.normalizedScore` (0–1), to feed the Viberate V2 score's Layer 3 — this is not the same signal as `artists.googleTrendsScore` written by the Python pytrends job. **The writer/producer of `ArtistTrendScore` was not identified in this audit** — do not assume it is the same pytrends pipeline. Flagged as `UNKNOWN / CANNOT VERIFY (writer)`; the read side is confirmed live.

### Venue Capacity
See Section 2, item 11 for the mechanism. Heuristic constants (all confirmed directly against `venue_capacity/resolver.py`):
```
VENUE_TYPE_BASELINES: stadium=40000, arena=15000, amphitheatre=8000, theater/theatre/auditorium=2500,
  club=700, lounge=500, bar=250, festival/grounds=25000, park=12000, hall/center/centre=3500, indoor=6000
capacity = round(venue_base × city_multiplier × artist_multiplier), floor 100
city_multiplier: tier_1=1.0, tier_2=0.72, tier_3(default)=0.45
artist_multiplier: superstar=1.45, major=1.15, mid=0.9, rising=0.72, micro=0.45
```
Validation/confidence adjustments and status thresholds (validated ≥0.82, review_required ≥0.6, estimated only if source=="heuristic" and <0.6, else review_required) confirmed at `resolver.py:426-490`.
**Its own city-tier table** (`CITY_TIER_1` = mumbai/delhi/bangalore/bengaluru/hyderabad/chennai/pune/kolkata, `CITY_TIER_2` = ahmedabad/jaipur/chandigarh/lucknow/indore/kochi/bhopal/bhubaneswar/guwahati, default tier_3) is **independently defined** from Demand's `CITY_TIER_FACTORS` and classifies some cities differently (e.g. Pune and Kolkata are Tier-1 here but Tier-2/Tier-3 in Demand's table). **These are two separate tables serving two separate purposes and must not be conflated.**
**Status: LIVE + USED**, both tables.

### Artist tiers
```
ARTIST_TIER_BREAKS = [0, 10_000, 100_000, 500_000, 2_000_000, ∞] → ["micro","rising","mid","major","superstar"]
```
Assigned from the max follower count across social platforms (streams/views intentionally excluded).
**File:** `mad_analytics/utils/feature_engineering.py::infer_artist_tier()`.
**Status: LIVE + USED** — feeds Revenue's `artist_tier` feature and Venue Capacity's `artist_multiplier`.

### Anomaly detection
```
if len(series) < 7: False
smoothed = exponential_smooth(series, alpha=0.3)
last_z = |residuals[-1]| / std(residuals); anomaly = last_z > 3.0
```
**File:** `mad_analytics/growth/rog_calculator.py::_anomaly_detected()` (verified lines 32–42). **Confirmed wired into the live `/growth` endpoint** — `calculate()` sets `PlatformForecast.anomaly_detected` for every platform (line 122).
**Frontend:** fetched as part of the `/growth` response's `platforms[]` array but **not confirmed to be rendered anywhere** — Analysis.jsx was found to read only `cross_platform_score` and `platforms[0].rog_30d` from this response.
**Status: LIVE (computed & returned by the API); not confirmed as displayed on the frontend.**

### Holt forecast (30/90/180-day)
```
level[t] = α·value[t] + (1-α)(level[t-1]+trend[t-1]); trend[t] = β·(level[t]-level[t-1]) + (1-β)·trend[t-1]
forecast[t+h] = level[t] + h·trend[t]   (α, β optimized by statsmodels; fallback: linear slope over the last 3 smoothed points)
```
**File:** `mad_analytics/utils/feature_engineering.py::forecast_holt()`. **Confirmed wired into `/growth`** — `calculate()` computes `forecast_30d`/`forecast_90d`/`forecast_180d` for every platform (lines 105–107, 118–120).
**Frontend:** not confirmed as displayed.
**Status: LIVE (computed & returned); not confirmed as displayed on the frontend.**

### Trend classification
```
rog_30>5 or rog_90>10 → "rising"; rog_30<-5 or rog_90<-10 → "declining"; else "stable"
```
**File:** `mad_analytics/growth/rog_calculator.py::_classify_trend()` (verified lines 24–29), wired into `/growth`'s `PlatformForecast.trend` (line 121).
**Status: LIVE (computed & returned); not confirmed as displayed on the frontend.**

### RoG
See Section 2, item 12. **Status: LIVE + USED** (visibly, via `avgRogDaily` on the Dashboard).

### City tier systems
Two independent tables — see Venue Capacity above and City Affinity in Section 2. Do not conflate.

---

## SECTION 7 — DATA → FORMULA → API → UI MAP

**Popularity (System A, canonical):**
`artists.{spotifyMonthlyListeners, youtubeSubscribers, instagramFollowers, facebookFollowers}` + `platform_metrics` (momentum) + `artists.googleTrendsScore`/live pytrends
→ `popularity/calculator.py::calculate()/calculate_all()`
→ `madAnalytics.service.ts::getPopularityScore/getAllPopularityScores`
→ `madAnalytics.controller.ts` → `GET/POST /api/v1/analytics/ml/popularity[/all]`
→ `src/hooks/useArtists.js` (batch) / `src/hooks/usePredictions.js::useMadPopularity` (single)
→ `src/pages/Artists.jsx` ("Popularity") / `src/pages/Analysis.jsx` ("Popularity")

**Demand:**
Platform followers + platform_metrics time series + `googleTrendsScore` + city (NCCS/concerts)
→ `demand/scorer.py::calculate()`
→ `madAnalytics.service.ts::getDemandScore` → `madAnalytics.controller.ts` → `POST /api/v1/analytics/ml/demand`
→ `usePredictions.js::useMadDemand`
→ `Analysis.jsx` ("Demand Score", "Risk", "Confidence")

**Revenue (System 2, headline):**
`concerts.{capacity, avgTicketPrice}` / venue resolver / `demand_score` / `cross_platform_score` / artist tier
→ `revenue/predictor.py::calculate()` (GradientBoosting + `_heuristic_revenue()` blend)
→ `madAnalytics.service.ts::getRevenuePrediction` → `madAnalytics.controller.ts` → `POST /api/v1/analytics/ml/revenue`
→ `usePredictions.js::useAutoPredict`
→ `Analysis.jsx` ("Predicted Revenue", "Model Confidence", "Prediction Range")

**Popularity (System B, Node Dashboard compositeScore):**
`Artist`/`PlatformMetric` rows (raw)
→ `dashboard.controller.ts::getTopArtists` (computed entirely in Node, no Python call)
→ `GET /api/v1/dashboard/top-artists`
→ `src/hooks/useDashboardData.js`
→ `src/pages/Dashboard.jsx` ("Popularity" on Top-10 list)

**Popularity (System D, Viberate V2):**
`ViberateMetricDaily` + `ArtistTrendScore`
→ `viberate/scorer.ts::runScorer()` (Render Cron Job, daily)
→ writes `ArtistPopularityV2Snapshot`
→ `artist.controller.ts::getScore` → `GET /api/v1/artists/:id/score`
→ `src/hooks/useViberate.js::useArtistScore`
→ `src/components/.../ScoreBreakdown.jsx` (Artist Profile "Score" tab)

**Venue Capacity:**
Curated `known_venues` / supplied input / `venues` DB / web search / heuristic
→ `venue_capacity/resolver.py::resolve_venue_capacity()`
→ `madAnalytics.service.ts::getVenueCapacity` → `POST /api/v1/analytics/ml/venue-capacity`
→ `usePredictions.js::useMadVenueCapacity`
→ `Analysis.jsx` ("Venue Capacity")

**Node "hybrid-revenue-v1" (orphaned):**
`Concert`/`Venue`/`PlatformMetric`/`AudienceDemographic` (raw features)
→ `featureEngineeringService.buildFeatures` → `revenuePredictionService.predict()`
→ `concert.controller.ts::predictRevenue` → `POST /api/v1/concerts/predictions/revenue` (admin-only)
→ **no frontend consumer found** — chain ends at the API.

---

## SECTION 8 — CURRENTLY MISSING / NOT IMPLEMENTED

- **`AudienceDemographic` has no writer anywhere in the codebase.** Confirmed directly via `grep -r "audienceDemographic\.(create|createMany|upsert)" backend/src` → zero matches. Every reference to this table across the codebase (`analytics.controller.ts`, `artist.controller.ts`, `featureEngineeringService.ts`) is a **read**. Yet live, routed UI exists wired to it — Dashboard age/gender pies (`Dashboard.jsx`) and Artist Profile's Demographics tab — meaning these charts run against a permanently empty table in the current system. The `/analytics/demographics/geo` endpoint additionally returns hardcoded placeholder `coordinates: [0,0]` and has no frontend caller at all.
- **`ArtistTrendScore` table** (feeds Viberate V2's Layer 3 trends signal) — read-side confirmed (`viberate/scorer.ts::getTrendsScore`), but **no writer/producer job was identified in this audit.** Flag for follow-up rather than assuming it shares the Python pytrends pipeline.
- **Dead Demand formula** (Section 5, formula B) — fully implemented, zero call sites.
- **Node `revenuePrediction.service.ts` / "hybrid-revenue-v1"** — implemented, DB-writing, wired to a real route, but **no frontend code calls it** (confirmed by grep).
- **`concertIntelligenceService.runDiscoveryPipeline`** — the method the frontend's admin "scrape" button (`AdminIngestion.jsx`) actually calls (`POST /concerts/intelligence`) contains a hardcoded `eventNormalizationService.normalizeBatch([] as RawConcertEvent[])` — an empty-array literal — so the method always no-ops regardless of what options the UI sends. Looks live from the frontend; does nothing.
- **`concertIntelligenceService.enqueueDiscoveryPipeline`** — returns the literal string `'scraping-handled-by-python-scheduler'`; a vestigial stub confirming this responsibility moved to Python.
- **Dead/unused frontend hooks and pages** (confirmed via grep — zero importers): `src/hooks/useDemographics.js` (also calls a URL shape that doesn't match any real route), `src/hooks/useDashboard.js` (duplicate of `useDashboardData.js`), `src/hooks/useViberate.js::useLeaderboard`, `usePredictions.js::useModelInfo` (a local stub returning `{models:[]}`, no real endpoint behind it). `src/pages/Demographics.jsx` is unrouted (commented out in `App.jsx` and in the sidebar nav) and renders only hardcoded mock data even if it were reachable. `src/pages/Artists1.jsx` / `ArtistProfile1.jsx` are unimported legacy duplicates.
- **`Artist.appleMusicListeners`** — referenced in `madAnalytics.service.ts`'s `reachPopularity()` fallback but **not declared on the current `Artist` Prisma model** (only in a historical migration file) — always resolves to `undefined`/0 at runtime.
- **`signal_revenue`** — computed, transmitted, never read by the frontend (Section 4, System 3).
- **Anomaly detection / Holt forecast / trend classification** — computed and returned by `/growth`, not confirmed as rendered on any page.

---

## SECTION 9 — CURRENT PROBLEMS / WHAT NEEDS FIXING

(No fixes applied — list only, per instructions.)

1. **Four competing Popularity systems** (Sections 3A–3D) shown to users under overlapping "Popularity" labels with no disambiguation — the same artist can show three different numbers across Dashboard / Artists grid / Artist Profile.
2. **Six revenue-related formulas** (Section 4) with only two ("Predicted Revenue" and "LLM Revenue") actually surfaced to users; `signal_revenue` and the Node hybrid model are computed/stored but invisible to the product.
3. **A fully-written, dead Demand formula** (Section 5B) sitting alongside the live one in the same file, with `FORMULAS.md`/`FORMULAS_SIMPLE.md` documenting the dead one as if it were canonical.
4. **`AudienceDemographic` has no ingestion/writer** — live demographic UI is wired to a permanently empty table.
5. **A stubbed scrape pipeline** (`concertIntelligenceService.runDiscoveryPipeline`) that the admin UI calls and believes is working, but which silently does nothing.
6. **An orphaned admin-only revenue model** (Node `revenuePrediction.service.ts`) with no product-facing consumer.
7. **Two independently-defined city-tier tables** (Demand's `CITY_TIER_FACTORS` vs. Venue Capacity's `city_multiplier`) that classify some of the same cities differently and are easy to conflate.
8. **A suspected schema/live-DB drift risk** on `artists.googleTrendsScore`, explicitly flagged in a Node code comment — worth confirming against the actual production database before relying on it.
9. **An unidentified writer for `ArtistTrendScore`** — the Viberate V2 score depends on a signal whose producer wasn't located in this audit.
10. **A stale docstring inside `popularity/calculator.py` itself** (says Spotify floor is "40%"; the constant is 0.45) — an intra-file inconsistency independent of the three `.md` docs.
11. **Several dead frontend hooks/pages** (`useDemographics.js`, `useDashboard.js`, `useLeaderboard`, `useModelInfo`, `Demographics.jsx`, `Artists1.jsx`, `ArtistProfile1.jsx`) — maintenance burden / risk of someone wiring UI to a hook that quietly calls the wrong URL shape.
12. **A stale Prisma-vs-migration mismatch** on `Artist.appleMusicListeners` — referenced in Node code but absent from the current schema model.
13. **Frontend label collisions on the same page** — Analysis.jsx's "Popularity Score" progress bar is actually fed by the *demand* score field, not the popularity engine's score shown a few rows above it as "Popularity".
14. **Documentation mismatches** — see Section 10 in full.

---

## SECTION 10 — FORMULA DOCUMENTATION STATUS

| File | Status |
|---|---|
| `FORMULAS_IMPLEMENTED_v2.md` | **Current and accurate** for what it covers: Popularity's full blend (incl. correct 0.45/0.25 floors), Platform Size, City Affinity, the live Demand formula, Risk, Demand-tier Confidence, and `signal_revenue`. **Incomplete**: does not mention the heuristic-revenue exact formula, the LLM pricing model, the real venue-capacity mechanism, RoG/Holt/anomaly-detection specifics, artist tiers, or any of the three competing Node popularity systems, or any of the other revenue systems. |
| `FORMULAS_SIMPLE.md` | **Materially inaccurate on Demand** — its Demand section explains the *dead* formula (Section 5B), not the live one. Its Revenue section carries specific performance claims ("69%/28% feature importance", "within 15% accuracy") that are training-run-dependent and were not corroborated against any fixed code constant in this audit — treat as unverified narrative, not a guaranteed figure. Momentum/RoG/Currency/Sell-Through sections are directionally consistent with code where checked. |
| `FORMULAS.md` | **Mixed.** Current and code-accurate for: heuristic revenue exact formula, ML blend weights, LLM pricing model, RoG, cross-platform score, anomaly detection, Holt forecast, trend classification, artist tiers, revenue validation rules, and the venue-capacity heuristic *constants*. **Stale/wrong** on: the Demand composite (documents the dead formula as canonical, Section 5B), Popularity (omits the Momentum/Trends blend and the entropy floors entirely), and the venue-capacity *mechanism* (describes a strict priority chain; the actual code collects candidates and picks the best-confidence one, and omits the highest-priority `known_venues` source entirely). |

**myFormulas.md is the new current-state reference.**

---

## SECTION 11 — FINAL SUMMARY TABLE

| Metric/System | Implemented? | Live/Used? | Canonical? | Main Code Location | Frontend Used? | Needs Fix? |
|---|---|---|---|---|---|---|
| Popularity — Python entropy blend (System A) | Yes | Yes | Yes | `popularity/calculator.py` | Yes (Artists, Analysis) | Disambiguate vs. B/D |
| Popularity — Node `compositeScore` (System B) | Yes | Yes | No | `dashboard.controller.ts` | Yes (Dashboard) | Disambiguate vs. A/D |
| Popularity — Node "V1" entropy (System C) | Yes | Yes (internal only) | No | `utils/artistPopularity.ts` | No (feeds Node revenue only) | Document as internal |
| Popularity — Viberate V2 `finalScore` (System D) | Yes | Yes | No | `viberate/scorer.ts` | Yes (Artist Profile Score tab) | Disambiguate vs. A/B |
| Momentum / cross_platform_score | Yes | Yes | Yes | `growth/rog_calculator.py` | Yes (Analysis "Growth Score") | — |
| Platform Size | Yes | Yes (internal) | Yes | `demand/scorer.py` | No (fetched, unrendered) | Consider surfacing |
| City Affinity | Yes | Yes (internal) | Yes | `demand/scorer.py` | No (fetched, unrendered) | Note dual city-tier tables |
| Demand — live (formula A) | Yes | Yes | Yes | `demand/scorer.py::calculate()` | Yes (Analysis) | — |
| Demand — dead (formula B) | Yes | No | No | `demand/scorer.py` (unused) | No | Remove or document as legacy |
| Risk | Yes | Yes | Yes | `demand/scorer.py::compute_risk` | Yes (Analysis) | — |
| Confidence — Demand tier | Yes | Yes | Yes | `demand/scorer.py::compute_confidence` | Yes (Analysis) | Clarify vs. other "Confidence" |
| Confidence — Revenue interval | Yes | Yes | Yes | `revenue/predictor.py::_confidence` | Yes (Analysis "Model Confidence") | Clarify vs. other "Confidence" |
| Confidence — Venue Capacity | Yes | Yes (internal) | Yes | `venue_capacity/resolver.py` | Yes (via status field) | Clarify vs. other "Confidence" |
| Revenue — heuristic+ML blend | Yes | Yes | Yes | `revenue/predictor.py::calculate()` | Yes (Analysis "Predicted Revenue") | — |
| Revenue — `signal_revenue` | Yes | No (frontend) | Yes (backend cross-check) | `revenue/predictor.py::signal_revenue` | No | Surface or remove from payload |
| Revenue — LLM pricing model | Yes | Yes | Yes | `revenue/llm_model.py` | Yes (Analysis "LLM Revenue") | — |
| Revenue — scheduler predict-empty heuristic | Yes | Yes (scheduler only) | No | `server.py` | No | Document |
| Revenue — Node hybrid-revenue-v1 | Yes | No (frontend) | No | `revenuePrediction.service.ts` | No | Wire up or remove |
| Google Trends (pytrends → `googleTrendsScore`) | Yes | Yes | Yes | `trends/google_trends.py` | Indirect (via Popularity/Demand/Dashboard) | Verify live-DB column exists |
| Google Trends (`ArtistTrendScore`) | Read-side yes | Yes (read) | Unclear | `viberate/scorer.ts` (writer unknown) | Yes (Artist Profile "Google Trends") | Identify writer |
| Venue Capacity | Yes | Yes | Yes | `venue_capacity/resolver.py` | Yes (Analysis) | Update docs to match real mechanism |
| Artist Tier | Yes | Yes (internal) | Yes | `utils/feature_engineering.py` | No (internal) | — |
| Anomaly Detection | Yes | Computed, not confirmed displayed | Yes | `growth/rog_calculator.py` | Not confirmed | Confirm/decide if worth surfacing |
| Holt Forecast | Yes | Computed, not confirmed displayed | Yes | `utils/feature_engineering.py` | Not confirmed | Confirm/decide if worth surfacing |
| Trend Classification | Yes | Computed, not confirmed displayed | Yes | `growth/rog_calculator.py` | Not confirmed | Confirm/decide if worth surfacing |
| RoG | Yes | Yes | Yes | `utils/feature_engineering.py::rog()` | Yes (Dashboard `avgRogDaily`) | — |
| AudienceDemographic (age/gender/geo) | Table yes, ingestion no | UI live, data empty | N/A | Prisma schema; no writer found | Yes (UI calls it, gets nothing) | Build ingestion or remove UI |

---

**Report:** Created only `myFormulas.md`. No existing project files modified.

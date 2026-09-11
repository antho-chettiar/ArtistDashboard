# MAD Analytics — Formula Consolidation Decisions

**Status:** Finalized decisions, not yet implemented.
**Purpose:** This file is the single source of truth for which formula/system wins in each area where `myFormulas.md` identified competing/conflicting implementations. Scope is formulas only — `AudienceDemographic` (missing data ingestion) is explicitly **out of scope** for this round; it will be handled separately once real data-sourcing is in place.
**Baseline reference:** `myFormulas.md` (current-state audit) — all file/line citations below trace back to it.

---

## 1. Demand Score

**Decision:** Keep System A (live formula) as canonical. Remove System B (dead code) from the live file, but preserve its concept as a documented future idea — do not implement it now.

- **Keep (canonical):** `Demand = PlatformSize×0.35 + Momentum×0.35 + GoogleTrends×0.20 + CityAffinity×0.10` (renormalized over present components)
  File: `mad_analytics/demand/scorer.py::calculate()` / `_blend_demand()`, weights at `DEMAND_WEIGHTS` (lines 333–338).
- **Remove from live code:** the unused `WEIGHTS` dict (lines 36–41), `_recency_score()` (lines 129–155), and the unused `social_velocity`/`ticket_velocity`/`seasonality_factor` imports (lines 24–31) in the same file — none are referenced by `calculate()`.
- **Archive, do not implement:** System B's underlying idea (ticket-sales-driven demand: social velocity 40% / past ticket sell-through 30% / seasonality 20% / recency-since-last-played 10%) — worth revisiting once real ticket-sales history is richer. Keep as a "future enhancement" note, not live code.
- **Docs to correct:** `FORMULAS.md` and `FORMULAS_SIMPLE.md` currently document System B as if it were canonical — needs correcting once implementation lands.

---

## 2. Popularity Score

**Decision:** System A becomes the **single universal Popularity formula**. Systems B, C, and D are removed as independent systems; every UI location that currently shows B/C/D output switches to consuming A instead.

- **Keep (canonical, everywhere):** `Popularity = BaseEntropy×0.60 + Momentum×0.20 + GoogleTrends×0.20`
  File: `mad_analytics/popularity/calculator.py::calculate()` / `calculate_all()`.
  Note: fix the stale docstring at line 100 (says "40%", should say the real constant `0.45` — Spotify entropy-weight floor).
- **Remove — System B (Node `compositeScore`):** `backend/src/controllers/dashboard.controller.ts::getTopArtists` (lines 132–375). Dashboard's Top-10 artist list must call the Python Popularity API (`GET /api/v1/analytics/ml/popularity/all`) instead of recomputing its own score in Node.
- **Remove — System C (Node "V1" entropy):** `backend/src/utils/artistPopularity.ts::calculateArtistPopularity` / `calculateArtistPopularityWithModel`. Its only consumer was feeding `global_popularity` into the Node hybrid-revenue-v1 feature pipeline — which is itself being removed (see Revenue §3, System 6), so this system has no remaining caller once that's done. Safe to delete outright.
- **Remove — System D (Viberate V2 `finalScore`):** `backend/src/services/scrapers/viberate/scorer.ts::runScorer()`. The Artist Profile "Score" tab (`ScoreBreakdown.jsx`, fed by `GET /api/v1/artists/:id/score`) must be rewired to display System A's breakdown (BaseEntropy / Momentum / GoogleTrends) instead of D's (Reach / Engagement / Trends).
  **Explicitly accepted tradeoff:** D's unique engagement signal (Instagram/YouTube likes+comments velocity, `EngagementService.calculate()`) is dropped entirely — A has no equivalent input. This was a deliberate call, not an oversight.
- **Frontend files needing rewiring:** `src/pages/Dashboard.jsx`, `src/pages/Artists.jsx` (already on A — no change), `src/pages/Analysis.jsx` (already on A — no change), `src/components/.../ScoreBreakdown.jsx` (Artist Profile Score tab — needs restructuring).

---

## 3. Revenue Prediction

**Decision:** Keep the two currently user-facing systems (#2 headline, #4 secondary). Remove the three that are computed-but-invisible or orphaned (#3, #5, #6). #1 stays only as #2's internal fallback (no code change needed there).

- **Keep — headline "Predicted Revenue" (System 2):** `predicted_revenue = model_prediction×0.55 + heuristic_prediction×0.45` (GradientBoostingRegressor + `_heuristic_revenue()`).
  File: `mad_analytics/revenue/predictor.py::calculate()` (lines 187–292). No changes to this formula itself.
- **Keep — secondary "LLM Revenue" (System 4):** dynamic pricing-tier model (`base_price` → VIP/Tier1/Tier2/Tier3 → `weighted_avg_price` → `total_revenue`).
  File: `mad_analytics/revenue/llm_model.py`. No changes.
- **Keep as-is (no user-facing change):** System 1, `_heuristic_revenue()` — stays exactly as it is, used only as System 2's cold-start fallback and 45%-weight component.
- **Remove — System 3 (`signal_revenue`):** stop computing/returning `signal_revenue`, `signal_tickets`, `signal_sell_through` in the `/revenue` API response.
  File: `mad_analytics/revenue/predictor.py::signal_revenue()` (lines 167–184) and its call site inside `calculate()`.
- **Remove — System 5 (scheduler backfill heuristic):** `sell_through = clamp(0.30 + (popularity/100)×0.65, 0.30, 0.95)`.
  File: `mad_analytics/server.py::_run_predict_empty_concerts_job()` and the same formula reused in `_run_data_validation_job()`'s "Fix 3" correction.
  **Open question for implementation:** this job needs *some* formula to backfill missing `totalRevenue`/`ticketsSold` on existing concert rows. Recommend pointing it at System 2 (`calculate()`) instead of a fifth bespoke formula — confirm this substitution during implementation rather than leaving the job with no fallback.
- **Remove — System 6 (Node "hybrid-revenue-v1"):** delete `backend/src/services/predictions/revenuePrediction.service.ts`, its admin route `POST /api/v1/concerts/predictions/revenue` in `concert.controller.ts`, and the `PredictionOutput`/`PredictionTrainingData` writes tied to it. Check `backend/src/services/features/featureEngineering.service.ts` for any other remaining consumer before deleting it wholesale (it may be used elsewhere).

---

## 4. Confidence Labeling

**Decision:** These are three legitimate, unrelated values — no formula changes, only a label fix on one of them.

- **Demand signal-completeness tier** → rename label from "Confidence" to **"Signal Completeness"** or **"Data Confidence"** on the Analysis page. Backend field name in `compute_confidence()` (`mad_analytics/demand/scorer.py`, lines 506–519) can stay as-is; this is a frontend display-label change in `src/pages/Analysis.jsx`.
- **Revenue interval-width confidence** → keep label "Model Confidence" exactly as-is. No change.
- **Venue Capacity validation confidence** → stays internal, exposed only via the `status` field (`validated` / `review_required` / `estimated`). No change.

---

## 5. City-Tier Tables

**Decision:** Keep two separate tables (different purposes, different multiplier scales) but reconcile which tier each city falls into so the two never disagree.

- **Demand's table** (`CITY_TIER_FACTORS` in `demand/scorer.py`): 4 tiers — Mumbai/Delhi=1.00, Bengaluru/Hyderabad/Chennai/Kolkata=0.85, Pune/Ahmedabad/Jaipur/Chandigarh=0.75, else=0.65.
- **Venue Capacity's table** (`CITY_TIER_1`/`CITY_TIER_2` in `venue_capacity/resolver.py`): 3 tiers — Tier 1 = {mumbai, delhi, bangalore/bengaluru, hyderabad, chennai, pune, kolkata}, Tier 2 = {ahmedabad, jaipur, chandigarh, lucknow, indore, kochi, bhopal, bhubaneswar, guwahati}, default = tier 3. Multipliers: 1.0 / 0.72 / 0.45.
- **Conflict:** Bengaluru, Hyderabad, Chennai, Kolkata, and Pune are all "Tier 1" (top bracket) in Venue Capacity but "Tier 2" or "Tier 3" (lower bracket) in Demand.
- **PROPOSED reconciled mapping (needs sign-off before implementation, since Demand has 4 tiers and Venue Capacity has 3 — someone has to decide how they line up):**
  - Shared Tier 1: Mumbai, Delhi
  - Shared Tier 2: Bengaluru/Bangalore, Hyderabad, Chennai, Kolkata
  - Shared Tier 3: Pune, Ahmedabad, Jaipur, Chandigarh
  - Shared Tier 4 (default): everything else, including Lucknow, Indore, Kochi, Bhopal, Bhubaneswar, Guwahati (previously Venue Capacity's Tier 2)
  - Venue Capacity's resolver would need a 4th multiplier bucket added (currently only has 3) to fully match this — flag this explicitly during implementation rather than silently collapsing tiers.
- **Action:** implementer should confirm the above mapping (or propose an alternative) before hardcoding — this is the one sub-decision in this sheet that wasn't fully pinned down and may need a quick check back with the project owner.

---

## 6. Google Trends Signals

**Decision:** Investigate the unidentified writer for `ArtistTrendScore` first; if nothing else depends on it, remove it and standardize on `googleTrendsScore` everywhere.

- **Step 1 — Investigate:** grep the full codebase (`backend/src`, any cron/scheduler configs, migration files) for any writer of `ArtistTrendScore` (create/update/upsert). Confirm whether `viberate/scorer.ts::getTrendsScore()` (its only known reader, part of System D which is being removed) is genuinely its only consumer.
- **Step 2a — If no other consumer found:** deprecate the `ArtistTrendScore` table/pipeline entirely. Remove `getTrendsScore()` from `viberate/scorer.ts` (moot anyway once System D is deleted per §2).
- **Step 2b — Standardize:** all "Google Trends" display (including the Artist Profile Score tab's current "Google Trends" sub-field, which reads from `ArtistTrendScore` today) should read from `artists.googleTrendsScore` instead, written by the `pytrends` job (`mad_analytics/trends/google_trends.py`).
- **Also confirm while in there:** a Node code comment (`viberate/sync.ts`) flags a risk that `artists.googleTrendsScore` may be declared in `schema.prisma`/migrations but **absent from the live production database** in at least one environment. Verify this against the actual DB before relying on the column being populated.

---

## Explicitly Out of Scope (this round)

- `AudienceDemographic` — no data writer exists anywhere in the codebase; Dashboard and Artist Profile demographic charts are wired to a permanently empty table. **Deferred** until real demographic data ingestion is built.

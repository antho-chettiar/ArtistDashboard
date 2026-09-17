# MAD Analytics — Implemented Formula Reference (Blueprint v2.0)

**Design:** signals-only (no historical ticket-sales data). Every score is a deterministic
function of the variables below — same inputs in → same numbers out.

**Missing-data rule (applies everywhere):** if an input/component is unavailable it is
**renormalized out** (the present component weights are rescaled to sum to 1.0). Values are
never fabricated; a component with no data simply drops out and lowers the Confidence tier.

Code lives in `mad_analytics/` (Python). Score ranges are 0–100 unless noted.

---

## 1. Master Variable Inventory

| Variable | Source | DB field / data location | Used in |
|---|---|---|---|
| Spotify monthly listeners | Viberate / Excel | `artists.spotifyMonthlyListeners` | Popularity (base), Platform Size |
| Spotify followers | Viberate / Excel | `artists.spotifyFollowers` | (reference) |
| YouTube subscribers | Viberate / Excel | `artists.youtubeSubscribers` | Popularity (base), Platform Size |
| Instagram followers | Viberate / Excel | `artists.instagramFollowers` | Popularity (base), Platform Size |
| Facebook followers | Viberate / Excel | `artists.facebookFollowers` | Popularity (base), Platform Size |
| Twitter followers | Viberate / Excel | `artists.twitterFollowers` | — (legacy Risk/Growth only, see §10) |
| Google Trends score (0–100) | pytrends job | `artists.googleTrendsScore` (or `DemandInput.google_trends_score`) | Popularity, Demand, Confidence |
| Per-platform time series | scrapers | `platform_metrics.{followers, streams, views, metricDate, platform}` | — (legacy Momentum only, see §10) |
| Stored RoG | ingestion | `platform_metrics.{rogDaily, rogWeekly, rogMonthly}` | — (unused) |
| Momentum (`cross_platform_score`) | derived (growth module) | — | — (legacy only, see §10) |
| City tier factor | static table (below) | — | City Affinity, Revenue |
| Market activity index | NCCS (primary) / concerts (fallback) | `mad_analytics/data/nccs.json` (`nccs_a`,`nccs_b`) · `concerts.{city, concertDate}` | City Affinity |
| NCCS A / B / C, population | NCCS reference | `mad_analytics/data/nccs.json` | City Affinity |
| Concerts in city (90d / 12m) | concerts | `concerts.{city, concertDate}` | City Affinity (fallback) |
| Venue capacity | input / venue DB / resolver | `concerts.capacity` · `venues.avgCapacity` · request input | Revenue |
| Avg ticket price | input / concerts | `concerts.avgTicketPrice` (or tier prices) · request input | Revenue |
| Platform Size (derived) | Step 2 | — | Demand |
| City Affinity (derived) | Step 3 | — | Demand |
| Demand (derived) | Step 4 | — | Revenue |

---

## 2. Popularity Score
**File:** `mad_analytics/popularity/calculator.py`

```
Popularity = BaseEntropy × 0.75 + GoogleTrends × 0.25
```
(weights renormalized over available components)

> **Changed (product decision, 2026-09):** Momentum (`cross_platform_score`, weight
> 0.20) was removed — Growth/RoG was archived (see **§10 Legacy — Retired
> Metrics**). Its weight was redistributed to BaseEntropy (0.60 → 0.75) and
> GoogleTrends (0.20 → 0.25).

- **BaseEntropy (0–100):** `5 + 95 × Σ(normalized_value[p] × entropy_weight[p])` over
  p ∈ {spotify, youtube, instagram, facebook}.
  - `normalized_value[p] = log1p(value) / max(log1p(value)) across cohort`
  - `entropy_weight[p]` = Shannon-entropy diversification weight, with floors **Spotify ≥ 0.45**, **Instagram ≥ 0.25**.
- **GoogleTrends (0–100):** `artists.googleTrendsScore` (else omitted).

**Inputs / DB:** `artists.{spotifyMonthlyListeners, youtubeSubscribers, instagramFollowers, facebookFollowers, googleTrendsScore}`.

---

## 3. Platform Size Score
**File:** `mad_analytics/demand/scorer.py` → `compute_platform_size`

```
PlatformSize = ( 0.40·norm(SpotifyMonthlyListeners)
               + 0.25·norm(YouTubeSubscribers)
               + 0.25·norm(InstagramFollowers)
               + 0.10·norm(FacebookFollowers) ) × 100
```
- `norm(x) = (x − cohort_min) / (cohort_max − cohort_min)`  (min-max across active artists; degenerate cohort → 0)

**Inputs / DB:** `artists.{spotifyMonthlyListeners, youtubeSubscribers, instagramFollowers, facebookFollowers}`.

---

## 4. City Affinity Score
**File:** `mad_analytics/demand/scorer.py` → `city_affinity_score`

```
CityAffinity = city_tier_factor × market_activity_index × 100
```

- **city_tier_factor:**

  | Tier | Cities | Factor |
  |---|---|---|
  | 1 | Mumbai, Delhi (New Delhi / Delhi NCR) | 1.00 |
  | 2 | Bengaluru/Bangalore, Hyderabad, Chennai, Kolkata | 0.85 |
  | 3 | Pune, Ahmedabad, Jaipur, Chandigarh | 0.75 |
  | 4 | all other cities | 0.65 |

- **market_activity_index (0–1):**
  - **Primary (NCCS):** `(NCCS_A + NCCS_B) / max(NCCS_A + NCCS_B across cities)` — the affluent + upper-middle consumer base, normalized so the strongest market = 1.0. Source: `mad_analytics/data/nccs.json`.
  - **Fallback (concerts):** `concerts_in_city_last_12m / max(concerts across cities)`.

**Inputs / data:** NCCS reference (`nccs_a`, `nccs_b`) or `concerts.{city, concertDate}`.
**NCCS plug-point:** provided via a swappable `MarketActivityProvider`; swap the source without changing the formula.

---

## 5. Demand Score
**File:** `mad_analytics/demand/scorer.py` → `calculate` / `_blend_demand`

```
Demand = PlatformSize × 0.55 + GoogleTrends × 0.30 + CityAffinity × 0.15
```
(renormalized over available components)

> **Changed (product decision, 2026-09):** Momentum (`cross_platform_score`, weight
> 0.35) was removed — Growth/RoG was archived (see **§10 Legacy — Retired
> Metrics**). Its weight was redistributed to PlatformSize (0.35 → 0.55),
> GoogleTrends (0.20 → 0.30), and CityAffinity (0.10 → 0.15).

**Inputs:** PlatformSize (§3), GoogleTrends (`artists.googleTrendsScore`), CityAffinity (§4).

---

## 6. Revenue Prediction
**File:** `mad_analytics/revenue/predictor.py` → `calculate()`

```
predicted_revenue = model_prediction × 0.55 + heuristic_prediction × 0.45
```

The trained GradientBoosting model (`model_prediction`) is blended with the rule-based
`_heuristic_revenue()` fallback (`heuristic_prediction`); see `FORMULAS.md` §1–2 for
the exact heuristic formula and blend weights.

> **Removed (FORMULA_DECISIONS.md §3, System 3):** this section previously also
> documented a `signal_revenue` signals-only cross-check
> (`sell_through = (demand/100) × city_tier_factor`, `revenue = capacity × sell_through × avg_ticket_price`).
> That value was computed and transmitted in the API response but never read by
> the frontend, and has been removed from `predictor.py` and `RevenueOutput`.

---

## 7. Confidence
**File:** `mad_analytics/demand/scorer.py` → `compute_confidence`

> **Removed (product decision — Risk is out of scope for the current Artist
> Analytics product):** this section previously also documented a Risk Score
> (`compute_risk`, Blueprint v2.0 Step 6), computed inside `calculate()` and
> exposed as `DemandOutput.risk` / the Analysis page's "Risk" stat. It has been
> removed from the active demand pipeline, the response schema, and the
> frontend. The original formula and implementation are preserved unchanged —
> see **§10 Legacy — Retired Metrics** below.

> **Renamed (product decision, 2026-09):** the Analysis page's tile for this
> value was labeled "Signal Completeness" — a stakeholder reads that as jargon.
> It is now labeled **"Data Confidence"**. The underlying tier logic
> (`compute_confidence`, High/Medium/Low/Insufficient) and the backend field
> name (`DemandOutput.confidence`) are unchanged — this is a display-label
> change only, in `src/pages/Analysis.jsx`.

### Confidence tier
```
High         = platform metrics + Google Trends + city data all present
Medium       = two of the three present
Low          = platform metrics only
Insufficient = no platform data
```

---

## 8. Supporting computations

> **Momentum / `cross_platform_score` / Rate of Growth (RoG) have been retired**
> from Popularity and Demand (product decision, 2026-09) — see **§10 Legacy —
> Retired Metrics** for the preserved formula and implementation location.

### Notes
- **Google Trends** requires the pytrends job to have populated `artists.googleTrendsScore`; until then it is unavailable → renormalized out, and Confidence drops a tier.

---

## 9. Formula → primary data dependencies (quick view)

| Formula | Needs (minimum for a real number) |
|---|---|
| Popularity | artist follower columns (Trends optional) |
| Platform Size | artist follower columns |
| City Affinity | NCCS data for the city (or concert history) |
| Demand | Platform Size + at least one of Google Trends / city affinity |
| Revenue | demand + city + venue capacity + avg ticket price |
| Confidence (shown on the Analysis page as **Data Confidence**) | (always computes — grades what's present) |

---

## 10. Legacy — Retired Metrics

### LEGACY — Risk Score
**Status:** Retired from active dashboard.
**Reason:** Removed from current product scope (product decision — not a bug or formula defect).
**Preserved implementation:** `mad_analytics/legacy/risk_score.py` (verbatim copy of `compute_risk` and its helpers, unchanged). Not imported by any active endpoint, service, or route.

```
Risk = average( market_saturation, momentum_volatility, trends_recency_gap )   # over available flags
  market_saturation   = clamp(concerts_city_90d / 20, 0, 1)
  momentum_volatility = clamp( STDDEV(rog[spotify, youtube, instagram, facebook]), 0, 1 )
  trends_recency_gap  = 1.0 if google_trends_score < 30 else 0.0
```
Level: **Low** < 0.33 · **Medium** 0.33–0.66 · **High** > 0.66.

**Inputs / DB (as originally implemented):** `concerts.{city, concertDate}` (90-day count), per-platform RoG from `platform_metrics`, `artists.googleTrendsScore`.

This formula/implementation is unchanged from its last active version; it is documented here only so it remains recoverable for possible future reuse.

### LEGACY — Growth / RoG (Momentum / `cross_platform_score`)
**Status:** Retired from Popularity and Demand.
**Reason:** Product decision (2026-09) — Growth/RoG added complexity without a proportional accuracy gain for V1; the freed-up weight was judged better spent on the more reliable remaining signals. Not a bug or formula defect.
**Preserved implementation:** `mad_analytics/legacy/growth_calculator.py` (verbatim copy of `calculate`, `_cross_platform_score`, and their helpers, unchanged). The `/growth` endpoint (`server.py`) still points at this preserved module, so it keeps returning a result for any external caller — it is simply no longer read by Popularity or Demand.

```
per platform:  score = 50 + 50 × tanh(rog_30d / 20)          # 0% growth → 50 (neutral)
cross_platform_score = Σ(weight[p] × score[p]) / Σ(weight[p])
weights: spotify 0.25, youtube 0.20, instagram 0.20, apple_music 0.15, twitter 0.10, facebook 0.10

rog(window) = (latest_value − value_window_days_ago) / value_window_days_ago × 100
```
Windows: 7 / 30 / 90 days. Returns 0 if insufficient data or non-positive baseline.
**Inputs / DB (as originally implemented):** `platform_metrics` primary metric per platform (Spotify/Apple = streams, YouTube = views, others = followers) — needs multiple dated rows (a time series), not just a current snapshot.

**Where its weight went:**
- Popularity: BaseEntropy 0.60 → **0.75**, GoogleTrends 0.20 → **0.25** (Momentum's 0.20 split between them).
- Demand: PlatformSize 0.35 → **0.55**, GoogleTrends 0.20 → **0.30**, CityAffinity 0.10 → **0.15** (Momentum's 0.35 split between them).
- Revenue: `best_rog_30d` / `cross_platform_score` were removed from the feature row assembled in `revenue/predictor.py` — they were never read by the primary heuristic formula, only by the (still-dormant) secondary ML model's feature row.

This formula/implementation is unchanged from its last active version; it is documented here only so it remains recoverable for possible future reuse.

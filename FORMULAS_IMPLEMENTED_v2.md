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
| Twitter followers | Viberate / Excel | `artists.twitterFollowers` | Risk (volatility, optional) |
| Google Trends score (0–100) | pytrends job | `artists.googleTrendsScore` (or `DemandInput.google_trends_score`) | Popularity, Demand, Risk, Confidence |
| Per-platform time series | scrapers | `platform_metrics.{followers, streams, views, metricDate, platform}` | Momentum, Risk (volatility) |
| Stored RoG | ingestion | `platform_metrics.{rogDaily, rogWeekly, rogMonthly}` | (alt momentum input) |
| Momentum (`cross_platform_score`) | derived (growth module) | — | Popularity, Demand |
| City tier factor | static table (below) | — | City Affinity, Revenue |
| Market activity index | NCCS (primary) / concerts (fallback) | `mad_analytics/data/nccs.json` (`nccs_a`,`nccs_b`) · `concerts.{city, concertDate}` | City Affinity |
| NCCS A / B / C, population | NCCS reference | `mad_analytics/data/nccs.json` | City Affinity |
| Concerts in city (90d / 12m) | concerts | `concerts.{city, concertDate}` | Risk (saturation), City Affinity (fallback) |
| Venue capacity | input / venue DB / resolver | `concerts.capacity` · `venues.avgCapacity` · request input | Revenue |
| Avg ticket price | input / concerts | `concerts.avgTicketPrice` (or tier prices) · request input | Revenue |
| Platform Size (derived) | Step 2 | — | Demand |
| City Affinity (derived) | Step 3 | — | Demand |
| Demand (derived) | Step 4 | — | Revenue |

---

## 2. Popularity Score
**File:** `mad_analytics/popularity/calculator.py`

```
Popularity = BaseEntropy × 0.60 + Momentum × 0.20 + GoogleTrends × 0.20
```
(weights renormalized over available components)

- **BaseEntropy (0–100):** `5 + 95 × Σ(normalized_value[p] × entropy_weight[p])` over
  p ∈ {spotify, youtube, instagram, facebook}.
  - `normalized_value[p] = log1p(value) / max(log1p(value)) across cohort`
  - `entropy_weight[p]` = Shannon-entropy diversification weight, with floors **Spotify ≥ 0.45**, **Instagram ≥ 0.25**.
- **Momentum (0–100):** `cross_platform_score` (see §8). Needs a platform-metrics time series.
- **GoogleTrends (0–100):** `artists.googleTrendsScore` (else omitted).

**Inputs / DB:** `artists.{spotifyMonthlyListeners, youtubeSubscribers, instagramFollowers, facebookFollowers, googleTrendsScore}`, `platform_metrics` time series (momentum).

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
Demand = PlatformSize × 0.35 + Momentum × 0.35 + GoogleTrends × 0.20 + CityAffinity × 0.10
```
(renormalized over available components)

**Inputs:** PlatformSize (§3), Momentum = `cross_platform_score` (§8), GoogleTrends (`artists.googleTrendsScore`), CityAffinity (§4).

---

## 6. Revenue Prediction (signals-only)
**File:** `mad_analytics/revenue/predictor.py` → `signal_revenue`

```
sell_through = clamp( (demand / 100) × city_tier_factor , 0, 1 )
tickets      = capacity × sell_through
revenue      = tickets × avg_ticket_price
```

**Inputs / DB:** demand (§5), city_tier_factor (§4), `capacity` (`concerts.capacity` / `venues.avgCapacity` / request), `avg_ticket_price` (`concerts.avgTicketPrice` / tier prices / request). Revenue is in the concert's local currency.

*(The trained GradientBoosting model remains the headline `predicted_revenue`; this signals-only value is returned additively as `signal_revenue`.)*

---

## 7. Risk & Confidence
**File:** `mad_analytics/demand/scorer.py` → `compute_risk`, `compute_confidence`

### Risk Score (0–1)
```
Risk = average( market_saturation, momentum_volatility, trends_recency_gap )   # over available flags
  market_saturation   = clamp(concerts_city_90d / 20, 0, 1)
  momentum_volatility = clamp( STDDEV(rog[spotify, youtube, instagram, facebook]), 0, 1 )
  trends_recency_gap  = 1.0 if google_trends_score < 30 else 0.0
```
Level: **Low** < 0.33 · **Medium** 0.33–0.66 · **High** > 0.66.

**Inputs / DB:** `concerts.{city, concertDate}` (90-day count), per-platform RoG from `platform_metrics`, `artists.googleTrendsScore`.

### Confidence tier
```
High         = platform metrics + Google Trends + city data all present
Medium       = two of the three present
Low          = platform metrics only
Insufficient = no platform data
```

---

## 8. Supporting computations

### Momentum — `cross_platform_score`
**File:** `mad_analytics/growth/rog_calculator.py`
```
per platform:  score = 50 + 50 × tanh(rog_30d / 20)          # 0% growth → 50 (neutral)
cross_platform_score = Σ(weight[p] × score[p]) / Σ(weight[p])
weights: spotify 0.25, youtube 0.20, instagram 0.20, apple_music 0.15, twitter 0.10, facebook 0.10
```

### Rate of Growth (RoG)
```
rog(window) = (latest_value − value_window_days_ago) / value_window_days_ago × 100
```
Windows: 7 / 30 / 90 days. Returns 0 if insufficient data or non-positive baseline.
**Input:** `platform_metrics` primary metric per platform (Spotify/Apple = streams, YouTube = views, others = followers).

### Notes
- **Momentum needs a time series** (multiple dated `platform_metrics` rows). With only a current snapshot it is unavailable → renormalized out (Demand/Popularity still compute from the other components).
- **Google Trends** requires the pytrends job to have populated `artists.googleTrendsScore`; until then it is unavailable → renormalized out, and Confidence drops a tier.

---

## 9. Formula → primary data dependencies (quick view)

| Formula | Needs (minimum for a real number) |
|---|---|
| Popularity | artist follower columns (Trends & momentum optional) |
| Platform Size | artist follower columns |
| City Affinity | NCCS data for the city (or concert history) |
| Demand | Platform Size + at least one of momentum / city affinity |
| Revenue | demand + city + venue capacity + avg ticket price |
| Risk | any of: city concert count / multi-platform RoG / Trends |
| Confidence | (always computes — grades what's present) |

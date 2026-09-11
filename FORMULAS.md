# MAD Analytics — Complete Formula Reference

Every formula, algorithm, and calculation used in this project, with detailed parameter explanations.

---

## Table of Contents

1. [Revenue Prediction (ML Model)](#1-revenue-prediction-ml-model)
2. [Revenue Prediction (Heuristic Fallback)](#2-revenue-prediction-heuristic-fallback)
3. [LLM-Style Pricing & Sales Predictor](#3-llm-style-pricing--sales-predictor)
4. [Demand Scoring](#4-demand-scoring)
5. [Growth Rate-of-Change (RoG)](#5-growth-rate-of-change-rog)
6. [Artist Popularity (Entropy-Weighted)](#6-artist-popularity-entropy-weighted)
7. [Venue Capacity Resolution](#7-venue-capacity-resolution)
8. [Currency Conversion](#8-currency-conversion)
9. [Sell-Through Calculations](#9-sell-through-calculations)
10. [Forecasting (Holt Linear Trend)](#10-forecasting-holt-linear-trend)
11. [Anomaly Detection](#11-anomaly-detection)
12. [Cross-Platform Growth Score](#12-cross-platform-growth-score)

---

## 1. Revenue Prediction (ML Model)

**File:** `mad_analytics/revenue/predictor.py`
**Model:** GradientBoostingRegressor (scikit-learn)
**Training:** `mad_analytics/training/train_revenue.py`

### Final Prediction Formula

```
predicted_revenue = (model_prediction × 0.55) + (heuristic_prediction × 0.45)
```

| Parameter | Source | Description |
|-----------|--------|-------------|
| `model_prediction` | GradientBoostingRegressor output | ML model trained on 49 historical concerts |
| `heuristic_prediction` | `_heuristic_revenue()` function | Rule-based fallback (see Section 2) |
| `0.55 / 0.45` | Hardcoded blend weights | Balances ML accuracy with heuristic stability |

### Model Features (Input to GradientBoosting)

| Feature | Formula / Source | Description |
|---------|-----------------|-------------|
| `venue_capacity` | From `concerts.capacity` or venue resolver | Max audience the venue holds |
| `avg_ticket_price` | `ticket_price_min + (price_range × 0.235)` | Weighted average across tiers: VIP(10%) + Tier1(20%) + Tier2(40%) + Tier3(30%) |
| `price_range` | `ticket_price_max - ticket_price_min` | Spread between cheapest and most expensive ticket |
| `max_revenue_naive` | `venue_capacity × avg_ticket_price` | Theoretical maximum if 100% sold |
| `is_weekend` | `1 if concert_date.weekday() in {4,5,6} else 0` | Friday/Saturday/Sunday = 1 |
| `month` | `concert_date.month` (1-12) | Month of the concert |
| `season` | Mapped from month: Dec-Feb=winter, Mar-May=spring, Jun-Aug=summer, Sep-Nov=autumn | Categorical season |
| `city` | From `concerts.city` | Concert city (categorical, one-hot encoded) |
| `country` | From `concerts.country` | Concert country (categorical, one-hot encoded) |
| `artist_tier` | See Artist Tier formula below | micro/rising/mid/major/superstar |
| `demand_score` | From Demand Scoring module (Section 4) | 0-100 composite demand score |
| `best_rog_30d` | `max(rog(platform, 30) for platform in all_platforms)` | Best 30-day growth rate across all platforms |
| `cross_platform_score` | From Growth module (Section 12) | 0-100 weighted cross-platform health |

### Artist Tier Classification

```
if max_followers >= 2,000,000 → "superstar"
if max_followers >= 500,000   → "major"
if max_followers >= 100,000   → "mid"
if max_followers >= 10,000    → "rising"
else                          → "micro"
```

| Parameter | Source |
|-----------|--------|
| `max_followers` | Maximum `followers` value across all `PlatformMetric` rows for the artist |

### Confidence Interval

```
confidence = min(0.95, max(0.1, 1 - relative_width / 2))
relative_width = (upper_bound - lower_bound) / predicted_revenue
```

| Parameter | Source |
|-----------|--------|
| `upper_bound` | 90th percentile of staged GradientBoosting predictions |
| `lower_bound` | 10th percentile of staged GradientBoosting predictions |

### Preprocessing Pipeline

- **Numeric features:** StandardScaler (zero mean, unit variance)
- **Categorical features:** OneHotEncoder (handle_unknown="ignore")

---

## 2. Revenue Prediction (Heuristic Fallback)

**File:** `mad_analytics/revenue/predictor.py` → `_heuristic_revenue()`

Used when no trained model exists, or blended with ML prediction.

### Formula

```
predicted_revenue = venue_capacity × avg_ticket_price × sell_through_rate
```

### Sell-Through Rate Calculation

```
sell_through = clamp((base + demand_factor × 0.5) × venue_factor, 0.15, 0.90)

base = 0.25 (fixed baseline)
demand_factor = (demand_score - 10) / 85
```

### Venue Factor

| Venue Capacity | Factor |
|---------------|--------|
| < 1,000 | 1.3 (small venues fill easier) |
| 1,000 – 5,000 | 1.1 |
| 5,000 – 20,000 | 1.0 (baseline) |
| > 20,000 | 0.8 (large venues harder to fill) |

| Parameter | Source |
|-----------|--------|
| `venue_capacity` | From venue resolver or concerts table |
| `avg_ticket_price` | `ticket_price_min + (range × 0.235)` |
| `demand_score` | From Demand Scoring module (0-100) |

---

## 3. LLM-Style Pricing & Sales Predictor

**File:** `mad_analytics/revenue/llm_model.py`

Deterministic heuristic model that predicts ticket pricing tiers and sales.

### Dynamic Pricing Tiers

```
base_price = max(500, (800 + artist_popularity × 12 + city_popularity × 8) × market_multiplier × scarcity_multiplier × venue_multiplier)

pricing_tiers = {
    VIP:     base_price × 4.5
    Tier 1:  base_price × 2.2
    Tier 2:  base_price × 1.0
    Tier 3:  base_price × 0.5
}

weighted_avg_price = VIP×0.10 + Tier1×0.20 + Tier2×0.40 + Tier3×0.30
```

| Parameter | Source | Range |
|-----------|--------|-------|
| `artist_popularity` | From `artists.popularity` or computed from social reach | 0-100 |
| `city_popularity` | `artist_city_popularity()` function | 0-100 |
| `market_multiplier` | `1 + city_market_boost(city) / 100` | 1.0-1.5 |
| `scarcity_multiplier` | Based on venue capacity (see below) | 0.75-1.3 |
| `venue_multiplier` | Based on venue type keyword | 0.7-1.6 |

### City Market Boost (selected values)

| City | Boost |
|------|-------|
| New York | +50 |
| London, Los Angeles | +45 |
| Mumbai, Dubai | +40 |
| Delhi | +38 |
| Bangalore | +35 |
| Singapore, Toronto | +30-35 |
| Default (unknown city) | 0 |

### Scarcity Multiplier

| Venue Capacity | Multiplier | Reasoning |
|---------------|------------|-----------|
| < 500 | 1.3 | Very exclusive, high demand |
| 500 – 2,000 | 1.1 | Small venues |
| 2,000 – 10,000 | 1.0 | Baseline |
| 10,000 – 30,000 | 0.9 | Large, slightly easier |
| > 30,000 | 0.75 | Very large, hard to fill |

### Venue Type Multiplier

| Type | Multiplier |
|------|-----------|
| Festival | 1.6 |
| Grounds | 1.5 |
| Stadium | 1.4 |
| Park | 1.3 |
| Arena | 1.2 |
| Amphitheatre | 1.1 |
| Theater | 0.9 |
| Hall | 0.8 |
| Club | 0.7 |

### Ticket Sales Prediction

```
demand_score = clamp(city_popularity × 0.65 + artist_popularity × 0.25 + city_market_boost × 0.3, 10, 95)

sell_through = clamp((0.25 + demand_factor × 0.5) × venue_factor, 0.15, 0.90)
demand_factor = (demand_score - 10) / 85

tickets_sold = min(venue_capacity × sell_through, venue_capacity)
total_revenue = tickets_sold × weighted_avg_price
```

### Artist City Popularity

```
city_popularity = global_popularity × market_multiplier × genre_affinity
```

| City | Market Multiplier |
|------|------------------|
| Mumbai | 1.20 |
| Bangalore | 1.20 |
| Delhi | 1.15 |
| Pune | 1.10 |
| Hyderabad | 1.05 |
| Kolkata | 0.95 |
| Chennai | 0.90 |
| Default (tier-3) | 0.70 |

---

## 4. Demand Scoring

**File:** `mad_analytics/demand/scorer.py`

> **Correction (see `myFormulas.md` / `FORMULA_DECISIONS.md` §1):** this section
> previously documented a "social velocity / ticket velocity / seasonality /
> recency" composite. That formula was never the one `calculate()` (the live
> entry point) computes — it existed only as dead constants/functions in the
> same file and has since been removed from the codebase. The formula actually
> live in production is the Blueprint v2.0 Demand score below.

### Composite Score Formula (live)

```
Demand = PlatformSize×0.35 + Momentum×0.35 + GoogleTrends×0.20 + CityAffinity×0.10
```

Weights are renormalized over whichever components are available (a missing
component is dropped, not fabricated as zero). See `mad_analytics/demand/scorer.py::calculate()` /
`_blend_demand()`, `DEMAND_WEIGHTS`. Platform Size, Momentum, Google Trends, and
City Affinity are each documented in their own sections of `FORMULAS_IMPLEMENTED_v2.md`.

### Archived idea (not implemented)

A ticket-sales-driven demand formula — `social_velocity×0.40 + ticket_velocity×0.30
+ seasonality×0.20 + recency×0.10` — was proposed and partially scaffolded but is
**not live code**. It remains a candidate future enhancement once richer real
ticket-sales history exists, per `FORMULA_DECISIONS.md` §1. Do not treat it as
the current formula.

---

## 5. Growth Rate-of-Change (RoG)

**File:** `mad_analytics/utils/feature_engineering.py` → `rog()`

### Formula

```
rog = ((end_value - start_value) / start_value) × 100

end_value = last value in the time series
start_value = value at (end_date - window_days)
```

| Parameter | Source |
|-----------|--------|
| `end_value` | Latest metric value (followers/streams/views) |
| `start_value` | Value `window` days before the latest |
| `window` | 7, 30, or 90 days |

**Guards:**
- Returns 0.0 if `start_value <= 0` (avoid divide-by-zero)
- Returns 0.0 if series has < 2 data points

### Platform Primary Metrics

| Platform | Primary Metric |
|----------|---------------|
| Spotify | streams |
| Apple Music | streams |
| YouTube | views |
| Instagram | followers |
| Facebook | followers |
| Twitter | followers |

---

## 6. Artist Popularity (Entropy-Weighted)

**File:** `mad_analytics/popularity/calculator.py`

Uses **information entropy** (Shannon entropy) to weight platforms by how much they differentiate artists.

### Step 1: Build Cross-Sectional Matrix

```
matrix[artist][platform] = log1p(metric_value)
```

All artists × all platforms (Spotify, YouTube, Instagram, Facebook, Twitter, Apple Music).

### Step 2: Compute Entropy Weights

```
For each platform column:
    probabilities = column / column_sum
    entropy = -entropy_factor × sum(p × log(p) for p in probabilities where p > 0)
    diversification = max(0, 1 - entropy)

entropy_factor = 1 / log(num_artists)  (normalization)

weights[platform] = diversification[platform] / sum(all diversifications)
```

**Intuition:** Platforms where all artists have similar values get LOW weight (low diversification). Platforms where artists differ significantly get HIGH weight.

### Step 3: Compute Score

```
normalized_value = log1p(artist_metric) / max(log1p(all_artists_metric))

platform_contribution = normalized_value × weight

popularity_score = clamp(5 + 95 × sum(all platform_contributions), 0, 100)
```

| Parameter | Source |
|-----------|--------|
| `artist_metric` | From `artists` table: `spotifyMonthlyListeners`, `youtubeSubscribers`, `instagramFollowers`, etc. |
| `num_artists` | Count of active artists in the database |
| `5` | Minimum score (no artist gets 0) |
| `95` | Score range (max contribution = 100) |

---

## 7. Venue Capacity Resolution

**File:** `mad_analytics/venue_capacity/resolver.py`

### Resolution Priority Chain

```
1. Supplied capacity (confidence: 0.95)
2. Source text extraction via regex (confidence: 0.70-0.90)
3. Venue DB lookup (confidence: 0.84-0.96)
4. Web search via SerpAPI (confidence: 0.78-0.92)
5. Heuristic estimate (confidence: 0.35-0.82)
```

### Heuristic Estimation Formula

```
capacity = venue_base × city_multiplier × artist_multiplier
capacity = max(100, capacity)
```

| Parameter | Formula |
|-----------|---------|
| `venue_base` | From VENUE_TYPE_BASELINES lookup (stadium=40K, arena=15K, club=700, etc.) |
| `city_multiplier` | Tier 1 cities = 1.0, Tier 2 = 0.72, Tier 3 = 0.45 |
| `artist_multiplier` | superstar=1.45, major=1.15, mid=0.9, rising=0.72, micro=0.45 |

### Validation Rules

```
if capacity < 100 → confidence -= 0.1, flag "unusually small"
if capacity > 200,000 → confidence -= 0.2, flag "unusually large"
if source == "heuristic" → confidence -= 0.05
if venue_type=stadium AND capacity < 1000 → confidence -= 0.15, flag "inconsistent"
if artist_tier=superstar AND capacity < 500 → confidence -= 0.08

Final status:
    confidence >= 0.82 → "validated"
    confidence >= 0.60 → "review_required"
    else               → "estimated"
```

### Capacity Range

```
spread = capacity × 0.08 (if validated) or capacity × 0.18 (if estimated)
capacity_min = max(1, capacity - spread)
capacity_max = capacity + spread
```

---

## 8. Currency Conversion

**File:** `mad_analytics/utils/currency.py` + `src/pages/Concerts.jsx`

### Server-Side (Python)

```
local_amount = predicted_revenue (in training currency, based on local ticket prices)
usd_amount = local_amount / USD_RATE[local_currency]
```

### Client-Side (Revenue Card Total)

```
total_revenue_inr = sum(concert.totalRevenue × RATES_TO_INR[concert.currency] for all concerts)
```

### Exchange Rates (1 unit = X INR)

| Currency | Rate to INR |
|----------|-------------|
| INR | 1 |
| USD | 84 |
| EUR | 91 |
| GBP | 106 |
| AUD | 55 |
| CAD | 61 |
| AED | 22.9 |
| SGD | 63 |
| NZD | 51 |

### Country → Currency Resolution

| Country | Currency |
|---------|----------|
| India | INR |
| United States | USD |
| United Kingdom | GBP |
| Australia | AUD |
| Canada | CAD |
| UAE | AED |
| Singapore | SGD |
| Germany, France, Italy, Spain, Netherlands | EUR |
| New Zealand | NZD |

---

## 9. Sell-Through Calculations

**File:** `mad_analytics/utils/feature_engineering.py`

### Sell-Through Rate

```
sell_through_rate = tickets_sold / venue_capacity
```

Capped at 1.0 by default (oversold events normalized).

### Sell-Through Percentage

```
sell_through_percentage = sell_through_rate × 100
```

### Ticket Velocity (for Demand Scoring)

```
ticket_velocity = mean(sell_through_rate for concerts where date is within last 90 days)
```

Only includes concerts where both `tickets_sold` and `venue_capacity` are available.

---

## 10. Forecasting (Holt Linear Trend)

**File:** `mad_analytics/utils/feature_engineering.py` → `forecast_holt()`

### Exponential Smoothing (preprocessing)

```
smoothed[t] = alpha × value[t] + (1 - alpha) × smoothed[t-1]
alpha = 0.3 (smoothing factor)
```

### Holt Linear Trend Model

```
level[t] = alpha × value[t] + (1 - alpha) × (level[t-1] + trend[t-1])
trend[t] = beta × (level[t] - level[t-1]) + (1 - beta) × trend[t-1]

forecast[t+h] = level[t] + h × trend[t]
```

| Parameter | Source |
|-----------|--------|
| `alpha` | Optimized by statsmodels (level smoothing) |
| `beta` | Optimized by statsmodels (trend smoothing) |
| `h` | Forecast horizon: 30, 90, or 180 days |

**Fallback** (if statsmodels fails or series too short):
```
slope = (smoothed[-1] - smoothed[-3]) / 2
forecast = max(0, smoothed[-1] + slope × steps)
```

---

## 11. Anomaly Detection

**File:** `mad_analytics/growth/rog_calculator.py` → `_anomaly_detected()`

### Z-Score Method

```
smoothed = exponential_smooth(series, alpha=0.3)
residuals = series - smoothed
std = residuals.std()
last_z = |residuals[-1]| / std

anomaly_detected = (last_z > 3.0)
```

| Parameter | Source |
|-----------|--------|
| `series` | Platform metric time series (followers/streams/views) |
| `3.0` | Sigma threshold (3 standard deviations) |
| `smoothed` | EWM smoothed baseline |

### Breakpoint Detection (PELT Algorithm)

```
Uses ruptures library with RBF kernel model
penalty = 5.0 (controls sensitivity)
```

Returns ISO date strings where structural trend changes were detected.

---

## 12. Cross-Platform Growth Score

**File:** `mad_analytics/growth/rog_calculator.py` → `_cross_platform_score()`

### Formula

```
For each platform:
    normalized_score = 50 + 50 × tanh(rog_30d / 20)

cross_platform_score = weighted_sum(normalized_score × platform_weight) / total_weight
```

### Platform Weights

| Platform | Weight |
|----------|--------|
| Spotify | 0.25 |
| YouTube | 0.20 |
| Instagram | 0.20 |
| Apple Music | 0.15 |
| Twitter | 0.10 |
| Facebook | 0.10 |

### Normalization via tanh

```
tanh(rog_30d / 20) maps:
    0% growth → score 50 (neutral)
    +20% growth → score ~80
    -20% growth → score ~20
    +50% growth → score ~94
    -50% growth → score ~6
```

The `tanh` function provides smooth saturation — extreme growth/decline doesn't produce scores outside [0, 100].

---

## 13. Trend Classification

**File:** `mad_analytics/growth/rog_calculator.py`

```
if rog_30d > 5 OR rog_90d > 10 → "rising"
if rog_30d < -5 OR rog_90d < -10 → "declining"
else → "stable"
```

---

## 14. Revenue Validation Rules

**File:** `mad_analytics/training/validate_concerts.py`

### Capacity Validation (Web Search)

```
if web_capacity > stored_capacity × 1.5 AND web_capacity / stored_capacity <= 5.0:
    → Flag: "capacity may be too low"
    → Correct to web_capacity

if stored_capacity > web_capacity × 2.5 AND web_capacity >= 1000:
    → Flag: "capacity may be too high"
    → Correct to web_capacity
```

### Revenue Consistency Check

```
expected_revenue = tickets_sold × avg_ticket_price
ratio = actual_revenue / expected_revenue

if ratio > 2.5 OR ratio < 0.3:
    → Flag: "revenue inconsistent"
    → Correct: revenue = tickets_sold × avg_ticket_price
```

### ATP Validation Ranges

| Country | Min ATP | Max ATP | Currency |
|---------|---------|---------|----------|
| India | 200 | 15,000 | INR |
| United States | 30 | 500 | USD |
| United Kingdom | 25 | 400 | GBP |
| Australia | 40 | 500 | AUD |
| Canada | 30 | 450 | CAD |
| UAE | 100 | 2,000 | AED |

---

## 15. Frontend Revenue Total (Server-Side Aggregation)

**File:** `backend/src/controllers/concert.controller.ts`

### Formula

```
totalRevenueINR = sum(concert.totalRevenue × RATES_TO_INR[concert.currency]) for ALL concerts matching filter

avgTicketPriceINR = totalRevenueINR / totalTickets
avgSellThrough = (totalTickets / totalCapacity) × 100
```

This runs server-side across ALL concerts in the database (not just the paginated page), ensuring the Revenue metric card always shows the complete total.

---

## Data Flow Summary

```
Social Media APIs (n8n workflows)
    ↓
PlatformMetrics table (daily followers, streams, views)
    ↓
┌─────────────────────────────────────────────────────┐
│  Growth Module: RoG + Holt Forecast + Anomaly       │
│  Demand Module: Social Velocity + Ticket Velocity   │
│                 + Seasonality + Recency              │
│  Popularity Module: Entropy Weights + Normalization │
└─────────────────────────────────────────────────────┘
    ↓
Revenue Predictor:
    features = [capacity, price, demand_score, rog, tier, ...]
    prediction = GradientBoosting(features) × 0.55 + Heuristic × 0.45
    ↓
Frontend Display (with currency conversion)
```

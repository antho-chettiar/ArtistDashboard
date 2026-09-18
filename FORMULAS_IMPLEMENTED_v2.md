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
| Artist genre-style tag | static roster table (curated, V1) | `feature_engineering.ARTIST_GENRE_STYLE` | Popularity, Platform Size (Phase 3, Day 6) |
| Artist performance language(s) | static roster table (curated, V1) | `revenue/predictor.ARTIST_LANGUAGES` | Revenue (Phase 3, Day 5) |
| City dominant language | static table | `revenue/predictor.CITY_DOMINANT_LANGUAGE` | Revenue (Phase 3, Day 5) |
| City affluence ratio (NCCS proxy) | NCCS reference | `mad_analytics/data/nccs.json` via `demand.scorer.city_affluence_ratio()` | Revenue (Phase 3, Day 7) |
| Venue type (outdoor/indoor) | input | `concerts.venueType` / request input | Revenue (Phase 3, Day 8) |
| Concert weekday / month | derived from concert date | `concerts.concertDate` | Revenue (`is_weekend` Phase 3 Day 7, `month` Phase 3 Day 8) |

---

## 2. Popularity Score
**File:** `mad_analytics/popularity/calculator.py`

```
Popularity = BaseEntropy × 0.80 + GoogleTrends × 0.20
```
(weights renormalized over available components)

> **Changed (product decision, 2026-09):** Momentum (`cross_platform_score`, weight
> 0.20) was removed — Growth/RoG was archived (see **§10 Legacy — Retired
> Metrics**). Its weight was redistributed to BaseEntropy (0.60 → 0.75) and
> GoogleTrends (0.20 → 0.25).

> **Changed again (2026-09 — Google Trends distortion incident):** an actor-singer's
> live Google Trends search interest spiked hard for reasons unrelated to music
> (most likely a film promotion), maxed out at 100 within Google Trends'
> always-scale-the-max-to-100 normalization, and that alone briefly outranked
> artists who are far more established musicians. Two fixes together: (1) the
> Trends lookback window widened from 3 to 12 months
> (`trends/google_trends.py`'s `fetch_trends_scores`) so a short-lived spike is
> diluted by a full year of baseline interest instead of dominating a 3-month
> window outright — verified live, the same artist's Trends score dropped from
> 100 to 0.31 once widened; (2) Trends' weight reduced 0.25 → 0.20 (moved to
> BaseEntropy, now 0.80) as a second layer of protection so even a spike that
> survives the wider window swings the score less.

- **BaseEntropy (0–100):** `5 + 95 × Σ(normalized_value[p] × tilted_entropy_weight[p])` over
  p ∈ {spotify, youtube, instagram, facebook}.
  - `normalized_value[p] = log1p(value) / max(log1p(value)) across cohort`
  - `entropy_weight[p]` = Shannon-entropy diversification weight, with floors **Spotify ≥ 0.45**, **Instagram ≥ 0.25**.
  - `tilted_entropy_weight[p]` = `entropy_weight[p]` adjusted by the artist's genre-style
    platform tilt (Phase 3, Day 6 — see §3's callout below), then renormalized back to
    sum to 1.0. Untagged artists (or a genre style with no tilt entry) get the
    untilted `entropy_weight[p]` unchanged.
- **GoogleTrends (0–100):** `artists.googleTrendsScore`, queried over a trailing
  12-month window (else omitted).

**Inputs / DB:** `artists.{spotifyMonthlyListeners, youtubeSubscribers, instagramFollowers, facebookFollowers, googleTrendsScore}`, curated genre-style tag (§3 callout).

---

## 3. Platform Size Score
**File:** `mad_analytics/demand/scorer.py` → `compute_platform_size`

```
PlatformSize = ( w_spotify·norm(SpotifyMonthlyListeners)
               + w_youtube·norm(YouTubeSubscribers)
               + w_instagram·norm(InstagramFollowers)
               + w_facebook·norm(FacebookFollowers) ) × 100
```
- `norm(x) = (x − cohort_min) / (cohort_max − cohort_min)`  (min-max across active artists; degenerate cohort → 0)
- Default weights `w = {spotify: 0.40, youtube: 0.25, instagram: 0.25, facebook: 0.10}`.

> **Added (Phase 3, Day 6 — genre-style platform tilt):** a regional/folk artist's
> real fanbase shows up more on YouTube than Spotify; the real `genre` DB field is
> unusable for this (it's "Pop" for almost every one of the 11 artists), so a small
> curated genre-style tag per artist (`feature_engineering.ARTIST_GENRE_STYLE`) tilts
> the platform weights above before use, then renormalizes back to sum to 1.0. The
> same tilt function (`feature_engineering.apply_genre_tilt`) and tag table are
> shared with Popularity's `entropy_weight[p]` above — one table, not two that could
> drift apart. Only `regional_folk` (YouTube ×1.5 / Spotify ×0.6) and `pop_remix`
> (Spotify ×1.15 / YouTube ×0.9) have a real tilt for V1; `mainstream_bollywood` and
> `modern_pop_crossover` are left untilted — 9 of the 11-artist roster is mainstream
> Bollywood, so the untilted weights were already calibrated against them. An artist
> not in the roster table gets no tilt, never a guessed adjustment.

**Inputs / DB:** `artists.{spotifyMonthlyListeners, youtubeSubscribers, instagramFollowers, facebookFollowers}`, curated genre-style tag.

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
**File:** `mad_analytics/revenue/predictor.py` → `calculate()` / `_heuristic_revenue()`

**PRIMARY (canonical):** a deterministic, rule-based Heuristic Revenue Model —
always computed, and always what `predicted_revenue`/`lower_bound`/`upper_bound`
come from.
**SECONDARY (optional/experimental):** a trained GradientBoostingRegressor,
attempted only as a comparison signal (`ml_available` / `ml_predicted_revenue`).
Its failure never affects the primary heuristic result, and it never blends
into or replaces it.

> **Corrected (2026-09):** this section previously described `predicted_revenue`
> as a 0.55/0.45 blend of a trained model and the heuristic. That was never how
> the live code works — the heuristic is canonical and the ML model is a
> secondary, optional-only comparison signal that never affects
> `predicted_revenue`. Corrected here to match `calculate()` as implemented.

> **Removed (FORMULA_DECISIONS.md §3, System 3):** this section previously also
> documented a `signal_revenue` signals-only cross-check
> (`sell_through = (demand/100) × city_tier_factor`, `revenue = capacity × sell_through × avg_ticket_price`).
> That value was computed and transmitted in the API response but never read by
> the frontend, and has been removed from `predictor.py` and `RevenueOutput`.

```
sell_through = clamp(0.15, 0.85, 0.25 + demand_factor × 0.5)
             × venue_factor
             × language_affinity_factor        (Phase 3, Day 5)
             × price_income_friction_factor    (Phase 3, Day 7)
             × weather_season_factor           (Phase 3, Day 8)
sell_through = clamp(0.15, 0.90, sell_through)

predicted_revenue = venue_capacity × avg_ticket_price × sell_through × weekend_premium_factor   (Phase 3, Day 7)
```
- `demand_factor = (demand_score − 10) / 85`
- `venue_factor`: **1.3** (capacity < 1,000) · **1.1** (< 5,000) · **1.0** (< 20,000) · **0.8** (≥ 20,000)

### Language Affinity (Phase 3, Day 5)
An artist performing in a language the target city doesn't primarily speak sells
fewer tickets there, even with high demand and a big venue.
```
language_affinity_factor = 1.20   artist/city language match (incl. a curated multi-lingual artist, always treated as a match)
                          = 1.00   artist or city not in the curated tables — never a guessed adjustment
                          = 0.80   language mismatch
```
Values are the original product pitch's "Linguistic Affinity" multiplier, not
invented fresh. **Inputs:** `revenue/predictor.ARTIST_LANGUAGES` (curated, 11-artist
roster), `revenue/predictor.CITY_DOMINANT_LANGUAGE` (static table, defaults to
Hindi for an unlisted city).

### Price-vs-City-Income Friction (Phase 3, Day 7)
Flagged as the single highest-value V1 accuracy addition. A ticket priced fine
for Mumbai can be genuinely unaffordable for a lower-income city's audience.
Mirrors the original pitch deck's Huff Gravity "Friction" term (Ticket Price ÷
City Daily Income), rebuilt from data already trusted for City Affinity (no
free/paid real income-data source exists):
```
affordable_reference = 2500 × city_affluence_ratio(city)     # AFFORDABLE_REFERENCE_PRICE_INR, a calibration assumption
price_income_friction_factor = 1.0                              if avg_ticket_price ≤ affordable_reference, or city unknown
                              = max(0.5, affordable_reference / avg_ticket_price)   otherwise
```
`city_affluence_ratio(city) = (NCCS_A + NCCS_B) / population` — the same NCCS
reference data (`mad_analytics/data/nccs.json`) City Affinity already uses,
via `demand.scorer.city_affluence_ratio()`. `2500` is a single, explicitly
labeled calibration anchor (not derived from real ticket-sales data — none
exists yet) and should be revisited once real concerts are logged (Phase 4:
Excel intake + predicted-vs-actual comparison).

### Weekend Ticket-Price Premium (Phase 3, Day 7)
`is_weekend` was already computed for the ML training feature row but never
read by the heuristic — this turns on that already-computed signal.
```
weekend_premium_factor = 1.08   if concert date is Friday/Saturday/Sunday, else 1.0
```
Organizers price weekend shows higher (more people free to attend), so this
scales the revenue total directly rather than the sell-through fill-rate.
Value is the original pitch deck's "Weekend Premium" multiplier.

### Weather / Season Risk (Phase 3, Day 8)
A monsoon-season outdoor show genuinely performs worse than a normal indoor
show. Deliberately simple — no paid weather API, just a static calendar rule:
```
weather_season_factor = 0.55   if concert month ∈ {Jun, Jul, Aug, Sep} AND venue is outdoor
                       = 1.00   otherwise (indoor is weather-shielded; unrecognized venue_type defaults to indoor)
```
`0.55` is the original pitch deck's exact "outdoor July monsoon" multiplier,
applied across the whole monsoon window for simplicity rather than tapering
month-by-month. This is a monsoon *penalty* on outdoor shows only — not a
winter bonus for anyone. Outdoor is detected by keyword match on `venue_type`
(stadium, arena, amphitheatre, festival, grounds, park, open air, outdoor).

**Inputs / DB (Phase 3 additions):** curated artist language + city dominant
language (Day 5), `mad_analytics/data/nccs.json` via `city_affluence_ratio()`
(Day 7), `concerts.concertDate` weekday (Day 7), `concerts.concertDate` month +
`concerts.venueType` (Day 8).

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
| Popularity | artist follower columns (Trends optional; genre-style tilt optional, §3 callout) |
| Platform Size | artist follower columns (genre-style tilt optional, §3 callout) |
| City Affinity | NCCS data for the city (or concert history) |
| Demand | Platform Size + at least one of Google Trends / city affinity |
| Revenue | demand + city + venue capacity + avg ticket price (language/price-income/weekend/weather adjustments all degrade to neutral, never block a result — §6) |
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

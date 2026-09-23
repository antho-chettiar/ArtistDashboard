"""
revenue/predictor.py
Revenue prediction for a single concert.

PRIMARY (canonical): Heuristic Revenue Model — a deterministic, rule-based
formula (see _heuristic_revenue) computed from venue_capacity, avg_ticket_price,
and demand_score. This is what predicted_revenue/lower_bound/upper_bound below
always come from.

SECONDARY (optional/experimental): a trained GradientBoostingRegressor (sklearn),
attempted only as a comparison signal (ml_available / ml_predicted_revenue).
Its failure never affects the primary heuristic result.
Training: run training/train_revenue.py to generate models/revenue_model.joblib
          and models/revenue_preprocessor.joblib
"""
from __future__ import annotations
import logging
from datetime import datetime, timezone
from typing import Optional

import numpy as np
import pandas as pd

from ..utils.schemas import RevenueInput, RevenueOutput
from ..utils import model_store
from ..utils.feature_engineering import (
    concert_base_features, infer_artist_tier,
    resolve_venue_capacity, DEFAULT_AVG_TICKET_PRICE_INR,
)
from ..demand.scorer import calculate as demand_calculate
from ..utils.schemas import DemandInput
# NOTE: this file used to import the growth module (growth_calculate/GrowthInput)
# to populate best_rog_30d/cross_platform_score below. Removed when Growth/RoG
# was archived — those two fields were never read by the PRIMARY heuristic
# formula (_heuristic_revenue), only by the currently-dormant SECONDARY ML
# model's feature row, so this is pure cleanup with zero effect on the live
# Revenue number. See mad_analytics/legacy/growth_calculator.py.

logger = logging.getLogger(__name__)


# ── Feature assembly ───────────────────────────────────────────────────────────

def _build_feature_row(payload: RevenueInput) -> dict:
    """
    Assemble all features into a flat dict, computing sub-modules inline
    when pre-computed values aren't provided.

    Capacity and ticket price are resolved with a fixed priority order so a
    missing historical value never blocks a prediction:
      1. Real, event-specific value supplied on the concert record.
      2. (Capacity only) A known/curated venue capacity or the venues
         database — via the existing resolve_venue_capacity() resolver.
      3. A reasonable default estimate.
    Whichever tier is used is recorded in feature_dict so calculate() can
    mark the result as an estimate rather than implying historical/actual data.
    """
    concert = payload.concert
    metrics = payload.platform_metrics

    # Base concert features (venue_capacity/avg_ticket_price placeholders here
    # are always overwritten below with the fully-resolved, provenance-aware
    # values — concert_base_features() also feeds the ML training pipeline,
    # so its own null-safe defaults are kept there unchanged.)
    features = concert_base_features(concert)

    # Artist tier
    artist_tier = infer_artist_tier(metrics)
    features["artist_tier"] = artist_tier

    # ── Capacity resolution, in the required priority order:
    #   1. Real, event-specific capacity — used directly, never
    #      second-guessed by curated/venue-database data.
    #   2/3. Otherwise, the existing resolver chain: known/curated venue
    #      capacity, the venues database, then a reasonable default estimate.
    #      enable_web_search=False: a routine revenue calculation must never
    #      trigger an outbound web search.
    if concert.venue_capacity is not None:
        features["venue_capacity"] = concert.venue_capacity
        features["capacity_source"] = "event_specific"
        features["capacity_is_estimated"] = False
    else:
        capacity_result = resolve_venue_capacity(
            concert.venue_name or "venue",
            concert.city,
            country=concert.country,
            venue_type=concert.venue_type or "",
            artist_tier=artist_tier,
            supplied_capacity=None,
            enable_web_search=False,
        )
        features["venue_capacity"] = capacity_result.capacity
        features["capacity_source"] = _capacity_source_label(capacity_result.source)
        features["capacity_is_estimated"] = capacity_result.status != "validated"

    # ── Ticket price resolution. There is no curated ticket-price database
    # today (see the venue capacity resolver's known-venue/venue-db tiers),
    # so this is a straightforward two-tier resolution: the caller's real
    # event-specific price, or a reasonable default.
    if concert.ticket_price_min is not None and concert.ticket_price_max is not None:
        price_range = concert.ticket_price_max - concert.ticket_price_min
        avg_price = concert.ticket_price_min + (price_range * 0.235)
        ticket_price_is_estimated = bool(concert.ticket_price_is_estimated)
    else:
        avg_price = DEFAULT_AVG_TICKET_PRICE_INR
        price_range = 0.0
        ticket_price_is_estimated = True

    features["avg_ticket_price"] = avg_price
    features["price_range"] = price_range
    features["ticket_price_is_estimated"] = ticket_price_is_estimated
    features["ticket_price_source"] = "default_estimate" if ticket_price_is_estimated else "event_specific"
    features["max_revenue_naive"] = features["venue_capacity"] * avg_price

    # Demand score — use pre-computed or compute inline
    if payload.demand_score is not None:
        demand_score = payload.demand_score
    else:
        demand_out = demand_calculate(DemandInput(
            artist_id=concert.artist_id,
            city=concert.city,
            country=concert.country,
            target_date=concert.date,
            platform_metrics=metrics,
            recent_concerts=[],
        ))
        demand_score = demand_out.score

    features["demand_score"] = demand_score

    # Language affinity — how well the artist's performance language matches
    # the target city's dominant language. See the "Language Affinity" section
    # below for the WHY and the static reference tables. Resolved here (DB
    # lookup) and stored as a plain multiplier so _heuristic_revenue itself
    # stays a pure function that only reads from feature_dict.
    artist_languages = _artist_languages_for(concert.artist_id)
    features["language_affinity_factor"] = _feasibility_language_factor(
        concert.artist_id, artist_languages, concert.city,
        payload.popularity_score, payload.regional_trend_score,
    )

    # Price-vs-city-income friction — see the "Price-vs-City-Income Friction"
    # section below for the WHY. Uses the now-resolved avg_price/city.
    features["price_income_friction_factor"] = _price_income_friction_factor(avg_price, concert.city)

    # Weather/season risk — see the "Weather / Season Risk" section below.
    features["weather_season_factor"] = _weather_season_factor(concert.date.month, concert.venue_type)

    # Cannibalization — see the "Cannibalization" section below for the WHY.
    features["cannibalization_factor"] = _cannibalization_factor(
        concert.artist_id, concert.city, concert.date
    )

    # best_rog_30d / cross_platform_score (growth/RoG-derived features) removed
    # here — see the NOTE by the imports above. If the dormant secondary ML
    # model is ever retrained (Phase 4 milestone, ~100+ logged concerts),
    # training/train_revenue.py's own NUMERIC_COLS still lists these two
    # columns; that script is untouched by this cleanup (it's an offline,
    # not-currently-invoked script) and should be reconciled with this feature
    # row's shape at that time.

    return features


#: Maps the venue-capacity resolver's internal `source` value to the public
#: capacity_source label returned by the revenue endpoint.
_CAPACITY_SOURCE_LABELS = {
    "known_venues_db": "known_venue",
    "venue_db": "venue_database",
    "supplied": "event_specific",
    "heuristic": "default_estimate",
    "web_search": "default_estimate",  # disabled for revenue (enable_web_search=False); kept for completeness
}


def _capacity_source_label(resolver_source: str) -> str:
    return _CAPACITY_SOURCE_LABELS.get(resolver_source, "default_estimate")


# ── Language Affinity (accuracy upgrade — Phase 3, Day 5, 2026-09) ─────────────
#
# WHY THIS EXISTS: an artist performing in a language the target city doesn't
# primarily speak sells fewer tickets there, even with high demand and a big
# venue — the Revenue formula had zero awareness of this before today. The
# multiplier values below (1.20x match / 0.80x mismatch) are taken directly
# from the original product pitch's "Linguistic Affinity" multiplier, not
# invented fresh for this change.
#
# ARTIST_LANGUAGES / CITY_DOMINANT_LANGUAGE are static reference tables,
# curated for the locked 11-artist V1 roster (plus Diljit Dosanjh, added
# 2026-09 as a calibration benchmark — see feature_engineering.ARTIST_GENRE_STYLE
# for why) and the concert cities already used across the product. An artist
# or city NOT in these tables gets the neutral 1.0x factor — we never guess a
# bonus or penalty from missing data, matching the "renormalize/neutral on
# missing" rule used everywhere else in these formulas.

#: Sentinel meaning "known to be multi-lingual enough to treat as a match in
#: every city" — used instead of trying to enumerate every language an artist
#: like Shreya Ghoshal performs in (we can't fully verify the list, but we are
#: confident it's broad).
_ANY_LANGUAGE = "*"

ARTIST_LANGUAGES: dict[str, frozenset[str]] = {
    "arijit singh":        frozenset({"hindi", "bengali"}),
    "shreya ghoshal":      frozenset({_ANY_LANGUAGE}),
    "sonu nigam":          frozenset({"hindi"}),
    "armaan malik":        frozenset({"hindi", "english"}),
    "vishal mishra":       frozenset({"hindi"}),
    "sachet parampara":    frozenset({"hindi"}),
    # UNCERTAIN — flagged during the V1 formula audit and accepted as a
    # best-effort placeholder by the business rather than blocking on it.
    # Correct this if/when the artist's actual primary language is confirmed.
    "hansraj raghuwanshi": frozenset({"punjabi", "himachali"}),
    "aparshakti khurana":  frozenset({"hindi"}),
    "ayushmann khurrana":  frozenset({"hindi"}),
    "neeraj shridhar":     frozenset({"hindi"}),
    "amaal mallik":        frozenset({"hindi"}),
    # Primarily Punjabi, also performs in Hindi -- global crossover artist,
    # not multi-lingual enough to warrant the _ANY_LANGUAGE sentinel.
    "diljit dosanjh":      frozenset({"punjabi", "hindi"}),
}

CITY_DOMINANT_LANGUAGE: dict[str, str] = {
    "mumbai": "hindi", "delhi": "hindi", "new delhi": "hindi", "delhi ncr": "hindi",
    "bangalore": "kannada", "bengaluru": "kannada",
    "hyderabad": "telugu",
    "chennai": "tamil",
    "kolkata": "bengali",
    "pune": "marathi",
    "ahmedabad": "gujarati",
    "jaipur": "hindi",
    "chandigarh": "punjabi",
}
#: Hindi is the closest thing to a lingua franca across most untracked Indian
#: cities, so it's the least-wrong default rather than an arbitrary guess.
DEFAULT_CITY_LANGUAGE = "hindi"

LANGUAGE_MATCH_FACTOR = 1.20     # perfect language match (pitch deck's "Linguistic Affinity")
LANGUAGE_MISMATCH_FACTOR = 0.80  # language mismatch (same source)
LANGUAGE_NEUTRAL_FACTOR = 1.00   # unknown artist/city — never guess a bonus or penalty


def _city_dominant_language(city: str) -> str:
    """Resolve a city's dominant concert-market language (defaults to Hindi)."""
    if not city:
        return DEFAULT_CITY_LANGUAGE
    return CITY_DOMINANT_LANGUAGE.get(city.strip().lower(), DEFAULT_CITY_LANGUAGE)


def _language_affinity_factor(artist_languages: Optional[frozenset[str]], city: str) -> float:
    """Pure: sell-through multiplier for artist-language vs city-language fit.

    No DB — offline-testable. `artist_languages=None` (artist not in the
    static roster table, e.g. a future addition) always returns the neutral
    factor rather than guessing a penalty. The _ANY_LANGUAGE marker (a
    known multi-lingual artist) always returns the match factor.
    """
    if not artist_languages:
        return LANGUAGE_NEUTRAL_FACTOR
    if _ANY_LANGUAGE in artist_languages:
        return LANGUAGE_MATCH_FACTOR
    city_language = _city_dominant_language(city)
    return LANGUAGE_MATCH_FACTOR if city_language in artist_languages else LANGUAGE_MISMATCH_FACTOR


def _artist_languages_for(artist_id: str) -> Optional[frozenset[str]]:
    """DB-touching resolver: artist_id -> artist name -> ARTIST_LANGUAGES entry.

    Reuses popularity.calculator._get_artist_name (the same name-lookup
    already used by Demand for its Google Trends lookup) rather than adding a
    second way to resolve an artist's name from its ID.
    """
    from ..popularity.calculator import _get_artist_name
    name = _get_artist_name(artist_id)
    if not name:
        return None
    return ARTIST_LANGUAGES.get(name.strip().lower())


# ── Feasibility hierarchy (Phase B, 2026-09) ────────────────────────────────
#
# WHY THIS EXISTS: the 2026-09 Diljit Dosanjh calibration incident (see
# touring_history/scorer.py) showed the flat language-affinity heuristic
# above is a last resort, not a rule -- Arijit Singh and Shreya Ghoshal
# both tour every linguistic region of India despite the "mismatch" table,
# and a real touring history is direct proof tickets already sold there,
# stronger than any language guess. Agreed hierarchy (Anthony, 2026-09):
#   1. Real touring precedent for this artist+city -> use it directly,
#      overriding the language heuristic entirely.
#   2. No precedent yet, but broad reach (high Popularity, OR -- 2026-09 --
#      high REGIONAL search interest in this city's own state, when supplied)
#      -> soften the mismatch penalty rather than fully applying an unproven
#      assumption. Regional interest is preferred when available: it answers
#      "does fame transcend language HERE" directly for the actual city,
#      instead of inferring it from a national number.
#   3. No precedent, no broad reach -> fall back to the flat heuristic above.
POPULARITY_BROAD_REACH_THRESHOLD = 70.0  # 0-100 scale; only genuinely broad-reach artists get Tier 2
LANGUAGE_MISMATCH_SOFTENED_FACTOR = 0.90  # halfway between neutral (1.0) and full mismatch (0.80)


def _feasibility_language_factor(
    artist_id: str,
    artist_languages: Optional[frozenset[str]],
    city: str,
    popularity_score: Optional[float],
    regional_trend_score: Optional[float] = None,
    db_url: Optional[str] = None,
) -> float:
    """Tiered replacement for a bare _language_affinity_factor() call --
    see the "Feasibility hierarchy" section above for the WHY. db_url=None
    (the live request path) shares the pooled engine via touring_precedent's
    own get_engine(db_url) call; tests pass an explicit temp-DB URL."""
    from ..touring_history import touring_precedent

    precedent = touring_precedent(artist_id, city, db_url=db_url)
    if precedent.has_precedent:
        return LANGUAGE_MATCH_FACTOR  # Tier 1: real ticket-sold evidence beats a language guess

    base_factor = _language_affinity_factor(artist_languages, city)
    if base_factor != LANGUAGE_MISMATCH_FACTOR:
        return base_factor  # already match/neutral -- Tier 2 never upgrades these

    # Tier 2: regional interest (this city's own state) is the more precise
    # signal and wins when supplied; national Popularity is the fallback
    # only when regional data wasn't provided at all (never both checked --
    # that would let a weak national score sneak in after a real regional
    # reading already said "no").
    if regional_trend_score is not None:
        return LANGUAGE_MISMATCH_SOFTENED_FACTOR if regional_trend_score >= POPULARITY_BROAD_REACH_THRESHOLD else base_factor
    if popularity_score is not None and popularity_score >= POPULARITY_BROAD_REACH_THRESHOLD:
        return LANGUAGE_MISMATCH_SOFTENED_FACTOR
    return base_factor  # Tier 3 -- no broad-reach signal available


# ── Cannibalization (Phase B, 2026-09) ──────────────────────────────────────
#
# WHY THIS EXISTS: flagged during the Phase B planning conversation as fully
# computable from concert dates already in the database, no new data needed.
# A rival concert (any other artist) in the same city within two weeks
# competes for the same local audience's discretionary spend and attention,
# dampening sell-through even when this show's own demand is high.
CANNIBALIZATION_WINDOW_DAYS = 14
CANNIBALIZATION_PENALTY_FACTOR = 0.85


def _cannibalization_factor(
    artist_id: str, city: str, concert_date, db_url: Optional[str] = None
) -> float:
    """Sell-through multiplier when another artist has a concert in the same
    city within +/- CANNIBALIZATION_WINDOW_DAYS of this one. City matching
    uses the same alias table as City Affinity (Bangalore == Bengaluru) so a
    rival show isn't missed over a spelling variant. db_url=None (the live
    request path) shares the pooled engine, matching the get_engine(db_url)
    convention used throughout touring_history/venue_capacity -- see
    touring_history/scorer.py's docstring for why this matters."""
    from datetime import timedelta
    from sqlalchemy import text
    from ..utils.db import get_engine
    from ..demand.scorer import _normalize_city_key

    # Bind the window as ISO date strings, not raw date objects -- works
    # uniformly whether "concertDate" is a real DATE column (production
    # Postgres) or a TEXT column (sqlite test fixtures, see
    # test_touring_history.py's _seed_concerts), since ISO-format strings
    # compare correctly both lexicographically and after Postgres's implicit
    # text-to-date cast.
    window_start = (concert_date - timedelta(days=CANNIBALIZATION_WINDOW_DAYS)).isoformat()
    window_end = (concert_date + timedelta(days=CANNIBALIZATION_WINDOW_DAYS)).isoformat()

    engine = get_engine(db_url)
    try:
        with engine.connect() as conn:
            rows = conn.execute(
                text(
                    'SELECT city FROM concerts WHERE "artistId" != :aid '
                    'AND "concertDate" BETWEEN :start AND :end'
                ),
                {"aid": artist_id, "start": window_start, "end": window_end},
            ).mappings().all()
    finally:
        if db_url is not None:
            engine.dispose()

    target_key = _normalize_city_key(city)
    has_rival = any(_normalize_city_key(r["city"] or "") == target_key for r in rows)
    return CANNIBALIZATION_PENALTY_FACTOR if has_rival else 1.0


# ── Price-vs-City-Income Friction (Phase 3, Day 7) ─────────────────────────────
#
# WHY THIS EXISTS: flagged as the single highest-value accuracy addition in
# the V1 plan. A ticket priced fine for Mumbai can be genuinely unaffordable
# for a lower-income city's audience even with identical demand and venue
# size — the Revenue formula had zero awareness of city-level affordability
# before today. Mirrors the original pitch deck's Huff Gravity "Friction" term
# (Ticket Price ÷ City Daily Income), rebuilt from data we actually have (the
# NCCS affluent-population ratio already trusted for City Affinity) instead of
# a real per-capita income figure we have no free source for.
#
# AFFORDABLE_REFERENCE_PRICE_INR is a single, explicitly labeled calibration
# assumption — NOT derived from real ticket-sales data (none exists yet; see
# Phase 4) — and should be revisited once real concerts are logged.
AFFORDABLE_REFERENCE_PRICE_INR = 2500.0  # comfortably affordable in India's most affluent metro market
MIN_FRICTION_FACTOR = 0.5  # floor — an expensive ticket in a low-income city dampens sell-through, never zeroes it


def _price_income_friction_factor(avg_ticket_price: float, city: str) -> float:
    """Sell-through multiplier for ticket price vs. the target city's
    affordability (NCCS-derived proxy — see demand.scorer.city_affluence_ratio).

    A city with no NCCS data gets the neutral 1.0x factor — never a guessed
    penalty. A price at or below the city's affordable reference also gets
    1.0x: this is a penalty for overpricing relative to the local market, not
    a bonus for underpricing.
    """
    from ..demand.scorer import city_affluence_ratio, _normalize_city_key
    ratio = city_affluence_ratio().get(_normalize_city_key(city or ""))
    if not ratio:
        return 1.0
    affordable_reference = AFFORDABLE_REFERENCE_PRICE_INR * ratio
    if affordable_reference <= 0 or avg_ticket_price <= affordable_reference:
        return 1.0
    price_ratio = avg_ticket_price / affordable_reference
    return max(MIN_FRICTION_FACTOR, 1.0 / price_ratio)


# ── Weather / Season Risk (Phase 3, Day 8) ─────────────────────────────────────
#
# WHY THIS EXISTS: a monsoon-season outdoor show genuinely performs worse than
# a normal indoor show — heavy rain suppresses turnout and can force
# cancellations — but the Revenue formula had zero awareness of this before
# today. Deliberately kept "simple" per the V1 plan: no paid weather API, just
# a static calendar rule. Indoor venues are weather-shielded so they're always
# neutral here — this is a monsoon PENALTY on outdoor shows, not a winter
# bonus for anyone (matching the plan's own framing: "outdoor monsoon show
# underperforms a December indoor one", not "indoor shows are boosted").
#
# OUTDOOR_MONSOON_RISK_FACTOR is the original pitch deck's exact "outdoor July
# monsoon" multiplier, applied across the whole monsoon window for simplicity
# rather than tapering month-by-month (that precision isn't something we have
# real data to justify yet).
MONSOON_MONTHS = {6, 7, 8, 9}          # June-September
OUTDOOR_MONSOON_RISK_FACTOR = 0.55

#: Keywords identifying an outdoor/exposed-to-weather venue, matched the same
#: loose way venue_capacity/resolver.py matches its own venue-type keywords.
#: An unrecognized/blank venue_type is treated as indoor (the safer, far more
#: common default for ticketed concerts) rather than guessing a penalty.
OUTDOOR_VENUE_KEYWORDS = (
    "stadium", "arena", "amphitheatre", "amphitheater",
    "festival", "grounds", "park", "open air", "open-air", "openair", "outdoor",
)


def _is_outdoor_venue_type(venue_type: Optional[str]) -> bool:
    if not venue_type:
        return False
    normalized = venue_type.strip().lower()
    return any(keyword in normalized for keyword in OUTDOOR_VENUE_KEYWORDS)


def _weather_season_factor(concert_month: int, venue_type: Optional[str]) -> float:
    """Sell-through multiplier for monsoon risk on outdoor shows.

    Pure — no DB, no API, offline-testable. Indoor (or unrecognized) venue
    types and non-monsoon months always return the neutral 1.0x.
    """
    if concert_month not in MONSOON_MONTHS:
        return 1.0
    if _is_outdoor_venue_type(venue_type):
        return OUTDOOR_MONSOON_RISK_FACTOR
    return 1.0


# ── Weekend Ticket-Price Premium (Phase 3, Day 7) ──────────────────────────────
#
# WHY THIS EXISTS: `is_weekend` was already computed by concert_base_features()
# for the ML training feature row (NUMERIC_COLS) but never actually read by
# the primary heuristic formula below — this turns on that already-computed
# signal. Organizers price Friday/Saturday shows higher (more people are free
# to attend, willing to pay more), so this scales the revenue total directly
# rather than the sell-through fill-rate — see _heuristic_revenue. Value is
# the same one used in the original pitch deck's "Weekend Premium" multiplier.
WEEKEND_PREMIUM_FACTOR = 1.08


# ── Inference ──────────────────────────────────────────────────────────────────

# NOTE: not referenced elsewhere in this file today (feature_dict is passed to
# the ML preprocessor as a full row, not filtered through these lists) — kept
# as documentation of the expected column shape. best_rog_30d/cross_platform_score
# were dropped from feature_dict above when Growth/RoG was archived; a
# train_revenue.py copy of these constants still includes them (see the NOTE
# in _build_feature_row above).
CATEGORICAL_COLS = ["season", "city", "country", "artist_tier"]
NUMERIC_COLS = [
    "venue_capacity", "avg_ticket_price", "price_range", "max_revenue_naive",
    "is_weekend", "month", "demand_score", "language_affinity_factor",
    "price_income_friction_factor", "weather_season_factor", "cannibalization_factor",
]


def _feature_importances(model, preprocessor, row_df: pd.DataFrame) -> dict[str, float]:
    """
    Return SHAP-style importances if shap is installed, else fall back to
    sklearn's built-in feature_importances_ attribute.
    """
    try:
        import shap
        explainer = shap.TreeExplainer(model)
        X_transformed = preprocessor.transform(row_df)
        shap_values = explainer.shap_values(X_transformed)
        feature_names = preprocessor.get_feature_names_out()
        importances = dict(zip(feature_names, np.abs(shap_values[0])))
        # Normalise to sum-to-1
        total = sum(importances.values()) or 1
        return {k: round(v / total, 4) for k, v in
                sorted(importances.items(), key=lambda x: -x[1])[:10]}
    except ImportError:
        # Fallback: sklearn feature_importances_
        feature_names = preprocessor.get_feature_names_out()
        raw = model.feature_importances_
        total = raw.sum() or 1
        imp = dict(zip(feature_names, raw / total))
        return {k: round(v, 4) for k, v in
                sorted(imp.items(), key=lambda x: -x[1])[:10]}


def _confidence(lower: float, upper: float, predicted: float) -> float:
    """Tighter interval → higher confidence (max 0.95)."""
    if predicted == 0:
        return 0.5
    relative_width = (upper - lower) / predicted
    return round(min(0.95, max(0.1, 1 - relative_width / 2)), 3)


def _heuristic_revenue(feature_dict: dict) -> float:
    """Economics-based baseline used for cold start and model calibration."""
    capacity = feature_dict["venue_capacity"]
    avg_price = feature_dict["avg_ticket_price"]
    demand_score = feature_dict["demand_score"]
    # Language-match multiplier (1.20x match / 1.00x unknown / 0.80x mismatch)
    # — see the "Language Affinity" section above. Defaults to neutral if this
    # feature_dict predates that field (e.g. a hand-built dict in a test).
    language_affinity_factor = feature_dict.get("language_affinity_factor", LANGUAGE_NEUTRAL_FACTOR)
    # Price-vs-city-income friction (<= 1.0x) — see that section above.
    price_income_friction_factor = feature_dict.get("price_income_friction_factor", 1.0)
    # Monsoon risk on outdoor shows (<= 1.0x) — see the "Weather / Season Risk" section above.
    weather_season_factor = feature_dict.get("weather_season_factor", 1.0)
    # Rival concert in the same city within +/-14 days (<= 1.0x) — see the
    # "Cannibalization" section above.
    cannibalization_factor = feature_dict.get("cannibalization_factor", 1.0)
    # Weekend ticket-price premium — see that section above.
    weekend_premium_factor = WEEKEND_PREMIUM_FACTOR if feature_dict.get("is_weekend") else 1.0

    base_sell_through = 0.25
    demand_factor = (demand_score - 10) / 85

    if capacity < 1000:
        venue_factor = 1.3
    elif capacity < 5000:
        venue_factor = 1.1
    elif capacity < 20000:
        venue_factor = 1.0
    else:
        venue_factor = 0.8

    # Sell-through: how much of the venue fills, driven by demand/venue size
    # and how well the show fits this audience (language match, local
    # affordability, and whether monsoon rain keeps an outdoor crowd away).
    # Weekend pricing is NOT a fill-rate effect, so it's kept out of
    # sell_through and applied to the revenue total below instead.
    sell_through = max(0.15, min(0.85, base_sell_through + demand_factor * 0.5))
    sell_through *= venue_factor
    sell_through *= language_affinity_factor
    sell_through *= price_income_friction_factor
    sell_through *= weather_season_factor
    sell_through *= cannibalization_factor
    sell_through = max(0.15, min(0.90, sell_through))

    return capacity * avg_price * sell_through * weekend_premium_factor


def calculate(payload: RevenueInput) -> RevenueOutput:
    """
    Predict concert revenue.

    Heuristic Revenue Model is the canonical PRIMARY predictor (production
    MVP stabilization — see FORMULA_DECISIONS.md-style consolidation notes).
    It is always computed first, using the existing rule-based formula
    unchanged, and its result is what predicted_revenue/lower_bound/
    upper_bound/confidence/feature_importances below are built from.

    The trained GradientBoosting model is attempted ONLY afterwards, as an
    optional/experimental secondary signal (ml_available / ml_predicted_revenue).
    Any failure there — missing model file, incompatible artifact, a
    load/predict error, anything — is caught, logged, and otherwise ignored:
    it can never prevent this function from returning the primary heuristic
    result, and it never blends into or replaces it.
    """
    concert = payload.concert

    # ── PRIMARY: Heuristic Revenue Model (canonical) ───────────────────────
    # feature_dict assembly (venue capacity, avg ticket price, demand score,
    # artist tier, growth/momentum) is a genuine prerequisite for the
    # heuristic formula itself -- if THIS fails, the required inputs really
    # are missing/unavailable, and it is correct for the request to fail.
    try:
        feature_dict = _build_feature_row(payload)
        row_df = pd.DataFrame([feature_dict])

        predicted   = _heuristic_revenue(feature_dict)
        lower       = predicted * 0.70
        upper       = predicted * 1.30
        importances = {
            "venue_capacity":    0.30,
            "avg_ticket_price":  0.25,
            "demand_score":      0.25,
            "artist_tier":       0.10,
            "seasonality":       0.10,
        }
    except Exception as e:
        logger.error(f"REVENUE_PRIMARY_HEURISTIC_FAILURE concert_id={concert.concert_id}: {e}")
        raise RuntimeError(
            f"Heuristic revenue calculation failed — required inputs unavailable: {e}"
        ) from e

    logger.info(f"REVENUE_PRIMARY_HEURISTIC_SUCCESS concert_id={concert.concert_id}")

    # ── SECONDARY (optional, experimental): ML model comparison ───────────
    # Never allowed to affect predicted_revenue/lower_bound/upper_bound above.
    ml_available = False
    ml_predicted_revenue: Optional[float] = None
    try:
        if model_store.exists("revenue_model") and model_store.exists("revenue_preprocessor"):
            model        = model_store.load("revenue_model")
            preprocessor = model_store.load("revenue_preprocessor")
            X = preprocessor.transform(row_df)
            ml_predicted_revenue = round(float(model.predict(X)[0]), 2)
            ml_available = True
            logger.info(f"REVENUE_SECONDARY_ML_SUCCESS concert_id={concert.concert_id}")
    except Exception as e:
        ml_available = False
        ml_predicted_revenue = None
        logger.warning(f"REVENUE_SECONDARY_ML_FAILURE concert_id={concert.concert_id}: {e}")

    # ── Currency conversion ───────────────────────────────────────────────
    # predicted/lower/upper are the heuristic values, computed directly from
    # the concert's own local ticket price and capacity, so they are already
    # in local currency. We additionally store the USD equivalent for
    # cross-country comparison.
    from ..utils.currency import resolve_currency, usd_to_local, local_to_usd, get_exchange_rate

    local_currency = resolve_currency(concert.country)
    exchange_rate = get_exchange_rate(local_currency)

    predicted_local = round(max(0.0, predicted), 2)
    lower_local = round(max(0.0, lower), 2)
    upper_local = round(max(0.0, upper), 2)

    predicted_usd = local_to_usd(predicted_local, local_currency)
    lower_usd = local_to_usd(lower_local, local_currency)
    upper_usd = local_to_usd(upper_local, local_currency)

    # ── Input provenance ───────────────────────────────────────────────────
    # Real inputs and fallback/estimated inputs are never conflated: each is
    # labeled with where it came from, so the caller (frontend) can present
    # this as an estimate rather than implying historical/actual revenue.
    capacity_is_estimated = feature_dict["capacity_is_estimated"]
    ticket_price_is_estimated = feature_dict["ticket_price_is_estimated"]
    if not capacity_is_estimated and not ticket_price_is_estimated:
        data_quality = "full"
    elif capacity_is_estimated and ticket_price_is_estimated:
        data_quality = "estimated"
    else:
        data_quality = "partial"

    return RevenueOutput(
        concert_id=concert.concert_id,
        artist_id=concert.artist_id,
        predicted_revenue=predicted_local,
        lower_bound=lower_local,
        upper_bound=upper_local,
        confidence=_confidence(lower, upper, predicted),
        demand_score_used=feature_dict["demand_score"],
        feature_importances=importances,
        computed_at=datetime.now(timezone.utc).isoformat(),
        currency=local_currency,
        predicted_revenue_usd=predicted_usd,
        lower_bound_usd=lower_usd,
        upper_bound_usd=upper_usd,
        exchange_rate=exchange_rate,
        model_type="heuristic",
        ml_available=ml_available,
        ml_predicted_revenue=ml_predicted_revenue,
        resolved_venue_capacity=int(feature_dict["venue_capacity"]),
        resolved_avg_ticket_price=float(feature_dict["avg_ticket_price"]),
        capacity_source=feature_dict["capacity_source"],
        capacity_is_estimated=capacity_is_estimated,
        ticket_price_source=feature_dict["ticket_price_source"],
        ticket_price_is_estimated=ticket_price_is_estimated,
        data_quality=data_quality,
        language_affinity_factor=feature_dict["language_affinity_factor"],
        price_income_friction_factor=feature_dict["price_income_friction_factor"],
        weekend_premium_applied=bool(feature_dict.get("is_weekend")),
        weather_season_factor=feature_dict["weather_season_factor"],
    )

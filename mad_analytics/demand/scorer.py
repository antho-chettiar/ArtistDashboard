"""
demand/scorer.py
Composite 0–100 demand score for an artist in a given city on a given date
(Formula Blueprint v2.1 — Growth/RoG retired, 2026-09).

Components
----------
- platform_size (55%) — social/streaming reach vs. a FIXED external anchor
  (Step 2; see "Platform Size" section below for why this is no longer
  cohort-relative)
- google_trends (30%) — real-time public search interest
- city_affinity (15%) — city tier × market activity (Step 3)

Momentum (cross_platform_score from the growth/RoG module) was dropped by
product decision — Growth/RoG has been archived (preserved, unchanged, in
mad_analytics/legacy/growth_calculator.py) because it added complexity without
a proportional accuracy gain for V1. Its 35% weight was redistributed to
Platform Size (35% -> 55%) and Google Trends (20% -> 30%), with City Affinity
picking up the remainder (10% -> 15%).

Missing components are renormalized out (present weights rescaled to sum to 1.0).

Platform Size's own per-platform weights are tilted per-artist by a curated
genre-style tag (Phase 3, Day 6 — see feature_engineering.ARTIST_GENRE_STYLE),
shared with Popularity's identical tilt: a regional/folk artist's real fanbase
shows up more on YouTube than Spotify, so treating every artist under the same
weights under- or over-counts them.

Input:  DemandInput
Output: DemandOutput
"""
from __future__ import annotations
import json
import logging
import os
from datetime import datetime, timezone, timedelta
from typing import Callable, Optional

from ..utils.feature_engineering import genre_style_for_artist_name, apply_genre_tilt

from ..utils.schemas import DemandInput, DemandOutput
from ..utils.db import fetch_artist_snapshots
from ..popularity.calculator import _scale_to_anchor, PLATFORM_ANCHORS


# ── Platform Size Score (Formula Blueprint v2.2 — fixed-anchor, 2026-09-29) ────
#
#   PlatformSize = 0.40·Spotify + 0.25·YouTube + 0.25·Instagram + 0.10·Facebook
#
# Each platform value is scaled against a FIXED external anchor (the same
# PLATFORM_ANCHORS Popularity's Reach component uses — see
# popularity/calculator.py's module docstring for the full incident), NOT the
# active-artist cohort's own min/max. The original cohort-relative version had
# the same defect Popularity's Reach and Google Trends components were both
# found to have on 2026-09-29: adding, removing, or updating any OTHER
# artist's followers would silently reshuffle every artist's Demand score,
# and a genuinely huge artist and a merely-large one could both get crushed
# toward the cohort's own max. Reusing Popularity's exact anchors (rather than
# deriving separate ones for Demand) also means the same absolute follower
# count means the same thing in both scores. Output is a 0–100 score.
# "Spotify" uses spotifyMonthlyListeners (the frontend's monthlyStreams); the
# other three use the artist snapshot follower columns.

PLATFORM_SIZE_WEIGHTS = {
    "spotify":   0.40,
    "youtube":   0.25,
    "instagram": 0.25,
    "facebook":  0.10,
}

# Map each platform to the artist-snapshot column returned by fetch_artist_snapshots().
PLATFORM_SIZE_FIELD = {
    "spotify":   "spotifyMonthlyListeners",
    "youtube":   "youtubeSubscribers",
    "instagram": "instagramFollowers",
    "facebook":  "facebookFollowers",
}


def compute_platform_size(
    artist_values: dict[str, float],
    genre_style: Optional[str] = None,
) -> float:
    """Platform Size Score (0–100) for one artist, scaled against Popularity's
    fixed PLATFORM_ANCHORS -- no cohort/roster needed, so this artist's score
    cannot be moved by any other artist's data (see module docstring).

    `genre_style` (Phase 3, Day 6) tilts PLATFORM_SIZE_WEIGHTS per-artist
    before use — see feature_engineering.apply_genre_tilt. None (the default)
    leaves the weights untouched, exactly the old behavior.

    Pure function — no DB — so it is unit-testable offline.
    """
    weights = apply_genre_tilt(PLATFORM_SIZE_WEIGHTS, genre_style)
    total = 0.0
    for platform, weight in weights.items():
        db_field = PLATFORM_SIZE_FIELD[platform]
        value = float(artist_values.get(platform, 0.0) or 0.0)
        scaled = _scale_to_anchor(value, PLATFORM_ANCHORS[db_field])
        total += weight * scaled
    return round(min(100.0, max(0.0, total * 100.0)), 2)


def platform_size_scores() -> dict[str, float]:
    """Compute Platform Size for every active artist from snapshot columns.

    Returns {artist_id: score_0_100}. Returns {} if no snapshot data is available
    (so callers renormalize this component out rather than fabricating a value).
    """
    try:
        artists = fetch_artist_snapshots()
    except Exception as e:
        logger.warning(f"[Demand] Platform Size unavailable (snapshot fetch failed): {e}")
        return {}
    if not artists:
        return {}

    result: dict[str, float] = {}
    for row in artists:
        values = {platform: float(row.get(field) or 0.0) for platform, field in PLATFORM_SIZE_FIELD.items()}
        artist_id = str(row["artist_id"])
        genre_style = genre_style_for_artist_name(row.get("artistName"))
        result[artist_id] = compute_platform_size(values, genre_style)
    return result


# ── City Affinity Score (Formula Blueprint v2.0 — Step 3) ─────────────────────
#
#   city_affinity = market_activity_index × 100
#
# market_activity_index is a 0–1 signal of how strong the live-music market is
# in that city, produced by a *provider* function. Preferred provider: real
# NCCS consumer-class data (nccs_market_activity() below -- see its own
# comment for the fixed-anchor, real-size-and-density blend, and the
# 2026-09-30 incident that replaced a hand-picked 12-city tier table with
# it). Fallback provider (used only if the NCCS reference file is
# unavailable): the count of concerts in that city over the last 12 months,
# normalized by the busiest city (count / max_count) -- a real but different
# signal ("how much has THIS APP already recorded here" rather than "how
# affluent/large is this real market"), with no provenance flag surfaced
# downstream when the fallback is the one actually in effect.
#
# NCCS PLUG-POINT: pass a different provider to city_affinity_scores() /
# city_affinity_for_city() to swap the market-activity source without
# touching the formula.

logger = logging.getLogger(__name__)

# A market-activity provider returns {city_lower: market_activity_index_0_1}.
MarketActivityProvider = Callable[[], "dict[str, float]"]


def city_affinity_score(city: str, market_activity_index: float) -> float:
    """Pure: city_affinity = market_activity_index × 100.

    market_activity_index is clamped to [0, 1]. Output 0–100. No DB — offline-testable.

    `city` is unused (kept for backward-compatible call sites/tests) --
    2026-09-30: this used to also multiply by a hand-picked city_tier_factor
    covering only 12 cities (everything else fell to one flat 0.65 default,
    silently discarding real NCCS data this app already has for 33 OTHER
    real cities -- Lucknow, Surat, Nagpur, Indore and more). Removed: the
    market_activity_index itself is now a fixed-anchor blend of real city
    size AND real per-capita affluence (see nccs_market_activity() below),
    computed the same way for every one of the 43 NCCS-covered cities, not
    just a hand-picked 12 -- so the tier multiplier's job is already done,
    more precisely, by the index itself.
    """
    idx = max(0.0, min(1.0, float(market_activity_index or 0.0)))
    return round(min(100.0, max(0.0, idx * 100.0)), 2)


def _concert_market_activity() -> dict[str, float]:
    """Default market-activity provider: concerts per city in the last 12 months,
    normalized by the busiest city (count / max_count) into [0, 1].

    Returns {city_lower: index}. Returns {} on any failure (so callers treat the
    component as unavailable rather than fabricating a value).
    """
    import os
    try:
        from sqlalchemy import text as sql_text
        from ..utils.db import get_engine
        engine = get_engine()
        with engine.connect() as conn:
            rows = conn.execute(sql_text("""
                SELECT LOWER(city) AS city, COUNT(*) AS cnt
                FROM concerts
                WHERE "concertDate" >= CURRENT_DATE - INTERVAL '12 months'
                  AND city IS NOT NULL AND city <> ''
                GROUP BY LOWER(city)
            """)).mappings().all()
    except Exception as e:
        logger.warning(f"[Demand] Failed to fetch concert market activity: {e}")
        return {}

    counts = {row["city"]: float(row["cnt"]) for row in rows if row["city"]}
    if not counts:
        return {}
    hi = max(counts.values())
    if hi <= 0:
        return {}
    return {city: min(1.0, cnt / hi) for city, cnt in counts.items()}


# ── NCCS-backed market activity (Blueprint: "Future NCCS integration") ────────
# Static consumer-class reference data bundled at mad_analytics/data/nccs.json.
#
#   market_activity_index = 0.7 × min(1, (NCCS_A+NCCS_B) / NCCS_ABSOLUTE_ANCHOR)
#                          + 0.3 × min(1, affluence_ratio / NCCS_RATIO_ANCHOR)
#
# 2026-09-30 redesign -- two real problems in the previous version, found in
# the same audit that fixed Popularity/Platform Size:
#   1. It was cohort-relative: "/ max(A+B across cities)" meant every city's
#      score depended on whichever city happened to be biggest in the CURRENT
#      data -- the exact same fragile pattern already fixed everywhere else
#      (a data refresh or a new city entry could silently reshuffle every
#      other city's score). Fixed anchors below close this the same way
#      Popularity's PLATFORM_ANCHORS did. Delhi is the real, stable ceiling
#      today (NCCS_A+B = 15,483,815) -- unlike an artist roster, a new city
#      isn't going to dethrone it next quarter, so anchoring near its real
#      value (rather than well above it) is a deliberate, different choice
#      from Popularity's anchors, not an oversight.
#   2. It was pure absolute city size, so two cities of very different real
#      density scored identically whenever a hand-picked tier table (removed
#      the same day, see city_affinity_score()) flattened them to the same
#      bucket -- e.g. Surat (real market index 0.23) and Lucknow (0.10) both
#      read as an identical 0.65 under the old tier multiplier, despite Surat
#      being genuinely ~2.3x bigger by this exact data. The 30% per-capita
#      term (city_affluence_ratio, already computed elsewhere in this file
#      for Revenue's price-friction factor) restores that real distinction.
# Known, honestly unfixed limits: NCCS affluence is a proxy for who CAN
# afford a ticket, not verified proof anyone actually buys one -- no real
# ticket-sales data exists to check either weight or anchor against, so
# 0.7/0.3 is a labeled V1 assumption, same convention as PLATFORM_WEIGHTS.
# The reference file also carries no date/vintage field anywhere, so its
# real age is unverifiable from the data itself -- flagged, not fixable
# without a fresher source. And this only ever covers the 43 cities the file
# already has: a city outside that set is invisible to City Affinity (and
# therefore to TOPSIS's candidate universe) regardless of this fix.
NCCS_ABSOLUTE_ANCHOR = 15_000_000.0   # ~Delhi's real current NCCS_A+B
NCCS_RATIO_ANCHOR = 0.55              # just above Mumbai's real current ratio (~0.515)
NCCS_ABSOLUTE_WEIGHT = 0.7
NCCS_RATIO_WEIGHT = 0.3

_NCCS_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "nccs.json")
_nccs_cache: Optional[dict[str, float]] = None

_CITY_ALIASES = {
    "bangalore": "bengaluru",
    "bombay": "mumbai",
    "calcutta": "kolkata",
    "madras": "chennai",
    "new delhi": "delhi",
    "delhi ncr": "delhi",
    "gurugram": "gurgaon",
    "thiruvananthapuram": "trivandrum",
    "prayagraj": "allahabad",
    "pondicherry": "puducherry",
}


def _normalize_city_key(name: str) -> str:
    k = (name or "").strip().lower()
    return _CITY_ALIASES.get(k, k)


def nccs_market_activity() -> dict[str, float]:
    """Market-activity provider backed by NCCS consumer-class data -- fixed-anchor
    blend of real city size (70%) and real per-capita affluence (30%), see the
    module comment above for the full incident and reasoning. Keyed by
    normalized city name, one entry per city nccs.json actually has. Returns
    {} if the reference file is missing.
    """
    global _nccs_cache
    if _nccs_cache is not None:
        return _nccs_cache
    try:
        with open(_NCCS_PATH, encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        logger.warning(f"[Demand] NCCS data unavailable: {e}")
        _nccs_cache = {}
        return _nccs_cache

    ratios = city_affluence_ratio()
    scores: dict[str, float] = {}
    for r in data:
        city = r.get("city")
        if not city:
            continue
        key = _normalize_city_key(city)
        ab = float(r.get("nccs_a", 0) or 0) + float(r.get("nccs_b", 0) or 0)
        absolute_component = min(1.0, ab / NCCS_ABSOLUTE_ANCHOR)
        ratio_component = min(1.0, ratios.get(key, 0.0) / NCCS_RATIO_ANCHOR)
        scores[key] = round(
            NCCS_ABSOLUTE_WEIGHT * absolute_component + NCCS_RATIO_WEIGHT * ratio_component, 4
        )
    _nccs_cache = scores
    return _nccs_cache


_nccs_affluence_ratio_cache: Optional[dict[str, float]] = None


def city_affluence_ratio() -> dict[str, float]:
    """Per-capita affluence proxy for each city, from the same NCCS reference
    data as nccs_market_activity() above: (NCCS_A + NCCS_B) / population — the
    fraction of a city's population in the affluent/upper-middle consumer
    classes, i.e. the segment realistically buying concert tickets. This is
    NOT a real income figure (no free/paid income-data source is wired in);
    it's a defensible proxy built from data this product already trusts for
    City Affinity, reused here for Revenue's price-vs-city-income friction
    penalty (Phase 3, Day 7) — see revenue/predictor.py.

    Keyed by normalized city name, roughly in [0, 1]. Returns {} if the
    reference file is missing.
    """
    global _nccs_affluence_ratio_cache
    if _nccs_affluence_ratio_cache is not None:
        return _nccs_affluence_ratio_cache
    try:
        with open(_NCCS_PATH, encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        logger.warning(f"[Demand] NCCS data unavailable for affluence ratio: {e}")
        _nccs_affluence_ratio_cache = {}
        return _nccs_affluence_ratio_cache

    ratios: dict[str, float] = {}
    for r in data:
        city = r.get("city")
        population = float(r.get("population", 0) or 0)
        if not city or population <= 0:
            continue
        affluent = float(r.get("nccs_a", 0) or 0) + float(r.get("nccs_b", 0) or 0)
        ratios[_normalize_city_key(city)] = min(1.0, affluent / population)
    _nccs_affluence_ratio_cache = ratios
    return _nccs_affluence_ratio_cache


def _default_market_activity() -> dict[str, float]:
    """Default market-activity source: NCCS if available, else concert history."""
    nccs = nccs_market_activity()
    return nccs if nccs else _concert_market_activity()


def city_affinity_scores(
    market_activity_provider: Optional[MarketActivityProvider] = None,
) -> dict[str, float]:
    """City Affinity (0–100) for every city that has market-activity data.

    Defaults to the NCCS-backed provider; pass a different provider to swap the
    market-activity source without touching the formula. Returns {city_lower: score}.
    """
    provider = market_activity_provider or _default_market_activity
    activity = provider()
    return {city: city_affinity_score(city, idx) for city, idx in activity.items()}


def city_affinity_for_city(
    city: str,
    market_activity_provider: Optional[MarketActivityProvider] = None,
) -> Optional[float]:
    """City Affinity (0–100) for a single city, or None when there is no
    market-activity data for it (so the Demand blend renormalizes it out).
    """
    provider = market_activity_provider or _default_market_activity
    activity = provider()
    key = _normalize_city_key(city)
    if key not in activity:
        return None
    return city_affinity_score(city, activity[key])


# ── Demand Score (Formula Blueprint v2.1 — Growth/RoG retired, 2026-09) ───────
#
#   Demand = PlatformSize*0.55 + GoogleTrends*0.30 + CityAffinity*0.15
#
# All three components are 0–100. Missing components are renormalized out (present
# weights rescaled to sum to 1.0) so a missing Google-Trends or city-affinity
# signal never silently zeroes the score and no value is fabricated.
# Momentum (35%) was removed and redistributed to these three — see module docstring.

DEMAND_WEIGHTS = {
    "platform_size": 0.55,
    "google_trends": 0.30,
    "city_affinity": 0.15,
}


def _blend_demand(
    platform_size: Optional[float],
    google_trends: Optional[float],
    city_affinity: Optional[float],
) -> tuple[float, dict[str, float], dict[str, float]]:
    """Apply the Demand blend, renormalizing over available components.

    Pure function — no DB — so it is unit-testable offline.
    Returns (score_0_100, components_present, effective_weights).
    """
    spec = [
        ("platform_size", platform_size),
        ("google_trends", google_trends),
        ("city_affinity", city_affinity),
    ]
    present = [(name, float(val), DEMAND_WEIGHTS[name]) for name, val in spec if val is not None]
    components = {name: round(val, 4) for name, val, _ in present}
    total_w = sum(w for _, _, w in present)
    if total_w <= 0:
        return 0.0, components, {}
    score = round(min(100.0, max(0.0, sum(val * w for _, val, w in present) / total_w)), 2)
    effective = {name: round(w / total_w, 4) for name, _, w in present}
    return score, components, effective


# NOTE: this file used to have an _artist_momentum_from_metrics() helper that
# called into the growth module (cross_platform_score) to produce Momentum for
# the blend above. Removed when Growth/RoG was archived as a product decision —
# the preserved implementation lives in mad_analytics/legacy/growth_calculator.py.


def _google_trends_for_artist(artist_id: str) -> Optional[float]:
    """Stored Google Trends score for an artist (reuses the popularity module's
    DB helpers). Returns None when unavailable (pytrends not yet run)."""
    try:
        from ..popularity.calculator import _get_artist_name, _fetch_stored_trends_scores
        name = _get_artist_name(artist_id)
        if not name:
            return None
        return _fetch_stored_trends_scores().get(name)
    except Exception as e:
        logger.warning(f"[Demand] Google Trends lookup failed for {artist_id}: {e}")
        return None


# NOTE: Risk Score (Formula Blueprint v2.0 — Step 6) has been retired from the
# active dashboard by product decision (Risk is out of scope for the current
# Artist Analytics product). The original implementation (compute_risk and its
# helpers) is preserved unchanged in mad_analytics/legacy/risk_score.py for
# possible future reuse — see that module's docstring. It is no longer called
# from calculate() below and DemandOutput no longer has a `risk` field.


# ── Confidence Score (Formula Blueprint v2.0 — Step 7) ────────────────────────
#
# Signal-completeness tier (Prediction_Formula §6):
#   High         — platform metrics + Google Trends + city data all present
#   Medium       — two of the three signals present
#   Low          — only platform metrics present
#   Insufficient — no platform data (no usable prediction)

def compute_confidence(
    platform_present: bool,
    trends_present: bool,
    city_present: bool,
) -> str:
    """Pure confidence tier from signal availability. Offline-testable."""
    if not platform_present:
        return "Insufficient"
    signals = int(platform_present) + int(trends_present) + int(city_present)
    if signals >= 3:
        return "High"
    if signals == 2:
        return "Medium"
    return "Low"


# ── Main entry point ───────────────────────────────────────────────────────────

def calculate(payload: DemandInput) -> DemandOutput:
    """
    Compute the composite demand score (Formula Blueprint v2.1):

        Demand = PlatformSize*0.55 + GoogleTrends*0.30 + CityAffinity*0.15

    Each component is 0–100. Weights are renormalized over whichever components are
    available. The returned `components` dict reports only the present components.
    """
    # Platform Size (Step 2) — needs the artist cohort, so computed over snapshots.
    platform_size = platform_size_scores().get(payload.artist_id)

    # Google Trends — explicit input > stored DB score > unavailable.
    google_trends = payload.google_trends_score
    if google_trends is None:
        google_trends = _google_trends_for_artist(payload.artist_id)

    # City Affinity (Step 3) for the target city — None if no market-activity data.
    city_affinity = city_affinity_for_city(payload.city)

    score, components, _effective = _blend_demand(
        platform_size, google_trends, city_affinity
    )

    # Confidence tier (Step 7) — signal completeness across platform / trends / city.
    platform_present = platform_size is not None
    confidence = compute_confidence(
        platform_present,
        google_trends is not None,
        city_affinity is not None,
    )

    return DemandOutput(
        artist_id=payload.artist_id,
        city=payload.city,
        score=score,
        components=components,
        computed_at=datetime.now(timezone.utc).isoformat(),
        confidence=confidence,
    )

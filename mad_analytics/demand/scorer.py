"""
demand/scorer.py
Composite 0–100 demand score for an artist in a given city on a given date
(Formula Blueprint v2.1 — Growth/RoG retired, 2026-09).

Components
----------
- platform_size (55%) — cohort-relative social/streaming reach (Step 2)
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


# ── Platform Size Score (Formula Blueprint v2.0 — Step 2) ─────────────────────
#
#   PlatformSize = 0.40·Spotify + 0.25·YouTube + 0.25·Instagram + 0.10·Facebook
#
# where each platform value is min-max normalized across the active-artist cohort:
#   norm(x) = (x - cohort_min) / (cohort_max - cohort_min)  clamped to [0, 1]
# Output is a 0–100 score. "Spotify" uses spotifyMonthlyListeners (the frontend's
# monthlyStreams); the other three use the artist snapshot follower columns.

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


def _minmax(value: float, lo: float, hi: float) -> float:
    """Min-max normalize to [0, 1]. Degenerate cohort (hi <= lo) -> 0.0."""
    if hi <= lo:
        return 0.0
    return max(0.0, min(1.0, (value - lo) / (hi - lo)))


def compute_platform_size(
    artist_values: dict[str, float],
    cohort_min: dict[str, float],
    cohort_max: dict[str, float],
    genre_style: Optional[str] = None,
) -> float:
    """Platform Size Score (0–100) for one artist given the cohort min/max.

    `genre_style` (Phase 3, Day 6) tilts PLATFORM_SIZE_WEIGHTS per-artist
    before use — see feature_engineering.apply_genre_tilt. None (the default)
    leaves the weights untouched, exactly the old behavior.

    Pure function — no DB — so it is unit-testable offline.
    """
    weights = apply_genre_tilt(PLATFORM_SIZE_WEIGHTS, genre_style)
    total = 0.0
    for platform, weight in weights.items():
        norm = _minmax(
            float(artist_values.get(platform, 0.0) or 0.0),
            float(cohort_min.get(platform, 0.0) or 0.0),
            float(cohort_max.get(platform, 0.0) or 0.0),
        )
        total += weight * norm
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

    cohort_values: dict[str, list[float]] = {p: [] for p in PLATFORM_SIZE_WEIGHTS}
    per_artist: dict[str, dict[str, float]] = {}
    per_artist_genre: dict[str, Optional[str]] = {}
    for row in artists:
        values: dict[str, float] = {}
        for platform, field in PLATFORM_SIZE_FIELD.items():
            v = float(row.get(field) or 0.0)
            values[platform] = v
            cohort_values[platform].append(v)
        artist_id = str(row["artist_id"])
        per_artist[artist_id] = values
        per_artist_genre[artist_id] = genre_style_for_artist_name(row.get("artistName"))

    cohort_min = {p: (min(vs) if vs else 0.0) for p, vs in cohort_values.items()}
    cohort_max = {p: (max(vs) if vs else 0.0) for p, vs in cohort_values.items()}

    return {
        artist_id: compute_platform_size(values, cohort_min, cohort_max, per_artist_genre[artist_id])
        for artist_id, values in per_artist.items()
    }


# ── City Affinity Score (Formula Blueprint v2.0 — Step 3) ─────────────────────
#
#   city_affinity = city_tier_factor × market_activity_index × 100
#
# city_tier_factor is a documented static table (below). market_activity_index is
# a 0–1 signal of how active the live-music market is in that city; by default it
# is the count of concerts in the city over the last 12 months, normalized by the
# busiest city (count / max_count).
#
# NCCS PLUG-POINT: market_activity_index is produced by a *provider* function.
# The default provider reads the concerts table; a future NCCS-backed provider can
# be passed to city_affinity_scores() / city_affinity_for_city() to replace the
# market-activity source WITHOUT changing this formula or the public interface.

logger = logging.getLogger(__name__)

CITY_TIER_FACTORS = {
    # Tier 1 — Mega
    "mumbai": 1.00, "delhi": 1.00, "new delhi": 1.00, "delhi ncr": 1.00,
    # Tier 2 — Major
    "bangalore": 0.85, "bengaluru": 0.85, "hyderabad": 0.85, "chennai": 0.85, "kolkata": 0.85,
    # Tier 3 — Large
    "pune": 0.75, "ahmedabad": 0.75, "jaipur": 0.75, "chandigarh": 0.75,
}
DEFAULT_CITY_TIER_FACTOR = 0.65   # Tier 4 — all remaining metros

# A market-activity provider returns {city_lower: market_activity_index_0_1}.
MarketActivityProvider = Callable[[], "dict[str, float]"]


def city_tier_factor(city: str) -> float:
    """Resolve the documented city tier factor (defaults to 0.65 for other cities)."""
    if not city:
        return DEFAULT_CITY_TIER_FACTOR
    return CITY_TIER_FACTORS.get(city.strip().lower(), DEFAULT_CITY_TIER_FACTOR)


def city_affinity_score(city: str, market_activity_index: float) -> float:
    """Pure: city_affinity = city_tier_factor(city) × market_activity_index × 100.

    market_activity_index is clamped to [0, 1]. Output 0–100. No DB — offline-testable.
    """
    idx = max(0.0, min(1.0, float(market_activity_index or 0.0)))
    return round(min(100.0, max(0.0, city_tier_factor(city) * idx * 100.0)), 2)


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
#   market_activity_index = (NCCS_A + NCCS_B) / max(A+B across cities), in [0, 1]
# — a city's affluent + upper-middle consumer base (the concert-ticket segment),
# normalized so the strongest market = 1.0. This is the NCCS source plugged into
# the same provider interface City Affinity was built around (no formula change).

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
    """Market-activity provider backed by NCCS consumer-class data.

    index = (NCCS_A + NCCS_B) / max(A+B across cities), clamped to [0, 1],
    keyed by normalized city name. Returns {} if the reference file is missing.
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
    ab = {
        _normalize_city_key(r.get("city", "")): float(r.get("nccs_a", 0) or 0) + float(r.get("nccs_b", 0) or 0)
        for r in data if r.get("city")
    }
    hi = max(ab.values()) if ab else 0.0
    _nccs_cache = {c: min(1.0, v / hi) for c, v in ab.items()} if hi > 0 else {}
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

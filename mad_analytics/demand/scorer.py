"""
demand/scorer.py
Composite 0–100 demand score for an artist in a given city on a given date.

Components
----------
- social_velocity  (40%)  — how fast the artist is growing across platforms
- ticket_velocity  (30%)  — recent sell-through rate at past concerts
- seasonality      (20%)  — month-of-year × weekend bonus
- recency          (10%)  — how recently the artist performed nearby

Input:  DemandInput
Output: DemandOutput
"""
from __future__ import annotations
import logging
from datetime import datetime, timezone, timedelta
from typing import Callable, Optional

from ..utils.schemas import DemandInput, DemandOutput
from ..utils.db import fetch_artist_snapshots
from ..utils.feature_engineering import (
    metrics_to_df,
    social_velocity,
    ticket_velocity,
    seasonality_factor,
)


# ── Component weights ─────────────────────────────────────────────────────────

WEIGHTS = {
    "social_velocity": 0.40,
    "ticket_velocity": 0.30,
    "seasonality":     0.20,
    "recency":         0.10,
}


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
) -> float:
    """Platform Size Score (0–100) for one artist given the cohort min/max.

    Pure function — no DB — so it is unit-testable offline.
    """
    total = 0.0
    for platform, weight in PLATFORM_SIZE_WEIGHTS.items():
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
    for row in artists:
        values: dict[str, float] = {}
        for platform, field in PLATFORM_SIZE_FIELD.items():
            v = float(row.get(field) or 0.0)
            values[platform] = v
            cohort_values[platform].append(v)
        per_artist[str(row["artist_id"])] = values

    cohort_min = {p: (min(vs) if vs else 0.0) for p, vs in cohort_values.items()}
    cohort_max = {p: (max(vs) if vs else 0.0) for p, vs in cohort_values.items()}

    return {
        artist_id: compute_platform_size(values, cohort_min, cohort_max)
        for artist_id, values in per_artist.items()
    }


def _recency_score(concerts, city: str, country: str) -> float:
    """
    Score based on how recently the artist played in the same city/country.
    Recent = higher novelty anticipation if > 3 months ago, else saturation risk.
    Returns 0–1.
    """
    if not concerts:
        return 0.5   # neutral — no data

    now = datetime.now(timezone.utc).date()
    nearby = [
        c for c in concerts
        if c.city.lower() == city.lower() or c.country.lower() == country.lower()
    ]
    if not nearby:
        return 0.7   # never played here → high novelty

    most_recent = max(c.date for c in nearby)
    days_since = (now - most_recent).days

    if days_since < 30:
        return 0.2   # too soon — audience fatigue risk
    if days_since < 90:
        return 0.5
    if days_since < 180:
        return 0.8
    return 0.9       # long absence → strong anticipation


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
        from sqlalchemy import create_engine, text as sql_text
        db_url = os.environ.get("DATABASE_URL")
        if not db_url:
            return {}
        normalized = db_url.replace("postgres://", "postgresql://", 1) if db_url.startswith("postgres://") else db_url
        engine = create_engine(normalized)
        with engine.connect() as conn:
            rows = conn.execute(sql_text("""
                SELECT LOWER(city) AS city, COUNT(*) AS cnt
                FROM concerts
                WHERE "concertDate" >= CURRENT_DATE - INTERVAL '12 months'
                  AND city IS NOT NULL AND city <> ''
                GROUP BY LOWER(city)
            """)).mappings().all()
        engine.dispose()
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


def city_affinity_scores(
    market_activity_provider: Optional[MarketActivityProvider] = None,
) -> dict[str, float]:
    """City Affinity (0–100) for every city that has market-activity data.

    Pass a different provider (e.g. a future NCCS-backed one) to swap the
    market-activity source without touching the formula. Returns {city_lower: score}.
    """
    provider = market_activity_provider or _concert_market_activity
    activity = provider()
    return {city: city_affinity_score(city, idx) for city, idx in activity.items()}


def city_affinity_for_city(
    city: str,
    market_activity_provider: Optional[MarketActivityProvider] = None,
) -> Optional[float]:
    """City Affinity (0–100) for a single city, or None when there is no
    market-activity data for it (so the Demand blend renormalizes it out).
    """
    provider = market_activity_provider or _concert_market_activity
    activity = provider()
    key = (city or "").strip().lower()
    if key not in activity:
        return None
    return city_affinity_score(city, activity[key])


# ── Demand Score (Formula Blueprint v2.0 — Step 4) ────────────────────────────
#
#   Demand = PlatformSize*0.35 + Momentum*0.35 + GoogleTrends*0.20 + CityAffinity*0.10
#
# All four components are 0–100. Missing components are renormalized out (present
# weights rescaled to sum to 1.0) so a missing Google-Trends or city-affinity
# signal never silently zeroes the score and no value is fabricated.

DEMAND_WEIGHTS = {
    "platform_size": 0.35,
    "momentum":      0.35,   # cross_platform_score (growth module / useMadGrowth)
    "google_trends": 0.20,
    "city_affinity": 0.10,
}


def _blend_demand(
    platform_size: Optional[float],
    momentum: Optional[float],
    google_trends: Optional[float],
    city_affinity: Optional[float],
) -> tuple[float, dict[str, float], dict[str, float]]:
    """Apply the Demand blend, renormalizing over available components.

    Pure function — no DB — so it is unit-testable offline.
    Returns (score_0_100, components_present, effective_weights).
    """
    spec = [
        ("platform_size", platform_size),
        ("momentum", momentum),
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


def _artist_momentum_from_metrics(artist_id: str, metrics) -> Optional[float]:
    """Momentum = cross_platform_score from the growth module (useMadGrowth),
    computed from the payload's platform_metrics. None if it can't be computed."""
    try:
        from ..growth.rog_calculator import calculate as growth_calculate
        from ..utils.schemas import GrowthInput
        result = growth_calculate(GrowthInput(artist_id=artist_id, metrics=metrics))
        return result.cross_platform_score
    except Exception as e:
        logger.warning(f"[Demand] Momentum calc failed for {artist_id}: {e}")
        return None


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


# ── Main entry point ───────────────────────────────────────────────────────────

def calculate(payload: DemandInput) -> DemandOutput:
    """
    Compute the composite demand score (Formula Blueprint v2.0):

        Demand = PlatformSize*0.35 + Momentum*0.35 + GoogleTrends*0.20 + CityAffinity*0.10

    Each component is 0–100. Weights are renormalized over whichever components are
    available. The returned `components` dict reports only the present components.
    """
    # Platform Size (Step 2) — needs the artist cohort, so computed over snapshots.
    platform_size = platform_size_scores().get(payload.artist_id)

    # Momentum = cross_platform_score (growth module / useMadGrowth) from payload metrics.
    momentum = _artist_momentum_from_metrics(payload.artist_id, payload.platform_metrics)

    # Google Trends — explicit input > stored DB score > unavailable.
    google_trends = payload.google_trends_score
    if google_trends is None:
        google_trends = _google_trends_for_artist(payload.artist_id)

    # City Affinity (Step 3) for the target city — None if no market-activity data.
    city_affinity = city_affinity_for_city(payload.city)

    score, components, _effective = _blend_demand(
        platform_size, momentum, google_trends, city_affinity
    )

    return DemandOutput(
        artist_id=payload.artist_id,
        city=payload.city,
        score=score,
        components=components,
        computed_at=datetime.now(timezone.utc).isoformat(),
    )

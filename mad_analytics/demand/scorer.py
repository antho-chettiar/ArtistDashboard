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
from datetime import datetime, timezone, timedelta

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
    artists = fetch_artist_snapshots()
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


# ── Main entry point ───────────────────────────────────────────────────────────

def calculate(payload: DemandInput) -> DemandOutput:
    """
    Compute the composite demand score.

    Each component returns a 0–1 float.
    Final score = weighted sum × 100, clamped to [0, 100].
    """
    df = metrics_to_df(payload.platform_metrics)

    sv = social_velocity(df, days=14)
    tv = ticket_velocity(payload.recent_concerts, days_back=90)
    sf = seasonality_factor(payload.target_date, payload.city)
    rv = _recency_score(payload.recent_concerts, payload.city, payload.country)

    components = {
        "social_velocity": round(sv, 4),
        "ticket_velocity": round(tv, 4),
        "seasonality":     round(sf, 4),
        "recency":         round(rv, 4),
    }

    raw_score = sum(WEIGHTS[k] * v for k, v in components.items())
    score = round(min(100.0, max(0.0, raw_score * 100)), 2)

    return DemandOutput(
        artist_id=payload.artist_id,
        city=payload.city,
        score=score,
        components=components,
        computed_at=datetime.now(timezone.utc).isoformat(),
    )

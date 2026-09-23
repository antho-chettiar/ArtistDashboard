"""
audience_city/scorer.py
Real, city-resolved DIGITAL audience presence -- from Viberate's "Audience by
City" table (backend/src/services/scrapers/viberate/audienceCity.ts), not from
concerts. Kept as its own module rather than folded into touring_history/
(deliberately NOT a digital-footprint proxy for touring precedent, per that
module's docstring) or engagement/ (a different concern -- ratios, not raw
per-city shares): this is a THIRD kind of signal, checked and wired in 2026-09
specifically to cover Touring Precedent's blind spot -- see
feasibility/topsis.py's module docstring for the exact blend rule (it boosts,
never replaces, the real visit-count signal).

COVERAGE IS ARTIST-DEPENDENT AND OBSERVED TO FLUCTUATE OVER TIME (checked
2026-09-23): re-running the collector on the same artist hours apart showed
different availability (e.g. Shreya Ghoshal read as unavailable on a later
pass after reading as available on an earlier one) -- this looks like it
reflects Viberate's own data-refresh state, not a stable per-artist partition.
Per the project-wide no-fabrication rule, this module reports exactly what's
in viberate_metrics_daily as of the last successful collector run for that
artist -- an artist with zero rows reads as `available=False`, never a
fabricated 0% share.

Metric names (must stay in sync with audienceCity.ts's METRIC_* constants):
  audience_city_monthly_listeners_pct -- % of Spotify monthly listeners in this city
  audience_city_monthly_views         -- absolute YouTube monthly views from this city
  audience_city_total_followers_pct   -- % of Instagram followers in this city
Any of the three may be individually absent (Viberate itself shows "N/A" for
some columns even when the table exists at all) -- never fabricated as 0.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import text

from ..utils.db import get_engine
from ..utils.schemas import CityAudiencePresenceOutput
from ..demand.scorer import _normalize_city_key

METRIC_MONTHLY_LISTENERS_PCT = 'audience_city_monthly_listeners_pct'
METRIC_MONTHLY_VIEWS = 'audience_city_monthly_views'
METRIC_TOTAL_FOLLOWERS_PCT = 'audience_city_total_followers_pct'


def _latest_raw_city_metrics(
    artist_id: str,
    db_url: Optional[str] = None,
) -> dict[tuple[str, str], float]:
    """{(raw_city, metricName): latest non-null totalValue}. "Latest" (not
    "today's") on purpose -- this collector runs periodically, not daily (see
    audienceCity.ts), so a query scoped to today would go empty between runs
    even though the last real reading is still the best available truth."""
    engine = get_engine(db_url)
    try:
        with engine.connect() as conn:
            rows = conn.execute(
                text(
                    'SELECT city, "metricName", "totalValue" FROM viberate_metrics_daily '
                    'WHERE "artistId" = :aid AND city IS NOT NULL ORDER BY date DESC'
                ),
                {"aid": artist_id},
            ).mappings().all()
    finally:
        if db_url is not None:
            engine.dispose()

    latest: dict[tuple[str, str], float] = {}
    for r in rows:
        key = (r["city"], r["metricName"])
        if key in latest or r["totalValue"] is None:
            continue
        latest[key] = float(r["totalValue"])
    return latest


def city_audience_index(
    artist_id: str,
    db_url: Optional[str] = None,
) -> dict[str, dict[str, float]]:
    """This artist's audience_city_* metrics, keyed by _normalize_city_key so
    it can be looked up exactly like every other per-city signal in this
    codebase (city_affinity_scores, visit_counts_by_city) -- the shared
    building block feasibility/topsis.py needs for every candidate city in one
    query, same reasoning as touring_history.visit_counts_by_city.

    Raw Viberate city rows that collapse to the same normalized key (e.g.
    "Delhi" and "New Delhi" both -> "delhi", seen for several artists on this
    roster) are SUMMED, not overwritten -- Viberate appears to geo-tag the
    same metro area under both spellings as separate rows, and since this
    platform treats them as one city everywhere else (concerts, city
    affinity), splitting an artist's real Delhi-NCR audience across two keys
    would understate it under either alias alone."""
    latest = _latest_raw_city_metrics(artist_id, db_url=db_url)
    index: dict[str, dict[str, float]] = {}
    for (raw_city, metric_name), value in latest.items():
        key = _normalize_city_key(raw_city)
        bucket = index.setdefault(key, {})
        bucket[metric_name] = bucket.get(metric_name, 0.0) + value
    return index


def city_audience_presence(
    artist_id: str,
    city: str,
    db_url: Optional[str] = None,
) -> CityAudiencePresenceOutput:
    """Single artist+city read. `available=False` (every figure None) is the
    honest, structured signal for "not offered by the source for this artist
    right now" -- never a fabricated 0% share standing in for missing data."""
    index = city_audience_index(artist_id, db_url=db_url)
    metrics = index.get(_normalize_city_key(city), {})
    listeners_pct = metrics.get(METRIC_MONTHLY_LISTENERS_PCT)
    views = metrics.get(METRIC_MONTHLY_VIEWS)
    followers_pct = metrics.get(METRIC_TOTAL_FOLLOWERS_PCT)

    return CityAudiencePresenceOutput(
        artist_id=artist_id,
        city=city,
        monthly_listeners_pct=listeners_pct,
        monthly_views=views,
        total_followers_pct=followers_pct,
        available=any(v is not None for v in (listeners_pct, views, followers_pct)),
        computed_at=datetime.now(timezone.utc).isoformat(),
    )

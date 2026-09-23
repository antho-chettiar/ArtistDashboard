"""
touring_history/scorer.py
Real touring precedent, computed straight from the `concerts` table --
deliberately NOT another Popularity/Demand-style formula estimate.

Background: Diljit Dosanjh was added to this roster specifically to check
whether Popularity/Demand track real commercial draw or just digital
footprint (2026-09 calibration incident). The result: they can't, because
neither has any real concert data in them at all -- reweighting their
follower/streaming/search-trend inputs can never substitute for an artist's
actual booking history. This module is the fix: a ground-truth "has this
artist actually played this city, and how does their touring pattern look"
signal, meant to sit ABOVE the language-affinity / city-affinity heuristics
in the feasibility hierarchy agreed for this platform:
  1. Real touring history for this artist+city -> use it directly
  2. No history yet, high Popularity/broad reach -> soften other assumptions
  3. No history, niche/regional artist -> fall back to the heuristics

Two functions:
  touring_precedent(artist_id, city) -- has this artist played this specific
    city before, when, and where. This is the Tier-1 override signal above.
  repeat_visit_rate(artist_id) -- of all the cities this artist has ever
    played, what fraction did they return to more than once. A consistency/
    precedent signal about the ARTIST, not about any one city.

Deliberately NOT built: a cross-artist ranking by raw concert count. An
artist doing 30 small club shows would wrongly outrank one doing 3 sold-out
stadiums on volume alone -- these functions only ever answer questions about
one artist's own history, never compare artists' totals against each other.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import text

from ..utils.db import get_engine
from ..utils.schemas import (
    DashboardHighlightsOutput, RepeatVisitRateOutput, TouringHighlight,
    TouringHistoryOutput, TouringVisit,
)
from ..demand.scorer import _normalize_city_key


def touring_precedent(
    artist_id: str,
    city: str,
    db_url: Optional[str] = None,
) -> TouringHistoryOutput:
    """Real, logged concert history for this artist in this specific city.

    City matching uses the same alias table as City Affinity (Bangalore ==
    Bengaluru, etc.) so a real visit isn't missed over a spelling variant.
    """
    engine = get_engine(db_url)
    try:
        with engine.connect() as conn:
            rows = conn.execute(
                text('SELECT "concertDate", city, "venueName" FROM concerts WHERE "artistId" = :aid'),
                {"aid": artist_id},
            ).mappings().all()
    finally:
        if db_url is not None:
            engine.dispose()

    target_key = _normalize_city_key(city)
    visits = [
        TouringVisit(date=str(r["concertDate"]), venue=r["venueName"])
        for r in rows
        if _normalize_city_key(r["city"] or "") == target_key and r["concertDate"]
    ]
    visits.sort(key=lambda v: v.date)

    return TouringHistoryOutput(
        artist_id=artist_id,
        city=city,
        visit_count=len(visits),
        visits=visits,
        first_visit=visits[0].date if visits else None,
        last_visit=visits[-1].date if visits else None,
        has_precedent=len(visits) > 0,
        computed_at=datetime.now(timezone.utc).isoformat(),
    )


def visit_counts_by_city(
    artist_id: str,
    db_url: Optional[str] = None,
) -> dict[str, int]:
    """This artist's logged concert count per normalized city, in ONE query --
    the shared building block for repeat_visit_rate() below and for the
    feasibility/TOPSIS Touring Precedent criterion (which needs this same
    breakdown for every candidate city and must not re-fetch the artist's
    full history once per city, see feasibility/topsis.py)."""
    engine = get_engine(db_url)
    try:
        with engine.connect() as conn:
            rows = conn.execute(
                text('SELECT city FROM concerts WHERE "artistId" = :aid AND city IS NOT NULL'),
                {"aid": artist_id},
            ).mappings().all()
    finally:
        if db_url is not None:
            engine.dispose()

    counts: dict[str, int] = {}
    for r in rows:
        key = _normalize_city_key(r["city"] or "")
        if not key:
            continue
        counts[key] = counts.get(key, 0) + 1
    return counts


def repeat_visit_rate(
    artist_id: str,
    db_url: Optional[str] = None,
) -> RepeatVisitRateOutput:
    """Of every city this artist has ever performed in, what fraction did
    they play more than once. 0.0 if they have zero logged concerts (not
    fabricated as "average" or renormalized against anything) -- an artist
    with no history should read as exactly that, not as a plausible middle
    score."""
    counts = visit_counts_by_city(artist_id, db_url=db_url)
    distinct_cities = len(counts)
    repeat_cities = sum(1 for c in counts.values() if c > 1)
    rate = (repeat_cities / distinct_cities) if distinct_cities > 0 else 0.0

    return RepeatVisitRateOutput(
        artist_id=artist_id,
        distinct_cities=distinct_cities,
        repeat_cities=repeat_cities,
        repeat_rate=round(rate, 4),
        computed_at=datetime.now(timezone.utc).isoformat(),
    )


# ── Dashboard Highlights (reminder, not forecast -- 2026-09) ────────────────
#
# WHY THIS EXISTS: replaces the retired Tickets Sold YTD / Revenue YTD
# homepage KPIs (removed because real ticket/revenue coverage was too sparse
# to headline honestly) with something built on data this roster actually
# has in full: real concert dates. Deliberately NOT a scored prediction --
# see the module docstring's Tier-1 principle and the explicit 2026-09
# decision with Anthony to surface "it's been this long since X played Y" as
# a plain fact for a human to act on, not a fabricated "likely to sell out"
# style number. One query, no formula, no live Popularity/TOPSIS call.
DEFAULT_REVISIT_THRESHOLD_DAYS = 545  # ~18 months -- a reasonable touring-cycle gap, not derived from data


def dashboard_highlights(
    revisit_threshold_days: int = DEFAULT_REVISIT_THRESHOLD_DAYS,
    db_url: Optional[str] = None,
) -> DashboardHighlightsOutput:
    """spotlight: the single most-repeated real artist+city pair roster-wide
    (the strongest real touring-precedent story to headline). revisit_reminders:
    every artist+city pair whose last visit is more than revisit_threshold_days
    ago, longest-overdue first, capped at 5."""
    engine = get_engine(db_url)
    try:
        with engine.connect() as conn:
            rows = conn.execute(
                text(
                    'SELECT a."artistName", c."artistId", c.city, c."concertDate" '
                    'FROM concerts c JOIN artists a ON a.id = c."artistId" '
                    'WHERE c.city IS NOT NULL AND c."concertDate" IS NOT NULL '
                    'AND c."concertDate" <= CURRENT_DATE'
                )
            ).mappings().all()
    finally:
        if db_url is not None:
            engine.dispose()

    groups: dict[tuple[str, str, str], list] = {}
    for r in rows:
        city_key = _normalize_city_key(r["city"] or "")
        if not city_key:
            continue
        key = (r["artistId"], r["artistName"], city_key)
        groups.setdefault(key, []).append(r["concertDate"])

    today = datetime.now(timezone.utc).date()
    pairs: list[TouringHighlight] = []
    for (artist_id, artist_name, city_key), dates in groups.items():
        dates.sort()
        last_visit = dates[-1]
        pairs.append(TouringHighlight(
            artist_id=artist_id,
            artist_name=artist_name,
            city=city_key,
            visit_count=len(dates),
            last_visit=last_visit.isoformat(),
            days_since_last_visit=(today - last_visit).days,
        ))

    spotlight = max(pairs, key=lambda p: p.visit_count) if pairs else None
    revisit_reminders = sorted(
        (p for p in pairs if p.days_since_last_visit > revisit_threshold_days),
        key=lambda p: -p.days_since_last_visit,
    )[:5]

    # Roster-wide (not per-artist): every distinct city ANY artist has played,
    # and how many of those cities have seen a repeat visit from the SAME
    # artist -- a real, always-computable signal, unlike ticket/revenue data
    # which this platform genuinely doesn't have.
    cities_played: dict[str, int] = {}
    for (_artist_id, _artist_name, city_key), dates in groups.items():
        cities_played[city_key] = max(cities_played.get(city_key, 0), len(dates))
    distinct_cities_played = len(cities_played)
    cities_with_repeat_visit = sum(1 for count in cities_played.values() if count > 1)

    return DashboardHighlightsOutput(
        spotlight=spotlight,
        revisit_reminders=revisit_reminders,
        distinct_cities_played=distinct_cities_played,
        cities_with_repeat_visit=cities_with_repeat_visit,
        computed_at=datetime.now(timezone.utc).isoformat(),
    )

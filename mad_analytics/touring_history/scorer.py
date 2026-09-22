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
from ..utils.schemas import RepeatVisitRateOutput, TouringHistoryOutput, TouringVisit
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

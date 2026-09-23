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
    TouringHistoryOutput, TouringInsight, TouringVisit,
)
from ..demand.scorer import _normalize_city_key
from ..audience_city.scorer import city_audience_presence


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


def _as_date(value):
    """Postgres (production) returns a real `date` for a DATE column;
    SQLite (this file's own test fixtures) returns plain text -- normalize
    once here rather than assume the caller's DB backend."""
    if isinstance(value, str):
        return datetime.fromisoformat(value[:10]).date()
    if hasattr(value, "hour"):  # a datetime, not a plain date -- narrow it
        return value.date()
    return value


def _biggest_verified_show(rows) -> Optional[TouringInsight]:
    """The single largest-capacity real show in the roster -- a concrete,
    unambiguous "how big does this roster actually play" fact. Requires both
    a real venue name and a positive capacity on the same row (no fallback,
    no estimate substituted just to always have an answer)."""
    candidates = [r for r in rows if r["venueName"] and (r["capacity"] or 0) > 0]
    if not candidates:
        return None
    best = max(candidates, key=lambda r: r["capacity"])
    return TouringInsight(
        insight_type="biggest_show",
        headline=f'The biggest verified show in this roster: {best["artistName"]} at {best["venueName"]}, {best["city"].title()}',
        detail=f'{int(best["capacity"]):,} capacity, played {_as_date(best["concertDate"]).strftime("%d %b %Y")}',
    )


def dashboard_highlights(
    revisit_threshold_days: int = DEFAULT_REVISIT_THRESHOLD_DAYS,
    db_url: Optional[str] = None,
) -> DashboardHighlightsOutput:
    """highlights: up to 5 distinct, real, plain-fact insights about the
    roster's actual touring history (most-repeated pair, longest-running
    relationship, widest reach, biggest verified show, most consistent
    touring pattern) -- each independently true, none a scored prediction.

    revisit_reminders: artist+city pairs overdue by more than
    revisit_threshold_days, cross-checked against audience_city's real
    per-city digital-demand data where available. A long gap alone is NOT
    evidence of an overlooked opportunity -- an artist can just as easily have
    stopped drawing real interest in a city as have been merely overlooked.
    Pairs with a corroborating digital-demand signal are surfaced first (an
    actual reason to believe it's an oversight); the rest still show, but
    without a demand_signal_pct their card reads as an open question, not a
    confirmed opportunity. Widen the elapsed-time candidate pool before this
    re-rank, or a corroborated-but-shorter-gap pair could never out-rank a
    much longer, uncorroborated one."""
    engine = get_engine(db_url)
    try:
        with engine.connect() as conn:
            rows = conn.execute(
                text(
                    'SELECT a."artistName", c."artistId", c.city, c."concertDate", '
                    'c."venueName", c.capacity '
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
        groups.setdefault(key, []).append(_as_date(r["concertDate"]))

    today = datetime.now(timezone.utc).date()
    pairs: list[TouringHighlight] = []
    first_visits: dict[tuple[str, str, str], "date"] = {}
    for (artist_id, artist_name, city_key), dates in groups.items():
        dates.sort()
        first_visits[(artist_id, artist_name, city_key)] = dates[0]
        last_visit = dates[-1]
        pairs.append(TouringHighlight(
            artist_id=artist_id,
            artist_name=artist_name,
            city=city_key,
            visit_count=len(dates),
            last_visit=last_visit.isoformat(),
            days_since_last_visit=(today - last_visit).days,
        ))

    # ── 1. Most-repeated pair ──
    highlights: list[TouringInsight] = []
    most_repeated = max(pairs, key=lambda p: p.visit_count) if pairs else None
    if most_repeated:
        highlights.append(TouringInsight(
            insight_type="most_repeated",
            headline=f'{most_repeated.artist_name} has played {most_repeated.city.title()} {most_repeated.visit_count} times — the most of any pairing in the roster',
            detail=f'Last visit {datetime.fromisoformat(most_repeated.last_visit).strftime("%d %b %Y")}',
        ))

    # ── 2. Longest-running relationship (span, not just count) ──
    repeat_pairs = [p for p in pairs if p.visit_count > 1]
    if repeat_pairs:
        longest = max(
            repeat_pairs,
            key=lambda p: (datetime.fromisoformat(p.last_visit).date()
                           - first_visits[(p.artist_id, p.artist_name, p.city)]).days,
        )
        first = first_visits[(longest.artist_id, longest.artist_name, longest.city)]
        last = datetime.fromisoformat(longest.last_visit).date()
        years = round((last - first).days / 365.25, 1)
        highlights.append(TouringInsight(
            insight_type="longest_relationship",
            headline=f'{longest.artist_name} has been touring {longest.city.title()} for {years} years',
            detail=f'First played {first.strftime("%d %b %Y")}, most recently {last.strftime("%d %b %Y")} — {longest.visit_count} visits total',
        ))

    # ── 3. Widest reach (most distinct cities, one artist) ──
    artist_cities: dict[str, set[str]] = {}
    artist_names: dict[str, str] = {}
    for (artist_id, artist_name, city_key) in groups:
        artist_names[artist_id] = artist_name
        artist_cities.setdefault(artist_id, set()).add(city_key)
    if artist_cities:
        widest_id = max(artist_cities, key=lambda a: len(artist_cities[a]))
        widest_count = len(artist_cities[widest_id])
        if widest_count > 1:
            highlights.append(TouringInsight(
                insight_type="widest_reach",
                headline=f'{artist_names[widest_id]} has performed in {widest_count} different cities — the widest reach in the roster',
                detail="No other tracked artist has toured that many distinct cities",
            ))

    # ── 4. Biggest verified show ──
    biggest_show = _biggest_verified_show(rows)
    if biggest_show:
        highlights.append(biggest_show)

    # ── 5. Most consistent touring artist (repeat-rate, min 3 cities so a
    # 1-for-1 artist can't show a hollow 100%) ──
    best_consistency = None
    for artist_id, cities in artist_cities.items():
        counts = {c: 0 for c in cities}
        for (aid, _name, city_key), dates in groups.items():
            if aid == artist_id:
                counts[city_key] = len(dates)
        distinct = len(counts)
        if distinct < 3:
            continue
        repeat = sum(1 for c in counts.values() if c > 1)
        rate = repeat / distinct
        if best_consistency is None or rate > best_consistency[1]:
            best_consistency = (artist_id, rate, repeat, distinct)
    if best_consistency:
        artist_id, rate, repeat, distinct = best_consistency
        highlights.append(TouringInsight(
            insight_type="most_consistent",
            headline=f'{artist_names[artist_id]} returns to {round(rate * 100)}% of the cities they\'ve ever played',
            detail=f'{repeat} of {distinct} cities visited more than once — the most consistent touring pattern in the roster',
        ))

    # ── Revisit reminders, corroborated against real digital-demand data ──
    overdue = sorted(
        (p for p in pairs if p.days_since_last_visit > revisit_threshold_days),
        key=lambda p: -p.days_since_last_visit,
    )[:15]  # widen the pool before re-ranking by corroboration, see docstring
    for p in overdue:
        presence = city_audience_presence(p.artist_id, p.city, db_url=db_url)
        if presence.available and presence.monthly_listeners_pct is not None:
            p.demand_signal_pct = presence.monthly_listeners_pct
    revisit_reminders = sorted(
        overdue,
        key=lambda p: (p.demand_signal_pct is None, -(p.demand_signal_pct or 0), -p.days_since_last_visit),
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
        highlights=highlights,
        revisit_reminders=revisit_reminders,
        distinct_cities_played=distinct_cities_played,
        cities_with_repeat_visit=cities_with_repeat_visit,
        computed_at=datetime.now(timezone.utc).isoformat(),
    )

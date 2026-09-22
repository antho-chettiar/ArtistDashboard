"""
feasibility/topsis.py
Phase C: "Is this artist feasible for this city" -- the final piece of the
phased roadmap agreed with Anthony after the 2026-09 Diljit Dosanjh
calibration incident (see touring_history/scorer.py's docstring for the full
background).

WHY TOPSIS, AND WHY RELATIVE TO OTHER CITIES: the business question is
inherently comparative -- "feasible" only means something next to the
alternatives an artist could tour instead. TOPSIS (Technique for Order
Preference by Similarity to Ideal Solution) ranks a set of alternatives (here,
candidate cities for ONE artist) by how close each one is to a hypothetical
best-of-all-criteria city and how far from a worst-of-all-criteria city. The
candidate-city universe is the same NCCS-covered set already trusted for City
Affinity (demand.scorer.city_affinity_scores) -- real Indian-market reference
data, not an invented list.

CRITERIA (all benefit criteria -- higher raw value is always better, so no
cost-criteria inversion is needed):
  1. Artist Power (Popularity, 0-100) -- constant across every city for a
     single artist query. Included for fidelity to the agreed criteria set,
     but a constant column contributes EXACTLY ZERO to TOPSIS's relative
     ranking (ideal-best == ideal-worst == that same constant, so the
     distance contribution is 0 for every row) -- see _topsis()'s docstring.
     It only starts to matter if this module is ever extended to also rank
     multiple ARTISTS against one fixed city, which is not built here.
  2. City Affinity (0-100) -- the existing NCCS-backed market-activity signal.
  3. Touring Precedent (raw visit count) -- Tier 1 from the feasibility
     hierarchy (see revenue/predictor.py): real past visits are the strongest
     ground-truth signal this product has, so this gets the heaviest weight.
  4. Venue Fit (0-100) -- this city's average KNOWN concert venue capacity
     (any artist, not just this one), normalized against the strongest city.
     This is a market-size proxy ("can this city's venues support a large
     show at all"), NOT this specific artist's fit to one exact venue --
     there is no locked venue for a hypothetical future show, and venue-name
     coverage is still incomplete (91 of 233 concerts as of 2026-09, see the
     venue-capacity backfill work) so this criterion is honestly bounded by
     whatever capacity data actually exists, never fabricated.

WEIGHTS are an explicitly labeled calibration assumption (same convention as
revenue/predictor.py's AFFORDABLE_REFERENCE_PRICE_INR) -- not derived from
real ticket-sales data, because none exists yet. Revisit once real concerts
accumulate.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from ..utils.schemas import FeasibilityInput, FeasibilityOutput, FeasibilityCriteria

ARTIST_POWER_WEIGHT = 0.10
CITY_AFFINITY_WEIGHT = 0.30
TOURING_PRECEDENT_WEIGHT = 0.40
VENUE_FIT_WEIGHT = 0.20


def _topsis(matrix: list[list[float]], weights: list[float]) -> list[float]:
    """Standard TOPSIS closeness coefficient. Pure -- no DB, offline-testable.

    All criteria here are benefit criteria (higher raw value = better), so
    ideal-best is always the column max and ideal-worst the column min --
    no cost-criteria inversion needed.

    Returns one score per row, each in [0, 1] (1 = closest to the ideal
    across all rows). A single-row matrix returns [0.5] -- nothing to rank
    against, so neither best nor worst. A zero-variance column (every row
    has the same raw value, e.g. Artist Power in a single-artist query)
    contributes 0 to every row's distance from both ideals, by construction
    -- it never breaks or biases the ranking, just doesn't move it.
    """
    n_rows = len(matrix)
    if n_rows == 0:
        return []
    if n_rows == 1:
        return [0.5]

    n_cols = len(weights)
    col_norms = [
        sum(row[j] ** 2 for row in matrix) ** 0.5
        for j in range(n_cols)
    ]
    normalized = [
        [(row[j] / col_norms[j]) if col_norms[j] > 0 else 0.0 for j in range(n_cols)]
        for row in matrix
    ]
    weighted = [[normalized[i][j] * weights[j] for j in range(n_cols)] for i in range(n_rows)]

    ideal_best = [max(weighted[i][j] for i in range(n_rows)) for j in range(n_cols)]
    ideal_worst = [min(weighted[i][j] for i in range(n_rows)) for j in range(n_cols)]

    dist_best = [
        sum((weighted[i][j] - ideal_best[j]) ** 2 for j in range(n_cols)) ** 0.5
        for i in range(n_rows)
    ]
    dist_worst = [
        sum((weighted[i][j] - ideal_worst[j]) ** 2 for j in range(n_cols)) ** 0.5
        for i in range(n_rows)
    ]

    scores = []
    for i in range(n_rows):
        denom = dist_best[i] + dist_worst[i]
        scores.append(dist_worst[i] / denom if denom > 0 else 0.5)
    return scores


def _city_venue_capacity_index(db_url: Optional[str] = None) -> dict[str, float]:
    """Venue Fit criterion, market-size proxy -- see the module docstring's
    WHY. {normalized_city: 0-100}, strongest city = 100. Cities with no
    concert on record that has a resolved capacity are simply absent (never
    zero-filled -- TOPSIS treats an absent column value as "no data", the
    caller decides the neutral default, see calculate() below)."""
    from sqlalchemy import text
    from ..utils.db import get_engine
    from ..demand.scorer import _normalize_city_key

    engine = get_engine(db_url)
    try:
        with engine.connect() as conn:
            rows = conn.execute(text(
                'SELECT city, capacity FROM concerts '
                'WHERE capacity IS NOT NULL AND capacity > 0 '
                'AND city IS NOT NULL AND city != \'\''
            )).mappings().all()
    finally:
        if db_url is not None:
            engine.dispose()

    totals: dict[str, list[float]] = {}
    for r in rows:
        key = _normalize_city_key(r["city"] or "")
        if not key:
            continue
        totals.setdefault(key, []).append(float(r["capacity"]))

    if not totals:
        return {}
    averaged = {k: sum(v) / len(v) for k, v in totals.items()}
    hi = max(averaged.values())
    return {k: (v / hi) * 100.0 for k, v in averaged.items()} if hi > 0 else {}


def calculate(payload: FeasibilityInput, db_url: Optional[str] = None) -> FeasibilityOutput:
    """Rank payload.city's feasibility for payload.artist_id against every
    other NCCS-covered city, for this same artist. db_url=None (the live
    request path) shares the pooled engine, matching the get_engine(db_url)
    convention used throughout touring_history/venue_capacity."""
    from ..demand.scorer import city_affinity_scores, _normalize_city_key
    from ..touring_history import visit_counts_by_city
    from ..popularity.calculator import calculate as popularity_calculate
    from ..utils.schemas import PopularityInput

    affinity = city_affinity_scores()
    target_key = _normalize_city_key(payload.city)

    candidate_affinity = dict(affinity)
    if target_key not in candidate_affinity:
        # Never silently drop the city the caller actually asked about --
        # no market-activity data for it is a real, honest 0.0, not a reason
        # to exclude it from the comparison.
        candidate_affinity[target_key] = 0.0

    visit_counts = visit_counts_by_city(payload.artist_id, db_url=db_url)
    venue_index = _city_venue_capacity_index(db_url=db_url)
    popularity_score = popularity_calculate(
        PopularityInput(artist_id=payload.artist_id)
    ).popularity_score

    city_keys = list(candidate_affinity.keys())
    matrix = [
        [
            popularity_score,
            candidate_affinity[city_key],
            float(visit_counts.get(city_key, 0)),
            venue_index.get(city_key, 0.0),
        ]
        for city_key in city_keys
    ]
    weights = [ARTIST_POWER_WEIGHT, CITY_AFFINITY_WEIGHT, TOURING_PRECEDENT_WEIGHT, VENUE_FIT_WEIGHT]
    scores = _topsis(matrix, weights)

    ranked = sorted(zip(city_keys, scores), key=lambda pair: -pair[1])
    rank = next(i for i, (c, _) in enumerate(ranked, start=1) if c == target_key)
    target_index = city_keys.index(target_key)

    return FeasibilityOutput(
        artist_id=payload.artist_id,
        city=payload.city,
        score=round(scores[target_index], 4),
        rank=rank,
        total_cities_compared=len(city_keys),
        components=FeasibilityCriteria(
            artist_power=popularity_score,
            city_affinity=candidate_affinity[target_key],
            touring_precedent_visits=visit_counts.get(target_key, 0),
            venue_fit_index=venue_index.get(target_key, 0.0),
        ),
        computed_at=datetime.now(timezone.utc).isoformat(),
    )

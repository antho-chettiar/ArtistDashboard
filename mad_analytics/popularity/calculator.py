"""
Popularity model — Formula Blueprint v2.3 (Reach / Revealed-Demand redesign, 2026-09-29):

    Popularity = Reach * 0.40 + GoogleTrends * 0.20 + RevealedDemand * 0.40
  (weights renormalized over whichever components are actually available)

  - Reach (40%): platform follower/listener counts (Spotify, YouTube,
    Instagram, Facebook), each scaled against a FIXED external anchor (NOT
    the current roster's own biggest artist) and weighted by platform using
    the CRITIC method (see PLATFORM_WEIGHTS below).
  - Google Trends (20%): real-time public search interest. None (never a
    fabricated 0) when unavailable for this artist -- renormalizes onto the
    other two components. Search interest is a supporting signal, not a
    guarantee of ticket sales (see "Known limitation" below), which is why
    it stays a minority weight even when the data pipeline is fixed.
  - Revealed Demand (40%): recency-weighted peak REAL, VERIFIED venue
    capacity from this artist's own logged concert history (see
    REVEALED_DEMAND_ANCHOR / REVEALED_DEMAND_HALF_LIFE_YEARS below). None
    (never fabricated) when this artist has no verified show at all --
    renormalizes onto the other two rather than treating a data/import gap
    as evidence of low demand.

INCIDENT that prompted this redesign (2026-09-29): the prior formula
(Base*0.80 + Trends*0.20, Base computed via cohort-relative max-normalization
and entropy weights with a Spotify>=45%/Instagram>=25% floor) produced a
real, publicly indefensible result live in production: Armaan Malik ranked
#1 in the roster, ahead of Shreya Ghoshal, Diljit Dosanjh, and Arijit Singh
-- artists any follower of Indian music would immediately know are bigger.
Root cause, diagnosed against this app's own real data, not theory:
  1. log1p + cohort-relative max-normalization compresses every "big enough"
     artist toward the same ~90-100 band (verified: the 4 most-followed
     artists in the roster landed within a 4-point Base-score spread),
     leaving the ranking to be decided by near-noise rather than real
     differences in fame. No amount of reweighting fixes this -- it's the
     normalization method itself that destroys the ranking's discriminating
     power among top-tier artists.
  2. The Spotify/Instagram weight floors were asserted, never empirically
     validated. Checked against this roster's own real, verified touring
     history (see RevealedDemand below): Instagram tracks real ticket-
     selling success far better than Spotify does in this roster -- the
     opposite of what the floors assumed.
  3. Armaan Malik's own real evidence: his one verified large-venue booking
     (55,000 capacity) is from 2017; Shreya/Arijit/Diljit all have verified
     large-venue bookings within the last 1-3 years. A follower-count-only
     formula has no way to see this; RevealedDemand does, via its recency
     weighting.

METHODOLOGY behind PLATFORM_WEIGHTS: cross-referenced every artist's real
logged concerts against this app's own curated/verified venue-capacity list
(mad_analytics/venue_capacity/known_venues.py -- the same strict bar already
used for the Venue Capacity stat; deliberately NOT the looser "capacity
column is non-null" bar touring_history/scorer.py's _biggest_verified_show
uses for its own, separate purpose -- that column also holds un-curated
heuristic-estimated placeholder values, see Analysis.jsx's
KNOWN_CAPACITY_PLACEHOLDER fix from this same day), built a recency-weighted
"real peak demand" per artist (N=8 usable artists after excluding actor-
first artists whose Instagram/real-venue draw is plausibly film-fame-driven,
not music-fame-driven), then applied the CRITIC method (Diakoulaki, Mavrotas
& Papayannakis, 1995 -- an established multi-criteria weighting technique
that, unlike a raw correlation-to-outcome, penalizes redundancy between
correlated indicators instead of rewarding it). Cross-checked with PCA (the
4 platforms load ~63% onto one shared "general fame" factor -- they are not
4 independent signals), a joint ridge regression, and a bootstrap confidence
interval. The one finding robust across every method: Instagram outweighs
Spotify for this roster. The exact Spotify/YouTube/Facebook split is NOT
reliably resolvable from N=8 and should be recomputed as more verified
concert data accumulates -- PLATFORM_WEIGHTS is a V1 snapshot, not a
permanent constant.

Known limitation, stated honestly rather than buried in a weight: Google
Trends' correlation with real verified touring success in this roster is
positive but moderate (r=+0.45) and weaker/less reliable than Instagram's
(r=+0.74) -- e.g. SONU NIGAM has meaningful Trends presence but the LOWEST
real verified touring success in the roster; Vishal Mishra has almost no
Trends presence but strong real touring success. High search interest does
not reliably translate into ticket sales for this roster; real touring
history does more reliably, which is why RevealedDemand outweighs Trends
2-to-1 in the blend above.

Momentum (cross_platform_score from the growth/RoG module) remains dropped
as an input by prior product decision -- see
mad_analytics/legacy/growth_calculator.py.

The Reach platform weights are further tilted per-artist by a curated
genre-style tag (Phase 3, Day 6 -- see feature_engineering.ARTIST_GENRE_STYLE),
unchanged by this redesign: a regional/folk artist's real fanbase shows up
more on YouTube than Spotify, so treating every artist under the same
weights under- or over-counts them.

INCIDENT, part 2 (same day, caught in live verification right after this
redesign shipped): Armaan Malik was STILL outranking Arijit Singh, Shreya
Ghoshal and Diljit Dosanjh in production, despite the fix above -- Reach and
RevealedDemand alone correctly ranked all three above him. The live Google
Trends fetch had handed Armaan Malik a 100 and Arijit Singh a 0 in the same
run, a 20-point swing on a 20%-weighted component large enough to flip the
ranking on its own. Root cause: this component was assumed unused/dead by
the redesign above and left untouched -- it wasn't dead, and it batch-
normalizes every artist so THIS RUN's single highest-interest artist = 100,
the exact same cohort-dependence Reach and RevealedDemand were redesigned to
remove. Fixed by making Trends cohort-independent too (see
_fetch_google_trends_scores and trends/google_trends.py's
fetch_trends_scores_stable) -- each artist is now scored only against their
own 12-month history, so no other artist's data, spike, or absence from the
roster can move their score.
"""
from __future__ import annotations
from datetime import datetime, timezone, date as date_cls
import logging
from typing import Optional

import numpy as np
import pandas as pd

from ..utils.db import fetch_artist_snapshots, get_engine
from ..utils.schemas import PopularityInput, PopularityOutput
from ..utils.feature_engineering import (
    platform_series, genre_style_for_artist_name, apply_genre_tilt,
)

logger = logging.getLogger(__name__)

# ── Weight Configuration ───────────────────────────────────────────────────────
# Formula Blueprint v2.3 -- see module docstring for the incident and
# methodology behind these numbers. Weights are renormalized over whichever
# components are actually available for a given artist (see _blend_popularity).
WEIGHT_REACH = 0.40             # Platform follower/listener counts
WEIGHT_GOOGLE_TRENDS = 0.20     # Google Trends search interest
WEIGHT_REVEALED_DEMAND = 0.40   # Recency-weighted real, verified venue capacity

# Reach model platforms
SNAPSHOT_PLATFORMS = [
    "spotifyMonthlyListeners",
    "youtubeSubscribers",
    "instagramFollowers",
    "facebookFollowers",
]

PLATFORM_LABELS = {
    "spotifyMonthlyListeners": "spotify",
    "youtubeSubscribers": "youtube",
    "instagramFollowers": "instagram",
    "facebookFollowers": "facebook",
}

# CRITIC-method-derived platform weights (Diakoulaki, Mavrotas & Papayannakis,
# 1995) -- see module docstring for full derivation and the incident that
# prompted it. Replaces the old ad hoc "Spotify >= 45%, Instagram >= 25%"
# floors, which had no empirical basis. V1 snapshot from N=8 verified
# artists -- confident that Instagram ranks highest, low confidence on the
# exact split beyond that. Revisit as more verified concert data accumulates.
PLATFORM_WEIGHTS: dict[str, float] = {
    "instagram": 0.305,
    "facebook": 0.269,
    "youtube": 0.259,
    "spotify": 0.168,
}

# Fixed, EXTERNAL anchors -- what does a "100" mean in absolute terms,
# independent of who else is currently in the roster. Replaces cohort-
# relative max-normalization, which reshuffled every artist's score whenever
# the roster changed and crushed every "big enough" artist toward the same
# ~90-100 band (see incident in module docstring). Chosen as a realistic
# ceiling for this roster's own genre/market (mainstream + regional Indian
# music), not a global-pop ceiling that would flatten everyone in THIS
# roster near zero.
PLATFORM_ANCHORS: dict[str, float] = {
    "spotifyMonthlyListeners": 80_000_000,
    "youtubeSubscribers": 30_000_000,
    "instagramFollowers": 80_000_000,
    "facebookFollowers": 80_000_000,
}

# Revealed Demand: a real show's evidentiary weight halves every this many
# years -- an old sold-out show fades, a recent one counts fully. See
# incident in module docstring (Armaan Malik's only verified large show is
# from 2017; this is the mechanism that stops a decade-old show from
# counting the same as a recent one for Shreya/Arijit/Diljit).
REVEALED_DEMAND_HALF_LIFE_YEARS = 3.0
# ~India's biggest real stadiums -- Narendra Modi Stadium (132,000 capacity)
# is itself one of this roster's own verified data points.
REVEALED_DEMAND_ANCHOR = 150_000.0


def _scale_to_anchor(value: float, anchor: float) -> float:
    """log-compressed 0.0-1.0 scale against a FIXED external anchor -- see
    module docstring for why cohort-relative normalization was replaced."""
    if value <= 0 or anchor <= 0:
        return 0.0
    return float(min(1.0, np.log1p(value) / np.log1p(anchor)))


# ── Reach (platform follower/listener counts) ──────────────────────────────────

def _reach_score_for_artist(artist_row: dict) -> tuple[float, dict[str, float], dict[str, float]]:
    """Reach score (0-100) for one artist: each platform's raw value scaled
    against its own FIXED anchor (PLATFORM_ANCHORS), weighted by the
    CRITIC-derived PLATFORM_WEIGHTS, tilted per-artist by genre style.

    Needs only THIS artist's own snapshot row -- no cohort/matrix required.
    This is also what makes a single-artist call agree with the full-roster
    batch call by construction (both call the same function with the same
    per-artist inputs), rather than by careful parallel maintenance of two
    code paths computing a cohort-relative value.
    """
    genre_style = genre_style_for_artist_name(artist_row.get("artistName"))
    tilted_weights = apply_genre_tilt(PLATFORM_WEIGHTS, genre_style)

    contributions: dict[str, float] = {}
    weights_out: dict[str, float] = {}
    for db_field, label in PLATFORM_LABELS.items():
        value = float(artist_row.get(db_field) or 0.0)
        scaled = _scale_to_anchor(value, PLATFORM_ANCHORS[db_field])
        w = tilted_weights.get(label, 0.0)
        contributions[label] = round(scaled * w, 4)
        weights_out[label] = round(w, 4)

    score = round(min(100.0, max(0.0, 5.0 + 95.0 * sum(contributions.values()))), 2)
    return score, weights_out, contributions


# ── Google Trends Integration ───────────────────────────────────────────────────
# 2026-09-29 incident, part 2: this used to call fetch_trends_scores(), which
# rescales every artist in the batch so THIS RUN's single highest-interest
# artist = 100 -- the same cohort-dependence the rest of this redesign
# eliminated, just still present here because this function was believed
# unused by the redesign (it wasn't). Live symptom: Armaan Malik hit 100 and
# Arijit Singh hit 0 in the same run purely from who else was in that batch,
# a 20-point swing on its own large enough to outrank an artist who wins on
# both other components. See fetch_trends_scores_stable's docstring.

def _fetch_google_trends_scores(artist_names: list[str]) -> dict[str, float]:
    """
    Fetch Google Trends scores for all artists, each one independent of every
    other -- one artist's spike can never move another artist's score.
    Falls back to stored DB scores if pytrends fails or is unavailable.
    Returns dict: artist_name → score (0–100)
    """
    scores: dict[str, float] = {}

    # Try live fetch first. timeframe="today 12-m": widened from 3-m so a
    # short-lived, music-unrelated search spike (e.g. a film promotion or a
    # reality-TV appearance for an actor-singer) is diluted by a full year of
    # this SAME artist's own baseline interest, not just outcompeted by
    # whoever else happens to be in the roster.
    try:
        from ..trends.google_trends import fetch_trends_scores_stable
        scores = fetch_trends_scores_stable(artist_names, geo="", timeframe="today 12-m", suffix=" music")
        if scores:
            logger.info(f"[Popularity] Google Trends: live scores for {len(scores)} artists")
            return scores
    except ImportError:
        logger.warning("[Popularity] pytrends not installed — using stored scores")
    except Exception as e:
        logger.warning(f"[Popularity] Google Trends live fetch failed: {e} — using stored scores")

    # Fallback: read from DB (googleTrendsScore column) -- also written by the
    # cohort-independent fetch now (see fetch_and_store_trends), so the
    # fallback path carries the same guarantee as the live path.
    scores = _fetch_stored_trends_scores()
    if scores:
        logger.info(f"[Popularity] Google Trends: using {len(scores)} stored scores from DB")
    return scores


def _fetch_stored_trends_scores() -> dict[str, float]:
    """Read previously stored Google Trends scores from the artists table."""
    try:
        from sqlalchemy import text as sql_text
        engine = get_engine()
        with engine.connect() as conn:
            rows = conn.execute(sql_text("""
                SELECT "artistName", "googleTrendsScore"
                FROM artists
                WHERE active = true AND "googleTrendsScore" IS NOT NULL
            """)).mappings().all()
        return {row["artistName"]: float(row["googleTrendsScore"]) for row in rows}
    except Exception:
        return {}


# ── Revealed Demand (real, verified touring evidence) ──────────────────────────

def _fetch_verified_concert_history(artist_id: str) -> list[dict]:
    """This artist's own real concerts whose venue+city matches the curated,
    cross-checked known-venues table (mad_analytics/venue_capacity/known_venues.py)
    -- the same strict bar already used for the Analysis page's Venue Capacity
    stat. Deliberately NOT the looser "capacity column is non-null" bar
    touring_history/scorer.py's _biggest_verified_show uses for its own,
    separate purpose -- that column also holds un-curated heuristic-estimated
    placeholder values (see Analysis.jsx's KNOWN_CAPACITY_PLACEHOLDER fix,
    2026-09-29), which would silently re-contaminate this signal with the
    exact bug already found and fixed elsewhere in this product.

    Returns [] (never raises) on any DB failure -- this signal renormalizes
    out of the blend when unavailable, same discipline as Google Trends.
    """
    try:
        from ..venue_capacity.known_venues import lookup_known_capacity
        from sqlalchemy import text as sql_text
        engine = get_engine()
        with engine.connect() as conn:
            rows = conn.execute(
                sql_text(
                    'SELECT "venueName", city, "concertDate" FROM concerts '
                    'WHERE "artistId" = :aid AND "venueName" IS NOT NULL '
                    'AND city IS NOT NULL AND "concertDate" IS NOT NULL '
                    'AND "concertDate" <= CURRENT_DATE'
                ),
                {"aid": artist_id},
            ).mappings().all()
    except Exception as e:
        logger.warning(f"[Popularity] Revealed-demand concert fetch failed for {artist_id}: {e}")
        return []

    verified: list[dict] = []
    for r in rows:
        capacity = lookup_known_capacity(r["venueName"] or "", r["city"] or "")
        if not capacity:
            continue
        verified.append({"capacity": float(capacity), "date": r["concertDate"]})
    return verified


def _as_utc_datetime(value) -> Optional[datetime]:
    """Concert.concertDate can come back as either a date or a datetime,
    depending on the driver -- normalize to a tz-aware datetime so it can be
    subtracted from datetime.now(timezone.utc)."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
    if isinstance(value, date_cls):
        return datetime(value.year, value.month, value.day, tzinfo=timezone.utc)
    return None


def _revealed_demand_score(artist_id: str) -> Optional[float]:
    """Recency-weighted peak REAL, VERIFIED venue capacity, log-scaled
    against REVEALED_DEMAND_ANCHOR. None (never a fabricated 0) when this
    artist has no verified show at all -- the score renormalizes onto
    Reach/Trends instead of penalizing what might just be an import gap,
    not real evidence of low demand."""
    hits = _fetch_verified_concert_history(artist_id)
    if not hits:
        return None

    now = datetime.now(timezone.utc)
    best_weighted = 0.0
    for hit in hits:
        show_date = _as_utc_datetime(hit["date"])
        if show_date is None:
            continue
        years_ago = max(0.0, (now - show_date).days / 365.25)
        decay = 0.5 ** (years_ago / REVEALED_DEMAND_HALF_LIFE_YEARS)
        best_weighted = max(best_weighted, hit["capacity"] * decay)

    if best_weighted <= 0:
        return None
    return round(100.0 * _scale_to_anchor(best_weighted, REVEALED_DEMAND_ANCHOR), 2)


# ── Instagram Engagement Rate Integration (unused by calculate()/calculate_all(),
# kept for a future engagement-rate signal -- see engagement/scorer.py for the
# currently-wired engagement rate consumer) ────────────────────────────────────

def _fetch_engagement_rates(artist_ids: list[str]) -> dict[str, float]:
    """
    Fetch Instagram engagement rates for artists from platform_metrics.

    Engagement Rate = (avg_likes + avg_comments) / followers × 100

    The Instagram scraper stores avg_likes in 'likes' column and avg_comments
    in 'comments' column of platform_metrics (INSTAGRAM platform).

    Returns dict: artist_id → engagement_rate (raw percentage, e.g. 2.5 means 2.5%)
    """
    import os
    try:
        from sqlalchemy import create_engine, text as sql_text
        db_url = os.environ.get("DATABASE_URL")
        if not db_url:
            return {}
        normalized = db_url.replace("postgres://", "postgresql://", 1) if db_url.startswith("postgres://") else db_url
        engine = create_engine(normalized)

        # Get latest Instagram metrics for each artist
        with engine.connect() as conn:
            rows = conn.execute(sql_text("""
                SELECT DISTINCT ON ("artistId")
                    "artistId", followers, likes, comments
                FROM platform_metrics
                WHERE platform = 'INSTAGRAM'
                  AND followers > 0
                ORDER BY "artistId", "metricDate" DESC
            """)).mappings().all()

        engine.dispose()

        rates: dict[str, float] = {}
        for row in rows:
            followers = int(row["followers"] or 0)
            avg_likes = float(row["likes"] or 0)
            avg_comments = float(row["comments"] or 0)
            if followers > 0:
                er = (avg_likes + avg_comments) / followers * 100.0
                rates[row["artistId"]] = round(er, 4)

        return rates
    except Exception as e:
        logger.warning(f"[Popularity] Failed to fetch engagement rates: {e}")
        return {}


def _normalize_engagement_scores(rates: dict[str, float]) -> dict[str, float]:
    """
    Normalize engagement rates to 0–100 scale.

    Typical celebrity ER is 0.5%–5%. We use a logarithmic scale so that:
    - ER ≥ 5% → 100
    - ER ~2.5% → ~75
    - ER ~1% → ~50
    - ER ~0.3% → ~25
    - ER = 0% → 0
    """
    if not rates:
        return {}

    normalized: dict[str, float] = {}
    for artist_id, er in rates.items():
        if er <= 0:
            normalized[artist_id] = 0.0
        else:
            # Log scale: score = min(100, (ln(1 + er * 20) / ln(101)) * 100)
            # This maps ER=5% → ~100, ER=1% → ~60, ER=0.3% → ~35
            score = min(100.0, (np.log1p(er * 20) / np.log(101)) * 100.0)
            normalized[artist_id] = round(score, 2)

    return normalized


# ── Rate of Growth Integration (unused by calculate()/calculate_all() --
# Momentum was archived, see module docstring; kept for the same reason as
# the engagement-rate functions above) ─────────────────────────────────────────

def _fetch_rog_scores() -> dict[str, float]:
    """Fetch average daily RoG per artist from platform_metrics (last 90 days).

    rogDaily is a percentage (e.g., 2.5 means 2.5% growth in a day).
    Returns dict: artist_id → avg_rog_daily
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
                SELECT "artistId", AVG("rogDaily") as avg_rog
                FROM platform_metrics
                WHERE "rogDaily" IS NOT NULL
                  AND "metricDate" >= CURRENT_DATE - INTERVAL '90 days'
                GROUP BY "artistId"
            """)).mappings().all()
        engine.dispose()
        return {row["artistId"]: float(row["avg_rog"]) for row in rows if row["avg_rog"] is not None}
    except Exception as e:
        logger.warning(f"[Popularity] Failed to fetch RoG scores: {e}")
        return {}


def _normalize_rog_scores(raw_rog: dict[str, float]) -> dict[str, float]:
    """Normalize daily RoG to 0–100 scale.

    rogDaily of 0.5% (moderate growth) → ~50
    rogDaily of 2% (very fast growth) → ~100
    Uses log scale so tiny growth doesn't score zero.
    """
    if not raw_rog:
        return {}

    normalized: dict[str, float] = {}
    for artist_id, rog in raw_rog.items():
        if rog <= 0:
            normalized[artist_id] = 0.0
        else:
            # Log scale: score = min(100, (ln(1 + rog * 40) / ln(81)) * 100)
            # Maps: 0.1% → ~30, 0.5% → ~62, 1% → ~79, 2% → ~92, 5% → 100
            score = min(100.0, (np.log1p(rog * 40) / np.log(81)) * 100.0)
            normalized[artist_id] = round(score, 2)

    return normalized


# NOTE: this file used to have a "Momentum (cross_platform_score) Integration"
# section here (_fetch_recent_metrics_by_artist) that fed the growth module for
# the Momentum component. Removed along with Momentum itself when Growth/RoG
# was archived — see the module docstring and mad_analytics/legacy/growth_calculator.py.


# ── Blended score with renormalization ────────────────────────────────────────

def _blend_popularity(
    reach_score: float,
    trends: Optional[float],
    revealed_demand: Optional[float],
) -> tuple[float, dict[str, float]]:
    """Apply Popularity = Reach*0.40 + Trends*0.20 + RevealedDemand*0.40,
    renormalizing over whichever components are actually available.

    reach_score is always present. trends/revealed_demand are None when
    unavailable for this artist (pytrends not yet run / no verified show
    logged) -- never a fabricated 0.
    Returns (final_score_0_100, effective_weights) where effective_weights are
    the renormalized weights actually used (for transparency in the response).
    """
    components: list[tuple[str, float, float]] = [("reach", reach_score, WEIGHT_REACH)]
    if trends is not None:
        components.append(("google_trends", trends, WEIGHT_GOOGLE_TRENDS))
    if revealed_demand is not None:
        components.append(("revealed_demand", revealed_demand, WEIGHT_REVEALED_DEMAND))

    total_w = sum(w for _, _, w in components)
    effective = {name: round(w / total_w, 4) for name, _, w in components} if total_w > 0 else {}
    if total_w <= 0:
        return round(min(100.0, max(0.0, reach_score)), 2), effective

    blended = sum(value * w for _, value, w in components) / total_w
    return round(min(100.0, max(0.0, blended)), 2), effective


# ── Main Calculation ──────────────────────────────────────────────────────────

def _build_popularity_output(
    artist_id: str,
    artist_row: dict,
    trend_score: Optional[float],
) -> PopularityOutput:
    """Shared by calculate() and calculate_all() -- computes Reach and
    Revealed Demand for one artist and blends them with the given (already
    fetched) Trends score. Both entry points calling this one function is
    what GUARANTEES single-artist and full-roster results agree, rather than
    relying on two separate code paths being kept in sync by hand."""
    reach_score, platform_weights_dict, platform_contributions = _reach_score_for_artist(artist_row)
    revealed_demand_score = _revealed_demand_score(artist_id)

    final_score, effective_weights = _blend_popularity(reach_score, trend_score, revealed_demand_score)

    reach_w = effective_weights.get("reach", 0.0)
    all_contributions = {k: round(v * reach_w, 4) for k, v in platform_contributions.items()}
    all_weights = {k: round(v * reach_w, 4) for k, v in platform_weights_dict.items()}
    if trend_score is not None:
        all_contributions["google_trends"] = round(trend_score * effective_weights.get("google_trends", 0.0) / 100.0, 4)
        all_weights["google_trends"] = effective_weights.get("google_trends", 0.0)
    if revealed_demand_score is not None:
        all_contributions["revealed_demand"] = round(revealed_demand_score * effective_weights.get("revealed_demand", 0.0) / 100.0, 4)
        all_weights["revealed_demand"] = effective_weights.get("revealed_demand", 0.0)

    return PopularityOutput(
        artist_id=artist_id,
        popularity_score=final_score,
        platform_weights=all_weights,
        platform_contributions=all_contributions,
        computed_at=datetime.now(timezone.utc).isoformat(),
        reach_score=reach_score,
        revealed_demand_score=revealed_demand_score,
        trends_score=trend_score,
    )


def calculate_all() -> list[PopularityOutput]:
    """
    Compute popularity scores for all active artists using the blended
    formula: Popularity = Reach*0.40 + GoogleTrends*0.20 + RevealedDemand*0.40
    (weights renormalized over available components) -- see module docstring
    for the full formula, the incident that produced it, and its methodology.
    """
    artists = fetch_artist_snapshots()
    if not artists:
        return []

    artist_names = [a["artistName"] for a in artists]
    trends_scores = _fetch_google_trends_scores(artist_names)

    return [
        _build_popularity_output(artist["artist_id"], artist, trends_scores.get(artist["artistName"]))
        for artist in artists
    ]


def calculate(payload: PopularityInput) -> PopularityOutput:
    """
    Compute one artist's popularity score using the same blended formula and
    the same per-artist computation calculate_all() uses for every artist
    (see _build_popularity_output) -- guaranteeing single-artist and
    full-roster results agree, by construction rather than by convention.

    NOTE: `payload.platform_metrics` (a caller-supplied time series) is
    intentionally NOT used for Reach, even when provided -- Reach is scaled
    against a fixed external anchor from the artist's current snapshot, not
    any self-relative history, so there is no "monotonic history forces the
    score to 100" failure mode to guard against here (that was the old
    cohort-relative design's bug; fixed-anchor scaling doesn't have it).
    """
    artists = fetch_artist_snapshots()
    artist_row = next((a for a in artists if a["artist_id"] == payload.artist_id), None)
    if artist_row is None:
        return PopularityOutput(
            artist_id=payload.artist_id,
            popularity_score=5.0,
            platform_weights={},
            platform_contributions={},
            computed_at=datetime.now(timezone.utc).isoformat(),
        )

    # Google Trends score — None if not present (pytrends not yet run).
    # Looked up for THIS artist alone: the stable fetch (fetch_trends_scores_stable)
    # scores each artist against their own 12-month history, never against the
    # rest of the roster, so there is no cohort to gather here any more --
    # unlike the old batch-normalized fetch, a single-artist call agrees with
    # calculate_all()'s value by construction, not because both happen to see
    # the same cohort.
    artist_name = artist_row.get("artistName")
    trend_score = None
    if artist_name:
        trends_scores = _fetch_google_trends_scores([artist_name])
        trend_score = trends_scores.get(artist_name)

    return _build_popularity_output(payload.artist_id, artist_row, trend_score)


def _get_artist_name(artist_id: str) -> Optional[str]:
    """Lookup artist name from ID via DB."""
    try:
        from sqlalchemy import text as sql_text
        engine = get_engine()
        with engine.connect() as conn:
            result = conn.execute(
                sql_text('SELECT "artistName" FROM artists WHERE id = :id'),
                {"id": artist_id},
            ).scalar()
        return result
    except Exception:
        return None

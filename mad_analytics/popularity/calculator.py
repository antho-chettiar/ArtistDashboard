"""
Popularity model using a blended approach:
  - 55% Base entropy score (Spotify, YouTube, Instagram, Facebook follower counts)
  - 25% Google Trends score (real-time public search interest)
  - 20% Instagram Engagement Rate (content quality + fan interaction)

The base entropy model uses information-entropy weighting across artist platform
snapshots to compute relative popularity from follower/listener counts.

Google Trends captures current demand/buzz (artists on tour or trending get boosted).
Instagram Engagement Rate captures content quality — an artist with fewer followers
but high engagement is more "active" and culturally relevant than a dormant account.
"""
from __future__ import annotations
from datetime import datetime, timezone
import logging
from typing import Optional

import numpy as np
import pandas as pd

from ..utils.db import fetch_artist_snapshots
from ..utils.schemas import PopularityInput, PopularityOutput
from ..utils.feature_engineering import metrics_to_df, platform_series

logger = logging.getLogger(__name__)

# ── Weight Configuration ───────────────────────────────────────────────────────

# Final blended formula weights
WEIGHT_BASE = 0.50           # Entropy-weighted platform followers
WEIGHT_GOOGLE_TRENDS = 0.25  # Google Trends search interest
WEIGHT_ROG = 0.25            # Rate of Growth momentum

# Base model platforms
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


# ── Base Entropy Model (unchanged core logic) ─────────────────────────────────

def _build_platform_matrix(df: pd.DataFrame) -> pd.DataFrame:
    """Return a dense platform × time matrix of each platform's primary metric."""
    platforms = sorted({p for p in df["platform"].unique() if p})
    if not platforms:
        return pd.DataFrame()

    rows: dict[str, pd.Series] = {}
    for platform in platforms:
        series = platform_series(df, platform)
        rows[platform] = series

    matrix = pd.DataFrame(rows).fillna(0.0)
    matrix = matrix.sort_index()
    return matrix


def _build_snapshot_matrix(rows: list[dict[str, object]]) -> pd.DataFrame:
    """Build a cross-sectional snapshot matrix from artist-level fields."""
    if not rows:
        return pd.DataFrame()

    data = {
        PLATFORM_LABELS[platform]: [
            float(row.get(platform) or 0.0) for row in rows
        ]
        for platform in SNAPSHOT_PLATFORMS
    }
    return pd.DataFrame(data)


def _entropy_weights(matrix: pd.DataFrame) -> dict[str, float]:
    """Compute entropy-based weights with Spotify priority.
    
    Modifications from pure entropy:
    - Spotify gets a minimum floor of 40% (it's the core music metric)
    - Remaining weight distributed by entropy among other platforms
    """
    if matrix.empty:
        return {}

    n_rows = len(matrix)
    entropy_factor = 1.0 / np.log(n_rows) if n_rows > 1 else 0.0
    transformed = np.log1p(matrix)
    diversifications: dict[str, float] = {}

    for platform in transformed.columns:
        column = transformed[platform].astype(float)
        column_sum = float(column.sum())
        if column_sum <= 0 or entropy_factor == 0:
            diversifications[platform] = 0.0
            continue

        probabilities = column / column_sum
        entropy = -entropy_factor * np.nansum(
            np.where(probabilities > 0, probabilities * np.log(probabilities), 0.0)
        )
        diversifications[platform] = float(max(0.0, 1.0 - entropy))

    total = sum(diversifications.values())
    if total <= 0:
        equal_weight = 1.0 / max(1, len(transformed.columns))
        return {platform: equal_weight for platform in transformed.columns}

    # Raw entropy weights
    raw_weights = {platform: value / total for platform, value in diversifications.items()}

    # Apply constraints: platform minimum floors
    SPOTIFY_FLOOR = 0.45
    INSTAGRAM_FLOOR = 0.25
    adjusted = raw_weights.copy()

    spotify_key = next((k for k in adjusted if "spotify" in k.lower()), None)
    if spotify_key and adjusted[spotify_key] < SPOTIFY_FLOOR:
        deficit_for_floor = SPOTIFY_FLOOR - adjusted[spotify_key]
        adjusted[spotify_key] = SPOTIFY_FLOOR

        other_keys = [k for k in adjusted if k != spotify_key]
        other_total = sum(adjusted[k] for k in other_keys)
        if other_total > 0:
            for k in other_keys:
                adjusted[k] -= deficit_for_floor * (adjusted[k] / other_total)

    instagram_key = next((k for k in adjusted if "instagram" in k.lower()), None)
    if instagram_key and adjusted[instagram_key] < INSTAGRAM_FLOOR:
        deficit = INSTAGRAM_FLOOR - adjusted[instagram_key]
        adjusted[instagram_key] = INSTAGRAM_FLOOR
        other_keys = [k for k in adjusted if k != instagram_key]
        other_total = sum(adjusted[k] for k in other_keys)
        if other_total > 0:
            for k in other_keys:
                adjusted[k] -= deficit * (adjusted[k] / other_total)

    # Normalize to sum to 1.0
    final_total = sum(adjusted.values())
    if final_total > 0:
        adjusted = {k: v / final_total for k, v in adjusted.items()}

    return adjusted


def _normalize_vector(series: pd.Series) -> pd.Series:
    max_by_platform = series.max(axis=0).replace(0.0, np.nan)
    return (series / max_by_platform).fillna(0.0)


# ── Google Trends Integration ─────────────────────────────────────────────────

def _fetch_google_trends_scores(artist_names: list[str]) -> dict[str, float]:
    """
    Fetch Google Trends scores for all artists.
    Falls back to stored DB scores if pytrends fails or is unavailable.
    Returns dict: artist_name → score (0–100)
    """
    scores: dict[str, float] = {}

    # Try live fetch first
    try:
        from ..trends.google_trends import fetch_trends_scores
        scores = fetch_trends_scores(artist_names, geo="", timeframe="today 3-m", suffix=" music")
        if scores:
            logger.info(f"[Popularity] Google Trends: live scores for {len(scores)} artists")
            return scores
    except ImportError:
        logger.warning("[Popularity] pytrends not installed — using stored scores")
    except Exception as e:
        logger.warning(f"[Popularity] Google Trends live fetch failed: {e} — using stored scores")

    # Fallback: read from DB (googleTrendsScore column)
    scores = _fetch_stored_trends_scores()
    if scores:
        logger.info(f"[Popularity] Google Trends: using {len(scores)} stored scores from DB")
    return scores


def _fetch_stored_trends_scores() -> dict[str, float]:
    """Read previously stored Google Trends scores from the artists table."""
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
                SELECT "artistName", "googleTrendsScore"
                FROM artists
                WHERE active = true AND "googleTrendsScore" IS NOT NULL
            """)).mappings().all()
        engine.dispose()
        return {row["artistName"]: float(row["googleTrendsScore"]) for row in rows}
    except Exception:
        return {}


# ── Instagram Engagement Rate Integration ─────────────────────────────────────

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


# ── Rate of Growth Integration ─────────────────────────────────────────────────

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
        ninety_days_ago = datetime.now(timezone.utc).isoformat()  # We'll filter in SQL
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


# ── Main Calculation ──────────────────────────────────────────────────────────

def _calculate_base_entropy_score(artist_id: str, artists: list[dict], matrix: pd.DataFrame, weights: dict[str, float]) -> tuple[float, dict[str, float], dict[str, float]]:
    """Calculate the base entropy-weighted score for a single artist."""
    if matrix.empty:
        return 5.0, {}, {}

    transformed = np.log1p(matrix)
    normalized = _normalize_vector(transformed)

    target_row = next((row for row in artists if row["artist_id"] == artist_id), None)
    if not target_row:
        return 5.0, {}, {}

    target_values = {
        PLATFORM_LABELS[platform]: float(target_row.get(platform) or 0.0)
        for platform in SNAPSHOT_PLATFORMS
    }
    target_series = pd.Series(target_values)
    target_normalized = _normalize_vector(target_series.to_frame().T).iloc[0]

    platform_contributions = {
        platform: round(float(target_normalized.get(platform, 0.0) * weights.get(platform, 0.0)), 4)
        for platform in matrix.columns
    }
    platform_weights = {platform: round(weights.get(platform, 0.0), 4) for platform in matrix.columns}
    score = round(min(100.0, max(0.0, 5.0 + 95.0 * sum(platform_contributions.values()))), 2)

    return score, platform_weights, platform_contributions


def calculate_all() -> list[PopularityOutput]:
    """
    Compute popularity scores for all active artists using the blended formula:
      final = base × 0.50 + google_trends × 0.25 + rog × 0.25
    """
    artists = fetch_artist_snapshots()
    if not artists:
        return []

    matrix = _build_snapshot_matrix(artists)
    if matrix.empty:
        return []

    weights = _entropy_weights(matrix)
    transformed = np.log1p(matrix)
    normalized = _normalize_vector(transformed)

    # Fetch Google Trends scores (by artist name)
    artist_names = [a["artistName"] for a in artists]
    trends_scores = _fetch_google_trends_scores(artist_names)

    # Fetch RoG scores (by artist ID)
    artist_ids = [a["artist_id"] for a in artists]
    raw_rog = _fetch_rog_scores()
    rog_scores = _normalize_rog_scores(raw_rog)

    outputs: list[PopularityOutput] = []
    for idx, row in normalized.iterrows():
        artist = artists[idx]
        artist_id = artist["artist_id"]
        artist_name = artist["artistName"]

        # Base entropy score (0–100)
        platform_contributions = {
            platform: round(float(row.get(platform, 0.0) * weights.get(platform, 0.0)), 4)
            for platform in matrix.columns
        }
        platform_weights_dict = {platform: round(weights.get(platform, 0.0), 4) for platform in matrix.columns}
        base_score = round(min(100.0, max(0.0, 5.0 + 95.0 * sum(platform_contributions.values()))), 2)

        # Google Trends score (0–100)
        trend_score = trends_scores.get(artist_name, 0.0)

        # RoG score (0–100, normalized)
        rog_score = rog_scores.get(artist_id, 0.0)

        # Blended final score
        final_score = (
            base_score * WEIGHT_BASE
            + trend_score * WEIGHT_GOOGLE_TRENDS
            + rog_score * WEIGHT_ROG
        )
        final_score = round(min(100.0, max(0.0, final_score)), 2)

        # Include all components in contributions for transparency
        all_contributions = {
            **platform_contributions,
            "google_trends": round(trend_score * WEIGHT_GOOGLE_TRENDS / 100.0, 4),
            "rog": round(rog_score * WEIGHT_ROG / 100.0, 4),
        }
        all_weights = {
            **{k: round(v * WEIGHT_BASE, 4) for k, v in platform_weights_dict.items()},
            "google_trends": WEIGHT_GOOGLE_TRENDS,
            "rog": WEIGHT_ROG,
        }

        outputs.append(PopularityOutput(
            artist_id=artist_id,
            popularity_score=final_score,
            platform_weights=all_weights,
            platform_contributions=all_contributions,
            computed_at=datetime.now(timezone.utc).isoformat(),
        ))

    return outputs


def calculate(payload: PopularityInput) -> PopularityOutput:
    """
    Compute an artist popularity score using the blended formula.
    
    If platform_metrics are provided, uses them for the base entropy score.
    Otherwise, falls back to the snapshot-based approach.
    
    Google Trends and RoG are always fetched from stored data.
    """
    if payload.platform_metrics:
        df = metrics_to_df(payload.platform_metrics)
        matrix = _build_platform_matrix(df)
        if matrix.empty:
            platform_weights_dict = {}
            platform_contributions = {}
            base_score = 5.0
        else:
            weights = _entropy_weights(matrix)
            transformed = np.log1p(matrix)
            latest_relative = _normalize_vector(transformed).iloc[-1]

            platform_contributions = {
                platform: round(float(latest_relative.get(platform, 0.0) * weights.get(platform, 0.0)), 4)
                for platform in transformed.columns
            }
            platform_weights_dict = {platform: round(weights.get(platform, 0.0), 4) for platform in transformed.columns}
            base_score = round(min(100.0, max(0.0, 5.0 + 95.0 * sum(platform_contributions.values()))), 2)
    else:
        artists = fetch_artist_snapshots()
        if not artists:
            return PopularityOutput(
                artist_id=payload.artist_id,
                popularity_score=5.0,
                platform_weights={},
                platform_contributions={},
                computed_at=datetime.now(timezone.utc).isoformat(),
            )

        matrix = _build_snapshot_matrix(artists)
        if matrix.empty:
            return PopularityOutput(
                artist_id=payload.artist_id,
                popularity_score=5.0,
                platform_weights={},
                platform_contributions={},
                computed_at=datetime.now(timezone.utc).isoformat(),
            )

        weights = _entropy_weights(matrix)
        base_score, platform_weights_dict, platform_contributions = _calculate_base_entropy_score(
            payload.artist_id, artists, matrix, weights
        )

    # Get artist name for Google Trends lookup
    artist_name = _get_artist_name(payload.artist_id)

    # Google Trends score
    trend_score = 0.0
    if artist_name:
        trends_scores = _fetch_google_trends_scores([artist_name])
        trend_score = trends_scores.get(artist_name, 0.0)

    # RoG score
    raw_rog = _fetch_rog_scores()
    rog_scores = _normalize_rog_scores(raw_rog)
    rog_score = rog_scores.get(payload.artist_id, 0.0)

    # Blended final score
    final_score = (
        base_score * WEIGHT_BASE
        + trend_score * WEIGHT_GOOGLE_TRENDS
        + rog_score * WEIGHT_ROG
    )
    final_score = round(min(100.0, max(0.0, final_score)), 2)

    # Merge all contributions
    all_contributions = {
        **platform_contributions,
        "google_trends": round(trend_score * WEIGHT_GOOGLE_TRENDS / 100.0, 4),
        "rog": round(rog_score * WEIGHT_ROG / 100.0, 4),
    }
    all_weights = {
        **{k: round(v * WEIGHT_BASE, 4) for k, v in platform_weights_dict.items()},
        "google_trends": WEIGHT_GOOGLE_TRENDS,
        "rog": WEIGHT_ROG,
    }

    return PopularityOutput(
        artist_id=payload.artist_id,
        popularity_score=final_score,
        platform_weights=all_weights,
        platform_contributions=all_contributions,
        computed_at=datetime.now(timezone.utc).isoformat(),
    )


def _get_artist_name(artist_id: str) -> Optional[str]:
    """Lookup artist name from ID via DB."""
    import os
    try:
        from sqlalchemy import create_engine, text as sql_text
        db_url = os.environ.get("DATABASE_URL")
        if not db_url:
            return None
        normalized = db_url.replace("postgres://", "postgresql://", 1) if db_url.startswith("postgres://") else db_url
        engine = create_engine(normalized)
        with engine.connect() as conn:
            result = conn.execute(
                sql_text('SELECT "artistName" FROM artists WHERE id = :id'),
                {"id": artist_id},
            ).scalar()
        engine.dispose()
        return result
    except Exception:
        return None

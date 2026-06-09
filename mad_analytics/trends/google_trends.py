"""
Google Trends integration for artist popularity scoring.

Uses pytrends (unofficial Google Trends API) to fetch relative search interest
for artist names. No API key needed — free.

Query: "{artist_name}" (general interest)
Geo: IN (India)
Timeframe: last 3 months

Returns 0–100 scores normalized across all queried artists.

Rate limiting: ~2 seconds between requests to avoid 429s.
Batch size: 5 keywords max per request (pytrends limit).

Usage:
    from mad_analytics.trends import fetch_trends_scores
    scores = fetch_trends_scores(["Diljit Dosanjh", "Arijit Singh", "Taylor Swift"])
    # Returns: {"Diljit Dosanjh": 87.5, "Arijit Singh": 42.3, "Taylor Swift": 100.0}
"""
from __future__ import annotations
import functools
import logging
import time
from typing import Optional

logger = logging.getLogger(__name__)


def _get_pytrends_client():
    """Create a pytrends TrendReq client with anti-429 headers."""
    try:
        from pytrends.request import TrendReq
    except ImportError:
        raise ImportError(
            "pytrends is not installed. Run: pip install pytrends"
        )

    # Patch urllib3 Retry for pytrends 4.9.2 compatibility with urllib3 v2+
    try:
        import urllib3
        from urllib3.util.retry import Retry
        import inspect
        sig = inspect.signature(Retry.__init__)
        if "method_whitelist" not in sig.parameters:
            _orig_retry_init = Retry.__init__
            @functools.wraps(_orig_retry_init)
            def _patched_retry_init(self, *args, **kwargs):
                if "method_whitelist" in kwargs:
                    kwargs["allowed_methods"] = kwargs.pop("method_whitelist")
                _orig_retry_init(self, *args, **kwargs)
            Retry.__init__ = _patched_retry_init
    except Exception:
        pass

    try:
        from pytrends import request as pytrends_request
        if hasattr(pytrends_request, "DEFAULT_HEADERS"):
            original_headers = pytrends_request.DEFAULT_HEADERS.copy()
            pytrends_request.DEFAULT_HEADERS.update({
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "en-US,en;q=0.9",
            })
            client = TrendReq(hl="en-US", tz=330, timeout=(15, 30), retries=2)
            pytrends_request.DEFAULT_HEADERS.clear()
            pytrends_request.DEFAULT_HEADERS.update(original_headers)
            return client
    except Exception:
        pass

    client = TrendReq(hl="en-US", tz=330, timeout=(15, 30), retries=2)
    return client


def _fetch_batch(pytrends, keywords: list[str], geo: str, timeframe: str) -> dict[str, float]:
    """
    Fetch interest_over_time for a batch of up to 5 keywords.
    Returns average interest score (0–100) for each keyword.
    """
    try:
        pytrends.build_payload(keywords, cat=0, timeframe=timeframe, geo=geo)
        data = pytrends.interest_over_time()

        if data.empty:
            logger.warning(f"[GoogleTrends] Empty response for: {keywords}")
            return {kw: 0.0 for kw in keywords}

        # Drop 'isPartial' column if present
        if "isPartial" in data.columns:
            data = data.drop(columns=["isPartial"])

        # Average interest over the timeframe for each keyword
        scores = {}
        for kw in keywords:
            if kw in data.columns:
                scores[kw] = round(float(data[kw].mean()), 2)
            else:
                scores[kw] = 0.0

        return scores
    except Exception as e:
        logger.error(f"[GoogleTrends] Error fetching batch {keywords}: {e}")
        return {kw: 0.0 for kw in keywords}


def fetch_trends_scores(
    artist_names: list[str],
    geo: str = "",
    timeframe: str = "today 3-m",
    reference_artist: Optional[str] = None,
    delay_seconds: float = 5.0,
    suffix: str = "",
) -> dict[str, float]:
    """
    Fetch Google Trends scores for a list of artist names.

    Since pytrends only supports 5 keywords per request, and scores are relative
    within each batch, we use a reference artist across all batches to normalize.

    Strategy:
    1. Pick a reference artist (highest expected — defaults to first artist or provided)
    2. Include the reference in every batch
    3. Normalize each batch so scores are comparable across batches
    4. Final normalization: scale so max = 100

    Args:
        artist_names: List of artist names to query
        geo: Country code (default "" for worldwide)
        timeframe: Pytrends timeframe string (default "today 3-m")
        reference_artist: Artist to use as cross-batch normalizer (default: first in list)
        delay_seconds: Seconds to wait between API calls (rate limiting)
        suffix: Optional suffix appended to keywords for API query (e.g. " music")

    Returns:
        Dict mapping artist_name → score (0–100)
    """
    if not artist_names:
        return {}

    pytrends = _get_pytrends_client()

    # Build keyword mapping: keyword_for_api → original_artist_name
    kw_map = {f"{name}{suffix}": name for name in artist_names}

    # Pick reference artist (use provided or first in list)
    ref = reference_artist or artist_names[0]
    if ref not in artist_names:
        ref = artist_names[0]
    ref_kw = f"{ref}{suffix}"

    # Remove reference from the main list to avoid duplicates in batching
    others = [name for name in artist_names if name != ref]
    others_kw = [f"{name}{suffix}" for name in others]

    # Batch others into groups of 4 (leaving 1 slot for reference)
    BATCH_SIZE = 4
    batches: list[list[str]] = []
    for i in range(0, len(others_kw), BATCH_SIZE):
        batches.append(others_kw[i:i + BATCH_SIZE])

    # If no others, just query the reference alone
    if not batches:
        batches = [[]]

    raw_scores: dict[str, float] = {}
    ref_scores_per_batch: list[float] = []

    for idx, batch in enumerate(batches):
        keywords = [ref_kw] + batch
        logger.info(f"[GoogleTrends] Batch {idx + 1}/{len(batches)}: {keywords}")

        scores = _fetch_batch(pytrends, keywords, geo, timeframe)

        ref_score = scores.get(ref_kw, 0.0)
        ref_scores_per_batch.append(ref_score)

        # Store raw scores for this batch (map back to original names)
        for kw, score in scores.items():
            original_name = kw_map.get(kw)
            if original_name and original_name != ref:
                # Normalize relative to reference within this batch
                if ref_score > 0:
                    normalized = (score / ref_score) * 100.0
                else:
                    normalized = score
                raw_scores[original_name] = round(normalized, 2)

        # Rate limit
        if idx < len(batches) - 1:
            time.sleep(delay_seconds)

    # Reference artist gets score = 100 (it's the baseline)
    # But actually, let's use the average of its appearances as its absolute score
    if ref_scores_per_batch:
        ref_absolute = sum(ref_scores_per_batch) / len(ref_scores_per_batch)
    else:
        ref_absolute = 100.0

    # The raw_scores are already normalized to reference = 100
    raw_scores[ref] = 100.0

    # Final normalization: scale so the maximum across all artists = 100
    max_score = max(raw_scores.values()) if raw_scores else 1.0
    if max_score <= 0:
        max_score = 1.0

    final_scores = {
        name: round(min(100.0, max(0.0, (score / max_score) * 100.0)), 2)
        for name, score in raw_scores.items()
    }

    logger.info(f"[GoogleTrends] Final scores: {final_scores}")
    return final_scores


def fetch_single_trend_score(
    artist_name: str,
    geo: str = "",
) -> float:
    """
    Fetch a single artist's Google Trends score (0–100).
    Note: Without comparison artists, this is the absolute average interest.
    """
    pytrends = _get_pytrends_client()
    scores = _fetch_batch(pytrends, [artist_name], geo, timeframe)
    return scores.get(artist_name, 0.0)


def fetch_and_store_trends(db_url: Optional[str] = None, geo: str = "", suffix: str = "") -> dict[str, float]:
    """
    Full pipeline: fetch all active artists from DB, query Google Trends,
    store scores back in the artists table (googleTrendsScore column).

    Args:
        db_url: Database URL (default from DATABASE_URL env)
        geo: Country code for trends (default "" for worldwide)
        suffix: Optional keyword suffix (e.g. " music")

    Returns the scores dict, or empty dict if all scores are zero (guard).
    """
    import os
    from sqlalchemy import create_engine, text as sql_text

    if not db_url:
        db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        logger.error("[GoogleTrends] DATABASE_URL not set")
        return {}

    normalized = db_url.replace("postgres://", "postgresql://", 1) if db_url.startswith("postgres://") else db_url
    engine = create_engine(normalized)

    # Fetch active artists
    with engine.connect() as conn:
        rows = conn.execute(
            sql_text('SELECT id, "artistName" FROM artists WHERE active = true')
        ).mappings().all()

    if not rows:
        engine.dispose()
        return {}

    artists = [dict(r) for r in rows]
    artist_names = [a["artistName"] for a in artists]
    name_to_id = {a["artistName"]: a["id"] for a in artists}

    logger.info(f"[GoogleTrends] Fetching trends for {len(artist_names)} artists...")

    # Fetch scores
    scores = fetch_trends_scores(artist_names, geo=geo, suffix=suffix)

    # Guard: don't save if ALL scores are zero (avoids overwriting good data on rate-limit failures)
    if not scores or all(v <= 0 for v in scores.values()):
        logger.warning(f"[GoogleTrends] All scores are zero — skipping DB save to preserve existing data.")
        engine.dispose()
        return {}

    # Store in DB
    with engine.begin() as conn:
        # Ensure column exists (safe to call multiple times)
        try:
            conn.execute(sql_text("""
                ALTER TABLE artists ADD COLUMN IF NOT EXISTS "googleTrendsScore" DECIMAL(5,2)
            """))
        except Exception:
            pass  # Column already exists or DB doesn't support IF NOT EXISTS

        for name, score in scores.items():
            artist_id = name_to_id.get(name)
            if artist_id:
                conn.execute(
                    sql_text('UPDATE artists SET "googleTrendsScore" = :score WHERE id = :id'),
                    {"score": round(score, 2), "id": artist_id},
                )

    engine.dispose()
    logger.info(f"[GoogleTrends] Stored scores for {len(scores)} artists.")
    return scores

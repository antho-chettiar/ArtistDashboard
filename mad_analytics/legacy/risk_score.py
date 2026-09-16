"""
LEGACY — Risk Score (Formula Blueprint v2.0 — Step 6)

Status: Retired from the active dashboard (removed by product decision —
Risk is out of scope for the current Artist Analytics product).
Reason: Removed from current product scope, not a bug or formula defect.

This module is preserved VERBATIM from mad_analytics/demand/scorer.py at the
point of removal, for possible future reuse. It is NOT imported by any active
endpoint, service, or route (server.py's /demand endpoint no longer calls
compute_risk(), and DemandOutput no longer has a `risk` field). Do not wire
this back into the active pipeline without a separate, explicit decision.

Original formula (unchanged):

    risk = average(market_saturation, momentum_volatility, trends_recency_gap)

    market_saturation   = concerts_city_90d / 20              (clamped [0, 1])
    momentum_volatility = STDDEV(rog per platform)            (clamped [0, 1]) *
    trends_recency_gap  = 1.0 if google_trends_score < 30 else 0.0

Averaged over whichever flags are computable (renormalize-on-missing). Level:
    Low < 0.33 · Medium 0.33-0.66 · High > 0.66.

* SPEC NOTE: Prediction_Formula Section 5 defines momentum_volatility as a raw
  STDDEV yet also states each flag is 0-1. No normalization divisor is given,
  so the literal STDDEV is clamped to [0, 1] (the minimal, non-inventive
  reconciliation). If a divisor is later specified, only
  _risk_momentum_volatility (here: the STDDEV clamp in compute_risk) changes.
"""
from __future__ import annotations
import logging
from typing import Optional

from ..utils.feature_engineering import metrics_to_df, platform_series, rog

logger = logging.getLogger(__name__)

RISK_ROG_PLATFORMS = ["spotify", "youtube", "instagram", "facebook"]


def _risk_level(score: float) -> str:
    if score < 0.33:
        return "Low"
    if score <= 0.66:
        return "Medium"
    return "High"


def _stddev(values: list[float]) -> Optional[float]:
    """Population standard deviation; None if fewer than 2 values."""
    n = len(values)
    if n < 2:
        return None
    mean = sum(values) / n
    variance = sum((v - mean) ** 2 for v in values) / n
    return variance ** 0.5


def compute_risk(
    concerts_city_90d: Optional[int],
    rogs: list[float],
    google_trends_score: Optional[float],
) -> Optional[dict]:
    """Pure risk computation over the three Blueprint flags.

    Each flag is included only when its inputs are available; the risk score is the
    average of the present flags. Returns {score, level, flags} or None if no flag
    is computable. No DB — offline-testable.
    """
    flags: dict[str, float] = {}

    if concerts_city_90d is not None:
        flags["market_saturation"] = round(max(0.0, min(1.0, concerts_city_90d / 20.0)), 4)

    sd = _stddev([r for r in rogs if r is not None])
    if sd is not None:
        flags["momentum_volatility"] = round(max(0.0, min(1.0, sd)), 4)

    if google_trends_score is not None:
        flags["trends_recency_gap"] = 1.0 if google_trends_score < 30 else 0.0

    if not flags:
        return None

    score = round(sum(flags.values()) / len(flags), 4)
    return {"score": score, "level": _risk_level(score), "flags": flags}


def _per_platform_rogs(metrics, window: int = 30) -> list[float]:
    """Per-platform RoG (percent) over `window` days, from the payload metrics.
    Only the four Blueprint platforms; platforms with <2 points are skipped."""
    try:
        df = metrics_to_df(metrics)
    except Exception:
        return []
    out: list[float] = []
    for platform in RISK_ROG_PLATFORMS:
        series = platform_series(df, platform)
        if not series.empty and len(series) >= 2:
            out.append(rog(series, window))
    return out


def _concerts_in_city_last_90d(city: str) -> Optional[int]:
    """Count concerts in a city over the last 90 days. None on failure (flag dropped)."""
    if not city:
        return None
    try:
        from sqlalchemy import text as sql_text
        from ..utils.db import get_engine
        engine = get_engine()
        with engine.connect() as conn:
            count = conn.execute(sql_text("""
                SELECT COUNT(*) FROM concerts
                WHERE LOWER(city) = LOWER(:city)
                  AND "concertDate" >= CURRENT_DATE - INTERVAL '90 days'
            """), {"city": city}).scalar()
        return int(count) if count is not None else None
    except Exception as e:
        logger.warning(f"[Demand] Risk market-saturation lookup failed for {city}: {e}")
        return None

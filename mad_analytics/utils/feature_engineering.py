"""Feature engineering — shared transformations for all three models."""
from __future__ import annotations
import math
from datetime import date, timedelta
from typing import Optional

import numpy as np
import pandas as pd

from .schemas import PlatformMetricRow, ConcertRow


# ── Platform helpers ──────────────────────────────────────────────────────────

PLATFORM_PRIMARY_METRIC = {
    "spotify":     "streams",
    "apple_music": "streams",
    "youtube":     "views",
    "instagram":   "followers",
    "facebook":    "followers",
    "twitter":     "followers",
}

ARTIST_TIER_BREAKS = [0, 10_000, 100_000, 500_000, 2_000_000, math.inf]
ARTIST_TIER_LABELS = ["micro", "rising", "mid", "major", "superstar"]


def metrics_to_df(metrics: list[PlatformMetricRow]) -> pd.DataFrame:
    """Convert list of metric rows into a tidy DataFrame indexed by (date, platform)."""
    rows = [r.model_dump() for r in metrics]
    df = pd.DataFrame(rows)
    df["date"] = pd.to_datetime(df["date"])
    df["platform"] = (
        df["platform"]
        .astype(str)
        .str.strip()
        .str.lower()
        .str.replace("-", "_", regex=False)
        .str.replace(" ", "_", regex=False)
    )
    df = df.sort_values("date").reset_index(drop=True)
    return df


def platform_series(df: pd.DataFrame, platform: str) -> pd.Series:
    """Return the primary metric time-series for a single platform."""
    col = PLATFORM_PRIMARY_METRIC.get(platform, "followers")
    sub = df[df["platform"] == platform][["date", col]].dropna()
    sub = sub.set_index("date")[col].sort_index()
    return sub


def rog(series: pd.Series, window: int) -> float:
    """
    Percentage rate-of-growth over `window` days.
    Uses the last available value vs the value `window` days before it.
    Returns 0.0 when there is insufficient data.
    """
    if len(series) < 2:
        return 0.0
    end_val = series.iloc[-1]
    cutoff = series.index[-1] - timedelta(days=window)
    past = series[series.index <= cutoff]
    if past.empty:
        return 0.0
    start_val = past.iloc[-1]
    if start_val <= 0:
        # Can't compute meaningful RoG from a zero or negative baseline;
        # fall back to absolute growth capped to avoid divide-by-zero.
        return 0.0
    return round((end_val - start_val) / start_val * 100, 4)


def exponential_smooth(series: pd.Series, alpha: float = 0.3) -> pd.Series:
    """Simple exponential smoothing to reduce viral-spike noise."""
    return series.ewm(alpha=alpha, adjust=False).mean()


def forecast_holt(series: pd.Series, steps: int) -> float:
    """
    Holt linear trend forecast (no seasonal component).
    Falls back to last value when series is too short.
    """
    s = exponential_smooth(series)
    if len(s) < 3:
        return float(s.iloc[-1]) if len(s) else 0.0
    try:
        from statsmodels.tsa.holtwinters import Holt
        model = Holt(s.values, initialization_method="estimated")
        fit = model.fit(optimized=True, remove_bias=True)
        pred = fit.forecast(steps)
        return max(0.0, float(pred[-1]))
    except Exception:
        # Graceful fallback: linear extrapolation
        slope = (float(s.iloc[-1]) - float(s.iloc[-3])) / 2
        return max(0.0, float(s.iloc[-1]) + slope * steps)


def detect_breakpoints(series: pd.Series, penalty: float = 5.0) -> list[str]:
    """
    Detect trend change-points using PELT (ruptures library).
    Returns ISO date strings of detected breakpoints.
    Falls back to [] if ruptures is not installed.
    """
    if len(series) < 14:
        return []
    try:
        import ruptures as rpt
        signal = series.values.reshape(-1, 1)
        algo = rpt.Pelt(model="rbf").fit(signal)
        bkps = algo.predict(pen=penalty)
        dates = []
        for idx in bkps[:-1]:   # last entry is always len(series)
            if 0 <= idx < len(series):
                dates.append(series.index[idx].date().isoformat())
        return dates
    except ImportError:
        return []


def infer_artist_tier(metrics: list[PlatformMetricRow]) -> str:
    """
    Assign an artist tier based on max follower count across social platforms.
    Streams/views are intentionally excluded — a niche artist can have high
    streams without being 'major'.
    """
    max_val = 0
    for m in metrics:
        v = getattr(m, "followers", None)
        if v and v > max_val:
            max_val = v
    for i, (lo, hi) in enumerate(zip(ARTIST_TIER_BREAKS, ARTIST_TIER_BREAKS[1:])):
        if lo <= max_val < hi:
            return ARTIST_TIER_LABELS[i]
    return "micro"


# ── Concert features ──────────────────────────────────────────────────────────

SEASON_MAP = {12: "winter", 1: "winter", 2: "winter",
              3: "spring", 4: "spring", 5: "spring",
              6: "summer", 7: "summer", 8: "summer",
              9: "autumn", 10: "autumn", 11: "autumn"}

WEEKEND_DAYS = {4, 5, 6}   # Fri, Sat, Sun (weekday() indices)


#: Reasonable default average ticket price (INR) used only when neither a
#: real event-specific price nor a caller-supplied fallback is available.
#: Mirrors the existing Node-side default (backend/src/services/madAnalytics.service.ts).
DEFAULT_AVG_TICKET_PRICE_INR = 1250.0


def concert_base_features(concert: ConcertRow) -> dict:
    """Numeric / categorical features derived from a single concert record.

    venue_capacity / ticket price are optional on ConcertRow. When present,
    the same existing formula is used unchanged. When absent, a null-safe
    placeholder is used here — callers that need the fully-resolved,
    provenance-aware capacity/price (e.g. the revenue predictor) overwrite
    these afterwards via resolve_venue_capacity() and their own price logic.
    """
    if concert.ticket_price_min is not None and concert.ticket_price_max is not None:
        # LLM Processor tier distribution: VIP (10%), Tier1 (20%), Tier2 (40%), Tier3 (30%)
        # This evaluates to a weighted average of min + 23.5% of the price range
        price_range = concert.ticket_price_max - concert.ticket_price_min
        avg_price = concert.ticket_price_min + (price_range * 0.235)
    else:
        price_range = 0.0
        avg_price = DEFAULT_AVG_TICKET_PRICE_INR

    capacity = concert.venue_capacity if concert.venue_capacity is not None else 0

    return {
        "venue_capacity":    capacity,
        "avg_ticket_price":  avg_price,
        "price_range":       price_range,
        "max_revenue_naive": capacity * avg_price,
        "is_weekend":        int(concert.date.weekday() in WEEKEND_DAYS),
        "month":             concert.date.month,
        "season":            SEASON_MAP[concert.date.month],
        "city":              concert.city,
        "country":           concert.country,
    }


def social_velocity(df: pd.DataFrame, days: int = 14) -> float:
    """
    Mean daily follower / stream growth across all platforms over last `days`.
    Normalised to [0, 1] via a log scale (asymptotes at 1M/day).
    """
    cutoff = df["date"].max() - timedelta(days=days)
    recent = df[df["date"] >= cutoff]
    total_growth = 0.0
    for platform, col in PLATFORM_PRIMARY_METRIC.items():
        sub = recent[recent["platform"] == platform][["date", col]].dropna()
        if len(sub) >= 2:
            total_growth += float(sub[col].iloc[-1] - sub[col].iloc[0])
    if total_growth <= 0:
        return 0.0
    return min(1.0, math.log1p(total_growth) / math.log1p(1_000_000))


def sell_through_rate(
    tickets_sold: Optional[int],
    venue_capacity: Optional[int],
    *,
    cap_at_one: bool = True,
) -> float:
    """
    Return tickets sold divided by venue capacity as a 0-1 rate.

    Missing values, zero capacity, and negative tickets are tre ated as 0.0.
    Oversold events are capped at 1.0 by default so downstream demand scores
    stay in their expected range.
    """
    if tickets_sold is None or venue_capacity is None or venue_capacity <= 0:
        return 0.0

    sold = max(0.0, float(tickets_sold))
    rate = sold / float(venue_capacity)
    if cap_at_one:
        rate = min(rate, 1.0)
    return round(rate, 4)


def sell_through_percentage(
    tickets_sold: Optional[int],
    venue_capacity: Optional[int],
    *,
    cap_at_100: bool = True,
) -> float:
    """Return sell-through as a percentage on a 0-100 scale."""
    return round(
        sell_through_rate(
            tickets_sold,
            venue_capacity,
            cap_at_one=cap_at_100,
        ) * 100,
        2,
    )


def ticket_velocity(concerts: list[ConcertRow], days_back: int = 90) -> float:
    """
    Ratio of tickets sold vs capacity across recent concerts.
    Returns 0.0 when no sold-out data is available.
    """
    if not concerts:
        return 0.0
    cutoff = date.today() - timedelta(days=days_back)
    today = date.today()
    ratios = [
        sell_through_rate(c.tickets_sold, c.venue_capacity)
        for c in concerts
        if cutoff <= c.date <= today
        and c.tickets_sold is not None
        and c.venue_capacity is not None
    ]
    if not ratios:
        return 0.0
    return round(float(np.mean(ratios)), 4)


def seasonality_factor(target_date: date, city: str = "") -> float:
    """
    Month-of-year + weekend multiplier as a 0-1 score.
    This keeps the repo's existing demand curve, where late-summer weekends are
    the strongest and winter weekdays are softer.
    """
    month_weights = {
        1: 0.55, 2: 0.50, 3: 0.60, 4: 0.70, 5: 0.75, 6: 0.90,
        7: 0.95, 8: 1.00, 9: 0.85, 10: 0.80, 11: 0.65, 12: 0.60,
    }
    base = month_weights.get(target_date.month, 0.7)
    weekend_bonus = 0.1 if target_date.weekday() in WEEKEND_DAYS else 0.0
    return min(1.0, base + weekend_bonus)


def resolve_venue_capacity(
    venue_name: str,
    city: str,
    *,
    country: str = "",
    venue_type: str = "",
    artist_tier: Optional[str] = None,
    supplied_capacity: Optional[int] = None,
    source_texts: Optional[list[str]] = None,
    db_url: Optional[str] = None,
    enable_web_search: bool = True,
):
    """Resolve venue capacity with extraction, DB lookup, validation, and fallback estimation."""
    from ..venue_capacity.resolver import resolve_venue_capacity as _resolve_venue_capacity
    from .schemas import VenueCapacityInput

    return _resolve_venue_capacity(
        VenueCapacityInput(
            venue_name=venue_name or "venue",
            city=city,
            country=country,
            venue_type=venue_type or "",
            artist_tier=artist_tier,
            supplied_capacity=supplied_capacity,
            source_texts=source_texts or [],
            db_url=db_url,
            enable_web_search=enable_web_search,
        )
    )


def infer_venue_capacity(city: str, artist_tier: str) -> int:
    """
    Infer venue capacity based on Indian city tier and artist tier.
    Useful when explicit capacity is not available.
    """
    capacity_result = resolve_venue_capacity(
        "venue",
        city,
        country="",
        artist_tier=artist_tier,
    )
    return int(capacity_result.capacity)


def artist_city_popularity(global_popularity: float, city: str, genre_affinity: float = 1.0) -> float:
    """
    Calculate artist city popularity based on their global popularity, 
    the city's market size in India, and an optional genre/language affinity multiplier.
    Returns a score from 0 to 100.
    """
    city_lower = (city or "").lower()
    
    # Market penetration multipliers for Indian cities
    market_multipliers = {
        "mumbai": 1.20,
        "delhi": 1.15,
        "new delhi": 1.15,
        "bangalore": 1.20, 
        "bengaluru": 1.20,
        "hyderabad": 1.05,
        "pune": 1.10,
        "kolkata": 0.95,
        "chennai": 0.90,  # Highly dependent on genre (e.g. Tamil/International vs Bollywood)
        "ahmedabad": 0.85,
        "chandigarh": 0.90, # High affinity for Punjabi music
        "jaipur": 0.80
    }
    
    # Default to 0.7 for smaller/tier-3 cities
    multiplier = market_multipliers.get(city_lower, 0.7)

    city_pop = global_popularity * multiplier * genre_affinity
    return min(100.0, max(0.0, city_pop))


# ── Genre style — per-artist platform-weight tilt (Phase 3, Day 6, 2026-09) ────
#
# WHY THIS EXISTS: the real `genre` DB field is unusable for this — it's "Pop"
# for almost every one of the 11 artists — so this is a small, manually
# curated style tag per artist instead. A regional/folk artist's real fanbase
# shows up more on YouTube than Spotify; treating every artist identically
# under- or over-counts them in both Popularity's base entropy score and
# Demand's Platform Size. Shared here (not duplicated in each module) so
# Popularity and Demand can never drift onto two different genre tag lists.
#
# Curated for the locked 11-artist V1 roster, plus Diljit Dosanjh (added
# 2026-09 as a deliberate calibration/benchmark case — a genuine stadium-
# selling headliner whose streaming numbers alone don't obviously top the
# roster, useful for sanity-checking whether these formulas track real-world
# popularity or just social-platform size). An artist not in
# ARTIST_GENRE_STYLE gets NO tilt (their existing weights are used as-is) —
# we never guess a genre or a platform adjustment from missing data.

ARTIST_GENRE_STYLE: dict[str, str] = {
    "arijit singh":        "mainstream_bollywood",
    "shreya ghoshal":      "mainstream_bollywood",
    "sonu nigam":          "mainstream_bollywood",
    "ayushmann khurrana":  "mainstream_bollywood",
    "sachet parampara":    "mainstream_bollywood",
    "amaal mallik":        "mainstream_bollywood",
    "aparshakti khurana":  "mainstream_bollywood",
    "armaan malik":        "modern_pop_crossover",
    "vishal mishra":       "modern_pop_crossover",
    "hansraj raghuwanshi": "regional_folk",
    "neeraj shridhar":     "pop_remix",
    # Diljit's actual platform numbers (Spotify/YouTube/Instagram/Facebook, all
    # in the 8-27M range) are far more balanced than Hansraj's YouTube-heavy
    # regional_folk profile, and closer in shape to Armaan Malik/Vishal
    # Mishra's -- modern_pop_crossover (untilted) fits without inventing a tilt
    # we don't have evidence for.
    "diljit dosanjh":      "modern_pop_crossover",
}

#: Multiplicative tilt applied to a platform's default weight, then the whole
#: weight dict is renormalized back to its original sum. 1.0 = no change.
#: Only regional_folk and pop_remix get a real tilt for V1 — mainstream_bollywood
#: and modern_pop_crossover already match what the existing weights were
#: calibrated against (9 of the 11-artist roster is mainstream Bollywood), so a
#: tilt for them would be invented precision we don't have evidence for.
GENRE_STYLE_PLATFORM_TILT: dict[str, dict[str, float]] = {
    "regional_folk": {"youtube": 1.5, "spotify": 0.6},
    "pop_remix":     {"spotify": 1.15, "youtube": 0.9},
}


def genre_style_for_artist_name(name: Optional[str]) -> Optional[str]:
    """Resolve an artist's curated genre-style tag from their DB artistName.
    None for any artist not in the curated V1 roster table."""
    if not name:
        return None
    return ARTIST_GENRE_STYLE.get(name.strip().lower())


def apply_genre_tilt(weights: dict[str, float], genre_style: Optional[str]) -> dict[str, float]:
    """Apply a genre-style platform-weight tilt and renormalize back to the
    original weights' sum (so a tilted weight dict stays comparable/bounded
    exactly like the untilted one).

    Pure — no DB, offline-testable. A genre_style with no tilt entry (or
    None) returns the original weights unchanged.
    """
    tilt = GENRE_STYLE_PLATFORM_TILT.get(genre_style or "", {})
    if not tilt:
        return dict(weights)

    target_total = sum(weights.values())
    if target_total <= 0:
        return dict(weights)

    tilted = {platform: w * tilt.get(platform, 1.0) for platform, w in weights.items()}
    tilted_total = sum(tilted.values())
    if tilted_total <= 0:
        return dict(weights)

    return {platform: (w / tilted_total) * target_total for platform, w in tilted.items()}

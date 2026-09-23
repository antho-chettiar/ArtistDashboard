"""
engagement/scorer.py
Engagement ratios -- a "true fan" proxy, stronger than raw follower count for
demand (a large but passive following engages less than a smaller, genuinely
engaged one). Built 2026-09 per Anthony's request to reduce booking-decision
ambiguity beyond the existing touring-history/feasibility signals.

CRITICAL DESIGN RULE: only ever divide two numbers on the SAME time-basis.
viberate_metrics_daily mixes lifetime-cumulative totals (e.g. youtube_likes,
youtube_views, spotify_streams -- accumulated since the channel/account began)
with current-snapshot counts (youtube_subscribers, spotify_followers,
spotify_listeners -- a point-in-time reading). Dividing a cumulative total by
a snapshot count (e.g. the naive youtube_likes / youtube_subscribers) produces
a nonsense number > 1 that LOOKS like a plausible percentage but measures
nothing real -- this was caught live during this exact build (Armaan Malik
came back at 1855%) and is the same category of mistake as the Growth Trends
chart's cumulative-Spotify-streams incident earlier this session. Every ratio
below pairs same-basis numbers only:
  - youtube_like_rate    = youtube_likes / youtube_views       (both lifetime-cumulative)
  - spotify_follow_rate  = spotify_followers / spotify_listeners  (both current snapshots;
                            a real, industry-standard "follower conversion rate")

PLATFORM LIMITATIONS (checked 2026-09-23, not a fixable gap):
  - Instagram: likes/comments are NEVER populated by Viberate's API -- 0 of
    726 collected rows have a value, across every artist. A real platform-
    side API restriction, not something more scraping would fix.
  - Facebook: no likes/reactions metric was ever collected at all (only a
    follower count exists) -- there is nothing to compute a ratio from.
  - TikTok: excluded ENTIRELY, deliberately, even though data exists for it --
    TikTok has been banned in India since 2020, so any TikTok number reflects
    only an artist's international/diaspora audience, not the India-only
    market this platform covers, and would be actively misleading here.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import text

from ..utils.db import get_engine
from ..utils.schemas import EngagementOutput


def engagement_rate(artist_id: str, db_url: Optional[str] = None) -> EngagementOutput:
    """Latest known engagement ratios for this artist. Computed only when
    BOTH same-basis inputs are real, non-null, positive numbers -- never a
    fabricated value standing in for missing data. See module docstring for
    why each ratio pairs the specific metrics it does, and which platforms
    have no honest ratio available at all."""
    engine = get_engine(db_url)
    try:
        with engine.connect() as conn:
            rows = conn.execute(
                text(
                    'SELECT "metricName", "totalValue" FROM viberate_metrics_daily '
                    'WHERE "artistId" = :aid ORDER BY date DESC'
                ),
                {"aid": artist_id},
            ).mappings().all()
    finally:
        if db_url is not None:
            engine.dispose()

    # First (most recent, since rows are date-DESC) non-null value wins per metric.
    latest: dict[str, float] = {}
    for r in rows:
        name = r["metricName"]
        if name in latest or r["totalValue"] is None:
            continue
        latest[name] = float(r["totalValue"])

    def _ratio(numerator_key: str, denominator_key: str) -> Optional[float]:
        num = latest.get(numerator_key)
        den = latest.get(denominator_key)
        if not num or not den:
            return None
        return round(num / den, 4)

    return EngagementOutput(
        artist_id=artist_id,
        youtube_like_rate=_ratio("youtube_likes", "youtube_views"),
        spotify_follow_rate=_ratio("spotify_followers", "spotify_listeners"),
        instagram_engagement_rate=None,  # never available -- see module docstring
        facebook_engagement_rate=None,   # never available -- see module docstring
        computed_at=datetime.now(timezone.utc).isoformat(),
    )

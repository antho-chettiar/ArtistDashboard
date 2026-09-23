"""
tests/test_engagement.py
See engagement/scorer.py's module docstring for the WHY behind each ratio's
same-time-basis pairing and the Instagram/Facebook/TikTok exclusions.
"""
from __future__ import annotations
import tempfile

from sqlalchemy import create_engine, text

from mad_analytics.engagement import engagement_rate


def _seed_metrics(db_url: str, rows: list[tuple[str, str, float]]):
    """rows: (artist_id, metric_name, total_value)."""
    engine = create_engine(db_url)
    with engine.begin() as conn:
        conn.execute(text(
            '''
            CREATE TABLE viberate_metrics_daily (
                id TEXT PRIMARY KEY,
                "artistId" TEXT NOT NULL,
                "metricName" TEXT,
                date TEXT,
                "totalValue" REAL
            )
            '''
        ))
        for i, (artist_id, metric_name, value) in enumerate(rows):
            conn.execute(text(
                'INSERT INTO viberate_metrics_daily (id, "artistId", "metricName", date, "totalValue") '
                'VALUES (:id, :aid, :name, :date, :val)'
            ), {"id": f"m{i}", "aid": artist_id, "name": metric_name, "date": "2026-09-01", "val": value})
    engine.dispose()


class TestEngagementRate:
    def test_youtube_like_rate_uses_same_basis_metrics(self):
        """likes / views (both lifetime-cumulative), never likes / subscribers
        (a snapshot) -- see the module docstring for why that's wrong."""
        with tempfile.TemporaryDirectory() as tmpdir:
            db_url = f"sqlite+pysqlite:///{tmpdir}/eng.db"
            _seed_metrics(db_url, [
                ("artist-1", "youtube_likes", 1_000_000),
                ("artist-1", "youtube_views", 100_000_000),
                ("artist-1", "youtube_subscribers", 500_000),
            ])
            out = engagement_rate("artist-1", db_url=db_url)
            assert out.youtube_like_rate == 0.01

    def test_spotify_follow_rate(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_url = f"sqlite+pysqlite:///{tmpdir}/eng.db"
            _seed_metrics(db_url, [
                ("artist-1", "spotify_followers", 2_000_000),
                ("artist-1", "spotify_listeners", 4_000_000),
            ])
            out = engagement_rate("artist-1", db_url=db_url)
            assert out.spotify_follow_rate == 0.5

    def test_instagram_and_facebook_always_none(self):
        """Never fabricated -- these platforms have no honest ratio available
        regardless of what other data exists for the artist."""
        with tempfile.TemporaryDirectory() as tmpdir:
            db_url = f"sqlite+pysqlite:///{tmpdir}/eng.db"
            _seed_metrics(db_url, [
                ("artist-1", "youtube_likes", 1_000_000),
                ("artist-1", "youtube_views", 100_000_000),
            ])
            out = engagement_rate("artist-1", db_url=db_url)
            assert out.instagram_engagement_rate is None
            assert out.facebook_engagement_rate is None

    def test_missing_denominator_is_none_not_zero_division(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_url = f"sqlite+pysqlite:///{tmpdir}/eng.db"
            _seed_metrics(db_url, [("artist-1", "youtube_likes", 1_000_000)])
            out = engagement_rate("artist-1", db_url=db_url)
            assert out.youtube_like_rate is None

    def test_no_data_at_all_is_all_none_not_fabricated(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_url = f"sqlite+pysqlite:///{tmpdir}/eng.db"
            _seed_metrics(db_url, [])
            out = engagement_rate("artist-with-no-data", db_url=db_url)
            assert out.youtube_like_rate is None
            assert out.spotify_follow_rate is None

"""
tests/test_audience_city.py
See audience_city/scorer.py's module docstring for the WHY (Touring
Precedent's blind spot) and the metric-name/no-fabrication conventions this
mirrors from test_engagement.py.
"""
from __future__ import annotations
import tempfile

from sqlalchemy import create_engine, text

from mad_analytics.audience_city import city_audience_index, city_audience_presence


def _seed_city_metrics(db_url: str, rows: list[tuple[str, str, str, float, str]]):
    """rows: (artist_id, metric_name, city, total_value, date)."""
    engine = create_engine(db_url)
    with engine.begin() as conn:
        conn.execute(text(
            '''
            CREATE TABLE viberate_metrics_daily (
                id TEXT PRIMARY KEY,
                "artistId" TEXT NOT NULL,
                "metricName" TEXT,
                date TEXT,
                "totalValue" REAL,
                city TEXT
            )
            '''
        ))
        for i, (artist_id, metric_name, city, value, date) in enumerate(rows):
            conn.execute(text(
                'INSERT INTO viberate_metrics_daily (id, "artistId", "metricName", date, "totalValue", city) '
                'VALUES (:id, :aid, :name, :date, :val, :city)'
            ), {"id": f"m{i}", "aid": artist_id, "name": metric_name, "date": date, "val": value, "city": city})
    engine.dispose()


class TestCityAudienceIndex:
    def test_indexes_by_normalized_city_key(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_url = f"sqlite+pysqlite:///{tmpdir}/aud.db"
            _seed_city_metrics(db_url, [
                ("artist-1", "audience_city_monthly_listeners_pct", "Bengaluru", 23.7, "2026-09-01"),
            ])
            index = city_audience_index("artist-1", db_url=db_url)
            assert index["bengaluru"]["audience_city_monthly_listeners_pct"] == 23.7

    def test_city_alias_variants_are_summed_not_overwritten(self):
        """Viberate geo-tags the same metro under two spellings for some
        artists (seen for real on this roster) -- "Delhi" and "New Delhi"
        both normalize to "delhi" and must combine into one real total, not
        have one silently overwrite the other."""
        with tempfile.TemporaryDirectory() as tmpdir:
            db_url = f"sqlite+pysqlite:///{tmpdir}/aud.db"
            _seed_city_metrics(db_url, [
                ("artist-1", "audience_city_monthly_listeners_pct", "Delhi", 7.7, "2026-09-01"),
                ("artist-1", "audience_city_monthly_listeners_pct", "New Delhi", 8.2, "2026-09-01"),
            ])
            index = city_audience_index("artist-1", db_url=db_url)
            assert index["delhi"]["audience_city_monthly_listeners_pct"] == round(7.7 + 8.2, 4) or \
                abs(index["delhi"]["audience_city_monthly_listeners_pct"] - 15.9) < 1e-9

    def test_latest_date_wins_per_city_metric(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_url = f"sqlite+pysqlite:///{tmpdir}/aud.db"
            _seed_city_metrics(db_url, [
                ("artist-1", "audience_city_monthly_listeners_pct", "Mumbai", 5.0, "2026-08-01"),
                ("artist-1", "audience_city_monthly_listeners_pct", "Mumbai", 9.0, "2026-09-01"),
            ])
            index = city_audience_index("artist-1", db_url=db_url)
            assert index["mumbai"]["audience_city_monthly_listeners_pct"] == 9.0

    def test_no_rows_at_all_is_empty_index_not_fabricated(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_url = f"sqlite+pysqlite:///{tmpdir}/aud.db"
            _seed_city_metrics(db_url, [])
            assert city_audience_index("artist-with-no-data", db_url=db_url) == {}


class TestCityAudiencePresence:
    def test_available_when_any_metric_present(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_url = f"sqlite+pysqlite:///{tmpdir}/aud.db"
            _seed_city_metrics(db_url, [
                ("artist-1", "audience_city_monthly_listeners_pct", "Pune", 22.0, "2026-09-01"),
            ])
            out = city_audience_presence("artist-1", "Pune", db_url=db_url)
            assert out.available is True
            assert out.monthly_listeners_pct == 22.0
            assert out.monthly_views is None       # never fabricated -- Viberate didn't return this column
            assert out.total_followers_pct is None

    def test_unavailable_city_is_all_none_not_fabricated_zero(self):
        """Same standard as engagement_rate()'s no-data case: absence reads
        as None throughout, never a plausible-looking 0."""
        with tempfile.TemporaryDirectory() as tmpdir:
            db_url = f"sqlite+pysqlite:///{tmpdir}/aud.db"
            _seed_city_metrics(db_url, [
                ("artist-1", "audience_city_monthly_listeners_pct", "Pune", 22.0, "2026-09-01"),
            ])
            out = city_audience_presence("artist-1", "Chennai", db_url=db_url)
            assert out.available is False
            assert out.monthly_listeners_pct is None
            assert out.monthly_views is None
            assert out.total_followers_pct is None

    def test_city_name_is_normalized_before_lookup(self):
        """"Bangalore" (a common alias) must find the same row stored as
        "Bengaluru" -- same alias table as City Affinity / Touring Precedent."""
        with tempfile.TemporaryDirectory() as tmpdir:
            db_url = f"sqlite+pysqlite:///{tmpdir}/aud.db"
            _seed_city_metrics(db_url, [
                ("artist-1", "audience_city_monthly_listeners_pct", "Bengaluru", 23.7, "2026-09-01"),
            ])
            out = city_audience_presence("artist-1", "Bangalore", db_url=db_url)
            assert out.available is True
            assert out.monthly_listeners_pct == 23.7

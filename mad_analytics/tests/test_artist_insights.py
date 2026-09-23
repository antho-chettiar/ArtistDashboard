from __future__ import annotations

import tempfile

from sqlalchemy import create_engine, text

from mad_analytics.touring_history.scorer import artist_insights


def _seed(db_url: str, concerts: list[tuple], audience_rows: list[tuple] | None = None):
    """concerts: (id, artistId, artistName, city, date, venueName, capacity).
    audience_rows: (artistId, metricName, city, totalValue). Same fixture
    shape as test_dashboard_highlights.py's _seed -- duplicated rather than
    cross-imported, matching this test suite's existing convention of each
    file owning its own fixture (see test_touring_history.py, test_feasibility.py)."""
    engine = create_engine(db_url)
    with engine.begin() as conn:
        conn.execute(text(
            'CREATE TABLE artists (id TEXT PRIMARY KEY, "artistName" TEXT NOT NULL)'
        ))
        conn.execute(text(
            '''
            CREATE TABLE concerts (
                id TEXT PRIMARY KEY, "artistId" TEXT NOT NULL, city TEXT,
                "concertDate" TEXT, "venueName" TEXT, capacity INTEGER
            )
            '''
        ))
        conn.execute(text(
            '''
            CREATE TABLE viberate_metrics_daily (
                id TEXT PRIMARY KEY, "artistId" TEXT NOT NULL, "metricName" TEXT,
                date TEXT, "totalValue" REAL, city TEXT
            )
            '''
        ))
        seen_artists = set()
        for cid, artist_id, artist_name, city, concert_date, venue, capacity in concerts:
            if artist_id not in seen_artists:
                conn.execute(text('INSERT INTO artists (id, "artistName") VALUES (:id, :name)'),
                             {"id": artist_id, "name": artist_name})
                seen_artists.add(artist_id)
            conn.execute(text(
                'INSERT INTO concerts (id, "artistId", city, "concertDate", "venueName", capacity) '
                'VALUES (:id, :aid, :city, :date, :venue, :cap)'
            ), {"id": cid, "aid": artist_id, "city": city, "date": concert_date,
                "venue": venue, "cap": capacity})
        for i, (artist_id, metric, city, value) in enumerate(audience_rows or []):
            conn.execute(text(
                'INSERT INTO viberate_metrics_daily (id, "artistId", "metricName", date, "totalValue", city) '
                'VALUES (:id, :aid, :metric, :date, :value, :city)'
            ), {"id": f"vmd-{i}", "aid": artist_id, "metric": metric, "date": "2026-09-01",
                "value": value, "city": city})
    engine.dispose()


def test_artist_with_no_concerts_gets_no_fabricated_insights():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_url = f"sqlite+pysqlite:///{tmpdir}/ai.db"
        _seed(db_url, [
            ("c1", "other-artist", "Other Artist", "Mumbai", "2020-01-01", "Hall", 5000),
        ])
        # artist-1 exists in no concert row at all -- artist_insights() still
        # needs a name lookup, so seed it via the artists table indirectly by
        # giving it zero concerts of its own.
        result = artist_insights("artist-1", db_url=db_url)

    assert result.insights == []


def test_widest_reach_only_claims_roster_superlative_when_actually_true():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_url = f"sqlite+pysqlite:///{tmpdir}/ai.db"
        _seed(db_url, [
            # artist-1: 2 cities -- NOT the roster's widest
            ("c1", "artist-1", "Narrow Artist", "Mumbai", "2020-01-01", "Hall", 5000),
            ("c2", "artist-1", "Narrow Artist", "Delhi", "2020-02-01", "Hall", 5000),
            # artist-2: 4 cities -- the actual roster-wide widest
            ("c3", "artist-2", "Wide Artist", "Mumbai", "2021-01-01", "Hall", 5000),
            ("c4", "artist-2", "Wide Artist", "Delhi", "2021-02-01", "Hall", 5000),
            ("c5", "artist-2", "Wide Artist", "Chennai", "2021-03-01", "Hall", 5000),
            ("c6", "artist-2", "Wide Artist", "Kolkata", "2021-04-01", "Hall", 5000),
        ])
        narrow = artist_insights("artist-1", db_url=db_url)
        wide = artist_insights("artist-2", db_url=db_url)

    narrow_reach = next(i for i in narrow.insights if i.insight_type == "widest_reach")
    wide_reach = next(i for i in wide.insights if i.insight_type == "widest_reach")
    assert "widest reach in the roster" not in narrow_reach.headline
    assert "2 different cities" in narrow_reach.headline
    assert "widest reach in the roster" in wide_reach.headline


def test_overdue_with_demand_requires_real_corroboration():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_url = f"sqlite+pysqlite:///{tmpdir}/ai.db"
        _seed(
            db_url,
            [
                ("c1", "artist-1", "Gone Quiet Artist", "Bengaluru", "2010-01-01", "Hall", 5000),
                ("c2", "artist-2", "Corroborated Artist", "Chennai", "2010-01-01", "Hall", 5000),
            ],
            audience_rows=[
                ("artist-2", "audience_city_monthly_listeners_pct", "Chennai", 18.4),
            ],
        )
        gone_quiet = artist_insights("artist-1", db_url=db_url)
        corroborated = artist_insights("artist-2", db_url=db_url)

    # No real digital-demand signal for artist-1's overdue city -> no insight,
    # never a fabricated one just to fill the slot.
    assert not any(i.insight_type == "overdue_with_demand" for i in gone_quiet.insights)
    overdue = next(i for i in corroborated.insights if i.insight_type == "overdue_with_demand")
    assert "Chennai" in overdue.headline
    assert "18.4%" in overdue.detail


def test_untested_promising_excludes_cities_already_played():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_url = f"sqlite+pysqlite:///{tmpdir}/ai.db"
        _seed(
            db_url,
            [("c1", "artist-1", "Test Artist", "Mumbai", "2023-01-01", "Hall", 5000)],
            audience_rows=[
                # Real demand in a city they've PLAYED -- must not count as "untested"
                ("artist-1", "audience_city_monthly_listeners_pct", "Mumbai", 30.0),
                # Real demand in a city they've NEVER played -- the real untested case
                ("artist-1", "audience_city_monthly_listeners_pct", "Pune", 14.2),
            ],
        )
        result = artist_insights("artist-1", db_url=db_url)

    untested = next(i for i in result.insights if i.insight_type == "untested_promising")
    assert "Pune" in untested.headline
    assert "Mumbai" not in untested.headline


def test_most_consistent_requires_at_least_three_distinct_cities():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_url = f"sqlite+pysqlite:///{tmpdir}/ai.db"
        _seed(db_url, [
            # Only 2 distinct cities, one repeated -- rate would be a hollow 50%
            ("c1", "artist-1", "Small Sample Artist", "Mumbai", "2020-01-01", "Hall", 5000),
            ("c2", "artist-1", "Small Sample Artist", "Mumbai", "2021-01-01", "Hall", 5000),
            ("c3", "artist-1", "Small Sample Artist", "Delhi", "2020-06-01", "Hall", 5000),
        ])
        result = artist_insights("artist-1", db_url=db_url)

    assert not any(i.insight_type == "most_consistent" for i in result.insights)

from __future__ import annotations

import tempfile
from datetime import date

from sqlalchemy import create_engine, text

from mad_analytics.touring_history.scorer import _biggest_verified_show, dashboard_highlights


def _seed(db_url: str, concerts: list[tuple], audience_rows: list[tuple] | None = None):
    """concerts: (id, artistId, artistName, city, date, venueName, capacity).
    audience_rows: (artistId, metricName, city, totalValue)."""
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


def test_biggest_verified_show_picks_max_capacity_with_real_venue():
    rows = [
        {"artistName": "A", "venueName": "Small Club", "capacity": 500, "city": "pune",
         "concertDate": date(2024, 1, 1)},
        {"artistName": "B", "venueName": "Big Stadium", "capacity": 60000, "city": "delhi",
         "concertDate": date(2024, 2, 1)},
        {"artistName": "C", "venueName": None, "capacity": 90000, "city": "mumbai",
         "concertDate": date(2024, 3, 1)},  # no venue name -> excluded even though bigger
        {"artistName": "D", "venueName": "Unknown Cap", "capacity": None, "city": "goa",
         "concertDate": date(2024, 4, 1)},  # no capacity -> excluded
    ]

    result = _biggest_verified_show(rows)

    assert result is not None
    assert "Big Stadium" in result.headline
    assert "60,000" in result.detail


def test_biggest_verified_show_is_none_when_nothing_qualifies():
    rows = [{"artistName": "A", "venueName": None, "capacity": None, "city": "pune",
              "concertDate": date(2024, 1, 1)}]

    assert _biggest_verified_show(rows) is None


def test_dashboard_highlights_produces_nine_distinct_real_insights():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_url = f"sqlite+pysqlite:///{tmpdir}/dh.db"
        _seed(db_url, [
            # Most-repeated + longest-relationship: artist-1 x Mumbai, 3 visits over years
            ("c1", "artist-1", "Loyal Artist", "Mumbai", "2015-01-01", "Arena", 20000),
            ("c2", "artist-1", "Loyal Artist", "Mumbai", "2019-01-01", "Arena", 20000),
            ("c3", "artist-1", "Loyal Artist", "Mumbai", "2023-01-01", "Arena", 20000),
            # Widest reach: artist-2 plays 4 distinct cities once each
            ("c4", "artist-2", "Wide Reach Artist", "Delhi", "2022-01-01", "Hall", 5000),
            ("c5", "artist-2", "Wide Reach Artist", "Chennai", "2022-02-01", "Hall", 5000),
            ("c6", "artist-2", "Wide Reach Artist", "Kolkata", "2022-03-01", "Hall", 5000),
            ("c7", "artist-2", "Wide Reach Artist", "Pune", "2022-04-01", "Hall", 5000),
            # Biggest verified show: artist-3, one huge stadium date
            ("c8", "artist-3", "Stadium Artist", "Ahmedabad", "2021-01-01", "Megadome", 90000),
            # Most consistent: artist-1 already qualifies (3 distinct cities min) --
            # give it 3 cities, 2 of them repeats, so repeat_rate is high and unambiguous
            ("c9", "artist-1", "Loyal Artist", "Delhi", "2016-01-01", "Hall", 5000),
            ("c10", "artist-1", "Loyal Artist", "Delhi", "2020-01-01", "Hall", 5000),
            ("c11", "artist-1", "Loyal Artist", "Chennai", "2017-01-01", "Hall", 5000),
        ])

        result = dashboard_highlights(revisit_threshold_days=99999, db_url=db_url)

    insight_types = {h.insight_type for h in result.highlights}
    assert insight_types == {
        "most_repeated", "longest_relationship", "widest_reach",
        "biggest_show", "most_consistent", "career_origin",
        "longest_dry_spell", "busiest_year", "geographic_breadth",
    }
    by_type = {h.insight_type: h for h in result.highlights}
    assert "Loyal Artist" in by_type["most_repeated"].headline
    assert "Wide Reach Artist" in by_type["widest_reach"].headline
    assert "Stadium Artist" in by_type["biggest_show"].headline
    assert "01 Jan 2015" in by_type["career_origin"].detail  # earliest of all seeded dates
    assert "3.0 years" in by_type["longest_dry_spell"].headline  # Loyal Artist: Jan 2020 -> Jan 2023
    assert "2022" in by_type["busiest_year"].headline and "4 shows" in by_type["busiest_year"].detail
    assert "4 different states" in by_type["geographic_breadth"].headline  # Wide Reach: Delhi/Chennai/Kolkata/Pune


def test_revisit_reminders_prioritize_corroborated_demand_signal_over_raw_elapsed_time():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_url = f"sqlite+pysqlite:///{tmpdir}/dh.db"
        _seed(
            db_url,
            [
                # Much longer gap, but NO corroborating digital-demand data
                ("c1", "artist-1", "No Signal Artist", "Mumbai", "2010-01-01", "Hall", 5000),
                # Shorter gap, but a real audience_city signal exists for it
                ("c2", "artist-2", "Signal Artist", "Delhi", "2018-01-01", "Hall", 5000),
            ],
            audience_rows=[
                ("artist-2", "audience_city_monthly_listeners_pct", "Delhi", 22.5),
            ],
        )

        result = dashboard_highlights(revisit_threshold_days=365, db_url=db_url)

    assert len(result.revisit_reminders) == 2
    # The corroborated, shorter-gap pair must rank first despite the other
    # pair being overdue by far more days -- elapsed time alone is not
    # evidence of a real opportunity (see the module docstring).
    assert result.revisit_reminders[0].artist_name == "Signal Artist"
    assert result.revisit_reminders[0].demand_signal_pct == 22.5
    assert result.revisit_reminders[1].artist_name == "No Signal Artist"
    assert result.revisit_reminders[1].demand_signal_pct is None

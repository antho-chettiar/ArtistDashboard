from __future__ import annotations

import tempfile

from sqlalchemy import create_engine, text

from mad_analytics.touring_history import repeat_visit_rate, touring_precedent


def _seed_concerts(db_url: str, rows: list[tuple[str, str, str, str]]):
    """rows: (concert_id, artist_id, city, date)"""
    engine = create_engine(db_url)
    with engine.begin() as conn:
        conn.execute(text(
            """
            CREATE TABLE concerts (
                id TEXT PRIMARY KEY,
                "artistId" TEXT NOT NULL,
                city TEXT,
                "concertDate" TEXT,
                "venueName" TEXT
            )
            """
        ))
        for concert_id, artist_id, city, date in rows:
            conn.execute(text(
                'INSERT INTO concerts (id, "artistId", city, "concertDate", "venueName") '
                'VALUES (:id, :aid, :city, :date, NULL)'
            ), {"id": concert_id, "aid": artist_id, "city": city, "date": date})
    engine.dispose()


def test_touring_precedent_finds_real_repeat_visits():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_url = f"sqlite+pysqlite:///{tmpdir}/touring.db"
        _seed_concerts(db_url, [
            ("c1", "artist-1", "Ahmedabad", "2024-11-17"),
            ("c2", "artist-1", "Ahmedabad", "2026-11-21"),
            ("c3", "artist-1", "Delhi", "2024-10-26"),
        ])

        result = touring_precedent("artist-1", "Ahmedabad", db_url=db_url)

    assert result.has_precedent is True
    assert result.visit_count == 2
    assert result.first_visit == "2024-11-17"
    assert result.last_visit == "2026-11-21"


def test_touring_precedent_is_honest_about_zero_history():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_url = f"sqlite+pysqlite:///{tmpdir}/touring.db"
        _seed_concerts(db_url, [
            ("c1", "artist-1", "Delhi", "2024-10-26"),
        ])

        # Same artist, but a city they've never played -- must report zero,
        # never a fabricated/interpolated value.
        result = touring_precedent("artist-1", "Chennai", db_url=db_url)

    assert result.has_precedent is False
    assert result.visit_count == 0
    assert result.visits == []
    assert result.first_visit is None
    assert result.last_visit is None


def test_touring_precedent_normalizes_city_aliases():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_url = f"sqlite+pysqlite:///{tmpdir}/touring.db"
        _seed_concerts(db_url, [
            ("c1", "artist-1", "Bangalore", "2023-01-01"),
            ("c2", "artist-1", "Bengaluru", "2025-01-01"),
        ])

        # Same real city under its two common spellings should count as one
        # touring history, not two separate cities.
        result = touring_precedent("artist-1", "Bengaluru", db_url=db_url)

    assert result.visit_count == 2


def test_repeat_visit_rate_never_uses_raw_concert_count():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_url = f"sqlite+pysqlite:///{tmpdir}/touring.db"
        _seed_concerts(db_url, [
            # Artist plays 3 different cities once each, and returns to a 4th
            # twice -- 4 distinct cities, 1 of them a repeat -> 0.25, NOT a
            # function of the raw 5 total concerts logged.
            ("c1", "artist-1", "Mumbai", "2024-01-01"),
            ("c2", "artist-1", "Delhi", "2024-02-01"),
            ("c3", "artist-1", "Chennai", "2024-03-01"),
            ("c4", "artist-1", "Kolkata", "2024-04-01"),
            ("c5", "artist-1", "Kolkata", "2025-04-01"),
        ])

        result = repeat_visit_rate("artist-1", db_url=db_url)

    assert result.distinct_cities == 4
    assert result.repeat_cities == 1
    assert result.repeat_rate == 0.25


def test_repeat_visit_rate_is_zero_not_fabricated_for_no_history():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_url = f"sqlite+pysqlite:///{tmpdir}/touring.db"
        _seed_concerts(db_url, [])

        result = repeat_visit_rate("artist-with-no-concerts", db_url=db_url)

    assert result.distinct_cities == 0
    assert result.repeat_cities == 0
    assert result.repeat_rate == 0.0

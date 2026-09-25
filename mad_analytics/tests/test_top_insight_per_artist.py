from __future__ import annotations

import tempfile

from sqlalchemy import create_engine, text

from mad_analytics.touring_history.scorer import top_insight_per_artist


def _seed(db_url: str, concerts: list[tuple]):
    """concerts: (id, artistId, artistName, city, date, venueName, capacity).
    Matches test_dashboard_highlights.py's fixture shape -- duplicated per
    this suite's existing convention of each file owning its own fixture."""
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
    engine.dispose()


def test_every_artist_with_data_gets_exactly_one_teaser():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_url = f"sqlite+pysqlite:///{tmpdir}/ti.db"
        _seed(db_url, [
            ("c1", "artist-1", "Artist One", "Mumbai", "2020-01-01", "Big Arena", 40000),
            ("c2", "artist-2", "Artist Two", "Delhi", "2021-01-01", "Small Hall", 2000),
        ])
        result = top_insight_per_artist(db_url=db_url)

    by_artist = {i.artist_id: i for i in result.items}
    assert set(by_artist.keys()) == {"artist-1", "artist-2"}


def test_biggest_show_is_scoped_to_the_artist_not_the_roster():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_url = f"sqlite+pysqlite:///{tmpdir}/ti.db"
        _seed(db_url, [
            ("c1", "artist-1", "Small Show Artist", "Pune", "2022-01-01", "Small Hall", 3000),
            ("c2", "artist-2", "Big Show Artist", "Mumbai", "2022-01-01", "Huge Stadium", 90000),
        ])
        result = top_insight_per_artist(db_url=db_url)

    by_artist = {i.artist_id: i for i in result.items}
    # artist-1's own biggest show is small hall -- must never claim it's the
    # roster's biggest just because a shared helper computed it.
    assert "Small Show Artist's biggest verified show" in by_artist["artist-1"].insight.headline
    assert "in this roster" not in by_artist["artist-1"].insight.headline
    assert "Small Hall" in by_artist["artist-1"].insight.headline


def test_priority_picks_the_most_distinctive_available_type():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_url = f"sqlite+pysqlite:///{tmpdir}/ti.db"
        # This artist qualifies for both widest_reach (4 cities) and
        # career_origin (always available) -- priority should pick the more
        # distinctive widest_reach, not the near-universal fallback.
        _seed(db_url, [
            ("c1", "artist-1", "Wide Artist", "Mumbai", "2022-01-01", None, None),
            ("c2", "artist-1", "Wide Artist", "Delhi", "2022-02-01", None, None),
            ("c3", "artist-1", "Wide Artist", "Chennai", "2022-03-01", None, None),
            ("c4", "artist-1", "Wide Artist", "Kolkata", "2022-04-01", None, None),
        ])
        result = top_insight_per_artist(db_url=db_url)

    assert result.items[0].insight.insight_type == "widest_reach"


def test_flat_zero_consistency_is_skipped_for_a_more_distinctive_fact():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_url = f"sqlite+pysqlite:///{tmpdir}/ti.db"
        # 3 distinct cities, zero repeats -> a real, honest 0% -- but that's
        # not a distinctive highlight, so a different real fact (career
        # origin, always available) should win instead of a flat "0%".
        _seed(db_url, [
            ("c1", "artist-1", "Never Returns Artist", "Mumbai", "2022-01-01", None, None),
            ("c2", "artist-1", "Never Returns Artist", "Delhi", "2022-02-01", None, None),
            ("c3", "artist-1", "Never Returns Artist", "Chennai", "2022-03-01", None, None),
        ])
        result = top_insight_per_artist(db_url=db_url)

    picked = result.items[0].insight
    assert picked.insight_type != "most_consistent"


def test_artist_with_no_real_data_is_absent_not_a_placeholder():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_url = f"sqlite+pysqlite:///{tmpdir}/ti.db"
        _seed(db_url, [])
        result = top_insight_per_artist(db_url=db_url)

    assert result.items == []

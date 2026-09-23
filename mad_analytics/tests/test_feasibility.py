"""
tests/test_feasibility.py
Phase C: TOPSIS-based city feasibility ranking -- see feasibility/topsis.py's
module docstring for the WHY.
"""
from __future__ import annotations
import tempfile

from sqlalchemy import create_engine, text

from mad_analytics.utils.schemas import FeasibilityInput
import mad_analytics.feasibility.topsis as topsis


def _seed_concerts_with_capacity(
    db_url: str,
    rows: list[tuple[str, str, str, str, int]],
    audience_city_rows: list[tuple[str, str, str, float]] | None = None,
):
    """rows: (concert_id, artist_id, city, date, capacity). Also creates
    viberate_metrics_daily WITH a city column -- calculate() now also queries
    it by city (for the Engagement criterion, city IS NULL implicitly via no
    filter, and for the new City Audience Presence boost, city IS NOT NULL) --
    same issue that came up for the Engagement criterion fixture, now extended
    for the audience_city_* metrics. audience_city_rows (optional):
    (artist_id, metric_name, city, total_value) -- an honest empty list is
    what production looks like for an artist with no Viberate city data at
    all, not a schema error."""
    engine = create_engine(db_url)
    with engine.begin() as conn:
        conn.execute(text(
            '''
            CREATE TABLE concerts (
                id TEXT PRIMARY KEY,
                "artistId" TEXT NOT NULL,
                city TEXT,
                "concertDate" TEXT,
                "venueName" TEXT,
                capacity INTEGER
            )
            '''
        ))
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
        for concert_id, artist_id, city, concert_date, capacity in rows:
            conn.execute(text(
                'INSERT INTO concerts (id, "artistId", city, "concertDate", "venueName", capacity) '
                'VALUES (:id, :aid, :city, :date, NULL, :cap)'
            ), {"id": concert_id, "aid": artist_id, "city": city, "date": concert_date, "cap": capacity})
        for i, (artist_id, metric_name, city, value) in enumerate(audience_city_rows or []):
            conn.execute(text(
                'INSERT INTO viberate_metrics_daily (id, "artistId", "metricName", date, "totalValue", city) '
                'VALUES (:id, :aid, :name, :date, :val, :city)'
            ), {"id": f"ac{i}", "aid": artist_id, "name": metric_name, "date": "2026-09-01", "val": value, "city": city})
    engine.dispose()


class TestTopsisPure:
    """Pure TOPSIS math -- no DB, offline-testable."""

    def test_single_row_is_neutral(self):
        assert topsis._topsis([[10.0, 20.0]], [0.5, 0.5]) == [0.5]

    def test_empty_matrix_returns_empty(self):
        assert topsis._topsis([], [0.5, 0.5]) == []

    def test_best_row_scores_higher_than_worst_row(self):
        scores = topsis._topsis([[100.0], [10.0]], [1.0])
        assert scores[0] > scores[1]
        assert scores[0] == 1.0  # sole best-in-every-criterion row is the ideal itself
        assert scores[1] == 0.0  # sole worst-in-every-criterion row is the anti-ideal itself

    def test_constant_column_contributes_nothing(self):
        """A column where every row has the identical value (e.g. Artist
        Power in a single-artist feasibility query) must not affect the
        ranking -- only the varying column should decide it."""
        scores = topsis._topsis(
            [[50.0, 10.0], [50.0, 100.0], [50.0, 55.0]],
            [0.5, 0.5],
        )
        ranked = sorted(range(3), key=lambda i: -scores[i])
        assert ranked == [1, 2, 0]  # ordered purely by the second (varying) column

    def test_scores_are_bounded_0_to_1(self):
        scores = topsis._topsis([[5, 1], [2, 8], [9, 3], [1, 1]], [0.6, 0.4])
        assert all(0.0 <= s <= 1.0 for s in scores)


class TestCityVenueCapacityIndex:
    def test_strongest_city_normalizes_to_100(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_url = f"sqlite+pysqlite:///{tmpdir}/feas.db"
            _seed_concerts_with_capacity(db_url, [
                ("c1", "a1", "Mumbai", "2024-01-01", 50000),
                ("c2", "a2", "Chennai", "2024-01-01", 5000),
            ])
            index = topsis._city_venue_capacity_index(db_url=db_url)
            assert index["mumbai"] == 100.0
            assert index["chennai"] == 10.0

    def test_city_with_no_resolved_capacity_is_absent_not_zero(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_url = f"sqlite+pysqlite:///{tmpdir}/feas.db"
            _seed_concerts_with_capacity(db_url, [
                ("c1", "a1", "Mumbai", "2024-01-01", 50000),
                ("c2", "a2", "Pune", "2024-01-01", 0),  # unresolved -- excluded by the > 0 filter
            ])
            index = topsis._city_venue_capacity_index(db_url=db_url)
            assert "pune" not in index

    def test_no_data_at_all_returns_empty(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_url = f"sqlite+pysqlite:///{tmpdir}/feas.db"
            _seed_concerts_with_capacity(db_url, [])
            assert topsis._city_venue_capacity_index(db_url=db_url) == {}


class TestFeasibilityCalculateIntegration:
    """calculate() orchestration. Popularity is monkeypatched -- it's a live
    Google-Trends-backed lookup already covered by TestArtistPopularity, out
    of scope here -- so these stay fast and deterministic."""

    def _mock_popularity(self, monkeypatch, score: float):
        import mad_analytics.popularity.calculator as popularity_calculator
        from mad_analytics.utils.schemas import PopularityOutput
        monkeypatch.setattr(
            popularity_calculator, "calculate",
            lambda payload: PopularityOutput(
                artist_id=payload.artist_id, popularity_score=score,
                platform_weights={}, platform_contributions={},
                computed_at="2026-01-01T00:00:00+00:00",
            ),
        )

    def test_city_with_real_touring_precedent_outranks_one_without(self, monkeypatch):
        self._mock_popularity(monkeypatch, 50.0)
        with tempfile.TemporaryDirectory() as tmpdir:
            db_url = f"sqlite+pysqlite:///{tmpdir}/feas.db"
            _seed_concerts_with_capacity(db_url, [
                ("c1", "artist-1", "Mumbai", "2024-01-01", 20000),
                ("c2", "artist-1", "Mumbai", "2025-01-01", 20000),
            ])
            mumbai = topsis.calculate(FeasibilityInput(artist_id="artist-1", city="Mumbai"), db_url=db_url)
            chennai = topsis.calculate(FeasibilityInput(artist_id="artist-1", city="Chennai"), db_url=db_url)
            assert mumbai.components.touring_precedent_visits == 2
            assert chennai.components.touring_precedent_visits == 0
            assert mumbai.score > chennai.score
            assert mumbai.rank < chennai.rank

    def test_output_is_well_formed_for_a_city_with_no_market_data(self, monkeypatch):
        """A city outside the NCCS-covered universe must still be rankable
        (0.0 city affinity, never dropped from the comparison)."""
        self._mock_popularity(monkeypatch, 30.0)
        with tempfile.TemporaryDirectory() as tmpdir:
            db_url = f"sqlite+pysqlite:///{tmpdir}/feas.db"
            _seed_concerts_with_capacity(db_url, [])
            out = topsis.calculate(
                FeasibilityInput(artist_id="artist-1", city="Nowhereville"), db_url=db_url
            )
            assert 0.0 <= out.score <= 1.0
            assert out.components.city_affinity == 0.0
            assert 1 <= out.rank <= out.total_cities_compared


class TestCityAudiencePresenceBoost:
    """feasibility/topsis.py's _city_audience_boost() -- covers Touring
    Precedent's "never toured but has a real digital audience there" blind
    spot. See topsis.py's module docstring CITY AUDIENCE PRESENCE BOOST
    section for the exact rule: boosts, never replaces; falls back to
    unchanged behavior when no audience-city reading exists."""

    def _mock_popularity(self, monkeypatch, score: float):
        import mad_analytics.popularity.calculator as popularity_calculator
        from mad_analytics.utils.schemas import PopularityOutput
        monkeypatch.setattr(
            popularity_calculator, "calculate",
            lambda payload: PopularityOutput(
                artist_id=payload.artist_id, popularity_score=score,
                platform_weights={}, platform_contributions={},
                computed_at="2026-01-01T00:00:00+00:00",
            ),
        )

    def test_boost_is_exactly_zero_when_no_audience_data(self, monkeypatch):
        """Unchanged-behavior guarantee: with zero audience_city_* rows for
        this artist, the boost must contribute nothing at all -- same score
        and same (None) transparency field as before this signal existed."""
        self._mock_popularity(monkeypatch, 50.0)
        with tempfile.TemporaryDirectory() as tmpdir:
            db_url = f"sqlite+pysqlite:///{tmpdir}/feas.db"
            _seed_concerts_with_capacity(db_url, [
                ("c1", "artist-1", "Mumbai", "2024-01-01", 20000),
            ])
            out = topsis.calculate(FeasibilityInput(artist_id="artist-1", city="Chennai"), db_url=db_url)
            assert out.components.touring_precedent_visits == 0
            assert out.components.city_audience_monthly_listeners_pct is None
            assert topsis._city_audience_boost(None) == 0.0

    def test_zero_visit_city_with_strong_audience_presence_still_never_outranks_a_real_visit(self, monkeypatch):
        """The exact blind spot this signal fixes: Chennai has NEVER been
        toured but shows a strong (25%) digital audience share, while Mumbai
        has exactly one real recorded visit. The boost must narrow the gap
        (Chennai must clearly out-rank a city with neither visits nor
        audience data) but never let the 0-visit city catch up to, let alone
        beat, the real Tier-1 visit."""
        self._mock_popularity(monkeypatch, 50.0)
        with tempfile.TemporaryDirectory() as tmpdir:
            db_url = f"sqlite+pysqlite:///{tmpdir}/feas.db"
            _seed_concerts_with_capacity(
                db_url,
                [("c1", "artist-1", "Mumbai", "2024-01-01", 20000)],
                audience_city_rows=[
                    ("artist-1", "audience_city_monthly_listeners_pct", "Chennai", 25.0),
                ],
            )
            mumbai = topsis.calculate(FeasibilityInput(artist_id="artist-1", city="Mumbai"), db_url=db_url)
            chennai = topsis.calculate(FeasibilityInput(artist_id="artist-1", city="Chennai"), db_url=db_url)
            nowhere = topsis.calculate(FeasibilityInput(artist_id="artist-1", city="Nowhereville"), db_url=db_url)

            assert chennai.components.city_audience_monthly_listeners_pct == 25.0
            assert chennai.components.touring_precedent_visits == 0  # raw count itself is NEVER altered by the boost
            assert mumbai.score > chennai.score   # one real visit still outranks a 0-visit city, boosted or not
            assert chennai.score > nowhere.score  # but the boost clearly lifts it above a city with no signal at all

    def test_boost_is_capped_at_half_a_visit(self):
        """A maximal (>=20%) audience share must never contribute more than
        half of one real visit's worth to the matrix value -- keeps this
        Tier-2 signal from ever letting a 0-visit city outrank a 1-visit one
        regardless of how strong the digital presence is."""
        assert topsis._city_audience_boost(20.0) == 0.5
        assert topsis._city_audience_boost(100.0) == 0.5  # capped, not linearly unbounded
        assert topsis._city_audience_boost(10.0) == 0.25  # scales linearly below the reference point

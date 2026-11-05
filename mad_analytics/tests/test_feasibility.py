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


class TestCityVenueSeats:
    """Organiser-facing venue seat list that replaces the on-screen Venue Fit
    index (the index still feeds the ranking maths; see topsis.py)."""

    @staticmethod
    def _add_venue_concerts(db_url, rows):
        """rows: (id, artist_id, city, venue, capacity)"""
        engine = create_engine(db_url)
        with engine.begin() as conn:
            for cid, aid, city, venue, cap in rows:
                conn.execute(text(
                    'INSERT INTO concerts (id, "artistId", city, "concertDate", "venueName", capacity) '
                    'VALUES (:id, :aid, :city, :d, :v, :cap)'
                ), {"id": cid, "aid": aid, "city": city, "d": "2024-01-01", "v": venue, "cap": cap})
        engine.dispose()

    def _seats(self, rows, city_key="mumbai", artist="a1"):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_url = f"sqlite+pysqlite:///{tmpdir}/feas.db"
            _seed_concerts_with_capacity(db_url, [])
            self._add_venue_concerts(db_url, rows)
            return topsis._city_venue_seats(city_key, artist, db_url=db_url)

    def test_curated_venue_is_verified_and_logged_one_is_an_estimate(self):
        venues, total = self._seats([
            ("c1", "a1", "Mumbai", "DY Patil Stadium", 1),           # curated -> 55,000 wins over the logged value
            ("c2", "a2", "Mumbai", "Some Garden Lawn", 3000),        # not curated -> estimate
        ])
        by_name = {v.name: v for v in venues}
        assert by_name["DY Patil Stadium"].seats == 55000 and by_name["DY Patil Stadium"].verified is True
        assert by_name["Some Garden Lawn"].seats == 3000 and by_name["Some Garden Lawn"].verified is False
        assert [v.name for v in venues][0] == "DY Patil Stadium"  # largest first
        assert total >= 2

    def test_same_venue_spelled_two_ways_is_one_row(self):
        venues, _ = self._seats([
            ("c1", "a1", "Mumbai", "Dublin Square", 5000),
            ("c2", "a2", "Mumbai", "Dublin Square, Phoenix Marketcity Kurla", 5000),
        ])
        assert sum(1 for v in venues if v.name.startswith("Dublin Square")) == 1
        assert next(v for v in venues if v.name.startswith("Dublin Square")).concerts_in_log == 2

    def test_hall_vs_auditorium_and_garden_aliases_merge_and_verified_wins(self):
        """Regression for the 2026-11 duplicate review: same physical venue under
        different names must be one row, and the curated (verified) capacity must
        beat the unverified logged one."""
        venues, _ = self._seats([
            ("c1", "a1", "Mumbai", "Shanmukhananda Hall", 3500),
            ("c2", "a2", "Mumbai", "Shanmukhananda Hall", 3500),
            ("c3", "a3", "Mumbai", "Shanmukhananda Auditorium", 2500),
            ("c4", "a1", "Mumbai", "Jio Garden, BKC", 5000),
            ("c5", "a2", "Mumbai", "Jio World Garden", 5000),
            ("c6", "a3", "Mumbai", "Jio World Centre", 3500),
            ("c7", "a4", "Mumbai", "Jio World Convention Centre", 3500),
        ])
        names = [v.name for v in venues]
        shan = [v for v in venues if v.name.startswith("Shanmukhananda")]
        assert len(shan) == 1 and shan[0].seats == 2500 and shan[0].verified is True
        assert sum(1 for n in names if n.startswith("Jio")) == 2  # one Garden + one Convention Centre
        garden = next(v for v in venues if "Garden" in v.name)
        assert garden.concerts_in_log == 2

    def test_researched_capacity_overrides_log_estimate_but_is_never_verified(self):
        venues, _ = self._seats([
            ("c1", "a1", "Mumbai", "JVPD Grounds, Juhu", 25000),   # stale type-based estimate
            ("c2", "a2", "Mumbai", "Jio Garden, BKC", 5000),
        ])
        jvpd = next(v for v in venues if v.name.startswith("JVPD"))
        assert jvpd.seats == 3000 and jvpd.verified is False and "Web research" in jvpd.note
        jio = next(v for v in venues if "Jio" in v.name)
        assert jio.seats == 7500 and jio.verified is False

    def test_curated_verified_capacity_beats_researched(self):
        from mad_analytics.venue_capacity import known_venues
        assert known_venues.lookup_researched_capacity("DY Patil Stadium", "Mumbai") is None
        venues, _ = self._seats([("c1", "a1", "Mumbai", "DY Patil Stadium", 1)])
        dy = next(v for v in venues if v.name == "DY Patil Stadium")
        assert dy.verified is True and dy.note is None

    def test_garden_and_convention_centre_stay_separate_venues(self):
        venues, _ = self._seats([
            ("c1", "a1", "Mumbai", "Jio World Garden", 5000),
            ("c2", "a2", "Mumbai", "Jio World Convention Centre", 3500),
        ])
        # Garden uses its researched 7,500; Convention Centre keeps its logged 3,500.
        assert {v.seats for v in venues if v.name.startswith("Jio")} == {7500, 3500}

    def test_trailing_ground_and_estate_words_merge_spellings(self):
        venues, _ = self._seats([
            ("c1", "a1", "Mumbai", "Aquatica", 5000),
            ("c2", "a2", "Mumbai", "Aquatica Ground", 5000),
            ("c3", "a1", "Mumbai", "Mayfield Estate", 5000),
            ("c4", "a2", "Mumbai", "Mayfield Eva Garden", 5000),
        ])
        assert sum(1 for v in venues if v.name.startswith("Aquatica")) == 1
        assert sum(1 for v in venues if v.name.startswith("Mayfield")) == 1

    def test_conflicting_logged_capacities_use_the_median(self):
        venues, _ = self._seats([
            ("c1", "a1", "Mumbai", "Mystery Arena Ground", 5000),
            ("c2", "a2", "Mumbai", "Mystery Arena Ground", 40000),
            ("c3", "a3", "Mumbai", "Mystery Arena Ground", 5000),
        ])
        assert next(v for v in venues if v.name == "Mystery Arena Ground").seats == 5000

    def test_played_by_artist_flag_and_other_cities_excluded(self):
        venues, _ = self._seats([
            ("c1", "a1", "Mumbai", "Club Alpha", 800),
            ("c2", "a2", "Mumbai", "Club Beta", 900),
            ("c3", "a1", "Pune", "Club Gamma", 700),
        ])
        by_name = {v.name: v for v in venues}
        assert by_name["Club Alpha"].played_by_artist is True
        assert by_name["Club Beta"].played_by_artist is False
        assert "Club Gamma" not in by_name

    def test_venue_without_any_capacity_is_omitted_not_zero_filled(self):
        venues, _ = self._seats([("c1", "a1", "Mumbai", "No Capacity Hall", 0)])
        assert all(v.name != "No Capacity Hall" for v in venues)

    def test_curated_venue_with_no_logged_show_still_appears(self):
        venues, _ = self._seats([], city_key="kolkata")
        assert any(v.name.lower() == "eden gardens" and v.verified and v.concerts_in_log == 0 for v in venues)


class TestArtistVenueSeats:
    """The Venue Fit score translated into approximate seats FOR THE SELECTED
    ARTIST (the old score was one number per city, identical for every artist)."""

    @staticmethod
    def _city(*seats_and_shows):
        from mad_analytics.utils.schemas import VenueSeats
        return [VenueSeats(name=f"V{i}", seats=s, verified=False, concerts_in_log=n)
                for i, (s, n) in enumerate(seats_and_shows)]

    def test_uses_the_artists_own_shows_in_that_city(self):
        shows = [("mumbai", 3000), ("mumbai", 5000), ("mumbai", 4000), ("delhi", 60000)]
        seats, basis = topsis._artist_venue_seats(shows, "mumbai", self._city((55000, 1)))
        assert (seats, basis) == (4000, "played_here")  # median of Mumbai shows only; Delhi stadium ignored

    def test_falls_back_to_artists_typical_size_when_never_played_the_city(self):
        shows = [("delhi", 2000), ("pune", 3000), ("chennai", 4000)]
        seats, basis = topsis._artist_venue_seats(shows, "mumbai", self._city((55000, 1)))
        assert (seats, basis) == (3000, "artist_typical")

    def test_artist_habit_is_capped_by_the_citys_largest_venue(self):
        shows = [("delhi", 60000), ("kolkata", 66000)]
        seats, basis = topsis._artist_venue_seats(shows, "chennai", self._city((8000, 1), (25000, 1)))
        assert (seats, basis) == (25000, "artist_typical_capped")

    def test_artist_with_no_shows_gets_the_city_average_flagged_as_such(self):
        seats, basis = topsis._artist_venue_seats([], "mumbai", self._city((10000, 1), (2000, 3)))
        assert basis == "city_typical" and seats == 4000  # (10000*1 + 2000*3) / 4 = 4000

    def test_nothing_to_go_on_returns_none(self):
        assert topsis._artist_venue_seats([], "mumbai", []) == (None, None)

    def test_rounding_is_approximate(self):
        assert topsis._round_seats(4049) == 4000
        assert topsis._round_seats(12400) == 12500

    def test_two_artists_get_different_seats_for_the_same_city(self, monkeypatch):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_url = f"sqlite+pysqlite:///{tmpdir}/feas.db"
            _seed_concerts_with_capacity(db_url, [
                ("c1", "club-act", "Mumbai", "2024-01-01", 800),
                ("c2", "club-act", "Mumbai", "2024-02-01", 1000),
                ("c3", "stadium-act", "Mumbai", "2024-01-01", 40000),
            ])
            club = topsis._artist_show_seats("club-act", db_url=db_url)
            stadium = topsis._artist_show_seats("stadium-act", db_url=db_url)
            assert [s for _, s in club] == [800, 1000]
            assert [s for _, s in stadium] == [40000]
            assert (topsis._artist_venue_seats(club, "mumbai", [])[0]
                    != topsis._artist_venue_seats(stadium, "mumbai", [])[0])


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

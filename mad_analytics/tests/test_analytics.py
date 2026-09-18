"""
tests/test_analytics.py
Pytest suite for all three calculation modules.

Run: pytest mad_analytics/tests/ -v
"""
from __future__ import annotations
import tempfile
from datetime import date, timedelta

import pytest

from mad_analytics.utils.schemas import (
    PlatformMetricRow, ConcertRow,
    GrowthInput, DemandInput, RevenueInput, PopularityInput, PopularityOutput,
)
# Growth/RoG was archived (moved to mad_analytics/legacy/growth_calculator.py) —
# these tests still exercise the preserved implementation directly to make sure
# archiving it didn't silently break its math, even though Popularity/Demand no
# longer call it.
from mad_analytics.legacy.growth_calculator import calculate as growth_calc
from mad_analytics.demand.scorer import calculate as demand_calc
import mad_analytics.demand.scorer as demand_scorer
from mad_analytics.revenue.predictor import calculate as revenue_calc
import mad_analytics.revenue.predictor as revenue_predictor
from mad_analytics.popularity import calculate as popularity_calc, calculate_all as popularity_calc_all
import mad_analytics.popularity.calculator as popularity_calculator
from mad_analytics.utils.db import persist_popularity_scores, fetch_saved_popularity
from mad_analytics.utils.feature_engineering import (
    rog, exponential_smooth, seasonality_factor,
    social_velocity, ticket_velocity, infer_artist_tier, metrics_to_df,
    apply_genre_tilt, genre_style_for_artist_name,
)


# ── Fixtures ───────────────────────────────────────────────────────────────────

def make_metrics(days: int = 60, platform: str = "spotify",
                 start: int = 100_000, daily_growth: int = 500) -> list[PlatformMetricRow]:
    """Generate a synthetic metric series with steady growth."""
    today = date.today()
    rows = []
    for i in range(days):
        d = today - timedelta(days=days - i)
        rows.append(PlatformMetricRow(
            date=d,
            platform=platform,
            followers=start + i * daily_growth,
            streams=start * 3 + i * daily_growth * 2,
            views=start * 2 + i * daily_growth,
        ))
    return rows


def make_concert(artist_id="a1", city="Mumbai", days_from_now=30) -> ConcertRow:
    return ConcertRow(
        concert_id="c1",
        artist_id=artist_id,
        city=city,
        country="India",
        venue_capacity=5000,
        ticket_price_min=500.0,
        ticket_price_max=2000.0,
        date=date.today() + timedelta(days=days_from_now),
    )


# ── Feature engineering ────────────────────────────────────────────────────────

class TestRoG:
    def test_positive_growth(self):
        metrics = make_metrics(60, daily_growth=1000)
        df = metrics_to_df(metrics)
        from mad_analytics.utils.feature_engineering import platform_series
        series = platform_series(df, "spotify")
        r = rog(series, 30)
        assert r > 0, "Expected positive RoG for growing series"

    def test_zero_start_guard(self):
        """Should return 0.0 not divide-by-zero when the 30d-ago baseline is 0.
        Spotify's primary metric is streams; series starts at 0 with daily_growth
        so the value exactly 30+ days ago is 0 — guard must kick in."""
        from mad_analytics.utils.feature_engineering import platform_series
        from mad_analytics.utils.schemas import PlatformMetricRow
        from datetime import timedelta
        today = date.today()
        # All streams values are 0 — baseline is definitely 0
        metrics = [
            PlatformMetricRow(date=today - timedelta(days=60 - i), platform="spotify",
                              followers=0, streams=0, views=0)
            for i in range(60)
        ]
        df = metrics_to_df(metrics)
        series = platform_series(df, "spotify")
        r = rog(series, 30)
        assert r == 0.0

    def test_insufficient_data(self):
        metrics = make_metrics(3)
        df = metrics_to_df(metrics)
        from mad_analytics.utils.feature_engineering import platform_series
        series = platform_series(df, "spotify")
        r = rog(series, 30)
        assert r == 0.0


class TestSeasonality:
    def test_summer_weekend_high(self):
        s = seasonality_factor(date(2024, 8, 3), "Mumbai")   # August Saturday
        assert s >= 0.9

    def test_winter_weekday_low(self):
        s = seasonality_factor(date(2024, 2, 5), "Delhi")    # February Monday
        assert s <= 0.65


class TestArtistTier:
    def test_micro(self):
        metrics = make_metrics(30, start=5_000, daily_growth=10)
        assert infer_artist_tier(metrics) == "micro"

    def test_major(self):
        metrics = make_metrics(30, start=1_000_000, daily_growth=1000)
        assert infer_artist_tier(metrics) in ("major", "superstar")


# ── Genre-style platform tilt (Popularity + Demand accuracy upgrade — Phase 3, Day 6) ──

class TestGenreStyleTilt:
    """Pure, offline-testable: apply_genre_tilt/genre_style_for_artist_name never touch the DB."""

    def test_regional_folk_shifts_weight_toward_youtube(self):
        weights = {"spotify": 0.40, "youtube": 0.25, "instagram": 0.25, "facebook": 0.10}
        tilted = apply_genre_tilt(weights, "regional_folk")
        assert tilted["youtube"] > weights["youtube"]
        assert tilted["spotify"] < weights["spotify"]
        # Renormalized back to the same total -- still a valid weight set.
        assert abs(sum(tilted.values()) - sum(weights.values())) < 1e-9

    def test_untagged_genre_style_is_unchanged(self):
        weights = {"spotify": 0.40, "youtube": 0.25, "instagram": 0.25, "facebook": 0.10}
        assert apply_genre_tilt(weights, None) == weights
        # mainstream_bollywood/modern_pop_crossover have no tilt entry for V1 (see module docstring).
        assert apply_genre_tilt(weights, "mainstream_bollywood") == weights
        assert apply_genre_tilt(weights, "a_future_tag_not_in_the_table") == weights

    def test_curated_roster_resolves_expected_styles(self):
        assert genre_style_for_artist_name("Arijit Singh") == "mainstream_bollywood"
        assert genre_style_for_artist_name("Hansraj Raghuwanshi") == "regional_folk"
        assert genre_style_for_artist_name("Neeraj Shridhar") == "pop_remix"
        assert genre_style_for_artist_name("Armaan Malik") == "modern_pop_crossover"

    def test_unknown_artist_name_is_neutral(self):
        """An artist outside the locked 11-artist roster must never be
        guessed into a tag -- None, same as any other missing signal."""
        assert genre_style_for_artist_name("Some Future Artist") is None
        assert genre_style_for_artist_name(None) is None


# ── Growth module ──────────────────────────────────────────────────────────────

class TestGrowthCalculator:
    def _payload(self, platforms=("spotify", "instagram")):
        all_metrics = []
        for p in platforms:
            all_metrics.extend(make_metrics(90, platform=p))
        return GrowthInput(artist_id="artist_001", metrics=all_metrics)

    def test_output_schema(self):
        out = growth_calc(self._payload())
        assert out.artist_id == "artist_001"
        assert 0 <= out.cross_platform_score <= 100
        assert len(out.platforms) >= 1

    def test_rising_trend(self):
        out = growth_calc(self._payload())
        trends = {p.platform: p.trend for p in out.platforms}
        assert trends.get("spotify") in ("rising", "stable")

    def test_forecasts_non_negative(self):
        out = growth_calc(self._payload())
        for pf in out.platforms:
            assert pf.forecast_30d >= 0
            assert pf.forecast_90d >= 0
            assert pf.forecast_180d >= 0

    def test_single_platform(self):
        out = growth_calc(self._payload(platforms=("youtube",)))
        assert any(p.platform == "youtube" for p in out.platforms)

    def test_rog_values_present(self):
        out = growth_calc(self._payload())
        for pf in out.platforms:
            assert isinstance(pf.rog_7d, float)
            assert isinstance(pf.rog_30d, float)
            assert isinstance(pf.rog_90d, float)


# ── Demand module ──────────────────────────────────────────────────────────────

class TestDemandScorer:
    def _payload(self, city="Mumbai", days_ahead=45):
        metrics = make_metrics(60, "spotify") + make_metrics(60, "instagram")
        return DemandInput(
            artist_id="artist_001",
            city=city,
            country="India",
            target_date=date.today() + timedelta(days=days_ahead),
            platform_metrics=metrics,
            recent_concerts=[],
        )

    def test_score_range(self):
        out = demand_calc(self._payload())
        assert 0 <= out.score <= 100

    def test_components_present(self):
        # Blueprint v2.1 demand components: platform_size, google_trends,
        # city_affinity (momentum was removed when Growth/RoG was archived — see
        # demand/scorer.py's module docstring). Only *available* components are
        # reported; none of the three is guaranteed present without DB fixtures,
        # so this just checks nothing unexpected leaks into the output.
        out = demand_calc(self._payload())
        valid = {"platform_size", "google_trends", "city_affinity"}
        assert set(out.components).issubset(valid)

    def test_high_ticket_velocity_raises_score(self):
        base_out = demand_calc(self._payload())

        concerts_sold = [
            ConcertRow(
                concert_id=f"c{i}", artist_id="artist_001",
                city="Mumbai", country="India",
                venue_capacity=5000, ticket_price_min=500, ticket_price_max=2000,
                date=date.today() - timedelta(days=i*20),
                tickets_sold=4800,
            )
            for i in range(1, 5)
        ]
        metrics = make_metrics(60, "spotify") + make_metrics(60, "instagram")
        payload = DemandInput(
            artist_id="artist_001", city="Mumbai", country="India",
            target_date=date.today() + timedelta(days=45),
            platform_metrics=metrics, recent_concerts=concerts_sold,
        )
        high_out = demand_calc(payload)
        assert high_out.score >= base_out.score

    def test_recent_concerts_do_not_affect_score(self):
        """Blueprint v2.0 is signals-only ("No historical ticket sales data used"):
        recent concert history no longer feeds the demand score — the ticket-velocity
        and recency components were removed. Adding a recent concert must not change it.
        """
        metrics = make_metrics(60, "spotify") + make_metrics(60, "instagram")
        without = DemandInput(
            artist_id="artist_001", city="Mumbai", country="India",
            target_date=date.today() + timedelta(days=30),
            platform_metrics=metrics, recent_concerts=[],
        )
        very_recent = [
            ConcertRow(
                concert_id="c_recent", artist_id="artist_001",
                city="Mumbai", country="India",
                venue_capacity=5000, ticket_price_min=500, ticket_price_max=2000,
                date=date.today() - timedelta(days=5),
            )
        ]
        with_recent = DemandInput(
            artist_id="artist_001", city="Mumbai", country="India",
            target_date=date.today() + timedelta(days=30),
            platform_metrics=metrics, recent_concerts=very_recent,
        )
        assert demand_calc(with_recent).score == demand_calc(without).score


class TestDemandGenreTilt:
    """Genre-style platform tilt (Phase 3, Day 6) applied to Platform Size."""

    def test_tagged_artist_platform_size_shifts_with_youtube_strength(self, monkeypatch):
        # Folk Artist is YouTube-heavy / Spotify-light -- the regional_folk
        # tilt (toward YouTube) has something real to bite on here.
        rows = [
            {"artist_id": "artist_001", "artistName": "Folk Artist",
             "spotifyMonthlyListeners": 5000, "youtubeSubscribers": 500000,
             "instagramFollowers": 20000, "facebookFollowers": 10000},
            {"artist_id": "artist_002", "artistName": "Peer Artist",
             "spotifyMonthlyListeners": 50000, "youtubeSubscribers": 30000,
             "instagramFollowers": 40000, "facebookFollowers": 10000},
        ]
        monkeypatch.setattr(demand_scorer, "fetch_artist_snapshots", lambda: rows)

        monkeypatch.setattr(demand_scorer, "genre_style_for_artist_name", lambda name: None)
        untagged = demand_scorer.platform_size_scores()

        monkeypatch.setattr(
            demand_scorer, "genre_style_for_artist_name",
            lambda name: "regional_folk" if name == "Folk Artist" else None,
        )
        tagged = demand_scorer.platform_size_scores()

        assert tagged["artist_001"] > untagged["artist_001"]
        assert tagged["artist_002"] == untagged["artist_002"]  # peer is untagged in both runs

    def test_untagged_artist_unaffected(self):
        weights = demand_scorer.PLATFORM_SIZE_WEIGHTS
        artist_values = {"spotify": 10000.0, "youtube": 20000.0, "instagram": 5000.0, "facebook": 1000.0}
        cohort_min = {p: 0.0 for p in weights}
        cohort_max = {p: v * 2 for p, v in artist_values.items()}
        assert demand_scorer.compute_platform_size(artist_values, cohort_min, cohort_max, genre_style=None) == \
            demand_scorer.compute_platform_size(artist_values, cohort_min, cohort_max)


# ── Revenue module ─────────────────────────────────────────────────────────────

class TestRevenuePredictor:
    def _payload(self, capacity=5000, avg_price=1500):
        metrics = make_metrics(90, "spotify") + make_metrics(90, "instagram")
        concert = ConcertRow(
            concert_id="c1", artist_id="a1",
            city="Mumbai", country="India",
            venue_capacity=capacity,
            ticket_price_min=avg_price * 0.5,
            ticket_price_max=avg_price * 1.5,
            date=date.today() + timedelta(days=60),
        )
        return RevenueInput(concert=concert, platform_metrics=metrics)

    def test_output_schema(self):
        out = revenue_calc(self._payload())
        assert out.concert_id == "c1"
        assert out.predicted_revenue >= 0
        assert out.lower_bound <= out.predicted_revenue <= out.upper_bound

    def test_confidence_range(self):
        out = revenue_calc(self._payload())
        assert 0 < out.confidence <= 1.0

    def test_larger_venue_higher_revenue(self):
        small = revenue_calc(self._payload(capacity=1000))
        large = revenue_calc(self._payload(capacity=10000))
        assert large.predicted_revenue > small.predicted_revenue

    def test_higher_price_higher_revenue(self):
        cheap = revenue_calc(self._payload(avg_price=500))
        expensive = revenue_calc(self._payload(avg_price=5000))
        assert expensive.predicted_revenue > cheap.predicted_revenue

    def test_feature_importances_sum(self):
        out = revenue_calc(self._payload())
        total = sum(out.feature_importances.values())
        # Top-10 features should account for at least 95% of total importance
        assert total > 0.95, f"Top importances should sum to >0.95, got {total}"
        assert total <= 1.01, f"Importances should not exceed 1.0, got {total}"

    def test_pre_computed_demand_score(self):
        """Passing demand_score should skip internal demand calculation."""
        metrics = make_metrics(90, "spotify") + make_metrics(90, "instagram")
        concert = make_concert()
        payload = RevenueInput(concert=concert, platform_metrics=metrics, demand_score=75.0)
        out = revenue_calc(payload)
        assert out.demand_score_used == 75.0


# ── Language Affinity (Revenue accuracy upgrade — Phase 3, Day 5) ─────────────

class TestLanguageAffinityFactor:
    """Pure, offline-testable: _language_affinity_factor never touches the DB."""

    def test_perfect_match(self):
        factor = revenue_predictor._language_affinity_factor(frozenset({"hindi"}), "Mumbai")
        assert factor == revenue_predictor.LANGUAGE_MATCH_FACTOR

    def test_mismatch(self):
        factor = revenue_predictor._language_affinity_factor(frozenset({"hindi"}), "Chennai")
        assert factor == revenue_predictor.LANGUAGE_MISMATCH_FACTOR

    def test_multilingual_artist_always_matches(self):
        multilingual = frozenset({revenue_predictor._ANY_LANGUAGE})
        assert revenue_predictor._language_affinity_factor(multilingual, "Chennai") == revenue_predictor.LANGUAGE_MATCH_FACTOR
        assert revenue_predictor._language_affinity_factor(multilingual, "Kolkata") == revenue_predictor.LANGUAGE_MATCH_FACTOR

    def test_unknown_artist_is_neutral_not_penalized(self):
        """An artist outside the locked 11-artist roster table must never be
        guessed into a penalty -- neutral 1.0x, same as any other missing signal."""
        assert revenue_predictor._language_affinity_factor(None, "Chennai") == revenue_predictor.LANGUAGE_NEUTRAL_FACTOR

    def test_unlisted_city_defaults_to_hindi(self):
        # Guwahati isn't in CITY_DOMINANT_LANGUAGE -> defaults to Hindi -> a
        # Hindi-singing artist still gets a match there, not a guessed penalty.
        factor = revenue_predictor._language_affinity_factor(frozenset({"hindi"}), "Guwahati")
        assert factor == revenue_predictor.LANGUAGE_MATCH_FACTOR


class TestRevenueLanguageAffinityIntegration:
    def _payload(self, city):
        """demand_score is pre-computed and fixed here on purpose: city also
        feeds the internally-computed demand score via city-tier affinity, so
        leaving demand_score unset would let city move revenue through THAT
        channel too and confound these tests. Fixing it isolates language
        affinity as the only thing that can differ between two cities below.
        """
        metrics = make_metrics(90, "spotify") + make_metrics(90, "instagram")
        concert = ConcertRow(
            concert_id="c1", artist_id="a1",
            city=city, country="India",
            venue_capacity=5000,
            ticket_price_min=1000, ticket_price_max=2000,
            date=date.today() + timedelta(days=60),
        )
        return RevenueInput(concert=concert, platform_metrics=metrics, demand_score=75.0)

    def test_language_mismatch_lowers_predicted_revenue(self, monkeypatch):
        """Same artist, same venue/price/demand -- only the city's dominant
        language differs. A mismatch must predict strictly less revenue than
        a match, all else equal."""
        monkeypatch.setattr(
            revenue_predictor, "_artist_languages_for", lambda artist_id: frozenset({"hindi"})
        )
        match = revenue_calc(self._payload("Mumbai"))       # Hindi artist x Hindi-dominant city
        mismatch = revenue_calc(self._payload("Chennai"))   # Hindi artist x Tamil-dominant city
        assert mismatch.predicted_revenue < match.predicted_revenue

    def test_unresolvable_artist_does_not_change_revenue(self, monkeypatch):
        """An artist_id that can't be resolved to a name (not in the roster
        table, or DB lookup fails) must fall back to neutral -- city alone
        must not move predicted revenue THROUGH THE LANGUAGE CHANNEL when
        language affinity is unknown. Price-vs-income friction (Day 7) is
        also city-dependent but is a separate channel -- neutralized here so
        this test isolates language affinity specifically."""
        monkeypatch.setattr(revenue_predictor, "_artist_languages_for", lambda artist_id: None)
        monkeypatch.setattr(revenue_predictor, "_price_income_friction_factor", lambda price, city: 1.0)
        mumbai = revenue_calc(self._payload("Mumbai"))
        chennai = revenue_calc(self._payload("Chennai"))
        assert mumbai.predicted_revenue == chennai.predicted_revenue


# ── Price-vs-City-Income Friction (Revenue accuracy upgrade — Phase 3, Day 7) ──

class TestPriceIncomeFrictionFactor:
    """Pure, offline-testable: _price_income_friction_factor never touches the DB
    (city_affluence_ratio() reads a static bundled JSON file, not a live DB call)."""

    def test_price_within_affordable_reference_is_neutral(self):
        # Mumbai's affluence ratio (~0.515) x the 2500 reference -> ~1288.
        # A price well below that must never be rewarded, only penalties apply.
        factor = revenue_predictor._price_income_friction_factor(1000.0, "Mumbai")
        assert factor == 1.0

    def test_price_above_affordable_reference_is_penalized(self):
        factor = revenue_predictor._price_income_friction_factor(6000.0, "Mumbai")
        assert factor < 1.0

    def test_penalty_floors_at_minimum(self):
        factor = revenue_predictor._price_income_friction_factor(100_000.0, "Mumbai")
        assert factor == revenue_predictor.MIN_FRICTION_FACTOR

    def test_lower_income_city_is_penalized_more_at_same_price(self):
        """Same price, same everything else -- a lower-affluence city must
        show a strictly lower (or equal, if both floor out) friction factor."""
        price = 2000.0
        mumbai = revenue_predictor._price_income_friction_factor(price, "Mumbai")     # higher affluence ratio
        kolkata = revenue_predictor._price_income_friction_factor(price, "Kolkata")   # lower affluence ratio
        assert kolkata <= mumbai

    def test_city_without_nccs_data_is_neutral_not_penalized(self):
        """A city with no NCCS entry must never be guessed into a penalty."""
        factor = revenue_predictor._price_income_friction_factor(10_000.0, "Atlantis")
        assert factor == 1.0


class TestRevenuePriceIncomeFrictionIntegration:
    def _payload(self, city, avg_price):
        metrics = make_metrics(90, "spotify") + make_metrics(90, "instagram")
        concert = ConcertRow(
            concert_id="c1", artist_id="a1",
            city=city, country="India",
            venue_capacity=5000,
            ticket_price_min=avg_price, ticket_price_max=avg_price,
            date=date.today() + timedelta(days=60),
        )
        return RevenueInput(concert=concert, platform_metrics=metrics, demand_score=75.0)

    def test_expensive_ticket_in_lower_income_city_predicts_less_revenue(self, monkeypatch):
        """Same artist/venue/price/demand -- only the city differs. An
        expensive ticket in a lower-affluence city must predict strictly
        less revenue than the same ticket in a higher-affluence city.
        1800 is chosen so neither city's friction factor has hit the 0.5
        floor yet (a much higher price would floor both out to the same
        0.5x, hiding the difference this test is checking for)."""
        monkeypatch.setattr(revenue_predictor, "_artist_languages_for", lambda artist_id: None)
        mumbai = revenue_calc(self._payload("Mumbai", 1800.0))
        kolkata = revenue_calc(self._payload("Kolkata", 1800.0))
        assert kolkata.predicted_revenue < mumbai.predicted_revenue


# ── Weekend Ticket-Price Premium (Revenue accuracy upgrade — Phase 3, Day 7) ───

class TestWeekendPremium:
    def _payload(self, concert_date):
        metrics = make_metrics(90, "spotify") + make_metrics(90, "instagram")
        concert = ConcertRow(
            concert_id="c1", artist_id="a1",
            city="Mumbai", country="India",
            venue_capacity=5000,
            ticket_price_min=1500, ticket_price_max=1500,
            date=concert_date,
        )
        return RevenueInput(concert=concert, platform_metrics=metrics, demand_score=75.0)

    def test_saturday_show_predicts_more_revenue_than_weekday(self, monkeypatch):
        monkeypatch.setattr(revenue_predictor, "_artist_languages_for", lambda artist_id: None)
        # 2026-09-19 is a Saturday, 2026-09-16 (same week) is a Wednesday.
        saturday = date(2026, 9, 19)
        wednesday = date(2026, 9, 16)
        assert saturday.weekday() == 5 and wednesday.weekday() == 2

        weekend_out = revenue_calc(self._payload(saturday))
        weekday_out = revenue_calc(self._payload(wednesday))

        assert weekend_out.weekend_premium_applied is True
        assert weekday_out.weekend_premium_applied is False
        assert weekend_out.predicted_revenue == pytest.approx(
            weekday_out.predicted_revenue * revenue_predictor.WEEKEND_PREMIUM_FACTOR
        )


# ── Weather / Season Risk (Revenue accuracy upgrade — Phase 3, Day 8) ─────────

class TestWeatherSeasonFactor:
    """Pure, offline-testable: no DB, no weather API."""

    def test_outdoor_monsoon_is_penalized(self):
        assert revenue_predictor._weather_season_factor(7, "Stadium") == revenue_predictor.OUTDOOR_MONSOON_RISK_FACTOR

    def test_indoor_monsoon_is_neutral(self):
        assert revenue_predictor._weather_season_factor(7, "Auditorium") == 1.0

    def test_outdoor_non_monsoon_is_neutral(self):
        assert revenue_predictor._weather_season_factor(12, "Stadium") == 1.0

    def test_unknown_venue_type_defaults_to_indoor_neutral(self):
        """A blank/unrecognized venue_type must never be guessed into a
        penalty -- treated as indoor (the far more common case), not outdoor."""
        assert revenue_predictor._weather_season_factor(7, None) == 1.0
        assert revenue_predictor._weather_season_factor(7, "") == 1.0
        assert revenue_predictor._weather_season_factor(7, "Some Venue") == 1.0

    def test_open_air_keyword_is_recognized_as_outdoor(self):
        assert revenue_predictor._weather_season_factor(8, "Open Air Grounds") == revenue_predictor.OUTDOOR_MONSOON_RISK_FACTOR


class TestRevenueWeatherSeasonIntegration:
    def _payload(self, concert_month, venue_type):
        metrics = make_metrics(90, "spotify") + make_metrics(90, "instagram")
        concert = ConcertRow(
            concert_id="c1", artist_id="a1",
            city="Mumbai", country="India",
            venue_name="Test Venue", venue_type=venue_type,
            venue_capacity=5000,
            ticket_price_min=1500, ticket_price_max=1500,
            # 2026-07-04 and 2026-12-05 are both Saturdays -- fixed to avoid
            # the weekend premium (Day 7) confounding this comparison.
            date=date(2026, concert_month, 4 if concert_month == 7 else 5),
        )
        return RevenueInput(concert=concert, platform_metrics=metrics, demand_score=75.0)

    def test_outdoor_monsoon_show_predicts_less_than_indoor_winter_show(self, monkeypatch):
        """Same artist/venue/price/demand -- only month and venue type
        (outdoor vs indoor) differ. The classic case this feature exists for:
        an outdoor monsoon show must predict strictly less than an indoor
        winter show, all else equal."""
        monkeypatch.setattr(revenue_predictor, "_artist_languages_for", lambda artist_id: None)
        outdoor_monsoon = revenue_calc(self._payload(7, "Stadium"))     # July, outdoor
        indoor_winter = revenue_calc(self._payload(12, "Auditorium"))  # December, indoor
        assert outdoor_monsoon.predicted_revenue < indoor_winter.predicted_revenue
        assert outdoor_monsoon.weather_season_factor == revenue_predictor.OUTDOOR_MONSOON_RISK_FACTOR
        assert indoor_winter.weather_season_factor == 1.0

    def test_same_outdoor_venue_unaffected_outside_monsoon(self, monkeypatch):
        """The same outdoor venue in a non-monsoon month must not be
        penalized -- this is a monsoon-specific risk, not a blanket
        discount on all outdoor shows."""
        monkeypatch.setattr(revenue_predictor, "_artist_languages_for", lambda artist_id: None)
        monsoon = revenue_calc(self._payload(7, "Stadium"))
        winter = revenue_calc(self._payload(12, "Stadium"))
        assert monsoon.predicted_revenue < winter.predicted_revenue


class TestHeuristicIsPrimaryRevenueModel:
    """Heuristic Revenue Model is the canonical PRIMARY predictor
    (production MVP stabilization). The ML model is optional/secondary and
    must never block, replace, or hide the primary heuristic result."""

    def _payload(self, capacity=5000, avg_price=1500, demand_score=None):
        metrics = make_metrics(90, "spotify") + make_metrics(90, "instagram")
        concert = ConcertRow(
            concert_id="c1", artist_id="a1",
            city="Mumbai", country="India",
            venue_capacity=capacity,
            ticket_price_min=avg_price * 0.5,
            ticket_price_max=avg_price * 1.5,
            date=date.today() + timedelta(days=60),
        )
        return RevenueInput(concert=concert, platform_metrics=metrics, demand_score=demand_score)

    # ── Test A — heuristic succeeds, ML unavailable ───────────────────────
    def test_heuristic_succeeds_when_no_model_files_exist(self, monkeypatch):
        monkeypatch.setattr(revenue_predictor.model_store, "exists", lambda name: False)

        out = revenue_calc(self._payload())

        assert out.predicted_revenue is not None
        assert out.predicted_revenue >= 0
        assert out.model_type == "heuristic"
        assert out.ml_available is False
        assert out.ml_predicted_revenue is None

    def test_heuristic_succeeds_when_ml_model_raises_on_load(self, monkeypatch):
        """Reproduces the real-world failure mode (e.g. an incompatible/
        corrupted model artifact): model_store.exists() is True but
        model_store.load() raises. The primary heuristic result must still
        be returned -- this must NOT surface as 'Analytics Unavailable'."""
        monkeypatch.setattr(revenue_predictor.model_store, "exists", lambda name: True)

        def _raise_load(name):
            raise ModuleNotFoundError("No module named '_loss'")

        monkeypatch.setattr(revenue_predictor.model_store, "load", _raise_load)

        out = revenue_calc(self._payload())

        assert out.predicted_revenue is not None
        assert out.predicted_revenue >= 0
        assert out.model_type == "heuristic"
        assert out.ml_available is False
        assert out.ml_predicted_revenue is None

    # ── Test B — heuristic succeeds, ML succeeds ──────────────────────────
    def test_heuristic_remains_primary_when_ml_also_succeeds(self, monkeypatch):
        """Even when the ML model loads and predicts successfully, the
        primary predicted_revenue must be the heuristic value, unchanged --
        ML must not be blended in or replace it."""
        payload = self._payload()

        # What the heuristic alone produces for this exact payload, computed
        # directly (not via a prior revenue_calc() call, since this sandbox
        # may have real model files on disk that would otherwise be hit).
        feature_dict = revenue_predictor._build_feature_row(payload)
        expected_heuristic = round(
            max(0.0, revenue_predictor._heuristic_revenue(feature_dict)), 2
        )

        class _FakePreprocessor:
            def transform(self, row_df):
                return row_df

        class _FakeModel:
            def predict(self, X):
                # Deliberately very different from the heuristic value, so a
                # blend or override would be trivially detectable.
                return [expected_heuristic * 50 + 1_000_000]

        monkeypatch.setattr(revenue_predictor.model_store, "exists", lambda name: True)
        monkeypatch.setattr(
            revenue_predictor.model_store,
            "load",
            lambda name: _FakeModel() if name == "revenue_model" else _FakePreprocessor(),
        )

        out = revenue_calc(payload)

        assert out.model_type == "heuristic"
        assert out.ml_available is True
        assert out.ml_predicted_revenue == pytest.approx(expected_heuristic * 50 + 1_000_000, rel=1e-6)
        # The primary value must equal the pure heuristic result, not a blend.
        assert out.predicted_revenue == pytest.approx(expected_heuristic, rel=1e-6)
        assert out.predicted_revenue != out.ml_predicted_revenue

    # ── Test C — heuristic fails (genuinely missing/invalid required inputs) ──
    def test_unavailable_when_heuristic_inputs_cannot_be_computed(self, monkeypatch):
        """When a real prerequisite for the heuristic formula itself cannot
        be computed, the request should fail -- and the error must describe
        the HEURISTIC calculation failing, not blame the ML model."""

        def _raise_demand(payload):
            raise RuntimeError("simulated: demand score unavailable")

        monkeypatch.setattr(revenue_predictor, "demand_calculate", _raise_demand)

        with pytest.raises(RuntimeError) as excinfo:
            revenue_calc(self._payload(demand_score=None))

        message = str(excinfo.value).lower()
        assert "heuristic" in message
        assert "ml" not in message
        assert "model" not in message

    # ── Test D — zero/low but valid revenue must not look like "missing" ──
    def test_low_valid_revenue_is_not_treated_as_missing(self, monkeypatch):
        monkeypatch.setattr(revenue_predictor.model_store, "exists", lambda name: False)

        # Smallest capacity/price combination the schema allows -> a very
        # small but still valid (non-negative, non-null) predicted_revenue.
        out = revenue_calc(self._payload(capacity=1, avg_price=1, demand_score=10.0))

        assert out.predicted_revenue is not None
        assert out.predicted_revenue >= 0
        # A valid low number, not Python/JSON null and not silently coerced away.
        assert isinstance(out.predicted_revenue, float)


class TestRevenueInputRobustness:
    """Missing historical venue capacity / ticket pricing must never block a
    prediction, never be silently invented as if real, and must always be
    labeled with where the value actually came from. Canonical heuristic
    formula (demand_factor / base_sell_through / venue_factor / sell_through /
    predicted_revenue) is untouched by any of this -- only the INPUTS feeding
    it are made robust."""

    def _payload(self, *, capacity=None, price_min=None, price_max=None,
                 ticket_price_is_estimated=False, venue_name=None, city="Mumbai",
                 demand_score=50.0):
        metrics = make_metrics(90, "spotify") + make_metrics(90, "instagram")
        concert = ConcertRow(
            concert_id="c1", artist_id="a1",
            city=city, country="India",
            venue_name=venue_name,
            venue_capacity=capacity,
            ticket_price_min=price_min,
            ticket_price_max=price_max,
            ticket_price_is_estimated=ticket_price_is_estimated,
            date=date.today() + timedelta(days=60),
        )
        return RevenueInput(concert=concert, platform_metrics=metrics, demand_score=demand_score)

    def test_missing_capacity_does_not_raise_and_is_marked_estimated(self, monkeypatch):
        monkeypatch.delenv("DATABASE_URL", raising=False)
        out = revenue_calc(self._payload(capacity=None, price_min=500, price_max=2000))

        assert out.predicted_revenue is not None
        assert out.predicted_revenue >= 0
        assert out.model_type == "heuristic"
        assert out.capacity_is_estimated is True
        assert out.capacity_source in {"known_venue", "venue_database", "default_estimate"}
        assert out.resolved_venue_capacity is not None and out.resolved_venue_capacity > 0
        # A real ticket price was supplied, so only capacity is estimated.
        assert out.ticket_price_is_estimated is False
        assert out.data_quality == "partial"

    def test_missing_ticket_price_does_not_raise_and_is_marked_estimated(self, monkeypatch):
        monkeypatch.delenv("DATABASE_URL", raising=False)
        out = revenue_calc(self._payload(capacity=5000, price_min=None, price_max=None))

        assert out.predicted_revenue is not None
        assert out.predicted_revenue >= 0
        assert out.ticket_price_is_estimated is True
        assert out.ticket_price_source == "default_estimate"
        assert out.resolved_avg_ticket_price is not None and out.resolved_avg_ticket_price > 0
        assert out.capacity_is_estimated is False
        assert out.data_quality == "partial"

    def test_missing_capacity_and_price_together_is_fully_estimated(self, monkeypatch):
        monkeypatch.delenv("DATABASE_URL", raising=False)
        out = revenue_calc(self._payload(capacity=None, price_min=None, price_max=None))

        assert out.predicted_revenue is not None
        assert out.predicted_revenue >= 0
        assert out.capacity_is_estimated is True
        assert out.ticket_price_is_estimated is True
        assert out.data_quality == "estimated"

    def test_real_event_specific_inputs_are_not_marked_estimated(self, monkeypatch):
        monkeypatch.delenv("DATABASE_URL", raising=False)
        out = revenue_calc(self._payload(capacity=8000, price_min=1000, price_max=3000))

        assert out.capacity_is_estimated is False
        assert out.capacity_source == "event_specific"
        assert out.ticket_price_is_estimated is False
        assert out.ticket_price_source == "event_specific"
        assert out.data_quality == "full"
        assert out.resolved_venue_capacity == 8000

    def test_known_curated_venue_capacity_is_used_and_labeled(self, monkeypatch):
        """A real, historically-established venue in the curated known-venues
        list must resolve to its curated capacity (not a generic default) when
        no event-specific capacity was supplied -- and be labeled with its
        actual source ('known_venue', not 'event_specific'). A curated,
        validated reference value is high-confidence real data, so it is
        NOT flagged as an estimate the way a generic default/heuristic guess
        is (that distinction is what capacity_source is for)."""
        monkeypatch.delenv("DATABASE_URL", raising=False)
        out = revenue_calc(self._payload(
            capacity=None, price_min=500, price_max=2000,
            venue_name="Jawaharlal Nehru Stadium", city="New Delhi",
        ))

        assert out.capacity_source == "known_venue"
        assert out.capacity_is_estimated is False
        assert out.resolved_venue_capacity == 60000

    def test_missing_inputs_never_trigger_web_search(self, monkeypatch):
        """A routine revenue calculation must never perform an outbound web
        search, even when SERPAPI_KEY is configured and capacity is missing."""
        monkeypatch.delenv("DATABASE_URL", raising=False)
        monkeypatch.setenv("SERPAPI_KEY", "test-key-should-never-be-used")

        def _fail_if_called(*args, **kwargs):
            raise AssertionError("search_venue_capacity must not be called during revenue calculation")

        import mad_analytics.venue_capacity.web_search as web_search_module
        monkeypatch.setattr(web_search_module, "search_venue_capacity", _fail_if_called)

        out = revenue_calc(self._payload(capacity=None, price_min=None, price_max=None,
                                          venue_name="Some Obscure Unlisted Venue"))
        assert out.predicted_revenue is not None

    def test_deterministic_for_identical_inputs(self, monkeypatch):
        monkeypatch.delenv("DATABASE_URL", raising=False)
        payload_kwargs = dict(capacity=None, price_min=None, price_max=None,
                               venue_name="Some Obscure Unlisted Venue", city="Mumbai")

        out1 = revenue_calc(self._payload(**payload_kwargs))
        out2 = revenue_calc(self._payload(**payload_kwargs))

        assert out1.predicted_revenue == out2.predicted_revenue
        assert out1.resolved_venue_capacity == out2.resolved_venue_capacity
        assert out1.resolved_avg_ticket_price == out2.resolved_avg_ticket_price
        assert out1.data_quality == out2.data_quality == "estimated"

    def test_ml_secondary_failure_never_affects_estimated_primary_result(self, monkeypatch):
        """Combining the two robustness concerns: missing historical inputs
        AND a broken ML artifact must still produce a clean heuristic result,
        never a 5xx / 'Analytics Unavailable'."""
        monkeypatch.delenv("DATABASE_URL", raising=False)
        monkeypatch.setattr(revenue_predictor.model_store, "exists", lambda name: True)

        def _raise_load(name):
            raise ModuleNotFoundError("No module named '_loss'")

        monkeypatch.setattr(revenue_predictor.model_store, "load", _raise_load)

        out = revenue_calc(self._payload(capacity=None, price_min=None, price_max=None))

        assert out.predicted_revenue is not None
        assert out.model_type == "heuristic"
        assert out.ml_available is False
        assert out.data_quality == "estimated"


class TestArtistPopularity:
    # Base entropy score is ALWAYS cohort-relative now (see calculate()'s
    # docstring) — every test in this class exercises the single-artist path
    # against a mocked fetch_artist_snapshots() cohort, never a real DB.

    def _two_artist_cohort(self, target_values: dict) -> list[dict]:
        peer = {
            "artist_id": "artist_002",
            "artistName": "Peer Artist",
            "spotifyMonthlyListeners": 50000,
            "youtubeSubscribers": 30000,
            "instagramFollowers": 40000,
            "facebookFollowers": 10000,
            "twitterFollowers": 5000,
        }
        target = {"artist_id": "artist_001", "artistName": "Test Artist", **target_values}
        return [target, peer]

    def test_popularity_schema(self, monkeypatch):
        snapshot_rows = self._two_artist_cohort({
            "spotifyMonthlyListeners": 100000,
            "youtubeSubscribers": 50000,
            "instagramFollowers": 80000,
            "facebookFollowers": 20000,
            "twitterFollowers": 15000,
        })
        monkeypatch.setattr(popularity_calculator, "fetch_artist_snapshots", lambda: snapshot_rows)

        out = popularity_calc(PopularityInput(artist_id="artist_001"))
        assert out.artist_id == "artist_001"
        assert 0 <= out.popularity_score <= 100
        assert abs(sum(out.platform_weights.values()) - 1.0) < 0.01
        assert set(out.platform_weights) == set(out.platform_contributions)

    def test_larger_cohort_relative_reach_increases_score(self, monkeypatch):
        """An artist with a bigger footprint relative to the same cohort peer
        must score at least as high as a smaller one. Base score is always
        cohort-relative (never driven by a caller-supplied platform_metrics
        time series — see calculate()'s docstring)."""
        small_rows = self._two_artist_cohort({
            "spotifyMonthlyListeners": 5000,
            "youtubeSubscribers": 2000,
            "instagramFollowers": 3000,
            "facebookFollowers": 1000,
            "twitterFollowers": 500,
        })
        big_rows = self._two_artist_cohort({
            "spotifyMonthlyListeners": 100000,
            "youtubeSubscribers": 50000,
            "instagramFollowers": 80000,
            "facebookFollowers": 20000,
            "twitterFollowers": 15000,
        })

        monkeypatch.setattr(popularity_calculator, "fetch_artist_snapshots", lambda: small_rows)
        small = popularity_calc(PopularityInput(artist_id="artist_001"))

        monkeypatch.setattr(popularity_calculator, "fetch_artist_snapshots", lambda: big_rows)
        big = popularity_calc(PopularityInput(artist_id="artist_001"))

        assert big.popularity_score >= small.popularity_score

    def test_platform_metrics_time_series_does_not_self_normalize_to_100(self, monkeypatch):
        """Regression test for the Analysis-page bug where single-artist
        /popularity returned exactly 100.0: a caller-supplied platform_metrics
        time series that is monotonically increasing (so the artist's latest
        value equals its own historical max on every platform) must NOT force
        the score to ~100 purely because of that self-relative shape. The
        score must reflect the artist's current snapshot value relative to
        the active-artist cohort, exactly like /popularity/all — a modest
        artist dwarfed by a much larger cohort peer must score well below 100
        even though its own history only ever went up.
        """
        snapshot_rows = self._two_artist_cohort({
            "spotifyMonthlyListeners": 10000,
            "youtubeSubscribers": 5000,
            "instagramFollowers": 8000,
            "facebookFollowers": 2000,
            "twitterFollowers": 1000,
        })
        # Override the peer to be a much larger superstar for this test.
        snapshot_rows[1] = {
            "artist_id": "artist_002",
            "artistName": "Superstar Peer",
            "spotifyMonthlyListeners": 50_000_000,
            "youtubeSubscribers": 20_000_000,
            "instagramFollowers": 30_000_000,
            "facebookFollowers": 5_000_000,
            "twitterFollowers": 2_000_000,
        }
        monkeypatch.setattr(popularity_calculator, "fetch_artist_snapshots", lambda: snapshot_rows)

        # Monotonically increasing -> latest value == historical max on every
        # platform. Under the old buggy branch this alone forced base_score
        # (and, absent trends, the final score) to ~100.
        monotonic_metrics = (
            make_metrics(90, "spotify", start=1000, daily_growth=50)
            + make_metrics(90, "instagram", start=500, daily_growth=30)
        )

        payload = PopularityInput(artist_id="artist_001", platform_metrics=monotonic_metrics)
        out = popularity_calc(payload)

        assert out.artist_id == "artist_001"
        # log1p compresses the 10K-vs-50M gap, so this isn't near-zero — the
        # point is it's nowhere near the ~100 the old self-normalizing branch
        # would have produced for this same monotonic time series.
        assert out.popularity_score < 90

    def test_snapshot_artist_popularity_with_db_fetch(self, monkeypatch):
        snapshot_rows = [
            {
                "artist_id": "artist_001",
                "artistName": "Test Artist",
                "spotifyMonthlyListeners": 100000,
                "youtubeSubscribers": 50000,
                "instagramFollowers": 80000,
                "facebookFollowers": 20000,
                "twitterFollowers": 15000,
            },
            {
                "artist_id": "artist_002",
                "artistName": "Peer Artist",
                "spotifyMonthlyListeners": 50000,
                "youtubeSubscribers": 30000,
                "instagramFollowers": 40000,
                "facebookFollowers": 10000,
                "twitterFollowers": 5000,
            },
        ]
        monkeypatch.setattr(popularity_calculator, "fetch_artist_snapshots", lambda: snapshot_rows)

        payload = PopularityInput(artist_id="artist_001")
        out = popularity_calc(payload)

        assert out.artist_id == "artist_001"
        assert 0 <= out.popularity_score <= 100
        assert "spotify" in out.platform_weights
        assert "spotify" in out.platform_contributions

    def test_snapshot_popularity_for_all_artists(self, monkeypatch):
        snapshot_rows = [
            {
                "artist_id": "artist_001",
                "artistName": "Test Artist",
                "spotifyMonthlyListeners": 100000,
                "youtubeSubscribers": 50000,
                "instagramFollowers": 80000,
                "facebookFollowers": 20000,
                "twitterFollowers": 15000,
            },
            {
                "artist_id": "artist_002",
                "artistName": "Peer Artist",
                "spotifyMonthlyListeners": 50000,
                "youtubeSubscribers": 30000,
                "instagramFollowers": 40000,
                "facebookFollowers": 10000,
                "twitterFollowers": 5000,
            },
        ]
        monkeypatch.setattr(popularity_calculator, "fetch_artist_snapshots", lambda: snapshot_rows)

        outputs = popularity_calc_all()

        assert len(outputs) == 2
        assert outputs[0].artist_id == "artist_001"
        assert outputs[1].artist_id == "artist_002"
        assert all(0 <= out.popularity_score <= 100 for out in outputs)


class TestPopularityGenreTilt:
    """Genre-style platform tilt (Phase 3, Day 6) applied to the base entropy score."""

    def _rows(self):
        # Folk Artist is YouTube-heavy / Spotify-light -- a distribution the
        # regional_folk tilt (toward YouTube) has something real to bite on.
        return [
            {"artist_id": "artist_001", "artistName": "Folk Artist",
             "spotifyMonthlyListeners": 5000, "youtubeSubscribers": 500000,
             "instagramFollowers": 20000, "facebookFollowers": 10000},
            {"artist_id": "artist_002", "artistName": "Peer Artist",
             "spotifyMonthlyListeners": 50000, "youtubeSubscribers": 30000,
             "instagramFollowers": 40000, "facebookFollowers": 10000},
        ]

    def test_tagged_artist_scores_higher_than_untagged(self, monkeypatch):
        # Deterministic "no trends data" regardless of whether pytrends happens
        # to be installed in this environment -- these tests are about the
        # genre tilt, not live Google Trends, which would otherwise make a
        # real (rate-limited, non-deterministic) network call for fake names.
        monkeypatch.setattr(popularity_calculator, "_fetch_google_trends_scores", lambda names: {})
        monkeypatch.setattr(popularity_calculator, "fetch_artist_snapshots", lambda: self._rows())

        monkeypatch.setattr(popularity_calculator, "genre_style_for_artist_name", lambda name: None)
        untagged = popularity_calc(PopularityInput(artist_id="artist_001"))

        monkeypatch.setattr(
            popularity_calculator, "genre_style_for_artist_name",
            lambda name: "regional_folk" if name == "Folk Artist" else None,
        )
        tagged = popularity_calc(PopularityInput(artist_id="artist_001"))

        assert tagged.popularity_score > untagged.popularity_score
        assert tagged.platform_weights["youtube"] > untagged.platform_weights["youtube"]

    def test_single_artist_agrees_with_all_artists_when_tagged(self, monkeypatch):
        """The genre tilt must be applied identically on both paths -- the
        same consistency guarantee _calculate_base_entropy_score's docstring
        already makes for the untagged case."""
        # Deterministic "no trends data" -- see the sibling test's comment above.
        # Without this, calculate() and calculate_all() each make their own
        # live Google Trends call for these fake artist names whenever pytrends
        # happens to be installed, and those two calls aren't guaranteed to
        # agree -- a real flake this test hit once pytrends was installed
        # locally for unrelated live-data debugging.
        monkeypatch.setattr(popularity_calculator, "_fetch_google_trends_scores", lambda names: {})
        monkeypatch.setattr(popularity_calculator, "fetch_artist_snapshots", lambda: self._rows())
        monkeypatch.setattr(
            popularity_calculator, "genre_style_for_artist_name",
            lambda name: "regional_folk" if name == "Folk Artist" else None,
        )

        single = popularity_calc(PopularityInput(artist_id="artist_001"))
        all_outputs = popularity_calc_all()
        from_all = next(o for o in all_outputs if o.artist_id == "artist_001")

        assert single.popularity_score == from_all.popularity_score


class TestPopularityPersistence:
    def test_persist_and_fetch_scores(self):
        outputs = [
            PopularityOutput(
                artist_id="artist_001",
                popularity_score=75.5,
                platform_weights={"spotify": 0.5, "youtube": 0.5},
                platform_contributions={"spotify": 0.4, "youtube": 0.5},
                computed_at="2026-05-21T00:00:00+00:00",
            ),
            PopularityOutput(
                artist_id="artist_002",
                popularity_score=50.0,
                platform_weights={"spotify": 0.7, "youtube": 0.3},
                platform_contributions={"spotify": 0.35, "youtube": 0.15},
                computed_at="2026-05-21T00:00:00+00:00",
            ),
        ]

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = f"{tmpdir}/popularity_test.db"
            db_url = f"sqlite+pysqlite:///{db_path}"
            saved = persist_popularity_scores(outputs, db_url=db_url)
            assert saved == 2

            saved_rows = fetch_saved_popularity(db_url=db_url)
            assert len(saved_rows) == 2
            assert saved_rows[0]["artist_id"] == "artist_001"
            assert saved_rows[1]["artist_id"] == "artist_002"
            assert saved_rows[0]["platform_weights"]["spotify"] == 0.5

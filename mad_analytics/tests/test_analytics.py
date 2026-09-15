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
from mad_analytics.growth.rog_calculator import calculate as growth_calc
from mad_analytics.demand.scorer import calculate as demand_calc
from mad_analytics.revenue.predictor import calculate as revenue_calc
from mad_analytics.popularity import calculate as popularity_calc, calculate_all as popularity_calc_all
import mad_analytics.popularity.calculator as popularity_calculator
from mad_analytics.utils.db import persist_popularity_scores, fetch_saved_popularity
from mad_analytics.utils.feature_engineering import (
    rog, exponential_smooth, seasonality_factor,
    social_velocity, ticket_velocity, infer_artist_tier, metrics_to_df,
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
        # Blueprint v2.0 demand components: platform_size, momentum, google_trends,
        # city_affinity. Only *available* components are reported; momentum is
        # computable from the payload metrics alone (no DB), so it is always present.
        out = demand_calc(self._payload())
        valid = {"platform_size", "momentum", "google_trends", "city_affinity"}
        assert set(out.components).issubset(valid)
        assert "momentum" in out.components

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
        # (and, absent momentum/trends, the final score) to ~100.
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

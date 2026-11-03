from __future__ import annotations

import tempfile

from sqlalchemy import create_engine, text

from mad_analytics.utils.feature_engineering import infer_venue_capacity
from mad_analytics.utils.schemas import VenueCapacityInput
from mad_analytics.venue_capacity import calculate
from mad_analytics.venue_capacity.resolver import (
    extract_capacity_candidates,
    fetch_saved_capacity_resolutions,
)


def test_extract_capacity_candidates_from_source_text():
    candidates = extract_capacity_candidates([
        "The arena has a seating capacity of 12,500 for concerts.",
        "Standing capacity 2k depending on the configuration.",
    ])

    values = sorted(candidate.capacity for candidate in candidates)
    assert values == [2_000, 12_500]
    assert all(candidate.confidence > 0.5 for candidate in candidates)


def test_resolve_uses_supplied_capacity_and_validates():
    output = calculate(
        VenueCapacityInput(
            venue_name="Example Arena",
            city="Mumbai",
            country="India",
            venue_type="arena",
            supplied_capacity=15_000,
        )
    )

    assert output.capacity == 15_000
    assert output.status == "validated"
    assert output.source == "supplied"
    assert output.capacity_min < output.capacity < output.capacity_max


def test_resolve_estimates_when_no_source_exists():
    output = calculate(
        VenueCapacityInput(
            venue_name="Sample Club",
            city="Indore",
            country="India",
            venue_type="club",
            artist_tier="rising",
            # Web search is on by default. With a search key in backend/.env
            # (which many other tests load as a side effect of importing the
            # scrapers) this test made a live, billable lookup and got a web
            # result instead of the heuristic it asserts on.
            enable_web_search=False,
        )
    )

    assert output.capacity >= 100
    assert output.status in {"estimated", "review_required"}
    assert output.source == "heuristic"
    assert "capacity was estimated from venue metadata" in output.validation_reasons


def test_infer_venue_capacity_routes_through_resolver():
    assert infer_venue_capacity("Mumbai", "superstar") == 20_000
    assert infer_venue_capacity("Indore", "superstar") == 14_400


def test_persist_and_fetch_capacity_resolution():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_url = f"sqlite+pysqlite:///{tmpdir}/capacity.db"
        output = calculate(
            VenueCapacityInput(
                venue_name="Audit Grounds",
                city="Bengaluru",
                country="India",
                venue_type="grounds",
                supplied_capacity=30_000,
                persist=True,
                db_url=db_url,
            )
        )

        saved = fetch_saved_capacity_resolutions(db_url)

    assert output.capacity == 30_000
    assert len(saved) == 1
    assert saved[0]["venue_name"] == "Audit Grounds"
    assert saved[0]["capacity"] == 30_000
    assert saved[0]["candidates"][0]["source"] == "supplied"


def test_resolve_prefers_existing_venue_db_capacity():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_url = f"sqlite+pysqlite:///{tmpdir}/venues.db"
        engine = create_engine(db_url)
        with engine.begin() as conn:
            conn.execute(text(
                """
                CREATE TABLE venues (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    city TEXT NOT NULL,
                    state TEXT,
                    country TEXT NOT NULL,
                    address TEXT,
                    latitude NUMERIC,
                    longitude NUMERIC,
                    "capacityMin" INTEGER,
                    "capacityMax" INTEGER,
                    "avgCapacity" INTEGER,
                    "ticketPriceMin" NUMERIC,
                    "ticketPriceMax" NUMERIC,
                    "avgTicketPrice" NUMERIC,
                    "venueType" TEXT,
                    verified BOOLEAN,
                    source TEXT,
                    "sourceUrl" TEXT,
                    "lastUpdated" TEXT,
                    created_at TEXT,
                    UNIQUE (name, city, country)
                )
                """
            ))
            conn.execute(
                text(
                    """
                    INSERT INTO venues
                        (id, name, city, country, "capacityMin", "capacityMax", "avgCapacity",
                         "venueType", verified, source, "sourceUrl", "lastUpdated", created_at)
                    VALUES
                        ('v1', 'Known Stadium', 'Mumbai', 'India', 45000, 50000, 48000,
                         'stadium', 1, 'seed', 'https://example.com', '2026-05-21', '2026-05-21')
                    """
                )
            )
        engine.dispose()

        output = calculate(
            VenueCapacityInput(
                venue_name="Known Stadium",
                city="Mumbai",
                country="India",
                venue_type="stadium",
                db_url=db_url,
            )
        )

    assert output.capacity == 48_000
    assert output.status == "validated"
    assert output.source == "venue_db"

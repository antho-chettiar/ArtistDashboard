"""
Regression test for the 2026-09 Venues-page market-toggle incident: a
curated (no-tracked-concert-yet) venue like Shillong's Jawaharlal Nehru
Stadium has no concert row of its own, so inferring "is this India" purely
from real concert history wrongly classified it as international -- it has
zero tracked concerts in this roster's data. KNOWN_INDIA_CITIES is the
explicit, hand-maintained ground truth instead.
"""
from mad_analytics.venue_capacity.known_venues import KNOWN_VENUES, KNOWN_INDIA_CITIES


def test_known_india_cities_are_all_real_known_venues_cities():
    cities = {city for (_, city) in KNOWN_VENUES}
    assert KNOWN_INDIA_CITIES.issubset(cities)


def test_shillong_tagged_india_despite_no_tracked_concert():
    assert "shillong" in KNOWN_INDIA_CITIES


def test_a_curated_international_city_not_tagged_india():
    assert "adelaide" not in KNOWN_INDIA_CITIES
    assert "london" not in KNOWN_INDIA_CITIES


def test_major_india_cities_present():
    for city in ("delhi", "mumbai", "kolkata", "chennai", "hyderabad", "ahmedabad"):
        assert city in KNOWN_INDIA_CITIES

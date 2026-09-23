"""
tests/test_regional_trends.py
Pure, offline-testable: city_to_geo_code() never touches the network --
regional_trend_score() itself needs a live pytrends call, out of scope for
an automated test (same reasoning as the existing Google Trends tests not
hitting the live API).
"""
from mad_analytics.trends.regional import city_to_geo_code


class TestCityToGeoCode:
    def test_known_city_resolves_to_its_state_code(self):
        assert city_to_geo_code("Mumbai") == "IN-MH"
        assert city_to_geo_code("Chennai") == "IN-TN"
        assert city_to_geo_code("Delhi") == "IN-DL"

    def test_city_alias_normalizes_before_lookup(self):
        # "Bangalore" -> "bengaluru" via the shared _CITY_ALIASES table
        assert city_to_geo_code("Bangalore") == "IN-KA"
        assert city_to_geo_code("New Delhi") == "IN-DL"

    def test_unmapped_city_returns_none_not_a_guess(self):
        assert city_to_geo_code("Nowhereville") is None

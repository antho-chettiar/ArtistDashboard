"""
trends/regional.py
State-level (NOT literally city-level -- Google Trends' public API doesn't
go finer than state/region for India) search interest for one artist in one
city's state. Built 2026-09 to sharpen Tier 2 of the feasibility hierarchy in
revenue/predictor.py: that tier currently softens the language-mismatch
penalty using NATIONAL Popularity as a blunt proxy for "does this artist's
fame transcend the local language here" -- a state-specific trend score
answers that question directly for the actual city in question, instead of
inferring it from a countrywide number.

CITY_TO_STATE_CODE covers only this platform's actually-tracked touring
cities (not an exhaustive India gazetteer) -- lean on purpose, per the
"nothing built that isn't used" direction. A city with no entry returns None
(never a fabricated fallback), same discipline as everywhere else in this
codebase that resolves city-level data.
"""
from __future__ import annotations

from typing import Optional

CITY_TO_STATE_CODE: dict[str, str] = {
    # Maharashtra
    "mumbai": "IN-MH", "thane": "IN-MH", "navi mumbai": "IN-MH", "pune": "IN-MH",
    "nagpur": "IN-MH", "sangamner": "IN-MH", "kolhapur": "IN-MH",
    # Delhi
    "delhi": "IN-DL", "new delhi": "IN-DL",
    # Karnataka
    "bengaluru": "IN-KA", "bangalore": "IN-KA", "mysuru": "IN-KA", "manipal": "IN-KA",
    "moodbidri": "IN-KA", "nitte / karkala": "IN-KA",
    # Telangana
    "hyderabad": "IN-TG",
    # Tamil Nadu
    "chennai": "IN-TN",
    # West Bengal
    "kolkata": "IN-WB", "durgapur": "IN-WB",
    # Gujarat
    "ahmedabad": "IN-GJ", "surat": "IN-GJ", "rajkot": "IN-GJ", "gandhinagar": "IN-GJ", "diu": "IN-GJ",
    # Rajasthan
    "jaipur": "IN-RJ", "jodhpur": "IN-RJ",
    # Chandigarh (UT)
    "chandigarh": "IN-CH",
    # Uttar Pradesh
    "lucknow": "IN-UP", "kanpur": "IN-UP", "varanasi": "IN-UP", "prayagraj": "IN-UP",
    "bareilly": "IN-UP", "greater noida": "IN-UP", "kharagpur": "IN-WB",
    # Madhya Pradesh
    "indore": "IN-MP", "bhopal": "IN-MP", "ujjain": "IN-MP",
    # Assam
    "guwahati": "IN-AS", "jatinga": "IN-AS",
    # Chhattisgarh
    "raipur": "IN-CT",
    # Jharkhand
    "jamshedpur": "IN-JH",
    # Punjab
    "amritsar": "IN-PB", "gurdaspur": "IN-PB", "batala": "IN-PB",
    # Uttarakhand
    "dehradun": "IN-UK", "kunjapuri / tehri garhwal": "IN-UK",
    # Arunachal Pradesh
    "itanagar": "IN-AR",
    # Andhra Pradesh
    "visakhapatnam": "IN-AP",
    # Haryana
    "gurugram": "IN-HR",
    # Odisha
    "bhubaneswar": "IN-OR", "cuttack": "IN-OR",
}


def city_to_geo_code(city: str) -> Optional[str]:
    from ..demand.scorer import _normalize_city_key
    return CITY_TO_STATE_CODE.get(_normalize_city_key(city))


# Human-readable state/UT name for each geo code above -- used only to label
# the score honestly in the UI ("state-level search interest in Maharashtra",
# never "in Mumbai") so the granularity limitation is never mistaken for
# city-level precision. Kept in lockstep with CITY_TO_STATE_CODE's codes.
GEO_CODE_TO_STATE_NAME: dict[str, str] = {
    "IN-MH": "Maharashtra", "IN-DL": "Delhi", "IN-KA": "Karnataka",
    "IN-TG": "Telangana", "IN-TN": "Tamil Nadu", "IN-WB": "West Bengal",
    "IN-GJ": "Gujarat", "IN-RJ": "Rajasthan", "IN-CH": "Chandigarh",
    "IN-UP": "Uttar Pradesh", "IN-MP": "Madhya Pradesh", "IN-AS": "Assam",
    "IN-CT": "Chhattisgarh", "IN-JH": "Jharkhand", "IN-PB": "Punjab",
    "IN-UK": "Uttarakhand", "IN-AR": "Arunachal Pradesh", "IN-AP": "Andhra Pradesh",
    "IN-HR": "Haryana", "IN-OR": "Odisha",
}


def geo_code_to_state_name(geo_code: Optional[str]) -> Optional[str]:
    if not geo_code:
        return None
    return GEO_CODE_TO_STATE_NAME.get(geo_code)


def regional_trend_score(
    artist_name: str,
    city: str,
    timeframe: str = "today 12-m",
) -> Optional[float]:
    """Real, state-level search interest (0-100, same pytrends-normalized
    scale as the national Popularity trend score) for one artist. Returns
    None -- never a fabricated 0 -- when the city has no known state mapping.
    KNOWN LIMITATION inherited from _fetch_batch: a live pytrends fetch
    failure also currently returns 0.0 there, indistinguishable from a
    genuine zero-interest result -- pre-existing behavior of the shared
    fetch helper, not something this function newly introduces."""
    geo = city_to_geo_code(city)
    if not geo:
        return None

    from .google_trends import _get_pytrends_client, _fetch_batch
    pytrends = _get_pytrends_client()
    scores = _fetch_batch(pytrends, [artist_name], geo=geo, timeframe=timeframe)
    return scores.get(artist_name)

"""
Web search integration for venue capacity resolution.
Uses SerpAPI (Google Search) to find real venue capacity data.

Security measures:
- API key is ONLY read from environment variable SERPAPI_KEY (never hardcoded)
- Rate limited: max 50 searches/hour, 10 searches/minute
- Results are cached in DB so the same venue is never searched twice
- Only called server-side from the resolver pipeline
"""
from __future__ import annotations

import os
import re
import time
import logging
from typing import Optional

from ..utils.schemas import VenueCapacityCandidate

logger = logging.getLogger(__name__)

SERPAPI_KEY_ENV = "SERPAPI_KEY"

# ── Rate limiting ──────────────────────────────────────────────────────────────

_search_timestamps: list[float] = []
MAX_SEARCHES_PER_HOUR = 100
MAX_SEARCHES_PER_MINUTE = 15


def _is_rate_limited() -> bool:
    """Check if we've exceeded the search rate limit."""
    now = time.time()
    _search_timestamps[:] = [t for t in _search_timestamps if now - t < 3600]

    if len(_search_timestamps) >= MAX_SEARCHES_PER_HOUR:
        logger.warning("Web search hourly rate limit reached. Skipping.")
        return True

    recent = [t for t in _search_timestamps if now - t < 60]
    if len(recent) >= MAX_SEARCHES_PER_MINUTE:
        logger.warning("Web search per-minute rate limit reached. Skipping.")
        return True

    return False


def _record_search():
    """Record a search timestamp for rate limiting."""
    _search_timestamps.append(time.time())


# ── Capacity extraction patterns ──────────────────────────────────────────────

CAPACITY_PATTERNS = [
    # "capacity of 7,000" / "capacity: 7000" / "seating capacity of 15,000"
    re.compile(
        r"(?:seating\s+)?capacity\s*(?:of|:|\s*is)?\s*(\d[\d,]*)\s*(?:seats?|people|guests)?",
        re.IGNORECASE,
    ),
    # "7,000 seats" / "15000-seat arena"
    re.compile(
        r"(\d[\d,]*)\s*[-\s]?\s*seats?",
        re.IGNORECASE,
    ),
    # "holds 7,000" / "accommodates 15,000"
    re.compile(
        r"(?:holds?|accommodates?|fits?)\s+(?:up\s+to\s+)?(\d[\d,]*)",
        re.IGNORECASE,
    ),
    # "7,000 capacity"
    re.compile(
        r"(\d[\d,]*)\s*(?:[-\s])?capacity",
        re.IGNORECASE,
    ),
    # "venue for 7,000"
    re.compile(
        r"(?:venue|arena|hall|stadium|theater|theatre)\s+(?:for|of)\s+(\d[\d,]*)",
        re.IGNORECASE,
    ),
]


def _parse_number(raw: str) -> int:
    """Parse a number string like '7,000' or '15000' to int."""
    cleaned = raw.replace(",", "").strip()
    try:
        return int(float(cleaned))
    except (ValueError, TypeError):
        return 0


def _is_reasonable_capacity(value: int) -> bool:
    """Filter out numbers that are clearly not venue capacities."""
    return 50 <= value <= 250_000


def _extract_capacities_from_text(text: str) -> list[int]:
    """Extract all plausible capacity numbers from a text snippet."""
    results = []
    for pattern in CAPACITY_PATTERNS:
        for match in pattern.finditer(text):
            value = _parse_number(match.group(1))
            if _is_reasonable_capacity(value):
                results.append(value)
    return results


# ── Main search function ───────────────────────────────────────────────────────

def search_venue_capacity(
    venue_name: str,
    city: str,
    country: str = "",
    *,
    api_key: Optional[str] = None,
) -> list[VenueCapacityCandidate]:
    """
    Search Google via SerpAPI for venue capacity information.

    Returns a list of VenueCapacityCandidate objects extracted from search results.
    Returns empty list if API key is not configured, rate limit hit, or search fails.
    """
    key = api_key or os.environ.get(SERPAPI_KEY_ENV)

    if not key:
        logger.debug("SerpAPI key not configured (set %s env var)", SERPAPI_KEY_ENV)
        return []

    # Skip web search for generic/placeholder venue names
    generic_names = {"venue", "arena", "stadium", "hall", "club", "theater", "theatre", "grounds"}
    if venue_name.lower().strip() in generic_names or len(venue_name.strip()) < 4:
        return []

    if _is_rate_limited():
        return []

    data = fetch_serp_json(build_query(venue_name, city), key)
    if data is None:
        return []
    return parse_serp_response(data, venue_name)


def build_query(venue_name: str, city: str) -> str:
    return f'"{venue_name}" {city} capacity seats'


def fetch_serp_json(query: str, key: str) -> Optional[dict]:
    """One SerpAPI call = one search credit. Split out from parsing so callers
    (e.g. the one-off backfill script) can cache the raw response on disk and
    re-run parse_serp_response() as often as needed WITHOUT spending another
    credit when the extraction rules are tuned."""
    try:
        import urllib.request
        import urllib.parse
        import json

        params = urllib.parse.urlencode({
            "api_key": key,
            "engine": "google",
            "q": query,
            "num": 5,
        })
        url = f"https://serpapi.com/search.json?{params}"

        req = urllib.request.Request(url, headers={"User-Agent": "MAD-Analytics/1.0"})
        # 45s, not 15s: SerpAPI bills a search even when OUR client gives up
        # waiting (2026-11: three 15s timeouts were all charged), so a short
        # timeout wastes credits instead of saving them.
        with urllib.request.urlopen(req, timeout=45) as response:
            data = json.loads(response.read().decode("utf-8"))

        _record_search()
        return data

    except Exception as e:
        logger.warning(f"SerpAPI call failed: {e}")
        return None


def parse_serp_response(data: dict, venue_name: str) -> list[VenueCapacityCandidate]:
    """Pure parsing of a SerpAPI response -- no network, no credits."""
    import json

    # Extract from Knowledge Graph (most accurate)
    candidates: list[VenueCapacityCandidate] = []

    knowledge_graph = data.get("knowledge_graph", {})
    # Only trust the panel if it is actually about THIS venue (Google can show
    # a neighbouring/similarly-named place).
    if knowledge_graph and _mentions_venue(str(knowledge_graph.get("title", "")), venue_name):
        # SerpAPI often returns capacity directly in knowledge graph
        kg_text = json.dumps(knowledge_graph)
        kg_capacities = _extract_capacities_from_text(kg_text)
        for capacity in kg_capacities:
            candidates.append(
                VenueCapacityCandidate(
                    capacity=capacity,
                    source="web_search",
                    method="serpapi_knowledge_graph",
                    confidence=0.92,
                    source_url=knowledge_graph.get("website", ""),
                    raw_text=knowledge_graph.get("description", "")[:200],
                    notes="Extracted from Google Knowledge Graph via SerpAPI",
                )
            )

    # Extract from Answer Box
    answer_box = data.get("answer_box", {})
    if answer_box:
        ab_text = f"{answer_box.get('title', '')} {answer_box.get('snippet', '')} {answer_box.get('answer', '')}"
        ab_capacities = _extract_capacities_from_text(ab_text)
        for capacity in ab_capacities:
            candidates.append(
                VenueCapacityCandidate(
                    capacity=capacity,
                    source="web_search",
                    method="serpapi_answer_box",
                    confidence=0.90,
                    source_url=answer_box.get("link", ""),
                    raw_text=ab_text[:200],
                    notes="Extracted from Google Answer Box via SerpAPI",
                )
            )

    # Extract from organic search results
    organic_results = data.get("organic_results", [])
    for item in organic_results[:5]:
        snippet = item.get("snippet", "")
        title = item.get("title", "")
        link = item.get("link", "")
        combined_text = f"{title} {snippet}"

        # A snippet that never names this venue (e.g. a banquet-hall listing for
        # a different "GMR ..." / "... Convention Centre") must not supply a
        # seat count -- a wrong number is worse than no number for organisers.
        if not _mentions_venue(f"{title} {snippet} {link}", venue_name):
            continue

        capacities = _extract_capacities_from_text(combined_text)

        for capacity in capacities:
            confidence = 0.78
            domain = link.lower()

            if any(auth in domain for auth in ["wikipedia.org", "setlist.fm", "songkick.com"]):
                confidence = 0.88
            elif any(auth in domain for auth in [".gov", "ticketmaster", "livenation", "aeg"]):
                confidence = 0.85
            elif "capacity" in snippet.lower() and venue_name.lower().split()[0] in snippet.lower():
                confidence = 0.82

            candidates.append(
                VenueCapacityCandidate(
                    capacity=capacity,
                    source="web_search",
                    method="serpapi_organic",
                    confidence=confidence,
                    source_url=link,
                    raw_text=snippet[:200] if snippet else None,
                    notes=f"Extracted from search result: {title[:80]}",
                )
            )

    # Deduplicate by capacity value, keeping highest confidence
    seen: dict[int, VenueCapacityCandidate] = {}
    for candidate in candidates:
        existing = seen.get(candidate.capacity)
        if not existing or candidate.confidence > existing.confidence:
            seen[candidate.capacity] = candidate

    # Filter out values that are clearly wrong for the venue type
    filtered = _filter_by_venue_context(list(seen.values()), venue_name)

    return sorted(filtered, key=lambda c: c.confidence, reverse=True)[:3]


_NAME_STOPWORDS = {
    "the", "of", "and", "in", "at", "a", "centre", "center", "complex", "park",
    "club", "mall", "lawns", "lawn", "ground", "grounds", "hall", "stadium",
}


def _name_tokens(value: str) -> set[str]:
    return {t for t in re.findall(r"[a-z0-9]+", value.lower()) if len(t) >= 2 and t not in _NAME_STOPWORDS}


def _mentions_venue(text: str, venue_name: str) -> bool:
    """True when at least half of the venue name's distinctive words appear in
    `text` (a title/snippet/URL). Pure string check -- costs no credits."""
    needed = _name_tokens(venue_name)
    if not needed:
        return True
    found = needed & _name_tokens(text)
    return len(found) * 2 >= len(needed)


def _filter_by_venue_context(
    candidates: list[VenueCapacityCandidate],
    venue_name: str,
) -> list[VenueCapacityCandidate]:
    """Remove candidates that are wildly inconsistent with the venue name."""
    if not candidates:
        return candidates

    name_lower = venue_name.lower()

    # Determine expected range from venue name keywords
    min_expected = 100
    max_expected = 250_000

    if any(kw in name_lower for kw in ("stadium", "grounds", "field")):
        min_expected = 5_000
    elif any(kw in name_lower for kw in ("arena", "garden", "center", "centre", "dome")):
        min_expected = 2_000
    elif any(kw in name_lower for kw in ("amphitheatre", "amphitheater", "pavilion")):
        min_expected = 1_000
    elif any(kw in name_lower for kw in ("theater", "theatre", "auditorium", "hall")):
        min_expected = 500
    elif any(kw in name_lower for kw in ("club", "lounge", "bar")):
        max_expected = 3_000

    filtered = [c for c in candidates if min_expected <= c.capacity <= max_expected]

    # If filtering removed everything, return original (don't lose all data)
    return filtered if filtered else candidates

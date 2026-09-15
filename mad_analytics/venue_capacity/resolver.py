"""Venue capacity extraction, estimation, validation, and persistence."""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from typing import Iterable, Optional

from sqlalchemy import create_engine, text
from sqlalchemy.exc import SQLAlchemyError

from ..utils.schemas import (
    VenueCapacityCandidate,
    VenueCapacityInput,
    VenueCapacityOutput,
)

DATABASE_URL_ENV = "DATABASE_URL"

CITY_TIER_1 = {
    "mumbai",
    "delhi",
    "new delhi",
    "bangalore",
    "bengaluru",
    "hyderabad",
    "chennai",
    "pune",
    "kolkata",
}

CITY_TIER_2 = {
    "ahmedabad",
    "jaipur",
    "chandigarh",
    "lucknow",
    "indore",
    "kochi",
    "bhopal",
    "bhubaneswar",
    "guwahati",
}

VENUE_TYPE_BASELINES = {
    "stadium": 40_000,
    "arena": 15_000,
    "amphitheatre": 8_000,
    "amphitheater": 8_000,
    "theater": 2_500,
    "theatre": 2_500,
    "auditorium": 2_500,
    "club": 700,
    "lounge": 500,
    "bar": 250,
    "festival": 25_000,
    "grounds": 25_000,
    "park": 12_000,
    "hall": 3_500,
    "center": 3_500,
    "centre": 3_500,
    "indoor": 6_000,
}

CAPACITY_PATTERN = re.compile(
    r"""
    (?P<label>
        capacity|seating|seats?|seat\s+count|standing\s+capacity|max(?:imum)?\s+capacity
    )
    [^0-9]{0,20}
    (?P<value>\d[\d,]*(?:\.\d+)?)
    \s*(?P<suffix>[kKmM])?
    """,
    re.IGNORECASE | re.VERBOSE,
)

INLINE_NUMBER_PATTERN = re.compile(
    r"(?P<value>\d[\d,]*(?:\.\d+)?)(?P<suffix>\s*[kKmM])?\s*(?:capacity|seats?|people|crowd)",
    re.IGNORECASE,
)

COMMON_CONTEXT_WORDS = (
    "capacity",
    "seats",
    "seat",
    "standing",
    "maximum",
    "max",
    "crowd",
    "attendance",
    "people",
)


def _normalize_text(value: str) -> str:
    return " ".join(value.strip().split())


def _normalize_name(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", " ", value.lower())
    return re.sub(r"\s+", " ", normalized).strip()


def _normalize_location(value: str) -> str:
    return _normalize_name(value)


def _scale_number(raw_value: str, suffix: Optional[str]) -> int:
    numeric = float(raw_value.replace(",", ""))
    suffix = (suffix or "").strip().lower()
    if suffix == "k":
        numeric *= 1_000
    elif suffix == "m":
        numeric *= 1_000_000
    return int(round(numeric))


def _city_tier(city: str) -> str:
    city_lower = _normalize_name(city)
    if city_lower in CITY_TIER_1 or any(token in city_lower for token in CITY_TIER_1):
        return "tier_1"
    if city_lower in CITY_TIER_2 or any(token in city_lower for token in CITY_TIER_2):
        return "tier_2"
    return "tier_3"


def _venue_type_key(venue_type: str) -> str:
    normalized = _normalize_name(venue_type)
    for key in VENUE_TYPE_BASELINES:
        if key in normalized:
            return key
    return "venue"


def extract_capacity_candidates(texts: Iterable[str], *, source: str = "text") -> list[VenueCapacityCandidate]:
    """Extract structured capacity candidates from freeform text."""
    candidates: list[VenueCapacityCandidate] = []
    for text_value in texts:
        if not text_value:
            continue
        normalized = _normalize_text(text_value)
        lower = normalized.lower()
        for pattern_name, pattern in (("context", CAPACITY_PATTERN), ("inline", INLINE_NUMBER_PATTERN)):
            for match in pattern.finditer(lower):
                value = _scale_number(match.group("value"), match.groupdict().get("suffix"))
                if value <= 0:
                    continue
                snippet = _snippet(normalized, match.start(), match.end())
                confidence = 0.9 if pattern_name == "context" else 0.7
                if any(word in lower for word in ("approx", "about", "around", "roughly", "estimated")):
                    confidence -= 0.12
                candidates.append(
                    VenueCapacityCandidate(
                        capacity=value,
                        source=source,
                        method=f"{pattern_name}_text_extraction",
                        confidence=max(0.35, min(0.98, confidence)),
                        raw_text=snippet,
                        notes=f"Matched {pattern_name} capacity expression",
                    )
                )
    return _dedupe_candidates(candidates)


def estimate_capacity(
    venue_name: str,
    *,
    city: str = "",
    country: str = "",
    venue_type: str = "",
    artist_tier: Optional[str] = None,
) -> VenueCapacityCandidate:
    """Estimate capacity from venue metadata when no direct source exists."""
    normalized_venue = _normalize_name(venue_name)
    venue_hint = _venue_type_key(venue_type or normalized_venue)
    artist_base = {
        "superstar": 20_000,
        "major": 8_000,
        "mid": 3_000,
        "rising": 1_000,
        "micro": 300,
    }.get((artist_tier or "").lower())
    venue_base = VENUE_TYPE_BASELINES.get(venue_hint, artist_base or 5_000)

    city_tier = _city_tier(city)
    city_multiplier = 1.0 if city_tier == "tier_1" else 0.72 if city_tier == "tier_2" else 0.45
    artist_multiplier = {
        "superstar": 1.45,
        "major": 1.15,
        "mid": 0.9,
        "rising": 0.72,
        "micro": 0.45,
    }.get((artist_tier or "").lower(), 1.0)
    if artist_base and venue_hint == "venue":
        artist_multiplier = 1.0

    capacity = int(round(venue_base * city_multiplier * artist_multiplier))
    capacity = max(100, capacity)
    confidence = 0.44

    if any(word in normalized_venue for word in ("stadium", "arena", "festival", "grounds")):
        confidence += 0.18
    if any(word in normalized_venue for word in ("club", "lounge", "bar")):
        confidence += 0.12
    if city_tier == "tier_1":
        confidence += 0.08

    return VenueCapacityCandidate(
        capacity=capacity,
        source="heuristic",
        method="metadata_estimate",
        confidence=max(0.35, min(0.82, confidence)),
        notes=f"Estimated from venue_type={venue_hint}, city_tier={city_tier}, artist_tier={(artist_tier or 'unknown').lower()}",
    )


def _dedupe_candidates(candidates: list[VenueCapacityCandidate]) -> list[VenueCapacityCandidate]:
    seen: set[tuple[int, str, str]] = set()
    deduped: list[VenueCapacityCandidate] = []
    for candidate in sorted(candidates, key=lambda c: (c.capacity, c.confidence), reverse=True):
        key = (candidate.capacity, candidate.source, candidate.method)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(candidate)
    return deduped


def _snippet(text: str, start: int, end: int, radius: int = 24) -> str:
    left = max(0, start - radius)
    right = min(len(text), end + radius)
    return text[left:right].strip()


def _fetch_venue_row(
    venue_name: str,
    city: str,
    country: str,
    db_url: Optional[str],
) -> dict[str, object] | None:
    if not db_url:
        return None
    engine = create_engine(_normalize_db_url(db_url))
    query = text(
        """
        SELECT name, city, country, state, "venueType", "capacityMin", "capacityMax", "avgCapacity",
               "ticketPriceMin", "ticketPriceMax", "avgTicketPrice", verified, source, "sourceUrl", "lastUpdated"
        FROM venues
        WHERE lower(name) = lower(:name)
          AND lower(city) = lower(:city)
          AND lower(country) = lower(:country)
        LIMIT 1
        """
    )
    try:
        with engine.connect() as conn:
            row = conn.execute(query, {"name": venue_name, "city": city, "country": country}).mappings().first()
    except SQLAlchemyError:
        row = None
    finally:
        engine.dispose()
    return dict(row) if row else None


def _normalize_db_url(db_url: str) -> str:
    if db_url.startswith("postgres://"):
        return db_url.replace("postgres://", "postgresql://", 1)
    return db_url


def _resolve_db_url(db_url: Optional[str]) -> Optional[str]:
    return db_url or os.environ.get(DATABASE_URL_ENV)


def _create_capacity_table_query(dialect_name: str) -> str:
    if dialect_name == "sqlite":
        return """
        CREATE TABLE IF NOT EXISTS venue_capacity_records (
            id TEXT PRIMARY KEY,
            venue_name TEXT NOT NULL,
            normalized_venue_name TEXT NOT NULL,
            city TEXT NOT NULL,
            normalized_city TEXT NOT NULL,
            country TEXT NOT NULL,
            normalized_country TEXT NOT NULL,
            venue_type TEXT NOT NULL,
            capacity INTEGER NOT NULL,
            capacity_min INTEGER NOT NULL,
            capacity_max INTEGER NOT NULL,
            confidence NUMERIC NOT NULL,
            status TEXT NOT NULL,
            source TEXT NOT NULL,
            validation_reasons TEXT NOT NULL,
            candidates TEXT NOT NULL,
            source_url TEXT,
            computed_at TEXT NOT NULL,
            inserted_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE (normalized_venue_name, normalized_city, normalized_country)
        )
        """

    return """
    CREATE TABLE IF NOT EXISTS venue_capacity_records (
        id TEXT PRIMARY KEY,
        venue_name TEXT NOT NULL,
        normalized_venue_name TEXT NOT NULL,
        city TEXT NOT NULL,
        normalized_city TEXT NOT NULL,
        country TEXT NOT NULL,
        normalized_country TEXT NOT NULL,
        venue_type TEXT NOT NULL,
        capacity INTEGER NOT NULL,
        capacity_min INTEGER NOT NULL,
        capacity_max INTEGER NOT NULL,
        confidence NUMERIC(5, 4) NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        validation_reasons JSONB NOT NULL,
        candidates JSONB NOT NULL,
        source_url TEXT,
        computed_at TIMESTAMPTZ NOT NULL,
        inserted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (normalized_venue_name, normalized_city, normalized_country)
    )
    """


def _create_capacity_upsert_query(dialect_name: str) -> str:
    if dialect_name == "sqlite":
        return """
        INSERT OR REPLACE INTO venue_capacity_records
            (id, venue_name, normalized_venue_name, city, normalized_city, country, normalized_country,
             venue_type, capacity, capacity_min, capacity_max, confidence, status, source,
             validation_reasons, candidates, source_url, computed_at)
        VALUES
            (:id, :venue_name, :normalized_venue_name, :city, :normalized_city, :country, :normalized_country,
             :venue_type, :capacity, :capacity_min, :capacity_max, :confidence, :status, :source,
             :validation_reasons, :candidates, :source_url, :computed_at)
        """

    return """
    INSERT INTO venue_capacity_records
        (id, venue_name, normalized_venue_name, city, normalized_city, country, normalized_country,
         venue_type, capacity, capacity_min, capacity_max, confidence, status, source,
         validation_reasons, candidates, source_url, computed_at)
    VALUES
        (:id, :venue_name, :normalized_venue_name, :city, :normalized_city, :country, :normalized_country,
         :venue_type, :capacity, :capacity_min, :capacity_max, :confidence, :status, :source,
         CAST(:validation_reasons AS JSONB), CAST(:candidates AS JSONB), :source_url, :computed_at)
    ON CONFLICT (normalized_venue_name, normalized_city, normalized_country) DO UPDATE SET
        venue_name = EXCLUDED.venue_name,
        city = EXCLUDED.city,
        country = EXCLUDED.country,
        venue_type = EXCLUDED.venue_type,
        capacity = EXCLUDED.capacity,
        capacity_min = EXCLUDED.capacity_min,
        capacity_max = EXCLUDED.capacity_max,
        confidence = EXCLUDED.confidence,
        status = EXCLUDED.status,
        source = EXCLUDED.source,
        validation_reasons = EXCLUDED.validation_reasons,
        candidates = EXCLUDED.candidates,
        source_url = EXCLUDED.source_url,
        computed_at = EXCLUDED.computed_at,
        inserted_at = now()
    """


def _create_venue_upsert_query(dialect_name: str) -> str:
    if dialect_name == "sqlite":
        return """
        INSERT OR REPLACE INTO venues
            (id, name, city, state, country, address, latitude, longitude, "capacityMin", "capacityMax", "avgCapacity",
             "ticketPriceMin", "ticketPriceMax", "avgTicketPrice", "venueType", verified, source, "sourceUrl", "lastUpdated", created_at)
        VALUES
            (:id, :name, :city, :state, :country, :address, :latitude, :longitude, :capacityMin, :capacityMax,
             :avgCapacity, :ticketPriceMin, :ticketPriceMax, :avgTicketPrice, :venueType, :verified, :source,
             :sourceUrl, :lastUpdated, :created_at)
        """

    return """
    INSERT INTO venues
        (id, name, city, state, country, address, latitude, longitude, "capacityMin", "capacityMax", "avgCapacity",
         "ticketPriceMin", "ticketPriceMax", "avgTicketPrice", "venueType", verified, source, "sourceUrl", "lastUpdated", created_at)
    VALUES
        (:id, :name, :city, :state, :country, :address, :latitude, :longitude, :capacityMin, :capacityMax,
         :avgCapacity, :ticketPriceMin, :ticketPriceMax, :avgTicketPrice, :venueType, :verified, :source,
         :sourceUrl, :lastUpdated, :created_at)
    ON CONFLICT (name, city, country) DO UPDATE SET
        state = EXCLUDED.state,
        address = EXCLUDED.address,
        latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        "capacityMin" = EXCLUDED."capacityMin",
        "capacityMax" = EXCLUDED."capacityMax",
        "avgCapacity" = EXCLUDED."avgCapacity",
        "ticketPriceMin" = EXCLUDED."ticketPriceMin",
        "ticketPriceMax" = EXCLUDED."ticketPriceMax",
        "avgTicketPrice" = EXCLUDED."avgTicketPrice",
        "venueType" = EXCLUDED."venueType",
        verified = EXCLUDED.verified,
        source = EXCLUDED.source,
        "sourceUrl" = EXCLUDED."sourceUrl",
        "lastUpdated" = EXCLUDED."lastUpdated"
    """


def _ensure_tables(engine) -> None:
    with engine.begin() as conn:
        conn.execute(text(_create_capacity_table_query(engine.dialect.name)))


def _select_best_candidate(candidates: list[VenueCapacityCandidate]) -> VenueCapacityCandidate:
    if not candidates:
        raise ValueError("At least one candidate is required")
    return max(
        candidates,
        key=lambda candidate: (
            candidate.confidence,
            -abs(candidate.capacity),
            candidate.capacity,
        ),
    )


def _validate_capacity(
    candidate: VenueCapacityCandidate,
    *,
    venue_name: str,
    city: str,
    country: str,
    venue_type: str,
    artist_tier: Optional[str],
) -> tuple[VenueCapacityOutput, list[str]]:
    reasons: list[str] = []
    confidence = candidate.confidence
    capacity = int(candidate.capacity)
    status: str

    if capacity < 100:
        reasons.append("capacity is unusually small")
        confidence -= 0.1
    if capacity > 200_000:
        reasons.append("capacity is unusually large")
        confidence -= 0.2
    if candidate.source == "heuristic":
        reasons.append("capacity was estimated from venue metadata")
        confidence -= 0.05
    if candidate.method.endswith("text_extraction"):
        reasons.append("capacity was extracted from source text")
    if any(token in _normalize_name(venue_name) for token in ("stadium", "arena", "grounds", "festival")) and capacity < 1_000:
        reasons.append("venue type and capacity look inconsistent")
        confidence -= 0.15
    if any(token in _normalize_name(venue_type) for token in ("club", "lounge", "bar")) and capacity > 10_000:
        reasons.append("small-venue type and capacity look inconsistent")
        confidence -= 0.15
    if artist_tier and artist_tier.lower() in {"superstar", "major"} and capacity < 500:
        reasons.append("artist tier likely needs a larger venue")
        confidence -= 0.08

    confidence = max(0.05, min(0.99, confidence))
    if confidence >= 0.82 and capacity >= 100:
        status = "validated"
    elif confidence >= 0.6:
        status = "review_required"
    elif candidate.source == "heuristic":
        status = "estimated"
    else:
        status = "review_required"

    spread = max(1, int(round(capacity * (0.08 if status == "validated" else 0.18))))
    output = VenueCapacityOutput(
        venue_name=venue_name,
        normalized_venue_name=_normalize_name(venue_name),
        city=city,
        normalized_city=_normalize_location(city),
        country=country,
        normalized_country=_normalize_location(country),
        venue_type=venue_type or "",
        capacity=capacity,
        capacity_min=max(1, capacity - spread),
        capacity_max=capacity + spread,
        confidence=round(confidence, 4),
        status=status,  # type: ignore[arg-type]
        source=candidate.source,
        validation_reasons=reasons,
        candidates=[candidate],
        computed_at=datetime.now(timezone.utc).isoformat(),
    )
    return output, reasons


def resolve_venue_capacity(payload: VenueCapacityInput) -> VenueCapacityOutput:
    """Resolve venue capacity from DB, supplied evidence, and heuristic fallback."""
    candidates: list[VenueCapacityCandidate] = []
    db_url = _resolve_db_url(payload.db_url)

    # Priority 0: Check curated known venues database (most reliable)
    from .known_venues import lookup_known_capacity
    known_cap = lookup_known_capacity(payload.venue_name, payload.city)
    if known_cap:
        candidates.append(
            VenueCapacityCandidate(
                capacity=known_cap,
                source="known_venues_db",
                method="curated_lookup",
                confidence=0.98,
                notes=f"Verified capacity from curated venue database",
            )
        )

    if payload.supplied_capacity:
        candidates.append(
            VenueCapacityCandidate(
                capacity=payload.supplied_capacity,
                source="supplied",
                method="explicit_input",
                confidence=0.95,
                source_url=payload.source_url,
                notes="Caller supplied capacity directly",
            )
        )

    candidates.extend(extract_capacity_candidates(payload.source_texts, source=payload.source_url or "source_text"))

    if db_url:
        venue_row = _fetch_venue_row(payload.venue_name, payload.city, payload.country, db_url)
        if venue_row:
            # Prefer capacityMax when capacityMin is 0 (indicates incomplete data)
            cap_min = venue_row.get("capacityMin") or 0
            cap_max = venue_row.get("capacityMax") or 0
            cap_avg = venue_row.get("avgCapacity") or 0

            if cap_min == 0 and cap_max > 0:
                db_capacity = cap_max
            elif cap_avg and cap_avg > 0:
                db_capacity = cap_avg
            elif cap_max > 0:
                db_capacity = cap_max
            else:
                db_capacity = cap_min if cap_min > 0 else None

            if db_capacity:
                candidates.append(
                    VenueCapacityCandidate(
                        capacity=int(db_capacity),
                        source="venue_db",
                        method="database_lookup",
                        confidence=0.96 if venue_row.get("verified") else 0.84,
                        source_url=str(venue_row.get("sourceUrl") or payload.source_url or ""),
                        notes="Capacity sourced from backend venues table",
                    )
                )

    if not candidates and payload.enable_web_search:
        # Try web search before falling back to heuristic
        from .web_search import search_venue_capacity
        web_candidates = search_venue_capacity(
            payload.venue_name,
            payload.city,
            payload.country,
        )
        candidates.extend(web_candidates)

    if not candidates:
        candidates.append(
            estimate_capacity(
                payload.venue_name,
                city=payload.city,
                country=payload.country,
                venue_type=payload.venue_type or "",
                artist_tier=payload.artist_tier,
            )
        )

    candidates = _dedupe_candidates(candidates)
    best = _select_best_candidate(candidates)
    output, reasons = _validate_capacity(
        best,
        venue_name=payload.venue_name,
        city=payload.city,
        country=payload.country,
        venue_type=payload.venue_type or "",
        artist_tier=payload.artist_tier,
    )
    output.candidates = candidates
    output.validation_reasons = reasons

    if db_url and payload.persist:
        persist_capacity_resolution(output, db_url=db_url)

    return output


def calculate(payload: VenueCapacityInput) -> VenueCapacityOutput:
    return resolve_venue_capacity(payload)


def persist_capacity_resolution(output: VenueCapacityOutput, *, db_url: str) -> int:
    engine = create_engine(_normalize_db_url(db_url))
    _ensure_tables(engine)
    capacity_record = {
        "id": f"{output.normalized_venue_name}:{output.normalized_city}:{output.normalized_country}",
        "venue_name": output.venue_name,
        "normalized_venue_name": output.normalized_venue_name,
        "city": output.city,
        "normalized_city": output.normalized_city,
        "country": output.country,
        "normalized_country": output.normalized_country,
        "venue_type": output.venue_type,
        "capacity": output.capacity,
        "capacity_min": output.capacity_min,
        "capacity_max": output.capacity_max,
        "confidence": output.confidence,
        "status": output.status,
        "source": output.source,
        "validation_reasons": json.dumps(output.validation_reasons),
        "candidates": json.dumps([candidate.model_dump() for candidate in output.candidates]),
        "source_url": output.candidates[0].source_url if output.candidates else None,
        "computed_at": output.computed_at,
    }

    with engine.begin() as conn:
        conn.execute(text(_create_capacity_upsert_query(engine.dialect.name)), capacity_record)

    venue_upsert = {
        "id": f"venue_{output.normalized_venue_name}_{output.normalized_city}_{output.normalized_country}",
        "name": output.venue_name,
        "city": output.city,
        "state": None,
        "country": output.country,
        "address": None,
        "latitude": None,
        "longitude": None,
        "capacityMin": output.capacity_min,
        "capacityMax": output.capacity_max,
        "avgCapacity": output.capacity,
        "ticketPriceMin": None,
        "ticketPriceMax": None,
        "avgTicketPrice": None,
        "venueType": output.venue_type or None,
        "verified": output.status == "validated",
        "source": output.source,
        "sourceUrl": output.candidates[0].source_url if output.candidates else None,
        "lastUpdated": datetime.now(timezone.utc),
        "created_at": datetime.now(timezone.utc),
    }
    try:
        with engine.begin() as conn:
            conn.execute(text(_create_venue_upsert_query(engine.dialect.name)), venue_upsert)
    except SQLAlchemyError:
        # The analytics audit record is authoritative for this package.
        # Mirroring into backend venues is best-effort for lightweight test DBs.
        pass

    engine.dispose()
    return 1


def fetch_saved_capacity_resolutions(db_url: Optional[str] = None) -> list[dict[str, object]]:
    resolved_db_url = _resolve_db_url(db_url)
    if not resolved_db_url:
        raise RuntimeError(f"Database URL is not configured. Set {DATABASE_URL_ENV} or pass db_url.")

    engine = create_engine(_normalize_db_url(resolved_db_url))
    _ensure_tables(engine)
    query = text(
        """
        SELECT venue_name, normalized_venue_name, city, normalized_city, country, normalized_country,
               venue_type, capacity, capacity_min, capacity_max, confidence, status, source,
               validation_reasons, candidates, source_url, computed_at, inserted_at
        FROM venue_capacity_records
        ORDER BY inserted_at DESC
        """
    )
    with engine.connect() as conn:
        rows = conn.execute(query).mappings().all()
    engine.dispose()

    results: list[dict[str, object]] = []
    for row in rows:
        result = dict(row)
        for key in ("validation_reasons", "candidates"):
            if isinstance(result.get(key), str):
                result[key] = json.loads(str(result[key]))
        result["confidence"] = float(result["confidence"])
        results.append(result)
    return results

"""
training/verify_concerts.py
Concert verification and deduplication system.

What it does:
1. Finds duplicate concerts (same artist + same/similar venue + same/close date)
2. Merges duplicates — keeps the one with most data, deletes the empty one
3. Marks concerts with $0 revenue and 0 tickets as PENDING
4. Normalizes city names ("New York (nyc)" → "New York")
5. Updates verificationStatus field

Usage:
    python -m mad_analytics.training.verify_concerts --db $DATABASE_URL --dry-run
    python -m mad_analytics.training.verify_concerts --db $DATABASE_URL
"""
from __future__ import annotations
import argparse
import os
import re
import sys
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

# Load env
_env_path = Path(__file__).parent.parent.parent / "backend" / ".env"
if _env_path.exists():
    with open(_env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and not os.environ.get(key):
                    os.environ[key] = value

from sqlalchemy import create_engine, text


def _normalize_db_url(url: str) -> str:
    return url.replace("postgres://", "postgresql://", 1) if url.startswith("postgres://") else url


# ── City normalization ─────────────────────────────────────────────────────────

CITY_ALIASES = {
    "new york (nyc)": "New York",
    "new york": "New York",
    "nyc": "New York",
    "los angeles (la)": "Los Angeles",
    "la": "Los Angeles",
    "delhi-ncr": "Delhi",
    "delhi ncr": "Delhi",
    "new delhi": "Delhi",
    "bengaluru": "Bangalore",
    "mumbai": "Mumbai",
    "chennai": "Chennai",
    "kolkata": "Kolkata",
    "atlantic city": "Atlantic City",
}


def normalize_city(city: str) -> str:
    """Normalize city name to canonical form."""
    if not city:
        return city
    lower = city.lower().strip()
    return CITY_ALIASES.get(lower, city.strip())


# ── Venue normalization ────────────────────────────────────────────────────────

def normalize_venue(venue: str) -> str:
    """Normalize venue name for comparison."""
    if not venue:
        return ""
    # Remove common suffixes/prefixes
    cleaned = re.sub(r"\s*[-:,]\s*(Mumbai|Delhi|Bangalore|Chennai|Kolkata|India)$", "", venue, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def venues_match(v1: str, v2: str) -> bool:
    """Check if two venue names refer to the same place."""
    if not v1 or not v2:
        return False
    n1 = normalize_venue(v1).lower()
    n2 = normalize_venue(v2).lower()
    if n1 == n2:
        return True
    # Check if one contains the other
    if n1 in n2 or n2 in n1:
        return True
    # Check first significant word match
    words1 = [w for w in n1.split() if len(w) > 3]
    words2 = [w for w in n2.split() if len(w) > 3]
    if words1 and words2 and words1[0] == words2[0]:
        return True
    return False


# ── Duplicate detection ────────────────────────────────────────────────────────

def find_duplicates(concerts: list[dict]) -> list[tuple[dict, dict]]:
    """Find pairs of concerts that are likely duplicates."""
    duplicates = []
    seen = set()

    for i, c1 in enumerate(concerts):
        if i in seen:
            continue
        for j, c2 in enumerate(concerts[i+1:], start=i+1):
            if j in seen:
                continue

            # Same artist
            if c1["artistId"] != c2["artistId"]:
                continue

            # Same or close date (within 1 day)
            date1 = c1["concertDate"]
            date2 = c2["concertDate"]
            if date1 and date2:
                diff = abs((date1 - date2).days)
                if diff > 1:
                    continue
            else:
                continue

            # Same or similar city
            city1 = normalize_city(c1.get("city") or "")
            city2 = normalize_city(c2.get("city") or "")
            # If both have cities, they must match
            if city1 and city2 and city1.lower() != city2.lower():
                continue
            # If neither has a city, skip (can't confirm they're the same)
            if not city1 and not city2:
                continue

            # Same or similar venue (or one is empty)
            v1 = c1.get("venueName") or ""
            v2 = c2.get("venueName") or ""
            if v1 and v2 and not venues_match(v1, v2):
                continue

            # It's a duplicate
            duplicates.append((c1, c2))
            seen.add(j)

    return duplicates


def pick_winner(c1: dict, c2: dict) -> tuple[dict, dict]:
    """Pick which concert to keep (winner) and which to delete (loser).
    Priority: revenue > tickets > price > capacity > venue > city."""
    def score(c):
        s = 0
        try:
            rev = float(c.get("totalRevenue") or 0)
        except (TypeError, ValueError):
            rev = 0
        try:
            tix = int(c.get("ticketsSold") or 0)
        except (TypeError, ValueError):
            tix = 0
        try:
            price = float(c.get("avgTicketPrice") or 0)
        except (TypeError, ValueError):
            price = 0
        try:
            cap = int(c.get("capacity") or 0)
        except (TypeError, ValueError):
            cap = 0

        if rev > 0: s += 100
        if tix > 0: s += 50
        if price > 0: s += 20
        if cap > 0: s += 10
        if c.get("venueName"): s += 5
        if c.get("city"): s += 3
        return s

    s1 = score(c1)
    s2 = score(c2)

    if s1 >= s2:
        return c1, c2
    else:
        return c2, c1


# ── Main verification ──────────────────────────────────────────────────────────

def run_verification(db_url: str, dry_run: bool = False) -> dict:
    """Run the full verification pipeline."""
    engine = create_engine(_normalize_db_url(db_url))
    stats = {"duplicates_found": 0, "duplicates_merged": 0, "cities_normalized": 0, "empty_flagged": 0}

    with engine.connect() as conn:
        # Load all concerts
        rows = conn.execute(text("""
            SELECT id, "artistId", "concertDate", city, country, "venueName",
                   capacity, "ticketsSold", "avgTicketPrice", "totalRevenue",
                   source, "verificationStatus"
            FROM concerts
            ORDER BY "artistId", "concertDate"
        """)).mappings().all()
        concerts = [dict(r) for r in rows]

    print(f"  Loaded {len(concerts)} concerts")

    # Step 1: Find duplicates
    duplicates = find_duplicates(concerts)
    stats["duplicates_found"] = len(duplicates)
    print(f"  Found {len(duplicates)} duplicate pairs")

    if duplicates:
        print(f"\n  Duplicates:")
        for c1, c2 in duplicates[:15]:
            winner, loser = pick_winner(c1, c2)
            w_rev = float(winner.get("totalRevenue") or 0)
            l_rev = float(loser.get("totalRevenue") or 0)
            print(f"    KEEP: {(winner.get('city') or ''):15s} {str(winner.get('venueName') or '')[:25]:25s} rev={w_rev:>10,.0f}")
            print(f"    DEL:  {(loser.get('city') or ''):15s} {str(loser.get('venueName') or '')[:25]:25s} rev={l_rev:>10,.0f}")
            print()

    # Step 2: Merge duplicates (delete loser, update winner if needed)
    if not dry_run and duplicates:
        with engine.begin() as conn:
            for winner, loser in duplicates:
                # If winner is missing data that loser has, copy it
                updates = {}
                if not winner.get("venueName") and loser.get("venueName"):
                    updates['"venueName"'] = loser["venueName"]
                if not float(winner.get("totalRevenue") or 0) and float(loser.get("totalRevenue") or 0):
                    updates['"totalRevenue"'] = loser["totalRevenue"]
                if not int(winner.get("ticketsSold") or 0) and int(loser.get("ticketsSold") or 0):
                    updates['"ticketsSold"'] = loser["ticketsSold"]
                if not int(winner.get("capacity") or 0) and int(loser.get("capacity") or 0):
                    updates["capacity"] = loser["capacity"]
                if not float(winner.get("avgTicketPrice") or 0) and float(loser.get("avgTicketPrice") or 0):
                    updates['"avgTicketPrice"'] = loser["avgTicketPrice"]

                # Update winner with merged data
                if updates:
                    set_clause = ", ".join(f"{k} = :{k.strip('\"')}" for k in updates)
                    params = {k.strip('"'): v for k, v in updates.items()}
                    params["id"] = winner["id"]
                    conn.execute(text(f"UPDATE concerts SET {set_clause} WHERE id = :id"), params)

                # Delete loser
                conn.execute(text("DELETE FROM concerts WHERE id = :id"), {"id": loser["id"]})
                stats["duplicates_merged"] += 1

    # Step 3: Normalize city names
    city_updates = []
    for c in concerts:
        original = c.get("city") or ""
        normalized = normalize_city(original)
        if normalized != original and normalized:
            city_updates.append((c["id"], normalized))

    stats["cities_normalized"] = len(city_updates)
    print(f"  Cities to normalize: {len(city_updates)}")

    if not dry_run and city_updates:
        with engine.begin() as conn:
            for cid, new_city in city_updates:
                conn.execute(text('UPDATE concerts SET city = :city WHERE id = :id'), {"city": new_city, "id": cid})

    # Step 4: Flag empty concerts as PENDING
    with engine.begin() as conn:
        if not dry_run:
            result = conn.execute(text("""
                UPDATE concerts
                SET "verificationStatus" = 'PENDING'
                WHERE "totalRevenue" = 0 AND "ticketsSold" = 0
                  AND "verificationStatus" != 'PENDING'
            """))
            stats["empty_flagged"] = result.rowcount
        else:
            count = conn.execute(text("""
                SELECT COUNT(*) FROM concerts
                WHERE "totalRevenue" = 0 AND "ticketsSold" = 0
                  AND "verificationStatus" != 'PENDING'
            """)).scalar()
            stats["empty_flagged"] = count

    # Step 5 (REMOVED, 2026-09): used to auto-promote any PENDING concert to
    # verificationStatus = 'VERIFIED' the moment totalRevenue and ticketsSold
    # were both non-zero -- with no check on whether those numbers ever came
    # from a real sale. This is the identical pattern that server.py's
    # _run_data_validation_job() "Fix 5" had (see that function's docstring
    # for the full incident writeup: it re-VERIFIED rows that
    # _run_predict_empty_concerts_job() had itself fabricated), except this
    # copy was worse -- it didn't even carry the `source != 'setlistfm'`
    # guard the server.py version had, and it runs every scheduler cycle via
    # _run_verification_job(). None of the sources this pipeline writes
    # (setlistfm, songkick, bookmyshow, district, HISTORICAL_EXCEL,
    # news-search) are genuine real-time sales-data feeds, so there is no
    # `source` value this can be safely scoped to either. The Concert model's
    # verifiedBy/verifiedAt fields exist for exactly this purpose: VERIFIED
    # is a human judgment call (a person, or a genuine sales-data integration
    # confirming the number), never an automated inference from two fields
    # happening to be non-zero.

    engine.dispose()
    return stats


def main():
    parser = argparse.ArgumentParser(description="Verify and deduplicate concerts")
    parser.add_argument("--db", default=os.environ.get("DATABASE_URL", ""), help="Database URL")
    parser.add_argument("--dry-run", action="store_true", help="Preview without changes")
    args = parser.parse_args()

    if not args.db:
        print("ERROR: Provide --db or set DATABASE_URL")
        sys.exit(1)

    print(f"{'[DRY RUN] ' if args.dry_run else ''}Concert Verification & Deduplication")
    print("=" * 55)

    stats = run_verification(args.db, dry_run=args.dry_run)

    print(f"\n{'='*55}")
    print(f"  RESULTS")
    print(f"{'='*55}")
    print(f"  Duplicates found:    {stats['duplicates_found']}")
    print(f"  Duplicates merged:   {stats['duplicates_merged']}")
    print(f"  Cities normalized:   {stats['cities_normalized']}")
    print(f"  Empty concerts flagged: {stats['empty_flagged']}")
    print(f"{'='*55}")

    if args.dry_run:
        print("\n[INFO] Dry run. Remove --dry-run to apply.")
    else:
        print("\n[OK] Verification complete.")


if __name__ == "__main__":
    main()

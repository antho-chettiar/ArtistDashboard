"""
Run concert scrapers and store results in the database.
Optionally triggers model retraining after ingestion.

Usage:
    python -m mad_analytics.scrapers.run_scraper --db $DATABASE_URL
    python -m mad_analytics.scrapers.run_scraper --db $DATABASE_URL --retrain
    python -m mad_analytics.scrapers.run_scraper --db $DATABASE_URL --source bookmyshow
    python -m mad_analytics.scrapers.run_scraper --db $DATABASE_URL --cities mumbai,delhi-ncr
"""
from __future__ import annotations
import argparse
import logging
import os
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from mad_analytics.scrapers.bookmyshow import scrape_bookmyshow
from mad_analytics.scrapers.district import scrape_district
from mad_analytics.scrapers.setlistfm import scrape_setlistfm
from mad_analytics.scrapers.songkick import scrape_songkick
from mad_analytics.scrapers.models import ScrapedConcert
from mad_analytics.utils.db import get_engine

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


def store_concerts(concerts: list[ScrapedConcert], db_url: str) -> int:
    """Store scraped concerts in the database, skipping duplicates."""
    from sqlalchemy import text

    # Dedicated engine (db_url passed explicitly, CLI usage) -- disposed below,
    # never the shared server-path engine. Also fixes a pre-existing bug: the
    # old local _normalize_db_url only rewrote postgres:// -> postgresql://
    # and didn't strip Prisma-only params like pgbouncer=true, so this script
    # crashed outright against the current DATABASE_URL.
    engine = get_engine(db_url)
    stored = 0

    with engine.begin() as conn:
        for concert in concerts:
            if not concert.date or not concert.artist_name:
                continue

            # Check for duplicate (same artist + city + date). Venue name is
            # deliberately NOT part of this match: real-world testing across
            # a dozen artists in this session found every venue-name mismatch
            # was the *same* real event recorded under two different venue
            # spellings (e.g. "Hotel Dayal Gateway" vs "Dayal Gateway
            # Convention Centre"), never two genuinely different same-day
            # shows -- matching on venue name too was silently letting those
            # re-spelled duplicates through as if they were new concerts.
            existing = conn.execute(text("""
                SELECT id FROM concerts
                WHERE "artistName" = :artist
                  AND city = :city
                  AND "concertDate" = :date
                LIMIT 1
            """), {
                "artist": concert.artist_name,
                "city": concert.city,
                "date": concert.date,
            }).first()

            if existing:
                continue

            # Find matching artist in our DB (required - concerts need a linked artist)
            # Use partial matching: check if any tracked artist name is contained in the scraped name
            artist_row = conn.execute(text("""
                SELECT id, "artistName" FROM artists 
                WHERE "artistName" ILIKE :artist 
                   OR :artist ILIKE '%' || "artistName" || '%'
                   OR "artistName" ILIKE '%' || :artist || '%'
                LIMIT 1
            """), {"artist": concert.artist_name}).first()

            if not artist_row:
                # Artist not in our database — skip this concert
                continue

            artist_id = artist_row[0]

            # Skip generic listing pages (not real events)
            if any(skip in concert.event_name.lower() for skip in [
                "music shows in", "upcoming events", "book tickets for music",
                "near you", "top upcoming",
            ]):
                continue

            # Insert new concert
            conn.execute(text("""
                INSERT INTO concerts (
                    id, "artistId", "concertDate", city, country,
                    "venueName", capacity, "ticketsSold",
                    "avgTicketPrice", "totalRevenue", currency,
                    "artistName", source, "sourceUrl", notes,
                    "verificationStatus", created_at
                ) VALUES (
                    gen_random_uuid(),
                    :artist_id,
                    :date, :city, :country,
                    :venue, 0, 0,
                    :avg_price, 0, :currency,
                    :artist_name, :source, :source_url, :notes,
                    'PENDING', NOW()
                )
            """), {
                "artist_id": artist_id,
                "date": concert.date,
                "city": concert.city,
                "country": concert.country,
                "venue": concert.venue_name or None,
                "avg_price": concert.avg_ticket_price or 0,
                "currency": concert.currency,
                "artist_name": concert.artist_name,
                "source": concert.source,
                "source_url": concert.source_url,
                "notes": f"Scraped from {concert.source} on {datetime.now().strftime('%Y-%m-%d')}. "
                         f"Event: {concert.event_name}. Time: {concert.time or 'TBA'}. "
                         f"Price range: {concert.price_min or '?'} - {concert.price_max or '?'} {concert.currency}",
            })
            stored += 1

    engine.dispose()
    return stored


def retrain_model(db_url: str):
    """Retrain the revenue model with updated data."""
    logger.info("Retraining revenue model...")
    from mad_analytics.training.train_revenue import load_training_data, train
    from mad_analytics.utils import model_store

    df = load_training_data(db_url)
    if len(df) < 10:
        logger.warning(f"Only {len(df)} training samples, skipping retrain.")
        return

    model, preprocessor = train(df)
    model_store.save("revenue_model", model)
    model_store.save("revenue_preprocessor", preprocessor)
    logger.info("Model retrained and saved.")


def main():
    parser = argparse.ArgumentParser(description="Scrape concerts and store in database")
    parser.add_argument("--db", default=os.environ.get("DATABASE_URL", ""),
                        help="PostgreSQL connection URL")
    parser.add_argument("--source", choices=["bookmyshow", "district", "setlistfm", "songkick", "all"], default="all",
                        help="Which source to scrape")
    parser.add_argument("--cities", default="",
                        help="Comma-separated city slugs (default: all major cities)")
    parser.add_argument("--retrain", action="store_true",
                        help="Retrain ML model after ingestion")
    args = parser.parse_args()

    if not args.db:
        # Try loading from backend/.env
        env_path = Path(__file__).parent.parent.parent / "backend" / ".env"
        if env_path.exists():
            with open(env_path) as f:
                for line in f:
                    if line.strip().startswith("DATABASE_URL"):
                        _, _, val = line.strip().partition("=")
                        args.db = val.strip().strip('"').strip("'")
                        break

    if not args.db:
        print("ERROR: Provide --db or set DATABASE_URL")
        sys.exit(1)

    cities = args.cities.split(",") if args.cities else None

    print(f"Concert Scraper")
    print(f"{'='*50}")
    print(f"  Source: {args.source}")
    print(f"  Cities: {cities or 'all major Indian cities'}")
    print(f"  Retrain after: {'yes' if args.retrain else 'no'}")
    print()

    all_concerts: list[ScrapedConcert] = []

    # Get tracked artists from DB (needed for all scrapers now)
    from sqlalchemy import create_engine, text as sql_text
    engine = create_engine(_normalize_db_url(args.db))
    with engine.connect() as conn:
        artists = [dict(r) for r in conn.execute(sql_text('SELECT id, "artistName" FROM artists WHERE active = true')).mappings().all()]
    engine.dispose()
    print(f"  Tracked artists: {len(artists)}\n")

    # Scrape
    if args.source in ("bookmyshow", "all"):
        print("Scraping BookMyShow...")
        bms = scrape_bookmyshow(artists)
        all_concerts.extend(bms)
        print(f"  BookMyShow: {len(bms)} concerts found")

    if args.source in ("district", "all"):
        print("Scraping District (Zomato)...")
        dist = scrape_district(artists)
        all_concerts.extend(dist)
        print(f"  District: {len(dist)} concerts found")

    if args.source in ("setlistfm", "all"):
        print("Scraping Setlist.fm...")
        from sqlalchemy import create_engine, text as sql_text
        engine = create_engine(_normalize_db_url(args.db))
        with engine.connect() as conn:
            artists = [dict(r) for r in conn.execute(sql_text('SELECT id, "artistName" FROM artists WHERE active = true')).mappings().all()]
        engine.dispose()
        setlists = scrape_setlistfm(artists)
        all_concerts.extend(setlists)
        print(f"  Setlist.fm: {len(setlists)} concerts found")

    if args.source in ("songkick", "all"):
        print("Scraping Songkick...")
        from sqlalchemy import create_engine, text as sql_text
        engine = create_engine(_normalize_db_url(args.db))
        with engine.connect() as conn:
            artists = [dict(r) for r in conn.execute(sql_text('SELECT id, "artistName" FROM artists WHERE active = true')).mappings().all()]
        engine.dispose()
        sk = scrape_songkick(artists)
        all_concerts.extend(sk)
        print(f"  Songkick: {len(sk)} concerts found")

    print(f"\nTotal scraped: {len(all_concerts)} concerts")

    if not all_concerts:
        print("No concerts found. Exiting.")
        sys.exit(0)

    # Store
    print(f"\nStoring in database...")
    stored = store_concerts(all_concerts, args.db)
    print(f"  New concerts stored: {stored}")
    print(f"  Duplicates skipped: {len(all_concerts) - stored}")

    # Retrain
    if args.retrain and stored > 0:
        print()
        retrain_model(args.db)

    print(f"\n[OK] Done. {stored} new concerts ingested.")


if __name__ == "__main__":
    main()

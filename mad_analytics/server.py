"""
server.py — FastAPI bridge between Express/TypeScript and mad_analytics.

Includes a background scheduler that automatically:
- Scrapes concerts from BookMyShow + District every 12 hours
- Retrains the ML model every 24 hours
- Updates artist popularity scores every 24 hours

Run:
    uvicorn mad_analytics.server:app --port 8001
"""
from __future__ import annotations
import logging
import os
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("mad_analytics")

# Load environment variables from backend/.env if available
_env_path = Path(__file__).parent.parent / "backend" / ".env"
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

from .utils.schemas import (
    GrowthInput,
    DemandInput,
    RevenueInput,
    PopularityInput,
    LlmPredictorInput,
    VenueCapacityInput,
)
from .growth.rog_calculator import calculate as growth_calc
from .demand.scorer import calculate as demand_calc
from .revenue.predictor import calculate as revenue_calc
from .revenue.llm_model import calculate as llm_calc
from .popularity import calculate as popularity_calc, calculate_all as popularity_calc_all
from .utils.db import persist_popularity_scores, fetch_saved_popularity
from .venue_capacity import calculate as venue_capacity_calc
from .venue_capacity.resolver import fetch_saved_capacity_resolutions


# ── Background Scheduler ───────────────────────────────────────────────────────

SCRAPE_INTERVAL_HOURS = int(os.environ.get("SCRAPE_INTERVAL_HOURS", "12"))
RETRAIN_INTERVAL_HOURS = int(os.environ.get("RETRAIN_INTERVAL_HOURS", "24"))
INSTAGRAM_INTERVAL_HOURS = int(os.environ.get("INSTAGRAM_INTERVAL_HOURS", "120"))  # 5 days
GOOGLE_TRENDS_INTERVAL_HOURS = int(os.environ.get("GOOGLE_TRENDS_INTERVAL_HOURS", "168"))  # 7 days
YOUTUBE_API_INTERVAL_HOURS = int(os.environ.get("YOUTUBE_API_INTERVAL_HOURS", "168"))  # 7 days
_scheduler_running = False


def _run_scraper_job():
    """Scrape concerts from BookMyShow + District + Setlist.fm + Songkick and store in DB."""
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        logger.info("[Scheduler] Skipping scrape (DATABASE_URL not set)")
        return 0

    try:
        from .scrapers.run_scraper import store_concerts
        from .scrapers.models import ScrapedConcert

        all_concerts = []

        # Scrape sources that need SerpAPI
        if os.environ.get("SERPAPI_KEY"):
            from .scrapers.bookmyshow import scrape_bookmyshow
            from .scrapers.district import scrape_district
            from .scrapers.songkick import scrape_songkick

            # Get tracked artists for all artist-based scrapers
            from sqlalchemy import create_engine, text as sql_text
            normalized = db_url.replace("postgres://", "postgresql://", 1) if db_url.startswith("postgres://") else db_url
            engine = create_engine(normalized)
            with engine.connect() as conn:
                artists = [dict(r) for r in conn.execute(sql_text('SELECT id, "artistName" FROM artists WHERE active = true')).mappings().all()]
            engine.dispose()

            logger.info("[Scheduler] Running BMS + District + Songkick scrapers...")
            all_concerts.extend(scrape_bookmyshow(artists))
            all_concerts.extend(scrape_district(artists))
            all_concerts.extend(scrape_songkick(artists))

        # Scrape Setlist.fm (has its own API key)
        if os.environ.get("SETLISTFM_API_KEY") or os.environ.get("SETLIST_API_KEY"):
            from .scrapers.setlistfm import scrape_setlistfm
            if not os.environ.get("SERPAPI_KEY"):
                # Need to fetch artists if not already done above
                from sqlalchemy import create_engine, text as sql_text
                normalized = db_url.replace("postgres://", "postgresql://", 1) if db_url.startswith("postgres://") else db_url
                engine = create_engine(normalized)
                with engine.connect() as conn:
                    artists = [dict(r) for r in conn.execute(sql_text('SELECT id, "artistName" FROM artists WHERE active = true')).mappings().all()]
                engine.dispose()
            all_concerts.extend(scrape_setlistfm(artists))

        stored = store_concerts(all_concerts, db_url)
        logger.info(f"[Scheduler] Scrape done: {stored} new concerts from {len(all_concerts)} scraped.")

        # Run venue capacity resolution for new concerts
        _run_venue_capacity_job()

        return stored
    except Exception as e:
        logger.error(f"[Scheduler] Scraper error: {e}")
        return 0


def _run_venue_capacity_job():
    """Resolve venue capacity for concerts that have capacity=0."""
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        return

    try:
        from sqlalchemy import create_engine, text as sql_text
        from .venue_capacity.web_search import search_venue_capacity
        from .venue_capacity.resolver import estimate_capacity

        normalized = db_url.replace("postgres://", "postgresql://", 1) if db_url.startswith("postgres://") else db_url
        engine = create_engine(normalized)

        with engine.connect() as conn:
            # Get concerts with no capacity that have a venue name
            rows = conn.execute(sql_text('''
                SELECT DISTINCT "venueName", city, country
                FROM concerts
                WHERE (capacity = 0 OR capacity IS NULL)
                  AND "venueName" IS NOT NULL AND "venueName" != ''
                LIMIT 20
            ''')).mappings().all()

        if not rows:
            logger.info("[Scheduler] No venues need capacity resolution.")
            engine.dispose()
            return

        logger.info(f"[Scheduler] Resolving capacity for {len(rows)} venues...")
        resolved = 0

        for row in rows:
            venue_name = row["venueName"]
            city = row["city"]
            country = row["country"] or ""

            # Try web search first
            capacity = None
            if os.environ.get("SERPAPI_KEY"):
                candidates = search_venue_capacity(venue_name, city, country)
                plausible = [c for c in candidates if c.capacity >= 500]
                if plausible:
                    capacity = max(plausible, key=lambda c: (c.confidence > 0.8, c.capacity)).capacity

            # Fallback to heuristic
            if not capacity:
                est = estimate_capacity(venue_name, city=city, country=country)
                capacity = est.capacity

            if capacity and capacity > 0:
                with engine.begin() as conn:
                    conn.execute(sql_text('''
                        UPDATE concerts SET capacity = :cap
                        WHERE "venueName" = :venue AND city = :city
                          AND (capacity = 0 OR capacity IS NULL)
                    '''), {"cap": capacity, "venue": venue_name, "city": city})
                resolved += 1

            import time
            time.sleep(2)  # Rate limit for web search

        engine.dispose()
        logger.info(f"[Scheduler] Resolved capacity for {resolved}/{len(rows)} venues.")
    except Exception as e:
        logger.error(f"[Scheduler] Venue capacity error: {e}")


def _run_verification_job():
    """Deduplicate and verify concerts."""
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        return

    try:
        from .training.verify_concerts import run_verification
        logger.info("[Scheduler] Running concert verification...")
        stats = run_verification(db_url, dry_run=False)
        logger.info(f"[Scheduler] Verification: {stats['duplicates_merged']} duplicates merged, {stats['cities_normalized']} cities normalized.")
    except Exception as e:
        logger.error(f"[Scheduler] Verification error: {e}")


def _run_fix_capacities_job():
    """Fix venue capacities using the curated known venues database."""
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        return

    try:
        from sqlalchemy import create_engine, text as sql_text
        from .venue_capacity.known_venues import lookup_known_capacity

        normalized = db_url.replace("postgres://", "postgresql://", 1) if db_url.startswith("postgres://") else db_url
        engine = create_engine(normalized)

        with engine.connect() as conn:
            rows = conn.execute(sql_text("""
                SELECT DISTINCT "venueName", city, capacity
                FROM concerts
                WHERE "venueName" IS NOT NULL AND "venueName" != ''
            """)).mappings().all()

        fixed = 0
        with engine.begin() as conn:
            for r in rows:
                venue = r["venueName"]
                city = r["city"]
                current = int(r["capacity"] or 0)
                known = lookup_known_capacity(venue, city)
                if known and known != current:
                    conn.execute(sql_text("""
                        UPDATE concerts SET capacity = :cap
                        WHERE "venueName" = :venue AND city = :city
                    """), {"cap": known, "venue": venue, "city": city})
                    fixed += 1

        engine.dispose()
        if fixed:
            logger.info(f"[Scheduler] Fixed {fixed} venue capacities from known DB.")
    except Exception as e:
        logger.error(f"[Scheduler] Fix capacities error: {e}")


def _run_predict_empty_concerts_job():
    """Predict tickets_sold and revenue for concerts that have capacity but no revenue."""
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        return

    try:
        from sqlalchemy import create_engine, text as sql_text

        normalized = db_url.replace("postgres://", "postgresql://", 1) if db_url.startswith("postgres://") else db_url
        engine = create_engine(normalized)

        with engine.connect() as conn:
            # Find concerts with capacity but no revenue/tickets
            rows = conn.execute(sql_text("""
                SELECT id, "artistId", city, country, capacity, "avgTicketPrice", "concertDate"
                FROM concerts
                WHERE capacity > 0
                  AND ("totalRevenue" IS NULL OR "totalRevenue" = 0)
                  AND ("ticketsSold" IS NULL OR "ticketsSold" = 0)
                LIMIT 50
            """)).mappings().all()

        if not rows:
            logger.info("[Scheduler] No empty concerts to predict.")
            engine.dispose()
            return

        logger.info(f"[Scheduler] Predicting revenue for {len(rows)} empty concerts...")
        predicted = 0

        for row in rows:
            capacity = int(row["capacity"])
            atp = float(row["avgTicketPrice"] or 0)
            artist_id = row["artistId"]

            # If no ATP, estimate from artist's other concerts
            if atp <= 0:
                with engine.connect() as conn:
                    avg = conn.execute(sql_text("""
                        SELECT AVG("avgTicketPrice") FROM concerts
                        WHERE "artistId" = :aid AND "avgTicketPrice" > 0
                    """), {"aid": artist_id}).scalar()
                atp = float(avg or 1500)

            # Get artist popularity for sell-through estimation
            with engine.connect() as conn:
                pop = conn.execute(sql_text("""
                    SELECT popularity FROM artists WHERE id = :aid
                """), {"aid": artist_id}).scalar()
            popularity = float(pop or 50)

            # Sell-through based on artist popularity:
            # popularity 100 → 95%, 80 → 80%, 60 → 65%, 40 → 50%, 20 → 35%
            sell_through = min(0.95, max(0.30, 0.30 + (popularity / 100) * 0.65))

            tickets_sold = min(int(capacity * sell_through), capacity)
            revenue = round(tickets_sold * atp, 2)

            with engine.begin() as conn:
                conn.execute(sql_text("""
                    UPDATE concerts
                    SET "ticketsSold" = :tickets, "totalRevenue" = :revenue,
                        "avgTicketPrice" = :atp
                    WHERE id = :id AND ("totalRevenue" IS NULL OR "totalRevenue" = 0)
                """), {
                    "tickets": tickets_sold,
                    "revenue": revenue,
                    "atp": round(atp, 2),
                    "id": row["id"],
                })
                predicted += 1

        engine.dispose()
        logger.info(f"[Scheduler] Predicted revenue for {predicted} concerts.")
    except Exception as e:
        logger.error(f"[Scheduler] Prediction error: {e}")


def _run_data_validation_job():
    """Validate all concert data: tickets <= capacity, revenue = tickets * price."""
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        return

    try:
        from sqlalchemy import create_engine, text as sql_text

        normalized = db_url.replace("postgres://", "postgresql://", 1) if db_url.startswith("postgres://") else db_url
        engine = create_engine(normalized)
        fixed = 0

        with engine.begin() as conn:
            # Fix 1: tickets_sold > capacity (cap at 85%)
            oversold = conn.execute(sql_text("""
                UPDATE concerts
                SET "ticketsSold" = CAST(capacity * 0.85 AS INTEGER)
                WHERE "ticketsSold" > capacity AND capacity > 0
                RETURNING id
            """)).fetchall()
            fixed += len(oversold)

            # Fix 2: Recalculate revenue where tickets were capped
            if oversold:
                for row in oversold:
                    conn.execute(sql_text("""
                        UPDATE concerts
                        SET "totalRevenue" = "ticketsSold" * COALESCE("avgTicketPrice", 1500)
                        WHERE id = :id
                    """), {"id": row[0]})

            # Fix 3: Unrealistically low sell-through on predicted concerts (< 20%)
            # Recalculate using artist popularity
            low_st_rows = conn.execute(sql_text("""
                SELECT c.id, c.capacity, c."avgTicketPrice", c."artistId", a.popularity
                FROM concerts c
                JOIN artists a ON a.id = c."artistId"
                WHERE c.capacity > 0
                  AND c."ticketsSold" > 0
                  AND (c."ticketsSold"::float / c.capacity) < 0.20
                  AND c.source IN ('setlistfm', 'songkick', 'bookmyshow', 'district')
            """)).mappings().all()

            for r in low_st_rows:
                pop = float(r["popularity"] or 50)
                sell_through = min(0.95, max(0.30, 0.30 + (pop / 100) * 0.65))
                new_tix = min(int(int(r["capacity"]) * sell_through), int(r["capacity"]))
                new_rev = round(new_tix * float(r["avgTicketPrice"] or 1500), 2)
                conn.execute(sql_text("""
                    UPDATE concerts SET "ticketsSold" = :tix, "totalRevenue" = :rev WHERE id = :id
                """), {"tix": new_tix, "rev": new_rev, "id": r["id"]})
                fixed += 1

            # Fix 4: Revenue = 0 but tickets > 0 and price > 0
            conn.execute(sql_text("""
                UPDATE concerts
                SET "totalRevenue" = "ticketsSold" * "avgTicketPrice"
                WHERE ("totalRevenue" IS NULL OR "totalRevenue" = 0)
                  AND "ticketsSold" > 0
                  AND "avgTicketPrice" > 0
            """))

            # Fix 5: Mark verified/pending status
            conn.execute(sql_text("""
                UPDATE concerts SET "verificationStatus" = 'VERIFIED'
                WHERE "totalRevenue" > 0 AND "ticketsSold" > 0 AND capacity > 0
                  AND "verificationStatus" = 'PENDING'
                  AND source IS NOT NULL AND source != 'setlistfm'
            """))

        engine.dispose()
        if fixed:
            logger.info(f"[Scheduler] Data validation: fixed {fixed} oversold concerts.")
        else:
            logger.info("[Scheduler] Data validation: all data consistent.")
    except Exception as e:
        logger.error(f"[Scheduler] Data validation error: {e}")


def _run_instagram_scraper_job():
    """Scrape Instagram profiles for all active artists and update follower counts + engagement."""
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        logger.info("[Scheduler] Skipping Instagram scrape (DATABASE_URL not set)")
        return

    api_token = os.environ.get("APIFY_API_TOKEN")
    if not api_token:
        logger.info("[Scheduler] Skipping Instagram scrape (APIFY_API_TOKEN not set)")
        return

    try:
        from .scrapers.instagram import run_instagram_scraper_job
        logger.info("[Scheduler] Running Instagram scraper (Apify)...")
        result = run_instagram_scraper_job(db_url=db_url)
        logger.info(f"[Scheduler] Instagram scrape: {result.get('updated_in_db', 0)}/{result.get('total_artists', 0)} "
                    f"artists updated. Engagement: {result.get('with_engagement', 0)}. "
                    f"Failed: {result.get('failed_usernames', [])}")
    except Exception as e:
        logger.error(f"[Scheduler] Instagram scraper error: {e}")


def _run_google_trends_job():
    """Fetch Google Trends scores for all active artists and store in DB."""
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        logger.info("[Scheduler] Skipping Google Trends (DATABASE_URL not set)")
        return

    try:
        from .trends.google_trends import fetch_and_store_trends
        logger.info("[Scheduler] Fetching Google Trends scores...")
        scores = fetch_and_store_trends(db_url=db_url)
        logger.info(f"[Scheduler] Google Trends: updated scores for {len(scores)} artists.")
    except ImportError:
        logger.warning("[Scheduler] pytrends not installed. Run: pip install pytrends")
    except Exception as e:
        logger.error(f"[Scheduler] Google Trends error: {e}")


def _run_youtube_api_job():
    """Fetch YouTube channel stats for all active artists via Data API v3."""
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        logger.info("[Scheduler] Skipping YouTube API (DATABASE_URL not set)")
        return

    api_key = os.environ.get("YOUTUBE_API_KEY")
    if not api_key:
        logger.info("[Scheduler] Skipping YouTube API (YOUTUBE_API_KEY not set)")
        return

    try:
        from .provider.youtube_api import fetch_and_store_all
        logger.info("[Scheduler] Fetching YouTube channel data...")
        count = fetch_and_store_all(db_url=db_url)
        logger.info(f"[Scheduler] YouTube API: updated {count} artists.")
    except ImportError:
        logger.warning("[Scheduler] requests library missing? Run: pip install requests")
    except Exception as e:
        logger.error(f"[Scheduler] YouTube API error: {e}")


def _run_retrain_job():
    """Retrain the revenue prediction model with all available data."""
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        return

    try:
        from .training.train_revenue import load_training_data, train
        from .utils import model_store

        logger.info("[Scheduler] Retraining revenue model...")
        df = load_training_data(db_url)
        if len(df) < 10:
            logger.info(f"[Scheduler] Only {len(df)} samples, skipping retrain.")
            return

        model, preprocessor = train(df)
        model_store.save("revenue_model", model)
        model_store.save("revenue_preprocessor", preprocessor)
        logger.info(f"[Scheduler] Model retrained on {len(df)} samples.")
    except Exception as e:
        logger.error(f"[Scheduler] Retrain error: {e}")


def _run_popularity_job():
    """Update artist popularity scores in the artists table."""
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        return

    try:
        from sqlalchemy import create_engine, text as sql_text

        outputs = popularity_calc_all()
        if not outputs:
            return

        normalized_url = db_url.replace("postgres://", "postgresql://", 1) if db_url.startswith("postgres://") else db_url
        engine = create_engine(normalized_url)
        with engine.begin() as conn:
            for output in outputs:
                conn.execute(
                    sql_text('UPDATE artists SET popularity = :score WHERE id = :id'),
                    {"score": round(output.popularity_score, 2), "id": output.artist_id}
                )
        engine.dispose()
        logger.info(f"[Scheduler] Updated popularity for {len(outputs)} artists.")
    except Exception as e:
        logger.error(f"[Scheduler] Popularity update error: {e}")


def _scheduler_loop():
    """Background scheduler loop — runs all ML models continuously with self-learning."""
    global _scheduler_running
    _scheduler_running = True

    # Wait 60 seconds after startup before first run (let server stabilize)
    time.sleep(60)
    logger.info(f"[Scheduler] Active: scrape every {SCRAPE_INTERVAL_HOURS}h, retrain every {RETRAIN_INTERVAL_HOURS}h")

    # ── STARTUP: Full pipeline run ──
    logger.info("[Scheduler] === STARTUP PIPELINE ===")
    _run_google_trends_job()           # 0. Fetch Google Trends (needed for popularity)
    _run_popularity_job()              # 1. Update artist popularity scores
    _run_verification_job()            # 2. Deduplicate concerts
    _run_fix_capacities_job()          # 3. Fix capacities from known venues DB
    _run_venue_capacity_job()          # 4. Resolve remaining unknown venues (web search)
    _run_predict_empty_concerts_job()  # 5. Predict revenue for empty concerts
    _run_data_validation_job()         # 6. Validate all data (tickets <= capacity, revenue consistency)
    _run_scraper_job()                 # 7. Scrape new concerts
    _run_retrain_job()                 # 8. Retrain ML model (self-learning: more data = better model)
    _run_instagram_scraper_job()       # 9. Scrape Instagram profiles (followers, posts)
    _run_youtube_api_job()             # 10. Fetch YouTube channel stats
    logger.info("[Scheduler] === STARTUP COMPLETE ===")

    # ── PERIODIC: Continuous improvement loop ──
    hours_since_scrape = 0
    hours_since_retrain = 0
    hours_since_instagram = 0
    hours_since_trends = 0
    hours_since_youtube = 0

    while _scheduler_running:
        time.sleep(3600)  # Sleep 1 hour
        hours_since_scrape += 1
        hours_since_retrain += 1
        hours_since_instagram += 1
        hours_since_trends += 1
        hours_since_youtube += 1

        # Every 12 hours: scrape + validate + predict
        if hours_since_scrape >= SCRAPE_INTERVAL_HOURS:
            logger.info("[Scheduler] === 12H CYCLE ===")
            _run_scraper_job()
            _run_verification_job()
            _run_fix_capacities_job()
            _run_venue_capacity_job()
            _run_predict_empty_concerts_job()
            _run_data_validation_job()
            hours_since_scrape = 0

        # Every 24 hours: retrain model (self-learning) + update scores
        if hours_since_retrain >= RETRAIN_INTERVAL_HOURS:
            logger.info("[Scheduler] === 24H RETRAIN (Self-Learning) ===")
            _run_retrain_job()
            _run_popularity_job()
            hours_since_retrain = 0

        # Every 5 days (120 hours): scrape Instagram profiles
        if hours_since_instagram >= INSTAGRAM_INTERVAL_HOURS:
            logger.info("[Scheduler] === 5-DAY INSTAGRAM SCRAPE ===")
            _run_instagram_scraper_job()
            _run_popularity_job()  # Re-calculate popularity with fresh IG data
            hours_since_instagram = 0

        # Every 7 days (168 hours): update Google Trends scores
        if hours_since_trends >= GOOGLE_TRENDS_INTERVAL_HOURS:
            logger.info("[Scheduler] === 7-DAY GOOGLE TRENDS UPDATE ===")
            _run_google_trends_job()
            _run_popularity_job()
            hours_since_trends = 0

        # Every 7 days (168 hours): fetch YouTube channel stats
        if hours_since_youtube >= YOUTUBE_API_INTERVAL_HOURS:
            logger.info("[Scheduler] === 7-DAY YOUTUBE API UPDATE ===")
            _run_youtube_api_job()
            _run_popularity_job()
            hours_since_youtube = 0


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start background scheduler on server startup.

    Set DISABLE_SCHEDULER=1 (or true/yes) to serve the analytics endpoints WITHOUT
    the background scraper/retrain loop — useful for local/API-only runs. Defaults
    to enabled, so normal deployments are unchanged.
    """
    scheduler_disabled = os.environ.get("DISABLE_SCHEDULER", "").strip().lower() in ("1", "true", "yes")
    if scheduler_disabled:
        logger.info("[Server] Background scheduler DISABLED (DISABLE_SCHEDULER set). Endpoints only.")
    else:
        thread = threading.Thread(target=_scheduler_loop, daemon=True, name="mad-scheduler")
        thread.start()
        logger.info("[Server] Background scheduler thread started.")
    yield
    global _scheduler_running
    _scheduler_running = False
    logger.info("[Server] Shutting down.")


# ── FastAPI App ────────────────────────────────────────────────────────────────

app = FastAPI(title="MAD Analytics", version="1.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok", "service": "mad_analytics", "scheduler": _scheduler_running}


@app.post("/llm-predict")
def llm_predict(payload: LlmPredictorInput):
    try:
        return llm_calc(payload)
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))


@app.post("/venue-capacity")
def venue_capacity(payload: VenueCapacityInput):
    try:
        return venue_capacity_calc(payload)
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))


@app.get("/venue-capacity/saved")
def venue_capacity_saved(db_url: str | None = Query(default=None)):
    try:
        return fetch_saved_capacity_resolutions(db_url)
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))


@app.post("/venue-capacity/enrich")
def venue_capacity_enrich(dry_run: bool = Query(default=False)):
    """Batch-resolve venue capacities from concert data."""
    from .training.enrich_venues import (
        load_venues_from_concerts, load_existing_venues, resolve_batch, backfill_concerts,
    )
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        raise HTTPException(status_code=500, detail="DATABASE_URL not configured")
    try:
        df = load_venues_from_concerts(db_url)
        existing = load_existing_venues(db_url)
        results = resolve_batch(df, db_url, existing, dry_run=dry_run)
        updated = backfill_concerts(results, db_url, dry_run=dry_run)
        return {
            "total_venues": len(results),
            "validated": sum(1 for r in results if r["status"] == "validated"),
            "estimated": sum(1 for r in results if r["status"] == "estimated"),
            "capacity_updates": sum(1 for r in results if r["action"] == "update"),
            "concerts_updated": updated,
            "dry_run": dry_run,
        }
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))


@app.post("/growth")
def growth(payload: GrowthInput):
    try:
        return growth_calc(payload)
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))


@app.post("/demand")
def demand(payload: DemandInput):
    try:
        return demand_calc(payload)
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))


@app.post("/revenue")
def revenue(payload: RevenueInput):
    try:
        return revenue_calc(payload)
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))


@app.post("/popularity")
def popularity(payload: PopularityInput):
    try:
        return popularity_calc(payload)
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))


@app.post("/popularity/all/save")
def popularity_all_save():
    try:
        outputs = popularity_calc_all()
        saved = persist_popularity_scores(outputs)
        return {"saved_artists": saved, "saved_at": outputs[0].computed_at if outputs else None}
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))


@app.get("/popularity/saved")
def popularity_saved():
    try:
        return fetch_saved_popularity()
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))


@app.get("/popularity/all")
def popularity_all():
    try:
        return popularity_calc_all()
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))


# Manual trigger endpoints for the scheduler jobs
@app.post("/scheduler/scrape")
def trigger_scrape():
    """Manually trigger the concert scraper."""
    stored = _run_scraper_job()
    return {"status": "done", "new_concerts": stored}


@app.post("/scheduler/retrain")
def trigger_retrain():
    """Manually trigger model retraining."""
    _run_retrain_job()
    return {"status": "done"}


@app.post("/scheduler/popularity")
def trigger_popularity():
    """Manually trigger popularity score update."""
    _run_popularity_job()
    return {"status": "done"}


@app.post("/scheduler/venue-capacity")
def trigger_venue_capacity():
    """Manually trigger venue capacity resolution for concerts with capacity=0."""
    _run_venue_capacity_job()
    return {"status": "done"}


@app.post("/scheduler/verify")
def trigger_verify():
    """Manually trigger concert verification and deduplication."""
    _run_verification_job()
    return {"status": "done"}


@app.post("/scheduler/predict-empty")
def trigger_predict_empty():
    """Manually trigger revenue prediction for empty concerts."""
    _run_predict_empty_concerts_job()
    return {"status": "done"}


@app.post("/scheduler/instagram")
def trigger_instagram():
    """Manually trigger Instagram profile scraping for all artists."""
    _run_instagram_scraper_job()
    return {"status": "done"}


@app.post("/scheduler/google-trends")
def trigger_google_trends():
    """Manually trigger Google Trends score fetch for all artists."""
    _run_google_trends_job()
    return {"status": "done"}


@app.post("/scheduler/youtube")
def trigger_youtube():
    """Manually trigger YouTube Data API scrape for all artists."""
    _run_youtube_api_job()
    return {"status": "done"}

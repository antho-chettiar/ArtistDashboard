# myCONCERT_PIPELINE_AUDIT.md — Concert Ingestion System Audit (Sprint 5)

**Date:** 2026-08-05 · **Mode:** READ-ONLY architectural audit (no code changed).
**Companion docs:** `mySCRAPER_ARCHITECTURE.md` (flow + readiness + target arch), `mySPRINT5_RECOMMENDATION.md` (verdict).

> **Headline finding:** there are **two entirely separate scraper stacks** (TypeScript in `backend/` and Python in `mad_analytics/`) that do **not** connect to each other. The TS BookMyShow/District pipeline **stops at `CanonicalEvent` and never writes `concerts`**. The only scrapers that actually populate the `concerts` table are the **Python** ones (`run_scraper.py`, `scrape_bookmyshow_all.py`) and the TS **setlist.fm** pipeline.

---

## PART 1 — Every scraper located

### A. TypeScript (backend) — event scrapers
| # | File | Purpose | Fetch | Status | Executed via | Output |
|---|---|---|---|---|---|---|
| 1 | `backend/src/services/scrapers/bookmyshow/bookMyShowScraper.ts` | BookMyShow concert listings (India) | **Playwright** → internal JSON API `/api/explore/v1/discover/concerts-{city}` (Cloudflare-cleared) | **Active** (wired) | `POST /api/v1/concerts/ingest/scrapers` → `runConcertScraperIngestion` → `scraper.scrape()` | `ScrapeResult{ events: RawConcertEvent[] }` |
| 2 | `backend/src/services/scrapers/district/districtScraper.ts` | District (by Zomato) events | **Playwright** → server-rendered JSON-LD `ItemList` | **Active** (wired) | same route | `RawConcertEvent[]` (only scraper with `ticketPriceRange`) |
| 3 | `…/scrapers/{jobQueue,rateLimiter,retry}.ts` | Redis-or-in-memory FIFO queue, delay limiter, backoff retry | — | **Active** (used by both scrapers + Viberate) | imported | utilities |
| — | `…/scrapers/bookmyshow/mapper.ts`,`district/mapper.ts`,`*/types.ts` | Map raw → `RawConcertEvent` | — | Active | — | — |

### B. Python (`mad_analytics/scrapers`) — event scrapers
| # | File | Purpose | Fetch | Status | Executed via | Output |
|---|---|---|---|---|---|---|
| 4 | `mad_analytics/scrapers/bookmyshow.py` | BMS concerts by artist name | **SerpAPI** (Google) via `urllib` | Active | `run_scraper.py` | `list[ScrapedConcert]` (no DB write) |
| 5 | `mad_analytics/scrapers/district.py` | District events by artist | **SerpAPI** | Active | `run_scraper.py` | `list[ScrapedConcert]` |
| 6 | `mad_analytics/scrapers/setlistfm.py` | Past/upcoming setlists | **Official Setlist.fm REST API** (`x-api-key`) | Active | `run_scraper.py` | `list[ScrapedConcert]` |
| 7 | `mad_analytics/scrapers/songkick.py` | Songkick concerts (API deprecated → search) | **SerpAPI** (`site:songkick.com`) | Active | `run_scraper.py` | `list[ScrapedConcert]` |
| 8 | `mad_analytics/scrapers/run_scraper.py` | **Orchestrator** — runs 4–6 scrapers, matches artists, **`INSERT INTO concerts`** | SQLAlchemy | **Active** (CLI `__main__`) | `python run_scraper.py --source all` | writes `concerts` |
| 9 | `mad_analytics/scrapers/scrape_bookmyshow_all.py` | **Standalone** full BMS crawl with **tier pricing**, **`INSERT INTO concerts`** | **Playwright + stealth** | **Active** (CLI `__main__`, independent) | `python scrape_bookmyshow_all.py` | writes `concerts` (+ VIP/Tier1-3) |
| — | `mad_analytics/scrapers/models.py` | `ScrapedConcert` dataclass (shared by 4–7) | — | Active | — | — |

### C. Venue / capacity / enrichment (Python `mad_analytics`)
| # | File | Purpose | Status | Persists to |
|---|---|---|---|---|
| 10 | `mad_analytics/venue_capacity/resolver.py` | Layered capacity resolution (`resolve_venue_capacity`) | Active | `venue_capacity_records` (non-Prisma) + mirrors `venues` |
| 11 | `mad_analytics/venue_capacity/known_venues.py` | **136 curated venue→capacity** entries (~132 unique) | Active | in-memory |
| 12 | `mad_analytics/venue_capacity/web_search.py` | SerpAPI capacity web-search (regex extract) | Active | in-memory |
| 13 | `mad_analytics/venue_capacity/pipeline.py` | Aggregate capacity from concerts → `venues` | Active | `venues` |
| 14 | `mad_analytics/training/enrich_venues.py` | Batch venue enrichment + concert capacity backfill | Active | `venues`, `concerts` |
| 15 | `mad_analytics/training/{validate_concerts,verify_concerts}.py` | Concert QA, city-alias normalize, dedup/merge | Active | `concerts` |

### D. TypeScript ingestion pipeline (post-scrape processing)
`eventNormalization.service.ts` → `duplicateDetection`/`duplicateMerge`/`embedding.service.ts` → `hybridValidation.service.ts` → `concertIntelligence.service.ts` (orchestrator) + `concertPipeline.service.ts` (separate setlist.fm path) + `revenuePrediction.service.ts`.

**Note:** `concertIntelligence.runDiscoveryPipeline` and `enqueueDiscoveryPipeline` (the `/scraping/start`, `/intelligence` endpoints) are **no-ops** — they normalize an empty array; a code comment states scraping "is now handled by the Python mad_analytics scheduler." `DuplicateDetectionService.persistDuplicateGroup` is **dead code** (no caller).

---

## PART 3 — Database integration & where the chain breaks

### Paths that DO reach the `concerts` table ✅
- **Python `run_scraper.py`** → `store_concerts()` → `INSERT INTO concerts (...)` (artistId matched by `ILIKE`, `verificationStatus='PENDING'`, `avgTicketPrice`, `currency`, `source`, `sourceUrl`). Capacity/ticketsSold/revenue inserted as 0.
- **Python `scrape_bookmyshow_all.py`** → `store_concerts()` → `INSERT INTO concerts (...)` **plus** `ticketPriceVip/Tier1/Tier2/Tier3`.
- **TS setlist.fm pipeline** (`concertPipeline.service.ts` → `storeValidatedConcert`) → `prisma.concert.create/update` + `prisma.venue.upsert`. Route: `POST /concerts/pipeline*`.
- **Manual admin** `POST/PUT /concerts` → `prisma.concert.create/update`.

### Path that does NOT reach `concerts` ❌ (the chain break)
**TS BookMyShow + District** (`POST /concerts/ingest/scrapers`):
```
scrape → normalizeBatch → detect(dupes) → persistNormalizedEvent → validate
   writes: CanonicalEvent, SourceEventReference, DuplicateGroup(+Member), ValidationLog
   ✗ STOPS — predictForEvent / persistPredictedConcert are gated off
```
`runConcertScraperIngestion` calls `ingestRawEvents` with defaults `runPredictions:false, persistConcerts:false` (concertScraperIngestion.service.ts:105-106), and the controller passes **no override** (concert.controller.ts:549). So `persistPredictedConcert` — the only `prisma.concert.create/update` on that path (concertIntelligence.service.ts:421/425) — is **never executed**. The file header even documents this: "never creates Concert/PredictionOutput/FeatureSnapshot rows."

**Conclusion:** the TS BookMyShow/District data lands in `canonical_events` and stops. The DB-facing concert ingestion that actually works today is **Python-based**.

### Prisma write map (TS pipeline)
`CanonicalEvent` (create/update), `SourceEventReference` (upsert), `DuplicateGroup(+Member)` (create — one path dead), `ValidationLog` (create/updateMany), `PredictionOutput`/`PredictionTrainingData` (revenue service), `FeatureSnapshot` (feature service), `Concert` (only via setlist.fm path / manual / gated-off intelligence path), `Venue` (upsert, setlist.fm path only), `IngestionJob`.

---

## PART 4 — Master field-coverage table

Legend: ✅ produced · ⚠️ partial/derived · ✗ not produced · (in) input-only.

| Field | TS BMS | TS District | Py BMS (serp) | Py District | Py setlist.fm | Py Songkick | Py BMS-all (playwright) |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Artist name | ⚠️ (heuristic) | ⚠️ | ✅ (query) | ✅ | ✅ | ✅ | ⚠️ (regex) |
| Event name | ✅ | ✅ | ✅ | ✅ | ⚠️ (derived) | ✅ | ✅ |
| Venue name | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| City | ✅ (job) | ✅ | ⚠️ | ⚠️ (often "") | ✅ | ⚠️ | ✅ |
| State | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Country | ✅ (India) | ✅ | ✅ (India) | ✅ (India) | ✅ | ⚠️ | ✅ |
| Date | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ (placeholder if none) |
| Time | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ⚠️ |
| Ticket price (single/avg) | ✗ | ✅ | ⚠️ (organic only) | ⚠️ | ✗ | ⚠️ | ✅ |
| Price range (min/max) | ✗ | ⚠️ (min=max) | ✗ | ✗ | ✗ | ✗ | ✅ |
| Price tiers (VIP/T1-3) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✅ |
| Currency | ⚠️ | ✅ (INR) | ✅ | ✅ | ⚠️ | ⚠️ | ✅ (INR) |
| **Capacity** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ (0) |
| **Latitude/Longitude** | ✗ (in) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Booking/source URL | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Source platform | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Source event id | ✅ | ✅ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Organizer | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Genre / Category | ✗ | ✗ | ✗ | ⚠️ (filter only) | ✗ | ✗ | ✗ |
| Availability / sold-out | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Confidence score | ✅ | ✅ | ✗ | ✗ | ✗ | ✗ | ✗ |

**No scraper anywhere extracts capacity or coordinates.** Capacity is added later by the venue resolver; coordinates have no source.

---

## PART 5 — Venue intelligence (what already exists)

| Capability | Exists? | Where | Notes |
|---|:--:|---|---|
| **Venue capacity** | ✅ | `venue_capacity/resolver.py::resolve_venue_capacity` | Layered: **known_venues (136) → supplied → regex text → `venues` table → SerpAPI web search → heuristic estimate**. No LLM. |
| **Venue coordinates / geocoding** | ❌ | — | **No real geocoding anywhere** (no Google Maps/Nominatim/geopy). Coords are hardcoded city→lat/lng tables (`update-all-predictions-with-coords.ts` ~120 cities; BMS `types.ts`), setlist.fm pass-through, or `NULL`/`[0,0]`. Resolver writes `venues.latitude/longitude = None`. |
| **City → tier mapping** | ✅ | `resolver.py` (`CITY_TIER_1/2`) | Used for capacity heuristic + City Affinity. |
| **Venue normalization** | ✅ (×3) | `resolver.py::_normalize_name`, `verify_concerts.py::normalize_venue`, TS `eventNormalization.service.ts` | Three independent implementations. |
| **Venue deduplication** | ✅ (×4) | resolver candidate-dedup, `web_search`, `enrich_venues`, `verify_concerts::find_duplicates`; TS `deduplication/*` (embedding-based) | Multiple, uncoordinated. |
| **Venue aliases** | ⚠️ | `known_venues.py` (duplicate entries as manual aliases) + substring match | No dedicated alias table. City aliases exist in `verify_concerts.py`. |

Persistence: capacity → `venue_capacity_records` (**non-Prisma** table, created via raw DDL) and mirrored to `venues`; `pipeline.py`/`enrich_venues.py` aggregate into `venues` and backfill `concerts.capacity`.

---

## PART 6 — Prediction readiness of scraper output

The analytics formulas (`FORMULAS_IMPLEMENTED_v2.md`) need: **demand** (from artist metrics — already available), **city/city-tier** (available), **venue capacity** and **avg ticket price** (for revenue), plus coordinates (for maps).

| Prediction | Needs | Scraper provides? | Gap |
|---|---|---|---|
| **Revenue** | demand + city tier + capacity + avg price | demand ✅, city ✅, price ⚠️ (District + BMS-all only), **capacity ✗ (from resolver, estimated)** | reliable per-venue capacity; consistent price |
| **Demand** | artist signals + city + momentum | ✅ (from Viberate pipeline, not scrapers) | none from scraper side |
| **Venue recommendation** | venue capacity + city + venue DB | capacity via resolver ⚠️, venue names ✅ | verified capacities, richer venue DB |
| **City recommendation** | city activity + NCCS | ✅ (NCCS + concerts count) | more concert volume |
| **Ticket-price recommendation** | historical prices by city/venue/tier | tiers only from BMS-all ⚠️ | broad price/tier coverage |
| **ROI** | revenue − cost | revenue ⚠️, **cost data ✗** | no cost/fee inputs anywhere |
| **Heat maps** | coordinates | **✗ (no geocoding)** | geocoding for venues/cities |

**Missing fields for full predictions:** reliable **capacity**, **coordinates**, **cost/fee data** (ROI), consistent **ticket tiers**, **organizer/genre/availability**, and a **verified artist↔event link** (scrapers match by fuzzy name).

---

## PART 7 — Excel dependency

| Excel | Still needed? | Reasoning |
|---|---|---|
| **Concert Excel** (`Concerts Venues.xlsx` etc.) | **Largely replaceable** | The Python `run_scraper.py` and `scrape_bookmyshow_all.py` already `INSERT INTO concerts` from live sources with artist matching + dedup. They can seed concerts without Excel — **caveats:** only artists already in the DB are matched; capacity=0 at insert (resolver backfills later); pricing coverage varies by source. |
| **Venue Excel** | **Not required** | Venue capacity comes from `known_venues.py` (136) + resolver + SerpAPI, not Excel. The supplied `Concerts Venues.xlsx` is only a City→Venue reference list, not used by any scraper path. |
| **NCCS Excel** | **Still separate** | NCCS is city-affinity reference data (`nccs.json`), unrelated to scrapers. Keep. |
| **Manual admin import** | **Keep as fallback** | Useful for verified/edge concerts the scrapers miss; ingestion endpoint remains. |

**Verdict for Part 7:** the scraper pipeline can replace the **concert** and **venue** Excel imports for ongoing ingestion; NCCS stays; manual import remains a fallback. The blocker is not Excel — it's that the working scraper→DB path is Python, undocumented as the "official" pipeline, and produces `PENDING` rows needing capacity/coordinate enrichment.

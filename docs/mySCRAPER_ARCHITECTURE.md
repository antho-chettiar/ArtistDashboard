# mySCRAPER_ARCHITECTURE.md — Scraper Data Flow, Readiness & Target Architecture

**Date:** 2026-08-05 · READ-ONLY. Companion to `myCONCERT_PIPELINE_AUDIT.md`.

---

## PART 2 — Data flow (per stack)

### Stack A — TypeScript BookMyShow + District (STOPS at CanonicalEvent)
```
BookMyShow (Playwright→JSON API)   District (Playwright→JSON-LD)
            │                              │
            └──────────► RawConcertEvent[] ◄──────────┘
                              │
        POST /concerts/ingest/scrapers → runConcertScraperIngestion
                              │
                    eventNormalization.normalizeBatch
                              │
                    duplicateDetection.detect  (embedding + candidate match)
                              │
                    duplicateMerge.persistNormalizedEvent
                              │
                    hybridValidation.validate
                              ▼
        DB WRITES: canonical_events, source_event_references,
                   duplicate_groups(+members), validation_logs
                              │
                    ✗ persistConcerts=false (gated OFF)
                              ▼
                   ❌ never reaches `concerts`  ← CHAIN BREAK
```

### Stack B — Python SerpAPI/API orchestrator (REACHES concerts)
```
artists (WHERE active) ──► run_scraper.py
   │
   ├─ bookmyshow.py (SerpAPI) ─┐
   ├─ district.py  (SerpAPI) ──┤
   ├─ setlistfm.py (REST API) ─┤──► list[ScrapedConcert]
   └─ songkick.py  (SerpAPI) ──┘
                     │
        store_concerts(): artist ILIKE match + dup check
                     ▼
        INSERT INTO concerts (verificationStatus='PENDING', avgTicketPrice, source…)
                     │
        (optional) --retrain → train_revenue
                     ▼
                  ✅ `concerts` table
```

### Stack C — Python Playwright full-crawl (REACHES concerts, with tiers)
```
scrape_bookmyshow_all.py (Playwright+stealth, per-city)
   listing pages → event detail pages (dates + tier prices)
                     ▼
        store_concerts(): dup check + artist match
        INSERT INTO concerts (+ ticketPriceVip/Tier1/2/3)
                     ▼
                  ✅ `concerts` table
```

### Stack D — TS setlist.fm pipeline (REACHES concerts) + Venue enrichment
```
POST /concerts/pipeline* → concertPipeline.runPipeline
   setlist.fm REST API → validateHybrid(in-file) → storeValidatedConcert
        prisma.concert.create/update  +  prisma.venue.upsert
                     ▼
                  ✅ `concerts` + `venues`

Venue enrichment (batch, separate):
concerts → enrich_venues.py → resolver.resolve_venue_capacity
   (known_venues → supplied → regex → venues → SerpAPI → heuristic)
        → venue_capacity_records (+ venues) → backfill concerts.capacity
```

**Observation:** four independent write-paths into one `concerts` table, with **no shared normalizer/dedup contract** between the Python and TS worlds. The most sophisticated post-processing (TS normalize→dedup→validate) is bolted only to the path that doesn't persist concerts.

---

## PART 8 — Production-readiness scoring

| Scraper / component | Score | Why |
|---|---|---|
| **Py `run_scraper.py` + SerpAPI scrapers (bms/district/songkick/setlistfm)** | **Needs Minor Work** | Actually writes `concerts` with artist-matching + dedup; degrades gracefully without keys. Gaps: capacity=0 at insert, price coverage patchy, `--cities` vestigial, page-1 only. Depends on paid SerpAPI. |
| **Py `scrape_bookmyshow_all.py` (Playwright)** | **Needs Minor Work** | Richest output (tiers, dates), writes `concerts` directly; stealth + Cloudflare handling present. Gaps: standalone (not orchestrated), placeholder dates, artist via regex, no capacity/coords. |
| **TS `districtScraper.ts`** | **Needs Moderate Work** | Solid Playwright JSON-LD scrape with price range, but its pipeline **never persists concerts**; single URL, no pagination, city not controllable. |
| **TS `bookMyShowScraper.ts`** | **Needs Moderate Work** | Good Playwright/API approach, but no price/capacity, only Mumbai city verified, and pipeline doesn't persist concerts. |
| **TS ingestion pipeline (normalize/dedup/validate/canonical)** | **Needs Moderate Work** | Well-built and active up to `CanonicalEvent`; the final Concert-persistence stage is intentionally gated OFF and unproven end-to-end. Contains one dead function. |
| **Venue capacity resolver (`resolver.py` + `known_venues`)** | **Production Ready** (for capacity) | Layered, sensible fallbacks, persists, 136 curated venues. Weakness: no coordinates; `venue_capacity_records` is outside Prisma (schema drift). |
| **`web_search.py` (SerpAPI capacity)** | **Needs Minor Work** | Works; rate-limited; paid-API dependent; regex extraction can be noisy. |
| **`enrich_venues.py` / `pipeline.py` (venue aggregation + backfill)** | **Needs Minor Work** | Functional batch enrichment/backfill; uncoordinated with TS side. |
| **`verify_concerts.py` / `validate_concerts.py` (QA + dedup)** | **Needs Minor Work** | Real dedup/merge + city normalization; overlaps the TS dedup subsystem. |
| **TS `concertPipeline.service.ts` (setlist.fm)** | **Needs Minor Work** | Genuinely writes concerts + venues; separate from the canonical pipeline; global (non-India). |
| **TS `/scraping/start`, `/intelligence`, `/intelligence/queue`** | **Legacy Only** | No-ops (normalize empty array / return fixed string); scraping delegated to Python. |
| **`DuplicateDetectionService.persistDuplicateGroup`** | **Legacy Only** | Dead code, no caller. |
| **Geocoding / coordinates** | **Needs Major Rewrite** (missing) | No geocoding exists; coords hardcoded/null. Must be built for maps/ROI heat maps. |

---

## PART 9 — Recommended architecture using ONLY existing code

Consolidate onto the **Python ingestion path** (it already reaches `concerts`), add the **existing venue resolver** as an enrichment stage, and reuse the TS **dedup/validation** concepts via the already-working Python `verify_concerts`. Geocoding is the one net-new capability.

```
        ┌─────────────── SOURCES (existing) ───────────────┐
        │  scrape_bookmyshow_all.py (Playwright, tiers)     │
        │  run_scraper.py → bms/district/songkick (SerpAPI) │
        │  setlistfm.py (official API)                      │
        └───────────────────────┬───────────────────────────┘
                                 ▼
                 NORMALIZE + ARTIST-MATCH (run_scraper.store_concerts
                     + verify_concerts.normalize_city/venue)
                                 ▼
                 DEDUP / MERGE (verify_concerts.find_duplicates)
                                 ▼
                 INSERT/UPSERT ► concerts   (verificationStatus=PENDING)
                                 ▼
                 VENUE ENRICHMENT (enrich_venues → resolver:
                    known_venues → DB → SerpAPI → heuristic)
                    → venues (+ venue_capacity_records) → backfill concerts.capacity
                                 ▼
                 [NET-NEW] GEOCODING → concerts/venues lat,lng
                                 ▼
                 PREDICTIONS (mad_analytics: demand/revenue/…)
                    → prediction_outputs
                                 ▼
                 REST APIs (/concerts, /dashboard, /analytics/ml/*)
                                 ▼
                 DASHBOARD (Concerts, Analysis, MapView)
```

**Reuse decisions (no new scrapers needed):**
- **Keep** the Python source scrapers + `scrape_bookmyshow_all.py` as the ingestion front-end (they already persist).
- **Promote** `run_scraper.py` to *the* orchestrator; make it idempotent (upsert, not insert) to stop duplicate concerts.
- **Wire in** `resolver.py`/`enrich_venues.py` as a mandatory post-insert enrichment step.
- **Fold in** `verify_concerts.py` dedup as a scheduled QA pass.
- **Decommission or complete** the TS BookMyShow/District pipeline: either flip `persistConcerts:true` and prove end-to-end, or retire it in favour of the Python path (avoid maintaining two).
- **Add** the missing geocoding stage (only genuinely new component).
- **Reconcile** `venue_capacity_records` into Prisma (schema drift).

See `mySPRINT5_RECOMMENDATION.md` for the verdict and prioritised scope.

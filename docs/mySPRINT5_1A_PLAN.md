# mySPRINT5_1A_PLAN.md — Sprint 5.1-A Implementation Readiness & Plan

**Date:** 2026-08-05 · **Status:** PLAN ONLY — awaiting approval. No code changed, no scrapers run, no schema touched.
Basis: `myBOOKMYSHOW_SCRAPER_AUDIT.md`, `myDISTRICT_SCRAPER_AUDIT.md`, `myCONCERT_SCRAPER_DATA_CONTRACT.md`, `mySPRINT5_SCRAPER_PLAN.md`.

---

## 1. BookMyShow base
**Primary:** `mad_analytics/scrapers/scrape_bookmyshow_all.py` (Playwright + stealth) — it is the only implementation that captures **VIP/Tier1-3 pricing** and event dates from detail pages (hard requirement "preserve VIP/tier pricing"), and it already writes concerts.
**Secondary/fallback:** `mad_analytics/scrapers/bookmyshow.py` (SerpAPI, artist-targeted) — kept for artist-specific top-ups when the full crawl misses an artist. Both feed the same canonical orchestrator.

## 2. District base
**Base:** `mad_analytics/scrapers/district.py` (SerpAPI), **enhanced** by porting the TypeScript `district/mapper.ts` **JSON-LD `offers.price` + `sourceEventId`** extraction (audit found TS price extraction stronger). Optionally add a Playwright JSON-LD read path mirroring `districtScraper.ts` for better price coverage (behind a flag; no new dependency).

## 3. Canonical orchestrator
`mad_analytics/scrapers/run_scraper.py` becomes THE canonical ingestion orchestrator. Its `store_concerts()` is rewritten from "SELECT-exact then INSERT" into: **normalize → artist-match → canonical-key → cross-source dedup → app-level upsert**, then it invokes venue enrichment and geocoding stages.

## 4. TS components ported / reused
| From (TS) | To (Python) | What |
|---|---|---|
| `eventNormalization.service.ts` | NEW `normalization.py` | `normalizeComparableName` (NFKD, lowercase, `&`→and, strip punctuation, strip stopwords `the/official/live/concert/tour/show/band/presents`, collapse), `CITY_ALIASES`/`COUNTRY_ALIASES`, `build_canonical_key(artist,venue,city,country,date)` |
| `district/mapper.ts` | `district.py` | JSON-LD `offers.price` → min/max, `sourceEventId` slug |
| `bookmyshow/mapper.ts` | BMS scrapers | `sourceEventId` regex (`ET\d+`) |
| embedding dedup concept (`embedding.service.ts` → `ml_engine/embeddings.py`, MiniLM) | dedup step | **OPTIONAL** near-duplicate check; canonical-key is primary (no new dependency required) |
| `hybridValidation` signal design | QA step (later) | REFERENCE only for now |

## 5. Exact fields extracted per platform
| Field | BookMyShow (playwright/serp) | District (serp + ported TS) | → Prisma `concerts` col |
|---|---|---|---|
| artistName | ✅ (regex/query) | ✅ (query) | `artistName` (+`artistId`) |
| eventName | ✅ | ✅ | `notes` |
| date | ✅ (detail) | ✅ | `concertDate` |
| time | ⚠️ (detail) | ⚠️ (in datetime) | `notes` (no col) |
| city | ✅ | ✅/⚠️ | `city` |
| venue | ✅ | ✅ | `venueName` |
| eventUrl | ✅ | ✅ | `sourceUrl` |
| sourceEventId | ⚠️→✅ (port) | ⚠️→✅ (port) | — (kept in `notes`/dedup only) |
| minTicketPrice | ✅ | ✅ (offers.price) | `ticketPriceMin` |
| maxTicketPrice | ✅ | ⚠️ (=min) | `ticketPriceMax` |
| tiers VIP/T1-3 | ✅ (preserve) | ❌ | `ticketPriceVip/Tier1/2/3` |
| avgTicketPrice | derived | derived | `avgTicketPrice` |
| currency | ✅ INR | ✅ INR | `currency` |
| source | `BOOKMYSHOW` | `DISTRICT` | `source` |
| capacity | — (enrichment) | — (enrichment) | `capacity` |
| lat/lng | — (geocode) | — (geocode) | `latitude`/`longitude` |

*(Note: current code uses `source='bookmyshow'`/`'district'` lowercase; will standardize to `BOOKMYSHOW`/`DISTRICT` per requirement.)*

## 6. Normalization / dedup strategy
1. **Normalize** artist/venue/city/country via ported rules.
2. **canonical_key** = `normArtist | normVenue | normCity | country | ISO(date)`.
3. **Artist matching:** normalize scraped artist AND the 11 DB artist names; match by normalized equality → alias → contains. **No match ⇒ do NOT insert; append to an unmatched-artists log** (in-memory + printed; optionally a `logs/unmatched_artists.csv` file — no DB/schema change).
4. **Cross-source dedup (in-memory):** group BMS+District events by `canonical_key`; merge into one record, preferring the richest fields (keep tier prices, union of source URLs, first non-null of each field). Optional embedding cosine check to catch venue/name variants that produce different keys.
5. **DB upsert (app-level):** `SELECT` existing concert by the normalized key (artist+venue+city+date) → if found `UPDATE` (fill missing price/tier/capacity) else `INSERT`. Idempotent across runs. **No DB unique constraint added.**

## 7. Exact database write path
```
run_scraper.store_concerts (rewritten)
  → normalize + canonical_key
  → match artist against `artists` (normalized)        [reads artists]
  → SELECT concerts WHERE normalized(artist,venue,city,date)   [idempotency check]
       → UPDATE concerts (enrich)  OR  INSERT INTO concerts (+tier cols)   [writes concerts]
  → enrich_venues / resolver.resolve_venue_capacity     [writes venues, venue_capacity_records; UPDATE concerts.capacity]
  → geocode stage                                        [UPDATE concerts.latitude/longitude, venues lat/lng]
```
Tables written: **`concerts`, `venues`, `venue_capacity_records`** (all existing). No schema change.

## 8. Dependencies to install
**None required for core ingestion.** Uses only what's already present: `sqlalchemy`, `psycopg2-binary`, `playwright` (+ chromium installed), `playwright-stealth`, stdlib `urllib`; SerpAPI via existing `SERPAPI_KEY`.
- **Embedding dedup:** `sentence-transformers` is **NOT** in `mad_analytics/requirements.txt`. To avoid a new dependency, embedding dedup will be **optional/off by default**; canonical-key handles dedup. (If you later want embeddings on, that's a dependency decision I'll raise separately.)

## 9. Schema change I believe is warranted — 🔴 NOT making it
A DB-level natural key on `Concert` — `@@unique([artistId, concertDate, city, venueName])` (or a dedicated `canonicalKey` column) — would give true upsert idempotency and race safety. **🔴 REQUIRES EXPLICIT APPROVAL. Not implemented in 5.1.** App-level canonical-key upsert is used instead.

## 10. Paid API / service I believe is relevant — NOT adding
- **None required.** SerpAPI is already configured (existing key) — I'll reuse it, and flag that a broad scrape consumes SerpAPI quota (cost).
- **Geocoding:** I will **reuse the existing free static city→coordinate table** already in the repo (`backend/scripts/update-all-predictions-with-coords.ts`, ~120 Indian cities) ported to a Python dict — **zero new dependency, zero API.** This gives city-level coordinates (enough to unblock the Map). Venue-level precision would need a geocoder; the only no-cost option is Nominatim via stdlib `urllib` (free, rate-limited) — **I will ask before using it**; I will NOT add Google Maps Geocoding (paid).

## 11. Proposed file-by-file implementation plan
| File | Action | Change |
|---|---|---|
| `mad_analytics/scrapers/normalization.py` | **CREATE** | ported normalize rules, alias maps, `build_canonical_key`, `normalize_artist`, `match_artist(name, db_artists)` |
| `mad_analytics/scrapers/models.py` | **MODIFY** | add `source_event_id`, `price_vip/tier1/2/3`, computed `canonical_key`, `normalized_*` to `ScrapedConcert` (or a `CanonicalConcert`) |
| `mad_analytics/scrapers/district.py` | **MODIFY** | port TS JSON-LD `offers.price` + `sourceEventId`; set `source='DISTRICT'` |
| `mad_analytics/scrapers/bookmyshow.py` | **MODIFY** | add `sourceEventId` regex; `source='BOOKMYSHOW'`; keep as SerpAPI fallback |
| `mad_analytics/scrapers/scrape_bookmyshow_all.py` | **MODIFY** | return canonical objects to the orchestrator (preserve tier extraction); stop using its own separate `store_concerts` (route through `run_scraper`) |
| `mad_analytics/scrapers/run_scraper.py` | **MODIFY** | canonical orchestrator: normalize → artist-match (+unmatched log) → dedup → app-level upsert (incl. tier cols) → call venue enrichment → call geocoding; add `--dry-run`, `--limit`, `--sample` flags for testing |
| `mad_analytics/scrapers/geocode.py` | **CREATE** | free city→coords (ported static table); UPDATE concerts/venues lat/lng |
| `mad_analytics/training/enrich_venues.py` | **REUSE** (minimal/no change) | invoked by orchestrator after persistence |
| `mad_analytics/venue_capacity/resolver.py` | **REUSE** (no change) | capacity resolution |
| `docs/mySPRINT5_1_IMPLEMENTATION_REPORT.md` | CREATE (later) | what was built |
| `docs/mySCRAPER_TEST_RESULTS.md` | CREATE (later, Sprint 5.1-B) | sample-run evidence |
| `docs/myCONCERT_INGESTION_RUNBOOK.md` | CREATE (later) | how to run |

### Testing gate (Sprint 5.1-B, before broad scrape)
`run_scraper --dry-run --sample` will print, without writing: extracted fields per event, #events found, #matched vs #unmatched artists, canonical-key dedup groups, pricing extraction, and venue/capacity enrichment preview. Broad scrape only after this is reviewed.

---

## Constraint compliance
No formula/analytics/popularity/schema/frontend/API changes. No file moves/deletes (legacy migration only after the new pipeline is proven — Sprint 5.11). No paid API, no new dependency without approval. Idempotency via application-level canonical-key upsert (no DB constraint).

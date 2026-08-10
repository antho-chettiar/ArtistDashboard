# myDISTRICT_SCRAPER_AUDIT.md — District Scraper Audit (Sprint 5, READ-ONLY)

**Date:** 2026-08-05 · No code executed, no scrapers called, nothing modified.

Two District implementations exist:
- **TS-DISTRICT** — `backend/src/services/scrapers/district/districtScraper.ts` (+ `mapper.ts`, `types.ts`)
- **PY-DISTRICT** — `mad_analytics/scrapers/district.py` (via `run_scraper.py`)

*(There is no Python Playwright District equivalent to `scrape_bookmyshow_all.py`.)*

---

## Implementation metadata

| Attribute | TS-DISTRICT | PY-DISTRICT (`district.py`) |
|---|---|---|
| Language | TypeScript | Python |
| Entry point | `districtScraper.scrape()` via `POST /concerts/ingest/scrapers` | `scrape_district()` via `run_scraper.py` |
| Scraping tech | Playwright (chromium) → server-rendered **JSON-LD `ItemList`** in DOM | SerpAPI (Google engine) via `urllib` |
| URL strategy | `https://www.district.in/events/` (single `DEFAULT_EVENTS_URL`) | `serpapi.com/search.json` (query = artist name) |
| City discovery | ⚠️ not selectable (server/IP-resolved); `cities` = post-fetch filter only | ❌ artist-driven; `--cities` ignored |
| Event discovery | ✅ parse `<script type="application/ld+json">` → `@type==='ItemList'` → `'Event'` items | ✅ Google `events_results` + `organic_results` filtered to district.in |
| Pagination | ❌ single URL, no pagination (tested no-op) | ❌ single SerpAPI call |
| Detail extraction | ❌ (list-level JSON-LD only) | ❌ |
| Music filter | ❌ | ✅ `_is_music_event` (excludes comedy/food/sports) |
| Error handling | ✅ `retryWithBackoff`, non-retryable 404, `errors[]`, explanatory error on empty city filter | ✅ graceful `[]` |
| Retry logic | ✅ `retry.ts` (3 attempts, backoff) | ❌ |
| Rate limiting | ✅ `rateLimiter.ts` (1500ms) | ❌ (SerpAPI-side) |
| Deduplication | ❌ (delegated downstream) | ✅ in-scraper on `artist|city|date` |
| Output format | `ScrapeResult{ events: RawConcertEvent[] }` | `list[ScrapedConcert]` |
| Writes to DB | ❌ (pipeline gated off — never reaches `concerts`) | ❌ (persistence in `run_scraper.store_concerts`) |
| Executable today | ❓ code present & wired; needs Node + Playwright + live District (unverified) | ❓ needs `SERPAPI_KEY` + Python env (unverified) |
| Proven end-to-end | ❌ never persists concerts | ❓ writes via orchestrator; not verified this session |

---

## Field-by-field extraction

| Field | TS-DISTRICT | PY-DISTRICT |
|---|:--:|:--:|
| artistName | ⚠️ heuristic (match else title) | ✅ (query artist) |
| eventName | ✅ (`item.name`) | ✅ |
| date | ✅ (`startDate` ISO datetime) | ✅ |
| time | ⚠️ present in `startDate` datetime, not split out | ❌ |
| city | ✅ (`address.addressLocality`) | ⚠️ often `""` on organic path |
| venue | ✅ (`location.name`) | ✅ |
| venueAddress | ⚠️ `addressLocality` only (no street) | ❌ |
| **minTicketPrice** | ✅ (`offers.price`) | ⚠️ organic only |
| **maxTicketPrice** | ⚠️ set = min (single price) | ❌ |
| currency | ✅ (`priceCurrency`, default INR) | ✅ (INR) |
| bookingUrl | ✅ (`item.url`) | ✅ |
| source | ✅ `ZOMATO` | ✅ `district` |
| sourceEventId | ✅ (slug last path segment) | ❌ |
| organizer | ❌ | ❌ |
| category | ❌ | ⚠️ music filter only (not stored) |
| image | ❌ | ❌ |
| latitude/longitude | ❌ | ❌ |
| venueCapacity | ❌ | ❌ |
| confidenceScore | ✅ (0.5/0.8) | ❌ |
| country | ✅ (`IN`→India) | ✅ India |

---

## Assessment
- **TS-DISTRICT** is the **only scraper on either platform that extracts structured ticket pricing at list level** (`offers.price` → `ticketPriceRange`), with source IDs and confidence — but it **never persists to `concerts`** and has a hard single-URL / no-city-control constraint (District resolves city by server/IP).
- **PY-DISTRICT** integrates with the DB-writing orchestrator and adds a music-vs-nonmusic filter, but has weaker city data and no source ID, prices only on the organic path.

**District verdict → PARTIALLY READY (needs fixes).** Data quality (esp. price) is best in TS, but persistence lives in Python. The pragmatic path: keep ingestion in Python (`district.py` + orchestrator) and **port the TS JSON-LD `offers.price` extraction + source-ID logic** to improve Python price/ID coverage. City remains a platform limitation to document, not a bug. See `mySPRINT5_SCRAPER_PLAN.md`.

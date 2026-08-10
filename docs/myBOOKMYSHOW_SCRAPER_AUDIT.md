# myBOOKMYSHOW_SCRAPER_AUDIT.md — BookMyShow Scraper Audit (Sprint 5, READ-ONLY)

**Date:** 2026-08-05 · No code executed, no scrapers called, nothing modified.

Three BookMyShow implementations exist:
- **TS-BMS** — `backend/src/services/scrapers/bookmyshow/bookMyShowScraper.ts` (+ `mapper.ts`, `types.ts`)
- **PY-serp** — `mad_analytics/scrapers/bookmyshow.py` (via `run_scraper.py`)
- **PY-playwright** — `mad_analytics/scrapers/scrape_bookmyshow_all.py` (standalone)

---

## Implementation metadata

| Attribute | TS-BMS | PY-serp (`bookmyshow.py`) | PY-playwright (`scrape_bookmyshow_all.py`) |
|---|---|---|---|
| Language | TypeScript | Python | Python |
| Entry point | `bookMyShowScraper.scrape()` via `POST /concerts/ingest/scrapers` | `scrape_bookmyshow()` via `run_scraper.py` | `main()` CLI `__main__` |
| Scraping tech | Playwright (chromium) → internal JSON API | SerpAPI (Google engine) via `urllib` | Playwright + `playwright_stealth`, persistent context |
| URL strategy | `GET /api/explore/v1/discover/concerts-{citySlug}` after homepage Cloudflare clearance | `serpapi.com/search.json` (query = artist name) | Per-city listing pages → event detail pages |
| City discovery | ⚠️ hardcoded `CITY_REGION_MAP` (only Mumbai verified) | ❌ artist-driven, `--cities` ignored | ⚠️ hardcoded city slug list |
| Event discovery | ✅ JSON API pagination (`maxPages`, default 3) | ✅ Google `events_results` + `organic_results` filtered to bookmyshow.com | ✅ listing-page crawl |
| Pagination | ✅ per-city up to `maxPages` | ❌ single SerpAPI call | ⚠️ listing pages yes; detail sample capped (`--max-details`, default 10) |
| Detail extraction | ❌ (list-level JSON only) | ❌ | ✅ event detail pages (dates + tier prices) |
| Error handling | ✅ `retryWithBackoff`, non-retryable 404/422 short-circuit, `errors[]` | ✅ graceful `[]` on missing key/errors | ✅ Cloudflare-block detection, try/except |
| Retry logic | ✅ `retry.ts` (3 attempts, backoff+jitter) | ❌ none | ⚠️ human-sim retries, no formal backoff |
| Rate limiting | ✅ `rateLimiter.ts` (1200ms page / 1500ms city) | ❌ (SerpAPI-side) | ⚠️ human-delay sleeps |
| Deduplication | ❌ (delegated downstream) | ✅ in-scraper on `artist|city|date` | ⚠️ DB SELECT-before-insert |
| Output format | `ScrapeResult{ events: RawConcertEvent[] }` | `list[ScrapedConcert]` (dataclass) | plain dicts |
| Writes to DB | ❌ (pipeline gated off — never reaches `concerts`) | ❌ (persistence in `run_scraper.store_concerts`) | ✅ `INSERT INTO concerts` (+ tier cols) |
| Executable today | ❓ code present & wired; needs Node + Playwright browser + live BMS (unverified) | ❓ needs `SERPAPI_KEY` + Python env (unverified) | ❓ needs Playwright + `DATABASE_URL` (unverified) |
| Proven end-to-end | ❌ never persists concerts | ❓ writes via orchestrator; not verified this session | ❓ writes concerts; not verified this session |

---

## Field-by-field extraction

| Field | TS-BMS | PY-serp | PY-playwright |
|---|:--:|:--:|:--:|
| artistName | ⚠️ heuristic (match else title) | ✅ (query artist) | ⚠️ regex `_extract_artist` |
| eventName | ✅ | ✅ | ✅ |
| date | ✅ (`startDate`) | ✅ | ⚠️ placeholder (now+30d) if none |
| time | ❌ | ❌ | ⚠️ detail page |
| city | ✅ (from job) | ⚠️ inferred from URL slug | ✅ |
| venue | ✅ (`location.name`, cleaned) | ✅ | ✅ |
| venueAddress | ⚠️ raw `address.streetAddress` in payload, not mapped out | ❌ | ❌ |
| minTicketPrice | ❌ | ⚠️ organic only (`_parse_price`) | ✅ |
| maxTicketPrice | ❌ | ❌ | ✅ |
| price tiers (VIP/T1-3) | ❌ | ❌ | ✅ |
| bookingUrl | ✅ (`sourceUrl`) | ✅ | ✅ |
| source | ✅ `BOOKMYSHOW` | ✅ `bookmyshow` | ✅ `bookmyshow` |
| sourceEventId | ✅ regex `ET\d+` | ❌ | ❌ |
| organizer | ❌ | ❌ | ❌ |
| category | ❌ | ❌ | ❌ |
| image | ⚠️ `image[]` in raw, not mapped out | ❌ | ❌ |
| latitude/longitude | ❌ (city lat/lon only as scrape input) | ❌ | ❌ |
| venueCapacity | ❌ | ❌ | ❌ (inserts 0) |
| confidenceScore | ✅ (0.5/0.8) | ❌ | ❌ |
| country | ✅ hardcoded India | ✅ India | ✅ |

---

## Assessment
- **TS-BMS**: cleanest fetch engineering (retry/rate-limit/pagination, source IDs, confidence) but **produces no price/capacity/coords and never writes `concerts`**.
- **PY-serp**: light, artist-targeted, integrates with the DB-writing orchestrator; weak on price and city precision, no source ID.
- **PY-playwright**: **richest data** (tier prices, detail dates) and **writes `concerts` directly**, but standalone, placeholder dates, regex artist extraction, capacity=0.

**BookMyShow verdict → PARTIALLY READY (needs fixes).** A working DB path exists in Python; gaps are idempotency, capacity/coords, artist-match reliability, and consolidating PY-serp vs PY-playwright. See `mySPRINT5_SCRAPER_PLAN.md`.

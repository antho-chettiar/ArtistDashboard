# mySPRINT5_SCRAPER_PLAN.md — Sprint 5 Concert Scraper Implementation Plan

**Date:** 2026-08-05 · READ-ONLY audit + plan. No code changed, no scrapers run.
Companions: `myBOOKMYSHOW_SCRAPER_AUDIT.md`, `myDISTRICT_SCRAPER_AUDIT.md`, `myCONCERT_SCRAPER_DATA_CONTRACT.md`.
**Decision already made:** Python / `mad_analytics` is the canonical pipeline; BookMyShow + District remain hard requirements.

---

## Part 3 — Python vs TypeScript capability comparison

| Capability | Python | TypeScript | Best implementation | Future action |
|---|---|---|---|---|
| BookMyShow scraping | serp + Playwright(`scrape_bookmyshow_all`), **persists** | Playwright→JSON API, no persist | Split: TS engineering, PY persistence | **KEEP IN PYTHON**; port TS source-ID regex |
| District scraping | serp (`district.py`) | Playwright→JSON-LD **with price** | TS (price/JSON-LD) | **PORT FROM TS** (price + source-ID) → Python |
| Event discovery | ✅ | ✅ | Tie | KEEP IN PYTHON |
| Event-detail extraction | ✅ (`scrape_bookmyshow_all`) | ❌ | Python | KEEP IN PYTHON |
| Price extraction | ⚠️ partial | ✅ (District `offers.price`, BMS-all tiers) | TS District + PY BMS-all | **PORT** TS District price logic → Python |
| Pagination | ⚠️ | ✅ (`maxPages`) | TS | REFERENCE (add to Python where needed) |
| Retry handling | ⚠️ minimal | ✅ `retry.ts` backoff+jitter | TS | REFERENCE (or Python `tenacity`) |
| Deduplication | ✅ `verify_concerts` heuristic; embeddings.py exists | ✅ embedding (MiniLM) + candidate match | TS concept, **already Python-backed** | **PORT** embedding-dedup concept → Python |
| Normalization | ✅ `verify_concerts.normalize_*` | ✅ `eventNormalization` (canonical_key, alias maps, stopword strip) | TS (more complete) | **PORT** canonical_key + alias/stopword rules → Python |
| Validation / fraud | ✅ `validate_concerts` | ✅ `hybridValidation` (confidence + fraud + reasons) | TS (more structured) | **REFERENCE** (port only cheap signal checks) |
| Source attribution | ✅ | ✅ | Tie | KEEP IN PYTHON |
| Database persistence | ✅ **reaches `concerts`** | ❌ (gated off) | Python | **KEEP IN PYTHON** |
| Venue enrichment | ✅ `enrich_venues`/`resolver` | ❌ | Python | KEEP IN PYTHON |
| Capacity resolution | ✅ `resolver` (known_venues 136 + fallbacks) | ❌ | Python | KEEP IN PYTHON |
| Geocoding | ❌ | ❌ | Neither | **BUILD NEW** (Python, net-new) |
| Prediction integration | ✅ `mad_analytics` | ❌ | Python | KEEP IN PYTHON |

**Summary:** KEEP IN PYTHON = persistence, venue enrichment, capacity, prediction, discovery. PORT TS→PY = District price/JSON-LD extraction, canonical_key normalization, embedding dedup, source-ID regex. REFERENCE = retry/pagination/validation patterns. LEGACY LATER = the entire TS BookMyShow/District ingestion + canonical/validation service stack (once Python parity is proven).

---

## Part 5 — Study of the TS `CanonicalEvent` pipeline

1. **What `CanonicalEvent` contains** (`schema.prisma`): `artistName`+`normalizedArtistName`, `eventName`, `venueName`+`normalizedVenueName`, `city`+`normalizedCity`, `country`, `eventDate`, `sourcePlatform`, `sourceUrl`, `ticketPriceRange`(Json), `confidenceScore`, `fraudRiskScore`, `validationStatus`, **`canonicalKey`(@unique)**, `embedding`(Json), `rawPayload`(Json), `concertId`, timestamps. Plus satellites `SourceEventReference` (per-source, `sourceEventKey` @unique), `DuplicateGroup(+Member)`, `ValidationLog`.
2. **Normalization** (`eventNormalization.service.ts`): `normalizeComparableName` = NFKD → lowercase → `&`→"and" → strip non-alphanumerics → strip stopwords (`the|official|live|concert|tour|show|band|presents`) → collapse spaces; `CITY_ALIASES`/`COUNTRY_ALIASES` maps; `canonicalKey = [normArtist, normVenue, normCity, country, date].join`.
3. **Deduplication** (`duplicateDetection.service.ts`): generate embedding of the event text → fetch candidate `CanonicalEvent`s → cosine similarity + rule reasons → `bestMatch`; `duplicateMerge` writes new/duplicate canonical rows keyed by `canonicalKey`, upserts `SourceEventReference`, boosts confidence on repeat confirmations.
4. **Embedding** (`embedding.service.ts` → `ml_engine/embeddings.py`): **sentence-transformers `all-MiniLM-L6-v2` (already Python)**, 384-dim; deterministic **hash fallback** if the Python subprocess is unavailable; cosine similarity in TS. Cached in Redis.
5. **Validation** (`hybridValidation.service.ts`): `ValidationSignals` (trustedSource, officialTicketUrl, venueExists, verifiedArtistAccount, multipleConfirmations, duplicateDetected) → `confidence_score`, `fraud_risk_score`, `validation_status`, `validation_reasons`, `rule_scores`, `ml_signals`; persists `ValidationLog` + updates `CanonicalEvent`.
6. **Genuinely valuable:** the `canonicalKey` normalization (idempotency/dedup key), the alias maps, and embedding-based cross-source dedup (the model is already Python). Confidence/fraud scoring is a nice-to-have.
7. **Portable to Python cleanly?** **Yes, cheaply.** The embedding model is already Python (`ml_engine/embeddings.py`); `canonicalKey` + normalization are pure string ops; `verify_concerts.py` already implements a simpler dedup to extend.
8. **Do NOT port:** the whole `CanonicalEvent`/`SourceEventReference`/`DuplicateGroup`/`ValidationLog` **table machinery** and the Express-coupled service classes. Keep dedup/QA as an **in-pipeline step that writes straight to `concerts`** — do not stand up a parallel canonical event-store in Python.

---

## Part 6 — Verdicts
- **BookMyShow: PARTIALLY READY — needs fixes.** Working Python DB path (`scrape_bookmyshow_all.py` writes concerts + tiers; `bookmyshow.py` via `run_scraper`). Fixes: idempotency, capacity/coords, artist-match, and consolidating serp-vs-playwright.
- **District: PARTIALLY READY — needs fixes.** `district.py` persists via orchestrator; port TS `offers.price` + source-ID for price/ID coverage; city is a platform limitation.
- **Neither requires a full rewrite.** Reuse `run_scraper.py`, `scrape_bookmyshow_all.py`, `bookmyshow.py`, `district.py`, `models.py`, `venue_capacity/*`, `enrich_venues.py`, `verify_concerts.py`.

---

## Part 7 — Target production pipeline (exist vs build)
| Stage | Component (existing) | Status |
|---|---|---|
| BookMyShow scraper | `scrape_bookmyshow_all.py` / `bookmyshow.py` | ✅ exists |
| District scraper | `district.py` (+ port TS price) | ⚠️ exists, enhance |
| Raw events | `ScrapedConcert` (`models.py`) | ✅ exists |
| Canonical Python event | extend `ScrapedConcert` w/ normalized + canonical_key | ⚠️ build (small) |
| Normalization | `verify_concerts.normalize_*` + port TS rules | ⚠️ enhance |
| Cross-source dedup | `verify_concerts.find_duplicates` + optional `embeddings.py` | ⚠️ enhance |
| Validation/QA | `validate_concerts.py` | ✅ exists |
| Venue normalization | `resolver._normalize_name` | ✅ exists |
| Venue capacity resolver | `resolver.resolve_venue_capacity` | ✅ exists |
| Geocoding | — | ❌ **build (net-new)** |
| `concerts` persistence | `run_scraper.store_concerts` (+ idempotency) | ⚠️ exists, harden |
| Prediction engine | `mad_analytics` revenue/demand | ✅ exists |
| API / Dashboard | Express `/concerts`, `/analytics/ml/*` | ✅ exists |

**Only genuinely new component: geocoding.** Everything else exists and needs wiring/hardening.

---

## Part 8 — Idempotency
**Current behavior:** both Python orchestrators do a **`SELECT … FROM concerts WHERE artistName [+ city + concertDate + venueName]` before `INSERT`** (`run_scraper.store_concerts`, `scrape_bookmyshow_all.store_concerts`). This dedupes across repeated runs **at the application level only**. `concerts` has **no unique constraint** (only `id`); `CanonicalEvent.canonicalKey` and `Venue(name,city,country)` are unique, but `concerts` is not.

**Risks today:** race conditions under concurrency; inconsistent match keys between the two orchestrators; loose matching (`ILIKE`, date-only) can both false-merge and false-duplicate.

**Safest strategy WITHOUT schema change (recommended for Sprint 5):** funnel all writes through **one** orchestrator that (a) computes a normalized match key equivalent to `canonicalKey` (normArtist|normVenue|normCity|country|date), (b) does SELECT-by-that-key → UPDATE if found else INSERT (application-level upsert). No schema change; deterministic; kills cross-run duplicates.

**Stronger strategy (better, but a schema change):**
> 🔴 **REQUIRES EXPLICIT APPROVAL** — add `@@unique([artistId, concertDate, city, venueName])` (or a dedicated `canonicalKey` column) on `Concert` to enable a true DB-level upsert. **Do not implement without sign-off** (Sprint 4 Phase 5 territory).

---

## Part 9 — Venue intelligence flow (reuse existing)
```
scraped concert (venueName, city, country, capacity=NULL)
   → normalize (resolver._normalize_name / verify_concerts.normalize_venue)
   → resolve_venue_capacity():
        known_venues(136) → supplied → regex text → `venues` table → SerpAPI web_search → heuristic estimate
   → persist venue_capacity_records (+ mirror `venues`)
   → backfill concerts.capacity  (enrich_venues.py)
```
**Already working:** capacity resolution + `venues`/`venue_capacity_records` persistence + concert backfill (batch). **Do not build a new capacity system.** **Not handled:** coordinates (resolver writes lat/long = NULL) → the geocoding stage must fill `concerts.latitude/longitude` and `venues.latitude/longitude`.

---

## Part 10 — Prediction readiness
```
Scraped concert → (venueName, city, date, price)  → enrich capacity → predict
```
Revenue formula needs: **demand** (from artist metrics — ✅ present), **city tier** (✅), **capacity** (✅ via resolver, incl. heuristic fallback so it never hard-blocks), **avg ticket price** (✅ District/BMS-all; ⚠️ BMS-serp-only artists). Demand needs artist signals + city (✅). 
**Verdict:** once ingestion + venue enrichment run, **revenue and demand predictions are unblocked.** Missing/optional: `latitude/longitude` (blocks **only** MapView/heatmaps, not revenue) and cost/fee data (blocks **ROI**, which is not in the current formulas). No formula changes needed.

---

## Part 11 — Sprint 5 phased plan

> Template per phase: Objective · Files to modify · Files to create · Reuse · Tables · Dependencies · Risks · Verification · Rollback · DoD. All DB writes go to `concerts`/`venues`/`venue_capacity_records`; **no schema change** unless a phase is flagged 🔴.

### 5.1 BookMyShow scraper (consolidate)
- **Objective:** one reliable BMS scraper producing the canonical contract. **Modify:** `scrape_bookmyshow_all.py`, `bookmyshow.py`. **Create:** none (decide primary = Playwright `scrape_bookmyshow_all`). **Reuse:** both + `models.py`. **Tables:** none yet. **Deps:** Playwright/SerpAPI. **Risks:** Cloudflare/anti-bot fragility; placeholder dates. **Verify:** dry-run to JSON (no DB), field coverage vs contract. **Rollback:** git revert. **DoD:** returns canonical dicts for ≥1 city with dates + prices, no DB writes in dry-run.

### 5.2 District scraper (enhance)
- **Objective:** add reliable price + source-ID to Python District by porting TS `offers.price`/JSON-LD logic. **Modify:** `district.py`. **Reuse:** TS `district/mapper.ts` as reference. **Tables:** none. **Deps:** SerpAPI (or add a Playwright JSON-LD path). **Risks:** District city not controllable (document). **Verify:** dry-run field coverage (price present). **Rollback:** git revert. **DoD:** District events carry `minTicketPrice`/`maxTicketPrice` + source id.

### 5.3 Common canonical event model
- **Objective:** extend `ScrapedConcert` with `normalized_*` + `canonical_key`. **Modify:** `models.py`. **Create:** optional `normalization.py` (port TS rules + alias maps). **Reuse:** `verify_concerts.normalize_*`, TS `eventNormalization` as spec. **Tables:** none. **Risks:** key-format drift vs TS. **Verify:** unit-style checks on sample names. **Rollback:** git revert. **DoD:** every scraped concert yields a deterministic `canonical_key`.

### 5.4 Normalization + deduplication
- **Objective:** cross-source dedup on `canonical_key` (+ optional embedding). **Modify:** `verify_concerts.py`. **Reuse:** `verify_concerts.find_duplicates`, `ml_engine/embeddings.py` (optional). **Tables:** reads `concerts`. **Risks:** false merges. **Verify:** run on a fixture set, confirm dup counts. **Rollback:** git revert. **DoD:** identical events across BMS+District collapse to one.

### 5.5 Concert persistence + idempotency
- **Objective:** single idempotent writer (app-level upsert by `canonical_key`). **Modify:** `run_scraper.store_concerts`. **Reuse:** existing SELECT-before-insert. **Tables:** `concerts`. **Deps:** 5.3/5.4. **Risks:** no DB constraint → concurrency; (optional 🔴 add `@@unique` — approval required). **Verify:** run twice on same data → 0 new rows the 2nd time. **Rollback:** git revert + delete test rows. **DoD:** repeated runs create no duplicates.

### 5.6 Venue enrichment
- **Objective:** auto-run capacity resolver after persistence. **Modify:** `run_scraper.py` (call `enrich_venues`), `enrich_venues.py`. **Reuse:** `resolver`, `known_venues`, `pipeline.py`. **Tables:** `venues`, `venue_capacity_records`, `concerts.capacity`. **Deps:** 5.5. **Risks:** SerpAPI cost; `venue_capacity_records` schema drift (🔴 reconcile later). **Verify:** concerts get non-null capacity. **Rollback:** git revert. **DoD:** ≥X% of new concerts have resolved capacity.

### 5.7 Geocoding (NET-NEW)
- **Objective:** fill `latitude/longitude` for venues/cities. **Create:** `mad_analytics/venue_capacity/geocode.py`. **Reuse:** existing static city→lat/lng table (`update-all-predictions-with-coords.ts`) as seed/reference. **Tables:** `venues`, `concerts` lat/lng. **Deps:** a geocoder (decide provider — approval if paid/new dep 🔴). **Risks:** provider cost/limits. **Verify:** coordinates populated + plausible. **Rollback:** git revert. **DoD:** MapView renders real points.

### 5.8 Prediction integration
- **Objective:** run predictions on newly ingested concerts. **Modify:** none in formulas; reuse `run_scraper --retrain` / `mad_analytics` predict path. **Reuse:** revenue/demand engine. **Tables:** `prediction_outputs`. **Deps:** 5.5–5.6. **Risks:** none to formulas. **Verify:** prediction rows exist for new concerts. **Rollback:** delete generated predictions. **DoD:** dashboard shows predicted revenue/demand.

### 5.9 API / dashboard verification
- **Objective:** confirm Concerts/Analysis/Map show real data. **Modify:** none. **Verify:** `/concerts`, `/concerts/cities`, `/dashboard/kpis`, Map. **Rollback:** n/a. **DoD:** endpoints return non-empty concert data (env permitting).

### 5.10 Scheduler / automation
- **Objective:** schedule scrape→enrich→predict. **Modify:** `mad_analytics/server.py` scheduler (or cron). **Reuse:** existing scheduler. **Risks:** key/cost, silent failures. **Verify:** scheduled run logs. **Rollback:** disable schedule. **DoD:** recurring run works idempotently.

### 5.11 Retire/move redundant TS ingestion → `legacy/`
- **Objective:** after Python parity proven, quarantine the TS BMS/District ingestion + canonical/validation stack. **Action:** `git mv` to `legacy/` (never delete). **Reuse:** keep as REFERENCE until 5.1–5.5 verified. **Risks:** removing a fallback prematurely. **Verify:** tsc still green; no active imports. **Rollback:** `git mv` back. **DoD:** one canonical (Python) pipeline; TS ingestion quarantined. **(Gated: only after 5.1–5.9 pass.)**

---

## FINAL DECISION

- **BOOKMYSHOW:** **PARTIAL** — working Python DB path exists; needs idempotency, capacity/coords, artist-match, serp/playwright consolidation.
- **DISTRICT:** **PARTIAL** — Python persists via orchestrator; port TS price/source-ID; city is a platform limitation.
- **PYTHON CANONICAL PIPELINE:** **NEEDS WORK** — persistence, venue enrichment, capacity, prediction all exist; missing idempotency hardening, canonical-key normalization, geocoding, and one orchestrated end-to-end run.
- **TS COMPONENTS TO PORT:** District `offers.price`/JSON-LD extraction, `canonicalKey` normalization + alias/stopword maps, embedding-based dedup (model already Python), source-ID regex.
- **TS COMPONENTS TO KEEP AS REFERENCE:** `retry.ts`/`rateLimiter.ts` patterns, pagination approach, `hybridValidation` signal design.
- **TS COMPONENTS TO MOVE TO LEGACY LATER:** the TS BookMyShow/District scrapers + the `CanonicalEvent`/normalization/dedup/validation service stack (only after Python parity is proven in 5.1–5.9).

### **READY FOR SPRINT 5.1**
No blockers to begin. Sprint 5 is consolidation + enrichment + geocoding + one end-to-end run on the existing Python code — not new scrapers. The only items needing explicit approval before implementation: any `Concert` unique-constraint schema change (§8, 🔴) and any new/paid geocoding dependency (§5.7, 🔴).

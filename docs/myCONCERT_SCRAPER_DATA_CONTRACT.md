# myCONCERT_SCRAPER_DATA_CONTRACT.md — Canonical Concert Data Contract (Sprint 5)

**Date:** 2026-08-05 · READ-ONLY. Derived from the actual repo: Prisma `Concert`/`Venue`/`CanonicalEvent` models, TS `RawConcertEvent`/`NormalizedConcertEvent`, Python `ScrapedConcert`, and the `mad_analytics` prediction payloads. No fields invented beyond what the schema/pipeline already supports.

---

## Flow (grounded in existing components)
```
BookMyShow scraper ─┐
District scraper  ──┴─► RawConcert (per-source dict)          [scrape stage]
                          │  normalize (name/city/country/date + canonical_key)
                          ▼
                    CanonicalConcert (in-memory Python model)  [normalize stage]
                          │  cross-source dedup (canonical_key + optional embedding)
                          ▼
                    Validated CanonicalConcert                 [QA/validation stage]
                          │  venue normalization + capacity resolver
                          ▼
                    + venueCapacity                            [venue enrichment]
                          │  geocoding (NET-NEW)
                          ▼
                    + latitude/longitude                       [geocode stage]
                          ▼
                    UPSERT ► `concerts`  (+ `venues`)          [persistence stage]
                          ▼
                    prediction engine → `prediction_outputs`
```

---

## Canonical contract (target Python model)

Column source keys: **BMS** = BookMyShow, **DST** = District. Prisma target = column on `concerts` unless noted.

| Field | Type | BMS | DST | Populated at | Prisma target (`concerts` unless noted) | Used by |
|---|---|:--:|:--:|---|---|---|
| `source` | enum str | ✅ | ✅ | scrape | `source` | attribution |
| `sourceEventId` | str? | ✅(TS) | ✅(TS) | scrape | — (no `concerts` col; lives on `CanonicalEvent`/`SourceEventReference`) | dedup, idempotency |
| `sourceUrl` (bookingUrl) | str | ✅ | ✅ | scrape | `sourceUrl` | display, idempotency |
| `artistName` | str | ⚠️ | ⚠️ | scrape | `artistName` (+ `artistId` via match) | **required** (FK match) |
| `eventName` | str? | ✅ | ✅ | scrape | `notes` (no dedicated col) | display |
| `date` (concertDate) | date | ✅ | ✅ | scrape | `concertDate` | **required** (dedup + prediction) |
| `time` | str? | ❌ | ⚠️ | scrape | — (no col) | display (optional) |
| `city` | str | ✅ | ✅ | scrape/normalize | `city` | **required** (dedup, city-affinity, prediction) |
| `country` | str | ✅ | ✅ | scrape/normalize | `country` | currency/tier |
| `venueName` | str | ✅ | ✅ | scrape/normalize | `venueName` | **required** (dedup, venue enrichment) |
| `venueAddress` | str? | ⚠️ | ⚠️ | scrape | — (`venues.address`) | venue enrichment (optional) |
| `minTicketPrice` | float? | ❌/✅(all) | ✅ | scrape | `ticketPriceMin` | revenue (avg source) |
| `maxTicketPrice` | float? | ✅(all) | ⚠️(=min) | scrape | `ticketPriceMax` | revenue (avg source) |
| `avgTicketPrice` | float? | derived | derived | normalize | `avgTicketPrice` | **required for revenue** |
| tiers `vip/tier1/2/3` | float? | ✅(all) | ❌ | scrape (detail) | `ticketPriceVip/Tier1/2/3` | pricing recommendation |
| `currency` | str | ✅ | ✅ | scrape | `currency` | revenue (display) |
| `canonicalKey` | str | derived | derived | normalize | — (`CanonicalEvent.canonicalKey` `@unique`) | **idempotency/dedup** |
| `confidenceScore` | float | ✅(TS) | ✅(TS) | normalize | — (`CanonicalEvent`) | QA |
| `venueCapacity` | int? | ❌ | ❌ | **enrich (resolver)** | `capacity` | **required for revenue** |
| `latitude` | float? | ❌ | ❌ | **geocode (NET-NEW)** | `latitude` (+ `venues.latitude`) | map/heatmap |
| `longitude` | float? | ❌ | ❌ | **geocode (NET-NEW)** | `longitude` (+ `venues.longitude`) | map/heatmap |
| `verificationStatus` | enum | set | set | persist | `verificationStatus` (=`PENDING`) | QA workflow |
| `organizer` | str? | ❌ | ❌ | — | — (no col) | not needed now |
| `category`/`genre` | str? | ❌ | ⚠️ | — | — (no col) | not needed now |
| `image` | str? | ⚠️ | ❌ | — | — (no col) | not needed now |

### Notes on schema fit (do NOT add columns without approval)
- `concerts` already has every price column the scrapers can fill (`avgTicketPrice`, `ticketPriceMin/Max`, `ticketPriceVip/Tier1/2/3`) — so pricing needs **no schema change**.
- There is **no `eventName`, `time`, `organizer`, `category`, or `image` column** on `concerts`; `eventName` currently rides in `notes`. Adding dedicated columns would be 🔴 a schema change (not required for predictions).
- `sourceEventId` has no `concerts` column; it exists on `CanonicalEvent`/`SourceEventReference`. If Python skips the canonical tables, source-event identity must be preserved another way (e.g., composite of `source` + `sourceUrl`).
- **`concerts` has NO natural unique constraint** — idempotency must be handled in code (see `mySPRINT5_SCRAPER_PLAN.md` §8).

### Minimum viable contract (to persist + predict)
`artistName` (→matched `artistId`), `concertDate`, `city`, `country`, `venueName`, one of `avgTicketPrice`/`min`+`max`, `currency`, `source`, `sourceUrl`, plus **`capacity`** (from resolver). `latitude/longitude` are required only for the map, not for revenue/demand.

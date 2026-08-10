# mySPRINT5_RECOMMENDATION.md — Final Verdict & Sprint 5 Focus

**Date:** 2026-08-05 · READ-ONLY audit conclusion. Companions: `myCONCERT_PIPELINE_AUDIT.md`, `mySCRAPER_ARCHITECTURE.md`.

---

## PART 10 — Final verdict

### 1. Can the current scraper system replace Excel?
**PARTIALLY.**
The Python path (`run_scraper.py`, `scrape_bookmyshow_all.py`) already writes real events into the `concerts` table from live sources with artist-matching and dedup — so the **concert Excel and venue Excel are replaceable in principle today**. It is only "partial" because: concerts land as `PENDING` with `capacity=0` (enriched later), price/tier coverage is uneven, artist↔event matching is fuzzy, there is **no geocoding**, and the ingestion is **not idempotent** (re-runs duplicate rows). NCCS reference data stays on Excel/JSON regardless.

### 2. What percentage of the concert pipeline is already built?
**≈ 65%.** Built: multi-source scrapers (BMS, District, Songkick, setlist.fm) in two languages ✅; concert persistence (Python) ✅; normalization + dedup + validation (both stacks) ✅; venue-capacity resolution with 136 curated venues + fallbacks ✅; revenue/demand formulas downstream ✅. Not built / broken: geocoding ✗; idempotent + unified orchestration ✗; the TS canonical pipeline's concert-persistence stage (gated off) ✗; verified artist linkage ⚠️; cost/ROI inputs ✗; schema reconciliation ⚠️. The *hard* parts (scraping through Cloudflare, capacity intelligence, dedup) are done; the *glue* is not.

### 3. Top 10 missing pieces
1. **Geocoding** — no lat/lng source anywhere; blocks MapView, heat maps, and ROI-by-location.
2. **Idempotent ingestion** — Python `INSERT INTO concerts` (and TS `concert.create`) duplicate on re-run; need upsert on a natural key.
3. **One authoritative pipeline** — two disconnected stacks (TS `backend/` vs Python `mad_analytics/`) both target `concerts` with no shared contract.
4. **Concert persistence on the TS canonical pipeline** — normalize→dedup→validate is solid but `persistConcerts` is gated `false`; either complete-and-prove it or retire it.
5. **Reliable per-venue capacity at ingest** — inserted as 0, backfilled later by an estimate-capable resolver; predictions need trustworthy capacity.
6. **Verified artist↔event linkage** — matching is fuzzy `ILIKE`/regex; risks false matches and silent drops of unmatched artists.
7. **Consistent ticket price + tier coverage** — only District and `scrape_bookmyshow_all.py` carry prices/tiers; others are blank.
8. **Cost / fee inputs for ROI** — absent in every scraper and table.
9. **Schema-drift reconciliation** — `venue_capacity_records` (and `artist_popularity_scores`) exist in the DB but not in Prisma.
10. **Scheduling, monitoring & key management** — no verified cron wiring for the scraper→enrich→predict loop; SerpAPI cost/limits and Cloudflare fragility are unmonitored.
*(Secondary gaps: organizer, genre/category, availability/sold-out, `state`, event `time`.)*

### 4. What should Sprint 5 actually focus on?
**Consolidation, enrichment, and one end-to-end run — NOT building new scrapers.** There is already more scraping capability than the pipeline uses.

**Recommended Sprint 5 scope (in order):**
1. **Choose one authoritative concert-ingestion path.** Recommendation: the **Python** path (`run_scraper.py` + `scrape_bookmyshow_all.py`) — it already persists. Decide the TS BookMyShow/District pipeline's fate (complete its concert-persist stage *or* retire it) to end the duplication.
2. **Make ingestion idempotent** — upsert concerts on `(artistId, concertDate, city, venueName)` so rebuilds don't duplicate.
3. **Wire venue-capacity enrichment into the flow** — run `resolver.py`/`enrich_venues.py` automatically after ingest so concerts don't sit at `capacity=0`.
4. **Add geocoding** (the one genuinely new component) — batch-geocode distinct venues/cities to fill `latitude/longitude`; unblocks MapView + heat maps.
5. **Run the pipeline end-to-end against the live DB** (11 artists already loaded) to actually populate `concerts` → predictions → and unblock the Concerts/Analysis/Map pages that are currently empty (see `myPROJECT_HEALTH_REPORT.md`).
6. **Reconcile schema drift** (fold `venue_capacity_records` into Prisma) — coordinate with cleanup Phase 5.
7. **Improve artist↔event matching** and add price/tier coverage where cheap.

**Explicitly out of scope for Sprint 5:** writing new scrapers, and any change to analytics formulas or APIs beyond what item 1's consolidation strictly requires (those remain protected per the Sprint 4 guardrails).

---

## One-paragraph executive summary
The concert pipeline is **~65% built and further along than it looks**: robust multi-source scrapers, working concert persistence (Python side), capacity intelligence, and dedup all exist. The problems are **structural, not missing-scraper**: the sophisticated TS pipeline stops at `CanonicalEvent` and never writes concerts, while the Python path that *does* write concerts is fragmented, non-idempotent, lacks geocoding, and inserts zero-capacity rows. **Sprint 5 should consolidate onto one idempotent Python path, bolt on the existing venue enrichment, add geocoding, and do a single end-to-end run to populate `concerts`** — replacing the concert/venue Excel imports — rather than building anything new.

# myREMOVAL_LIST.md — Itemized Cleanup Decisions

Categorized per Sprint 4.1. **Nothing here has been removed** — this is the approval worksheet. Verify each 🟡 before acting. Removing applied migrations or DB tables with data is out of bounds until explicitly approved.

---

## 🟢 SAFE TO REMOVE (verified 0 usages, no data)

### Code files
- `backend/src/services/analytics/popularityV2.service.ts` — 0-byte stub, 0 imports
- `backend/src/services/analytics/trends.service.ts` — 0-byte stub, 0 imports
- `backend/src/services/scrapers/viberate/test-collect.ts` — test harness
- `backend/src/services/scrapers/viberate/test-fetch.ts` — test harness
- `backend/scripts/test-predictions.ts` — dev test
- `backend/scripts/test-engagement.ts` — dev test (console only)
- `backend/scripts/simple-test.py`, `backend/scripts/test_trends.py`, `backend/scripts/googletrends1.py` — dev experiments

### Committed artifacts (should never have been tracked)
- `backend/scripts/venv/` — Python virtualenv (non-portable, ~thousands of files)
- `backend/scripts/.idea/` — JetBrains IDE config

### npm dependencies (referenced 0× in `backend/src`)
- `cheerio`, `csv-parser`, `express-validator`, `swagger-jsdoc`, `swagger-ui-express`, `redis`
  *(validation is `zod`; caching is `ioredis`; swagger is not mounted. Confirm no build/CI step imports them, then drop from `backend/package.json`.)*

---

## 🟡 NEEDS REVIEW (likely removable, but confirm intent/data first)

### Superseded / deprecated scripts
- `backend/scripts/update-predictions.ts` — superseded by `update-all-predictions-with-coords.ts`
- `backend/scripts/update-all-predictions.ts` — superseded by the `-with-coords` variant
- `backend/prisma/seed-new-artists.ts` — already flagged DEPRECATED; keep only as no-Excel dev fallback
- `backend/export-viberate.py` — ad-hoc export utility

### Diagnostics (move, don't delete outright)
- root `check_dashboard.py`, `check_data.py`, `check_data2.py`, `check_ranking.py`, `check_stored.py`, `check_subs.py`, `check_taylor_drake.py`, `check_yt_cols.py` → relocate to `scripts/diagnostics/` or remove

### Dead-service / stub logic
- `backend/src/services/currency/currencyConversion.service.ts` — 0 imports
- `backend/src/services/artistEnrichment.service.ts` — no-op stub wired to live `/ingestion/enrich*` (decide: implement or remove endpoints + service)

### Dead / unreachable APIs (remove or implement)
- `/ingestion/enrich`, `/ingestion/enrich/:id`, `/ingestion/sync/:platform` — enrichment stub
- `/analytics/demographics/{age,gender,geo}`, `/artists/:id/demographics` — `audience_demographics` never populated
- `/concerts/predictions/revenue` — orphan, no caller
- `/analytics/ml/popularity/all/save`, `/concerts/pipeline/sources` — no frontend caller

### Prisma models (⚠ requires migration + explicit approval; do NOT drop tables with data)
- Never used → `concert_research_jobs`, `duplicate_group_members`, `prediction_models`
- Write-only → `duplicate_groups`, `validation_logs`, `feature_snapshots`, `prediction_training_data`
- Never populated → `audience_demographics`; `artist_trend_scores` (**or** wire its writer to fix the Trends split-brain)
- Reconcile schema drift → add `artist_popularity_scores`, `venue_capacity_records` to Prisma **or** fold into existing tables

### Duplicate-engine consolidation (merge, not delete)
- `backend/ml_engine/` (spawned) vs `mad_analytics/` — pick one authoritative engine; retire the loser
- Popularity: converge on Viberate V2; demote V1 `utils/artistPopularity.ts` to internal input; drop dashboard-composite recompute
- Revenue: single interface; fix currency inconsistency; retire `calculateFallbackPricing` as an independent formula

---

## 🔵 KEEP (core production path)
Auth/users, `artist.controller`, `dashboard.controller`, `analytics.controller`, `madAnalytics.service.ts`, Viberate `collector`/`sync`/`scorer`, `import-artist-baseline.ts`, `seed.ts`, `viberate-slugs.ts`, `fix_rog.py`; models `artists, genres, artist_genres, platform_metrics, viberate_metrics_daily, artist_popularity_v2_snapshots, concerts, users, refresh_tokens, ingestion_jobs`; **all 4 migrations**; runtime deps listed in `myBACKEND_AUDIT.md §7`.

---

### Removal impact summary
- **~13 code/script files + 2 artifact dirs + 6 npm deps** are 🟢 safe now.
- **Model/table removals** are 🟡 and gated behind migrations + data checks.
- **Engine/metric consolidation** is refactor work (see `myCLEANUP_PLAN.md`), not deletion.

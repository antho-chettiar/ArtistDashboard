# myCLEANUP_PLAN.md — Phased Backend Cleanup Plan

Ordered lowest-risk → highest. Each phase is independently shippable and reversible via git. **Correctness/consolidation before deletion of anything ambiguous.** No phase changes analytics formulas' math except where explicitly noted as "fix inconsistency" (currency / split-brain).

---

## Phase 0 — Zero-risk deletions (🟢)
**Goal:** remove provably-dead files and artifacts.
- Delete the 2 empty stubs (`analytics/popularityV2.service.ts`, `analytics/trends.service.ts`).
- Delete test harnesses (`viberate/test-collect.ts`, `test-fetch.ts`, `scripts/test-predictions.ts`, `scripts/test-engagement.ts`, `scripts/simple-test.py`, `scripts/test_trends.py`, `scripts/googletrends1.py`).
- Untrack committed artifacts (`backend/scripts/venv/`, `backend/scripts/.idea/`) and add to `.gitignore`.
- **DoD:** `tsc --noEmit` clean; app boots; no import breaks. **Risk:** none.

## Phase 1 — Dependency hygiene (🟡→🟢)
**Goal:** shrink `package.json`.
- Remove unused deps: `cheerio, csv-parser, express-validator, swagger-jsdoc, swagger-ui-express, redis`.
- Move `prisma` and any `@types/*`/`typescript` that the build needs into the correct section (note: production Docker build currently fails because `typescript` is a devDependency — track separately).
- **DoD:** `npm ci && npm run build` green; server boots. **Risk:** low (run build + smoke test).

## Phase 2 — Retire superseded scripts & relocate diagnostics (🟡)
- Delete `scripts/update-predictions.ts` + `scripts/update-all-predictions.ts` (keep `-with-coords`).
- Move root `check_*.py` → `scripts/diagnostics/` (or delete).
- Keep `seed-new-artists.ts` (dev fallback, already labeled), `fix_rog.py`, `export-viberate.py` (or move the latter to diagnostics).
- **DoD:** production runbook references only surviving scripts. **Risk:** low.

## Phase 3 — Decide the dead APIs (🟡)
For each: **implement** or **remove route + controller + service**.
- Demographics (`/analytics/demographics/*`, `/artists/:id/demographics`) — implement real data or remove (currently always empty).
- Enrichment (`/ingestion/enrich*`, `/ingestion/sync/:platform`) — implement `artistEnrichment.service.ts` or remove the endpoints + stub.
- Orphans (`/concerts/predictions/revenue`, `/analytics/ml/popularity/all/save`, `/concerts/pipeline/sources`) — remove if no consumer.
- Remove `currencyConversion.service.ts` (0 imports).
- **DoD:** every registered route is reachable and returns real data or is gone. **Risk:** medium (API surface changes — confirm no frontend/integration relies on them first).

## Phase 4 — Metric-implementation consolidation (refactor, not delete)
**Goal:** one source of truth per score. *(This is the core technical debt; do NOT alter the winning formula's math.)*
- **Popularity:** make Viberate V2 (`scorer.ts` → `artist_popularity_v2_snapshots`) canonical for display; demote `utils/artistPopularity.ts` (V1) to an internal input; stop the dashboard-composite recompute; delete the empty stubs (done in Phase 0). Fix the **Trends split-brain** (populate `artist_trend_scores`, or remove the read).
- **Demand/Revenue:** single prediction interface; choose Python (`mad_analytics`) **or** TS as primary with the other as tagged fallback; route `/analytics/ml/revenue`, `/concerts/predictions/revenue`, and `concertPipeline` through it; **fix currency inconsistency** (one base currency, convert for display only).
- **Two Python engines:** confirm which of `backend/ml_engine/` vs `mad_analytics/` is deployed; retire the other.
- **DoD:** identical inputs → identical score regardless of entry path; one code path per metric. **Risk:** high — regression-test against known artists/concerts before/after.

## Phase 5 — Schema trim (🟡, migration + approval required)
**Goal:** drop dead tables; reconcile drift. **Never drop a table with data without explicit sign-off.**
- New migration dropping: `concert_research_jobs`, `duplicate_group_members`, `prediction_models` (all empty/unused).
- Decide per-table: `duplicate_groups`, `validation_logs`, `feature_snapshots`, `prediction_training_data` (write-only — keep as audit or drop).
- Reconcile `artist_popularity_scores`, `venue_capacity_records` into Prisma (add models) or fold into existing tables.
- **DoD:** `schema.prisma` matches the live DB exactly; no unmanaged tables. **Risk:** medium-high (destructive) — snapshot DB first.

---

## Sequencing summary
`Phase 0 → 1 → 2` can land this sprint (safe). `Phase 3` next (API decisions). `Phase 4` is the multi-sprint correctness effort. `Phase 5` last, gated on approval + DB backup. Each phase: branch → change → `tsc --noEmit` + boot + smoke-test the verified endpoints (see Sprint 3.6 API set) → PR.

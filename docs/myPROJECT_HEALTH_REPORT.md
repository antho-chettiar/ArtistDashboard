# myPROJECT_HEALTH_REPORT.md — Project Health Checkpoint

**Date:** 2026-08-05
**Checkpoint:** end of Sprint 4, Phase 2 (before any architectural refactoring)
**Status:** 🟢 Stable checkpoint — build green, data populated, safe cleanup landed; higher-risk refactors (APIs/analytics/schema) deliberately not started.

---

## 1. Executive snapshot
The backend is in a clean, verifiable state. The live data pipeline (artists → metrics → popularity) is fully working on real data locally, and all safe repository cleanup (dead files, unused dependencies, obsolete scripts) is complete and quarantined in `legacy/`. Remaining work is (a) the concert/prediction data path and (b) the higher-risk consolidation phases, both of which are planned but gated.

## 2. Build & code health
| Indicator | Status |
|---|---|
| TypeScript compile (`tsc --noEmit`) | ✅ exit 0 |
| Prisma schema (`prisma validate`) | ✅ valid |
| Dead/stub code in active tree | ✅ removed (quarantined in `legacy/`) |
| Unused npm dependencies | ✅ 6 removed (Phase 1) |
| Automated test coverage | ⚠️ minimal / effectively none (tech-debt item) |
| Known build defect | ⚠️ Render production build fails — `typescript` is a devDependency skipped under `NODE_ENV=production` (not yet fixed; tracked) |

## 3. Database & data
| Item | Status |
|---|---|
| Production DB | Neon (PostgreSQL) — database of record |
| Local dev DB | PostgreSQL 18, schema in sync (`db push`) |
| Users / Genres | 2 users (admin, viewer) · 8 genres |
| Artists | 11 real artists (Excel baseline), all with `viberateSlug`, no duplicates |
| Viberate daily metrics | ~4,805 rows (11 artists, 30-day window) |
| Platform metrics | ~1,302 rows |
| Popularity snapshots | 11 (`artist_popularity_v2_snapshots`, `v2.1-viberate`) |
| Concerts | 0 (no valid concert dataset yet) |
| Schema drift | `artist_popularity_scores`, `venue_capacity_records` exist in DB but not in Prisma (documented) |

## 4. Pipeline status
`Schema → Seed (users/genres) → Import Artists → Assign Slugs → Collector → Sync → Scorer` — **all verified working.** Downstream `Concert Import → Predictions` is **blocked** (no concert data; the supplied `Concerts Venues.xlsx` is venue-reference data, not concerts).

## 5. API status
Verified returning real production data (Sprint 3.6): `/health`, `/auth/*`, `/dashboard/kpis`, `/dashboard/top-artists`, `/artists`, `/artists/leaderboard`, `/artists/:id[/score|/metrics|/viberate-metrics]`, `/analytics/{trends,rog,genres}`. `/concerts*` and Map are empty pending concert data. Several endpoints are dead/no-op (demographics, enrichment) — slated for Phase 3.

## 6. Deployment status
Three services deployed (Vercel frontend; Render backend + analytics; Neon DB). Live deployment currently has two open items: the Render `typescript` build fix and repointing deployed services' DB env vars at Neon. Not addressed in Sprint 4 (cleanup-only).

## 7. Technical debt (from `myBACKEND_AUDIT.md`)
- **Metric fragmentation (top debt):** Popularity has ~4 implementations + 3 storage sinks; Revenue/Demand span 3–4 paths; two Python engines (`ml_engine` vs `mad_analytics`) with divergent formulas/FX. → Phase 4.
- **Dead APIs:** demographics + enrichment endpoints reachable but empty/no-op. → Phase 3.
- **Dead/write-only/never-populated tables** and **schema drift**. → Phase 5.
- **Trends split-brain:** scorer reads `artist_trend_scores`, which nothing populates → reach-only fallback.

## 8. Sprint 4 changes landed (this checkpoint)
- **Phase 0:** dead files/artifacts quarantined to `legacy/` (verified).
- **Phase 1:** removed 6 proven-unused deps; `tsc`/Prisma green; lockfile −703 lines.
- **Phase 2:** 11 obsolete scripts moved to `legacy/` via `git mv` (history preserved).
- **Docs:** canonical `my*` docs consolidated under `docs/`.
- All changes are **staged/working-tree only — not committed.**

## 9. Risks & blockers
1. **Concert dataset missing** → blocks concerts, predictions, revenue/map validation.
2. **Render build defect** → production backend redeploys fail until the `typescript` dependency placement is fixed.
3. **Metric fragmentation** → same entity can yield different numbers by code path; must be consolidated before trusting revenue/demand at scale.
4. **No test suite** → refactors (Phases 3–5) need regression coverage or careful manual verification.
5. **Environment flakiness** (sandbox process/`npx` operations intermittently hang) — affects runtime verification, not the code itself.

## 10. Overall assessment
**Healthy checkpoint.** Core product path is real and verified; the codebase is measurably leaner and provably still compiles; risk is contained because nothing in APIs/analytics/schema has been altered. Safe to review and commit before architectural work begins.

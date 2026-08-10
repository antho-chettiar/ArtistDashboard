# myMASTER_ROADMAP.md — Master Roadmap

**Date:** 2026-08-05
**As of:** Sprint 4, Phase 2 complete (safe cleanup landed; not committed).
**Companion docs:** `myPROJECT_HEALTH_REPORT.md`, `myBACKEND_AUDIT.md`, `myCLEANUP_PLAN.md`, `myREMOVAL_LIST.md`, `myDEPENDENCY_GRAPH.md`.

This roadmap is organized **Now / Next / Later**. Each item lists dependencies and risk. Items marked 🔒 are protected (modify APIs, analytics, or schema) and require explicit per-phase approval.

---

## ✅ Completed (context — not repeated below)
Cloud deployment (Vercel/Render/Neon) · Neon migration · local dev environment · full audit suite · repository/path standardization · production bootstrap redesign · database population · live Viberate pipeline (collector→sync→scorer) verified · core API verification · documentation consolidation · **Sprint 4 cleanup Phases 0–2** (dead files, unused deps, obsolete scripts → `legacy/`).

---

## NOW — Checkpoint & commit (no new risk)
1. **Review & commit this checkpoint.** Stage/commit as clean, separate commits: (a) legacy migration, (b) docs consolidation, (c) Phase 1 dep removal, (d) Phase 2 script moves. *Depends on:* your review. *Risk:* none.
   - Note: also decide whether to keep `legacy/backend/scripts/venv/` in git or drop it + `.gitignore` (6,424 tracked files).

## NEXT — Gated cleanup phases (require explicit approval)
2. 🔒 **Phase 3 — Dead API decisions.** For each dead/no-op endpoint (demographics, enrichment, orphan routes) and `currencyConversion.service.ts`: implement or remove route+controller+service. *Depends on:* confirming no frontend/integration relies on them. *Risk:* medium (API surface changes). *Verification:* tsc + import scan + (when env healthy) endpoint smoke tests.
3. 🔒 **Phase 4 — Metric-implementation consolidation.** One source of truth per score: make Viberate V2 canonical for popularity; unify Revenue/Demand behind one interface; fix currency inconsistency; retire one of the two Python engines; fix the Trends split-brain. *Depends on:* Phase 3, and ideally a regression baseline. *Risk:* HIGH (touches analytics math paths — do not change a winning formula's math). *Verification:* before/after regression against known artists/concerts.
4. 🔒 **Phase 5 — Schema trim & drift reconciliation.** New migration dropping unused tables (`concert_research_jobs`, `duplicate_group_members`, `prediction_models`); decide on write-only tables; fold `artist_popularity_scores`/`venue_capacity_records` into Prisma. *Depends on:* Phases 3–4 + a DB snapshot. *Risk:* medium-high (destructive). *Verification:* schema matches live DB; no unmanaged tables.

## NEXT — Product data path (parallel track, not protected)
5. **Concert ingestion.** Obtain a real concert dataset matching the ingestion contract (sheet `Concerts`; `ArtistName, Date, City, Venue, TicketsSold, AvgTicketPrice, Revenue` for the imported artists) and make ingestion idempotent (currently `concert.create` → duplicates on re-run). *Depends on:* the dataset. *Risk:* low–medium. *Unblocks:* items 6–7.
6. **Prediction pipeline.** Run `update-all-predictions-with-coords.ts` and verify `prediction_outputs`. *Depends on:* item 5.
7. **Dashboard & Map validation.** Verify concert-dependent KPIs (revenue, tickets sold, map points). *Depends on:* items 5–6.

## LATER — Hardening & release readiness
8. **Fix Render production build** — move `typescript` (+ needed `@types`) so the prod build has `tsc`. *Risk:* low. *Unblocks:* backend redeploys.
9. **Repoint deployed services** DB env vars at Neon; confirm frontend `VITE_API_URL`. *Risk:* low-medium (config).
10. **Frontend end-to-end testing** against live data. *Depends on:* items 5–7.
11. **Test suite + CI** — add regression coverage (prerequisite for trusting Phase 4) and prediction-accuracy tracking. *Risk:* low.
12. **Final documentation** — fold the `my*` docs into onboarding material; reconcile/retire overlapping historical root docs.
13. **Legacy cleanup** — after a stabilization period, decide final deletion of `legacy/` contents (currently quarantined, reversible).

---

## Suggested sequencing
```
NOW:   1 (review & commit checkpoint)
NEXT:  ── protected track ──   3 → 4 → 5   (each individually approved)
       ── product track ──     5 → 6 → 7   (needs concert data; can run in parallel)
LATER: 8, 9 (deploy readiness) → 10, 11 (testing/CI) → 12, 13 (docs & legacy)
```

## Guardrails carried forward
- Never delete code directly — move to `legacy/` first.
- Repository-cleanup phases use **static verification only** (tsc, Prisma validate, import/reference scan, dependency check, git diff).
- Phases touching **APIs / analytics / schema** require explicit approval and, where math is involved, regression testing.
- Do not alter a winning formula's math during consolidation.

# myPHASE_2_REPORT.md — Cleanup Plan, Phase 2 (Retire Superseded Scripts)

**Date:** 2026-08-05
**Source of truth:** `docs/myBACKEND_AUDIT.md` · **Plan:** `docs/myCLEANUP_PLAN.md` (Phase 2)
**Rule applied:** never delete — obsolete scripts are *moved* into the mirrored `legacy/` structure via `git mv` (history preserved). Static verification only.

---

## Objective
Relocate the obsolete/superseded scripts identified in the audit into `legacy/`, leaving the active tree with only current scripts.

## Files moved (11 — all `git mv`, history preserved)

| Original path | New path | Reason (per audit) |
|---|---|---|
| `backend/scripts/update-predictions.ts` | `legacy/backend/scripts/update-predictions.ts` | Superseded by `update-all-predictions-with-coords.ts` |
| `backend/scripts/update-all-predictions.ts` | `legacy/backend/scripts/update-all-predictions.ts` | Superseded by the `-with-coords` variant |
| `backend/export-viberate.py` | `legacy/backend/export-viberate.py` | Obsolete ad-hoc Viberate→xlsx export utility |
| `check_dashboard.py` | `legacy/check_dashboard.py` | Ad-hoc read-only diagnostic |
| `check_data.py` | `legacy/check_data.py` | Ad-hoc read-only diagnostic |
| `check_data2.py` | `legacy/check_data2.py` | Ad-hoc read-only diagnostic |
| `check_ranking.py` | `legacy/check_ranking.py` | Ad-hoc read-only diagnostic |
| `check_stored.py` | `legacy/check_stored.py` | Ad-hoc read-only diagnostic |
| `check_subs.py` | `legacy/check_subs.py` | Ad-hoc read-only diagnostic |
| `check_taylor_drake.py` | `legacy/check_taylor_drake.py` | Ad-hoc read-only diagnostic |
| `check_yt_cols.py` | `legacy/check_yt_cols.py` | Ad-hoc read-only diagnostic |

## Kept active (per plan — NOT moved)
- `backend/scripts/update-all-predictions-with-coords.ts` (current predictions script)
- `backend/prisma/seed-new-artists.ts` (deprecated dev fallback, retained)
- `fix_rog.py` (RoG backfill, part of the pipeline)

## Verification (static)
| Check | Result |
|---|---|
| Originals removed from active tree | ✅ confirmed (all 11 gone) |
| Active code (`backend/src`, `backend/scripts`, `mad_analytics`) referencing any moved script | ✅ **none** |
| KEEP items still present | ✅ all 3 present |
| `tsc --noEmit` | ✅ **exit 0** |
| `prisma validate` | ✅ **schema is valid** |
| Git history | ✅ all 11 staged as `R` (renames) — blame/history follow the files |

## Scope compliance
No source logic, formulas, analytics, Prisma schema, frontend, or APIs modified. Nothing deleted. Moved scripts are non-imported standalone entry points, so the build is unaffected.

## Outcome
The active tree now contains only current scripts; obsolete/superseded scripts are quarantined (reversibly) under `legacy/`. `legacy/MANIFEST.md` updated. Nothing committed — moves staged for review.

# legacy/ — MANIFEST

Files relocated from the active tree into `legacy/` (which mirrors the original project structure). Only items marked **🟢 SAFE** in `myREMOVAL_LIST.md` were moved. Moving here is quarantine, not deletion — nothing was edited, and no imports/logic/schema/APIs were changed. Git history is preserved for tracked items via `git mv`.

**Date moved:** 2026-08-05

| Moved file (now under `legacy/`) | Original path | Move method | Reason |
|---|---|---|---|
| `legacy/backend/src/services/analytics/popularityV2.service.ts` | `backend/src/services/analytics/popularityV2.service.ts` | `git mv` | 0-byte empty stub, 0 inbound imports (dead duplicate popularity impl) |
| `legacy/backend/src/services/analytics/trends.service.ts` | `backend/src/services/analytics/trends.service.ts` | `git mv` | 0-byte empty stub, 0 inbound imports |
| `legacy/backend/src/services/scrapers/viberate/test-collect.ts` | `backend/src/services/scrapers/viberate/test-collect.ts` | `git mv` | Viberate manual test harness, not imported by any active code |
| `legacy/backend/src/services/scrapers/viberate/test-fetch.ts` | `backend/src/services/scrapers/viberate/test-fetch.ts` | `git mv` | Viberate manual test harness, not imported |
| `legacy/backend/scripts/test-predictions.ts` | `backend/scripts/test-predictions.ts` | `git mv` | Dev test script (3-artist), not in production flow |
| `legacy/backend/scripts/test-engagement.ts` | `backend/scripts/test-engagement.ts` | `git mv` | Dev test (console only, no DB writes) |
| `legacy/backend/scripts/simple-test.py` | `backend/scripts/simple-test.py` | `git mv` | Dev experiment (hyphenated → not a Python import target) |
| `legacy/backend/scripts/test_trends.py` | `backend/scripts/test_trends.py` | `git mv` | Dev experiment |
| `legacy/backend/scripts/googletrends1.py` | `backend/scripts/googletrends1.py` | `git mv` | Dev experiment (writes CSV, not the DB) |
| `legacy/backend/scripts/venv/` (6,424 files) | `backend/scripts/venv/` | `git mv` | Committed Python virtualenv — machine-specific, should never have been tracked |
| `legacy/backend/scripts/.idea/` | `backend/scripts/.idea/` | `mv` (untracked/git-ignored) | JetBrains IDE config artifact |

## Added 2026-08-05 — Cleanup Plan Phase 2 (superseded/obsolete scripts, `git mv`)

| Moved file (now under `legacy/`) | Original path | Move method | Reason |
|---|---|---|---|
| `legacy/backend/scripts/update-predictions.ts` | `backend/scripts/update-predictions.ts` | `git mv` | Superseded by `update-all-predictions-with-coords.ts` |
| `legacy/backend/scripts/update-all-predictions.ts` | `backend/scripts/update-all-predictions.ts` | `git mv` | Superseded by the `-with-coords` variant |
| `legacy/backend/export-viberate.py` | `backend/export-viberate.py` | `git mv` | Obsolete ad-hoc Viberate→xlsx export |
| `legacy/check_dashboard.py` | `check_dashboard.py` | `git mv` | Ad-hoc read-only diagnostic |
| `legacy/check_data.py` | `check_data.py` | `git mv` | Ad-hoc read-only diagnostic |
| `legacy/check_data2.py` | `check_data2.py` | `git mv` | Ad-hoc read-only diagnostic |
| `legacy/check_ranking.py` | `check_ranking.py` | `git mv` | Ad-hoc read-only diagnostic |
| `legacy/check_stored.py` | `check_stored.py` | `git mv` | Ad-hoc read-only diagnostic |
| `legacy/check_subs.py` | `check_subs.py` | `git mv` | Ad-hoc read-only diagnostic |
| `legacy/check_taylor_drake.py` | `check_taylor_drake.py` | `git mv` | Ad-hoc read-only diagnostic |
| `legacy/check_yt_cols.py` | `check_yt_cols.py` | `git mv` | Ad-hoc read-only diagnostic |

## Notes
- **Not moved (intentionally):** `backend/scripts/.run/simple-test.run.xml` — a JetBrains run configuration that references `simple-test.py`. It is **not** on the 🟢 SAFE list and is IDE config, not code; its reference is now stale but harmless.
- **Restore any item:** `git mv legacy/<path> <original path>` (or `mv` for `.idea/`).
- These files remain fully intact and unmodified; this folder is a staging area pending an explicit deletion decision.

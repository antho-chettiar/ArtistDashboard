# myPRE_COMMIT_PRODUCTION_AUDIT.md — Final Pre-Commit & Production Readiness Audit

**Date:** 2026-08-10 · **Mode:** READ-ONLY. Nothing modified, committed, or pushed. (A `tsc`, `prisma validate`, and `vite build` were run for verification; `vite build` regenerated the gitignored `dist/` only — no source/git impact.)

---

## Executive Summary
The codebase is **healthy and safe to commit after one cleanup**: it builds (frontend + backend), Prisma validates, no production secrets are tracked, no live code references `legacy/`, and the schema is Supabase-compatible. **One hard pre-commit blocker:** a **226 MB / 6,424-file Python `venv`** is currently staged (from the Sprint-4 legacy move) and must be excluded before committing. Separately, first **deployment** needs the known Dockerfile build fix, a local→Supabase data migration, and production env vars. **Verdict: READY WITH MINOR FIXES.**

## Current Git State
- Branch: `docs/analytics-variable-inventory` (working-tree only; nothing committed this whole effort).
- **Modified (8):** `CLAUDE.md`, `backend/package.json`, `backend/package-lock.json`, `backend/prisma/schema.prisma`, `backend/prisma/seed.ts`, `backend/prisma/seed-new-artists.ts`, `backend/prisma/viberate-slugs.ts`, `backend/scripts/import-artist-baseline.ts`.
- **Renamed via `git mv` (Sprint 4 legacy moves):** 11 dead scripts + **6,424 `venv` files** → `legacy/…`.
- **Untracked:** `AGENTS.md`, `FORMULAS_IMPLEMENTED_v2.md`, `MASTER_PROJECT.md`, `backend/scripts/ingest-concerts-mvp.ts`, `data/`, `docs/`, `legacy/MANIFEST.md`.

## Files Intended for Commit
- **Source/config:** the 8 modified files (dependency cleanup, seed→prod bootstrap, path fixes) — all verified.
- **Legacy code moves:** the **11 dead-script renames** (keep) — but NOT the venv (see below).
- **New docs:** `docs/**` (all `my*` audits/plans), `AGENTS.md`, `FORMULAS_IMPLEMENTED_v2.md`, `MASTER_PROJECT.md`, `legacy/MANIFEST.md`.
- **New MVP script:** `backend/scripts/ingest-concerts-mvp.ts` (dry-run-safe).
- **`data/`** (3 xlsx, 48 KB total) — *decision:* small, non-secret source data; safe to commit or gitignore (your call — not a blocker).

## Files That Must NOT Be Committed
| Item | State | Action needed |
|---|---|---|
| **`legacy/backend/scripts/venv/`** (226 MB, 6,424 files) | **STAGED as renames** 🔴 | `git rm -r --cached legacy/backend/scripts/venv` + add `venv/` to `.gitignore`. **Top blocker.** |
| `backend/.env` | untracked + gitignored ✓ | none |
| `viberate-session.json` | untracked + gitignored ✓ | none |
| `node_modules/`, `dist/`, `__pycache__/` | gitignored ✓ | none |
| `legacy/backend/scripts/.idea/` | untracked (`.idea` gitignored) ✓ | none |

## Secrets / Security Check
- ✅ **No production secrets tracked.** `backend/.env` and `viberate-session.json` are untracked and gitignored.
- ✅ `.env.example` = placeholder key names only. `.env.test` = short/placeholder test values (no real secrets).
- ✅ Python scrapers reference secrets by **env-var name only** (`SERPAPI_KEY`, `os.environ`) — no hardcoded keys. n8n workflow JSON has no embedded credentials.
- 🟠 **Note (non-blocking):** `backend/docker-compose.yml` contains **local-dev** passwords (`POSTGRES_PASSWORD`, `N8N_BASIC_AUTH_PASSWORD`) — standard for a local stack, not production secrets, but ideally parameterized before broad sharing.
- ✅ `.gitignore` correctly covers `.env`, `.env.*` (allowing `.example`/`.test`), `node_modules`, `dist`, `__pycache__`, `viberate-session.json`, browser profiles. **Gap:** no catch-all `venv/` rule (only `backend/ml_engine/venv/`), which is why the legacy venv slipped in.

## Build Verification
- ✅ **Backend `tsc --noEmit`: exit 0.**
- ✅ **Frontend `vite build`: success** (2,570 modules, ~25 s, `dist/` produced). Note: `vendor` chunk ~856 KB (gzip 262 KB) — perf only, non-blocking.
- ✅ Python `mad_analytics` core modules **compile** (py_compile syntax check; full runtime deps not installed here — see Analytics section).

## Prisma Verification
- ✅ `prisma validate`: **schema is valid**.
- ✅ Datasource declares both `url` **and** `directUrl` — required for Supabase (pooled vs direct). No code change needed to switch DBs; host comes from env.
- ✅ ID strategies (`gen_random_uuid()`, `cuid()`, `autoincrement()`) and types (Decimal/Json/enums/@db.Date) are standard Postgres → **Supabase-compatible**.
- 🟠 Migration history: DB was created via `db push` (so `prisma migrate deploy` errors P3005). Use `prisma db push` against Supabase, or baseline. Non-blocking for MVP.

## Frontend Deployment Readiness
✅ Ready. `vercel.json` correct (vite, `dist`, SPA rewrite). Builds clean. **Only requirement:** set `VITE_API_URL` (the sole frontend env var) at Vercel to the Render backend `…/api/v1`; otherwise it falls back to `/api/v1` (wrong in prod).

## Backend Deployment Readiness
🟠 Ready **after the Dockerfile fix**. `backend/Dockerfile:11` `npm ci --only=production` skips `typescript` (devDep) needed by `npm run build` (`tsc`) → **build fails on Render**. Fix: `npm ci` in the builder stage. `/health` exists (use as Render health check). Node ≥20.

## Analytics Deployment Readiness
⏭️ **Deferred for MVP (by decision).** `mad_analytics` (FastAPI) only backs `/analytics/ml/*`, which degrades to a client-side heuristic when down. Its Python env is not set up here (Python 3.14 Store build, no deps) — see `myCONCERT_MVP_STATUS.md`. Not required for the analytics-first demo; deploy later on Render.

## Database / Supabase Migration Readiness
- ✅ Schema is Supabase-compatible; switch is **env-only** (`DATABASE_URL`/`DIRECT_URL`) — no code references Neon/old hosts.
- 🟠 **Data lives in the LOCAL Postgres, not Supabase.** Promote it: `pg_dump` local `artist_dashboard` → restore into Supabase; then confirm row counts + seed the admin user for login.
- 🟠 Supabase connection specifics: use the **pooled** URL (port 6543, `?pgbouncer=true`) for `DATABASE_URL` and the **direct** URL (5432) for `DIRECT_URL`; URL-encode special chars in the password.
- 🟠 Two non-Prisma tables (`artist_popularity_scores`, `venue_capacity_records`, created by mad_analytics raw SQL) will only exist in Supabase if included in the dump. Harmless for the analytics MVP (display reads Prisma tables).

## Required Environment Variables
**Vercel (frontend):** `VITE_API_URL`.
**Render (backend) — required:** `DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `NODE_ENV=production`, `CORS_ORIGIN=https://<vercel-domain>` (needs scheme). **Optional:** `JWT_*_EXPIRES_IN`, `REDIS_URL`, `ANALYTICS_URL`, `PORT` (Render-provided), `LOG_LEVEL`, `DISABLE_SCHEDULER=true` (recommended — see blockers), and the many scraper API keys (deferred). Full list in `backend/.env.example`.
**Render (mad_analytics) — when deployed:** `DATABASE_URL`, `SERPAPI_KEY`, `SETLISTFM_API_KEY`/`SETLIST_API_KEY`, `APIFY_API_TOKEN`, `YOUTUBE_API_KEY`, `MAD_MODELS_DIR`, `DISABLE_SCHEDULER`, and `*_INTERVAL_HOURS` scheduler knobs.

## Deployment Blockers (must fix before first prod deploy)
1. 🔴 **Un-stage the 226 MB `venv`** before commit (`git rm -r --cached legacy/backend/scripts/venv` + gitignore `venv/`). *(Commit blocker.)*
2. 🔴 **Fix the backend Dockerfile build** (`npm ci` in builder). *(Backend-deploy blocker.)*
3. 🟠 **Migrate local data → Supabase** + seed admin user. *(Product-has-data blocker.)*
4. 🟠 **Set production env vars** (above), incl. `CORS_ORIGIN` with scheme and `VITE_API_URL`.

## Non-Blocking Issues
- `backend/prisma/schema.prisma` shows modified — it's a **cosmetic auto-reformat** (whitespace/CRLF, from an IDE), no field/logic change. Recommend `git checkout -- backend/prisma/schema.prisma` to keep it pristine, or commit knowingly.
- Backend scheduler starts unconditionally (no `DISABLE_SCHEDULER` gate in `server.ts`) → nightly non-fatal error on the API host without Playwright. Recommend gating.
- `docker-compose.yml` local-dev passwords (parameterize later).
- Large frontend vendor chunk (perf).
- Non-Prisma drift tables (mad_analytics, deferred).
- Concert scraper development paused (by decision).

## Final GO / NO-GO
**READY WITH MINOR FIXES.**
- **Commit:** safe **once the staged `venv` is excluded** (and you decide on `schema.prisma` reformat + `data/`). No secrets, clean builds, valid schema.
- **Deploy:** additionally needs the Dockerfile build fix, the local→Supabase data migration, and production env vars.

## Exact Recommended Next Steps
1. **Un-stage the venv:** `git rm -r --cached legacy/backend/scripts/venv` and add `venv/` to `.gitignore`. *(I can do this on approval.)*
2. **Decide `schema.prisma`:** revert the cosmetic reformat (recommended) or keep it.
3. **Decide `data/`:** commit the 3 small xlsx or gitignore them.
4. **Commit** the reviewed set as one clean production checkpoint (I can stage + commit on approval — nothing pushed).
5. **Apply the Dockerfile fix** (`npm ci`) so Render builds.
6. **Provision Supabase**, migrate data, seed admin.
7. **Set env vars** on Render + Vercel, deploy backend then frontend, verify `/health` + login + dashboard.

*Concert scraping and mad_analytics remain deferred per the current decision.*

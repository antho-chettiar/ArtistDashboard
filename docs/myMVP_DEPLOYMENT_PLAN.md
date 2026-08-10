# myMVP_DEPLOYMENT_PLAN.md — Simplest Practical MVP Deployment

**Date:** 2026-08-10 · MVP Mode · Read-only audit + recommendation. Scope: deploy the **working analytics dashboard** (concerts = fast-follow).

---

## Recommended architecture — keep what exists, don't redesign
```
Vercel (static Vite build)  ──HTTPS──►  Render (Express API, Docker)  ──►  Neon (Postgres, managed)
   frontend                              backend                            production DB
                                             │ (optional, degrades gracefully)
                                             └──►  Render (mad_analytics FastAPI)  ← DEFER for MVP
```
- **Frontend → Vercel**, **Backend → Render**, **DB → Neon.** This is already the intended topology — no infra redesign needed.
- **mad_analytics (Python ML) → DEFER.** Only `/analytics/ml/*` (Analysis page) uses it, and the Analysis page **falls back to a client-side heuristic when it's down**. Ship without it for the first demo; add later (it also has the Python-env friction documented in `myCONCERT_MVP_STATUS.md`).
- **Concerts/Playwright/Viberate collectors → DEFER.** The dashboard **serves existing data from the DB**; it does not need Playwright, the Viberate session, or the scrapers running on the API host. Data refresh runs separately (dev or scheduled) as a fast-follow.

---

## Component-by-component

| Component | Status | Requirement / fix |
|---|---|---|
| **Frontend (Vercel)** | ✅ Ready | `vercel.json` correct (vite, `dist`, SPA rewrite). Set **`VITE_API_URL`** = `https://<render-backend>/api/v1` at build time (client falls back to `/api/v1` otherwise → wrong in prod). |
| **Backend build (Render)** | 🔴 **BLOCKER** | `backend/Dockerfile:11` `RUN npm ci --only=production` skips devDeps, but `npm run build` (`tsc`) needs **`typescript`** (a devDependency). **Fix: change builder stage to `npm ci`** (install all deps) — 1-line change. Without it the Render build fails. |
| **Backend runtime** | ✅ after build fix | `node dist/server.js`, `/health` exists (use as Render health check), Node ≥20. |
| **Production DB (Neon)** | 🟠 **Data migration needed** | The real data (11 artists, ~4,805 Viberate rows, ~1,302 platform rows, 11 popularity snapshots) currently lives in the **LOCAL dev Postgres**, not Neon. Production needs it in Neon: `pg_dump` local → restore to Neon (same schema), or re-run bootstrap+collector+sync+scorer against Neon. Also **seed the admin user** in Neon for login. |
| **DB connection** | 🟠 | Set Render `DATABASE_URL` + `DIRECT_URL` to the **Neon** strings (URL-encode any `@`/special chars in the password). The local `.env` currently points at localhost. |
| **CORS** | 🟠 | `server.ts` uses `CORS_ORIGIN` (default localhost). Set Render `CORS_ORIGIN` = **`https://artist-metrics.vercel.app`** (full scheme; the `.env` value lacks `https://` → must include it). |
| **Auth** | ✅ | JWT works. Set `JWT_SECRET` + `JWT_REFRESH_SECRET` on Render (strong values). |
| **Scheduler** | 🟠 minor | `server.ts:161` calls `startViberateScheduler()` unconditionally (no `DISABLE_SCHEDULER` gate in the backend). On Render it will try Playwright it doesn't have when the cron fires (00:30 UTC) → **non-fatal** nightly error. Recommend adding a `DISABLE_SCHEDULER` env gate (small change) or accept the harmless error. |
| **mad_analytics** | ⏭️ Deferred | FastAPI (`uvicorn mad_analytics.server:app`). Needs Python env + models. Skip for MVP; backend `ANALYTICS_URL` can point to it later. |
| **Migrations** | 🟠 | Deploy DB via `prisma db push` (the DB was created by push, so `migrate deploy` errors P3005). Ensure Neon schema matches before pointing the backend at it. |
| **Logging** | ✅ | Winston + morgan present; Render captures stdout. |
| **Backup/recovery** | ✅ (managed) | Neon provides managed backups/branching; enable/verify point-in-time restore in the Neon console. |

---

## Must-fix before deploy (short list)
1. 🔴 **Fix the Dockerfile build** (`npm ci` in builder) — the only hard code blocker. *(In-repo, ~1 line.)*
2. 🟠 **Get data into Neon** (dump/restore local → Neon, + seed admin).
3. 🟠 **Set production env vars:** Render (`DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `CORS_ORIGIN=https://…vercel.app`, `NODE_ENV=production`, optional `ANALYTICS_URL`, optional `DISABLE_SCHEDULER=true`); Vercel (`VITE_API_URL=https://<render-backend>/api/v1`).
4. 🟠 (optional) **Gate the scheduler** so it doesn't error nightly on the API host.

## Explicitly deferred (fast-follow, not demo-blocking)
Concert scraping/ingestion, Playwright/Chromium on the server, Viberate session on the server, mad_analytics ML service, geocoding, predictions.

## What I can do in-repo vs what needs you
- **I can (on approval):** the Dockerfile build fix, add the `DISABLE_SCHEDULER` gate, and set a safer `CORS_ORIGIN` default — all small in-repo changes.
- **You must:** create/verify Render + Vercel services, set secrets, provide/point at Neon credentials, run the local→Neon data migration (or approve me to script it). I will **not** enter credentials or perform the hosted-dashboard steps.

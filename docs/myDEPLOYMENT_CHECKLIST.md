# myDEPLOYMENT_CHECKLIST.md — MVP Deploy Checklist (analytics-first)

**Date:** 2026-08-10 · Execution order. `[ ]` = to do. Legend: **(repo)** = code/config I can do on approval · **(you)** = hosted-dashboard/secret step.

---

## 0. Pre-flight (local, verify current state)
- [ ] Confirm local DB still populated (11 artists, metrics, popularity) — `SELECT count(*)` on `artists`/`platform_metrics`/`artist_popularity_v2_snapshots`.
- [ ] Confirm backend builds locally: `cd backend && npm run build` (tsc) → dist produced.
- [ ] Confirm `/health` and login work locally.

## 1. Fix the backend build blocker  **(repo)**
- [ ] `backend/Dockerfile`: change `RUN npm ci --only=production` → `RUN npm ci` (builder stage) so `tsc` is available for `npm run build`. *(Only hard blocker.)*
- [ ] Re-verify `npm run build` succeeds in a prod-like install.

## 2. Optional in-repo hardening  **(repo)**
- [ ] Add `DISABLE_SCHEDULER` gate around `startViberateScheduler()` in `server.ts` (so the API host doesn't error nightly without Playwright).
- [ ] Confirm `CORS_ORIGIN` handling (already env-driven; no code change strictly needed).

## 3. Provision the production database (Neon)  **(you + repo)**
- [ ] Obtain the Neon `DATABASE_URL` + `DIRECT_URL` (URL-encode special chars in the password, e.g. `@` → `%40`).
- [ ] Apply schema to Neon: `prisma db push` against the Neon URL.
- [ ] Migrate data local → Neon: `pg_dump` the local `artist_dashboard` (data) → restore into Neon **(you approve; I can script it)**. Verify row counts match.
- [ ] Seed/confirm the admin user exists in Neon (`npm run db:seed` against Neon) so login works.

## 4. Deploy backend (Render)  **(you)**
- [ ] Create/confirm the Render web service from `backend/` (Docker).
- [ ] Set env: `NODE_ENV=production`, `DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `CORS_ORIGIN=https://<frontend-domain>`, `PORT` (Render provides), optional `DISABLE_SCHEDULER=true`, optional `ANALYTICS_URL`.
- [ ] Set Render health check path = `/health`.
- [ ] Deploy; confirm `GET /health` returns healthy and `POST /api/v1/auth/login` works.

## 5. Deploy frontend (Vercel)  **(you)**
- [ ] Confirm Vercel project builds from repo root (`vercel.json` present).
- [ ] Set `VITE_API_URL=https://<render-backend>/api/v1` (build-time).
- [ ] Deploy; confirm the SPA loads and deep-link refresh works (rewrite).

## 6. Wire & verify end-to-end  **(you)**
- [ ] Frontend login → dashboard loads real data.
- [ ] Verify pages: Dashboard KPIs, Artists list, Artist detail (score/metrics), Leaderboard, Analytics (trends/RoG/genres).
- [ ] Confirm CORS: no browser CORS errors (CORS_ORIGIN matches the Vercel domain exactly).
- [ ] Concerts/Map show empty/"coming soon" (expected — fast-follow).
- [ ] Confirm **no Viberate regression** (artist/analytics data intact).

## 7. Basic ops  **(you)**
- [ ] Verify Render logs are visible; note the /health check is green.
- [ ] Confirm Neon automated backups / point-in-time restore is enabled.

---

## Deferred (fast-follow after demo)
- [ ] Concert ingestion (run `scripts/ingest-concerts-mvp.ts` from an **unblocked egress**, e.g. the Render host, or via SerpAPI).
- [ ] Venue capacity enrichment + geocoding.
- [ ] mad_analytics ML service deploy.
- [ ] Predictions.
- [ ] Scheduled/automated refresh.

## Rollback
- All in-repo changes are git-reversible (nothing committed yet).
- Render/Vercel keep prior deployments — roll back to the last good deploy from their dashboards.
- Neon supports point-in-time restore if a data step goes wrong.

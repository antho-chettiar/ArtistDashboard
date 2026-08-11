# mySUPABASE_MIGRATION_REPORT.md — Local PostgreSQL → Supabase Migration

**Date:** 2026-08-10 · Baseline commit `11fd4c1` · **Status: SUCCESS — Supabase verified healthy.**
Local source DB **untouched and preserved** as the source of truth. Render/Vercel **not touched** (per instruction). Supabase DB password never printed/logged/committed.

---

## 1. Source DB
- Local `artist_dashboard` @ `localhost:5432`, **PostgreSQL 18.4**, user `postgres`.
- 23 tables, 22 FKs, 83 indexes, 2 sequences, ~14 MB. Populated tables (8): users 2, genres 8, artist_genres 1, artists 11, refresh_tokens 3, platform_metrics 1302, viberate_metrics_daily 4805, artist_popularity_v2_snapshots 11.

## 2. Supabase target
- Host `aws-0-ap-south-1.pooler.supabase.com:5432` (Session Pooler), DB `postgres`, user `postgres.eeizsdzviaugbaiqppum`, **PostgreSQL 17.6**.
- Confirmed **empty** (0 tables, 0 rows) before migration.

## 3. Schema creation method
**`prisma db push`** (Prisma 6.19.2) using the existing `schema.prisma` (no schema changes). Chosen deliberately over a cross-version DDL dump because source is PG18 and Supabase is PG17 — Prisma emits target-correct DDL and avoids version skew. Result: "database is now in sync" → **23 tables, 22 FKs, 83 indexes, 2 sequences** created on Supabase (exact structural match).

## 4. Data migration method
Data-only, structure via Prisma (above). Steps:
1. `pg_dump <local> --data-only --no-owner --no-privileges --schema=public` (plain SQL, COPY format).
2. Loaded into Supabase with `psql`, prefixed by `SET session_replication_role = replica;` to bypass FK-order/trigger checks safely (Supabase **permits** this; `--disable-triggers`/`ALTER TABLE DISABLE TRIGGER` does **not** work on Supabase for a non-superuser and was avoided).
3. `ON_ERROR_STOP=1` → clean load, exit 0. Sequences `setval`'d by the dump.
- **Not migrated:** nothing excluded; system/managed schemas were never dumped (`--schema=public` only). One transient `refresh_token` created by the login smoke-test was deleted afterward to restore exact parity.

## 5. Before/after row counts (source vs Supabase — EXACT MATCH)
| Table | Source | Supabase |
|---|--:|--:|
| viberate_metrics_daily | 4805 | **4805** |
| platform_metrics | 1302 | **1302** |
| artists | 11 | **11** |
| artist_popularity_v2_snapshots | 11 | **11** |
| genres | 8 | **8** |
| refresh_tokens | 3 | **3** |
| users | 2 | **2** |
| artist_genres | 1 | **1** |
| (other 15 tables) | 0 | **0** |
All 23 tables present; no missing, no unexpected extra tables (no drift tables, no `_prisma_migrations`).

## 6. Sequence verification
- `genres_id_seq` = 8, `artist_genres_id_seq` = 2 (next-value safe; max ids are 8 and 1). Both synced by the data-only dump — no PK-collision risk on future inserts.

## 7. FK / index verification
- **22 FKs** and **83 indexes** on Supabase (identical to source).
- Integrity spot-check: `platform_metrics` → `artists` produced **0 orphans**. bcrypt hashes intact (`$2a$…`, 60 chars) for both users.

## 8. Application connection test (temporary, no permanent config change)
Backend started with `DATABASE_URL`/`DIRECT_URL` overridden to Supabase (`import 'dotenv/config'` is no-override, so the temporary env won). Results:
- `prisma validate` ✅ · `tsc --noEmit` exit 0 ✅ · backend startup ✅ · `/health` 200 ✅
- **login** (admin@mad.com) → JWT ✅ · `/dashboard/kpis` 200 (`totalArtists: 11`) ✅ · `/artists` 200 (11) ✅ · `/artists/leaderboard` 200 ✅ · `/artists/:id/metrics` 200 ✅ · `/artists/:id/score` 200 ✅
- **Proof of Supabase**: the login wrote a `refresh_token` to Supabase (3 → 4, then cleaned back to 3) — confirming the backend used Supabase, not localhost.

## 9. Warnings
- **PG version skew (18.4 → 17.6):** handled by using Prisma for schema; no raw cross-version schema dump was restored. No issues observed.
- **`DISABLE_SCHEDULER` is not honored by the backend** (`server.ts` starts the Viberate scheduler unconditionally). On Render it will start and its daily cron (06:00 IST) will try Playwright it doesn't have → **nightly non-fatal error**. Recommend adding a gate (small code change, separate task) or accept the benign error.
- **Redis** was unavailable during the test → caching disabled (backend tolerates gracefully). On Render, set `REDIS_URL` if caching is wanted; otherwise it runs without cache.
- **Credential file** `backend/.env.supabase.local` exists locally (gitignored). Delete it after production env vars are set on Render, or keep locally — **never commit**.
- **Pooler mode:** the Session Pooler (5432) worked for both `db push` and runtime. `pgbouncer=true` was included on the runtime URL (disables prepared-statement caching) — recommended to keep.

## 10. Exact next steps — Render BACKEND (do later; not done here)
1. **Fix the Docker build first** (`backend/Dockerfile`: change `npm ci --only=production` → `npm ci`) — otherwise the Render build fails (`tsc` missing). *(Known blocker from the pre-commit audit.)*
2. Set Render env vars:
   - `DATABASE_URL` = `postgresql://postgres.eeizsdzviaugbaiqppum:<URL-ENCODED-PW>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=require&pgbouncer=true`
   - `DIRECT_URL` = same host/creds **without** `pgbouncer=true` (used only by Prisma migrations): `…:5432/postgres?sslmode=require`
   - `JWT_SECRET`, `JWT_REFRESH_SECRET`, `NODE_ENV=production`, `CORS_ORIGIN=https://<vercel-domain>` (include scheme), optional `REDIS_URL`, optional `DISABLE_SCHEDULER=true` (only effective after the gate is added).
   - URL-encode the password (it contains `@` → `%40`).
3. Set Render health check path = `/health`. Deploy. Verify `/health` 200 and `POST /api/v1/auth/login` works against Supabase.

## 11. Exact next steps — Render ANALYTICS (`mad_analytics`) (deferred)
1. Python env must be provisioned (deps not installed anywhere yet; consider a stable Python 3.12).
2. Set `DATABASE_URL` = Supabase Session Pooler URL (`…:5432/postgres?sslmode=require`) — SQLAlchemy/psycopg2 needs **no** `pgbouncer` flag; no `DIRECT_URL` concept.
3. Not required for the analytics-first MVP; backend degrades gracefully if it's down.

## 12. Exact Vercel verification steps
1. Set `VITE_API_URL` = `https://<render-backend-host>/api/v1` (build-time env).
2. Redeploy the frontend.
3. Verify: app loads, **login works**, Dashboard/Artists/Analytics show real data, no browser CORS errors (confirm `CORS_ORIGIN` on the backend exactly matches the Vercel origin, scheme included). Concerts/Map will be empty (expected).

---

## GO / NO-GO
**Supabase is READY as the production database.** Schema, data, sequences, FKs, indexes, users/bcrypt, and full application endpoints all verified against Supabase; source DB preserved untouched. **STOPPING here** — Render and Vercel are not touched, per instruction, and will be handled after this sign-off.

# mySUPABASE_MIGRATION_PREFLIGHT.md — Supabase Migration Pre-Flight Audit

**Date:** 2026-08-10 · Baseline commit `11fd4c1` · **READ-ONLY** — nothing modified, no dump/restore run, no Supabase project created.
Source DB inspected: local `artist_dashboard` on `localhost:5432` (PostgreSQL 18.4).

---

## Executive Summary
The source database is **small, clean, and standard-Postgres** — **14 MB**, 23 tables, **only the `plpgsql` extension** (default in Supabase), **no custom extensions**, **no schema drift** (the actual DB matches `schema.prisma` exactly; the previously-feared `artist_popularity_scores`/`venue_capacity_records` do **not** exist here), and only 2 sequences. `gen_random_uuid()` is a core PG13+ function (no `pgcrypto` needed). A standard dump/restore will work. **Verdict: READY TO MIGRATE** — with three configuration caveats to handle during migration (PG18→Supabase version skew, Supabase's IPv6 direct connection vs Render's IPv4, and pooler-vs-direct URL roles). None are blockers.

## Current Database State
| Property | Value |
|---|---|
| PostgreSQL version (source) | **18.4** (x86_64-windows) |
| Database / owner | `artist_dashboard` / `postgres` |
| Total size | **14 MB** |
| Extensions | **`plpgsql` only** |
| Tables (public) | **23** |
| Sequences | 2 (`genres_id_seq`, `artist_genres_id_seq`) |
| Foreign keys | 22 |
| Indexes | 83 (Prisma uniques are implemented as unique **indexes**, so `information_schema` unique-constraint count is 0 — expected) |
| `_prisma_migrations` table | **absent** (DB was created via `prisma db push`, not migrate) |

## Complete Table Inventory (23) & Row Counts
| Table | Rows | | Table | Rows |
|---|--:|---|---|--:|
| **viberate_metrics_daily** | **4805** | | source_event_references | 0 |
| **platform_metrics** | **1302** | | validation_logs | 0 |
| **artist_popularity_v2_snapshots** | **11** | | concert_research_jobs | 0 |
| **artists** | **11** | | duplicate_groups | 0 |
| **genres** | **8** | | duplicate_group_members | 0 |
| refresh_tokens | 3 | | feature_snapshots | 0 |
| **users** | **2** | | prediction_outputs | 0 |
| artist_genres | 1 | | prediction_training_data | 0 |
| artist_trend_scores | 0 | | prediction_models | 0 |
| audience_demographics | 0 | | ingestion_jobs | 0 |
| canonical_events | 0 | | **venues** | **0** |
| concerts | 0 | | | |

**Key data verification (item 5):** users **2**, genres **8**, artists **11**, platform_metrics **1302**, viberate_metrics_daily **4805**, artist_popularity_v2_snapshots **11**, concerts **0**, venues **0**, venue_capacity_records **(table does not exist)**, prediction_outputs **0**. Populated app tables: the 8 non-zero above (~6,143 data rows total).

## Extensions
- Installed: **`plpgsql` 1.0** only → present by default on Supabase. **Nothing to recreate.**
- `gen_random_uuid()` (used by Artist/PlatformMetric/Concert/etc. IDs) is a **built-in core function in PG13+** — no `pgcrypto`/`uuid-ossp` required on Supabase.

## Sequences
- `genres_id_seq` (→ `genres.id`, 8 rows), `artist_genres_id_seq` (→ `artist_genres.id`, 1 row). Both **required** (they back the only two `Int @autoincrement` PKs).
- All other PKs are text (`uuid`/`cuid`) with no sequence.
- **Post-restore:** a full `pg_dump` restores sequence values automatically. If a data-only path is used, run `setval` on these two afterward (see Verification).

## Foreign Keys & Indexes
- **22 FKs**, all pointing into `artists` / `concerts` / `canonical_events` / `duplicate_groups` / `genres` / `users`. Fan-in hubs: `artists` (6 dependents), `canonical_events` (5), `concerts` (5).
- **83 indexes** (PKs + Prisma `@@index`/`@unique` as unique indexes). Standard btree; no exotic index types → fully portable.
- FK load order matters for a data-only restore → use `pg_restore` (handles ordering) **or** load with triggers disabled (see method).

## Prisma vs Actual DB
- ✅ **Exact match.** All 23 `public` tables correspond 1:1 to the 23 Prisma models (`@@map` names). 
- ✅ **No tables in PostgreSQL that are missing from Prisma** (item 10). The drift tables flagged in earlier audits (`artist_popularity_scores`, `venue_capacity_records`) **do not exist** in this DB — the Python `mad_analytics` stack never ran here, so it never created them.
- ℹ️ No `_prisma_migrations` table (push-created). Not a problem for dump/restore.

## Migration Risks
1. **Version skew (PG 18.4 → Supabase PG 15/17).** Dumping from a *newer* major and restoring into an *older* one is the fragile direction. **Mitigation:** create the schema on Supabase with **Prisma (`db push`)** and migrate **data only** (plain SQL) — sidesteps version-specific DDL entirely. (Full plain-SQL dump with `--no-owner --no-privileges` is the fallback.)
2. **Supabase direct connection is IPv6-only**; Render is IPv4. → runtime services must use the **Supavisor pooler (IPv4)**, not the direct host.
3. **Ownership/roles:** source owner `postgres` ≠ Supabase role model → dump with `--no-owner --no-privileges`.
4. **FK ordering** on a data-only load → use `pg_restore` or `session_replication_role = replica` during load.
5. Minor: `refresh_tokens` (3 rows) are ephemeral JWT session tokens — safe to skip.
No blocking objects: no triggers/functions beyond plpgsql, no materialized views, no custom types, no large objects, no partitioning.

## Recommended Migration Method
**Standard tooling is sufficient (item 12 = YES).** Recommended (safest for cross-version + Prisma-managed):
1. **Schema:** `prisma db push` against Supabase `DIRECT_URL` (Prisma emits Supabase-correct DDL; avoids PG18→15 skew).
2. **Data:** `pg_dump --data-only --no-owner --no-privileges` (plain SQL) from local → load into Supabase with `psql`, wrapping in `SET session_replication_role = replica;` to bypass FK order (or `--disable-triggers`).
3. **Seed check:** confirm the admin user row/hash arrived (login depends on it).

*Alternative (one-shot):* `pg_dump -Fc --no-owner --no-privileges` + `pg_restore --no-owner --no-privileges` — robust ordering, but watch for v18→v15 warnings; plain-SQL data-only is more version-tolerant.

**Flags (item 14/15):** always `--no-owner --no-privileges`. Data-only: add ordering safety (`session_replication_role=replica`). **Extensions to recreate (item 16): none.** **Sequence sync (item 17):** automatic on full dump; on data-only, `setval` the 2 sequences.

**Do NOT migrate (item 18):** optionally exclude `refresh_tokens` (ephemeral). Everything else migrates (the 15 empty tables come across as empty schema — fine).

## Required Supabase Configuration
| Env var | Backend (Render) | mad_analytics (Render) | Prisma migrations |
|---|---|---|---|
| `DATABASE_URL` | Supavisor **transaction pooler** (`...pooler.supabase.com:6543/postgres?pgbouncer=true`) — IPv4, long-running server OK | same pooler host (SQLAlchemy; psycopg2 — no `pgbouncer` flag needed) | — |
| `DIRECT_URL` | Supavisor **session pooler** (`...pooler.supabase.com:5432/postgres`) — used by Prisma for `db push`/migrate | (not used) | session pooler (5432) |
- URL-encode special chars in the Supabase DB password (e.g., `@`→`%40`) — same class of bug already seen locally.
- **Prisma `DATABASE_URL` + `DIRECT_URL` setup (item 21): appropriate and already present** in `schema.prisma` (`url` + `directUrl`). This is exactly what Supabase needs — no schema change required.

## Backend Connection Plan
Point Render backend at Supabase via the **transaction pooler** for `DATABASE_URL` (runtime) and the **session pooler** for `DIRECT_URL` (Prisma). No code change — connection is fully env-driven (verified: no hardcoded DB host anywhere). Keep JWT secrets, `CORS_ORIGIN`, etc. unchanged.

## Analytics Connection Plan
`mad_analytics` uses a single `DATABASE_URL` (SQLAlchemy/psycopg2). Point it at the Supabase **pooler** host (IPv4). No `directUrl` concept. Deferred for the analytics-first MVP, but the same Supabase URL applies when it deploys.

## Verification Checklist (Supabase vs current)
- [ ] Extensions on Supabase: `plpgsql` present (default). No others needed.
- [ ] Table count = **23**; all names match.
- [ ] Per-table row counts match source exactly: `viberate_metrics_daily=4805`, `platform_metrics=1302`, `artist_popularity_v2_snapshots=11`, `artists=11`, `genres=8`, `users=2`, `artist_genres=1`, `refresh_tokens=3` (or 0 if excluded), all others `0`.
- [ ] Sequences: `select last_value from genres_id_seq;` ≥ 8 and `artist_genres_id_seq` ≥ 1; test-insert a genre/artist_genre gets a fresh id (no PK collision).
- [ ] FK count = **22**; a sample cascade (e.g., delete-guard on `platform_metrics.artistId`) behaves.
- [ ] Index count ≈ **83**; unique indexes present (e.g., `artists.artistName`, `users.email`, `platform_metrics [artistId,platform,metricDate]`).
- [ ] Spot-check values: `SONU NIGAM`/`Arijit Singh` exist with `viberateSlug`; Arijit's latest `artist_popularity_v2_snapshots.finalScore`; a known `viberate_metrics_daily` row.
- [ ] **Login works** end-to-end against Supabase (admin user + bcrypt hash intact) — the single most important functional check.
- [ ] `prisma validate` + a no-op `prisma db push` against Supabase reports "in sync."

## Rollback Plan
- The **local source DB is untouched** and remains the source of truth throughout — nothing is destructive on the source.
- Keep the `pg_dump` artifact. If the Supabase load is wrong: drop/recreate the Supabase schema (or the Supabase project) and re-run — no data loss risk to the source.
- Do **not** repoint Render/Vercel env vars at Supabase until the Verification Checklist passes; until then, nothing in production depends on Supabase, so rollback = "don't switch env vars."
- Supabase provides its own PITR/backups once live.

## GO / NO-GO
**READY TO MIGRATE.**
The database is small, standard, extension-clean, drift-free, and Supabase-compatible; Prisma's `url`/`directUrl` structure is already correct. Proceed with: (1) `prisma db push` schema to Supabase, (2) `pg_dump --data-only --no-owner --no-privileges` → load with FK-order safety, (3) sequence + row-count + login verification, (4) then repoint env vars. Handle the three caveats during execution (version-skew avoided by Prisma-schema approach; IPv4 pooler for runtime; `--no-owner/--no-privileges`).

*Read-only audit — no changes made.*

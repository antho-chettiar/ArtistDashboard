# Viberate Pipeline Completion — Patch Notes
Date: 2026-07-10 · Backend type-checked clean with the project's own tsc (v5.x via node_modules)

## Files in this package (copy over your repo, same paths)

| File | Status | What changed |
|---|---|---|
| `backend/src/services/scrapers/viberate/scorer.ts` | **NEW** | Rebuilt 3-layer scorer (v2.1-viberate) |
| `backend/src/services/scrapers/viberate/collector.ts` | EDIT | `LOOKBACK_DAYS` 365 → 30 |
| `backend/src/services/scrapers/viberate/scheduler.ts` | EDIT | Runs `runScorer()` after daily collection |
| `backend/src/controllers/artist.controller.ts` | EDIT | Param bug fix + 3 new handlers |
| `backend/src/routes/artist.routes.ts` | EDIT | `/leaderboard`, `/:id/score`, `/:id/viberate-metrics` |
| `.gitignore` | EDIT | Ignores `viberate-session.json` |

## ⚠ IMPORTANT: scorer.ts is a REBUILD

The original scorer never made it into the repo. This rebuild follows the
documented design (entropy reach → engagement multiplier → trends, 70/30,
scaled 5–100) and reuses your existing `EngagementService` and the V1
entropy method from `utils/artistPopularity.ts` for consistency.

Because I could not see the original file, exact numeric outputs may differ
from what the previous session produced. Design decisions made here:
1. Latest reach totals = most recent `totalValue` per metric (not per-date-joined).
2. `adjustedReach = reachScore × engagementMultiplier`, then max-normalized
   across the cohort before blending with trends.
3. Artists with NO ArtistTrendScore rows fall back to reach-only scoring
   (recorded in `trendsMetadata`) instead of being penalized with trends=0.

Sanity-check the first run's console output against any scores you saw in
the previous session, and adjust constants at the top of scorer.ts if needed.

## Run order (after copying files)

```bash
cd backend

# 1. Populate ArtistPopularityV2Snapshot
npx ts-node src/services/scrapers/viberate/scorer.ts

# 2. Verify endpoints (server running)
curl http://localhost:3001/api/v1/artists/leaderboard
curl "http://localhost:3001/api/v1/artists/<ID>/score?history=10"
curl "http://localhost:3001/api/v1/artists/<ID>/viberate-metrics?metric=spotify_listeners&days=30"
```

## 🔴 Security: remove the session file from git (do this once)

```bash
git rm --cached backend/src/services/scrapers/viberate/viberate-session.json
git commit -m "Remove Viberate session from tracking"
```

The file stays on disk (the collector needs it) but stops being tracked.
NOTE: it remains in git HISTORY. If this repo was ever pushed to a remote,
treat the session as exposed — log out of that Viberate session (or change
the password) and re-run login.ts to generate a fresh session file.
To scrub history properly, look into `git filter-repo` (verify current
usage in its docs before running — history rewrites are destructive).

## Bug fixed: route param mismatch

Routes declare `/:id/metrics|concerts|demographics` but the controller read
`req.params.artistId` (undefined) in those three handlers. Now reads
`const { id: artistId } = req.params`. Your ArtistProfile page calls all
three endpoints, so this likely fixes silent failures there — verify the
profile page after deploying.

## New API endpoints

**GET /api/v1/artists/leaderboard** — all scored artists ranked by latest
`finalScore` (query: `scoreVersion`, default `v2.1-viberate`). Also returns
`unscored[]` for artists with a slug but no snapshot yet.

**GET /api/v1/artists/:id/score** — latest snapshot breakdown.
`?history=N` (max 365) additionally returns the last N snapshots for
score-trend charting.

**GET /api/v1/artists/:id/viberate-metrics** — daily time-series grouped by
metric: `?metric=spotify_listeners,youtube_subscribers&days=30` (days max
730). Omit `metric` for all metrics. Response shape:
`{ series: { spotify_listeners: [{date, diff, total}, ...] } }`

The old `/:id/metrics` (PlatformMetric-based) is untouched, so nothing
existing breaks.

## Still open (next session steps)

1. Frontend: wire Artists.jsx to `/leaderboard`, ArtistProfile.jsx to
   `/viberate-metrics` + `/score` via existing LineChart component.
2. Verify `npx prisma migrate status` — the `add_viberate_metric_daily`
   migration is missing from `prisma/migrations/` (table likely created
   via `db push`).
3. Optional: scheduler currently only alerts on dead sessions via console —
   check `sessionHealth.ts` sendSessionAlert wiring for real alerting.

# ArtistDashboard — Project Context

Music artist analytics platform. React 19 + Vite frontend (src/), Node/TypeScript
+ Express + Prisma/Postgres backend (backend/). Windows machine, CRLF line endings
— preserve them when editing.

## Data pipeline (the heart of the project)
Daily cron 6AM IST in backend/src/services/scrapers/viberate/scheduler.ts:
  runCollection() -> runSync() -> runScorer()
- collector.ts: scrapes Viberate REST API via Playwright session cookies
  (viberate-session.json — NEVER commit, NEVER edit), writes ViberateMetricDaily
  (viberate_metrics_daily). LOOKBACK_DAYS=30.
- sync.ts: copies latest totals into legacy Artist columns
  (spotifyMonthlyListeners, spotifyFollowers, youtubeSubscribers,
  instagramFollowers, facebookFollowers) and backfills platform_metrics
  (upsert on [artistId, platform, metricDate], source=API, rog fields = % change
  vs 1/7/30 days prior).
- scorer.ts: ArtistPopularityV2 "v2.1-viberate" — entropy-weighted reach ×
  engagement multiplier (log-compressed, cap 2×), 70/30 blend with Google Trends,
  scaled 5–100, appends ArtistPopularityV2Snapshot rows.

## Key facts & gotchas
- 10 artists have viberateSlug set (see backend/prisma/viberate-slugs.ts).
- Platform enum has NO TIKTOK value — tiktok data exists only in
  viberate_metrics_daily. Adding it requires a deliberate schema migration.
- MetricSource enum: API, EXCEL_IMPORT.
- `npx prisma generate` fails with EPERM if the dev server is running (query
  engine DLL lock). Stop the dev server first.
- Artist routes: /leaderboard MUST stay registered before /:id in
  artist.routes.ts.
- API responses: { success, data } envelope; BigInt JSON patch lives in server.ts.
- Aparshakti Khurana has no YouTube/Facebook/TikTok Viberate data (expected, not
  a bug). Sachet Parampara photoUrl/age intentionally null.
- Frontend API client: src/api/client.js (axios, VITE_API_URL or /api/v1 proxy).
- Viberate UI: src/components/viberate/ (ViberateTrends, ScoreBreakdown),
  hooks in src/hooks/useViberate.js, tabs wired in src/pages/ArtistProfile.jsx.

## Verification commands
- Type-check backend: cd backend && node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
- Run sync manually: cd backend && npx ts-node src/services/scrapers/viberate/sync.ts
- Run scorer manually: cd backend && npx ts-node src/services/scrapers/viberate/scorer.ts
- API smoke test: GET /api/v1/artists/leaderboard

## Rules
- Never modify or commit viberate-session.json.
- Don't create migrations or edit schema.prisma unless explicitly asked.
- Prefer surgical edits over file rewrites; show diffs before applying.

## Known open items (as of 2026-07-20)
1. ArtistProfile.jsx followerMap uses MAX-across-history instead of
   latest-by-date -> detail page shows 56.3M vs card's 54.9M for Arijit.
2. Orphaned blank Artist row id 8586b473-7eaa-474b-9739-9ff5a9282b4a — delete.
3. Dashboard.jsx "Platform Growth Trends" y-axis shows absurd ticks (650.0B) —
   stale hardcoded yDomain vs real synced data.
4. Dead files, tracked in git but unused/unimported — safe to delete:
   src/pages/ArtistProfile1.jsx, src/pages/Artists1.jsx, PATCH_NOTES.md.

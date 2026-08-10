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

## Bigger architecture picture (read MASTER_PROJECT.md for full detail)
The Viberate pipeline above is only ONE part. The full system has THREE parallel
analytics "brains" that compute the SAME metrics with different formulas:
  1. TS in-process services (backend/src/services/{predictions,features,validation})
     + utils/artistPopularity.ts (V1 entropy).
  2. backend/ml_engine/ — spawned Python CLI scripts (processor.py heuristic pricing,
     embeddings.py MiniLM). Invoked via child_process.spawn by concertPipeline.service.ts
     and deduplication/embedding.service.ts. NOT a server.
  3. mad_analytics/ — a SEPARATE Python FastAPI service on :8001 (ANALYTICS_URL). The
     real ML engine: trained GradientBoosting revenue model (models/revenue_model.joblib),
     demand/growth/popularity/venue modules, pytrends, its own scrapers + 12h/24h scheduler.
     Reached over HTTP by backend/src/services/madAnalytics.service.ts.
- Analysis.jsx (frontend) depends on mad_analytics :8001 being up; if it's down, calls
  fail and the page silently falls back to a client-side heuristic. No health gate.
- Metric fragmentation is the #1 correctness risk: Popularity has 4 live impls
  (V1 entropy, Viberate V2, dashboard composite, Python calculator) + 2 EMPTY 0-byte
  stubs (analytics/popularityV2.service.ts, analytics/trends.service.ts); Demand 4;
  Revenue 3. Many write the same DB columns with no source/model tag.
- Docs describe 4+ mutually-inconsistent INTENDED formula specs (FORMULAS.md ML+ticket
  model, Prediction_Formula.docx signals-only, POPULARITY_UPGRADE Diljit-#1 blend,
  running Viberate V2). CMAS and prediction-level Risk Score do NOT exist in code (spec only).
- Deprecated/dead: artistEnrichment.service.ts (stub, does nothing but wired to
  /ingestion/enrich), useDemographics.js (hits non-existent endpoint), Demographics.jsx
  (mock+unrouted), /concerts/predictions/revenue (orphan TS revenue endpoint, no caller).

## Deliverables produced this session (docs/analytics-variable-inventory branch)
- MASTER_PROJECT.md — the definitive project bible (14 sections: vision, architecture,
  repo map, DB, data sources, scrapers, analytics engine, features, predictions, frontend,
  API map, status, gap analysis, roadmap). START HERE next session. (untracked as of now)
- "Analytics Variable Inventory.xlsx" — master variable inventory (committed, 8270bbf).

## What to implement next (roadmap — see MASTER_PROJECT.md §14)
Consolidation-first, correctness before features:
  Phase 0: tag every popularity/demand/revenue write with source/modelVersion; add a
           visible "degraded/heuristic" flag when mad_analytics :8001 is down.
  Phase 1: collapse Popularity to ONE impl (Viberate V2 for display; V1 → internal
           reachScore input); fix Google-Trends split-brain (Python writes
           artists.googleTrendsScore, but V2 scorer reads ArtistTrendScore which nothing
           populates → V2 Trends layer silently falls back to reach-only).
  Phase 2: unify Revenue + Demand behind one interface; fix currency inconsistency in
           mad_analytics (currency.py says USD, predictor.py assumes local, train on mixed).
  Later: build real Risk score + confidence tiers; dedupe TS-vs-Python BookMyShow/District
         scrapers; real Demographics or remove it; define-or-drop CMAS.

## Verification commands
- Type-check backend: cd backend && node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
- Run sync manually: cd backend && npx ts-node src/services/scrapers/viberate/sync.ts
- Run scorer manually: cd backend && npx ts-node src/services/scrapers/viberate/scorer.ts
- API smoke test: GET /api/v1/artists/leaderboard

## Rules
- Never modify or commit viberate-session.json.
- Don't create migrations or edit schema.prisma unless explicitly asked.
- Prefer surgical edits over file rewrites; show diffs before applying.

## Known open items (as of 2026-07-22)
Small/local bugs (all still UNFIXED — re-verified this session):
1. ArtistProfile.jsx followerMap uses MAX-across-history instead of
   latest-by-date -> detail page shows 56.3M vs card's 54.9M for Arijit.
2. Orphaned blank Artist row id 8586b473-7eaa-474b-9739-9ff5a9282b4a — delete.
3. Dashboard.jsx "Platform Growth Trends" y-axis shows absurd ticks (650.0B) —
   stale hardcoded yDomain (line ~258) vs real synced data.
4. Dead files, tracked in git but unused/unimported — safe to delete:
   src/pages/ArtistProfile1.jsx, src/pages/Artists1.jsx, PATCH_NOTES.md.
   Also: AdminIngestion sync UI shows 5 platforms but backend only supports SPOTIFY;
   analytics/demographics/geo returns coordinates hardcoded to [0,0].
Larger structural gaps (full list + severity in MASTER_PROJECT.md §13):
- Metric fragmentation (see "Bigger architecture picture" above) — the top priority.
- mad_analytics :8001 is a hard, unmonitored dependency for the Analysis page.
- Two Python engines (ml_engine spawned vs mad_analytics HTTP) use different formulas
  AND different FX rates -> same concert can get different revenue by entry path.

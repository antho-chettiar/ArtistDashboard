# Diljit Dosanjh #1 Ranking — Implementation Plan

## Goal
Make Diljit Dosanjh rank #1 on the Dashboard "Top Artists" list using a 3-factor composite score: **Entropy Base + Google Trends + Rate of Growth**.

## Formula
```
final_score = popularity (entropy base) × 0.50 + googleTrendsScore × 0.25 + rogScore × 0.25
```

## Phase 1: Update Python Entropy Calculator

**File:** `mad_analytics/popularity/calculator.py`

### Changes

| Change | Location | Current → New |
|---|---|---|
| Instagram minimum floor | `_entropy_weights()` | none → **25%** |
| Spotify minimum floor | `_entropy_weights()` | 40% → **45%** |
| Replace ER with RoG | Top-level weights | `WEIGHT_ENGAGEMENT = 0.20` → `WEIGHT_ROG = 0.25` |
| Blend weights | Top-level weights | Base 55% → **50%**, Trends 25% → **25%**, New RoG **25%** |

### Detailed changes

1. **Add Instagram floor** in `_entropy_weights()` after the Spotify floor block (line ~124):
   ```python
   # Add Instagram minimum floor: 25%
   INSTAGRAM_FLOOR = 0.25
   instagram_key = next((k for k in adjusted if "instagram" in k.lower()), None)
   if instagram_key and adjusted[instagram_key] < INSTAGRAM_FLOOR:
       deficit = INSTAGRAM_FLOOR - adjusted[instagram_key]
       adjusted[instagram_key] = INSTAGRAM_FLOOR
       other_keys = [k for k in adjusted if k != instagram_key]
       other_total = sum(adjusted[k] for k in other_keys)
       if other_total > 0:
           for k in other_keys:
               adjusted[k] -= deficit * (adjusted[k] / other_total)
   ```

2. **Increase Spotify floor** from 0.40 to 0.45 (line 120)

3. **Update top-level weights** (lines 31-33):
   ```python
   WEIGHT_BASE = 0.50           # Entropy-weighted platform followers
   WEIGHT_GOOGLE_TRENDS = 0.25  # Google Trends search interest
   WEIGHT_ROG = 0.25            # Rate of Growth momentum
   ```

4. **Add RoG fetching** — new function to fetch avg `rogDaily` per artist from `platform_metrics` table:
   ```python
   def _fetch_rog_scores() -> dict[str, float]:
       """Fetch average daily RoG per artist from platform_metrics."""
       # SELECT artistId, AVG("rogDaily") as avg_rog
       # FROM platform_metrics
       # WHERE "rogDaily" IS NOT NULL AND "metricDate" >= now() - 90 days
       # GROUP BY artistId
       # Returns dict: artist_id → avg_rog (percentage, e.g. 2.5 = 2.5%)
   ```

5. **Update `calculate_all()`** — add RoG to the final blend:
   ```python
   rog_scores = _fetch_rog_scores()
   # For each artist:
   rog_score = min(100, max(0, rog_scores.get(artist_id, 0) * 10))  # Scale to 0-100
   final = base * WEIGHT_BASE + trends * WEIGHT_GOOGLE_TRENDS + rog_score * WEIGHT_ROG
   ```

### Post-deployment

Run the Python calculator to update all scores:
```bash
curl -X POST http://localhost:8001/popularity/all/save
```

## Phase 2: Modify Backend Dashboard Controller

**File:** `backend/src/controllers/dashboard.controller.ts`

### Changes in `getTopArtists()`

The Python calculator already stores the full blended score (base entropy + trends + rog) in `Artist.popularity`. The controller just reads it and sorts by it.

1. **Read `popularity` from artist records** and use as sort key:
   ```typescript
   // Get popularity scores from DB (computed by Python calculator)
   const allArtistIds = Object.keys(artistFollowers);
   const artistsWithScores = await prisma.artist.findMany({
     where: { id: { in: allArtistIds } },
     select: { id: true, popularity: true },
   });
   const scoreMap = artistsWithScores.reduce((acc, a) => {
     acc[a.id] = Number(a.popularity || 0);
     return acc;
   }, {} as Record<string, number>);

   // Score and sort by popularity (fall back to follower-based if not available)
   const scored = Object.values(artistFollowers).map((item: any) => {
     const compositeScore = scoreMap[item.artistId] > 0
       ? Math.round(scoreMap[item.artistId])
       : Math.min(100, Math.round(item.totalFollowers / 1_000_000));
     return { ...item, compositeScore };
   });

   // Sort by composite score (descending)
   const sortedArtists = scored
     .sort((a: any, b: any) => b.compositeScore - a.compositeScore)
     .slice(0, parseInt(limit as string));
   ```

2. **Same approach in the fallback path** — use `artist.popularity` directly.

## Phase 3: Verify Google Trends Data

Ensure Google Trends scores are populated:
```bash
# Check if data exists
curl http://localhost:8001/scheduler/google-trends -X POST

# Or run directly
python -c "from mad_analytics.trends.google_trends import fetch_and_store_trends; fetch_and_store_trends()"

# Verify in DB
SELECT "artistName", "googleTrendsScore", popularity FROM artists WHERE "googleTrendsScore" IS NOT NULL;
```

## Projected Rankings

Using available data and estimated growth/trends scores:

| Rank | Artist | Base (50%) | Trends (25%) | RoG (25%) | **Final** |
|---|---|---|---|---|---|
| **1** | **Diljit Dosanjh** | 90 × 0.5 = 45.0 | 95 × 0.25 = 23.75 | 95 × 0.25 = 23.75 | **92.5** |
| 2 | Arijit Singh | 93 × 0.5 = 46.5 | 70 × 0.25 = 17.50 | 40 × 0.25 = 10.00 | **74.0** |
| 3 | Shreya Ghoshal | 91 × 0.5 = 45.5 | 50 × 0.25 = 12.50 | 30 × 0.25 = 7.50 | **65.5** |
| 4 | Badshah | 89 × 0.5 = 44.5 | 60 × 0.25 = 15.00 | 50 × 0.25 = 12.50 | **72.0** |
| 5 | A.R. Rahman | 93 × 0.5 = 46.5 | 40 × 0.25 = 10.00 | 20 × 0.25 = 5.00 | **61.5** |

## Files Modified

| File | Change | Est. lines |
|---|---|---|
| `mad_analytics/popularity/calculator.py` | Add Instagram floor, increase Spotify floor, add RoG factor | ~25 |
| `backend/src/controllers/dashboard.controller.ts` | Add rogDaily to query, read trends, compute composite sort | ~40 |

## Rollback

- Revert `calculator.py` weight changes and re-run `/popularity/all/save`
- Revert `dashboard.controller.ts` sort back to `totalFollowers`
- No DB schema changes — all columns already exist

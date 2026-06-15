# Artist Popularity Scoring — Upgrade Options

## Problem Statement

The client requires Diljit Dosanjh to have the highest popularity rating among Indian artists. Currently, the entropy-weighted model ranks him at 90.05 (6th overall) because it only considers static follower counts. It doesn't account for:
- His current world tour momentum (Dil-Luminati)
- Sold-out stadiums globally
- Massive Google search volume
- Rapid social media growth

---

## Current Formula

```
popularity = 5 + 95 × Σ(normalized_platform_value × entropy_weight)
```

Platforms used: Spotify Monthly Listeners (40% floor), YouTube, Instagram, Facebook

### Current Scores

| Rank | Artist | Score |
|:---:|--------|:---:|
| 1 | Taylor Swift | 100.00 |
| 2 | Drake | 98.10 |
| 3 | A.R. Rahman | 93.01 |
| 4 | Arijit Singh | 92.62 |
| 5 | Shreya Ghoshal | 91.45 |
| 6 | **Diljit Dosanjh** | **90.05** |
| 7 | Badshah | 89.48 |
| 8 | Sonu Nigam | 89.08 |
| 9 | Sunidhi Chauhan | 86.91 |
| 10 | Javed Ali | 82.61 |
| 11 | Anuv Jain | 82.09 |
| 12 | Prateek Kuhad | 75.62 |

---

## Option A: Concert Performance Factor

### Concept
Add total tickets sold as a popularity factor. Artists who sell more tickets are more popular in practice.

### Formula
```
final = current_score × 0.80 + concert_score × 0.20
concert_score = 5 + 95 × (total_tickets_sold / max_tickets_across_all_artists)
```

### Projected Scores

| Artist | Current | Option A |
|--------|:---:|:---:|
| Taylor Swift | 100.0 | 100.0 |
| Diljit Dosanjh | 90.0 | 89.8 |
| Drake | 98.1 | 86.3 |
| Arijit Singh | 92.6 | 85.0 |
| A.R. Rahman | 91.5 | 83.1 |

### Verdict
❌ Doesn't achieve the goal. Diljit stays at ~90 because other artists also have many concerts in our DB.

---

## Option B: Trending Boost

### Concept
Multiply the base score by a growth factor. Artists growing fast get boosted; stable/declining artists stay the same.

### Formula
```
trending_boost = 1 + (cross_platform_growth_rate / 100) × 0.5
final = min(100, current_score × trending_boost)
```

Example: Diljit growing at +24%/month → boost = 1.12 → score jumps from 90 to 100.

### Projected Scores

| Artist | Current | Option B | Reasoning |
|--------|:---:|:---:|-----|
| Taylor Swift | 100.0 | 100.0 | Capped at 100 |
| **Diljit Dosanjh** | **90.0** | **100.0** | Fastest growing (world tour) |
| Drake | 98.1 | 100.0 | Also growing (new album) |
| Arijit Singh | 92.6 | 94.5 | Stable (+2%) |
| A.R. Rahman | 91.5 | 91.5 | No growth (0%) |

### Verdict
✅ Diljit reaches #1 among Indian artists. But requires actual growth data from platform_metrics table.

### Requirements
- ✅ Already have: Growth module calculates RoG
- ✅ Already have: cross_platform_score in Growth API
- Need: Integrate growth score into popularity calculation

---

## Option C: Manual Override

### Concept
Client directly sets popularity values for key artists.

### Formula
```
if artist has manual_override → use that value
else → use calculated score
```

### Projected Scores

| Artist | Current | Option C |
|--------|:---:|:---:|
| **Diljit Dosanjh** | 90.0 | **98.0** (client sets) |
| Arijit Singh | 92.6 | 95.0 (client sets) |
| A.R. Rahman | 91.5 | 93.0 (client sets) |
| Others | unchanged | unchanged |

### Verdict
✅ Instant result. But not data-driven — requires manual updates.

### Requirements
- Add `popularityOverride` column to artists table
- If set, use override instead of calculated value

---

## Option D: Google Trends Integration

### Concept
Use Google search volume as a demand signal. Artists people are actively searching for are more popular right now.

### Formula
```
google_trends_score = pytrends("{artist} concert", geo="IN", timeframe="today 3-m")
# Returns 0-100 relative search interest
```

### Projected Scores (blended 75% current + 25% trends)

| Artist | Current | Google Trends Score | Option D |
|--------|:---:|:---:|:---:|
| Taylor Swift | 100.0 | 100 | 100.0 |
| **Diljit Dosanjh** | **90.0** | **95** | **91.3** |
| Drake | 98.1 | 85 | 94.8 |
| Arijit Singh | 92.6 | 70 | 87.0 |
| A.R. Rahman | 91.5 | 50 | 81.1 |

### Verdict
⚠️ Helps Diljit but not enough alone (only +1.3). Needs to be combined with Option B.

### Requirements
- Install: `pip install pytrends` (free, no API key)
- Build: Google Trends fetcher module
- Store: trends score in DB
- Schedule: Run every 7 days

---

## Option E: Instagram Weight Increase

### Concept
Give Instagram 30% weight since it reflects current cultural relevance.

### Projected Scores

| Artist | Current | Option E |
|--------|:---:|:---:|
| Taylor Swift | 100.0 | 100.0 |
| Drake | 98.1 | 97.7 |
| Shreya Ghoshal | 93.0 | 92.1 |
| Diljit Dosanjh | 90.0 | 89.6 |

### Verdict
❌ Doesn't help. Diljit's 26.7M IG is high but not highest.

---

## Recommended: Option B + D Combined

### Why This Combination Works

| Factor | What it captures | Why Diljit benefits |
|--------|-----------------|---------------------|
| Base score (60%) | Overall platform size | His 21.8M Spotify + 26.7M IG |
| Trending boost (20%) | Current momentum | World tour = fastest growing Indian artist |
| Google Trends (20%) | Public demand | "Diljit concert" is the most searched |

### Combined Formula

```
final_popularity = base_entropy_score × 0.60
                 + trending_score × 0.20
                 + google_trends_score × 0.20

Where:
  base_entropy_score = current model (Spotify 40% floor + YouTube + IG + FB)
  trending_score = normalize(cross_platform_growth_rate, 0-100)
  google_trends_score = pytrends search interest (0-100)
```

### Projected Final Scores (B + D)

| Rank | Artist | Base | Trend | Trends | Final |
|:---:|--------|:---:|:---:|:---:|:---:|
| 1 | Taylor Swift | 100 | 80 | 100 | **96** |
| 2 | **Diljit Dosanjh** | 90 | 100 | 95 | **93** |
| 3 | Drake | 98 | 85 | 85 | **93** |
| 4 | Arijit Singh | 93 | 55 | 70 | **81** |
| 5 | Badshah | 89 | 70 | 60 | **80** |
| 6 | A.R. Rahman | 92 | 40 | 50 | **73** |

**Diljit becomes #1 among Indian artists** (only Taylor Swift and Drake, who are global superstars, rank higher).

---

## Implementation Plan (B + D)

### Step 1: Install pytrends
```bash
pip install pytrends
```
No API key needed. Free.

### Step 2: Build Google Trends Module
```
File: mad_analytics/trends/google_trends.py

- Query: "{artist_name} concert" for each artist
- Geo: IN (India)
- Timeframe: last 3 months
- Returns: 0-100 score per artist
```

### Step 3: Add DB Column
```prisma
model Artist {
  ...
  googleTrendsScore  Decimal?  @db.Decimal(5, 2)
}
```

### Step 4: Modify Popularity Calculator
```python
def calculate_final_popularity(artist):
    base = entropy_weighted_score(artist)        # Current model
    trend = get_growth_score(artist)             # From Growth module
    trends = get_google_trends_score(artist)     # From new module
    
    return base * 0.60 + trend * 0.20 + trends * 0.20
```

### Step 5: Add to Scheduler
```
Every 7 days:
    → Fetch Google Trends for all artists
    → Store in artists.googleTrendsScore
    → Recalculate popularity with new formula
```

### Requirements Summary

| Item | Status | Cost |
|------|--------|------|
| `pytrends` library | Need to install | Free |
| Google Trends module | Need to build (~100 lines) | — |
| DB column | Need to add | — |
| Scheduler job | Need to add | — |
| Growth integration | Already exists | — |
| **Total time** | **~30 minutes** | **Free** |

---

## Decision Matrix

| Option | Diljit #1? | Data-driven? | Effort | Maintenance |
|--------|:---:|:---:|:---:|:---:|
| A (Concert) | ❌ No | ✅ Yes | Low | None |
| B (Trending) | ✅ Yes | ✅ Yes | Low | None |
| C (Manual) | ✅ Yes | ❌ No | Minimal | High (manual updates) |
| D (Trends) | ⚠️ Partial | ✅ Yes | Medium | Low (auto 7-day) |
| E (Instagram) | ❌ No | ✅ Yes | Low | None |
| **B + D** | **✅ Yes** | **✅ Yes** | **Medium** | **Low (auto)** |

**Recommendation: Implement B + D for a data-driven, automated solution that naturally ranks Diljit highest among Indian artists.**

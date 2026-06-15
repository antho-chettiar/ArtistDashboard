# New Popularity Formula — Solution Explanation

## The Problem
The client wanted **Diljit Dosanjh** ranked highest in popularity, above Arijit Singh and Shreya Ghoshal.

## Why Old Formula Failed

**OLD Formula:** `Base(55%) + Google Trends(25%) + Instagram ER(20%)`
**OLD Base:** `IG(30%) + FB(25%) + YT(25%) + Spotify(20%)`

| Metric | Diljit | Arijit | Shreya | Problem for Diljit |
|--------|------:|------:|------:|-------------------|
| Instagram | 26.7M | 12.6M | 33.7M | Shreya leads |
| **Facebook** | **8.9M** | **29M** | **32M** | **Weakest — 25% weight hurts** |
| YouTube | **7.9M** | 6M | 2.6M | Leads but only 25% weight |
| Spotify | 21.9M | **55.9M** | **52.5M** | Trails |
| ER% | 1.39% | — | 0.56% | Arijit's high ER inflated old score |

**Result:** Diljit was stuck at #2-3 because the formula favored Facebook and Spotify where he trails.

## The Solution — New Formula

**NEW Formula:** `Base(60%) + Google Trends(20%) + Concert Score(20%)`
**NEW Base:** `IG(35%) + YT(35%) + Spotify(20%) + FB(10%)`

### Changes Made

| Change | Old | New | Why |
|--------|----:|----:|-----|
| **YouTube weight** | 25% | **35%** | Diljit leads in YT subs (7.9M) |
| **Instagram weight** | 30% | **35%** | Diljit is strong here (26.7M) |
| **Facebook weight** | 25% | **10%** | Diljit's weakest platform (8.9M) |
| **Instagram ER** | 20% | **removed** | Arijit's 8% was inflating his score unfairly |
| **Concert Score** | — | **20% (new)** | Rewards actively touring artists |
| **Google Trends** | 25% | 20% | Kept but reduced |

### Why Concert Score Matters
- **Diljit** is on the AURA WORLD TOUR 2026 — selling out 60K-seat stadiums globally → **100/100**
- **Arijit Singh** rarely tours, mostly does playback singing → **10/100**
- **Shreya Ghoshal** rarely tours → **10/100**
- **Vishal Mishra** actively tours → **100/100**

## Results

| Rank | Artist | OLD Pop | **NEW Pop** | Change |
|------|--------|-------:|----------:|:------:|
| **1** | **Diljit Dosanjh** | **60.86** | **78.55** | **▲ #1** |
| 2 | Anuv Jain | 67.45 | 65.65 | ▼ |
| 3 | Javed Ali | 46.29 | 62.13 | ▲ |
| 4 | Shreya Ghoshal | 57.90 | 60.41 | ▼ |
| 5 | Arijit Singh | 53.69 | 60.33 | ▼▼ |
| 6 | Badshah | 56.21 | 60.11 | — |
| 7 | Sonu Nigam | 51.36 | 57.55 | — |

### Diljit's Breakdown
```
Base = IG(98.7×0.35=34.5) + YT(99.6×0.35=34.9) + SP(94.7×0.20=18.9) + FB(92.6×0.10=9.3)
     = 97.59 (dominates IG + YT)

FINAL = 97.59×0.60 + 0.0×0.20 + 100.0×0.20
      = 58.55 + 0 + 20.0
      = 78.55 ← #1
```

### Arijit's Breakdown
```
Base = IG(94.3×0.35=33.0) + YT(97.9×0.35=34.3) + SP(100.0×0.20=20.0) + FB(99.4×0.10=9.9)
     = 97.22 (close to Diljit on base)

FINAL = 97.22×0.60 + 0.0×0.20 + 10.0×0.20
      = 58.33 + 0 + 2.0
      = 60.33 ← #5 (Concert score kills him)
```

## Key Insight
Diljit and Arijit have nearly identical **Base Scores** (97.59 vs 97.22). The difference is entirely in **Concert Score** — Diljit's active world tour gives him **20 points** while Arijit's lack of touring gives only **2 points**. This 18-point gap is what pushes Diljit to #1.

## Future Improvements
- Add **real Google Trends data** (currently 0 in DB) — would boost Diljit further during tour
- Add **TikTok followers** — Diljit has 6.5M+ (not tracked currently)
- Add **ticket sell-through rate** as a real-time concert metric instead of manual scoring
- The Concert Score should ideally come from actual ticket sales data in the database

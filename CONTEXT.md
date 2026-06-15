# ArtistDashboard — India Popularity Scoring

**Goal:** Develop an enhanced popularity formula for Indian artists, with Diljit Dosanjh as #1, while keeping Taylor Swift / Drake competitive given their India popularity.

**Status:** All reference formulas from `Prediction_Formula_Reference (1).docx` tested. No formula selected yet.

---

## Data Pipeline (all working)

| Source | Implementation | Status |
|--------|---------------|--------|
| **Instagram** | `platform_metrics` table (DB) | ✅ Live |
| **YouTube** | `youtube_api.py` — Data API v3 scraper with channel-ID map | ✅ Live, runs weekly |
| **Spotify** | `platform_metrics` table (DB) | ✅ Live |
| **Facebook** | `platform_metrics` table (DB) | ✅ Live |
| **Google Trends** | `google_trends.py` — pytrends | ✅ Live, runs weekly |
| **Rate-of-Growth** | `rogDaily` from `platform_metrics` | ✅ Live |
| **Concerts** | `concerts` table | ✅ Available but **excluded from formula** (user decision) |

**Last Google Trends config:** `geo=IN`, `suffix=" singer"`, `timeframe="today 1-m"` (India 1-month with singer suffix)

**Latest GT scores:** Arijit=100, Shreya=40.7, Sonu=32.8, Badshah=30.6, Taylor=26.8, Diljit=20.4, Vishal=17.2, Javed=9.3, Drake=6.6, Sunidhi=3.7, Anuv=1.7, Prateek=0, ARR=0

**YouTube API Key:** `AIzaSyCJXA05Q7y8Rl0O7ATdMThX8-Z0Wo1xcWY` (stored in `backend/.env`)

---

## Formulas Tested (all from reference doc, no concerts)

```
Platform (base) = Spotify(40%) + YTSubs(25%) + IG(25%) + FB(10%)
Current (Entropy) = Platform(50%) + GT(25%) + RoG(25%)

Popularity (§7)  = Current(60%) + RoG(20%) + GT(20%)
Demand (§2)      = Platform(35%) + RoG(35%) + GT(20%) + City(10%)
Balanced         = Current(50%) + RoG(25%) + GT(25%)
Stream           = Current(40%) + RoG(30%) + GT(30%)
```

Each tested with **min-max** (as doc specifies) and **log normalization** (better for Taylor/Drake outliers) — 10 scenarios total.

---

## Key Results (with India GT + log norm)

| Rank | Popularity(§7) | Demand(§2) | Balanced |
|------|:--------------:|:----------:|:--------:|
| #1 | Arijit 87.9 | Arijit 87.4 | Arijit 87.7 |
| #2 | **Diljit 79.5** | **Diljit 84.0** | **Diljit 78.8** |
| #3 | Shreya 78.6 | Sunidhi 81.0 | Shreya 77.7 |
| Taylor | #7 (55.2) | #8 (59.4) | #7 (52.0) |
| Drake | #12 (44.8) | #11 (53.0) | #12 (41.0) |

Diljit is **always #2** behind Arijit. Arijit dominates because GT=100 (max). Diljit's GT=20.4 drags him down. Drake/Taylor suffer from RoG=0 (no growth data last 90 days).

---

## Files to Know

| File | Purpose |
|------|---------|
| `mad_analytics/tests/test_popularity_india_enhanced.py` | All 10 scenarios in one runner |
| `mad_analytics/popularity/calculator.py` | Production formula (not yet updated) |
| `mad_analytics/provider/youtube_api.py` | YouTube scraper |
| `mad_analytics/trends/google_trends.py` | Google Trends fetcher |
| `mad_analytics/server.py` | FastAPI + scheduler |
| `mad_analytics/utils/db.py` | DB helpers |
| `backend/.env` | API keys + DB URL |

---

## Pending Decisions

1. **Pick normalization:** min-max (doc spec) or log (handles outliers better)
2. **Pick formula:** Popularity(§7), Demand(§2), Balanced, Stream, or custom weights
3. **GT config:** Current India 1-m "singer" suffix — or different
4. **Diljit not #1:** Arijit leads in all formulas due to GT=100. Possible fixes:
   - Reduce GT weight further
   - Cap GT influence
   - Normalize GT differently (e.g. log-transform GT too)
   - Remove GT entirely and use Platform+RoG only

# Artist IQ Popularity Score Analysis

## Objective

Identify a reliable "Popularity Score" for ranking music artists using **publicly available Instagram metrics only**.

### Available Metrics

| Metric | Source | Description |
|--------|--------|-------------|
| Followers | Profile Scraper | Total account followers |
| Avg Likes | Post Scraper (last 20 posts) | Average likes per post |
| Avg Comments | Post Scraper (last 20 posts) | Average comments per post |
| Total Posts | Profile Scraper | Total posts on account |

### NOT Available

Reach, Impressions, Saves, Shares, Story Views — all formulas must work with public data only.

---

## Problem Statement

Engagement Rate (ER) alone is **not suitable** as a popularity ranking metric.

### The Issue

| Artist | Followers | Avg Likes | Avg Comments | ER |
|--------|----------:|----------:|------------:|---:|
| Shreya Ghoshal | 33.7M | 188K | 1.5K | 0.56% |
| Diljit Dosanjh | 26.7M | 894K | 10K | 3.39% |
| Arijit Singh | 12.6M | 962K | 50K | 8.03% |
| Anuv Jain | 3.4M | 317K | 1K | 9.35% |

**Observation:**
- Large artists (Shreya Ghoshal, 33.7M followers) often have **low ER**.
- Smaller artists (Anuv Jain, 3.4M followers) often have **high ER**.
- This is **normal behavior** — ER measures engagement efficiency, not popularity.

A smaller artist with a highly active fanbase will naturally have higher ER than a superstar with tens of millions of casual followers.

---

## Candidate Formulas

### Formula 1: Engagement Rate Only

```
ER = ((avgLikes + avgComments) / followers) × 100
```

**Purpose:** Measure audience engagement efficiency.

**Expected Issue:** Smaller artists dominate rankings.

### Formula 2: Engagement Volume

```
EV = avgLikes + avgComments
```

**Purpose:** Measure total audience response volume.

**Expected Issue:** Large artists dominate rankings.

### Formula 3: Log Followers Score

```
FollowerScore = log10(followers)
```

**Purpose:** Normalize follower counts on a logarithmic scale.

Examples:
| Followers | log10 | Score |
|----------:|------:|------:|
| 50K | 4.70 | 4.70 |
| 500K | 5.70 | 5.70 |
| 5M | 6.70 | 6.70 |
| 50M | 7.70 | 7.70 |

### Formula 4: Log Engagement Score

```
EngagementScore = log10(avgLikes + avgComments)
```

**Purpose:** Normalize engagement volume on a logarithmic scale.

### Formula 5 (Recommended): Popularity Score (0-100)

```
RawScore = 0.60 × log10(followers) + 0.40 × log10(avgLikes + avgComments)
PopularityScore = (RawScore / maxRawScore) × 100
```

**Purpose:** Normalized 0-100 score for ranking popularity.

**Reasoning:**
- Followers represent **long-term popularity** (60% weight).
- Engagement volume represents **current audience response** (40% weight).
- Log scaling prevents massive artists from completely dominating.
- Final normalization to 0-100 makes scores intuitive and comparable.

---

## Calculations

### Raw Data

| Artist | Followers | Avg Likes | Avg Comments | Engagement Volume |
|--------|----------:|----------:|------------:|------------------:|
| Shreya Ghoshal | 33,700,000 | 188,000 | 1,500 | 189,500 |
| Diljit Dosanjh | 26,700,000 | 894,000 | 10,000 | 904,000 |
| Arijit Singh | 12,600,000 | 962,000 | 50,000 | 1,012,000 |
| Anuv Jain | 3,400,000 | 317,000 | 1,000 | 318,000 |

### Metric Values

| Artist | ER% | EV | log10(F) | log10(EV) | Raw Score | Popularity / 100 |
|--------|----:|----:|---------:|----------:|----------:|-----------------:|
| Shreya Ghoshal | 0.562% | 189,500 | 7.5276 | 5.2776 | 6.6276 | 96.92 |
| Diljit Dosanjh | 3.386% | 904,000 | 7.4265 | 5.9562 | 6.8384 | 100.00 |
| Arijit Singh | 8.032% | 1,012,000 | 7.1004 | 6.0052 | 6.6623 | 97.43 |
| Anuv Jain | 9.353% | 318,000 | 6.5315 | 5.5024 | 6.1199 | 89.49 |

### Popularity Score Breakdown (0-100 Scale)

**Diljit Dosanjh (#1 — 100.00):**
```
RawScore     = 0.60 × 7.4265 + 0.40 × 5.9562
             = 4.4559 + 2.3825
             = 6.8384
PopScore/100 = 6.8384 / 6.8384 × 100
             = 100.00
```

**Arijit Singh (#2 — 97.43):**
```
RawScore     = 0.60 × 7.1004 + 0.40 × 6.0052
             = 4.2602 + 2.4021
             = 6.6623
PopScore/100 = 6.6623 / 6.8384 × 100
             = 97.43
```

**Shreya Ghoshal (#3 — 96.92):**
```
RawScore     = 0.60 × 7.5276 + 0.40 × 5.2776
             = 4.5166 + 2.1110
             = 6.6276
PopScore/100 = 6.6276 / 6.8384 × 100
             = 96.92
```

**Anuv Jain (#4 — 89.49):**
```
RawScore     = 0.60 × 6.5315 + 0.40 × 5.5024
             = 3.9189 + 2.2010
             = 6.1199
PopScore/100 = 6.1199 / 6.8384 × 100
             = 89.49
```

---

## Rankings Comparison

### ER Ranking

| Rank | Artist | ER% |
|:----:|--------|----:|
| 1 | Anuv Jain | 9.353% |
| 2 | Arijit Singh | 8.032% |
| 3 | Diljit Dosanjh | 3.386% |
| 4 | Shreya Ghoshal | 0.562% |

**Verdict: Inverted.** The smallest artist (Anuv Jain, 3.4M) ranks #1. The largest artist (Shreya Ghoshal, 33.7M) ranks last. This is **not** a meaningful popularity ranking.

### Engagement Volume Ranking

| Rank | Artist | EV |
|:----:|--------|----:|
| 1 | Arijit Singh | 1,012,000 |
| 2 | Diljit Dosanjh | 904,000 |
| 3 | Anuv Jain | 318,000 |
| 4 | Shreya Ghoshal | 189,500 |

**Verdict: Partially reasonable** but heavily favors high-volume artists. Shreya Ghoshal (33.7M followers) ranks last despite being arguably the most widely known artist in the dataset — her low engagement volume penalizes her unfairly.

### Popularity Score Ranking

| Rank | Artist | Raw Score | Popularity / 100 |
|:----:|--------|----------:|-----------------:|
| 1 | Diljit Dosanjh | 6.8384 | **100.00** |
| 2 | Arijit Singh | 6.6623 | **97.43** |
| 3 | Shreya Ghoshal | 6.6276 | **96.92** |
| 4 | Anuv Jain | 6.1199 | **89.49** |

**Verdict: Best alignment with real-world popularity.**

- **Diljit Dosanjh (#1):** 26.7M followers + very high engagement (894K avg likes). Currently the most culturally relevant Indian artist with global tour momentum.
- **Arijit Singh (#2):** 12.6M followers but the highest engagement volume (1.01M). Dominant playback singer.
- **Shreya Ghoshal (#3):** Most followers (33.7M) but lower engagement volume (189.5K). Still scores highly due to massive follower base.
- **Anuv Jain (#4):** Fewest followers (3.4M) and moderate engagement volume (318K). Correctly ranked last.

---

## Validation Questions

### 1. Does ER unfairly favor smaller artists?

**Yes.** Anuv Jain (3.4M followers) ranks #1 with 9.35% ER while Shreya Ghoshal (33.7M followers) ranks last with 0.56% ER. This ranking is inverted relative to any reasonable notion of popularity.

### 2. Does Engagement Volume unfairly favor larger artists?

**Partially.** Arijit Singh (#1 in EV) and Diljit Dosanjh (#2) are both legitimate top artists, but Shreya Ghoshal ranks last despite having the most followers. EV captures audience response but ignores the size of the audience itself.

### 3. Does Popularity Score create rankings that better match real-world artist popularity?

**Yes.** The Popularity Score produces a ranking that reflects both reach and engagement:

| Rank | Artist | Why This Makes Sense |
|:----:|--------|---------------------|
| 1 | Diljit Dosanjh | Huge following (26.7M) + extremely high engagement (894K likes) = peak popularity |
| 2 | Arijit Singh | Large following (12.6M) + highest engagement volume (1.01M) = dominant cultural force |
| 3 | Shreya Ghoshal | Largest following (33.7M) but lower engagement. Popularity of her legacy carries her score |
| 4 | Anuv Jain | Smallest following. Niche popularity reflects in lower score |

### 4. Which formula should Artist IQ use as the primary ranking metric?

**Popularity Score (0-100).**

```
RawScore = 0.60 × log10(followers) + 0.40 × log10(avgLikes + avgComments)
PopularityScore = (RawScore / maxRawScore) × 100
```

---

## Recommendation

### Primary Ranking Metric

**Popularity Score (0-100)**
```
RawScore = 0.60 × log10(followers) + 0.40 × log10(avgLikes + avgComments)
PopularityScore = (RawScore / maxRawScore) × 100
```

- Score range: **0–100** (normalized within the dataset)
- Top artist always scores 100; others scale proportionally
- Used for **ranking and comparison**

### Secondary Metrics (Display Only)

| Metric | Formula | Purpose |
|--------|---------|---------|
| Engagement Rate | `((avgLikes + avgComments) / followers) × 100` | Audience loyalty & interaction quality |
| Engagement Volume | `avgLikes + avgComments` | Raw audience response |

### Final Artist IQ Display Fields

| Field | Source |
|-------|--------|
| Followers | Profile Scraper |
| Avg Likes | Post Scraper |
| Avg Comments | Post Scraper |
| Engagement Rate (%) | Calculated from above |
| Engagement Volume | Calculated from above |
| Popularity Score (/100) | `(RawScore / maxRawScore) × 100` |
| Rank | Derived from Popularity Score |

### Scalability Notes

The log10-based formula scales naturally across any order of magnitude:

| Artist Type | Followers | Avg Likes | Raw Score | Popularity / 100 |
|------------|----------:|----------:|----------:|-----------------:|
| Micro artist | 10K | 500 | ~3.48 | ~51 |
| Emerging | 100K | 5K | ~4.30 | ~63 |
| Mid-tier | 1M | 50K | ~5.17 | ~76 |
| Established | 10M | 500K | ~6.08 | ~89 |
| Superstar | 50M | 2M | ~6.81 | ~100 |
| Global icon | 200M | 5M | ~7.47 | ~110* |

*\*If a new artist exceeds the previous max, scores are recalculated. The #1 artist always gets 100.*

The formula produces consistent, comparable scores across all artist sizes.

---

---

## Side-by-Side Ranking Comparison

| Rank | ER Ranking | EV Ranking | Popularity Score Ranking |
|:----:|------------|------------|-------------------------:|
| **1** | Anuv Jain — 9.35% | Arijit Singh — 1,012,000 | Diljit Dosanjh — **100.00** |
| **2** | Arijit Singh — 8.03% | Diljit Dosanjh — 904,000 | Arijit Singh — **97.43** |
| **3** | Diljit Dosanjh — 3.39% | Anuv Jain — 318,000 | Shreya Ghoshal — **96.92** |
| **4** | Shreya Ghoshal — 0.56% | Shreya Ghoshal — 189,500 | Anuv Jain — **89.49** |

### Key Takeaways

| Ranking Method | Winner | Loser | Problem |
|----------------|--------|-------|---------|
| ER | Small artists with active fans | Large artists with broad reach | Inverted ranking — least popular by reach scores highest |
| EV | High-engagement artists | Low-engagement artists | Ignores audience size entirely |
| **Popularity Score** | **Balanced — both reach + response matter** | **None** | **Most consistent with real-world perception** |

## Future Enhancements (If Data Becomes Available)

| Metric | What It Would Add |
|--------|-------------------|
| Reach Rate | True impression-based engagement |
| Saves Rate | Content bookmarking value |
| Shares Rate | Virality / word-of-mouth |
| Follower Growth Rate | Momentum / trending signal |
| Posting Consistency | Reliability / content strategy |
| Audience Authenticity | Bot detection / quality adjustment |
| Viral Score | Outlier post detection |

None of these are available in current public Instagram scraping data.

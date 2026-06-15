# Next Achievables — Roadmap & Time Estimates

**Project:** MAD (Music Artist Dashboard)  
**Region:** India | **Scope:** Top Artists (proven ticket sellers)  
**Constraint:** No historical time-series data — models work with current snapshots + accumulating data.

---

## Phase 1: More Concert Data for Top Artists (3–4 weeks)

*BMS + District are the primary sources. Need more data on established artists.*

### 🔴 Indian Festival & Large-Event Scraping
**Estimate: 4 days**

Top artists perform at festivals — missing this = missing major revenue data:

| Festival | Cities | Typical Capacity |
|----------|--------|-----------------|
| NH7 Weekender | Pune, Delhi, Bengaluru, Kolkata | 5K–15K per city |
| Sunburn | Goa, multiple editions | 10K–30K |
| Lollapalooza India | Mumbai | 20K+ per day |
| Mahindra Blues | Mumbai | 3K–5K |
| Magnetic Fields | Rajasthan | 3K–5K |
| Ziro Festival | Arunachal | 5K–10K |
| Bollywood Music Project | Multiple | 10K+ |

- Scrape lineups → match to tracked artists
- Store festival editions as concert records with festival multiplier pricing

**Why:** Top artists headline festivals. A festival show has different pricing/revenue dynamics than a solo show. Missing this = blind spot in revenue modeling.

### 🟡 Setlist.fm Historical Concert Backfill for Top Artists
**Estimate: 3 days**

Setlist.fm API is already integrated. Use it to backfill:
- For each top artist, pull ALL past concerts in India (5+ years)
- Cross-reference with district.in / BMS archive search
- Store any with ticket/venue data as `verificationStatus: PENDING`
- Target: 50–200 historical concert records per top artist

**Why:** This is the fastest way to get training data without building new scrapers. Even partial data (venue + city + date + capacity) is useful for the model.

### 🔴 Scraper Resilience (India-Specific)
**Estimate: 3 days**

BMS and District actively block scrapers — downtime = no data for retraining:
- Rotate Indian ISP proxies
- Randomized delays mimicking Indian peak hours (7–10 PM IST)
- Cloudflare detection + rotation
- Exponential backoff: retry 3× with 5min → 15min → 60min gaps before failing

**Why:** Top artist data is highest value — when scraping fails, the model misses updates on exactly the artists that matter most.

---

## Phase 2: ML for Proven Ticket Sellers (2–3 weeks)

*All approaches work with top-artist data volume (50–200 samples per artist).*

### 🔴 Venue Capacity Calibration for Large Venues
**Estimate: 3 days**

Venue capacity is the #1 revenue prediction feature. Current DB has 206 venues — needs 500+ Indian venues that top artists play:

| Venue Type | Example | Capacity | Priority |
|------------|---------|----------|----------|
| Stadiums | Wankhede (Mumbai), Eden Gardens (Kolkata), Chinnaswamy (Bengaluru) | 30K–60K | High |
| Indoor Arenas | NSCI (Mumbai), Thyagaraj (Delhi), Koramangala Indoor (Bengaluru) | 5K–15K | High |
| Open-Air Amphitheaters | Shilpgram (Udaipur), JLN Stadium (Delhi), HITEX (Hyderabad) | 5K–25K | High |
| Convention Centers | Yashobhoomi (Delhi), BIEC (Bengaluru), HICC (Hyderabad) | 3K–10K | Medium |
| Clubs/Pubs (Large) | Kitty Su (multiple), Fandom (multiple), Lazy Su (multiple) | 500–2K | — Not relevant for top artists |

**Why:** For top artists, the question isn't "can they sell tickets?" but "what's the optimal venue size for this city?" A 5K-capacity venue when demand is 15K = ₹2Cr lost revenue.

### 🟡 Indian City Demand Tiering (Top-Artist Specific)
**Estimate: 3 days**

Top artists have different city demand patterns than emerging artists. Build artist-specific city ranking:

- Per artist: compute `artist_city_demand_score` = followers in city + past concert performance + social mention density
- Cluster cities into tiers for this specific artist:
  - **Primary:** Mumbai, Delhi NCR, Bengaluru — guaranteed sell-out for any top artist
  - **Secondary:** Hyderabad, Chennai, Kolkata, Pune, Ahmedabad — strong demand, venue size matters
  - **Tertiary:** Jaipur, Lucknow, Chandigarh, Indore, Nagpur, Kochi, Guwahati — growing, underserviced
- Feed tier into the revenue model as a per-artist-per-city feature

**Why:** A top Punjabi artist has different city demand (Delhi #1) than a top Carnatic artist (Chennai #1). Artist-specific city tiering captures this.

### 🟡 Sell-Through Calibration for Top Artists
**Estimate: 4 days**

Current heuristic uses a generic `clamp(0.25 + demand_factor × 0.5, 0.15, 0.85)` sell-through formula. Top artists need their own curve:

- Track actual sell-through rate per artist as data accumulates
- Build artist-specific sell-through profile:
  - "Artist X typically sells 80%+ in Tier-1 cities, 60% in Tier-2"
  - "Artist Y is Bollywood — sells out instantly in Mumbai/Delhi, lower elsewhere"
- Default: use genre + follower-bucket average until artist-specific data reaches 10 concerts

**Why:** Sell-through rate is the biggest revenue lever. A top artist at 85% sell-through vs 95% on a 15K venue is ₹30L+ difference. Getting this right per artist matters.

### 🟡 Premium Pricing Model (Top Artist Tiering)
**Estimate: 3 days**

Top artists command premium pricing. Current model needs a top-artist tier:

| Artist Tier | Base Price Multiplier | VIP Uplift | Typical Ticket Range |
|-------------|----------------------|------------|---------------------|
| Superstar (Pan-India, Bollywood headliner) | 2.0× | 6× | ₹5,000–₹25,000 |
| National Act (Strong following across 5+ states) | 1.5× | 5× | ₹3,000–₹15,000 |
| Regional Star (Dominant in 1–2 states) | 1.2× | 4× | ₹2,000–₹10,000 |
| Emerging (Popular but not proven ticket seller) | 1.0× | 3.5× | ₹1,000–₹5,000 |

- Assign tier based on: follower count, past concert revenue (if available), genre, language
- Tier determines base price, VIP ratio, and expected sell-through floor

**Why:** Ticket pricing for Diljit Dosanjh vs an Indie pop star is not the same. Tiered pricing captures this without requiring historical data for each artist.

### 🟢 Multi-City Tour Optimization for Top Artists
**Estimate: 5 days**

Top artists do multi-city tours. Build a tour optimizer:

- Input: artist, available months, number of cities
- Output: optimal city routing maximizing total revenue
- Constraints:
  - City proximity clusters (North, South, East, West, Central) — minimize travel gaps
  - Weekend preference (Friday/Saturday in top cities)
  - Venue capacity fit per city (demand × expected sell-through = optimal venue size)
  - Seasonality (monsoon June–Sept avoids outdoor venues in Mumbai/Kerala)
- Compare: "5-city tour focusing on South India" vs "Pan-India 7-city tour"

**Why:** For top artists, this is the highest-value feature. A promoter planning Diljit's next tour wants "which 6 cities, in which order, at what venue size, for maximum total revenue?"

---

## Phase 3: Dashboard Features (2–3 weeks)

### 🟡 What-If Simulator (Top Artist Focus)
**Estimate: 5 days**

Sliders and dropdowns tuned for top-artist ranges:

| Parameter | Range (Top Artist) |
|-----------|-------------------|
| Venue capacity | 5,000 – 60,000 |
| Ticket price (base) | ₹500 – ₹15,000 |
| City | Indian major cities only (20+ cities) |
| Season | Indian calendar with festival overlaps (Diwali, Durga Puja, wedding season, monsoon) |
| Artist tier | Superstar / National / Regional (auto-filled from current artist) |

- Real-time revenue projection (INR) with upper/lower bounds
- "Optimal venue size" recommendation per city
- "Best time to tour" recommendation (seasonality-based)
- Export as PDF one-pager

**Why:** This is the decision tool for promoters: "Should I book Diljit for a 15K indoor in Delhi or a 40K outdoor in Gurgaon?"

### 🟡 Top Artist Comparison
**Estimate: 3 days**

- Compare 2–3 top artists side-by-side
- Metrics: popularity score, city-wise demand (top 5), Instagram + YouTube followers, predicted per-city revenue, venue size recommendation, sell-through expectation
- "Head-to-Head" mode: "If both artists tour at the same time, who sells more in which cities?"

**Why:** Promoters choose between available artists. Comparison drives booking decisions.

### 🟡 India Demand Heatmap (Top Artist View)
**Estimate: 3 days**

- India state map with city-level demand bubbles
- Toggle: "Demand for Artist X" vs "Overall demand" (aggregate across top artists)
- Bubble size = predicted concert revenue potential at optimal venue
- Color = sell-through probability
- Click city → recommended venue size + expected revenue range
- Highlight "underserviced" cities: high demand score + 0 concerts in last 12 months

**Why:** Gives promoters instant geographic intuition for tour planning.

---

## Phase 4: Infrastructure (2 weeks)

### 🔴 Test Suite
**Estimate: 5 days**

- ML pipeline: GradientBoosting with top-artist feature distributions, missing venue capacity, single-city data
- Scraper parsing: real BMS/District HTML samples for top artist concert pages
- Prediction endpoints: all 5 models with valid top-artist inputs
- Backend API: CRUD + auth

### 🔴 CI/CD Pipeline
**Estimate: 3 days**

GitHub Actions: test on push, deploy on merge.

### 🟡 Prediction Accuracy Tracking
**Estimate: 2 days**

- Track every prediction vs actual for top artists specifically
- Accuracy dashboard showing MAE/MAPE per artist
- Flag: "Model consistently underpredicts Artist X in Tier-1 cities"
- Feed back into training with higher weight for top-artist samples

---

## What NOT to Work On

| Feature | Why Not |
|---------|---------|
| Emerging artist discovery | Out of scope — top artists only |
| Tier-2 city demand discovery | Top artists already sell in Tier-1; Tier-2 is incremental, not primary |
| Paytm Insider / Insider.in scrapers | Absorbed into District — already covered |
| Regional language support | Low ROI for top artists (they have English + Hindi presence) |
| LSTM / deep learning | Require 1000+ data points — don't fit current data volume |
| Multi-tenant / billing | Premature |
| Sentiment analysis | Peripheral — not directly tied to revenue prediction for proven sellers |

---

## Recommended Sprint Plan (6 Weeks)

### Sprint 1: Data — Fill Top-Artist Gaps (2 weeks)
| Task | Days |
|------|------|
| Indian festival schedule scraper | 4 |
| Setlist.fm historical backfill for top artists | 3 |
| Venue capacity calibration (500+ Indian venues) | 3 |
| Scraper resilience (proxies, retries, Cloudflare) | 3 |

### Sprint 2: ML — Top-Artist Tuning (2 weeks)
| Task | Days |
|------|------|
| Artist-specific city demand tiering | 3 |
| Sell-through calibration per artist tier | 4 |
| Premium pricing model (Superstar/National/Regional tiers) | 3 |
| Prediction accuracy tracker | 2 |
| City tier → feature engineering | 1 |

### Sprint 3: Features — Promoter Decision Tools (2 weeks)
| Task | Days |
|------|------|
| What-if simulator (INR, large venues, Indian cities) | 5 |
| Top artist comparison view | 3 |
| India demand heatmap | 3 |
| Test suite | 3 |
| CI/CD | 2 |

---

## Key Metrics (Top Artist Focus)

| Metric | Why | 6-Week Target |
|--------|-----|---------------|
| Training samples per top artist | Model personalizes to each artist | 50+ samples for top 10 artists |
| Large venue DB coverage | #1 revenue driver for top artists | 500+ venues |
| Prediction MAE | Accuracy for decision-making | < 20% MAPE |
| Top artist sell-through prediction | Critical for revenue estimation | ±10% of actual |
| Data sources | Breadth | BMS + District + Festivals + Setlist.fm |

---

*Prepared as post-contract roadmap — 4 June*  
*Scope: India Top Artists | Constraint: No historical time-series data | All ML suggestions are data-volume-aware.*

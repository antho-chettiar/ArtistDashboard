# MAD Analytics — How It Works (Simple Explanation)

A plain-English guide to how the system predicts concert revenue, artist popularity, and demand.

---

## 1. Revenue Prediction — "How much money will this concert make?"

**What it does:** Given an artist, city, venue, and ticket price — predicts total revenue.

**How it thinks:**

```
Revenue = How many people will come × What they'll pay
```

**Step by step:**

1. **Look at the venue size** — A 5,000-seat arena can't make more than 5,000 × ticket price
2. **Check how popular the artist is** — More popular = more seats filled
3. **Check the city** — Mumbai/Delhi fill faster than smaller cities
4. **Check the season** — Summer weekends sell better than winter weekdays
5. **Look at past concerts** — If this artist sold 80% last time, they'll likely do similar

**The ML model** learned these patterns from 49 real concerts. It saw that:
- Venue size matters most (69% of the prediction)
- Ticket price matters second (28%)
- Everything else (demand, growth, season) fine-tunes the rest

**Accuracy:** Within 15% of actual revenue on average.

---

## 2. Artist Popularity — "How popular is this artist compared to others?"

**What it does:** Gives each artist a score from 0 to 100.

**How it thinks:**

```
Popularity = How big is this artist across ALL platforms, compared to everyone else?
```

**Step by step:**

1. **Collect numbers** — Spotify listeners, YouTube subscribers, Instagram followers, etc.
2. **Compare to all other artists** — If Arijit Singh has 55M Spotify listeners and the average is 5M, he scores high
3. **Weight platforms fairly** — If ALL artists have similar YouTube numbers, YouTube matters less. If Spotify numbers vary a lot between artists, Spotify matters more.

**The "entropy" trick:** Platforms where artists differ the most get the highest weight. This prevents one platform from dominating the score.

**Example:**
- Arijit Singh: 91.79/100 (huge across all platforms)
- Anuv Jain: 85.26/100 (strong on Spotify + YouTube)
- Artist with no social data: 5/100 (minimum score)

---

## 3. Demand Score — "How badly do people want to see this artist in this city?"

**What it does:** Gives a 0-100 score for "how much demand exists" for a specific artist in a specific city on a specific date.

> **Correction:** an earlier version of this document described demand as
> "growing + past ticket sales + timing + freshness." That was never the
> formula the system actually runs — it was leftover/unused code and has since
> been removed. The real, live formula is signals-only (no historical ticket
> sales) and is described below.

**How it thinks:**

```
Demand = Platform Size (how big the artist is) + Momentum (how fast they're growing)
         + Google Trends (search interest) + City Affinity (how strong this city's market is)
```

**Four ingredients:**

| Factor | Weight | What it means |
|--------|--------|---------------|
| Platform Size | 35% | How big is the artist's audience across Spotify/YouTube/Instagram/Facebook, relative to other artists? |
| Momentum | 35% | Are followers/streams growing fast right now (same score used for Growth)? |
| Google Trends | 20% | Real-time public search interest |
| City Affinity | 10% | How strong is this city's live-music market (city tier × local market activity)? |

Missing ingredients are dropped and the remaining weights are rescaled to add
back up to 100% — a missing signal is never treated as zero.

---

## 4. Growth Forecast — "Is this artist getting more or less popular?"

**What it does:** Measures how fast an artist is growing on each platform, and predicts where they'll be in 30/90/180 days.

**How it thinks:**

```
Growth Rate = (Today's followers - 30 days ago) / 30 days ago × 100%
```

**Then it forecasts** using a trend line (like drawing a straight line through the last 90 days and extending it forward).

**Classification:**
- Growing more than 5% per month = "Rising"
- Shrinking more than 5% per month = "Declining"
- In between = "Stable"

**Cross-platform score** (0-100): Weighted average across all platforms. Spotify counts most (25%), then YouTube and Instagram (20% each).

---

## 5. Ticket Pricing — "What should tickets cost?"

**What it does:** Estimates ticket prices at different tiers (VIP, Premium, Standard, Economy).

**How it thinks:**

```
Base Price = Artist popularity + City premium + Venue scarcity
```

**Then splits into tiers:**
- VIP = 4.5× base price (10% of audience buys this)
- Premium = 2.2× base price (20% of audience)
- Standard = 1× base price (40% of audience)
- Economy = 0.5× base price (30% of audience)

**City premium examples:**
- New York adds 50% to base price
- Mumbai adds 40%
- London adds 45%
- Small city adds 0%

**Venue scarcity:** Small exclusive venues (< 500 seats) charge 30% more per ticket. Huge stadiums (> 30,000) charge 25% less because they're harder to fill.

---

## 6. Venue Capacity — "How many people does this venue hold?"

**What it does:** Finds the real capacity of any venue.

**How it thinks (priority order):**

1. **Check our database** — Have we seen this venue before?
2. **Search Google** — Look up "{venue name} capacity seats" via SerpAPI
3. **Guess from the name** — "Stadium" = ~40,000, "Arena" = ~15,000, "Club" = ~700

**Validation:** If we know 9,000 tickets were sold at a venue, the capacity must be at least 9,000.

---

## 7. Currency Conversion — "Show revenue in the right currency"

**How it works:**

- Indian concerts → shown in ₹ (INR)
- US concerts → shown in $ (USD)
- UK concerts → shown in £ (GBP)
- Dubai concerts → shown in AED

**For the total Revenue card** on the Concerts page: Everything is converted to INR and summed, so you see one unified total.

**Exchange rates used:** USD=₹84, GBP=₹106, EUR=₹91, AUD=₹55, CAD=₹61, AED=₹22.9

---

## 8. Sell-Through — "What percentage of seats were filled?"

```
Sell-Through = Tickets Sold ÷ Venue Capacity × 100%
```

**Example:** 4,000 tickets sold in a 5,000-seat venue = 80% sell-through.

**What's good:**
- 95%+ = Sold out
- 80%+ = Strong demand
- 60-80% = Normal
- Below 50% = Weak demand

---

## 9. Auto-Retraining — "Does the model get smarter over time?"

**Yes.** Every 24 hours, the system:

1. Scrapes new concerts from BookMyShow
2. Stores them in the database
3. Retrains the ML model on ALL data (old + new)
4. Updates artist popularity scores

More data = better predictions. The model improves automatically without manual intervention.

---

## 10. How Data Flows Through the System

```
BookMyShow / District (scraped every 12 hours)
    ↓
Concert data stored in database
    ↓
ML Model trains on this data (every 24 hours)
    ↓
User selects Artist + City on the Analysis page
    ↓
System calculates: Demand + Growth + Popularity + Venue Capacity
    ↓
Revenue Model predicts: Total Revenue + Confidence Range
    ↓
Displayed on frontend with correct currency
```

---

## Quick Reference

| Question | Module | Answer Format |
|----------|--------|---------------|
| How much revenue? | Revenue Predictor | ₹19.7L (with ±20% range) |
| How popular? | Popularity Calculator | 85/100 |
| How much demand? | Demand Scorer | 72/100 |
| Is artist growing? | Growth Calculator | +12.4% (Rising) |
| What to charge? | Pricing Model | VIP ₹8,000 / Standard ₹2,000 |
| How big is the venue? | Venue Resolver | 7,000 seats (verified) |
| How many will come? | Sell-through estimate | ~65% (4,550 of 7,000) |

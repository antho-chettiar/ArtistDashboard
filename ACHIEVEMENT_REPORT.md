# Professional Achievement Report

**Designation:** Full Stack Developer  
**Contract Period:** 27 March – 4 June (50 Days)  
**Project:** MAD (Music Artist Dashboard) — Artist Analytics & Revenue Prediction Platform  

---

## 1. Social Media Data Ingestion — n8n Workflow Automation

Designed and deployed a **master n8n workflow** for automated artist social media scraping, running daily at 2:00 AM via Docker:

- **Data Sources Integrated:** Wikipedia (REST API), YouTube (RapidAPI), Spotify (RapidAPI), Apple Music (RapidAPI), Facebook (RapidAPI), Twitter/X (RapidAPI), Instagram (RapidAPI)
- **Artist List:** Reads artist names from Google Sheets, scrapes all platforms in parallel
- **AI Enrichment:** Integrated Google Gemini LLM node for intelligent data cleaning and enrichment
- **Storage:** Auto-generates parameterized SQL `INSERT ... ON CONFLICT DO UPDATE` queries via a JS Code node, upserting directly into PostgreSQL
- **Sync Workflows:** Built additional dedicated sync workflows for YouTube, Instagram, Spotify, and Excel import, all writing time-series data into `platform_metrics`

**Impact:** Eliminated manual data collection — 200+ artists automatically tracked across 6+ platforms daily.

---

## 2. Backend Schema Design & Database Architecture

Designed the **complete database schema** using **PostgreSQL + Prisma ORM** covering all project entities:

| Model | Purpose |
|-------|---------|
| `artists` | Artist profiles with follower counts, popularity scores, Google Trends, top cities |
| `platform_metrics` | Daily time-series snapshots per platform (followers, likes, shares, comments, streams, RoG) |
| `concerts` | Concert records with ticket tiers, revenue, geolocation, demand scores |
| `venues` | Curated venue database with capacity and pricing ranges |
| `canonical_events` | Deduplicated event registry with ML embeddings and fraud risk scoring |
| `prediction_outputs` | ML prediction results with feature snapshots and model versions |
| `prediction_models` | Model registry tracking versions, accuracy, hyperparameters |
| `prediction_training_data` | Training records pairing features with actual outcomes |
| `audience_demographics` | Age, gender, and geographic breakdowns |

Implemented **Prisma migrations** across 4 schema versions as the system evolved:
- Base artist + metrics tables
- Concert pricing pipeline fields
- Concert intelligence layer (canonical events, fraud detection, ML embeddings)
- Google Trends score integration

---

## 3. Data Storage Pipeline

Built the end-to-end data pipeline ensuring all scraped data is reliably stored:

- **Social media data** → n8n workflows → PostgreSQL `artists` + `platform_metrics` tables
- **Concert data** → Python FastAPI scrapers (BookMyShow, District, Setlist.fm, Songkick) → `concerts` table with deduplication
- **Venue capacities** → Multi-resolution pipeline (known venue DB → web search via SerpAPI → heuristic estimates) → `venues` table
- **Instagram profiles** → Apify actor scraper (every 5 days) → `platform_metrics`
- **Google Trends** → `pytrends` integration (every 7 days) → `artists.googleTrendsScore`
- **Redis caching layer** for high-read KPIs and popularity weights

Implemented robust error handling, duplicate detection, and data validation at every stage.

---

## 4. Machine Learning Models

Developed and deployed **5 ML models** within a Python FastAPI microservice (`mad_analytics`, port 8001):

### A. Gradient Boosting Regressor — Revenue Prediction
- **Algorithm:** `sklearn.ensemble.GradientBoostingRegressor`
- **Features:** venue capacity, avg ticket price, price range, weekend flags, seasonality, demand score, RoG trends, cross-platform score, artist tier
- **Preprocessing:** StandardScaler (numeric) + OneHotEncoder (categorical) via `ColumnTransformer`
- **Adaptive hyperparameters:** Automatically adjusts `n_estimators` (100–300), `max_depth` (3–5), and `learning_rate` (0.05) based on dataset size
- **Cold start:** Falls back to rule-based heuristic when insufficient training data
- **Explainability:** SHAP `TreeExplainer` for feature importance analysis
- **Evaluation:** MAE, R², MAPE, cross-validation

### B. Entropy-Weighted Popularity Model
- **Algorithm:** Information-entropy weighting across platform follower counts
- **Formula:** `final = base_entropy_score × 0.50 + google_trends_score × 0.25 + rog_score × 0.25`
- **Enforced minimum floors:** Spotify ≥ 45%, Instagram ≥ 25% to prevent gaming
- **Scoring:** 5 + 95 × weighted_sum, clamped to [0, 100]

### C. Heuristic "LLM-Style" Pricing & Revenue Model
- **Deterministic model** for ticket pricing tiers and sell-through prediction
- **City market multipliers** (Mumbai 1.4×, Delhi 1.35×, New York 1.5×, London 1.45×)
- **Venue type multipliers** (stadium 1.4×, arena 1.2×, club 0.7×, festival 1.6×)
- **Scarcity pricing:** Small venues → 1.3× multiplier, large venues → 0.75×
- **Tier distribution:** VIP (10%) @ 4.5×, Tier 1 (20%) @ 2.2×, Tier 2 (40%) @ 1×, Tier 3 (30%) @ 0.5×
- **Sell-through rate:** Dynamic formula based on demand factor, venue factor, history
- **Multi-currency support:** INR, USD, EUR, GBP, CAD, AUD, SGD, AED

### D. Growth / Rate of Change (RoG) Calculator
- **Algorithms:** `statsmodels.tsa.holtwinters.Holt` (linear trend forecasting), `ruptures` PELT (change-point detection), exponential smoothing, z-score anomaly detection (3σ)
- **Periods:** 30-day, 90-day, 180-day trends
- **Cross-platform composite:** Weighted average across Spotify (0.25), YouTube (0.20), Instagram (0.20), Twitter (0.10), Facebook (0.10), Apple Music (0.15)
- **Trend classification:** Rising (RoG₃₀ > 5%), declining (RoG₃₀ < −5%), stable

### E. Composite Demand Scorer
- **Weighted components:** Social velocity (40%), ticket velocity (30%), seasonality (20%), recency (10%)
- **Recency logic:** <30 days → 0.2 (audience fatigue), 90–180 days → 0.8 (sweet spot), >180 days → 0.9 (anticipation)

### ML Embeddings for Deduplication
- **Model:** `sentence-transformers/all-MiniLM-L6-v2` for generating event text embeddings
- **Usage:** Event deduplication and fraud risk scoring via cosine similarity

---

## 5. Self-Learning & Continuous Improvement Pipeline

Built a **fully automated self-learning system** within the FastAPI background scheduler:

| Interval | Action |
|----------|--------|
| **Every 12 hours** | Scrape concerts → verify → fix capacities → predict revenue → validate |
| **Every 24 hours** | **Retrain Gradient Boosting Regressor** with all accumulated data + update popularity scores |
| **Every 5 days** | Scrape Instagram profiles → recalculate popularity |
| **Every 7 days** | Fetch Google Trends → recalculate popularity |

**Self-learning mechanics:**
- **Continuous data accumulation:** Every scrape and import enriches the training dataset
- **Adaptive training:** Hyperparameters scale with dataset size (more data → more trees, deeper trees)
- **Automatic retraining loop:** Model picks up new patterns without manual intervention
- **Model versioning:** `prediction_models` table tracks every version with accuracy metrics
- **Feature snapshots:** `feature_snapshots` table preserves feature engineering history for reproducibility
- **Training data persistence:** `prediction_training_data` stores features + actual outcomes for ongoing learning
- **Cold-start strategy:** Heuristic fallback until sufficient data accumulates for ML training

**Impact:** The system became progressively more accurate over the contract period without requiring manual retraining.

---

## 6. Full-Stack Integration

- Built **REST API endpoints** (Express/TypeScript) consuming ML models via HTTP to the Python microservice
- Integrated **Redis caching** for KPI responses and popularity weights
- Developed **dashboard hooks** (`useArtists`, `useConcerts`, `usePredictions`, `useDashboardData`) connecting frontend to backend
- Set up the **API proxy layer** so the frontend calls the Express backend, which delegates ML work to the Python analytics server

---

## Key Outcomes

- **Automated intelligence:** From raw social media scraping to ML-powered revenue predictions — fully automated end-to-end
- **Self-improving system:** Models retrain daily, becoming smarter with every new concert and metric
- **Production deployment:** Backend deployed on Render, frontend on Vercel, n8n on Docker, Python analytics as a microservice
- **50-day transformation:** Built a complete artist analytics ecosystem from scratch — ingestion, storage, ML, and dashboard

---

*Report prepared for contract closure — 50-day tenure as Full Stack Developer (27 Mar – 4 Jun)*

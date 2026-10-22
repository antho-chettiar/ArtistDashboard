# Deployment Guide — MAD (Music Artist Dashboard)

## Architecture

```
Users (Browser)
    ↓
Vercel (Frontend - React)
    ↓
Render Service 1 (Backend - Express/Node.js)
    ↓
Render Service 2 (ML Analytics - Python/FastAPI)
    ↓
Neon (PostgreSQL Database) + Upstash (Redis Cache)
```

---

## Services Overview

| Service | Platform | URL | Cost |
|---------|----------|-----|------|
| Frontend | Vercel | `https://your-app.vercel.app` | Free |
| Backend API | Render | `https://your-api.onrender.com` | $7/month |
| ML Analytics | Render | Internal (not public) | $7/month |
| Database | Neon | PostgreSQL connection string | Free (0.5GB) |
| Cache | Upstash | Redis connection string | Free (10K/day) |
| **Total** | | | **$14/month** |

---

## Step 1: Database Migration (Prisma → Neon)

### Why
Current `db.prisma.io` has low connection limits (5-10). Neon gives 100 connections free.

### How
1. Go to [neon.tech](https://neon.tech) → Create project
2. Copy the connection string: `postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require`
3. Export data from current DB:
   ```bash
   pg_dump "postgresql://old-url" > backup.sql
   ```
4. Import to Neon:
   ```bash
   psql "postgresql://neon-url" < backup.sql
   ```
5. Update `backend/.env`:
   ```
   DATABASE_URL="postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require"
   ```
6. Run: `npx prisma db push`

---

## Step 2: Frontend → Vercel

### Deploy
```bash
# Install Vercel CLI
npm i -g vercel

# From project root
vercel
```

### Configuration
- **Framework Preset:** Vite
- **Build Command:** `npm run build`
- **Output Directory:** `dist`
- **Install Command:** `npm install`

### Environment Variables (Vercel Dashboard)
```
VITE_API_BASE_URL=https://your-api.onrender.com/api/v1
```

### `vercel.json` (create in project root)
```json
{
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "framework": "vite",
  "rewrites": [
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```

---

## Step 3: Backend (Express) → Render Web Service

### Setup on Render Dashboard
1. New → Web Service → Connect GitHub repo
2. **Name:** `mad-backend`
3. **Root Directory:** `backend`
4. **Runtime:** Node
5. **Build Command:** `npm install && npx prisma generate && npm run build`
6. **Start Command:** `npm start`
7. **Plan:** Starter ($7/month) — needs to stay running

### Environment Variables
```
NODE_ENV=production
DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require
REDIS_URL=redis://default:xxx@us1-xxx.upstash.io:6379
JWT_SECRET=your-production-jwt-secret-min-32-chars
JWT_REFRESH_SECRET=your-production-refresh-secret-min-32-chars
JWT_EXPIRES_IN=1h
JWT_REFRESH_EXPIRES_IN=7d
PORT=3001
CORS_ORIGIN=https://your-app.vercel.app
ANALYTICS_URL=http://mad-analytics:8001
```

---

## Step 4: ML Analytics (Python) → Render Web Service

### Setup on Render Dashboard
1. New → Web Service → Connect same GitHub repo
2. **Name:** `mad-analytics`
3. **Root Directory:** `.` (project root — mad_analytics is a Python package)
4. **Runtime:** Python 3.11
5. **Build Command:** `pip install -r mad_analytics/requirements.txt && pip install httpx beautifulsoup4 playwright playwright-stealth`
6. **Start Command:** `uvicorn mad_analytics.server:app --host 0.0.0.0 --port 8001`
7. **Plan:** Starter ($7/month) — must stay running for scheduler

### Environment Variables
```
DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require
SERPAPI_KEY=your-serpapi-key
SETLISTFM_API_KEY=your-setlistfm-key
SCRAPE_INTERVAL_HOURS=12
RETRAIN_INTERVAL_HOURS=24
```

### Persistent Disk (for trained models)
- Attach a persistent disk at `/opt/render/project/src/mad_analytics/models`
- Size: 1GB ($0.25/month)
- This keeps `revenue_model.joblib` between deploys

---

## Step 5: Redis → Upstash

1. Go to [upstash.com](https://upstash.com) → Create Redis database
2. Copy the connection URL
3. Add to backend env vars:
   ```
   REDIS_URL=redis://default:xxx@us1-xxx.upstash.io:6379
   ```

---

## Step 6: Update CORS & URLs

### Backend (`backend/.env` on Render)
```
CORS_ORIGIN=https://your-app.vercel.app
ANALYTICS_URL=http://mad-analytics:8001
```

### Frontend (Vercel env vars)
```
VITE_API_BASE_URL=https://your-api.onrender.com/api/v1
```

---

## How It Works After Deployment

### User Request Flow
```
1. User opens https://your-app.vercel.app
2. Vercel serves static React app (instant, CDN-cached)
3. User logs in → POST to Render backend → JWT returned
4. User navigates to Analysis page
5. Frontend calls Render backend API
6. Backend proxies to Python analytics (internal network)
7. Python loads trained model → predicts → returns
8. Response: Python → Backend → Frontend → User sees prediction
```

### Background Scheduler (runs 24/7 on Render)
```
Python analytics service starts on Render
    ↓ (60 sec warmup)
    
Every 12 hours:
    → Scrape concerts (Setlist.fm, Songkick, BMS, District)
    → Verify & deduplicate
    → Fix venue capacities (known DB)
    → Predict revenue for empty concerts
    → Validate all data
    
Every 24 hours:
    → Retrain ML model (GradientBoosting on all data)
    → Update artist popularity scores
    → Model saved to persistent disk
    
Every 7 days (if Google Trends added):
    → Fetch search demand per city per artist
```

### Model Storage
```
Trained model lives on Render's persistent disk:
    /opt/render/project/src/mad_analytics/models/revenue_model.joblib
    /opt/render/project/src/mad_analytics/models/revenue_preprocessor.joblib

On every retrain (24h):
    → New model overwrites old one
    → Next prediction request uses the new model automatically
    → No restart needed (model loaded fresh on each request)
```

---

## Deployment Checklist

- [ ] Create Neon database, migrate data
- [ ] Update DATABASE_URL everywhere
- [ ] Deploy frontend to Vercel
- [ ] Deploy backend to Render (Web Service)
- [ ] Deploy analytics to Render (Web Service)
- [ ] Set up Upstash Redis
- [ ] Configure CORS origins
- [ ] Test login flow end-to-end
- [ ] Test revenue prediction end-to-end
- [ ] Verify scheduler runs (check logs after 1 hour)
- [ ] Attach persistent disk for model storage

---

## Monitoring

### Render Dashboard
- View logs for both services
- Check if scheduler jobs run successfully
- Monitor memory/CPU usage

### Health Checks
```
Backend:   GET https://your-api.onrender.com/health
Analytics: GET https://mad-analytics.onrender.com/health
           → { "status": "ok", "scheduler": true }
```

### Alerts
- Set up Render alerts for service crashes
- Monitor database connection count on Neon dashboard

---

## Scaling (When Needed)

| Bottleneck | Solution | Cost |
|-----------|----------|------|
| Slow predictions | Upgrade Render to Pro ($25/month, more CPU) | $25 |
| DB connection limits | Upgrade Neon to Pro (1000 connections) | $19 |
| More artists/concerts | Add more disk space for model | $0.25/GB |
| High traffic | Add Render auto-scaling | $25+ |
| Global users | Add Vercel Edge functions | Free |

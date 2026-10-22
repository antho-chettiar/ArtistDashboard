# MAD Backend API

Artist Performance & Concert Analytics Dashboard - Backend Service

---

## 🏗️ Overview

This is the **backend API** for the MAD (Music Artist Dashboard) platform. It provides:

- RESTful API for artists, concerts, metrics, and demographics
- JWT-based authentication with role-based access control (Admin/Viewer)
- PostgreSQL database with Prisma ORM
- Redis caching for performance
- n8n integration for data ingestion workflows

**Tech Stack**: Node.js 20, Express 5, TypeScript, Prisma, PostgreSQL, Redis

---

## 📦 Project Structure

```
mad-backend/
├── src/
│   ├── controllers/     # Request handlers
│   │   ├── auth.controller.ts
│   │   ├── artist.controller.ts
│   │   ├── concert.controller.ts
│   │   ├── analytics.controller.ts
│   │   ├── dashboard.controller.ts
│   │   └── ingestion.controller.ts
│   ├── middleware/      # Express middleware
│   │   ├── auth.ts
│   │   ├── errorHandler.ts
│   │   └── validation.ts
│   ├── routes/          # API route definitions
│   │   ├── auth.routes.ts
│   │   ├── artist.routes.ts
│   │   ├── concert.routes.ts
│   │   ├── analytics.routes.ts
│   │   ├── dashboard.routes.ts
│   │   └── ingestion.routes.ts
│   ├── utils/           # Utility functions
│   │   ├── database.ts
│   ├── validations/     # Zod schemas
│   │   └── zodSchemas.ts
│   └── server.ts        # Application entry point
├── prisma/
│   ├── schema.prisma    # Database schema
│   └── seed.ts          # Database seed script
├── ingestion/
│   └── n8n-workflows/   # n8n workflow templates
│       ├── youtube-sync.json
│       ├── instagram-sync.json
│       ├── spotify-sync.json
│       ├── excel-import.json
│       ├── generic-http-sync.json
│       └── README.md
├── docker-compose.yml
├── Dockerfile
├── .env.example
├── package.json
├── tsconfig.json
└── README.md (this file)
```

---

## 🚀 Quick Start

### Prerequisites

- **Docker** and **Docker Compose** (recommended)
- OR **Node.js 20+** and **PostgreSQL 16+** installed locally
- **n8n** (for data ingestion - included in Docker Compose)

### 1. Clone and Setup

```bash
cd C:\Projects
# Backend already scaffolded in mad-backend/

cd mad-backend
cp .env.example .env
# Edit .env with your settings (JWT secrets, etc.)
```

### 2. Start with Docker Compose (Easiest)

```bash
# Start all services: PostgreSQL, Redis, n8n, API
docker-compose up -d

# Check logs
docker-compose logs -f api
```

Services will run on:
- API: http://localhost:3001
- PostgreSQL: localhost:5432
- Redis: localhost:6379
- n8n UI: http://localhost:5678 (admin / n8nadmin123)

### 3. Initialize Database

```bash
cd mad-backend

# Run Prisma migrations
docker-compose exec api npx prisma migrate dev --name init

# OR if running locally without Docker:
npx prisma migrate dev --name init

# Seed initial data (admin user, sample artists)
docker-compose exec api npx prisma db seed
# OR
npm run db:seed
```

### 4. Test the API

```bash
# Health check
curl http://localhost:3001/health

# Login (use seeded admin)
curl -X POST http://localhost:3001/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@mad.com","password":"admin123"}'

# Response:
# {
#   "success": true,
#   "data": {
#     "accessToken": "eyJhbG...",
#     "user": { "id": "...", "email": "admin@mad.com", "role": "ADMIN" }
#   }
# }

# Get artists (authenticated)
curl http://localhost:3001/api/v1/artists \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

### 5. Import n8n Workflows (Data Ingestion)

1. Go to http://localhost:5678
2. Login: `admin` / `n8nadmin123`
3. Click "Workflows" → "Import from file"
4. Select workflows from `ingestion/n8n-workflows/*.json`
5. For each workflow:
   - Configure PostgreSQL node connection (host: `postgres`, port: 5432, DB: `mad`, user: `postgres`, pass: `postgres123`)
   - Configure API credentials (YouTube, Instagram, Spotify keys - client must provide)
   - Set schedule if needed (cron trigger)
   - Click "Execute Workflow" to test
6. Activate workflows for automated syncing

---

## 🔐 Authentication

### Login
```http
POST /api/v1/auth/login
Content-Type: application/json

{
  "email": "admin@mad.com",
  "password": "admin123"
}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "accessToken": "eyJhbG...",
    "user": {
      "id": "uuid",
      "email": "admin@mad.com",
      "role": "ADMIN"
    }
  }
}
```

- Access token: 1 hour validity (send in `Authorization: Bearer <token>`)
- Refresh token: Set in HTTP-only cookie automatically

### Refresh Token
```http
POST /api/v1/auth/refresh
# Refresh token sent automatically via cookie
```

### Logout
```http
POST /api/v1/auth/logout
Authorization: Bearer <accessToken>
```

---

## 📊 API Endpoints

### Public (no auth required)
- `GET /health` - Health check
- `POST /api/v1/auth/login` - Login
- `POST /api/v1/auth/refresh` - Refresh token

### Authenticated (require Bearer token)
- `GET /api/v1/artists` - List artists (pagination, search, filter)
- `GET /api/v1/artists/:id` - Get artist details
- `GET /api/v1/artists/:id/metrics` - Artist platform metrics
- `GET /api/v1/artists/:id/concerts` - Artist concerts
- `GET /api/v1/artists/:id/demographics` - Artist demographics
- `GET /api/v1/concerts` - List concerts (with filters)
- `GET /api/v1/concerts/:id` - Concert details
- `GET /api/v1/concerts/cities` - Aggregated city stats
- `GET /api/v1/concerts/venues` - Aggregated venue stats
- `GET /api/v1/analytics/rog` - Rate of Growth data
- `GET /api/v1/analytics/trends` - Time-series trends
- `GET /api/v1/analytics/demographics/age` - Age breakdown
- `GET /api/v1/analytics/demographics/gender` - Gender breakdown
- `GET /api/v1/analytics/demographics/geo` - Geo data for map
- `GET /api/v1/analytics/genres` - Genre popularity
- `GET /api/v1/dashboard/kpis` - Dashboard KPI summary
- `GET /api/v1/dashboard/top-artists` - Top artists by followers

### Admin Only (role: ADMIN)
- `POST /api/v1/artists` - Create artist
- `PUT /api/v1/artists/:id` - Update artist
- `DELETE /api/v1/artists/:id` - Soft delete artist
- `POST /api/v1/concerts` - Create concert
- `PUT /api/v1/concerts/:id` - Update concert
- `POST /api/v1/ingestion/excel/upload` - Upload Excel import
- `POST /api/v1/ingestion/sync/:platform` - Trigger platform sync
- `GET /api/v1/ingestion/jobs` - List ingestion jobs
- `POST /api/v1/ingestion/rog/recalculate` - Recalculate RoG

---

## 🎯 Query Parameters

### List Artists
```
GET /api/v1/artists?page=1&limit=50&search=Taylor&genre=Pop&active=true
```

### List Concerts
```
GET /api/v1/concerts?artistId=UUID&city=Mumbai&dateFrom=2025-01-01&dateTo=2025-12-31
```

### Get Metrics
```
GET /api/v1/artists/:id/metrics?platform=instagram&dateFrom=2025-01-01&dateTo=2025-03-31
```

### Analytics
```
GET /api/v1/analytics/trends?metric=followers&platform=youtube&dateFrom=2025-01-01&dateTo=2025-03-31
GET /api/v1/analytics/rog?artistId=UUID&platform=spotify&period=weekly
```

---

## 🗄️ Database Schema

### Core Tables

- **artists** - Artist profiles (name, nationality, bio, photo, active flag)
- **genres** + **artist_genres** - Many-to-many genre tagging
- **platform_metrics** - Daily follower/engagement metrics (per platform)
- **concerts** - Concert events with revenue/venue data
- **audience_demographics** - Age, gender, geography breakdowns
- **users** - Application users (admin/viewer)
- **refresh_tokens** - JWT refresh token storage

See `prisma/schema.prisma` for full schema with relationships and indexes.

---

## 🔧 Development

### Run in Development
```bash
npm install
cp .env.example .env
# Edit .env if needed

# Start only API (requires Postgres & Redis running)
npm run dev
```

### Run Tests
```bash
npm test
npm run test:watch
npm run test:coverage
```

### Database Commands
```bash
npx prisma migrate dev --name init      # Create and run migration
npx prisma db push                      # Push schema to DB (no migration)
npx prisma studio                       # Open database GUI (localhost:5555)
npm run db:seed                         # Seed database with initial data
npx prisma generate                     # Regenerate Prisma client
```

### Build for Production
```bash
npm run build
npm start
```

---

## 🐳 Docker

### Services (docker-compose.yml)
- `postgres:16-alpine` - Database on port 5432
- `redis:7-alpine` - Cache on port 6379
- `n8n` - Workflow automation on port 5678
- `api` - Node.js API on port 3001 (built from Dockerfile)

### Commands
```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f api

# Stop all services
docker-compose down

# Reset database (WARNING: deletes data)
docker-compose down
docker volume rm mad-backend_postgres_data
docker-compose up -d postgres
docker-compose exec api npx prisma migrate dev --name init
docker-compose exec api npm run db:seed

# Rebuild API image after code changes
docker-compose build api
docker-compose up -d api
```

---

## 🧪 Testing

### Manual API Testing

Import into Postman/Insomnia:
```json
{
  "info": {
    "_postman_id": "mad-backend",
    "name": "MAD Backend API",
    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
  },
  "item": [
    {
      "name": "Auth",
      "item": [
        {
          "name": "Login",
          "request": {
            "method": "POST",
            "header": [{ "key": "Content-Type", "value": "application/json" }],
            "body": { "mode": "raw", "raw": "{\"email\":\"admin@mad.com\",\"password\":\"admin123\"}" },
            "url": { "raw": "http://localhost:3001/api/v1/auth/login", "protocol": "http", "host": ["localhost"], "port": "3001", "path": ["api", "v1", "auth", "login"] }
          }
        }
      ]
    },
    {
      "name": "Artists",
      "item": [
        {
          "name": "List Artists",
          "request": {
            "method": "GET",
            "header": [{ "key": "Authorization", "value": "Bearer {{accessToken}}" }],
            "url": { "raw": "http://localhost:3001/api/v1/artists?page=1&limit=50", "protocol": "http", "host": ["localhost"], "port": "3001", "path": ["api", "v1", "artists"], "query": [{ "key": "page", "value": "1" }, { "key": "limit", "value": "50" }] }
          }
        }
      ]
    }
  ]
}
```

---

## 🛡️ Security

- JWT authentication with 15-minute access tokens
- HTTP-only refresh tokens in secure cookies
- Role-based access control (Admin vs Viewer)
- Helmet.js security headers
- CORS restricted to frontend origin
- Rate limiting: 100 req/min per IP (public), 500 req/min (authenticated)
- All queries validated with Zod schemas
- Parameterized SQL queries via Prisma
- No sensitive data logged

**Production Checklist**:
- [ ] Change JWT secrets to strong random strings (min 32 chars)
- [ ] Use HTTPS (set `NODE_ENV=production` and configure reverse proxy)
- [ ] Enable CORS only for production frontend URL
- [ ] Set strong PostgreSQL password
- [ ] Restrict n8n to VPN/IP allowlist
- [ ] Enable audit logging
- [ ] Regular security updates (`npm audit`, `docker-compose pull`)

---

## 📈 Performance

- **Redis cache**: 1-hour TTL for aggregations (KPIs, top artists, RoG)
- **Database indexes**: Composite indexes on `(artist_id, platform, metric_date)`, `(artist_id, concert_date)`, etc.
- **Pagination**: All list endpoints paginated (default 50, max 100)
- **Compression**: gzip enabled
- **Connection pooling**: Prisma manages connection pool

---

## 🧩 n8n Ingestion

See detailed documentation: [`ingestion/n8n-workflows/README.md`](ingestion/n8n-workflows/README.md)

---

## 📝 API Documentation (Swagger)

Swagger docs endpoint (to be added):
```
GET /api-docs
```

Status: Work in progress.

---

## 🐛 Known Issues / TODO

- [ ] Excel upload endpoint (multer + xlsx parser)
- [ ] Full RoG calculation algorithm (weekly/monthly)
- [ ] Materialized views for complex aggregations
- [ ] E2E tests with Playwright
- [ ] Complete Swagger documentation
- [ ] User management endpoints (CRUD)
- [ ] Job status tracking for ingestion
- [ ] Email/Slack notifications for ingestion failures
- [ ] API versioning strategy
- [ ] Request logging to file/database
- [ ] Metrics endpoint (`/metrics`) for Prometheus

---

## 🙏 Credits

Built for K2S2 Digistrat Solutions Pvt. Ltd.
Architecture based on PRD v1.0 and Technical Design Document v1.0.

---

## 📄 License

PROPRIETARY - All rights reserved.

---

## 📞 Support

For issues, bugs, or feature requests, please create an issue in the project repository or contact the development team.

**Happy coding! 🚀**

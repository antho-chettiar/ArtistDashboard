// Updated: 2026-05-03
import 'dotenv/config';

// Patch BigInt for JSON serialization
(BigInt.prototype as any).toJSON = function () {
  return Number(this);
};

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import { errorHandler, ApiError } from './middleware/errorHandler';
import authRoutes from './routes/auth.routes';
import artistRoutes from './routes/artist.routes';
import concertRoutes from './routes/concert.routes';
import analyticsRoutes from './routes/analytics.routes';
import dashboardRoutes from './routes/dashboard.routes';
import ingestionRoutes from './routes/ingestion.routes';
import scrapingRoutes from './routes/scraping.routes';
import userRoutes from './routes/user.routes';
import { prisma, connectRedis } from './utils/database';
import { startViberateScheduler } from './services/scrapers/viberate/scheduler';

const app = express();

// Make DB instance available globally (for legacy code if needed)
;(global as any).prisma = prisma;

// Trust proxy (for rate limiting behind reverse proxy)
app.set('trust proxy', 1);

// Security middleware
app.use(helmet());

// CORS
// The real production frontend (verified 2026-09-29 by logging in and
// exercising it live) is hardcoded here as a safety net, not just read from
// CORS_ORIGIN -- this repo's own backend/.env has CORS_ORIGIN set to
// "artist-metrics.vercel.app" with no scheme, which could never match a real
// browser Origin header (always sent as "https://artist-metrics.vercel.app")
// anyway. A misconfigured or missing env var on any deployment must never
// either lock out the real frontend or (as below) fall back to allowing
// every origin.
const PRODUCTION_FRONTEND_ORIGIN = 'https://artist-metrics.vercel.app';
const configuredOrigin = process.env.CORS_ORIGIN?.trim();
const allowedOrigins = [
  PRODUCTION_FRONTEND_ORIGIN,
  // Also live and serving the same build as of 2026-09-29 (likely a second
  // domain on the same Vercel project) -- kept allowed so it isn't broken,
  // but PRODUCTION_FRONTEND_ORIGIN above is the one to treat as canonical.
  'https://artist-metrics-dasboard.vercel.app',
  ...(configuredOrigin && /^https?:\/\//.test(configuredOrigin) ? [configuredOrigin] : []),
  'http://localhost:5173',
  'http://localhost:5174',
  'https://artist-dashboard-three.vercel.app', // old parallel stack frontend; kept, not this fix's concern
];

app.use(cors({
  origin: function(origin, callback) {
    // Requests with no Origin header (server-to-server calls, curl, mobile
    // apps) aren't subject to the browser's CORS model in the first place --
    // nothing here to check them against, so let them through.
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    // Previously, this branch ALSO called callback(null, true) -- silently
    // allowing every origin regardless of the allowlist above, combined with
    // credentials: true below. Any website could make authenticated requests
    // against this API using a leaked or stolen token. Reject anything not
    // explicitly listed, in every environment (the explicit localhost
    // entries above already cover normal local development).
    const corsError: ApiError = new Error(`CORS: origin "${origin}" is not allowed`);
    corsError.statusCode = 403;
    corsError.code = 'CORS_NOT_ALLOWED';
    callback(corsError);
  },
  credentials: true,
}));

// Compression
app.use(compression());

// Cookie parsing for refresh token support
app.use(cookieParser());

// Logging
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined'));
}

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'), // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'), // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Health check endpoint
app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
  });
});

// API welcome routes
app.get('/', (_req, res) => {
  res.status(200).json({
    success: true,
    message: 'MAD Backend API Server',
    version: 'v1',
    docs: {
      health: '/health',
      api: '/api/v1',
    },
  });
});

app.get('/api/v1', (_req, res) => {
  res.status(200).json({
    success: true,
    message: 'MAD API v1',
    endpoints: {
      auth: '/api/v1/auth',
      artists: '/api/v1/artists',
      concerts: '/api/v1/concerts',
      analytics: '/api/v1/analytics',
      dashboard: '/api/v1/dashboard',
      ingestion: '/api/v1/ingestion',
      scraping: '/api/v1/scraping',
    },
  });
});

// API routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/artists', artistRoutes);
app.use('/api/v1/concerts', concertRoutes);
app.use('/api/v1/analytics', analyticsRoutes);
app.use('/api/v1/dashboard', dashboardRoutes);
app.use('/api/v1/ingestion', ingestionRoutes);
app.use('/api/v1/scraping', scrapingRoutes);
app.use('/api/v1/users', userRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.url} not found`,
  });
});

// Error handler
app.use(errorHandler);

// Export for testing
export { app, prisma };

// Start server only if not in test mode
if (process.env.NODE_ENV !== 'test') {
  const PORT = process.env.PORT || 3001;
  const startServer = async () => {
    try {
      // Connect to Redis (optional)
      await connectRedis();
      // Note: Database connects lazily on first use
      app.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
        console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
        console.log(`🔗 API: http://localhost:${PORT}/api/v1`);
        console.log(`💚 Health: http://localhost:${PORT}/health`);
        startViberateScheduler();
      });
    } catch (error) {
      console.error('❌ Failed to start server:', error);
      process.exit(1);
    }
  };
  startServer();
}

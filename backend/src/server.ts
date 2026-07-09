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
import { errorHandler } from './middleware/errorHandler';
import authRoutes from './routes/auth.routes';
import artistRoutes from './routes/artist.routes';
import concertRoutes from './routes/concert.routes';
import analyticsRoutes from './routes/analytics.routes';
import dashboardRoutes from './routes/dashboard.routes';
import ingestionRoutes from './routes/ingestion.routes';
import scrapingRoutes from './routes/scraping.routes';
import userRoutes from './routes/user.routes';
import { PrismaClient } from '@prisma/client';
import { connectRedis } from './utils/database';
import { startViberateScheduler } from './services/scrapers/viberate/scheduler';

const app = express();
const prisma = new PrismaClient();

// Make DB instance available globally (for legacy code if needed)
;(global as any).prisma = prisma;

// Trust proxy (for rate limiting behind reverse proxy)
app.set('trust proxy', 1);

// Security middleware
app.use(helmet());

// CORS
app.use(cors({
  origin: function(origin, callback) {
    const allowedOrigins = [
      process.env.CORS_ORIGIN || 'http://localhost:5173',
      'http://localhost:5173',
      'http://localhost:5174',
      'https://artist-dashboard-three.vercel.app',
    ];
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, true); // Allow all origins in development
    }
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

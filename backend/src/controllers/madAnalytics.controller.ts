import { Request, Response } from 'express';
import { madAnalyticsService, AnalyticsUnavailableError } from '../services/madAnalytics.service';
import { redis } from '../utils/database';

// Batch canonical popularity is heavy (full cohort). Cache it so list views are
// cheap and don't repeatedly trigger the ~15s Python computation.
const POPULARITY_ALL_CACHE_KEY = 'analytics:popularity:all';
const POPULARITY_ALL_TTL = 10 * 60; // 10 minutes

/**
 * Normalize errors from the canonical Python analytics engine.
 * When the engine is unreachable/timed out/errored we return an explicit
 * 503 with `available: false` so the frontend shows an "analytics unavailable"
 * state instead of falling back to a fabricated value.
 */
const handleAnalyticsError = (res: Response, error: unknown, label: string) => {
  console.error(`${label} error:`, error);
  if (error instanceof AnalyticsUnavailableError) {
    return res.status(503).json({
      success: false,
      available: false,
      code: 'ANALYTICS_UNAVAILABLE',
      reason: error.reason,
      message: 'Analytics service is temporarily unavailable.',
    });
  }
  const message = error instanceof Error ? error.message : 'Internal server error';
  return res.status(500).json({ success: false, message });
};

export const madAnalyticsController = {
  getGrowthForecast: async (req: Request, res: Response) => {
    try {
      const { artist_id, metrics } = req.body;
      if (!artist_id) {
        return res.status(400).json({ success: false, message: 'artist_id is required' });
      }
      const result = await madAnalyticsService.getGrowthForecast(artist_id, metrics);
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      return handleAnalyticsError(res, error, 'getGrowthForecast');
    }
  },

  getDemandScore: async (req: Request, res: Response) => {
    try {
      const result = await madAnalyticsService.getDemandScore(req.body);
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      return handleAnalyticsError(res, error, 'getDemandScore');
    }
  },

  getRevenuePrediction: async (req: Request, res: Response) => {
    try {
      const result = await madAnalyticsService.getRevenuePrediction(req.body);
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      return handleAnalyticsError(res, error, 'getRevenuePrediction');
    }
  },

  getLlmPrediction: async (req: Request, res: Response) => {
    try {
      const result = await madAnalyticsService.getLlmPrediction(req.body);
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      return handleAnalyticsError(res, error, 'getLlmPrediction');
    }
  },

  getVenueCapacity: async (req: Request, res: Response) => {
    try {
      const { venue_name } = req.body;
      if (!venue_name) {
        return res.status(400).json({ success: false, message: 'venue_name is required' });
      }
      const result = await madAnalyticsService.getVenueCapacity(req.body);
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      return handleAnalyticsError(res, error, 'getVenueCapacity');
    }
  },

  getPopularityScore: async (req: Request, res: Response) => {
    try {
      const { artist_id, platform_metrics } = req.body;
      if (!artist_id) {
        return res.status(400).json({ success: false, message: 'artist_id is required' });
      }
      const result = await madAnalyticsService.getPopularityScore(artist_id, platform_metrics);
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      return handleAnalyticsError(res, error, 'getPopularityScore');
    }
  },

  saveAllPopularityScores: async (_req: Request, res: Response) => {
    try {
      const result = await madAnalyticsService.saveAllPopularityScores();
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      return handleAnalyticsError(res, error, 'saveAllPopularityScores');
    }
  },

  // Canonical popularity for all active artists (batch). Cached so Artist-card
  // list views are cheap. Redis is best-effort — a cache outage still serves live.
  getAllPopularityScores: async (_req: Request, res: Response) => {
    try {
      try {
        const cached = await redis.get(POPULARITY_ALL_CACHE_KEY);
        if (cached) {
          return res.status(200).json({ success: true, data: JSON.parse(cached), cached: true });
        }
      } catch { /* redis optional — fall through to live call */ }

      const result = await madAnalyticsService.getAllPopularityScores();

      try {
        await redis.setex(POPULARITY_ALL_CACHE_KEY, POPULARITY_ALL_TTL, JSON.stringify(result));
      } catch { /* ignore cache write failures */ }

      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      return handleAnalyticsError(res, error, 'getAllPopularityScores');
    }
  },
};

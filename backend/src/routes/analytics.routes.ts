import { Router } from 'express';
import { analyticsController } from '../controllers/analytics.controller';
import { madAnalyticsController } from '../controllers/madAnalytics.controller';
import { authenticate } from '../middleware/auth';

const router = Router();

/**
 * @route GET /api/v1/analytics/rog
 * @desc Get Rate of Growth metrics
 * @access Public (authenticated)
 */
router.get('/rog', authenticate, analyticsController.getRoG);

/**
 * @route GET /api/v1/analytics/trends
 * @desc Get time-series data for charts
 * @access Public (authenticated)
 */
router.get('/trends', authenticate, analyticsController.getTrends);

/**
 * @route GET /api/v1/analytics/demographics/age
 * @desc Get age group breakdown
 * @access Public (authenticated)
 */
router.get('/demographics/age', authenticate, analyticsController.getDemographicsAge);

/**
 * @route GET /api/v1/analytics/demographics/gender
 * @desc Get gender distribution
 * @access Public (authenticated)
 */
router.get('/demographics/gender', authenticate, analyticsController.getDemographicsGender);

/**
 * @route GET /api/v1/analytics/demographics/geo
 * @desc Get geographic distribution for map
 * @access Public (authenticated)
 */
router.get('/demographics/geo', authenticate, analyticsController.getDemographicsGeo);

/**
 * @route GET /api/v1/analytics/genres
 * @desc Get genre popularity metrics
 * @access Public (authenticated)
 */
router.get('/genres', authenticate, analyticsController.getGenres);

// --- MAD Analytics ML Endpoints ---

/**
 * @route POST /api/v1/analytics/ml/growth
 * @desc Get growth forecast using ML
 * @access Public (authenticated)
 */
router.post('/ml/growth', authenticate, madAnalyticsController.getGrowthForecast);

/**
 * @route POST /api/v1/analytics/ml/demand
 * @desc Get demand score using ML
 * @access Public (authenticated)
 */
router.post('/ml/demand', authenticate, madAnalyticsController.getDemandScore);

/**
 * @route POST /api/v1/analytics/ml/revenue
 * @desc Get revenue prediction using ML
 * @access Public (authenticated)
 */
router.post('/ml/revenue', authenticate, madAnalyticsController.getRevenuePrediction);

/**
 * @route POST /api/v1/analytics/ml/llm-predict
 * @desc Get LLM-style heuristic prediction using mad_analytics
 * @access Public (authenticated)
 */
router.post('/ml/llm-predict', authenticate, madAnalyticsController.getLlmPrediction);

/**
 * @route POST /api/v1/analytics/ml/venue-capacity
 * @desc Resolve venue capacity using mad_analytics
 * @access Public (authenticated)
 */
router.post('/ml/venue-capacity', authenticate, madAnalyticsController.getVenueCapacity);

/**
 * @route POST /api/v1/analytics/ml/popularity
 * @desc Get popularity score using ML
 * @access Public (authenticated)
 */
router.post('/ml/popularity', authenticate, madAnalyticsController.getPopularityScore);

/**
 * @route GET /api/v1/analytics/ml/popularity/all
 * @desc Canonical popularity for all active artists (batch, cached)
 * @access Public (authenticated)
 */
router.get('/ml/popularity/all', authenticate, madAnalyticsController.getAllPopularityScores);

/**
 * @route GET /api/v1/analytics/ml/dashboard-highlights
 * @desc Dashboard homepage spotlight + revisit reminders (real touring data, no formula)
 * @access Public (authenticated)
 */
router.get('/ml/dashboard-highlights', authenticate, madAnalyticsController.getDashboardHighlights);

/**
 * @route POST /api/v1/analytics/ml/popularity/all/save
 * @desc Save popularity scores for all artists using ML
 * @access Public (authenticated)
 */
router.post('/ml/popularity/all/save', authenticate, madAnalyticsController.saveAllPopularityScores);

/**
 * @route POST /api/v1/analytics/ml/popularity/refresh
 * @desc "Sync Now" -- recompute Popularity for every active artist right now
 *       and write it into artists.popularity (weekly-cache-plus-manual-sync
 *       design, 2026-09). Normal page loads never call this.
 * @access Public (authenticated)
 */
router.post('/ml/popularity/refresh', authenticate, madAnalyticsController.refreshAllPopularityScores);

export default router;

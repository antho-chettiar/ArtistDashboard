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
 * @route GET /api/v1/analytics/ml/venue-capacity/known-list
 * @desc Curated venue capacities (real/verified, vs. the keyword heuristic)
 * @access Public (authenticated)
 */
router.get('/ml/venue-capacity/known-list', authenticate, madAnalyticsController.getKnownVenueCapacities);

/**
 * @route GET /api/v1/analytics/ml/engagement?artist_id=...
 * @desc Engagement ratios (YouTube like-rate, Spotify follow-rate)
 * @access Public (authenticated)
 */
router.get('/ml/engagement', authenticate, madAnalyticsController.getEngagement);

/**
 * @route GET /api/v1/analytics/ml/regional-trends?artist_name=...&city=...
 * @desc State-level (NOT city-level) Google Trends search interest -- see
 *       mad_analytics/trends/regional.py for the granularity limitation
 * @access Public (authenticated)
 */
router.get('/ml/regional-trends', authenticate, madAnalyticsController.getRegionalTrend);

/**
 * @route GET /api/v1/analytics/ml/touring-history/repeat-visit-rate?artist_id=...
 * @desc Per-artist repeat-visit rate (of cities played, fraction revisited)
 * @access Public (authenticated)
 */
router.get('/ml/touring-history/repeat-visit-rate', authenticate, madAnalyticsController.getRepeatVisitRate);

/**
 * @route GET /api/v1/analytics/ml/touring-history/insights?artist_id=...
 * @desc Every real, data-grounded insight this engine can find for one
 *       artist -- the per-artist surface of the same engine
 *       dashboard-highlights draws its roster-wide "best of" picks from.
 *       See mad_analytics/touring_history/scorer.py::artist_insights()
 * @access Public (authenticated)
 */
router.get('/ml/touring-history/insights', authenticate, madAnalyticsController.getArtistInsights);

/**
 * @route GET /api/v1/analytics/ml/touring-history/top-insight-per-artist
 * @desc One real insight per artist, roster-wide -- for the Artists list
 *       page's compact teaser. See mad_analytics/touring_history/scorer.py
 *       ::top_insight_per_artist()
 * @access Public (authenticated)
 */
router.get('/ml/touring-history/top-insight-per-artist', authenticate, madAnalyticsController.getTopInsightPerArtist);

/**
 * @route POST /api/v1/analytics/ml/feasibility
 * @desc TOPSIS-ranked city feasibility for one artist against every other
 *       NCCS-covered candidate city -- see mad_analytics/feasibility/topsis.py
 * @access Public (authenticated)
 */
router.post('/ml/feasibility', authenticate, madAnalyticsController.getFeasibility);

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

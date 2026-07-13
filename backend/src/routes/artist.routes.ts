import { Router } from 'express';
import { artistController } from '../controllers/artist.controller';
import { authenticate, isAdmin } from '../middleware/auth';

const router = Router();

/**
 * @route GET /api/v1/artists
 * @desc List artists with pagination, search, filter
 * @access Public
 */
router.get('/', artistController.list);

/**
 * @route GET /api/v1/artists/leaderboard
 * @desc All artists ranked by latest ArtistPopularityV2 finalScore
 * @access Public
 * NOTE: must be registered BEFORE /:id, or Express matches "leaderboard" as an id
 */
router.get('/leaderboard', artistController.leaderboard);

/**
 * @route GET /api/v1/artists/:id
 * @desc Get single artist by ID
 * @access Public
 */
router.get('/:id', artistController.getById);

/**
 * @route POST /api/v1/artists
 * @desc Create artist (admin only)
 * @access Private (Admin)
 */
router.post(
  '/',
  authenticate,
  isAdmin,
  artistController.create
);

/**
 * @route PUT /api/v1/artists/:id
 * @desc Update artist (admin only)
 * @access Private (Admin)
 */
router.put(
  '/:id',
  authenticate,
  isAdmin,
  artistController.update
);

/**
 * @route DELETE /api/v1/artists/:id
 * @desc Delete/soft-delete artist (admin only)
 * @access Private (Admin)
 */
router.delete(
  '/:id',
  authenticate,
  isAdmin,
  artistController.delete
);

/**
 * @route GET /api/v1/artists/:id/metrics
 * @desc Get artist metrics with optional platform/date filters
 * @access Public
 */
router.get('/:id/metrics', artistController.getMetrics);

/**
 * @route GET /api/v1/artists/:id/concerts
 * @desc Get artist concerts
 * @access Public
 */
router.get('/:id/concerts', artistController.getConcerts);

/**
 * @route GET /api/v1/artists/:id/demographics
 * @desc Get artist audience demographics
 * @access Public
 */
router.get('/:id/demographics', artistController.getDemographics);

/**
 * @route GET /api/v1/artists/:id/score
 * @desc Latest ArtistPopularityV2 score breakdown (?history=N for trend)
 * @access Public
 */
router.get('/:id/score', artistController.getScore);

/**
 * @route GET /api/v1/artists/:id/viberate-metrics
 * @desc Viberate daily time-series (?metric=spotify_listeners&days=30)
 * @access Public
 */
router.get('/:id/viberate-metrics', artistController.getViberateMetrics);

export default router;

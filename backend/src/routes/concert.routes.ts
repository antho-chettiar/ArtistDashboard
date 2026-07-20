import { Router } from 'express';
import { concertController } from '../controllers/concert.controller';
import { authenticate, isAdmin } from '../middleware/auth';

const router = Router();

/**
 * @route GET /api/v1/concerts
 * @desc List concerts with pagination and filters
 * @access Public
 */
router.get('/', concertController.list);

/**
 * @route POST /api/v1/concerts
 * @desc Create concert (admin only)
 * @access Private (Admin)
 */
router.post(
  '/',
  authenticate,
  isAdmin,
  concertController.create
);

/**
 * @route PUT /api/v1/concerts/:id
 * @desc Update concert (admin only)
 * @access Private (Admin)
 */
router.put(
  '/:id',
  authenticate,
  isAdmin,
  concertController.update
);

/**
 * @route GET /api/v1/concerts/cities
 * @desc Get cities with aggregated statistics
 * @access Public
 */
router.get('/cities', concertController.getCities);

/**
 * @route GET /api/v1/concerts/venues
 * @desc Get venues with aggregated statistics
 * @access Public
 */
router.get('/venues', concertController.getVenues);

/**
 * @route GET /api/v1/concerts/pipeline/sources
 * @desc List supported concert scraping sources
 * @access Public
 */
router.get('/pipeline/sources', concertController.getPipelineSources);

/**
 * @route POST /api/v1/concerts/pipeline
 * @desc Run concert scraping and ML pipeline for one artist or all active artists
 * @access Private (Admin)
 */
router.post(
  '/pipeline',
  authenticate,
  isAdmin,
  concertController.runPipeline
);

/**
 * @route POST /api/v1/concerts/pipeline/all
 * @desc Run concert scraping and ML pipeline for every active artist
 * @access Private (Admin)
 */
router.post(
  '/pipeline/all',
  authenticate,
  isAdmin,
  concertController.runPipelineForAllArtists
);

/**
 * @route POST /api/v1/concerts/intelligence
 * @desc Run multi-layer concert discovery, normalization, dedupe, validation, and prediction
 * @access Private (Admin)
 */
router.post(
  '/intelligence',
  authenticate,
  isAdmin,
  concertController.runIntelligencePipeline
);

/**
 * @route POST /api/v1/concerts/intelligence/queue
 * @desc Enqueue a queue-ready concert intelligence scraping job
 * @access Private (Admin)
 */
router.post(
  '/intelligence/queue',
  authenticate,
  isAdmin,
  concertController.enqueueIntelligencePipeline
);

/**
 * @route POST /api/v1/concerts/ingest/scrapers
 * @desc Run the registered concert scrapers (BookMyShow, District) and ingest
 *       their output into the canonical-event pipeline (CanonicalEvent +
 *       SourceEventReference + duplicate detection + ValidationLog only)
 * @access Private (Admin)
 */
router.post(
  '/ingest/scrapers',
  authenticate,
  isAdmin,
  concertController.ingestFromScrapers
);

/**
 * @route POST /api/v1/concerts/predictions/revenue
 * @desc Predict concert revenue, attendance, sellout probability, and demand score
 * @access Private (Admin)
 */
router.post(
  '/predictions/revenue',
  authenticate,
  isAdmin,
  concertController.predictRevenue
);

/**
 * @route POST /api/v1/concerts/pipeline/artist
 * @desc Backwards-compatible artist pipeline route
 * @access Private (Admin)
 */
router.post(
  '/pipeline/artist',
  authenticate,
  isAdmin,
  concertController.runArtistPipeline
);

/**
 * @route GET /api/v1/concerts/:id
 * @desc Get single concert by ID
 * @access Public
 */
router.get('/:id', concertController.getById);

export default router;

import { Response } from 'express';
import { prisma } from '../utils/database';
import { CreateConcertInput, UpdateConcertInput } from '../validations/zodSchemas';
import { concertPipelineService } from '../services/concertPipeline.service';
import { concertIntelligenceService } from '../services/concertIntelligence.service';
import { revenuePredictionService } from '../services/predictions/revenuePrediction.service';
import { ConcertSourcePlatform } from '../services/scrapers/types';
import { calculateConcertMetrics, withCalculatedConcertRevenue } from '../utils/concertRevenue';
import {
  runConcertScraperIngestion,
  AVAILABLE_SCRAPER_SOURCES,
} from '../services/ingestion/concertScraperIngestion.service';

const SUPPORTED_INTELLIGENCE_SOURCES: ConcertSourcePlatform[] = [
  'BOOKMYSHOW',
  'SONGKICK',
  'BANDSINTOWN',
  'EVENTBRITE',
  'GOOGLE_CSE',
];

const parseOptionalDate = (value: unknown): Date | undefined => {
  if (!value) return undefined;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const parseSources = (value: unknown): ConcertSourcePlatform[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const selected = value
    .map((source) => String(source).toUpperCase())
    .filter((source): source is ConcertSourcePlatform =>
      SUPPORTED_INTELLIGENCE_SOURCES.includes(source as ConcertSourcePlatform)
    );
  return selected.length ? selected : undefined;
};

export const concertController = {
  // List concerts with pagination and filters
  list: async (req: any, res: Response) => {
    try {
      const {
        page = 1,
        limit = 50,
        artistId,
        city,
        country,
        dateFrom,
        dateTo,
      } = req.query;

      const skip = (parseInt(page as string) - 1) * parseInt(limit as string);

      // Build where clause
      const where: any = {};

      if (artistId) where.artistId = artistId;
      if (city) where.city = { contains: city as string, mode: 'insensitive' };
      if (country) where.country = { contains: country as string, mode: 'insensitive' };

      if (dateFrom || dateTo) {
        where.concertDate = {};
        if (dateFrom) where.concertDate.gte = new Date(dateFrom as string);
        if (dateTo) where.concertDate.lte = new Date(dateTo as string);
      }

      const [concerts, total] = await Promise.all([
        prisma.concert.findMany({
          where,
          include: {
            artist: {
              select: {
                id: true,
                artistName: true,
                nationality: true,
              },
            },
            predictionOutputs: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: {
                expectedRevenue: true,
                expectedAttendance: true,
                demandScore: true,
                features: true,
              },
            },
          },
          orderBy: { concertDate: 'desc' },
          skip,
          take: parseInt(limit as string),
        }),
        prisma.concert.count({ where }),
      ]);

      return res.status(200).json({
        success: true,
        data: {
          concerts: concerts.map(withCalculatedConcertRevenue),
          pagination: {
            page: parseInt(page as string),
            limit: parseInt(limit as string),
            total,
            pages: Math.ceil(total / parseInt(limit as string)),
          },
        },
      });
    } catch (error) {
      throw error;
    }
  },

  // Get single concert by ID
  getById: async (req: any, res: Response) => {
    try {
      const { id } = req.params;

      const concert = await prisma.concert.findUnique({
        where: { id },
        include: {
          artist: {
            select: {
              id: true,
              artistName: true,
              nationality: true,
            },
          },
          audienceDemographics: {
            orderBy: { metricDate: 'desc' },
          },
          predictionOutputs: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: {
              expectedRevenue: true,
              expectedAttendance: true,
              demandScore: true,
              features: true,
            },
          },
        },
      });

      if (!concert) {
        return res.status(404).json({
          success: false,
          message: 'Concert not found',
          code: 'CONCERT_NOT_FOUND',
        });
      }

      return res.status(200).json({
        success: true,
        data: { concert: withCalculatedConcertRevenue(concert) },
      });
    } catch (error) {
      throw error;
    }
  },

  // Create concert (admin only)
  create: async (req: any, res: Response) => {
    try {
      const input: CreateConcertInput = req.body;

      // Verify artist exists
      const artist = await prisma.artist.findUnique({
        where: { id: input.artistId },
      });

      if (!artist) {
        return res.status(400).json({
          success: false,
          message: 'Artist not found',
          code: 'ARTIST_NOT_FOUND',
        });
      }

      const concertDate = new Date(input.concertDate);

      const filteredInput = Object.fromEntries(
        Object.entries(input).filter(([_, v]) => v !== null)
      );

      const concert = await prisma.concert.create({
        data: {
          ...filteredInput,
          ...calculateConcertMetrics(filteredInput),
          concertDate,
        } as any,
        include: {
          artist: {
            select: {
              id: true,
              artistName: true,
            },
          },
        },
      });

      return res.status(201).json({
        success: true,
        data: { concert: withCalculatedConcertRevenue(concert) },
        message: 'Concert created successfully',
      });
    } catch (error) {
      throw error;
    }
  },

  // Update concert (admin only)
  update: async (req: any, res: Response) => {
    try {
      const { id } = req.params;
      const input: UpdateConcertInput = req.body;

      // Check if concert exists
      const existing = await prisma.concert.findUnique({ where: { id } });
      if (!existing) {
        return res.status(404).json({
          success: false,
          message: 'Concert not found',
          code: 'CONCERT_NOT_FOUND',
        });
      }

      const updateData: any = { ...input };
      if (input.concertDate) {
        updateData.concertDate = new Date(input.concertDate);
      }

      if (updateData.totalRevenue === undefined || updateData.totalRevenue === null || Number(updateData.totalRevenue) <= 0) {
        const calculatedMetrics = calculateConcertMetrics({ ...existing, ...updateData });
        Object.assign(updateData, calculatedMetrics);
      } else {
        Object.assign(updateData, calculateConcertMetrics({ ...existing, ...updateData }));
      }

      const concert = await prisma.concert.update({
        where: { id },
        data: updateData,
        include: {
          artist: {
            select: {
              id: true,
              artistName: true,
            },
          },
        },
      });

      return res.status(200).json({
        success: true,
        data: { concert: withCalculatedConcertRevenue(concert) },
        message: 'Concert updated successfully',
      });
    } catch (error) {
      throw error;
    }
  },

  // Get cities with aggregated stats
  getCities: async (req: any, res: Response) => {
    try {
      const { country } = req.query;

      const where: any = {};
      if (country) {
        where.country = { contains: country as string, mode: 'insensitive' };
      }

      const cities = await prisma.concert.groupBy({
        by: ['city', 'state', 'country'],
        where,
        _sum: {
          ticketsSold: true,
          totalRevenue: true,
          capacity: true,
        },
        _count: {
          id: true,
        },
        orderBy: {
          _sum: {
            totalRevenue: 'desc',
          },
        },
        take: 50,
      });

      // Format response
      const formatted = cities.map((city) => ({
        city: city.city,
        state: city.state,
        country: city.country,
        concertCount: city._count.id,
        totalTicketsSold: city._sum.ticketsSold || 0,
        totalRevenue: city._sum.totalRevenue || 0,
        totalCapacity: city._sum.capacity || 0,
        avgTicketPrice: city._sum.totalRevenue && city._sum.ticketsSold && city._sum.ticketsSold > 0
          ? Number(city._sum.totalRevenue) / Number(city._sum.ticketsSold)
          : 0,
      }));

      return res.status(200).json({
        success: true,
        data: { cities: formatted },
      });
    } catch (error) {
      throw error;
    }
  },

  // Get venues with aggregated stats
  getVenues: async (_req: any, res: Response) => {
    try {
      const venues = await prisma.concert.groupBy({
        by: ['venueName', 'city', 'country'],
        _sum: {
          ticketsSold: true,
          totalRevenue: true,
          capacity: true,
        },
        _count: {
          id: true,
        },
        orderBy: {
          _sum: {
            totalRevenue: 'desc',
          },
        },
        take: 50,
      });

      const formatted = venues.map((venue) => ({
        venueName: venue.venueName,
        city: venue.city,
        country: venue.country,
        concertCount: venue._count.id,
        totalTicketsSold: venue._sum.ticketsSold || 0,
        totalRevenue: venue._sum.totalRevenue || 0,
        avgTicketPrice: venue._sum.totalRevenue && venue._sum.ticketsSold && venue._sum.ticketsSold > 0
          ? Number(venue._sum.totalRevenue) / Number(venue._sum.ticketsSold)
          : 0,
      }));

      return res.status(200).json({
        success: true,
        data: { venues: formatted },
      });
    } catch (error) {
      throw error;
    }
  },

  // Trigger ML pipeline for an artist
  runPipeline: async (req: any, res: Response) => {
    try {
      const { artistId, artistIds, startYear, endYear, maxPagesPerYear, dryRun } = req.body;
      const selectedArtistIds = Array.isArray(artistIds)
        ? artistIds
        : artistId
          ? [artistId]
          : undefined;

      const summary = await concertPipelineService.runPipeline({
        artistIds: selectedArtistIds,
        startYear: startYear ? Number(startYear) : undefined,
        endYear: endYear ? Number(endYear) : undefined,
        maxPagesPerYear: maxPagesPerYear ? Number(maxPagesPerYear) : undefined,
        dryRun: Boolean(dryRun),
        sources: ['SETLIST_FM'],
      });

      return res.status(200).json({
        success: true,
        data: summary,
        message: dryRun
          ? 'Concert scraping dry run completed successfully'
          : 'Concert scraping and revenue pipeline completed successfully',
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error'
      });
    }
  },

  // Trigger pipeline for every active artist in the DB
  runPipelineForAllArtists: async (req: any, res: Response) => {
    try {
      const { startYear, endYear, maxPagesPerYear, dryRun } = req.body;

      const summary = await concertPipelineService.runPipeline({
        startYear: startYear ? Number(startYear) : undefined,
        endYear: endYear ? Number(endYear) : undefined,
        maxPagesPerYear: maxPagesPerYear ? Number(maxPagesPerYear) : undefined,
        dryRun: Boolean(dryRun),
        sources: ['SETLIST_FM'],
      });

      return res.status(200).json({
        success: true,
        data: summary,
        message: dryRun
          ? 'All-artist concert scraping dry run completed successfully'
          : 'All-artist concert scraping and revenue pipeline completed successfully',
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error'
      });
    }
  },

  // Run the multi-source concert intelligence pipeline
  runIntelligencePipeline: async (req: any, res: Response) => {
    try {
      const {
        sources,
        artists,
        cities,
        country,
        dateFrom,
        dateTo,
        limitPerSource,
        maxPages,
        dryRun,
        runPredictions,
        persistConcerts,
        artistIds,
        artistLimit,
      } = req.body;

      const shouldRunPredictions = runPredictions === undefined ? true : Boolean(runPredictions);
      const summary = await concertIntelligenceService.runDiscoveryPipeline({
        sources: parseSources(sources),
        artistIds: Array.isArray(artistIds) ? artistIds.map(String) : undefined,
        artists: Array.isArray(artists) ? artists.map(String) : undefined,
        cities: Array.isArray(cities) ? cities.map(String) : undefined,
        country: country ? String(country) : undefined,
        dateFrom: parseOptionalDate(dateFrom),
        dateTo: parseOptionalDate(dateTo),
        limitPerSource: limitPerSource ? Number(limitPerSource) : undefined,
        maxPages: maxPages ? Number(maxPages) : undefined,
        dryRun: Boolean(dryRun),
        runPredictions: shouldRunPredictions,
        persistConcerts: persistConcerts === undefined ? true : Boolean(persistConcerts),
        artistLimit: artistLimit ? Number(artistLimit) : undefined,
      });

      return res.status(200).json({
        success: true,
        data: summary,
        message: dryRun
          ? 'Concert intelligence dry run completed successfully'
          : shouldRunPredictions
            ? 'Concert intelligence pipeline completed successfully'
            : 'Concert scraping and validation completed successfully',
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error',
      });
    }
  },

  // Enqueue a scrape job for an external worker to process
  enqueueIntelligencePipeline: async (req: any, res: Response) => {
    try {
      const { sources, artists, cities, country, dateFrom, dateTo, limitPerSource, maxPages } = req.body;
      const jobId = await concertIntelligenceService.enqueueDiscoveryPipeline({
        sources: parseSources(sources),
        artistIds: Array.isArray(req.body.artistIds) ? req.body.artistIds.map(String) : undefined,
        artists: Array.isArray(artists) ? artists.map(String) : undefined,
        cities: Array.isArray(cities) ? cities.map(String) : undefined,
        country: country ? String(country) : undefined,
        dateFrom: parseOptionalDate(dateFrom),
        dateTo: parseOptionalDate(dateTo),
        limitPerSource: limitPerSource ? Number(limitPerSource) : undefined,
        maxPages: maxPages ? Number(maxPages) : undefined,
      });

      return res.status(202).json({
        success: true,
        data: { jobId },
        message: 'Concert intelligence scrape job enqueued',
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error',
      });
    }
  },

  // Run the registered ConcertSourceScraper implementations (BookMyShow,
  // District) and ingest their output into the existing canonical-event
  // pipeline. Stops after CanonicalEvent + SourceEventReference + duplicate
  // detection + ValidationLog -- no Concert/prediction/analytics in this phase.
  ingestFromScrapers: async (req: any, res: Response) => {
    try {
      const inProgress = await prisma.ingestionJob.findFirst({
        where: { jobType: 'CONCERT_SCRAPE', status: 'RUNNING' },
      });

      if (inProgress) {
        return res.status(409).json({
          success: false,
          message: `A concert scraper ingestion job is already running (jobId: ${inProgress.id})`,
        });
      }

      const { sources, artists, cities, country, dateFrom, dateTo, limitPerSource, maxPages } = req.body;

      // Validated against the sources actually registered in
      // concertScraperIngestion.service.ts, NOT the older SUPPORTED_INTELLIGENCE_SOURCES
      // constant above -- that list excludes 'ZOMATO' (District), which would
      // otherwise silently drop District from any sources-filtered request.
      const parsedSources = Array.isArray(sources)
        ? sources
            .map((source: unknown) => String(source).toUpperCase())
            .filter((source: string): source is ConcertSourcePlatform =>
              AVAILABLE_SCRAPER_SOURCES.includes(source as ConcertSourcePlatform)
            )
        : undefined;

      const query = {
        sources: parsedSources && parsedSources.length ? parsedSources : undefined,
        artists: Array.isArray(artists) ? artists.map(String) : undefined,
        cities: Array.isArray(cities) ? cities.map(String) : undefined,
        country: country ? String(country) : undefined,
        dateFrom: parseOptionalDate(dateFrom),
        dateTo: parseOptionalDate(dateTo),
        limitPerSource: limitPerSource ? Number(limitPerSource) : undefined,
        maxPages: maxPages ? Number(maxPages) : undefined,
      };

      const job = await prisma.ingestionJob.create({
        data: { jobType: 'CONCERT_SCRAPE', status: 'RUNNING' },
      });

      const startTime = Date.now();

      try {
        const result = await runConcertScraperIngestion(query);

        await prisma.ingestionJob.update({
          where: { id: job.id },
          data: {
            status: 'SUCCESS',
            rowCount: result.totalRawEvents,
            duration: Math.floor((Date.now() - startTime) / 1000),
            completedAt: new Date(),
          },
        });

        return res.status(200).json({
          success: true,
          data: { jobId: job.id, ...result },
          message: 'Scraper ingestion completed successfully',
        });
      } catch (error: any) {
        await prisma.ingestionJob.update({
          where: { id: job.id },
          data: {
            status: 'FAILED',
            errorMessage: error.message || 'Unknown error',
            duration: Math.floor((Date.now() - startTime) / 1000),
            completedAt: new Date(),
          },
        });
        throw error;
      }
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error',
      });
    }
  },

  // Revenue prediction endpoint for ML-ready consumers
  predictRevenue: async (req: any, res: Response) => {
    try {
      const {
        artist,
        artistId,
        city,
        country,
        venueName,
        venue_capacity,
        avg_ticket_price,
        event_date,
        canonicalEventId,
        concertId,
      } = req.body;

      if (!artist || !city || !venue_capacity || !avg_ticket_price || !event_date) {
        return res.status(400).json({
          success: false,
          message: 'artist, city, venue_capacity, avg_ticket_price, and event_date are required',
        });
      }

      const prediction = await revenuePredictionService.predict({
        artist: String(artist),
        artistId: artistId ? String(artistId) : undefined,
        city: String(city),
        country: country ? String(country) : undefined,
        venueName: venueName ? String(venueName) : undefined,
        venue_capacity: Number(venue_capacity),
        avg_ticket_price: Number(avg_ticket_price),
        event_date,
        canonicalEventId: canonicalEventId ? String(canonicalEventId) : undefined,
        concertId: concertId ? String(concertId) : undefined,
      });

      return res.status(200).json({
        success: true,
        data: {
          expected_revenue: prediction.expected_revenue,
          expected_attendance: prediction.expected_attendance,
          sellout_probability: prediction.sellout_probability,
          demand_score: prediction.demand_score,
          model_version: prediction.model_version,
          features: prediction.features,
        },
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error',
      });
    }
  },

  // Document currently supported concert providers
  getPipelineSources: async (_req: any, res: Response) => {
    try {
      return res.status(200).json({
        success: true,
        data: {
          activeSources: [
            {
              key: 'SETLIST_FM',
              name: 'setlist.fm',
              requiredEnv: ['SETLISTFM_API_KEY'],
              supportsHistoricalData: true,
              notes: 'Used now for artist concert history from 2021 onward.',
            },
          ],
          intelligenceSources: [
            {
              key: 'BOOKMYSHOW',
              name: 'BookMyShow',
              notes: 'Playwright source adapter for India-focused event discovery.',
            },
            {
              key: 'SONGKICK',
              name: 'Songkick',
              notes: 'Playwright source adapter for artist and metro event discovery.',
            },
            {
              key: 'BANDSINTOWN',
              name: 'Bandsintown',
              notes: 'Playwright source adapter for artist tour pages and search results.',
            },
            {
              key: 'EVENTBRITE',
              name: 'Eventbrite',
              notes: 'Playwright source adapter for city and artist music event searches.',
            },
            {
              key: 'GOOGLE_CSE',
              name: 'Google Custom Search',
              requiredEnv: ['GOOGLE_SEARCH_API_KEY', 'GOOGLE_SEARCH_CX'],
              notes: 'Searches configured event sites and extracts real Event/JSON-LD metadata from result pages.',
            },
          ],
          plannedSources: [
            {
              key: 'TICKETMASTER',
              name: 'Ticketmaster Discovery API',
              notes: 'Good future extension for event discovery and venue metadata once an API key is added.',
            },
          ],
        },
      });
    } catch (error) {
      throw error;
    }
  },

  // Backwards-compatible alias for old callers that sent only artistId
  runArtistPipeline: async (req: any, res: Response) => {
    try {
      const { artistId } = req.body;
      if (!artistId) {
        return res.status(400).json({ success: false, message: 'artistId is required' });
      }

      const results = await concertPipelineService.runPipelineForArtist(artistId);

      return res.status(200).json({
        success: true,
        data: {
          processedCount: results.length,
          concerts: results
        },
        message: 'ML Pipeline executed successfully'
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error'
      });
    }
  },
};

export default concertController;

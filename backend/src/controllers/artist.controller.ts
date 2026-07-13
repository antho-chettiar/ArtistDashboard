import { Response } from 'express';
import { prisma } from '../utils/database';
import {
  CreateArtistInput,
  UpdateArtistInput,
  createArtistSchema,
  updateArtistSchema,
} from '../validations/zodSchemas';
import { withCalculatedConcertRevenue } from '../utils/concertRevenue';

export const artistController = {
  // List artists with pagination, search, genre filter
  list: async (req: any, res: Response) => {
    try {
      const {
        page = 1,
        limit = 50,
        search,
        genre,
        active,
      } = req.query;

      const skip = (parseInt(page as string) - 1) * parseInt(limit as string);

      // Parse active to boolean
      let isActive = true; // Default to true
      if (active === 'false') isActive = false;
      else if (active === 'true') isActive = true;
      else if (typeof active === 'boolean') isActive = active;

      // Build where clause
      const where: any = {
        active: isActive,
      };

      if (search) {
        where.OR = [
          { artistName: { contains: search as string, mode: 'insensitive' } },
          { nationality: { contains: search as string, mode: 'insensitive' } },
        ];
      }

      if (genre) {
        const genreRecord = await prisma.genre.findFirst({
          where: { name: { equals: genre as string, mode: 'insensitive' as const } },
        });
        if (genreRecord) {
          where.genres = { some: { genreId: genreRecord.id } };
        }
      }

      const [artists, total] = await Promise.all([
        prisma.artist.findMany({
          where,
          include: {
            genres: {
              include: {
                genre: true,
              },
            },
            platformMetrics: {
              orderBy: { metricDate: 'desc' },
              take: 5,
            },
          },
          skip,
          take: parseInt(limit as string),
          orderBy: { artistName: 'asc' },
        }),
        prisma.artist.count({ where }),
      ]);

      return res.status(200).json({
        success: true,
        data: {
          artists,
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

  // Get single artist by ID
  getById: async (req: any, res: Response) => {
    try {
      const { id } = req.params;

      const artist = await prisma.artist.findUnique({
        where: { id },
        include: {
          genres: {
            include: {
              genre: true,
            },
          },
          platformMetrics: {
            orderBy: { metricDate: 'desc' },
            take: 10, // Recent metrics
          },
          concerts: {
            take: 5,
            orderBy: { concertDate: 'desc' },
            include: {
              predictionOutputs: {
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: {
                  expectedRevenue: true,
                },
              },
            },
          },
        },
      });

      if (!artist) {
        return res.status(404).json({
          success: false,
          message: 'Artist not found',
          code: 'ARTIST_NOT_FOUND',
        });
      }

      return res.status(200).json({
        success: true,
        data: {
          artist: {
            ...artist,
            concerts: (artist.concerts || []).map(withCalculatedConcertRevenue),
          },
        },
      });
    } catch (error) {
      throw error;
    }
  },

  // Create artist (admin only)
  create: async (req: any, res: Response) => {
    try {
      const input: CreateArtistInput = createArtistSchema.parse(req.body);

      const { genreIds, ...artistData } = input;

      // Normalize genreIds: find or create genres
      let genreConnections: any[] = [];
      if (genreIds && genreIds.length > 0) {
        for (const genreId of genreIds) {
          // Check if it's a valid genre ID
          const genre = await prisma.genre.findFirst({
            where: { id: parseInt(genreId) },
          });
          if (genre) {
            genreConnections.push({ genreId: genre.id });
          }
        }
      }

      const artist = await prisma.artist.create({
        data: {
          ...artistData,
          photoUrl: artistData.photoUrl || null,
          genres: { create: genreConnections },
        },
        include: {
          genres: {
            include: {
              genre: true,
            },
          },
        },
      });

      return res.status(201).json({
        success: true,
        data: { artist },
        message: 'Artist created successfully',
      });
    } catch (error) {
      throw error;
    }
  },

  // Update artist (admin only)
  update: async (req: any, res: Response) => {
    try {
      const { id } = req.params;
      const input: UpdateArtistInput = updateArtistSchema.parse(req.body);

      // Check if artist exists
      const existing = await prisma.artist.findUnique({ where: { id } });
      if (!existing) {
        return res.status(404).json({
          success: false,
          message: 'Artist not found',
          code: 'ARTIST_NOT_FOUND',
        });
      }

      const { genreIds, ...artistData } = input;

      // Handle genres
      if (genreIds) {
        // Remove existing genre connections
        await prisma.artistGenre.deleteMany({
          where: { artistId: id },
        });

        // Add new genre connections
        const genreConnections: any[] = [];
        for (const genreId of genreIds) {
          const genre = await prisma.genre.findFirst({
            where: { id: parseInt(genreId) },
          });
          if (genre) {
            genreConnections.push({ genreId: genre.id });
          }
        }

        await prisma.artist.update({
          where: { id },
          data: {
            ...artistData,
            genres: { create: genreConnections },
          },
          include: {
            genres: {
              include: {
                genre: true,
              },
            },
          },
        });
      } else {
        await prisma.artist.update({
          where: { id },
          data: artistData,
          include: {
            genres: {
              include: {
                genre: true,
              },
            },
          },
        });
      }

      const updatedArtist = await prisma.artist.findUnique({
        where: { id },
        include: {
          genres: {
            include: {
              genre: true,
            },
          },
        },
      });

      return res.status(200).json({
        success: true,
        data: { artist: updatedArtist },
        message: 'Artist updated successfully',
      });
    } catch (error) {
      throw error;
    }
  },

  // Delete artist (soft delete - set active=false) (admin only)
  delete: async (req: any, res: Response) => {
    try {
      const { id } = req.params;

      const artist = await prisma.artist.update({
        where: { id },
        data: { active: false },
      });

      return res.status(200).json({
        success: true,
        data: { artist },
        message: 'Artist deactivated successfully',
      });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'P2025') {
        return res.status(404).json({
          success: false,
          message: 'Artist not found',
          code: 'ARTIST_NOT_FOUND',
        });
      }
      throw error;
    }
  },

  // Get artist metrics with filters
  getMetrics: async (req: any, res: Response) => {
    try {
      // Route declares /:id — read it as the artist id
      const { id: artistId } = req.params;
      const { platform, dateFrom, dateTo } = req.query;

      // Check artist exists
      const artist = await prisma.artist.findUnique({
        where: { id: artistId },
      });

      if (!artist) {
        return res.status(404).json({
          success: false,
          message: 'Artist not found',
          code: 'ARTIST_NOT_FOUND',
        });
      }

      const where: any = { artistId };

      if (platform) {
        where.platform = platform;
      }

      if (dateFrom || dateTo) {
        where.metricDate = {};
        if (dateFrom) where.metricDate.gte = new Date(dateFrom as string);
        if (dateTo) where.metricDate.lte = new Date(dateTo as string);
      }

      const metrics = await prisma.platformMetric.findMany({
        where,
        orderBy: { metricDate: 'desc' },
        take: 1000,
      });

      return res.status(200).json({
        success: true,
        data: { metrics },
      });
    } catch (error) {
      throw error;
    }
  },

  // Get artist concerts
  getConcerts: async (req: any, res: Response) => {
    try {
      // Route declares /:id — read it as the artist id
      const { id: artistId } = req.params;

      const concerts = await prisma.concert.findMany({
        where: { artistId },
        orderBy: { concertDate: 'desc' },
        take: 100,
        include: {
          predictionOutputs: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: {
              expectedRevenue: true,
            },
          },
        },
      });

      return res.status(200).json({
        success: true,
        data: { concerts: concerts.map(withCalculatedConcertRevenue) },
      });
    } catch (error) {
      throw error;
    }
  },

  // Get artist demographics
  getDemographics: async (req: any, res: Response) => {
    try {
      // Route declares /:id — read it as the artist id
      const { id: artistId } = req.params;
      const { dimension } = req.query;

      const where: any = {
        artistId,
      };

      if (dimension) {
        where.dimension = dimension;
      }

      const demographics = await prisma.audienceDemographic.findMany({
        where,
        orderBy: { metricDate: 'desc' },
        take: 100,
      });

      return res.status(200).json({
        success: true,
        data: { demographics },
      });
    } catch (error) {
      throw error;
    }
  },

  // ─── Viberate / PopularityV2 endpoints ─────────────────────────────────────

  // GET /api/v1/artists/leaderboard
  // All artists ranked by latest finalScore from ArtistPopularityV2Snapshot
  leaderboard: async (req: any, res: Response) => {
    try {
      const { scoreVersion = 'v2.1-viberate' } = req.query;

      const artists = await prisma.artist.findMany({
        where: { active: true, viberateSlug: { not: null } },
        select: {
          id: true,
          artistName: true,
          displayName: true,
          photoUrl: true,
          imageUrl: true,
          genre: true,
          nationality: true,
          popularityV2Snapshots: {
            where: { scoreVersion: scoreVersion as string },
            orderBy: { computedAt: 'desc' },
            take: 1,
          },
        },
      });

      const leaderboard = artists
        .filter((a) => a.popularityV2Snapshots.length > 0)
        .map((a) => {
          const snap = a.popularityV2Snapshots[0];
          return {
            artistId: a.id,
            artistName: a.artistName,
            displayName: a.displayName,
            photoUrl: a.photoUrl || a.imageUrl,
            genre: a.genre,
            nationality: a.nationality,
            score: {
              finalScore: Number(snap.finalScore),
              reachScore: Number(snap.reachScore),
              engagementMultiplier: Number(snap.engagementMultiplier),
              adjustedReach: Number(snap.adjustedReach),
              trendsScore: Number(snap.trendsScore),
              scoreVersion: snap.scoreVersion,
              computedAt: snap.computedAt,
            },
          };
        })
        .sort((a, b) => b.score.finalScore - a.score.finalScore)
        .map((entry, index) => ({ rank: index + 1, ...entry }));

      const unscored = artists
        .filter((a) => a.popularityV2Snapshots.length === 0)
        .map((a) => ({ artistId: a.id, artistName: a.artistName }));

      return res.status(200).json({
        success: true,
        data: { leaderboard, unscored, scoreVersion },
      });
    } catch (error) {
      throw error;
    }
  },

  // GET /api/v1/artists/:id/score
  // Latest score breakdown for one artist (+ optional history)
  getScore: async (req: any, res: Response) => {
    try {
      const { id: artistId } = req.params;
      const { scoreVersion = 'v2.1-viberate', history = '0' } = req.query;

      const artist = await prisma.artist.findUnique({
        where: { id: artistId },
        select: { id: true, artistName: true },
      });

      if (!artist) {
        return res.status(404).json({
          success: false,
          message: 'Artist not found',
          code: 'ARTIST_NOT_FOUND',
        });
      }

      const historyCount = Math.min(parseInt(history as string) || 0, 365);

      const snapshots = await prisma.artistPopularityV2Snapshot.findMany({
        where: { artistId, scoreVersion: scoreVersion as string },
        orderBy: { computedAt: 'desc' },
        take: Math.max(1, historyCount),
      });

      if (snapshots.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'No score snapshots for this artist yet. Run the scorer first.',
          code: 'SCORE_NOT_FOUND',
        });
      }

      const [latest, ...rest] = snapshots;

      return res.status(200).json({
        success: true,
        data: {
          artistId: artist.id,
          artistName: artist.artistName,
          latest,
          history: historyCount > 0 ? [latest, ...rest] : undefined,
        },
      });
    } catch (error) {
      throw error;
    }
  },

  // GET /api/v1/artists/:id/viberate-metrics?metric=spotify_listeners&days=30
  // Time-series rows from ViberateMetricDaily for charting.
  // `metric` accepts a single name or comma-separated list.
  getViberateMetrics: async (req: any, res: Response) => {
    try {
      const { id: artistId } = req.params;
      const { metric, days = '30' } = req.query;

      const artist = await prisma.artist.findUnique({
        where: { id: artistId },
        select: { id: true },
      });

      if (!artist) {
        return res.status(404).json({
          success: false,
          message: 'Artist not found',
          code: 'ARTIST_NOT_FOUND',
        });
      }

      const daysNum = Math.min(Math.max(parseInt(days as string) || 30, 1), 730);
      const since = new Date();
      since.setDate(since.getDate() - daysNum);

      const where: any = {
        artistId,
        date: { gte: since },
      };

      if (metric) {
        const metricNames = (metric as string)
          .split(',')
          .map((m) => m.trim())
          .filter(Boolean);
        where.metricName = metricNames.length === 1
          ? metricNames[0]
          : { in: metricNames };
      }

      const rows = await prisma.viberateMetricDaily.findMany({
        where,
        orderBy: [{ metricName: 'asc' }, { date: 'asc' }],
        select: {
          metricName: true,
          date: true,
          diffValue: true,
          totalValue: true,
        },
      });

      // Group by metric for easy charting on the frontend
      const series: Record<string, { date: string; diff: number | null; total: number | null }[]> = {};
      for (const row of rows) {
        if (!series[row.metricName]) series[row.metricName] = [];
        series[row.metricName].push({
          date: row.date.toISOString().split('T')[0],
          diff: row.diffValue,
          total: row.totalValue,
        });
      }

      return res.status(200).json({
        success: true,
        data: { artistId, days: daysNum, series },
      });
    } catch (error) {
      throw error;
    }
  },
};

export default artistController;

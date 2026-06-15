import { Response } from 'express';
import * as xlsx from 'xlsx';
import { prisma, redis } from '../utils/database';
import { enrichAllArtists, enrichArtistById } from '../services/artistEnrichment.service';
import { calculateConcertRevenue } from '../utils/concertRevenue';

export const ingestionController = {
  // Upload Excel file for bulk import
  uploadExcel: async (req: any, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: 'No file uploaded',
        });
      }

      const job = await prisma.ingestionJob.create({
        data: {
          jobType: 'EXCEL_IMPORT',
          status: 'RUNNING',
          fileName: req.file.originalname,
        },
      });

      const startTime = Date.now();

      try {
        const workbook = xlsx.readFile(req.file.path);
        let totalRows = 0;

        // Process Artist_Metrics
        const metricsSheet = workbook.Sheets['Artist_Metrics'];
        if (metricsSheet) {
          const data: any[] = xlsx.utils.sheet_to_json(metricsSheet);
          for (const row of data) {
            // Find artist by name
            const artist = await prisma.artist.findUnique({
              where: { artistName: row.ArtistName },
            });

            if (artist) {
              await prisma.platformMetric.upsert({
                where: {
                  artistId_platform_metricDate: {
                    artistId: artist.id,
                    platform: row.Platform.toUpperCase() as any,
                    metricDate: new Date(row.Date),
                  },
                },
                update: {
                  followers: row.Followers ? BigInt(row.Followers) : undefined,
                  streams: row.Streams ? BigInt(row.Streams) : undefined,
                  likes: row.Likes ? BigInt(row.Likes) : undefined,
                },
                create: {
                  artistId: artist.id,
                  platform: row.Platform.toUpperCase() as any,
                  metricDate: new Date(row.Date),
                  followers: row.Followers ? BigInt(row.Followers) : 0n,
                  streams: row.Streams ? BigInt(row.Streams) : 0n,
                  likes: row.Likes ? BigInt(row.Likes) : 0n,
                  source: 'EXCEL_IMPORT',
                },
              });
              totalRows++;
            }
          }
        }

        // Process Concerts
        const concertsSheet = workbook.Sheets['Concerts'];
        if (concertsSheet) {
          const data: any[] = xlsx.utils.sheet_to_json(concertsSheet);
          for (const row of data) {
            const artist = await prisma.artist.findUnique({
              where: { artistName: row.ArtistName },
            });

            if (artist) {
              await prisma.concert.create({
                data: {
                  artistId: artist.id,
                  artistName: row.ArtistName,
                  concertDate: new Date(row.Date),
                  city: row.City,
                  country: row.Country || 'India',
                  venueName: row.Venue,
                  ticketsSold: row.TicketsSold || 0,
                  avgTicketPrice: row.AvgTicketPrice || row.AverageTicketPrice || row.TicketPrice || null,
                  totalRevenue: calculateConcertRevenue({
                    totalRevenue: row.Revenue,
                    ticketsSold: row.TicketsSold,
                    avgTicketPrice: row.AvgTicketPrice || row.AverageTicketPrice || row.TicketPrice,
                  }),
                  notes: row.ConcertName || undefined,
                  source: 'EXCEL_IMPORT',
                },
              });
              totalRows++;
            }
          }
        }

        const duration = Math.floor((Date.now() - startTime) / 1000);

        await prisma.ingestionJob.update({
          where: { id: job.id },
          data: {
            status: 'SUCCESS',
            rowCount: totalRows,
            duration,
            completedAt: new Date(),
          },
        });

        // Invalidate relevant caches
        const patterns = ['dashboard:*', 'rog:*', 'genres:*'];
        for (const pattern of patterns) {
          const keys = await redis.keys(pattern);
          if (keys.length > 0) await redis.del(...keys);
        }

        return res.status(200).json({
          success: true,
          message: 'Excel data imported successfully',
          data: {
            jobId: job.id,
            rowsProcessed: totalRows,
          },
        });
      } catch (err: any) {
        await prisma.ingestionJob.update({
          where: { id: job.id },
          data: {
            status: 'FAILED',
            errorMessage: err.message,
            completedAt: new Date(),
          },
        });
        throw err;
      }
    } catch (error) {
      console.error('Ingestion error:', error);
      return res.status(500).json({
        success: false,
        message: 'Internal server error during ingestion',
      });
    }
  },

  // Trigger manual sync for a platform (admin only)
  syncPlatform: async (req: any, res: Response) => {
    try {
      const { platform } = req.params;
      const targetPlatform = platform?.toUpperCase();

      if (targetPlatform !== 'SPOTIFY') {
        return res.status(400).json({
          success: false,
          error: `Unsupported platform: ${platform}. Currently only SPOTIFY is supported.`,
        });
      }

      const job = await prisma.ingestionJob.create({
        data: {
          jobType: 'PLATFORM_SYNC',
          status: 'RUNNING',
          fileName: platform,
        },
      });

      const result = await enrichAllArtists();

      await prisma.ingestionJob.update({
        where: { id: job.id },
        data: {
          status: result.failed === 0 ? 'SUCCESS' : result.enriched > 0 ? 'SUCCESS' : 'FAILED',
          completedAt: new Date(),
          errorMessage: result.failed > 0 ? `${result.failed} artist(s) failed` : undefined,
          rowCount: result.total,
          duration: Math.floor((Date.now() - new Date(job.startedAt).getTime()) / 1000),
        },
      });

      return res.status(200).json({
        success: true,
        message: `Sync completed for ${platform}`,
        data: { job, enrichment: result },
      });
    } catch (error: any) {
      console.error('Sync error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to sync platform',
        details: error.message,
      });
    }
  },

  // Enrich all artists with social data (admin only)
  enrichArtists: async (_req: any, res: Response) => {
    try {
      const result = await enrichAllArtists();
      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      console.error('Enrichment error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to enrich artists',
        details: error.message,
      });
    }
  },

  // Enrich a single artist by ID
  enrichArtist: async (req: any, res: Response) => {
    try {
      const { id } = req.params;
      const result = await enrichArtistById(id);

      if (!result) {
        return res.status(404).json({ success: false, error: 'Artist not found' });
      }

      return res.status(200).json({ success: true, data: result });
    } catch (error: any) {
      console.error('Enrichment error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to enrich artist',
        details: error.message,
      });
    }
  },

  // List recent ingestion jobs
  listJobs: async (req: any, res: Response) => {
    try {
      const { limit = 20 } = req.query;
      
      const jobs = await prisma.ingestionJob.findMany({
        take: Number(limit),
        orderBy: { startedAt: 'desc' },
      });

      return res.status(200).json({
        success: true,
        data: { jobs },
      });
    } catch (error) {
      throw error;
    }
  },

  // Recalculate RoG for all or specific artist/platform
  recalcRoG: async (req: any, res: Response) => {
    try {
      const { artistId, platform } = req.body;

      const where: any = {};
      if (artistId) where.artistId = artistId;
      if (platform) where.platform = platform.toUpperCase();

      const metrics = await prisma.platformMetric.findMany({
        where,
        orderBy: [
          { artistId: 'asc' },
          { platform: 'asc' },
          { metricDate: 'asc' },
        ],
      });

      let updatedCount = 0;
      for (let i = 1; i < metrics.length; i++) {
        const current = metrics[i];
        const previous = metrics[i - 1];

        if (
          current.artistId === previous.artistId &&
          current.platform === previous.platform
        ) {
          const daysDiff = Math.floor(
            (new Date(current.metricDate).getTime() -
              new Date(previous.metricDate).getTime()) /
              (1000 * 60 * 60 * 24)
          );

          if (daysDiff >= 1 && daysDiff <= 45) {
            if (Number(previous.followers) > 0) {
              const rogDaily = ((Number(current.followers) - Number(previous.followers)) / Number(previous.followers)) * 100 / daysDiff;
              await prisma.platformMetric.update({
                where: { id: current.id },
                data: { rogDaily: parseFloat(rogDaily.toFixed(4)) },
              });
              updatedCount++;
            }
          }
        }
      }

      return res.status(200).json({
        success: true,
        message: 'RoG recalculation completed',
        data: { updated: updatedCount },
      });
    } catch (error) {
      throw error;
    }
  },
};

export default ingestionController;

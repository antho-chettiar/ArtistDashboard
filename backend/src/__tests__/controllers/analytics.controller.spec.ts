import { Request, Response } from 'express';
import { analyticsController } from '../../controllers/analytics.controller';
import { prisma, redis } from '../../utils/database';

jest.mock('../../utils/database');

describe('Analytics Controller', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;

  beforeEach(() => {
    mockRequest = { query: {} };
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    jest.clearAllMocks();
  });

  describe('getRoG (Rate of Growth)', () => {
    it('should return cached RoG data if available', async () => {
      mockRequest.query = { artistId: 'artist-1', period: 'daily' };
      const cachedData = [{ artistId: 'artist-1', rog: 5.2 }];

      (redis.get as jest.Mock).mockResolvedValue(JSON.stringify(cachedData));

      await analyticsController.getRoG(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          cached: true,
          data: cachedData,
        })
      );
    });

    it('should calculate RoG from database if not cached', async () => {
      mockRequest.query = { artistId: 'artist-1', period: 'daily' };

      const mockMetrics = [
        {
          id: 'metric-1',
          artistId: 'artist-1',
          platform: 'INSTAGRAM',
          rogDaily: 2.5,
          rogWeekly: null,
          rogMonthly: null,
          followers: 10000,
          artist: { id: 'artist-1', artistName: 'Artist One' },
        },
      ];

      (redis.get as jest.Mock).mockResolvedValue(null);
      (prisma.platformMetric.findMany as jest.Mock).mockResolvedValue(mockMetrics);
      (redis.setex as jest.Mock).mockResolvedValue('OK');

      await analyticsController.getRoG(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            results: expect.arrayContaining([
              expect.objectContaining({
                rog: 2.5,
                artistName: 'Artist One',
              }),
            ]),
          }),
        })
      );
    });

    it('should filter by platform', async () => {
      mockRequest.query = { platform: 'SPOTIFY', period: 'daily' };

      (redis.get as jest.Mock).mockResolvedValue(null);
      (prisma.platformMetric.findMany as jest.Mock).mockResolvedValue([]);
      (redis.setex as jest.Mock).mockResolvedValue('OK');

      await analyticsController.getRoG(mockRequest as Request, mockResponse as Response);

      expect(prisma.platformMetric.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            platform: 'SPOTIFY',
          }),
        })
      );
    });

    it('should handle different periods', async () => {
      mockRequest.query = { period: 'weekly' };

      const mockMetrics = [
        {
          id: 'metric-1',
          rogDaily: null,
          rogWeekly: 3.2,
          rogMonthly: null,
          artist: { artistName: 'Artist' },
        },
      ];

      (redis.get as jest.Mock).mockResolvedValue(null);
      (prisma.platformMetric.findMany as jest.Mock).mockResolvedValue(mockMetrics);
      (redis.setex as jest.Mock).mockResolvedValue('OK');

      await analyticsController.getRoG(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            results: expect.arrayContaining([
              expect.objectContaining({
                rog: 3.2,
              }),
            ]),
          }),
        })
      );
    });

    it('should filter out null RoG values', async () => {
      mockRequest.query = { period: 'monthly' };

      const mockMetrics = [
        {
          id: 'metric-1',
          rogDaily: 2.5,
          rogWeekly: 3.2,
          rogMonthly: null,
          artist: { artistName: 'Artist' },
        },
      ];

      (redis.get as jest.Mock).mockResolvedValue(null);
      (prisma.platformMetric.findMany as jest.Mock).mockResolvedValue(mockMetrics);
      (redis.setex as jest.Mock).mockResolvedValue('OK');

      await analyticsController.getRoG(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            results: [],
          }),
        })
      );
    });
  });

  describe('getTrends', () => {
    it('should return trend data for chart', async () => {
      mockRequest.query = { metric: 'followers', platform: 'INSTAGRAM' };

      const mockMetrics = [
        {
          id: 'metric-1',
          metricDate: new Date('2025-01-01'),
          followers: 10000,
          likes: 500,
          streams: 1000,
          artistId: 'artist-1',
        },
      ];

      (prisma.platformMetric.findMany as jest.Mock).mockResolvedValue(mockMetrics);

      await analyticsController.getTrends(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            trends: expect.arrayContaining([
              expect.objectContaining({
                date: new Date('2025-01-01'),
                followers: 10000,
              }),
            ]),
          }),
        })
      );
    });

    it('should filter by date range', async () => {
      mockRequest.query = {
        dateFrom: '2025-01-01',
        dateTo: '2025-12-31',
      };

      (prisma.platformMetric.findMany as jest.Mock).mockResolvedValue([]);

      await analyticsController.getTrends(mockRequest as Request, mockResponse as Response);

      expect(prisma.platformMetric.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            metricDate: expect.objectContaining({
              gte: new Date('2025-01-01'),
              lte: new Date('2025-12-31'),
            }),
          }),
        })
      );
    });

    it('should handle partial date range', async () => {
      mockRequest.query = {
        dateFrom: '2025-01-01',
      };

      (prisma.platformMetric.findMany as jest.Mock).mockResolvedValue([]);

      await analyticsController.getTrends(mockRequest as Request, mockResponse as Response);

      expect(prisma.platformMetric.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            metricDate: expect.objectContaining({
              gte: new Date('2025-01-01'),
            }),
          }),
        })
      );
    });

    it('should order trends by date ascending', async () => {
      mockRequest.query = {};

      (prisma.platformMetric.findMany as jest.Mock).mockResolvedValue([]);

      await analyticsController.getTrends(mockRequest as Request, mockResponse as Response);

      expect(prisma.platformMetric.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { metricDate: 'asc' },
        })
      );
    });

    it('should handle database errors', async () => {
      mockRequest.query = {};

      (prisma.platformMetric.findMany as jest.Mock).mockRejectedValue(
        new Error('Database error')
      );

      await expect(
        analyticsController.getTrends(mockRequest as Request, mockResponse as Response)
      ).rejects.toThrow('Database error');
    });
  });

  describe('getTrends (daily window)', () => {
    // Regression: the window used to be measured back from TODAY, so once the
    // newest reading was older than the window (data collected in batches, the
    // last one weeks ago) the 1M chart went blank while 3M still showed data.
    const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
    const row = (iso: string, followers: number) => ({
      metricDate: day(iso), followers, streams: 0, artistId: 'artist-1',
    });

    beforeEach(() => {
      (redis.get as jest.Mock).mockResolvedValue(null);
      (redis.setex as jest.Mock).mockResolvedValue('OK');
    });

    it('anchors the cutoff to the newest reading, not to today', async () => {
      mockRequest.query = { platform: 'youtube', granularity: 'day', days: '30' };
      const newest = day('2026-09-17');
      (prisma.platformMetric.findFirst as jest.Mock).mockResolvedValue({ metricDate: newest });
      (prisma.platformMetric.findMany as jest.Mock).mockResolvedValue([
        row('2026-08-20', 100), row('2026-09-17', 110),
      ]);

      await analyticsController.getTrends(mockRequest as Request, mockResponse as Response);

      const expectedCutoff = new Date(newest);
      expectedCutoff.setDate(expectedCutoff.getDate() - 40); // 30 days + 10 buffer
      expect(prisma.platformMetric.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ platform: 'YOUTUBE', metricDate: { gte: expectedCutoff } }),
        })
      );
      const payload = (mockResponse.json as jest.Mock).mock.calls[0][0];
      expect(payload.data.trends).toHaveLength(2);
      expect(payload.data.trends[1].followers).toBe(110);
    });

    it('still returns points for a 30-day window when the newest reading is weeks old', async () => {
      mockRequest.query = { platform: 'spotify', granularity: 'day', days: '30' };
      (prisma.platformMetric.findFirst as jest.Mock).mockResolvedValue({ metricDate: day('2026-09-17') });
      (prisma.platformMetric.findMany as jest.Mock).mockResolvedValue([row('2026-09-16', 5), row('2026-09-17', 6)]);

      await analyticsController.getTrends(mockRequest as Request, mockResponse as Response);

      const payload = (mockResponse.json as jest.Mock).mock.calls[0][0];
      expect(payload.data.trends.length).toBeGreaterThan(0);
    });

    it('returns an empty list, without querying history, when a platform has no data at all', async () => {
      mockRequest.query = { platform: 'instagram', granularity: 'day', days: '30' };
      (prisma.platformMetric.findFirst as jest.Mock).mockResolvedValue(null);

      await analyticsController.getTrends(mockRequest as Request, mockResponse as Response);

      expect(prisma.platformMetric.findMany).not.toHaveBeenCalled();
      const payload = (mockResponse.json as jest.Mock).mock.calls[0][0];
      expect(payload.data.trends).toEqual([]);
    });

    it('scopes the newest-reading lookup to the requested artist', async () => {
      mockRequest.query = { platform: 'facebook', granularity: 'day', days: '30', artistId: 'artist-9' };
      (prisma.platformMetric.findFirst as jest.Mock).mockResolvedValue({ metricDate: day('2026-09-17') });
      (prisma.platformMetric.findMany as jest.Mock).mockResolvedValue([]);

      await analyticsController.getTrends(mockRequest as Request, mockResponse as Response);

      expect(prisma.platformMetric.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { platform: 'FACEBOOK', artistId: 'artist-9' } })
      );
    });
  });

  describe('getGenres', () => {
    it('should return genre popularity metrics', async () => {
      mockRequest.query = {};

      (redis.get as jest.Mock).mockResolvedValue(null);
      (prisma.genre.findMany as jest.Mock).mockResolvedValue([]);
      (redis.setex as jest.Mock).mockResolvedValue(true);

      await analyticsController.getGenres(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: { genres: [] },
        })
      );
    });
  });

  describe('getDemographicsAge', () => {
    it('should return demographic age breakdown', async () => {
      mockRequest.query = { artistId: 'artist-1' };

      (redis.get as jest.Mock).mockResolvedValue(null);
      (prisma.audienceDemographic.groupBy as jest.Mock).mockResolvedValue([]);
      (redis.setex as jest.Mock).mockResolvedValue(true);

      await analyticsController.getDemographicsAge(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: { breakdown: [] },
        })
      );
    });
  });
});

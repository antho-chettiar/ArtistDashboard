import { Request, Response } from 'express';
import { concertController } from '../../controllers/concert.controller';
import { concertIntelligenceService } from '../../services/concertIntelligence.service';
import { prisma } from '../../utils/database';

describe('Concert Controller', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;

  beforeEach(() => {
    jest.restoreAllMocks();
    mockRequest = { body: {} };
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  });

  describe('runIntelligencePipeline', () => {
    // NOTE: prediction/concert-persistence options (runPredictions,
    // persistConcerts) were removed from this pipeline along with the Node
    // "hybrid-revenue-v1" revenue system (FORMULA_DECISIONS.md §3, System 6).
    // The pipeline now only scrapes, dedupes, normalizes, and validates.
    it('should run artist scrape, dedup, and validation', async () => {
      const summary = {
        scrapedCount: 2,
        normalizedCount: 2,
        persistedCount: 2,
        duplicateCount: 0,
        validatedCount: 2,
        results: [],
        errors: [],
      };

      mockRequest.body = {
        artistIds: ['artist-1'],
        sources: ['bookmyshow', 'invalid-source', 'eventbrite'],
        dateFrom: '2026-05-18',
        dateTo: '2026-08-18',
        country: 'India',
        limitPerSource: '10',
        maxPages: '3',
      };

      const runDiscoveryPipeline = jest
        .spyOn(concertIntelligenceService, 'runDiscoveryPipeline')
        .mockResolvedValue(summary);

      await concertController.runIntelligencePipeline(mockRequest as Request, mockResponse as Response);

      expect(runDiscoveryPipeline).toHaveBeenCalledWith(
        expect.objectContaining({
          artistIds: ['artist-1'],
          sources: ['BOOKMYSHOW', 'EVENTBRITE'],
          country: 'India',
          dateFrom: new Date('2026-05-18'),
          dateTo: new Date('2026-08-18'),
          limitPerSource: 10,
          maxPages: 3,
          dryRun: false,
        })
      );
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: summary,
          message: 'Concert scraping and validation completed successfully',
        })
      );
    });
  });

  describe('list', () => {
    it('should calculate revenue for concerts that do not store totalRevenue', async () => {
      mockRequest.query = { page: '2', limit: '1' };

      (prisma.concert.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'concert-2',
          artistId: 'artist-1',
          concertDate: new Date('2026-05-18'),
          city: 'Mumbai',
          country: 'India',
          venueName: 'NSCI Dome',
          ticketsSold: 120,
          avgTicketPrice: 2500,
          totalRevenue: null,
          artist: {
            id: 'artist-1',
            artistName: 'Artist One',
            nationality: 'India',
          },
        },
      ]);
      (prisma.concert.count as jest.Mock).mockResolvedValue(2);

      await concertController.list(mockRequest as Request, mockResponse as Response);

      expect(prisma.concert.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 1,
          take: 1,
          include: expect.objectContaining({
            predictionOutputs: expect.any(Object),
          }),
        })
      );

      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            concerts: [
              expect.objectContaining({
                totalRevenue: 300000,
              }),
            ],
            pagination: expect.objectContaining({
              page: 2,
              limit: 1,
              total: 2,
            }),
          }),
        })
      );
    });
  });
});

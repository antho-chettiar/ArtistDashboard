import { Response } from 'express';
import { prisma, redis } from '../utils/database';
import { calculateConcertRevenue } from '../utils/concertRevenue';

const CACHE_TTL = 60 * 60; // 1 hour

export const dashboardController = {
  // Get all KPIs for dashboard homepage
  getKPIs: async (_req: any, res: Response) => {
    try {
      const cacheKey = 'dashboard:kpis';
      const cached = await redis.get(cacheKey);
      if (cached) {
        return res.status(200).json({
          success: true,
          data: JSON.parse(cached),
          cached: true,
        });
      }

      const now = new Date();
      const currentYear = now.getFullYear();
      const startOfYear = new Date(currentYear, 0, 1);

      // Total active artists
      const totalArtists = await prisma.artist.count({
        where: { active: true },
      });

      // Total concerts (all time)
      const totalConcerts = await prisma.concert.count();

      // Concert totals YTD
      const concertsYTD = await prisma.concert.findMany({
        where: {
          concertDate: { gte: startOfYear },
        },
        select: {
          totalRevenue: true,
          ticketsSold: true,
          avgTicketPrice: true,
          predictionOutputs: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: {
              expectedRevenue: true,
            },
          },
        },
      });

      const ticketsSoldYTD = concertsYTD.reduce((sum, concert) => sum + (concert.ticketsSold || 0), 0);
      const revenueYTD = concertsYTD.reduce((sum, concert) => sum + calculateConcertRevenue(concert), 0);

      // Avg RoG across all platforms (last 30 days)
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const avgRoG = await prisma.platformMetric.aggregate({
        where: {
          metricDate: { gte: thirtyDaysAgo },
          rogDaily: { not: null },
        },
        _avg: {
          rogDaily: true,
        },
      });

      // Top artist by streams (last month)
      const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      // First, find the artistId with max streams
      const topArtistAgg = await prisma.platformMetric.groupBy({
        by: ['artistId'],
        where: {
          metricDate: { gte: oneMonthAgo },
          platform: 'YOUTUBE',
        },
        _max: {
          streams: true,
        },
        orderBy: {
          _max: {
            streams: 'desc',
          },
        },
        take: 1,
      });

      let topArtistByStreams = null;
      if (topArtistAgg.length > 0) {
        const { artistId, _max } = topArtistAgg[0];
        // Fetch artist details separately
        const artist = await prisma.artist.findUnique({
          where: { id: artistId },
          select: {
            id: true,
            artistName: true,
            photoUrl: true,
          },
        });
        if (artist) {
          topArtistByStreams = {
            id: artist.id,
            name: artist.artistName,
            photoUrl: artist.photoUrl,
            streams: _max.streams || 0,
          };
        }
      }

      const kpis = {
        totalArtists,
        totalConcerts,
        ticketsSoldYTD,
        revenueYTD,
        avgRoGDaily: avgRoG._avg.rogDaily ? parseFloat(avgRoG._avg.rogDaily.toFixed(2)) : 0,
        topArtistByStreams,
      };

      // Cache for 1 hour
      await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(kpis));

      return res.status(200).json({
        success: true,
        data: kpis,
      });
    } catch (error) {
      throw error;
    }
  },

  // Top performing artists by followers
  getTopArtists: async (req: any, res: Response) => {
    try {
      const { limit = 10, platform } = req.query;

      const cacheKey = `dashboard:topArtists:${limit}:${platform || 'all'}`;
      const cached = await redis.get(cacheKey);
      if (cached) {
        return res.status(200).json({
          success: true,
          data: JSON.parse(cached),
          cached: true,
        });
      }

      // Get latest metrics per artist+platform by fetching recent metrics sorted by date
      // We'll fetch metrics from the last 90 days and deduplicate in memory
      const now = new Date();
      const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      const allMetrics = await prisma.platformMetric.findMany({
        where: {
          metricDate: { gte: ninetyDaysAgo },
          ...(platform && { platform: platform.toUpperCase() }),
        },
        orderBy: { metricDate: 'desc' },
        select: {
          artistId: true,
          platform: true,
          followers: true,
          rogDaily: true,
        },
      });

      // Deduplicate: keep only the latest metric for each artist+platform combination
      const latestMap = new Map<string, typeof allMetrics[0]>();
      for (const metric of allMetrics) {
        const key = `${metric.artistId}:${metric.platform}`;
        if (!latestMap.has(key)) {
          latestMap.set(key, metric);
        }
      }
      const latestMetrics = Array.from(latestMap.values());

      // Track Rog values per artist (averaged across platforms)
      const artistRogs: Record<string, number[]> = {};
      for (const metric of latestMetrics) {
        if (metric.rogDaily !== null) {
          if (!artistRogs[metric.artistId]) artistRogs[metric.artistId] = [];
          artistRogs[metric.artistId].push(Number(metric.rogDaily));
        }
      }

      if (latestMetrics.length === 0) {
        // Fallback: Query artists directly and aggregate followers
        const fallbackArtists = await prisma.artist.findMany({
          where: { active: true },
          include: {
            genres: {
              include: { genre: true },
            },
          },
        });

        const fallbackScored = fallbackArtists.map(artist => {
          const totalFollowers = 
            Number(artist.instagramFollowers || 0) +
            Number(artist.youtubeSubscribers || 0) +
            Number(artist.spotifyMonthlyListeners || 0) +
            Number(artist.facebookFollowers || 0);

          // Weighted base score from artist-level fields
          const igF = Number(artist.instagramFollowers || 0);
          const ytF = Number(artist.youtubeSubscribers || 0);
          const spF = Number(artist.spotifyMonthlyListeners || 0);
          const fbF = Number(artist.facebookFollowers || 0);
          const maxFb = Math.max(igF, ytF, spF, fbF, 1);
          const baseScore = (
            (igF / maxFb) * 100 * 0.45 +
            (ytF / maxFb) * 100 * 0.25 +
            (spF / maxFb) * 100 * 0.20 +
            (fbF / maxFb) * 100 * 0.10
          );

          const trendsScore = Number(artist.googleTrendsScore || 0);
          const compositeScore = Math.round(baseScore * 0.50 + trendsScore * 0.25);

          return {
            artistId: artist.id,
            totalFollowers,
            compositeScore,
            // No daily RoG history available in the fallback path → unavailable,
            // not zero.
            avgRogDaily: null,
            rogScore: null,
            platforms: [
              { platform: 'INSTAGRAM', followers: igF },
              { platform: 'YOUTUBE', followers: ytF },
              { platform: 'SPOTIFY', followers: spF },
              { platform: 'FACEBOOK', followers: fbF },
            ],
            artist: artist,
          };
        }).sort((a, b) => b.compositeScore - a.compositeScore).slice(0, parseInt(limit as string));

        await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(fallbackScored));
        return res.status(200).json({
          success: true,
          data: { artists: fallbackScored },
        });
      }

      // Group by artist to sum total followers across platforms
      const artistFollowers: any = {};

      for (const metric of latestMetrics) {
        if (!artistFollowers[metric.artistId]) {
          artistFollowers[metric.artistId] = {
            artistId: metric.artistId,
            totalFollowers: 0,
            platforms: [],
          };
        }

        const followers = Number(metric.followers || 0);
        artistFollowers[metric.artistId].totalFollowers += followers;
        artistFollowers[metric.artistId].platforms.push({
          platform: metric.platform,
          followers: followers,
        });
      }

      // Fetch googleTrendsScore for composite scoring
      const allArtistIds = Object.keys(artistFollowers);
      const artistsWithTrends = await prisma.artist.findMany({
        where: { id: { in: allArtistIds } },
        select: { id: true, googleTrendsScore: true },
      });
      const trendsMap = artistsWithTrends.reduce((acc, a) => {
        acc[a.id] = Number(a.googleTrendsScore || 0);
        return acc;
      }, {} as Record<string, number>);

      // Compute composite score directly from platform metrics:
      //   baseScore (weighted platform followers) × 0.50
      //   + googleTrendsScore × 0.25
      //   + rogScore (avg daily RoG normalized) × 0.25
      const PLATFORM_WEIGHTS: Record<string, number> = {
        INSTAGRAM: 0.45,
        YOUTUBE: 0.25,
        SPOTIFY: 0.20,
        FACEBOOK: 0.10,
      };

      // Find max per-platform for normalization
      const platformMax: Record<string, number> = {};
      for (const item of Object.values(artistFollowers) as any[]) {
        for (const p of item.platforms) {
          const key = String(p.platform).toUpperCase();
          platformMax[key] = Math.max(platformMax[key] || 0, Number(p.followers || 0));
        }
      }

      const scored = Object.values(artistFollowers).map((item: any) => {
        // Build platform follower map
        const platformFollowers: Record<string, number> = {};
        for (const p of item.platforms) {
          platformFollowers[String(p.platform).toUpperCase()] = Number(p.followers || 0);
        }

        // Weighted base score (0-100)
        let baseScore = 0;
        for (const [platform, weight] of Object.entries(PLATFORM_WEIGHTS)) {
          const followers = platformFollowers[platform] || 0;
          const maxF = platformMax[platform] || 1;
          const normalized = maxF > 0 ? (followers / maxF) * 100 : 0;
          baseScore += normalized * weight;
        }
        baseScore = Math.min(100, Math.max(0, baseScore));

        // Google Trends score (0-100)
        const trendsScore = trendsMap[item.artistId] || 0;

        // RoG score: normalize avg daily rog to 0-100
        const rogValues = artistRogs[item.artistId] || [];
        const hasRog = rogValues.length > 0;
        const avgRogRaw = hasRog
          ? rogValues.reduce((a: number, b: number) => a + b, 0) / rogValues.length
          : 0;
        // Log scale: rogDaily of 0.1% → ~30, 0.5% → ~62, 2% → ~92
        const rogScoreValue = avgRogRaw > 0
          ? Math.min(100, Math.round((Math.log(1 + avgRogRaw * 40) / Math.log(81)) * 100))
          : 0;

        const compositeScore = Math.round(
          baseScore * 0.50 + trendsScore * 0.25 + rogScoreValue * 0.25
        );

        // Expose real RoG so the frontend never shows a hardcoded 0. null when
        // no rog data exists for the artist (rendered as "—", not 0).
        return {
          ...item,
          compositeScore,
          avgRogDaily: hasRog ? Number(avgRogRaw.toFixed(4)) : null,
          rogScore: hasRog ? rogScoreValue : null,
        };
      });

      // Sort by composite score (descending)
      const sortedArtists = scored
        .sort((a: any, b: any) => b.compositeScore - a.compositeScore)
        .slice(0, parseInt(limit as string));

      // Enrich with full artist details
      const artistIds = sortedArtists.map((a: any) => a.artistId);
      const artists = await prisma.artist.findMany({
        where: { id: { in: artistIds } },
        include: {
          genres: {
            include: {
              genre: true,
            },
          },
        },
      });

      const artistMap = artists.reduce((acc, artist) => {
        acc[artist.id] = artist;
        return acc;
      }, {} as any);

      const enriched = sortedArtists.map((item: any) => ({
        ...item,
        artist: artistMap[item.artistId],
      }));

      await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(enriched));

      return res.status(200).json({
        success: true,
        data: { artists: enriched },
      });
    } catch (error) {
      throw error;
    }
  },
};

export default dashboardController;

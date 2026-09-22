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

      // Sum only concerts with a real reported value -- a concert with no
      // ticketsSold/revenue on record contributes nothing here rather than a
      // silent 0, so this total is never inflated-looking-complete when it's
      // actually a partial sum. ticketsSoldYTDCount/revenueYTDCount below let
      // the frontend disclose exactly how many of concertsYTD.length concerts
      // that total is actually built from.
      const concertsWithTickets = concertsYTD.filter(c => (c.ticketsSold || 0) > 0);
      const concertsWithRevenue = concertsYTD.filter(c => calculateConcertRevenue(c) > 0);
      const ticketsSoldYTD = concertsWithTickets.reduce((sum, concert) => sum + (concert.ticketsSold || 0), 0);
      const revenueYTD = concertsWithRevenue.reduce((sum, concert) => sum + calculateConcertRevenue(concert), 0);
      const ticketsSoldYTDCount = concertsWithTickets.length;
      const revenueYTDCount = concertsWithRevenue.length;

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
        ticketsSoldYTDCount,
        revenueYTD,
        revenueYTDCount,
        concertsYTDCount: concertsYTD.length,
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

  // Top performing artists.
  // Popularity ("compositeScore") is the canonical MAD Analytics Popularity
  // score (mad_analytics/popularity/calculator.py), fetched in one batch call —
  // this endpoint no longer computes its own independent composite score.
  // RoG (avgRogDaily/rogScore) is a separate, unrelated display stat and is
  // still computed here from platform_metrics as before.
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

      // Track Rog values per artist (averaged across platforms) — display-only,
      // unrelated to the Popularity score below.
      const artistRogs: Record<string, number[]> = {};
      for (const metric of latestMetrics) {
        if (metric.rogDaily !== null) {
          if (!artistRogs[metric.artistId]) artistRogs[metric.artistId] = [];
          artistRogs[metric.artistId].push(Number(metric.rogDaily));
        }
      }

      // Candidate artist list with follower/platform breakdown. When no recent
      // PlatformMetric rows exist, fall back to the Artist table's own follower
      // columns for the breakdown (no score is computed from them either way).
      let candidates: Array<{ artistId: string; totalFollowers: number; platforms: Array<{ platform: string; followers: number }> }>;

      if (latestMetrics.length === 0) {
        const fallbackArtists = await prisma.artist.findMany({
          where: { active: true },
          include: { genres: { include: { genre: true } } },
        });

        candidates = fallbackArtists.map(artist => {
          const igF = Number(artist.instagramFollowers || 0);
          const ytF = Number(artist.youtubeSubscribers || 0);
          const spF = Number(artist.spotifyMonthlyListeners || 0);
          const fbF = Number(artist.facebookFollowers || 0);
          return {
            artistId: artist.id,
            totalFollowers: igF + ytF + spF + fbF,
            platforms: [
              { platform: 'INSTAGRAM', followers: igF },
              { platform: 'YOUTUBE', followers: ytF },
              { platform: 'SPOTIFY', followers: spF },
              { platform: 'FACEBOOK', followers: fbF },
            ],
          };
        });
      } else {
        const artistFollowers: Record<string, { artistId: string; totalFollowers: number; platforms: Array<{ platform: string; followers: number }> }> = {};
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
          artistFollowers[metric.artistId].platforms.push({ platform: metric.platform, followers });
        }
        candidates = Object.values(artistFollowers);
      }

      // Canonical Popularity -- read from artists.popularity (weekly-cache-
      // plus-manual-sync design, 2026-09), the same column the background
      // scheduler and the "Sync Now" button both keep fresh. This used to
      // make its own live call to the Python engine on every Dashboard load
      // (15-22s, and the whole reason this endpoint felt "broken" whenever
      // that live call timed out or the DB connection pool was under
      // pressure) -- normal page loads now never wait on a live computation.
      // Never fabricated: an artist with no stored score yet gets
      // compositeScore = null, rendered by the frontend as "—".
      const popularityArtists = await prisma.artist.findMany({
        where: { id: { in: candidates.map(c => c.artistId) } },
        select: { id: true, popularity: true },
      });
      const popularityByArtist: Record<string, number> = {};
      for (const a of popularityArtists) {
        if (a.popularity != null) popularityByArtist[a.id] = Number(a.popularity);
      }

      const scored = candidates.map(item => {
        const rogValues = artistRogs[item.artistId] || [];
        const hasRog = rogValues.length > 0;
        const avgRogRaw = hasRog
          ? rogValues.reduce((a, b) => a + b, 0) / rogValues.length
          : 0;
        // Log scale: rogDaily of 0.1% → ~30, 0.5% → ~62, 2% → ~92 (display only)
        const rogScoreValue = avgRogRaw > 0
          ? Math.min(100, Math.round((Math.log(1 + avgRogRaw * 40) / Math.log(81)) * 100))
          : 0;

        const popularityScore = popularityByArtist[item.artistId];

        return {
          ...item,
          compositeScore: Number.isFinite(popularityScore) ? popularityScore : null,
          avgRogDaily: hasRog ? Number(avgRogRaw.toFixed(4)) : null,
          rogScore: hasRog ? rogScoreValue : null,
        };
      });

      // Sort artists with a real popularity score first (descending); artists
      // without one (score engine had no data / was unavailable) sort after,
      // ordered by total followers only for a stable list — never given a
      // fabricated score.
      const sortedArtists = scored
        .sort((a, b) => {
          if (a.compositeScore != null && b.compositeScore != null) return b.compositeScore - a.compositeScore;
          if (a.compositeScore != null) return -1;
          if (b.compositeScore != null) return 1;
          return b.totalFollowers - a.totalFollowers;
        })
        .slice(0, parseInt(limit as string));

      // Enrich with full artist details
      const artistIds = sortedArtists.map((a) => a.artistId);
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

      const enriched = sortedArtists.map((item) => ({
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

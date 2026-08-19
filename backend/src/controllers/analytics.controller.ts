import { Response } from 'express';
import { prisma, redis } from '../utils/database';

const CACHE_TTL = 60 * 60; // 1 hour

export const analyticsController = {
  // Rate of Growth (RoG) for artist(s)
  getRoG: async (req: any, res: Response) => {
    try {
      const { artistId, platform, period = 'daily' } = req.query;

      const cacheKey = `rog:${artistId || 'all'}:${platform || 'all'}:${period}`;
      const cached = await redis.get(cacheKey);
      if (cached) {
        return res.status(200).json({ success: true, data: JSON.parse(cached), cached: true });
      }

      const where: any = {};
      if (artistId) where.artistId = artistId;
      if (platform) where.platform = platform.toUpperCase();

      const metrics = await prisma.platformMetric.findMany({
        where,
        orderBy: { metricDate: 'desc' },
        take: 1000,
        include: {
          artist: { select: { id: true, artistName: true } },
        },
      });

      const results = metrics.map((metric) => {
        const rogField = period === 'daily' ? metric.rogDaily
          : period === 'weekly' ? metric.rogWeekly
          : metric.rogMonthly;
        return {
          id: metric.id,
          artistId: metric.artistId,
          artistName: metric.artist.artistName,
          platform: metric.platform,
          metricDate: metric.metricDate,
          followers: metric.followers,
          rog: rogField,
        };
      }).filter((r) => r.rog !== null);

      await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(results));
      return res.status(200).json({ success: true, data: { results } });
    } catch (error) {
      throw error;
    }
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Platform Growth Trends — aggregated monthly totals per platform
  // Used by Dashboard "Platform Growth Trends" line chart
  //
  // Query params:
  //   platform  — INSTAGRAM | YOUTUBE | SPOTIFY  (required)
  //   months    — how many months back to fetch  (default: 12)
  //   artistId  — optional, filter to one artist
  //
  // Returns array of { date: 'Jan 2025', followers: 123456789 }
  // sorted oldest → newest so the chart reads left-to-right correctly.
  // ─────────────────────────────────────────────────────────────────────────
  getTrends: async (req: any, res: Response) => {
    try {
      const {
        platform,
        months = '12',
        artistId,
        granularity,
        days = '30',
        // legacy params — kept for backwards compat but ignored in new logic
        metric,
        dateFrom,
        dateTo,
      } = req.query;

      const useLegacyTrends = Boolean(metric || dateFrom || dateTo);

      // ── Daily granularity path (real dated points, no month bucketing) ──
      // Used by the short-range (7D/15D/30D) charts. Anchors to the LAST
      // available days of data (not "now"), so ranges stay populated even when
      // ingestion is a few days behind. Never pads or fabricates missing dates.
      if (platform && !useLegacyTrends && String(granularity) === 'day') {
        const platformUpper = String(platform).toUpperCase();
        const dayCount = Math.min(Math.max(parseInt(days as string) || 30, 1), 400);

        const cacheKey = `trends:day:${platformUpper}:${dayCount}:${artistId || 'all'}`;
        const cached = await redis.get(cacheKey);
        if (cached) {
          return res.status(200).json({ success: true, data: { trends: JSON.parse(cached) }, cached: true });
        }

        const where: any = { platform: platformUpper };
        if (artistId) where.artistId = String(artistId);

        const rows = await prisma.platformMetric.findMany({
          where,
          orderBy: { metricDate: 'asc' },
          select: { metricDate: true, followers: true, streams: true },
        });

        const streamPlatforms = new Set(['SPOTIFY', 'APPLE_MUSIC']);
        const useStreams = streamPlatforms.has(platformUpper);

        // Sum across artists per real calendar day (aggregate roster reach).
        const byDay: Record<string, { total: number; date: Date }> = {};
        for (const row of rows) {
          const d = new Date(row.metricDate);
          const key = d.toISOString().slice(0, 10); // YYYY-MM-DD
          const value = Number(useStreams ? row.streams : row.followers) || 0;
          if (!byDay[key]) byDay[key] = { total: 0, date: d };
          byDay[key].total += value;
        }

        const allDays = Object.values(byDay)
          .sort((a, b) => a.date.getTime() - b.date.getTime())
          .map(({ total, date }) => ({
            date: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), // "Jul 5"
            followers: total,
          }));

        // Only the last N days that actually have data — no padding.
        const trends = allDays.slice(-dayCount);
        await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(trends));
        return res.status(200).json({ success: true, data: { trends } });
      }

      // ── New aggregated path (used by Dashboard chart) ──────────────────
      if (platform && !useLegacyTrends) {
        const platformUpper = String(platform).toUpperCase();
        const monthCount = Math.min(parseInt(months as string) || 12, 36);

        const cacheKey = `trends:agg:${platformUpper}:${monthCount}:${artistId || 'all'}`;
        const cached = await redis.get(cacheKey);
        if (cached) {
          return res.status(200).json({ success: true, data: { trends: JSON.parse(cached) }, cached: true });
        }

        const cutoff = new Date();
        cutoff.setMonth(cutoff.getMonth() - monthCount);

        const where: any = {
          platform: platformUpper,
          metricDate: { gte: cutoff },
        };
        if (artistId) where.artistId = String(artistId);

        // Fetch raw rows — one row per artist per day
        const rows = await prisma.platformMetric.findMany({
          where,
          orderBy: { metricDate: 'asc' },
          select: {
            metricDate: true,
            followers: true,
            streams: true,
          },
        });

        // Pick the right metric per platform:
        //   Spotify / Apple Music → streams
        //   everything else       → followers
        const streamPlatforms = new Set(['SPOTIFY', 'APPLE_MUSIC']);
        const useStreams = streamPlatforms.has(platformUpper);

        // Aggregate by "Mon YYYY" so Jan 2024 and Jan 2025 never collide
        const byMonth: Record<string, { total: number; date: Date }> = {};

        for (const row of rows) {
          const d = new Date(row.metricDate);
          const key = d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }); // "Jan 2025"
          const value = Number(useStreams ? row.streams : row.followers) || 0;

          if (!byMonth[key]) {
            byMonth[key] = { total: 0, date: d };
          }
          byMonth[key].total += value;
        }

        // Sort chronologically and shape for the chart
        const trends = Object.entries(byMonth)
          .sort((a, b) => a[1].date.getTime() - b[1].date.getTime())
          .map(([label, { total }]) => ({
            date: label,             // "Jan 2025"
            followers: total,        // key the LineChart uses (kept as 'followers' to match existing chart config)
          }));

        await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(trends));
        return res.status(200).json({ success: true, data: { trends } });
      }

      // ── Legacy path (no platform param) — kept for other consumers ─────
      const where: any = {};
      if (artistId) where.artistId = artistId;
      if (dateFrom || dateTo) {
        where.metricDate = {};
        if (dateFrom) where.metricDate.gte = new Date(dateFrom as string);
        if (dateTo) where.metricDate.lte = new Date(dateTo as string);
      }

      const metrics = await prisma.platformMetric.findMany({
        where,
        orderBy: { metricDate: 'asc' },
        take: 1000,
      });

      const requestedMetric = metric || 'followers';
      const trends = metrics.map((m) => {
        const point: any = { date: m.metricDate };
        point[requestedMetric as string] = (m as any)[requestedMetric as string] || 0;
        point.followers = m.followers;
        point.likes = m.likes;
        point.streams = m.streams;
        point.artistId = m.artistId;
        return point;
      });

      return res.status(200).json({ success: true, data: { trends } });
    } catch (error) {
      throw error;
    }
  },

  // Demographics: Age group breakdown
  getDemographicsAge: async (req: any, res: Response) => {
    try {
      const { artistId, concertId } = req.query;

      const cacheKey = `demo:age:${artistId || 'all'}:${concertId || 'all'}`;
      const cached = await redis.get(cacheKey);
      if (cached) {
        return res.status(200).json({ success: true, data: JSON.parse(cached), cached: true });
      }

      const where: any = { dimension: 'AGE_GROUP' };
      if (artistId) where.artistId = artistId;
      if (concertId) where.concertId = concertId;

      const data = await prisma.audienceDemographic.groupBy({
        by: ['dimensionValue'],
        where,
        _sum: { absoluteCount: true },
        _avg: { percentage: true },
        orderBy: { _sum: { absoluteCount: 'desc' } },
      });

      await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(data));
      return res.status(200).json({ success: true, data: { breakdown: data } });
    } catch (error) {
      throw error;
    }
  },

  // Demographics: Gender distribution
  getDemographicsGender: async (req: any, res: Response) => {
    try {
      const { artistId, concertId } = req.query;

      const cacheKey = `demo:gender:${artistId || 'all'}:${concertId || 'all'}`;
      const cached = await redis.get(cacheKey);
      if (cached) {
        return res.status(200).json({ success: true, data: JSON.parse(cached), cached: true });
      }

      const where: any = { dimension: 'GENDER' };
      if (artistId) where.artistId = artistId;
      if (concertId) where.concertId = concertId;

      const data = await prisma.audienceDemographic.groupBy({
        by: ['dimensionValue'],
        where,
        _sum: { absoluteCount: true },
        _avg: { percentage: true },
        orderBy: { _sum: { absoluteCount: 'desc' } },
      });

      await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(data));
      return res.status(200).json({ success: true, data: { breakdown: data } });
    } catch (error) {
      throw error;
    }
  },

  // Demographics: Geographic distribution (for map)
  getDemographicsGeo: async (req: any, res: Response) => {
    try {
      const { artistId, concertId } = req.query;

      const where: any = { dimension: 'GEOGRAPHY' };
      if (artistId) where.artistId = artistId;
      if (concertId) where.concertId = concertId;

      const data = await prisma.audienceDemographic.groupBy({
        by: ['dimensionValue'],
        where,
        _sum: { absoluteCount: true },
        orderBy: { _sum: { absoluteCount: 'desc' } },
        take: 100,
      });

      const features = data.map((item, index) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [0, 0] },
        properties: {
          name: item.dimensionValue,
          count: item._sum.absoluteCount || 0,
          rank: index + 1,
        },
      }));

      return res.status(200).json({
        success: true,
        data: { type: 'FeatureCollection', features },
      });
    } catch (error) {
      throw error;
    }
  },

  // Genre popularity
  getGenres: async (req: any, res: Response) => {
    try {
      const { artistId } = req.query;

      const cacheKey = `genres:${artistId || 'all'}`;
      const cached = await redis.get(cacheKey);
      if (cached) {
        return res.status(200).json({ success: true, data: JSON.parse(cached), cached: true });
      }

      const genres = await prisma.genre.findMany({
        include: { _count: { select: { artists: true } } },
        orderBy: { artists: { _count: 'desc' } },
      });

      const enrichedGenres = await Promise.all(
        genres.map(async (genre) => {
          const artistsInGenre = await prisma.artist.findMany({
            where: { genres: { some: { genreId: genre.id } } },
            select: { id: true },
          });
          const artistIds = artistsInGenre.map((a) => a.id);

          const latestMetrics = await prisma.platformMetric.groupBy({
            by: ['artistId'],
            where: { artistId: { in: artistIds } },
            _max: { metricDate: true, followers: true },
          });

          const totalFollowers = latestMetrics.reduce(
            (sum, m) => sum + Number(m._max.followers || 0), 0
          );

          return {
            genreId: genre.id,
            genreName: genre.name,
            artistCount: genre._count.artists,
            totalFollowers,
          };
        })
      );

      await redis.setex(cacheKey, CACHE_TTL, JSON.stringify({ genres: enrichedGenres }));
      return res.status(200).json({ success: true, data: { genres: enrichedGenres } });
    } catch (error) {
      throw error;
    }
  },
};

export default analyticsController;
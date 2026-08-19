import { prisma } from '../utils/database';

const ANALYTICS_URL = process.env.ANALYTICS_URL ?? 'http://localhost:8001';
const DEFAULT_COUNTRY = 'India';
const ANALYTICS_TIMEOUT_MS = Number(process.env.ANALYTICS_TIMEOUT_MS) || 12_000;

/**
 * Raised when the Python analytics service (ANALYTICS_URL) cannot produce a
 * result — it is unreachable, timed out, or returned a non-2xx status.
 * Controllers can detect this to return an explicit "analytics unavailable"
 * state instead of a generic 500 (and the frontend must NOT fabricate a value).
 */
export class AnalyticsUnavailableError extends Error {
  constructor(
    message: string,
    public readonly reason: 'timeout' | 'network' | 'status',
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'AnalyticsUnavailableError';
  }
}

/**
 * Single hardened entry point to the canonical Python analytics engine.
 * Adds an AbortController timeout (no more indefinite hangs when the Render
 * service is cold/asleep) and normalizes every failure into
 * AnalyticsUnavailableError. This is the ONLY way this module talks to the
 * analytics service — we deliberately keep one engine, not two.
 */
const postAnalytics = async <T = unknown>(path: string, body?: unknown): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANALYTICS_TIMEOUT_MS);
  try {
    const res = await fetch(`${ANALYTICS_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AnalyticsUnavailableError(
        `Analytics ${path} returned ${res.status}${text ? ` ${text}` : ''}`,
        'status',
        res.status,
      );
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof AnalyticsUnavailableError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AnalyticsUnavailableError(
        `Analytics ${path} timed out after ${ANALYTICS_TIMEOUT_MS}ms`,
        'timeout',
      );
    }
    throw new AnalyticsUnavailableError(
      `Analytics ${path} unreachable: ${err instanceof Error ? err.message : String(err)}`,
      'network',
    );
  } finally {
    clearTimeout(timer);
  }
};

/**
 * GET counterpart to postAnalytics — same timeout + error normalization.
 * Used for read endpoints like /popularity/all (batch cohort scores).
 */
const getAnalytics = async <T = unknown>(path: string, timeoutMs = ANALYTICS_TIMEOUT_MS): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${ANALYTICS_URL}${path}`, { method: 'GET', signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AnalyticsUnavailableError(
        `Analytics ${path} returned ${res.status}${text ? ` ${text}` : ''}`,
        'status',
        res.status,
      );
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof AnalyticsUnavailableError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AnalyticsUnavailableError(`Analytics ${path} timed out after ${timeoutMs}ms`, 'timeout');
    }
    throw new AnalyticsUnavailableError(
      `Analytics ${path} unreachable: ${err instanceof Error ? err.message : String(err)}`,
      'network',
    );
  } finally {
    clearTimeout(timer);
  }
};

export interface MetricRow {
  platform: string;
  metricDate?: string | Date;
  date?: string | Date;
  followers?: number;
  streams?: number;
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
}

interface AnalyticsConcertPayload {
  concert_id: string;
  artist_id: string;
  city: string;
  country: string;
  venue_name?: string;
  venue_type?: string;
  venue_capacity: number;
  ticket_price_min: number;
  ticket_price_max: number;
  date: string;
  actual_revenue?: number;
  tickets_sold?: number;
}

interface AnalyticsRevenuePayload {
  concert: AnalyticsConcertPayload;
  platform_metrics: MetricRow[];
  demand_score?: number;
}

export interface LlmPredictorPayload {
  artist_id?: string;
  artist_name?: string;
  artist_popularity?: number;
  artist_city_popularity?: number;
  venue_name?: string;
  venue_capacity?: number;
  city?: string;
  country?: string;
  currency?: string;
  venue_type?: string;
}

export interface RevenuePayload {
  artist_id?: string;
  artist_name?: string;
  artist?: string;
  capacity?: number;
  venue_capacity?: number;
  venue_name?: string;
  venue_type?: string;
  ticket_price?: number;
  avg_ticket_price?: number;
  event_date?: string;
  date?: string;
  city?: string;
  country?: string;
  past_shows?: number;
  avg_past_revenue?: number;
  spotify_followers?: number;
  instagram_followers?: number;
  youtube_subscribers?: number;
  demand_score?: number;
  concert?: AnalyticsConcertPayload;
  platform_metrics?: MetricRow[];
}

export interface DemandPayload {
  artist_id?: string;
  artist_name?: string;
  city?: string;
  country?: string;
  target_city?: string;
  target_country?: string;
  target_date?: string;
  platform_metrics?: MetricRow[];
  recent_concerts?: AnalyticsConcertPayload[];
  spotify_followers?: number;
  instagram_followers?: number;
  youtube_subscribers?: number;
  past_shows_in_city?: number;
  days_since_last_show?: number;
}

export interface VenueCapacityPayload {
  venue_name: string;
  city?: string;
  country?: string;
  venue_type?: string;
  artist_tier?: string;
  supplied_capacity?: number;
  source_texts?: string[];
  persist?: boolean;
}

type ArtistWithMetrics = Record<string, unknown> & {
  id?: string;
  artistName?: string | null;
  platformMetrics?: Array<Record<string, unknown>>;
};

const toFiniteNumber = (value: unknown, fallback = 0): number => {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  if (value && typeof value === 'object' && 'toString' in value) {
    const parsed = Number(String(value));
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
};

const average = (values: number[], fallback: number): number => {
  const valid = values.filter((value) => Number.isFinite(value) && value > 0);
  if (!valid.length) return fallback;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
};

const normalizePlatform = (platform: string): string => {
  return platform.toLowerCase().replace(/-/g, '_').replace(/\s+/g, '_');
};

const metricDate = (metric: MetricRow): string => {
  const value = metric.date ?? metric.metricDate ?? new Date();
  return new Date(value).toISOString().slice(0, 10);
};

const toAnalyticsMetric = (metric: MetricRow): MetricRow => {
  const platform = normalizePlatform(metric.platform);
  const followers = toFiniteNumber(metric.followers);
  const streams = toFiniteNumber(metric.streams);
  const views = toFiniteNumber(metric.views, platform === 'youtube' ? streams || followers : 0);

  return {
    date: metricDate(metric),
    platform,
    followers,
    streams,
    views,
    likes: toFiniteNumber(metric.likes),
    comments: toFiniteNumber(metric.comments),
    shares: toFiniteNumber(metric.shares),
  };
};

const snapshotMetricSeeds = (artist: Record<string, unknown> | null, payload: RevenuePayload) => {
  return [
    {
      platform: 'spotify',
      followers: toFiniteNumber(payload.spotify_followers, toFiniteNumber(artist?.spotifyMonthlyListeners, 50_000)),
      streams: toFiniteNumber(artist?.spotifyMonthlyListeners, toFiniteNumber(payload.spotify_followers, 50_000)),
    },
    {
      platform: 'instagram',
      followers: toFiniteNumber(payload.instagram_followers, toFiniteNumber(artist?.instagramFollowers, 30_000)),
    },
    {
      platform: 'youtube',
      followers: toFiniteNumber(payload.youtube_subscribers, toFiniteNumber(artist?.youtubeSubscribers, 20_000)),
      views: toFiniteNumber(artist?.youtubeSubscribers, toFiniteNumber(payload.youtube_subscribers, 20_000)),
    },
    {
      platform: 'facebook',
      followers: toFiniteNumber(artist?.facebookFollowers),
    },
    {
      platform: 'twitter',
      followers: toFiniteNumber(artist?.twitterFollowers),
    },
    {
      platform: 'apple_music',
    }
  ].filter((seed) => Object.values(seed).some((value) => typeof value === 'number' && value > 0));
};

const synthesizeMetrics = (
  artist: Record<string, unknown> | null,
  payload: RevenuePayload,
  endDate: Date
): MetricRow[] => {
  const seeds = snapshotMetricSeeds(artist, payload);
  const rows: MetricRow[] = [];

  for (const seed of seeds.length ? seeds : [{ platform: 'spotify', followers: 50_000, streams: 50_000 }]) {
    for (let offset = 13; offset >= 0; offset -= 1) {
      const date = new Date(endDate);
      date.setUTCDate(date.getUTCDate() - offset);
      const growth = 1 - offset * 0.006;
      rows.push({
        date: date.toISOString().slice(0, 10),
        platform: seed.platform,
        followers: Math.max(0, Math.round(toFiniteNumber(seed.followers) * growth)),
        streams: Math.max(0, Math.round(toFiniteNumber(seed.streams) * growth)),
        views: Math.max(0, Math.round(toFiniteNumber(seed.views, toFiniteNumber(seed.streams)) * growth)),
        likes: Math.max(0, Math.round(toFiniteNumber(seed.followers, toFiniteNumber(seed.streams)) * growth * 0.01)),
        comments: Math.max(0, Math.round(toFiniteNumber(seed.followers, toFiniteNumber(seed.streams)) * growth * 0.001)),
        shares: Math.max(0, Math.round(toFiniteNumber(seed.followers, toFiniteNumber(seed.streams)) * growth * 0.0005)),
      });
    }
  }

  return rows;
};

const ticketRangeFromAverage = (avgTicketPrice: number): { min: number; max: number } => {
  const avg = Math.max(1, avgTicketPrice);
  return {
    min: Math.round(avg * 0.75 * 100) / 100,
    max: Math.round(avg * 1.85 * 100) / 100,
  };
};

const defaultEventDate = (): string => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 30);
  return date.toISOString().slice(0, 10);
};

const resolveArtist = async (payload: {
  artist_id?: string;
  artist_name?: string;
  artist?: string;
}): Promise<ArtistWithMetrics | null> => {
  const include = { platformMetrics: { orderBy: { metricDate: 'desc' as const }, take: 120 } };

  if (payload.artist_id) {
    return prisma.artist.findUnique({
      where: { id: payload.artist_id },
      include,
    }) as Promise<ArtistWithMetrics | null>;
  }

  const name = payload.artist_name || payload.artist;
  if (!name) return null;

  return prisma.artist.findFirst({
    where: { artistName: { equals: String(name), mode: 'insensitive' } },
    include,
  }) as Promise<ArtistWithMetrics | null>;
};

const metricsFromArtist = (artist: ArtistWithMetrics | null): MetricRow[] => {
  return (artist?.platformMetrics ?? [])
    .slice()
    .reverse()
    .map((metric) => toAnalyticsMetric({
      date: metric.metricDate as string | Date,
      platform: String(metric.platform),
      followers: toFiniteNumber(metric.followers),
      streams: toFiniteNumber(metric.streams),
      likes: toFiniteNumber(metric.likes),
      comments: toFiniteNumber(metric.comments),
      shares: toFiniteNumber(metric.shares),
    }));
};

const buildPlatformMetrics = (
  artist: ArtistWithMetrics | null,
  payload: RevenuePayload | DemandPayload,
  endDate: Date
): MetricRow[] => {
  const dbMetrics = metricsFromArtist(artist);
  const syntheticMetrics = synthesizeMetrics(artist, payload, endDate);
  return [...dbMetrics, ...syntheticMetrics];
};

/**
 * Real, DB-backed platform metrics only — NO synthetic rows.
 * Used by the Popularity and Growth endpoints so that Momentum is computed
 * from genuine history. When an artist has only a current snapshot (or no
 * metrics), the series is empty/short and the Python engine renormalizes
 * Momentum out (Blueprint v2.0), rather than us fabricating a growth curve.
 */
const realPlatformMetrics = (artist: ArtistWithMetrics | null): MetricRow[] =>
  metricsFromArtist(artist);

const toAnalyticsConcert = (
  concert: Record<string, unknown>,
  artistId: string,
  fallbackCity: string,
  fallbackCountry: string
): AnalyticsConcertPayload => {
  const avgPrice = toFiniteNumber(concert.avgTicketPrice, 1_250);
  const fallbackRange = ticketRangeFromAverage(avgPrice);

  return {
    concert_id: String(concert.id || `concert-${artistId}-${fallbackCity}`),
    artist_id: artistId,
    city: String(concert.city || fallbackCity),
    country: String(concert.country || fallbackCountry || DEFAULT_COUNTRY),
    venue_name: concert.venueName ? String(concert.venueName) : undefined,
    venue_capacity: Math.max(1, Math.round(toFiniteNumber(concert.capacity, 5_000))),
    ticket_price_min: toFiniteNumber(concert.ticketPriceTier3, fallbackRange.min),
    ticket_price_max: toFiniteNumber(concert.ticketPriceVip, fallbackRange.max),
    date: new Date(String(concert.concertDate || new Date())).toISOString().slice(0, 10),
    actual_revenue: toFiniteNumber(concert.totalRevenue),
    tickets_sold: Math.round(toFiniteNumber(concert.ticketsSold)),
  };
};

const fetchRecentConcerts = async (
  artistId: string | undefined,
  city: string,
  country: string
): Promise<AnalyticsConcertPayload[]> => {
  const concerts = await prisma.concert.findMany({
    where: {
      ...(artistId ? { artistId } : {}),
      ...(city ? { city: { equals: city, mode: 'insensitive' as const } } : {}),
      ...(country ? { country: { equals: country, mode: 'insensitive' as const } } : {}),
    },
    orderBy: { concertDate: 'desc' },
    take: 20,
  });

  return concerts.map((concert) => toAnalyticsConcert(
    concert as unknown as Record<string, unknown>,
    artistId || String(concert.artistId),
    city,
    country
  ));
};

const reachPopularity = (artist: ArtistWithMetrics | null): number => {
  if (!artist) return 50;
  const reach = [
    artist.spotifyMonthlyListeners,
    artist.youtubeSubscribers,
    artist.instagramFollowers,
    artist.facebookFollowers,
    artist.twitterFollowers,
    artist.appleMusicListeners
  ].map((value) => toFiniteNumber(value));
  const totalReach = reach.reduce((sum, value) => sum + value, 0);
  if (totalReach <= 0) return 50;
  return Math.min(95, Math.max(5, Math.round(Math.log10(totalReach + 1) * 12)));
};

const buildDemandPayload = async (payload: DemandPayload) => {
  const city = payload.city || payload.target_city;
  if (!city) throw new Error('city or target_city is required');

  const country = payload.country || payload.target_country || DEFAULT_COUNTRY;
  const targetDate = new Date(payload.target_date || defaultEventDate());
  const artist = await resolveArtist(payload);
  const artistId = artist?.id || payload.artist_id || 'frontend-artist';

  return {
    artist_id: artistId,
    city,
    country,
    target_date: targetDate.toISOString().slice(0, 10),
    // Real metrics only — no synthetic rows. Momentum (0.35 of Demand) must come
    // from genuine platform history. If an artist has too little real history the
    // Python DemandInput contract (min 7 rows) is unmet and the endpoint reports
    // unavailable — we never fabricate a growth curve to force a number.
    platform_metrics: payload.platform_metrics?.length
      ? payload.platform_metrics.map(toAnalyticsMetric)
      : realPlatformMetrics(artist),
    recent_concerts: payload.recent_concerts?.length
      ? payload.recent_concerts
      : await fetchRecentConcerts(artist?.id || payload.artist_id, city, country),
  };
};

const buildRevenuePayload = async (payload: RevenuePayload): Promise<AnalyticsRevenuePayload> => {
  if (payload.concert && payload.platform_metrics?.length) {
    return {
      concert: payload.concert,
      platform_metrics: payload.platform_metrics.map(toAnalyticsMetric),
      demand_score: payload.demand_score,
    };
  }

  if (!payload.city) {
    throw new Error('city is required');
  }

  const artist = await resolveArtist(payload);

  const historicalConcerts = await prisma.concert.findMany({
    where: {
      ...(artist?.id ? { artistId: artist.id } : {}),
      city: { equals: payload.city, mode: 'insensitive' },
      ...(payload.country ? { country: { equals: payload.country, mode: 'insensitive' } } : {}),
    },
    select: { capacity: true, avgTicketPrice: true, ticketPriceTier3: true, ticketPriceVip: true },
    take: 50,
  });

  const eventDate = new Date(payload.event_date || payload.date || defaultEventDate());
  const venueCapacity = Math.round(
    toFiniteNumber(
      payload.venue_capacity,
      toFiniteNumber(payload.capacity, average(historicalConcerts.map((concert) => toFiniteNumber(concert.capacity)), 5_000))
    )
  );
  const avgTicketPrice = toFiniteNumber(
    payload.avg_ticket_price,
    toFiniteNumber(
      payload.ticket_price,
      average(historicalConcerts.map((concert) => toFiniteNumber(concert.avgTicketPrice)), 1_250)
    )
  );
  const historicalMin = average(historicalConcerts.map((concert) => toFiniteNumber(concert.ticketPriceTier3)), 0);
  const historicalMax = average(historicalConcerts.map((concert) => toFiniteNumber(concert.ticketPriceVip)), 0);
  const fallbackRange = ticketRangeFromAverage(avgTicketPrice);
  const platformMetrics = buildPlatformMetrics(artist, payload, eventDate);

  return {
    concert: {
      concert_id: `frontend-${artist?.id || payload.artist_id || 'artist'}-${payload.city}-${eventDate.toISOString().slice(0, 10)}`,
      artist_id: artist?.id || payload.artist_id || 'frontend-artist',
      city: payload.city,
      country: payload.country || DEFAULT_COUNTRY,
      venue_name: payload.venue_name,
      venue_type: payload.venue_type,
      venue_capacity: Math.max(100, venueCapacity),
      ticket_price_min: historicalMin || fallbackRange.min,
      ticket_price_max: historicalMax || fallbackRange.max,
      date: eventDate.toISOString().slice(0, 10),
    },
    platform_metrics: platformMetrics,
    demand_score: payload.demand_score,
  };
};

export const madAnalyticsService = {
  getRevenuePrediction: async (payload: RevenuePayload) => {
    try {
      const analyticsPayload = await buildRevenuePayload(payload);
      const prediction = await postAnalytics<Record<string, unknown>>('/revenue', analyticsPayload);
      return {
        ...prediction,
        model_source: 'mad_analytics.revenue.predictor',
        inputs: {
          venue_capacity: analyticsPayload.concert.venue_capacity,
          avg_ticket_price:
            analyticsPayload.concert.ticket_price_min +
            (analyticsPayload.concert.ticket_price_max - analyticsPayload.concert.ticket_price_min) * 0.235,
          city: analyticsPayload.concert.city,
          country: analyticsPayload.concert.country,
          event_date: analyticsPayload.concert.date,
        },
        // Currency fields are now included from the Python response:
        // currency, predicted_revenue_usd, lower_bound_usd, upper_bound_usd, exchange_rate
      };
    } catch (error) {
      console.error('Error fetching revenue prediction from mad_analytics:', error);
      throw error;
    }
  },

  getLlmPrediction: async (payload: LlmPredictorPayload) => {
    try {
      const artist = await resolveArtist(payload);

      // Resolve currency from country if not explicitly provided
      let currency = payload.currency;
      if (!currency && payload.country) {
        const { currencyConversionService } = await import('./currency/currencyConversion.service.js');
        currency = currencyConversionService.resolveCurrency(payload.country);
      }

      const body = {
        ...payload,
        artist_popularity: payload.artist_popularity ?? reachPopularity(artist),
        city: payload.city || 'Mumbai',
        venue_capacity: payload.venue_capacity || 5_000,
        currency: currency || 'INR',
      };
      const prediction = await postAnalytics<Record<string, unknown>>('/llm-predict', body);
      return {
        ...prediction,
        model_source: 'mad_analytics.revenue.llm_model',
      };
    } catch (error) {
      console.error('Error fetching LLM-style prediction from mad_analytics:', error);
      throw error;
    }
  },

  getGrowthForecast: async (artistId: string, metrics?: MetricRow[]) => {
    try {
      const artist = await resolveArtist({ artist_id: artistId });
      // Real metrics only — do not fabricate a growth series (Blueprint v2.0:
      // missing time series ⇒ Momentum renormalized out downstream).
      const bodyMetrics = metrics?.length
        ? metrics.map(toAnalyticsMetric)
        : realPlatformMetrics(artist);
      return await postAnalytics('/growth', {
        artist_id: artist?.id || artistId,
        metrics: bodyMetrics,
      });
    } catch (error) {
      console.error('Error fetching growth forecast from mad_analytics:', error);
      throw error;
    }
  },

  getDemandScore: async (payload: DemandPayload) => {
    try {
      const analyticsPayload = await buildDemandPayload(payload);
      return await postAnalytics('/demand', analyticsPayload);
    } catch (error) {
      console.error('Error fetching demand score from mad_analytics:', error);
      throw error;
    }
  },
  
  getPopularityScore: async (artistId: string, platformMetrics?: any[]) => {
    try {
      const artist = await resolveArtist({ artist_id: artistId });
      // Real metrics only — no synthetic rows. Momentum (0.20 of Popularity)
      // must come from genuine history or renormalize out (Blueprint v2.0).
      const body = {
        artist_id: artist?.id || artistId,
        platform_metrics: platformMetrics?.length
          ? platformMetrics.map(toAnalyticsMetric)
          : realPlatformMetrics(artist),
      };
      return await postAnalytics('/popularity', body);
    } catch (error) {
      console.error('Error fetching popularity score from mad_analytics:', error);
      throw error;
    }
  },

  getVenueCapacity: async (payload: VenueCapacityPayload) => {
    try {
      const result = await postAnalytics<Record<string, unknown>>('/venue-capacity', {
        venue_name: payload.venue_name,
        city: payload.city || '',
        country: payload.country || DEFAULT_COUNTRY,
        venue_type: payload.venue_type || '',
        artist_tier: payload.artist_tier,
        supplied_capacity: payload.supplied_capacity,
        source_texts: payload.source_texts || [],
        persist: Boolean(payload.persist),
      });
      return {
        ...result,
        model_source: 'mad_analytics.venue_capacity.resolver',
      };
    } catch (error) {
      console.error('Error resolving venue capacity via mad_analytics:', error);
      throw error;
    }
  },
  
  saveAllPopularityScores: async () => {
    try {
      return await postAnalytics('/popularity/all/save');
    } catch (error) {
      console.error('Error saving all popularity scores via mad_analytics:', error);
      throw error;
    }
  },

  // Batch canonical popularity for the whole active cohort in ONE Python call,
  // so list views (Artist cards) never fan out into 11 sequential requests.
  // Longer timeout because the cohort computation is heavier than a single score.
  getAllPopularityScores: async () => {
    try {
      return await getAnalytics('/popularity/all', Math.max(ANALYTICS_TIMEOUT_MS, 30_000));
    } catch (error) {
      console.error('Error fetching all popularity scores via mad_analytics:', error);
      throw error;
    }
  },
};

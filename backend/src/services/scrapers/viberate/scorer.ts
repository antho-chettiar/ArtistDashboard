/**
 * scorer.ts
 *
 * ArtistPopularityV2 — 3-layer scoring from Viberate data.
 *
 * NOTE: This file is a rebuild. The original scorer.ts was written in a
 * previous working session but never made it into the repo. The formula
 * below follows the documented design:
 *
 *   Layer 1 — Reach Score (0–1)
 *     Entropy-weighted combination of spotify_listeners,
 *     youtube_subscribers, instagram_followers.
 *     Values are log1p-transformed and max-normalized across the cohort,
 *     mirroring the V1 method in utils/artistPopularity.ts.
 *
 *   Layer 2 — Engagement Multiplier
 *     Absolute engaged headcount over the trailing 30 days:
 *       Instagram: sum(instagram_likes.diff) + sum(instagram_comments.diff)
 *       YouTube:   sum(youtube_likes.diff)
 *     Log-compressed via EngagementService (1 + ln(1+engaged), /10, cap 2).
 *     adjustedReach = reachScore × engagementMultiplier
 *
 *   Layer 3 — Google Trends
 *     Latest normalizedScore (0–1) from ArtistTrendScore.
 *
 *   Final:
 *     combined   = 0.70 × normalized(adjustedReach) + 0.30 × trendsScore
 *     finalScore = clamp(5 + combined × 95, 5, 100)
 *
 *   If an artist has no trends data at all, the score falls back to
 *   reach-only (100% adjusted reach) and this is recorded in trendsMetadata,
 *   so artists without a Trends keyword aren't silently penalized.
 *
 * Snapshots are written to ArtistPopularityV2Snapshot with
 * scoreVersion = 'v2.1-viberate'. Historical snapshots are never
 * overwritten — each run appends a new row per artist.
 *
 * Usage (standalone):
 *   npx ts-node src/services/scrapers/viberate/scorer.ts
 *
 * Usage (from scheduler):
 *   import { runScorer } from './scorer';
 *   await runScorer();
 */

import { PrismaClient } from '@prisma/client';
import { EngagementService } from '../../analytics/engagement.service';
import { PlatformEngagement } from '../../analytics/types';

const prisma = new PrismaClient();

// ─── Config ──────────────────────────────────────────────────────────────────

export const SCORE_VERSION = 'v2.1-viberate';

// Reach metrics used in Layer 1 (ViberateMetricDaily.metricName values)
const REACH_METRICS = [
  'spotify_listeners',
  'youtube_subscribers',
  'instagram_followers',
] as const;

type ReachMetric = (typeof REACH_METRICS)[number];

// Final blend weights
const WEIGHT_REACH = 0.7;
const WEIGHT_TRENDS = 0.3;

// Engagement window (days of diffValue summed)
const ENGAGEMENT_WINDOW_DAYS = 30;

// ─── Types ───────────────────────────────────────────────────────────────────

interface ArtistReachInput {
  artistId: string;
  artistName: string;
  values: Record<ReachMetric, number>; // latest raw totals
}

interface EntropyModel {
  weights: Record<ReachMetric, number>;
  maxValues: Record<ReachMetric, number>; // max of log1p-transformed values
  sampleSize: number;
}

interface ArtistScoreRow {
  artistId: string;
  artistName: string;
  reachScore: number;
  engagementMultiplier: number;
  adjustedReach: number;
  trendsScore: number;
  finalScore: number;
  normalizedValues: Record<ReachMetric, number>;
  platformMultipliers: unknown;
  trendsMetadata: Record<string, unknown>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log1pSafe(value: number): number {
  return Math.log1p(Math.max(0, value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// ─── Data loading ────────────────────────────────────────────────────────────

/**
 * Latest non-null totalValue for one artist+metric.
 * "Latest" = most recent date that actually has a total.
 */
async function getLatestTotal(
  artistId: string,
  metricName: string
): Promise<number> {
  const row = await prisma.viberateMetricDaily.findFirst({
    where: { artistId, metricName, totalValue: { not: null } },
    orderBy: { date: 'desc' },
    select: { totalValue: true },
  });
  return row?.totalValue ?? 0;
}

/**
 * Sum of diffValue over the trailing N days for one artist+metric.
 * Used for engagement metrics that have no running total
 * (instagram_likes, instagram_comments) and for youtube_likes.
 */
async function getDiffSum(
  artistId: string,
  metricName: string,
  days: number
): Promise<number> {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const result = await prisma.viberateMetricDaily.aggregate({
    where: {
      artistId,
      metricName,
      date: { gte: since },
      diffValue: { not: null },
    },
    _sum: { diffValue: true },
  });

  return result._sum.diffValue ?? 0;
}

// ─── Layer 1: entropy-weighted reach ────────────────────────────────────────

/**
 * Entropy weight method — same approach as utils/artistPopularity.ts V1:
 *   1. log1p-transform raw values
 *   2. max-normalize each metric column across the cohort
 *   3. column entropy → diversification (1 - entropy) → normalized weights
 * Falls back to equal weights if the cohort is degenerate.
 */
function buildEntropyModel(inputs: ArtistReachInput[]): EntropyModel {
  const transformedRows = inputs.map((a) =>
    REACH_METRICS.map((m) => log1pSafe(a.values[m]))
  );

  const maxValues = {} as Record<ReachMetric, number>;
  REACH_METRICS.forEach((metric, i) => {
    maxValues[metric] = Math.max(...transformedRows.map((row) => row[i]), 0);
  });

  const normalizedRows = transformedRows.map((row) =>
    row.map((value, i) => {
      const max = maxValues[REACH_METRICS[i]];
      return max > 0 ? value / max : 0;
    })
  );

  const sampleSize = normalizedRows.length;
  const entropyFactor = sampleSize > 1 ? 1 / Math.log(sampleSize) : 0;

  const diversification = REACH_METRICS.map((_, columnIndex) => {
    const column = normalizedRows.map((row) => row[columnIndex]);
    const columnSum = column.reduce((sum, v) => sum + v, 0);
    if (columnSum <= 0 || entropyFactor === 0) return 0;

    const entropy = -entropyFactor * column.reduce((sum, v) => {
      if (v <= 0) return sum;
      const p = v / columnSum;
      return sum + p * Math.log(p);
    }, 0);

    return Math.max(0, 1 - entropy);
  });

  const totalDiversification = diversification.reduce((s, v) => s + v, 0);

  const weights = {} as Record<ReachMetric, number>;
  if (totalDiversification <= 0) {
    REACH_METRICS.forEach((m) => (weights[m] = 1 / REACH_METRICS.length));
  } else {
    REACH_METRICS.forEach((m, i) => {
      weights[m] = diversification[i] / totalDiversification;
    });
  }

  return { weights, maxValues, sampleSize };
}

function computeReachScore(
  artist: ArtistReachInput,
  model: EntropyModel
): { reachScore: number; normalizedValues: Record<ReachMetric, number> } {
  const normalizedValues = {} as Record<ReachMetric, number>;

  const reachScore = REACH_METRICS.reduce((sum, metric) => {
    const max = model.maxValues[metric];
    const normalized = max > 0 ? log1pSafe(artist.values[metric]) / max : 0;
    normalizedValues[metric] = round(normalized, 6);
    return sum + normalized * model.weights[metric];
  }, 0);

  return { reachScore, normalizedValues };
}

// ─── Layer 2: engagement multiplier ─────────────────────────────────────────

async function computeEngagement(
  artistId: string,
  igFollowers: number,
  ytSubscribers: number
): Promise<{ multiplier: number; platformMultipliers: unknown }> {
  const [igLikes, igComments, ytLikes] = await Promise.all([
    getDiffSum(artistId, 'instagram_likes', ENGAGEMENT_WINDOW_DAYS),
    getDiffSum(artistId, 'instagram_comments', ENGAGEMENT_WINDOW_DAYS),
    getDiffSum(artistId, 'youtube_likes', ENGAGEMENT_WINDOW_DAYS),
  ]);

  const platforms: PlatformEngagement[] = [];

  if (igFollowers > 0) {
    platforms.push({
      platform: 'instagram',
      followers: igFollowers,
      likes: Math.max(0, igLikes),
      comments: Math.max(0, igComments),
      shares: 0,
    });
  }

  if (ytSubscribers > 0) {
    platforms.push({
      platform: 'youtube',
      followers: ytSubscribers,
      likes: Math.max(0, ytLikes),
      comments: 0,
      shares: 0,
    });
  }

  const result = EngagementService.calculate(platforms);
  return {
    multiplier: result.engagementMultiplier,
    platformMultipliers: result.platformMultipliers,
  };
}

// ─── Layer 3: Google Trends ─────────────────────────────────────────────────

async function getTrendsScore(
  artistId: string
): Promise<{ score: number | null; metadata: Record<string, unknown> }> {
  const row = await prisma.artistTrendScore.findFirst({
    where: { artistId },
    orderBy: { fetchedAt: 'desc' },
  });

  if (!row) {
    return {
      score: null,
      metadata: { source: 'missing', fallback: 'reach-only' },
    };
  }

  return {
    score: clamp(Number(row.normalizedScore), 0, 1),
    metadata: {
      source: row.source ?? 'artist_trend_scores',
      keyword: row.keyword,
      geo: row.geo,
      timeframe: row.timeframe,
      fetchedAt: row.fetchedAt.toISOString(),
    },
  };
}

// ─── Main export ─────────────────────────────────────────────────────────────

export async function runScorer(): Promise<void> {
  const startTime = Date.now();
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Scorer (${SCORE_VERSION}) started: ${new Date().toISOString()}`);

  const artists = await prisma.artist.findMany({
    where: { viberateSlug: { not: null }, active: true },
    select: { id: true, artistName: true },
  });

  if (artists.length === 0) {
    console.warn('No artists with viberateSlug found — nothing to score.');
    await prisma.$disconnect();
    return;
  }

  console.log(`Artists to score: ${artists.length}`);
  console.log('═'.repeat(60));

  // 1. Load latest reach totals for every artist
  const reachInputs: ArtistReachInput[] = [];
  for (const artist of artists) {
    const values = {} as Record<ReachMetric, number>;
    for (const metric of REACH_METRICS) {
      values[metric] = await getLatestTotal(artist.id, metric);
    }
    reachInputs.push({
      artistId: artist.id,
      artistName: artist.artistName,
      values,
    });
  }

  // 2. Build cohort entropy model
  const model = buildEntropyModel(reachInputs);
  console.log('Entropy weights:', JSON.stringify(model.weights));

  // 3. Per-artist: reach → engagement → adjusted reach
  const rows: ArtistScoreRow[] = [];
  for (const input of reachInputs) {
    const { reachScore, normalizedValues } = computeReachScore(input, model);

    const { multiplier, platformMultipliers } = await computeEngagement(
      input.artistId,
      input.values.instagram_followers,
      input.values.youtube_subscribers
    );

    const adjustedReach = reachScore * multiplier;

    const trends = await getTrendsScore(input.artistId);

    rows.push({
      artistId: input.artistId,
      artistName: input.artistName,
      reachScore,
      engagementMultiplier: multiplier,
      adjustedReach,
      trendsScore: trends.score ?? 0,
      finalScore: 0, // filled below after cohort normalization
      normalizedValues,
      platformMultipliers,
      trendsMetadata: trends.metadata,
    });
  }

  // 4. Normalize adjusted reach across cohort, blend with trends, scale 5–100
  const maxAdjusted = Math.max(...rows.map((r) => r.adjustedReach), 0);

  for (const row of rows) {
    const adjustedNorm = maxAdjusted > 0 ? row.adjustedReach / maxAdjusted : 0;

    const hasTrends = row.trendsMetadata.source !== 'missing';
    const combined = hasTrends
      ? WEIGHT_REACH * adjustedNorm + WEIGHT_TRENDS * row.trendsScore
      : adjustedNorm; // reach-only fallback

    row.finalScore = round(clamp(5 + combined * 95, 5, 100), 2);
  }

  // 5. Persist snapshots
  const computedAt = new Date();
  for (const row of rows) {
    await prisma.artistPopularityV2Snapshot.create({
      data: {
        artistId: row.artistId,
        scoreVersion: SCORE_VERSION,
        reachScore: round(row.reachScore, 6),
        engagementMultiplier: round(row.engagementMultiplier, 4),
        adjustedReach: round(row.adjustedReach, 6),
        trendsScore: round(row.trendsScore, 6),
        finalScore: row.finalScore,
        reachWeights: model.weights,
        normalizedValues: row.normalizedValues,
        platformMultipliers: row.platformMultipliers as object,
        trendsMetadata: row.trendsMetadata as object,
        computedAt,
      },
    });
    console.log(
      `  ✓ ${row.artistName.padEnd(24)} final=${row.finalScore}` +
      ` (reach=${round(row.reachScore, 3)}, eng×=${round(row.engagementMultiplier, 3)},` +
      ` trends=${round(row.trendsScore, 3)}${row.trendsMetadata.source === 'missing' ? ' [missing → reach-only]' : ''})`
    );
  }

  await prisma.$disconnect();

  const duration = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Scoring complete in ${duration}s — ${rows.length} snapshots written (${SCORE_VERSION})`);
  console.log('═'.repeat(60));
}

// Allow running directly:
//   npx ts-node backend/src/services/scrapers/viberate/scorer.ts
if (require.main === module) {
  runScorer().catch((err) => {
    console.error('Scoring failed:', err);
    process.exit(1);
  });
}

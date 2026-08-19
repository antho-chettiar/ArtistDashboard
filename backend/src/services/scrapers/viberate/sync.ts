/**
 * sync.ts
 *
 * Bridges ViberateMetricDaily into the legacy Artist columns and
 * PlatformMetric table that the rest of the dashboard reads from.
 *
 * Flow:
 *   A) Update Artist.{spotifyMonthlyListeners, spotifyFollowers, youtubeSubscribers,
 *      instagramFollowers, facebookFollowers} with the latest non-null totalValue
 *      per metric from ViberateMetricDaily.
 *   B) Backfill PlatformMetric with the full daily history per platform so
 *      trend charts have data to render (not just the latest day).
 *
 * tiktok is intentionally skipped in Part B -- the Platform enum has no
 * TIKTOK value and this file must not add migrations.
 *
 * Runs between collection and scoring:
 *   runCollection() -> runSync() -> runScorer()
 *
 * Usage (standalone):
 *   npx ts-node backend/src/services/scrapers/viberate/sync.ts
 *
 * Usage (from scheduler):
 *   import { runSync } from './sync';
 *   await runSync();
 */

import { PrismaClient, Platform, MetricSource } from '@prisma/client';

const prisma = new PrismaClient();

// ─── Config ──────────────────────────────────────────────────────────────────

type ArtistColumn =
  | 'spotifyMonthlyListeners'
  | 'spotifyFollowers'
  | 'youtubeSubscribers'
  | 'instagramFollowers'
  | 'facebookFollowers';

// Artist column <- latest ViberateMetricDaily.totalValue for this metric.
// twitterFollowers is intentionally absent -- no Viberate source for it.
const ARTIST_COLUMN_METRICS: { metricName: string; column: ArtistColumn }[] = [
  { metricName: 'spotify_listeners', column: 'spotifyMonthlyListeners' },
  { metricName: 'spotify_followers', column: 'spotifyFollowers' },
  { metricName: 'youtube_subscribers', column: 'youtubeSubscribers' },
  { metricName: 'instagram_followers', column: 'instagramFollowers' },
  { metricName: 'facebook_followers', column: 'facebookFollowers' },
];

interface PlatformSyncConfig {
  platform: Platform;
  followersMetric: string;
  streamsMetric?: string;
  likesMetric?: string;
}

// PlatformMetric backfill -- one entry per platform we can populate.
const PLATFORM_SYNC_CONFIG: PlatformSyncConfig[] = [
  { platform: Platform.SPOTIFY, followersMetric: 'spotify_listeners', streamsMetric: 'spotify_streams' },
  { platform: Platform.YOUTUBE, followersMetric: 'youtube_subscribers', likesMetric: 'youtube_likes' },
  { platform: Platform.INSTAGRAM, followersMetric: 'instagram_followers' },
  { platform: Platform.FACEBOOK, followersMetric: 'facebook_followers' },
];

const ROG_WINDOWS: { field: 'rogDaily' | 'rogWeekly' | 'rogMonthly'; days: number }[] = [
  { field: 'rogDaily', days: 1 },
  { field: 'rogWeekly', days: 7 },
  { field: 'rogMonthly', days: 30 },
];

// How many upserts to run concurrently per batch when backfilling
// platform_metrics (~18k rows total across all artists/platforms).
const UPSERT_BATCH_SIZE = 100;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toBigIntOrUndefined(value: number | null | undefined): bigint | undefined {
  if (value === null || value === undefined) return undefined;
  return BigInt(Math.round(value));
}

function dateKey(date: Date): string {
  return date.toISOString().split('T')[0];
}

function daysBefore(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return dateKey(d);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

async function runBatched<T>(
  items: T[],
  size: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    await Promise.all(batch.map(worker));
  }
}

// ─── Part A: Artist column update ───────────────────────────────────────────

async function syncArtistColumns(artistId: string, artistName: string): Promise<void> {
  const data: Partial<Record<ArtistColumn, bigint>> = {};

  for (const { metricName, column } of ARTIST_COLUMN_METRICS) {
    const row = await prisma.viberateMetricDaily.findFirst({
      where: { artistId, metricName, totalValue: { not: null } },
      orderBy: { date: 'desc' },
      select: { totalValue: true },
    });

    const value = toBigIntOrUndefined(row?.totalValue);
    if (value !== undefined) {
      data[column] = value;
    }
  }

  if (Object.keys(data).length === 0) {
    console.log(`  ~ ${artistName} — no Viberate totals found, columns left unchanged`);
    return;
  }

  // select: { id: true } avoids Prisma's implicit return-all-columns behavior,
  // which otherwise selects artists.googleTrendsScore -- a column present in
  // schema.prisma but missing from the live DB (pre-existing drift, out of scope here).
  await prisma.artist.update({ where: { id: artistId }, data, select: { id: true } });
  console.log(`  ✓ ${artistName} — updated columns: ${Object.keys(data).join(', ')}`);
}

// ─── Part B: PlatformMetric backfill ────────────────────────────────────────

async function loadMetricTotals(artistId: string, metricName: string): Promise<Map<string, number>> {
  const rows = await prisma.viberateMetricDaily.findMany({
    where: { artistId, metricName, totalValue: { not: null } },
    select: { date: true, totalValue: true },
  });

  const map = new Map<string, number>();
  for (const row of rows) {
    if (row.totalValue !== null) {
      map.set(dateKey(row.date), row.totalValue);
    }
  }
  return map;
}

interface PlatformMetricRow {
  artistId: string;
  platform: Platform;
  metricDate: Date;
  followers: bigint;
  streams: bigint | undefined;
  likes: bigint | undefined;
  rogDaily: number | null;
  rogWeekly: number | null;
  rogMonthly: number | null;
}

async function syncPlatformMetric(
  artistId: string,
  artistName: string,
  config: PlatformSyncConfig
): Promise<number> {
  const followersMap = await loadMetricTotals(artistId, config.followersMetric);

  if (followersMap.size === 0) {
    console.log(`  ~ ${artistName} / ${config.platform} — no ${config.followersMetric} data, skipping`);
    return 0;
  }

  const streamsMap = config.streamsMetric ? await loadMetricTotals(artistId, config.streamsMetric) : null;
  const likesMap = config.likesMetric ? await loadMetricTotals(artistId, config.likesMetric) : null;

  const dates = Array.from(followersMap.keys()).sort();

  const rows: PlatformMetricRow[] = dates.map((dateStr) => {
    const followers = followersMap.get(dateStr)!;

    const rog: Record<'rogDaily' | 'rogWeekly' | 'rogMonthly', number | null> = {
      rogDaily: null,
      rogWeekly: null,
      rogMonthly: null,
    };

    for (const { field, days } of ROG_WINDOWS) {
      const prior = followersMap.get(daysBefore(dateStr, days));
      if (prior !== undefined && prior !== 0) {
        rog[field] = round(((followers - prior) / prior) * 100, 4);
      }
    }

    return {
      artistId,
      platform: config.platform,
      metricDate: new Date(`${dateStr}T00:00:00.000Z`),
      followers: BigInt(Math.round(followers)),
      streams: toBigIntOrUndefined(streamsMap?.get(dateStr)),
      likes: toBigIntOrUndefined(likesMap?.get(dateStr)),
      rogDaily: rog.rogDaily,
      rogWeekly: rog.rogWeekly,
      rogMonthly: rog.rogMonthly,
    };
  });

  await runBatched(rows, UPSERT_BATCH_SIZE, async (row) => {
    await prisma.platformMetric.upsert({
      where: {
        artistId_platform_metricDate: {
          artistId: row.artistId,
          platform: row.platform,
          metricDate: row.metricDate,
        },
      },
      update: {
        followers: row.followers,
        ...(row.streams !== undefined ? { streams: row.streams } : {}),
        ...(row.likes !== undefined ? { likes: row.likes } : {}),
        rogDaily: row.rogDaily,
        rogWeekly: row.rogWeekly,
        rogMonthly: row.rogMonthly,
        source: MetricSource.API,
      },
      create: {
        artistId: row.artistId,
        platform: row.platform,
        metricDate: row.metricDate,
        followers: row.followers,
        ...(row.streams !== undefined ? { streams: row.streams } : {}),
        ...(row.likes !== undefined ? { likes: row.likes } : {}),
        rogDaily: row.rogDaily,
        rogWeekly: row.rogWeekly,
        rogMonthly: row.rogMonthly,
        source: MetricSource.API,
      },
    });
  });

  console.log(`  ✓ ${artistName} / ${config.platform} — ${rows.length} days upserted`);
  return rows.length;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function runSync(opts: { limit?: number; slug?: string } = {}): Promise<void> {
  const startTime = Date.now();
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Viberate sync started: ${new Date().toISOString()}`);

  const artists = await prisma.artist.findMany({
    where: { viberateSlug: opts.slug ? opts.slug : { not: null } },
    select: { id: true, artistName: true },
    ...(opts.limit && opts.limit > 0 ? { take: opts.limit } : {}),
  });

  if (artists.length === 0) {
    console.warn('No artists with viberateSlug found — nothing to sync.');
    await prisma.$disconnect();
    return;
  }

  console.log(`Artists to sync: ${artists.length}`);
  console.log('═'.repeat(60));

  console.log('\n[sync] Part A — updating Artist columns from latest Viberate totals');
  for (const artist of artists) {
    await syncArtistColumns(artist.id, artist.artistName);
  }

  console.log('\n[sync] Part B — backfilling PlatformMetric daily history');
  console.log('  (tiktok skipped — Platform enum has no TIKTOK value)');
  let totalRows = 0;
  for (const artist of artists) {
    console.log(`\n[${artist.artistName}]`);
    for (const config of PLATFORM_SYNC_CONFIG) {
      totalRows += await syncPlatformMetric(artist.id, artist.artistName, config);
    }
  }

  await prisma.$disconnect();

  const duration = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Sync complete in ${duration}s — ${totalRows} platform_metrics rows upserted across ${artists.length} artists`);
  console.log('═'.repeat(60));
}

// Allow running directly:
//   npx ts-node backend/src/services/scrapers/viberate/sync.ts
if (require.main === module) {
  runSync().catch((err) => {
    console.error('Sync failed:', err);
    process.exit(1);
  });
}

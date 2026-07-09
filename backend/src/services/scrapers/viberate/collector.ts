/**
 * collector.ts
 *
 * Main Viberate data collector.
 *
 * Flow:
 *   1. Load all artists from DB that have a viberateSlug set
 *   2. For each artist, fetch all metric groups from Viberate /graphs/ endpoint
 *   3. Map responses to typed rows
 *   4. Upsert into ViberateMetricDaily (idempotent — safe to re-run)
 *   5. Log result to CollectionLog
 *
 * Called by scheduler.ts on a daily cron, or manually for backfills.
 */

import { chromium, BrowserContext } from 'playwright';
import path from 'path';
import fs from 'fs';
import { PrismaClient } from '@prisma/client';
import { mapGraphResponse, ViberateGraphResponse } from './mapper';

const prisma = new PrismaClient();

// ─── Config ──────────────────────────────────────────────────────────────────

const SESSION_PATH = path.resolve(__dirname, 'viberate-session.json');
const BASE_URL = 'https://api.viberate.com/api/v1';

// How many days of history to fetch on each run.
// 365 days means we always re-fetch the trailing year, which automatically
// handles Viberate's retroactive corrections to earlier days.
const LOOKBACK_DAYS = 365;

// Delay between platform group requests per artist (ms)
// Keeps us within reasonable request cadence
const INTER_REQUEST_DELAY_MS = 1500;
const INTER_REQUEST_JITTER_MS = 1000;

// Delay between artists (ms)
const INTER_ARTIST_DELAY_MS = 3000;
const INTER_ARTIST_JITTER_MS = 2000;

// ─── Metric groups ───────────────────────────────────────────────────────────
// Grouped exactly as Viberate fires them — one request per platform group.
// Confirmed from HAR analysis.

const METRIC_GROUPS = [
  {
    platform: 'spotify',
    metrics: [
      'spotify_followers',
      'spotify_listeners',
      'spotify_streams',
      'spotify_popularity',
    ],
  },
  {
    platform: 'youtube',
    metrics: [
      'youtube_subscribers',
      'youtube_views',
      'youtube_channel_views',
      'youtube_likes',
    ],
  },
  {
    platform: 'instagram',
    metrics: [
      'instagram_followers',
      'instagram_likes',
      'instagram_comments',
    ],
  },
  {
    platform: 'facebook',
    metrics: ['facebook_followers'],
  },
  {
    platform: 'tiktok',
    metrics: [
      'tiktok_followers',
      'tiktok_channel_likes',
      'tiktok_comments',
      'tiktok_views',
    ],
  },
];

// ─── Date helpers ─────────────────────────────────────────────────────────────

function getDateRange(): { dateFrom: string; dateTo: string } {
  const today = new Date();
  const from = new Date(today);
  from.setDate(today.getDate() - LOOKBACK_DAYS);
  return {
    dateFrom: from.toISOString().split('T')[0],
    dateTo: today.toISOString().split('T')[0],
  };
}

function delay(base: number, jitter: number): Promise<void> {
  return new Promise(res => setTimeout(res, base + Math.random() * jitter));
}

// ─── Fetch one metric group ───────────────────────────────────────────────────

async function fetchMetricGroup(
  context: BrowserContext,
  slug: string,
  metrics: string[],
  dateFrom: string,
  dateTo: string
): Promise<ViberateGraphResponse | null> {
  const metricParam = metrics.join(',');
  const url = `${BASE_URL}/artist/${slug}/graphs/?date-from=${dateFrom}&date-to=${dateTo}&metric=${metricParam}&period=daily`;

  const page = await context.newPage();

  try {
    const response = await page.request.get(url);

    if (response.status() !== 200) {
      console.warn(`  [collector] Non-200 for ${slug}/${metricParam}: ${response.status()}`);
      return null;
    }

    const contentType = response.headers()['content-type'] || '';
    if (!contentType.includes('application/json')) {
      console.warn(`  [collector] Non-JSON response for ${slug}/${metricParam}`);
      return null;
    }

    return await response.json() as ViberateGraphResponse;

  } catch (err) {
    console.error(`  [collector] Request error for ${slug}/${metricParam}:`, err);
    return null;
  } finally {
    await page.close();
  }
}

// ─── Upsert rows for one artist ───────────────────────────────────────────────

async function upsertRows(
  rows: ReturnType<typeof mapGraphResponse>
): Promise<number> {
  if (rows.length === 0) return 0;

  let upserted = 0;

  // Prisma doesn't support bulk upsert with createMany + skipDuplicates
  // for compound unique constraints in all versions, so we batch individually.
  // For ~150-200 rows per artist this is fast enough.
  // If you have 100+ artists, consider raw SQL COPY or chunked createMany.
  for (const row of rows) {
    await prisma.viberateMetricDaily.upsert({
      where: {
        artistId_metricName_date: {
          artistId: row.artistId,
          metricName: row.metricName,
          date: row.date,
        },
      },
      update: {
        diffValue: row.diffValue,
        totalValue: row.totalValue,
        apiVersion: row.apiVersion,
        fetchedAt: new Date(),
      },
      create: {
        artistId: row.artistId,
        metricName: row.metricName,
        date: row.date,
        diffValue: row.diffValue,
        totalValue: row.totalValue,
        apiVersion: row.apiVersion,
      },
    });
    upserted++;
  }

  return upserted;
}

// ─── Collect one artist ───────────────────────────────────────────────────────

async function collectArtist(
  context: BrowserContext,
  artistId: string,
  artistName: string,
  viberateSlug: string,
  dateFrom: string,
  dateTo: string
): Promise<{ success: boolean; rowsUpserted: number; error?: string }> {
  console.log(`\n[${artistName}] slug: ${viberateSlug}`);
  let totalRows = 0;

  for (const group of METRIC_GROUPS) {
    const response = await fetchMetricGroup(
      context,
      viberateSlug,
      group.metrics,
      dateFrom,
      dateTo
    );

    if (!response) {
      console.warn(`  ✗ ${group.platform} — fetch failed, skipping`);
      await delay(INTER_REQUEST_DELAY_MS, INTER_REQUEST_JITTER_MS);
      continue;
    }

    const rows = mapGraphResponse(artistId, response);

    if (rows.length === 0) {
      console.log(`  ~ ${group.platform} — no data returned (artist may not have this platform)`);
    } else {
      const upserted = await upsertRows(rows);
      console.log(`  ✓ ${group.platform} — ${upserted} rows upserted`);
      totalRows += upserted;
    }

    await delay(INTER_REQUEST_DELAY_MS, INTER_REQUEST_JITTER_MS);
  }

  return { success: true, rowsUpserted: totalRows };
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function runCollection(): Promise<void> {
  const startTime = Date.now();
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Viberate collection started: ${new Date().toISOString()}`);

  // Guard: session file must exist
  if (!fs.existsSync(SESSION_PATH)) {
    throw new Error(
      `Session file not found at ${SESSION_PATH}. Run login.ts first.`
    );
  }

  // Load artists that have a viberateSlug set
  const artists = await prisma.artist.findMany({
    where: {
      viberateSlug: { not: null },
      active: true,
    },
    select: {
      id: true,
      artistName: true,
      viberateSlug: true,
    },
  });

  if (artists.length === 0) {
    console.warn('No artists with viberateSlug found. Add slugs to artists first.');
    await prisma.$disconnect();
    return;
  }

  console.log(`Artists to collect: ${artists.length}`);
  const { dateFrom, dateTo } = getDateRange();
  console.log(`Date range: ${dateFrom} → ${dateTo}`);
  console.log('═'.repeat(60));

  // Launch browser with saved session
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: SESSION_PATH });

  // Establish page context once — sets origin/referer for all subsequent requests
  const initPage = await context.newPage();
  await initPage.goto('https://app.viberate.com/', { waitUntil: 'domcontentloaded' });
  await initPage.close();

  let succeeded = 0;
  let failed = 0;

  for (const artist of artists) {
    const slug = artist.viberateSlug!;

    try {
      const result = await collectArtist(
        context,
        artist.id,
        artist.artistName,
        slug,
        dateFrom,
        dateTo
      );

      if (result.success) {
        succeeded++;
        console.log(`  → Total: ${result.rowsUpserted} rows upserted`);
      } else {
        failed++;
      }

    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ Collection failed for ${artist.artistName}: ${msg}`);
    }

    // Polite delay between artists
    if (artists.indexOf(artist) < artists.length - 1) {
      await delay(INTER_ARTIST_DELAY_MS, INTER_ARTIST_JITTER_MS);
    }
  }

  await browser.close();
  await prisma.$disconnect();

  const duration = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Collection complete in ${duration}s`);
  console.log(`  Succeeded: ${succeeded}/${artists.length}`);
  console.log(`  Failed:    ${failed}/${artists.length}`);
  console.log('═'.repeat(60));
}

// Allow running directly for manual backfills:
//   npx ts-node backend/src/services/scrapers/viberate/collector.ts
if (require.main === module) {
  runCollection().catch(err => {
    console.error('Collection failed:', err);
    process.exit(1);
  });
}

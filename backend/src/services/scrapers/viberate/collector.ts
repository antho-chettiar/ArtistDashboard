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
import fs from 'fs';
import { PrismaClient } from '@prisma/client';
import { mapGraphResponse, ViberateGraphResponse } from './mapper';
import { retryWithBackoff } from '../retry';
import { RateLimiter } from '../rateLimiter';
import { getSessionPath } from './session';

const prisma = new PrismaClient();

// ─── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = 'https://api.viberate.com/api/v1';

// How many days of history to fetch on each run.
// 30 days keeps daily runs light while still re-fetching a trailing window,
// which absorbs Viberate's retroactive corrections to recent days.
// (Set to 365 only for one-off historical backfills.)
const LOOKBACK_DAYS = 30;

// Delay between platform group requests per artist (ms)
// Keeps us within reasonable request cadence
const INTER_REQUEST_DELAY_MS = 1500;
const INTER_REQUEST_JITTER_MS = 1000;

// Delay between artists (ms)
const INTER_ARTIST_DELAY_MS = 3000;
const INTER_ARTIST_JITTER_MS = 2000;

// Retry config for transient fetch failures (network errors, non-200, non-JSON).
// 401/403 are deliberately NOT retried -- they mean the session died, which
// retrying can't fix (sessionHealth.ts already gates the whole run on this).
const FETCH_RETRY_ATTEMPTS = 3;
const FETCH_RETRY_BASE_DELAY_MS = 1000;
const FETCH_RETRY_MAX_DELAY_MS = 8000;

// Enforces the minimum spacing above; jitter (below) stays a separate,
// deliberate anti-fingerprinting concern layered on top of it.
const interRequestLimiter = new RateLimiter(INTER_REQUEST_DELAY_MS);
const interArtistLimiter = new RateLimiter(INTER_ARTIST_DELAY_MS);

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

// Random jitter on top of the RateLimiter's enforced minimum spacing above --
// kept as its own helper since jitter (anti-fingerprinting/politeness) is a
// distinct concern from rate limiting (minimum spacing), not something
// RateLimiter itself models.
function jitter(maxMs: number): Promise<void> {
  return new Promise(res => setTimeout(res, Math.random() * maxMs));
}

// ─── Fetch one metric group ───────────────────────────────────────────────────

// A single fetch attempt either succeeds, or resolves with a fatal (non-retryable)
// auth failure -- everything else (non-200, non-JSON, thrown network errors)
// throws so retryWithBackoff will retry it.
type FetchAttemptResult =
  | { ok: true; data: ViberateGraphResponse }
  | { ok: false; fatal: true; status: number };

async function attemptFetch(
  context: BrowserContext,
  url: string,
  slug: string,
  metricParam: string
): Promise<FetchAttemptResult> {
  // Fresh page per attempt: retrying on the exact page/connection that just
  // got blocked is worse than a fresh one from the same authenticated context.
  const page = await context.newPage();

  try {
    const response = await page.request.get(url);
    const status = response.status();

    // Session expired mid-run -- retrying won't help, so resolve instead of
    // throwing (which retryWithBackoff would otherwise retry 3x for nothing).
    if (status === 401 || status === 403) {
      return { ok: false, fatal: true, status };
    }

    if (status !== 200) {
      throw new Error(`Non-200 for ${slug}/${metricParam}: ${status}`);
    }

    const contentType = response.headers()['content-type'] || '';
    if (!contentType.includes('application/json')) {
      throw new Error(`Non-JSON response for ${slug}/${metricParam}`);
    }

    const data = await response.json() as ViberateGraphResponse;
    return { ok: true, data };

  } finally {
    await page.close();
  }
}

async function fetchMetricGroup(
  context: BrowserContext,
  slug: string,
  metrics: string[],
  dateFrom: string,
  dateTo: string
): Promise<ViberateGraphResponse | null> {
  const metricParam = metrics.join(',');
  const url = `${BASE_URL}/artist/${slug}/graphs/?date-from=${dateFrom}&date-to=${dateTo}&metric=${metricParam}&period=daily`;

  try {
    const result = await retryWithBackoff(
      () => attemptFetch(context, url, slug, metricParam),
      {
        attempts: FETCH_RETRY_ATTEMPTS,
        baseDelayMs: FETCH_RETRY_BASE_DELAY_MS,
        maxDelayMs: FETCH_RETRY_MAX_DELAY_MS,
      }
    );

    if (!result.ok) {
      console.warn(`  [collector] Auth failure (HTTP ${result.status}) for ${slug}/${metricParam} — session likely expired, not retrying`);
      return null;
    }

    return result.data;

  } catch (err) {
    console.error(`  [collector] Request failed for ${slug}/${metricParam} after ${FETCH_RETRY_ATTEMPTS} attempts:`, err);
    return null;
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
      await interRequestLimiter.wait();
      await jitter(INTER_REQUEST_JITTER_MS);
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

    await interRequestLimiter.wait();
    await jitter(INTER_REQUEST_JITTER_MS);
  }

  return { success: true, rowsUpserted: totalRows };
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function runCollection(opts: { limit?: number; slug?: string } = {}): Promise<void> {
  const startTime = Date.now();
  const sessionPath = getSessionPath();
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Viberate collection started: ${new Date().toISOString()}`);

  // Guard: session file must exist
  if (!fs.existsSync(sessionPath)) {
    throw new Error(
      `Session file not found at ${sessionPath}. Run login.ts first (or provision VIBERATE_SESSION_B64).`
    );
  }

  // Load artists that have a viberateSlug set. Optional filters allow a small,
  // controlled subset (single slug or a capped count) without touching metrics.
  const where: { viberateSlug: any; active: boolean } = {
    viberateSlug: opts.slug ? opts.slug : { not: null },
    active: true,
  };
  const artists = await prisma.artist.findMany({
    where,
    select: {
      id: true,
      artistName: true,
      viberateSlug: true,
    },
    ...(opts.limit && opts.limit > 0 ? { take: opts.limit } : {}),
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
  const context = await browser.newContext({ storageState: sessionPath });

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
      await interArtistLimiter.wait();
      await jitter(INTER_ARTIST_JITTER_MS);
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

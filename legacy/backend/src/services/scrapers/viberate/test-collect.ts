/**
 * STAGE 2 — Full metric collection for one artist.
 *
 * Goal: prove the complete data pipeline from Viberate API → parsed rows,
 * WITHOUT writing to any database yet. Prints a clean summary of what
 * would be inserted so we can verify data shape and edge cases first.
 *
 * Covers all confirmed platforms from the HAR analysis:
 *   Spotify, YouTube, Instagram, Facebook, TikTok
 *
 * Uses the /graphs/ endpoint (daily time-series) as the primary source,
 * since it gives historical data in one call and Viberate pre-computes
 * both diff and running total per day.
 *
 * Known edge cases handled:
 *   - total: {} (empty) for some metrics (instagram_likes, tiktok_views etc)
 *   - diff: 0 on days where Viberate didn't update (not a real zero)
 *   - growth values sometimes null in overview/ responses
 *
 * Usage:
 *   npx ts-node backend/src/services/scrapers/viberate/test-collect.ts
 */

import { chromium, BrowserContext } from 'playwright';
import path from 'path';
import fs from 'fs';

// ─── Config ────────────────────────────────────────────────────────────────

const SESSION_PATH = path.resolve(__dirname, 'viberate-session.json');
const BASE_URL = 'https://api.viberate.com/api/v1';

// Test artist — swap this slug to test another artist
const TEST_ARTIST_SLUG = 'sonu-nigam';

// Date range: last 30 days from today
// In production, the collector will pass a rolling window
const today = new Date();
const thirtyDaysAgo = new Date(today);
thirtyDaysAgo.setDate(today.getDate() - 30);

const DATE_TO = today.toISOString().split('T')[0];
const DATE_FROM = thirtyDaysAgo.toISOString().split('T')[0];

// ─── Metric groups — exactly as Viberate groups them per request ────────────
// Confirmed from HAR: Viberate fires one request per platform group,
// not one request per individual metric.

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

// ─── Types ──────────────────────────────────────────────────────────────────

interface ViberateGraphMetric {
  graph: {
    diff: Record<string, number>;
    total: Record<string, number>; // may be {} for some metrics
  };
}

interface ViberateGraphResponse {
  api_version: string;
  data: Record<string, ViberateGraphMetric>;
}

// What each parsed row looks like — this will map 1:1 to ArtistMetricDaily in Prisma
interface ParsedMetricRow {
  artistSlug: string;
  metricName: string;
  date: string;        // YYYY-MM-DD
  diffValue: number | null;
  totalValue: number | null;
  apiVersion: string;
}

// ─── Fetch one metric group ──────────────────────────────────────────────────

async function fetchMetricGroup(
  context: BrowserContext,
  slug: string,
  metrics: string[]
): Promise<ViberateGraphResponse | null> {
  const metricParam = metrics.join(',');
  const url = `${BASE_URL}/artist/${slug}/graphs/?date-from=${DATE_FROM}&date-to=${DATE_TO}&metric=${metricParam}&period=daily`;

  const page = await context.newPage();

  try {
    const response = await page.request.get(url);

    if (response.status() !== 200) {
      console.error(`  ✗ ${url}`);
      console.error(`    Status: ${response.status()}`);
      return null;
    }

    const contentType = response.headers()['content-type'] || '';
    if (!contentType.includes('application/json')) {
      console.error(`  ✗ Expected JSON but got: ${contentType}`);
      const text = await response.text();
      console.error(`    Body preview: ${text.slice(0, 200)}`);
      return null;
    }

    return await response.json() as ViberateGraphResponse;

  } catch (err) {
    console.error(`  ✗ Request threw:`, err);
    return null;
  } finally {
    await page.close();
  }
}

// ─── Parse response into flat rows ──────────────────────────────────────────

function parseGraphResponse(
  slug: string,
  response: ViberateGraphResponse
): ParsedMetricRow[] {
  const rows: ParsedMetricRow[] = [];
  const apiVersion = response.api_version;

  for (const [metricName, metricData] of Object.entries(response.data)) {
    const diffMap = metricData?.graph?.diff ?? {};
    const totalMap = metricData?.graph?.total ?? {};

    // Get all dates from diff (always present) and total (may be empty)
    const allDates = new Set([
      ...Object.keys(diffMap),
      ...Object.keys(totalMap),
    ]);

    for (const date of allDates) {
      const rawDiff = diffMap[date];
      const rawTotal = totalMap[date];

      rows.push({
        artistSlug: slug,
        metricName,
        date,
        // Store null rather than 0 when diff is 0 — Viberate uses 0 to mean
        // "no update on this day", NOT "no change occurred". See data quality
        // note: days with diff=0 are often followed by double-sized diffs next day.
        diffValue: rawDiff !== undefined ? rawDiff : null,
        // Store null when total is missing — some metrics (instagram_likes,
        // tiktok_views etc) never have a running total from Viberate
        totalValue: rawTotal !== undefined ? rawTotal : null,
        apiVersion,
      });
    }
  }

  return rows;
}

// ─── Print summary ───────────────────────────────────────────────────────────

function printSummary(allRows: ParsedMetricRow[]) {
  // Group by metric for a clean overview
  const byMetric = new Map<string, ParsedMetricRow[]>();
  for (const row of allRows) {
    if (!byMetric.has(row.metricName)) byMetric.set(row.metricName, []);
    byMetric.get(row.metricName)!.push(row);
  }

  console.log('');
  console.log('═'.repeat(80));
  console.log(`PARSED ROWS SUMMARY — Artist: ${allRows[0]?.artistSlug}`);
  console.log(`Date range: ${DATE_FROM} → ${DATE_TO}`);
  console.log(`Total rows that would be inserted: ${allRows.length}`);
  console.log('═'.repeat(80));

  for (const [metricName, rows] of byMetric.entries()) {
    // Sort by date
    rows.sort((a, b) => a.date.localeCompare(b.date));

    const withTotal = rows.filter(r => r.totalValue !== null).length;
    const withDiff = rows.filter(r => r.diffValue !== null && r.diffValue !== 0).length;
    const zeroDiff = rows.filter(r => r.diffValue === 0).length;

    // Latest non-zero total for quick sanity check
    const latestWithTotal = [...rows].reverse().find(r => r.totalValue !== null);

    console.log('');
    console.log(`  ${metricName}`);
    console.log(`    Days with total value : ${withTotal}/${rows.length}`);
    console.log(`    Days with real diff   : ${withDiff}/${rows.length}`);
    console.log(`    Days with diff=0      : ${zeroDiff} (Viberate "no update" days)`);
    if (latestWithTotal) {
      console.log(`    Latest total          : ${latestWithTotal.totalValue?.toLocaleString()} (${latestWithTotal.date})`);
    } else {
      console.log(`    Latest total          : ⚠ no total data for this metric`);
    }

    // Print last 5 rows as sample
    const sample = rows.slice(-5);
    console.log(`    Last 5 rows:`);
    for (const row of sample) {
      const diff = row.diffValue !== null ? row.diffValue.toLocaleString() : 'null';
      const total = row.totalValue !== null ? row.totalValue.toLocaleString() : 'null';
      console.log(`      ${row.date}  diff: ${diff.padStart(12)}  total: ${total}`);
    }
  }

  console.log('');
  console.log('═'.repeat(80));
  console.log('Stage 2 complete. No data was written to the database.');
  console.log('If the above looks correct, Stage 3 will wire up the Prisma upserts.');
  console.log('═'.repeat(80));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(SESSION_PATH)) {
    console.error(`No session file found at: ${SESSION_PATH}`);
    console.error('Run login.ts first.');
    process.exit(1);
  }

  console.log(`Artist:     ${TEST_ARTIST_SLUG}`);
  console.log(`Date range: ${DATE_FROM} → ${DATE_TO}`);
  console.log(`Platforms:  ${METRIC_GROUPS.map(g => g.platform).join(', ')}`);
  console.log('');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: SESSION_PATH });

  // Navigate to the app once to establish referer/origin context
  // (same approach proven in Stage 1)
  const initPage = await context.newPage();
  console.log('Establishing page context on app.viberate.com...');
  await initPage.goto('https://app.viberate.com/', { waitUntil: 'domcontentloaded' });
  await initPage.close();

  const allRows: ParsedMetricRow[] = [];

  for (const group of METRIC_GROUPS) {
    console.log(`Fetching ${group.platform} metrics...`);

    const response = await fetchMetricGroup(
      context,
      TEST_ARTIST_SLUG,
      group.metrics
    );

    if (!response) {
      console.error(`  Skipping ${group.platform} — fetch failed.`);
      continue;
    }

    const rows = parseGraphResponse(TEST_ARTIST_SLUG, response);
    console.log(`  ✓ Got ${rows.length} rows across ${Object.keys(response.data).length} metrics`);
    allRows.push(...rows);

    // Polite delay between platform requests — same cadence as a real browser
    await new Promise(res => setTimeout(res, 1500 + Math.random() * 1000));
  }

  await browser.close();

  if (allRows.length === 0) {
    console.error('No rows collected — check errors above.');
    process.exit(1);
  }

  printSummary(allRows);
}

main().catch((err) => {
  console.error('Stage 2 failed:', err);
  process.exit(1);
});

/**
 * audienceCity.ts
 *
 * WHY THIS EXISTS: Touring Precedent (mad_analytics/feasibility/topsis.py)
 * only ever knows about cities an artist has ALREADY played -- an artist who
 * has never toured a city but has a large, verifiably real digital audience
 * there looks identical to one with zero interest in that city under pure
 * historical-visit-count scoring. Viberate's "Audience by City" tab (checked
 * manually 2026-09 across the full 12-artist roster) gives a real,
 * city-resolved audience-share reading for most of this roster -- this
 * collector is what turns that into a queryable signal. See
 * mad_analytics' consumer module and feasibility/topsis.py for how it's
 * actually used (it boosts, never replaces, the existing Touring Precedent
 * value -- see that module's docstring for the exact blend rule).
 *
 * COVERAGE IS ARTIST-DEPENDENT, CAUSE UNCONFIRMED (checked 2026-09-23):
 * 10 of 12 roster artists have real "Audience by City" data. Arijit Singh and
 * Diljit Dosanjh both show Viberate's own "Geographic data isn't available
 * for this artist" message -- notably, these are this roster's two biggest
 * mainstream/stadium-tier names, so tier/scale is a plausible cause, but this
 * was not confirmed against Viberate's own documentation and should not be
 * assumed. Per the project-wide no-fabrication rule, an unavailable artist
 * gets ZERO rows written here -- never a placeholder/zero row that would look
 * like "checked, found nothing" instead of "not offered by the source at all".
 *
 * Flow (mirrors collector.ts's shape, but is its own standalone module since
 * the row shape, source page, and cadence are all different -- this is a
 * page-rendered table on the app, not a JSON graphs/ API call, and these
 * percentages move far slower than the daily platform metrics, so this is
 * NOT wired into scheduler.ts's daily cron; run it manually/periodically):
 *   1. Load all artists from DB that have a viberateSlug set
 *   2. For each artist, open /artist/<slug>/audience and read the
 *      "Audience by City" table (or its "not available" message)
 *   3. Map rows to ViberateMetricDaily rows with city set
 *   4. Upsert (idempotent -- safe to re-run)
 *
 * Usage (use ts-node, NOT tsx -- tsx's esbuild transform injects a `__name`
 * helper into compiled output that isn't defined once Playwright extracts
 * this file's page.evaluate()/waitForFunction() callbacks as source text and
 * runs them inside the browser context, which throws
 * "ReferenceError: __name is not defined"; confirmed 2026-09 while building
 * this collector -- ts-node does not have this problem):
 *   npx ts-node src/services/scrapers/viberate/audienceCity.ts
 *   npx ts-node src/services/scrapers/viberate/audienceCity.ts --slug arijit-singh
 *   npx ts-node src/services/scrapers/viberate/audienceCity.ts --limit 1
 */

import { chromium, BrowserContext, Page } from 'playwright';
import fs from 'fs';
import { PrismaClient } from '@prisma/client';
import { RateLimiter } from '../rateLimiter';
import { getSessionPath } from './session';

const prisma = new PrismaClient();

// ─── Config ──────────────────────────────────────────────────────────────────

const APP_BASE_URL = 'https://app.viberate.com';

// Same polite-cadence convention as collector.ts -- this is a much smaller
// per-artist workload (one page load, not 5 API groups), so the inter-artist
// delay is the only one that matters here.
const INTER_ARTIST_DELAY_MS = 3000;
const INTER_ARTIST_JITTER_MS = 2000;
const PAGE_LOAD_TIMEOUT_MS = 30000;
// The app keeps background connections open (websockets/analytics), so
// waiting for 'networkidle' timed out on most artists during manual checks --
// wait for the actual content (table or "not available" message) instead.
const CONTENT_WAIT_TIMEOUT_MS = 20000;

const interArtistLimiter = new RateLimiter(INTER_ARTIST_DELAY_MS);

function jitter(maxMs: number): Promise<void> {
  return new Promise(res => setTimeout(res, Math.random() * maxMs));
}

// ─── Metric names ────────────────────────────────────────────────────────────
// Prefixed distinctly from the national-level metric names (spotify_listeners
// etc.) so the two can never collide in engagement_rate()'s unfiltered
// "SELECT metricName, totalValue ... WHERE artistId = :aid" scan.

export const METRIC_MONTHLY_LISTENERS_PCT = 'audience_city_monthly_listeners_pct';
export const METRIC_MONTHLY_VIEWS = 'audience_city_monthly_views';
export const METRIC_TOTAL_FOLLOWERS_PCT = 'audience_city_total_followers_pct';

// ─── Parsing helpers ─────────────────────────────────────────────────────────

/** "9.7%" -> 9.7. "N/A" or missing -> null (never 0 -- 0 would claim a real
 * reading of zero share, which is not what an absent cell means). */
function parsePercent(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || /n\/a/i.test(trimmed)) return null;
  const n = parseFloat(trimmed.replace('%', ''));
  return Number.isFinite(n) ? n : null;
}

/** "262.95K" -> 262950, "1.76M" -> 1760000, "3,296" -> 3296. "N/A" -> null. */
function parseAbbreviatedNumber(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || /n\/a/i.test(trimmed)) return null;
  const match = trimmed.replace(/,/g, '').match(/^(-?[\d.]+)\s*([KM])?$/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  if (!Number.isFinite(value)) return null;
  const suffix = (match[2] || '').toUpperCase();
  if (suffix === 'K') return Math.round(value * 1_000);
  if (suffix === 'M') return Math.round(value * 1_000_000);
  return Math.round(value);
}

/** "Pune, IN" -> "Pune". Stored raw (title case, un-normalized) -- same
 * convention as concerts.city -- the Python consumer normalizes at read time
 * via demand.scorer._normalize_city_key, matching touring_history/scorer.py. */
function stripCountrySuffix(cityText: string): string {
  return cityText.replace(/,\s*[A-Z]{2}\s*$/, '').trim();
}

// ─── Row shape ───────────────────────────────────────────────────────────────

interface CityAudienceRow {
  city: string;
  monthlyListenersPct: number | null;
  monthlyViews: number | null;
  totalFollowersPct: number | null;
}

interface ScrapeResult {
  available: boolean;
  rows: CityAudienceRow[];
}

// ─── Scrape one artist's Audience by City table ─────────────────────────────

async function scrapeAudienceByCity(page: Page): Promise<ScrapeResult> {
  await Promise.race([
    page.waitForFunction(
      (() => {
        const body: any = (globalThis as any).document.body;
        return (
          /audience by city/i.test(body.innerText) ||
          /geographic data isn.?t available/i.test(body.innerText)
        );
      }) as any,
      { timeout: CONTENT_WAIT_TIMEOUT_MS }
    ).catch(() => null),
    page.waitForTimeout(CONTENT_WAIT_TIMEOUT_MS),
  ]);
  // Small settle delay -- the table can still be populating rows just after
  // the heading text appears.
  await page.waitForTimeout(1000);

  const bodyText = await page.innerText('body').catch(() => '');
  if (/geographic data isn.?t available/i.test(bodyText)) {
    return { available: false, rows: [] };
  }

  // This backend's tsconfig has no "dom" lib (it's a Node process), so the
  // in-browser callback below is deliberately typed as `any` throughout --
  // it never runs in this Node process, only serialized into the page.
  const rawRows: Array<{
    city: string;
    monthlyListenersPct: string | null;
    monthlyViewsAbs: string | null;
    totalFollowersPct: string | null;
  }> = await page.evaluate((): any => {
    const doc: any = (globalThis as any).document;

    // IMPORTANT (confirmed 2026-09 while building this collector, via
    // Diljit Dosanjh -- an artist with a real international/diaspora
    // audience): this page renders a SECOND, unrelated module with the exact
    // same "pro-content-module audience-by-city module-main" CSS class --
    // Viberate's "Local audience (in Country)" widget, which shows a city
    // breakdown WITHIN a single (often non-India) country and is a totally
    // different feature. A class-name or generic "contains audience by city
    // text somewhere in the subtree" match matched THAT module instead for
    // Diljit and silently returned his US-market breakdown as if it were the
    // full "Audience by City" table. The two are only reliably told apart by
    // their actual heading text: "Local audience (in Country)" vs
    // "Audience by City" -- so require the real heading and explicitly
    // reject any module whose text says "Local audience".
    const modules: any[] = Array.from(doc.querySelectorAll('.pro-content-module.audience-by-city'));
    const module = modules.find((m: any) => {
      const text = m.textContent || '';
      return /audience by city/i.test(text) && !/local audience/i.test(text);
    });
    if (!module) return [];

    const table = module.querySelector('table');
    if (!table || !table.querySelector('td[data-column-id="city"]')) return [];

    const textOf = (el: any, selector: string): string | null => {
      const found = el?.querySelector(selector);
      return found ? (found.textContent || '').trim() : null;
    };

    return Array.from(table.querySelectorAll('tbody tr')).map((tr: any) => {
      const cityCell = tr.querySelector('td[data-column-id="city"] em');
      const listenersCell = tr.querySelector('td[data-column-id="spotify_listeners"]');
      const viewsCell = tr.querySelector('td[data-column-id="youtube_views"]');
      const followersCell = tr.querySelector('td[data-column-id="instagram_followers"]');

      return {
        city: cityCell ? (cityCell.textContent || '').trim() : '',
        monthlyListenersPct: textOf(listenersCell, '.second'),
        monthlyViewsAbs: textOf(viewsCell, '.first'),
        totalFollowersPct: textOf(followersCell, '.second'),
      };
    });
  });

  // This platform's touring/demand data is India-only (concerts, city
  // affinity, NCCS reference data are all India cities) -- some artists on
  // this roster have real international-diaspora audience too (confirmed
  // 2026-09: Diljit Dosanjh's table includes US cities), which would never
  // match anything in _normalize_city_key()'s India-city space downstream.
  // Keep only rows Viberate itself tags "IN", same honesty standard as
  // everything else here: no silent guessing at which non-India cities
  // might be "close enough".
  const rows: CityAudienceRow[] = rawRows
    .filter(r => r.city && /,\s*IN\s*$/.test(r.city))
    .map(r => ({
      city: stripCountrySuffix(r.city),
      monthlyListenersPct: parsePercent(r.monthlyListenersPct),
      monthlyViews: parseAbbreviatedNumber(r.monthlyViewsAbs),
      totalFollowersPct: parsePercent(r.totalFollowersPct),
    }));

  return { available: rows.length > 0, rows };
}

// ─── Upsert rows for one artist ──────────────────────────────────────────────

async function upsertCityRows(
  artistId: string,
  date: Date,
  rows: CityAudienceRow[]
): Promise<number> {
  let upserted = 0;

  for (const row of rows) {
    // Never write a placeholder for a metric that came back null (N/A on the
    // page) -- absence of a row IS the honest signal, same convention as
    // engagement_rate()'s Instagram/Facebook exclusions.
    const metrics: { metricName: string; totalValue: number }[] = [];
    if (row.monthlyListenersPct !== null) {
      metrics.push({ metricName: METRIC_MONTHLY_LISTENERS_PCT, totalValue: row.monthlyListenersPct });
    }
    if (row.monthlyViews !== null) {
      metrics.push({ metricName: METRIC_MONTHLY_VIEWS, totalValue: row.monthlyViews });
    }
    if (row.totalFollowersPct !== null) {
      metrics.push({ metricName: METRIC_TOTAL_FOLLOWERS_PCT, totalValue: row.totalFollowersPct });
    }

    for (const metric of metrics) {
      // city is a real, non-null string here, so (unlike collector.ts's
      // national rows) Prisma's compound-unique input type is satisfied
      // directly -- upsert works as normal.
      await prisma.viberateMetricDaily.upsert({
        where: {
          artistId_metricName_date_city: {
            artistId,
            metricName: metric.metricName,
            date,
            city: row.city,
          },
        },
        update: {
          totalValue: metric.totalValue,
          apiVersion: 'audience-city-v1',
          fetchedAt: new Date(),
        },
        create: {
          artistId,
          metricName: metric.metricName,
          date,
          city: row.city,
          totalValue: metric.totalValue,
          apiVersion: 'audience-city-v1',
        },
      });
      upserted++;
    }
  }

  return upserted;
}

// ─── Collect one artist ───────────────────────────────────────────────────────

async function collectArtist(
  context: BrowserContext,
  artistId: string,
  artistName: string,
  viberateSlug: string,
  date: Date
): Promise<{ available: boolean; citiesFound: number; rowsUpserted: number }> {
  console.log(`\n[${artistName}] slug: ${viberateSlug}`);
  const page = await context.newPage();

  try {
    await page.goto(`${APP_BASE_URL}/artist/${viberateSlug}/audience`, {
      waitUntil: 'domcontentloaded',
      timeout: PAGE_LOAD_TIMEOUT_MS,
    });

    const { available, rows } = await scrapeAudienceByCity(page);

    if (!available) {
      console.log('  ~ Geographic data not available for this artist -- skipping (no rows written)');
      return { available: false, citiesFound: 0, rowsUpserted: 0 };
    }

    const rowsUpserted = await upsertCityRows(artistId, date, rows);
    console.log(`  ✓ ${rows.length} cities found, ${rowsUpserted} metric rows upserted`);
    return { available: true, citiesFound: rows.length, rowsUpserted };
  } finally {
    await page.close();
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function runAudienceCityCollection(opts: { limit?: number; slug?: string } = {}): Promise<void> {
  const startTime = Date.now();
  const sessionPath = getSessionPath();
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Viberate audience-by-city collection started: ${new Date().toISOString()}`);

  if (!fs.existsSync(sessionPath)) {
    throw new Error(
      `Session file not found at ${sessionPath}. Run login.ts first (or provision VIBERATE_SESSION_B64).`
    );
  }

  const where: { viberateSlug: any; active: boolean } = {
    viberateSlug: opts.slug ? opts.slug : { not: null },
    active: true,
  };
  const artists = await prisma.artist.findMany({
    where,
    select: { id: true, artistName: true, viberateSlug: true },
    ...(opts.limit && opts.limit > 0 ? { take: opts.limit } : {}),
  });

  if (artists.length === 0) {
    console.warn('No artists with viberateSlug found.');
    await prisma.$disconnect();
    return;
  }

  console.log(`Artists to check: ${artists.length}`);
  console.log('═'.repeat(60));

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: sessionPath });

  const initPage = await context.newPage();
  await initPage.goto(`${APP_BASE_URL}/`, { waitUntil: 'domcontentloaded' });
  await initPage.close();

  // One shared "today" for the whole run so every row from this pass lands
  // on the same date, same convention as collector.ts's dateFrom/dateTo.
  const today = new Date();
  const dateOnly = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

  let available = 0;
  let unavailable = 0;
  let failed = 0;
  let totalRows = 0;

  for (const artist of artists) {
    const slug = artist.viberateSlug!;
    try {
      const result = await collectArtist(context, artist.id, artist.artistName, slug, dateOnly);
      if (result.available) {
        available++;
        totalRows += result.rowsUpserted;
      } else {
        unavailable++;
      }
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ Collection failed for ${artist.artistName}: ${msg}`);
    }

    if (artists.indexOf(artist) < artists.length - 1) {
      await interArtistLimiter.wait();
      await jitter(INTER_ARTIST_JITTER_MS);
    }
  }

  await browser.close();
  await prisma.$disconnect();

  const duration = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Audience-by-city collection complete in ${duration}s`);
  console.log(`  Available:   ${available}/${artists.length} (${totalRows} metric rows upserted)`);
  console.log(`  Unavailable: ${unavailable}/${artists.length} (honestly skipped, no rows written)`);
  console.log(`  Failed:      ${failed}/${artists.length}`);
  console.log('═'.repeat(60));
}

// ─── CLI entrypoint ───────────────────────────────────────────────────────────

function parseArgs() {
  const a = process.argv.slice(2);
  const slugIdx = a.indexOf('--slug');
  const limitIdx = a.indexOf('--limit');
  const slug = slugIdx >= 0 && a[slugIdx + 1] ? a[slugIdx + 1] : undefined;
  const limitRaw = limitIdx >= 0 && a[limitIdx + 1] ? parseInt(a[limitIdx + 1], 10) : undefined;
  const limit = limitRaw && limitRaw > 0 ? limitRaw : undefined;
  return { slug, limit };
}

if (require.main === module) {
  const { slug, limit } = parseArgs();
  runAudienceCityCollection({ slug, limit }).catch(err => {
    console.error('Audience-by-city collection failed:', err);
    process.exit(1);
  });
}

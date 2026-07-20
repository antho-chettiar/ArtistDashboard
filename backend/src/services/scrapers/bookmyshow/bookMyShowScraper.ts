/**
 * bookMyShowScraper.ts
 *
 * ConcertSourceScraper implementation for BookMyShow (in.bookmyshow.com).
 *
 * BookMyShow's Next.js frontend calls an internal, undocumented JSON API:
 *   GET /api/explore/v1/discover/concerts-{citySlug}
 *       ?region={REGION}&embedded=true&lat={lat}&lon={lon}&pageId={n}
 * confirmed via live network capture. It's Cloudflare-protected -- a plain
 * fetch()/axios call to this endpoint reliably 500s/422s even with cookies
 * forwarded, so this scraper uses Playwright the same way viberate/collector.ts
 * does: navigate once to pick up Cloudflare clearance, then use page.request
 * for the actual API calls.
 *
 * Does NOT write to Prisma -- returns RawConcertEvent[] inside a ScrapeResult
 * for the caller to persist/normalize.
 *
 * Usage:
 *   import { bookMyShowScraper } from './bookMyShowScraper';
 *   const result = await bookMyShowScraper.scrape({ cities: ['Mumbai'] });
 */

import { chromium, BrowserContext } from 'playwright';
import { randomUUID } from 'crypto';
import { retryWithBackoff } from '../retry';
import { RateLimiter } from '../rateLimiter';
import { ScrapingJobQueue } from '../jobQueue';
import { logger } from '../../../utils/logger';
import {
  ConcertSourceScraper,
  ConcertSourcePlatform,
  ScrapeQuery,
  ScrapeResult,
  RawConcertEvent,
} from '../types';
import {
  BookMyShowJob,
  BookMyShowDiscoverResponse,
  CityRegionEntry,
  CITY_REGION_MAP,
  DEFAULT_CITIES,
  SUPPORTED_COUNTRY_ALIASES,
} from './types';
import { mapDiscoverResponseToEvents } from './mapper';

// ─── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = 'https://in.bookmyshow.com';

// Delay between paginated requests within one city, and between cities --
// same dual-limiter shape as viberate/collector.ts.
const INTER_PAGE_DELAY_MS = 1200;
const INTER_CITY_DELAY_MS = 1500;

// Retry config for transient fetch failures -- same values as the Viberate
// scraper for consistency. 404/422 are handled separately as fatal (see
// attemptFetch) since retrying a bad city/region combo can't fix it.
const FETCH_RETRY_ATTEMPTS = 3;
const FETCH_RETRY_BASE_DELAY_MS = 1000;
const FETCH_RETRY_MAX_DELAY_MS = 8000;

// Cap on pages fetched per city unless the caller specifies query.maxPages.
const DEFAULT_MAX_PAGES = 3;

// A single fetch attempt either succeeds, or resolves with a fatal (non-retryable)
// status -- everything else (5xx, 429, non-JSON, thrown network errors) throws
// so retryWithBackoff will retry it. Mirrors viberate/collector.ts's pattern.
type FetchAttemptResult =
  | { ok: true; data: BookMyShowDiscoverResponse }
  | { ok: false; fatal: true; status: number };

export class BookMyShowScraper implements ConcertSourceScraper {
  readonly source: ConcertSourcePlatform = 'BOOKMYSHOW';

  private readonly interPageLimiter = new RateLimiter(INTER_PAGE_DELAY_MS);
  private readonly interCityLimiter = new RateLimiter(INTER_CITY_DELAY_MS);
  // Own namespace -- no collision with the concert queue ('concert') or the
  // Viberate scheduler's queue ('viberate').
  private readonly jobQueue = new ScrapingJobQueue<BookMyShowJob>('bookmyshow');

  async scrape(query: ScrapeQuery): Promise<ScrapeResult> {
    const errors: string[] = [];

    if (query.country && !SUPPORTED_COUNTRY_ALIASES.includes(query.country.trim().toLowerCase())) {
      return {
        source: this.source,
        events: [],
        errors: [
          `BookMyShow scraper only supports India (in.bookmyshow.com); requested country "${query.country}" is not supported`,
        ],
        fetchedAt: new Date(),
      };
    }

    const resolvedCities = this.resolveCities(query.cities, errors);
    if (resolvedCities.length === 0) {
      return { source: this.source, events: [], errors, fetchedAt: new Date() };
    }

    // One job per resolved city, enqueued then drained in this same call --
    // same scaffolding pattern established for the Viberate scheduler: proves
    // the shared queue works without standing up a separate async worker.
    for (const { city, entry } of resolvedCities) {
      await this.jobQueue.enqueue({
        id: randomUUID(),
        city,
        region: entry.region,
        lat: entry.lat,
        lon: entry.lon,
        slug: entry.slug,
      });
    }

    const events: RawConcertEvent[] = [];
    const browser = await chromium.launch({ headless: true });

    try {
      const context = await browser.newContext();

      // Establish origin/cookies (Cloudflare clearance) once, same approach
      // as viberate/collector.ts's initPage.goto() step.
      const initPage = await context.newPage();
      await initPage.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
      await initPage.close();

      let job = await this.jobQueue.dequeue();
      let isFirstCity = true;

      while (job) {
        if (!isFirstCity) {
          await this.interCityLimiter.wait();
        }
        isFirstCity = false;

        const cityEvents = await this.scrapeCity(context, job, query, errors);
        events.push(...cityEvents);

        job = await this.jobQueue.dequeue();
      }
    } finally {
      await browser.close();
    }

    let filtered = this.applyDateFilter(events, query.dateFrom, query.dateTo);
    if (query.limitPerSource && filtered.length > query.limitPerSource) {
      filtered = filtered.slice(0, query.limitPerSource);
    }

    return { source: this.source, events: filtered, errors, fetchedAt: new Date() };
  }

  private resolveCities(
    requestedCities: string[] | undefined,
    errors: string[]
  ): { city: string; entry: CityRegionEntry }[] {
    const cities = requestedCities?.length ? requestedCities : DEFAULT_CITIES;
    const resolved: { city: string; entry: CityRegionEntry }[] = [];

    for (const city of cities) {
      const entry = CITY_REGION_MAP[city.trim().toLowerCase()];
      if (!entry) {
        logger.warn('BookMyShow: unknown city, skipping', { city });
        errors.push(`Unknown city "${city}" -- not in BookMyShow city lookup table`);
        continue;
      }
      resolved.push({ city, entry });
    }

    return resolved;
  }

  private async scrapeCity(
    context: BrowserContext,
    job: BookMyShowJob,
    query: ScrapeQuery,
    errors: string[]
  ): Promise<RawConcertEvent[]> {
    const maxPages = query.maxPages ?? DEFAULT_MAX_PAGES;
    const events: RawConcertEvent[] = [];

    for (let pageId = 1; pageId <= maxPages; pageId++) {
      if (pageId > 1) {
        await this.interPageLimiter.wait();
      }

      const url = this.buildDiscoverUrl(job, pageId);
      const response = await this.fetchDiscoverPage(context, url, job.city);

      if (!response) {
        errors.push(`BookMyShow: failed to fetch ${job.city} page ${pageId} after ${FETCH_RETRY_ATTEMPTS} attempts`);
        break;
      }

      const rawCount = response.meta?.ldSchema?.eventsSchema?.length ?? 0;
      if (rawCount === 0) {
        break; // no more events for this city
      }

      const pageEvents = mapDiscoverResponseToEvents(response, job.city, 'India', query.artists);
      events.push(...pageEvents);
    }

    return events;
  }

  private buildDiscoverUrl(job: BookMyShowJob, pageId: number): string {
    const params = new URLSearchParams({
      region: job.region,
      embedded: 'true',
      lat: String(job.lat),
      lon: String(job.lon),
    });
    if (pageId > 1) {
      params.set('pageId', String(pageId));
    }
    return `${BASE_URL}/api/explore/v1/discover/concerts-${job.slug}?${params.toString()}`;
  }

  private async fetchDiscoverPage(
    context: BrowserContext,
    url: string,
    city: string
  ): Promise<BookMyShowDiscoverResponse | null> {
    try {
      const result = await retryWithBackoff(
        () => this.attemptFetch(context, url),
        {
          attempts: FETCH_RETRY_ATTEMPTS,
          baseDelayMs: FETCH_RETRY_BASE_DELAY_MS,
          maxDelayMs: FETCH_RETRY_MAX_DELAY_MS,
        }
      );

      if (!result.ok) {
        logger.warn('BookMyShow: fatal status, not retrying', { city, status: result.status, url });
        return null;
      }

      return result.data;
    } catch (err) {
      logger.error('BookMyShow: request failed after retries', {
        city,
        url,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private async attemptFetch(context: BrowserContext, url: string): Promise<FetchAttemptResult> {
    // Fresh page per attempt -- same rationale as viberate/collector.ts:
    // retrying on a page that just got blocked is worse than a fresh one.
    const page = await context.newPage();

    try {
      const response = await page.request.get(url);
      const status = response.status();

      // 404 (unknown city slug) / 422 (region-city mismatch, confirmed live
      // during recon) are structural problems retrying can't fix.
      if (status === 404 || status === 422) {
        return { ok: false, fatal: true, status };
      }

      if (status !== 200) {
        throw new Error(`Non-200 from BookMyShow: ${status} for ${url}`);
      }

      const contentType = response.headers()['content-type'] || '';
      if (!contentType.includes('application/json')) {
        throw new Error(`Non-JSON response from BookMyShow for ${url}`);
      }

      const data = (await response.json()) as BookMyShowDiscoverResponse;
      return { ok: true, data };
    } finally {
      await page.close();
    }
  }

  private applyDateFilter(
    events: RawConcertEvent[],
    dateFrom: Date | undefined,
    dateTo: Date | undefined
  ): RawConcertEvent[] {
    if (!dateFrom && !dateTo) return events;

    return events.filter((event) => {
      if (!event.eventDate) return true;
      const eventDate = event.eventDate instanceof Date ? event.eventDate : new Date(event.eventDate);
      if (Number.isNaN(eventDate.getTime())) return true;
      if (dateFrom && eventDate < dateFrom) return false;
      if (dateTo && eventDate > dateTo) return false;
      return true;
    });
  }
}

export const bookMyShowScraper = new BookMyShowScraper();

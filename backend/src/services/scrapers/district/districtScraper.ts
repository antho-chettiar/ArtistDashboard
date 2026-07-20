/**
 * districtScraper.ts
 *
 * ConcertSourceScraper implementation for District by Zomato (district.in).
 *
 * Unlike BookMyShow, District needs no separate JSON API call: its events
 * page (https://www.district.in/events/) is server-rendered and embeds a
 * <script type="application/ld+json"> ItemList of schema.org Event objects
 * directly in the HTML -- confirmed via live extraction. This scraper just
 * navigates there with Playwright and reads that script out of the DOM.
 *
 * Two limitations confirmed live (not assumed) during reconnaissance:
 *   - No real pagination: ?page=2 returns the identical item list.
 *   - No controllable city: neither a /{city}/events path nor ?lat=&lng=
 *     query params changed the returned city (server-resolved, IP/session
 *     based). query.cities is therefore applied as a POST-fetch filter
 *     against each event's own embedded city, not a fetch parameter.
 *
 * Does NOT write to Prisma -- returns RawConcertEvent[] inside a ScrapeResult
 * for the caller to persist/normalize.
 *
 * Uses ConcertSourcePlatform 'ZOMATO' -- there is no 'DISTRICT' member in
 * that union (District is Zomato's own rebranded events platform), and this
 * scraper does not add one.
 *
 * Usage:
 *   import { districtScraper } from './districtScraper';
 *   const result = await districtScraper.scrape({});
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
import { DistrictJob, DistrictEventListItem, DEFAULT_EVENTS_URL, SUPPORTED_COUNTRY_ALIASES } from './types';
import { mapEventListToEvents } from './mapper';

// ─── Config ──────────────────────────────────────────────────────────────────

// Delay before each fetch attempt -- same RateLimiter reuse as BookMyShow,
// sized down to one limiter since there's currently only one URL to fetch.
const REQUEST_DELAY_MS = 1500;

// Same retry values as bookmyshow/districtScraper.ts for consistency.
const FETCH_RETRY_ATTEMPTS = 3;
const FETCH_RETRY_BASE_DELAY_MS = 1000;
const FETCH_RETRY_MAX_DELAY_MS = 8000;

// A single fetch attempt either succeeds, or resolves with a fatal
// (non-retryable) status -- everything else throws so retryWithBackoff will
// retry it. Same pattern as bookmyshow/bookMyShowScraper.ts.
type FetchAttemptResult =
  | { ok: true; data: DistrictEventListItem[] }
  | { ok: false; fatal: true; status: number };

export class DistrictScraper implements ConcertSourceScraper {
  readonly source: ConcertSourcePlatform = 'ZOMATO';

  private readonly requestLimiter = new RateLimiter(REQUEST_DELAY_MS);
  // Own namespace -- no collision with 'concert', 'viberate', or 'bookmyshow'.
  private readonly jobQueue = new ScrapingJobQueue<DistrictJob>('district');

  async scrape(query: ScrapeQuery): Promise<ScrapeResult> {
    const errors: string[] = [];

    if (query.country && !SUPPORTED_COUNTRY_ALIASES.includes(query.country.trim().toLowerCase())) {
      return {
        source: this.source,
        events: [],
        errors: [
          `District (Zomato) scraper only supports India (district.in); requested country "${query.country}" is not supported`,
        ],
        fetchedAt: new Date(),
      };
    }

    // One job for the one confirmed-working URL, enqueued then drained in
    // this same call -- same scaffolding pattern as the other scrapers.
    await this.jobQueue.enqueue({ id: randomUUID(), url: DEFAULT_EVENTS_URL, label: 'events' });

    const events: RawConcertEvent[] = [];
    const browser = await chromium.launch({ headless: true });

    try {
      const context = await browser.newContext();
      let job = await this.jobQueue.dequeue();

      while (job) {
        await this.requestLimiter.wait();

        const items = await this.fetchEventItemList(context, job, errors);
        if (items) {
          events.push(...mapEventListToEvents(items, query.artists, query.cities));
        }

        job = await this.jobQueue.dequeue();
      }
    } finally {
      await browser.close();
    }

    if (query.cities?.length && events.length === 0) {
      errors.push(
        `No District events matched requested cities [${query.cities.join(', ')}] -- District's city is server-resolved (IP/session-based) and not directly controllable; only events for the server-resolved city are available per scrape`
      );
    }

    let filtered = this.applyDateFilter(events, query.dateFrom, query.dateTo);
    if (query.limitPerSource && filtered.length > query.limitPerSource) {
      filtered = filtered.slice(0, query.limitPerSource);
    }

    return { source: this.source, events: filtered, errors, fetchedAt: new Date() };
  }

  private async fetchEventItemList(
    context: BrowserContext,
    job: DistrictJob,
    errors: string[]
  ): Promise<DistrictEventListItem[] | null> {
    try {
      const result = await retryWithBackoff(
        () => this.attemptFetch(context, job.url),
        {
          attempts: FETCH_RETRY_ATTEMPTS,
          baseDelayMs: FETCH_RETRY_BASE_DELAY_MS,
          maxDelayMs: FETCH_RETRY_MAX_DELAY_MS,
        }
      );

      if (!result.ok) {
        logger.warn('District: fatal status, not retrying', { url: job.url, status: result.status });
        return null;
      }

      return result.data;
    } catch (err) {
      logger.error('District: request failed after retries', {
        url: job.url,
        error: err instanceof Error ? err.message : String(err),
      });
      errors.push(`District: failed to fetch ${job.label} after ${FETCH_RETRY_ATTEMPTS} attempts`);
      return null;
    }
  }

  private async attemptFetch(context: BrowserContext, url: string): Promise<FetchAttemptResult> {
    // Fresh page per attempt -- same rationale as the other scrapers.
    const page = await context.newPage();

    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const status = response?.status() ?? 0;

      if (status === 404) {
        return { ok: false, fatal: true, status };
      }

      if (status !== 200) {
        throw new Error(`Non-200 from District: ${status} for ${url}`);
      }

      // This callback runs in the browser, not Node -- tsconfig's `lib` has no
      // `dom`, so `document` is accessed via globalThis rather than pulling
      // DOM types into the whole backend build for one evaluate() call.
      const itemList = await page.evaluate((): unknown => {
        const doc = (globalThis as unknown as { document: { querySelectorAll: (selector: string) => ArrayLike<{ textContent: string | null }> } }).document;
        const scripts = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'));
        for (const script of scripts) {
          try {
            const json = JSON.parse(script.textContent || '');
            if (json['@type'] === 'ItemList' && Array.isArray(json.itemListElement)) {
              return json.itemListElement;
            }
          } catch {
            // Not valid JSON, or not the ItemList script -- skip and keep looking.
          }
        }
        return null;
      });

      if (!itemList) {
        throw new Error(`No ItemList JSON-LD found on ${url}`);
      }

      const events = (itemList as { item?: DistrictEventListItem }[])
        .map((entry) => entry.item)
        .filter((item): item is DistrictEventListItem => !!item && item['@type'] === 'Event');

      return { ok: true, data: events };
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

export const districtScraper = new DistrictScraper();

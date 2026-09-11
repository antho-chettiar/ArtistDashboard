/**
 * concertScraperIngestion.service.ts
 *
 * The ingestion layer connecting existing ConcertSourceScraper implementations
 * (BookMyShow, District) to the existing canonical-event pipeline
 * (concertIntelligenceService.ingestRawEvents -> eventNormalizationService ->
 * duplicateDetectionService -> duplicateMergeService -> hybridValidationService).
 *
 * This file does NOT reimplement any of that pipeline -- it only:
 *   1. Runs the registered scrapers to collect RawConcertEvent[]
 *   2. Flattens their output
 *   3. Hands it to concertIntelligenceService.ingestRawEvents(), which already
 *      does normalize -> canonicalKey -> dedupe-check -> CanonicalEvent /
 *      SourceEventReference / DuplicateGroup / DuplicateGroupMember -> validate
 *      (ValidationLog), exactly as already built.
 *
 * This phase never creates Concert rows -- it stops after CanonicalEvent /
 * SourceEventReference / dedup / ValidationLog. (Revenue prediction was
 * removed from concertIntelligenceService entirely -- FORMULA_DECISIONS.md
 * §3, System 6 -- so there is no longer a runPredictions/persistConcerts
 * option to opt into here.)
 *
 * Contains zero Prisma calls -- all persistence is delegated to the existing
 * services above.
 *
 * Usage:
 *   import { runConcertScraperIngestion } from './concertScraperIngestion.service';
 *   const summary = await runConcertScraperIngestion({ cities: ['Mumbai'] });
 */

import { bookMyShowScraper } from '../scrapers/bookmyshow/bookMyShowScraper';
import { districtScraper } from '../scrapers/district/districtScraper';
import { ConcertSourcePlatform, ConcertSourceScraper, RawConcertEvent, ScrapeQuery } from '../scrapers/types';
import { concertIntelligenceService, ConcertIntelligenceSummary } from '../concertIntelligence.service';

// The only ConcertSourceScraper implementations that exist today. Viberate's
// collector is deliberately excluded -- it is not a ConcertSourceScraper
// (different domain: artist social metrics, writes its own Prisma rows).
const AVAILABLE_SCRAPERS: ConcertSourceScraper[] = [bookMyShowScraper, districtScraper];

export const AVAILABLE_SCRAPER_SOURCES: ConcertSourcePlatform[] = AVAILABLE_SCRAPERS.map(
  (scraper) => scraper.source
);

export interface ConcertScraperIngestionOptions {
  dryRun?: boolean;
}

export interface ScraperSourceResult {
  source: ConcertSourcePlatform;
  eventCount: number;
  errors: string[];
}

export interface ConcertScraperIngestionSummary {
  scraperResults: ScraperSourceResult[];
  totalRawEvents: number;
  summary: ConcertIntelligenceSummary;
}

function resolveScrapers(sources: ConcertSourcePlatform[] | undefined): ConcertSourceScraper[] {
  if (!sources || sources.length === 0) return AVAILABLE_SCRAPERS;
  return AVAILABLE_SCRAPERS.filter((scraper) => sources.includes(scraper.source));
}

async function runScraper(
  scraper: ConcertSourceScraper,
  query: ScrapeQuery
): Promise<{ events: RawConcertEvent[]; result: ScraperSourceResult }> {
  try {
    const scrapeResult = await scraper.scrape(query);
    return {
      events: scrapeResult.events,
      result: {
        source: scraper.source,
        eventCount: scrapeResult.events.length,
        errors: scrapeResult.errors,
      },
    };
  } catch (err) {
    // One scraper throwing must not drop events already fetched by others.
    const message = err instanceof Error ? err.message : String(err);
    return {
      events: [],
      result: { source: scraper.source, eventCount: 0, errors: [`Scraper threw: ${message}`] },
    };
  }
}

export async function runConcertScraperIngestion(
  query: ScrapeQuery = {},
  options: ConcertScraperIngestionOptions = {}
): Promise<ConcertScraperIngestionSummary> {
  const scrapers = resolveScrapers(query.sources);

  const scraperRuns = await Promise.all(scrapers.map((scraper) => runScraper(scraper, query)));

  const scraperResults = scraperRuns.map((run) => run.result);
  const rawEvents = scraperRuns.flatMap((run) => run.events);

  const summary = await concertIntelligenceService.ingestRawEvents(rawEvents, {
    ...query,
    dryRun: options.dryRun,
  });

  return {
    scraperResults,
    totalRawEvents: rawEvents.length,
    summary,
  };
}

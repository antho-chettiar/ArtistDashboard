import { duplicateDetectionService } from './deduplication/duplicateDetection.service';
import { duplicateMergeService } from './deduplication/duplicateMerge.service';
import { eventNormalizationService } from './normalization/eventNormalization.service';
import { NormalizedConcertEvent } from './normalization/types';
import { RawConcertEvent, ScrapeQuery } from './scrapers/types';
import { hybridValidationService } from './validation/hybridValidation.service';
import { HybridValidationResult } from './validation/types';

// NOTE: this pipeline previously also ran a Node-local revenue prediction
// (predictForEvent / persistPredictedConcert, backed by revenuePredictionService
// — the "hybrid-revenue-v1" model) and could persist a Concert row from that
// prediction. That model was removed as part of the Revenue-system
// consolidation (FORMULA_DECISIONS.md §3, System 6) since it had no
// product-facing consumer. This pipeline now only dedups/normalizes/validates.

export interface ConcertIntelligenceOptions extends ScrapeQuery {
  artistIds?: string[];
  dryRun?: boolean;
  artistLimit?: number;
}

export interface ConcertIntelligenceEventResult {
  canonicalEventId?: string;
  action: 'created' | 'updated' | 'merged' | 'dry_run' | 'skipped';
  event: NormalizedConcertEvent;
  duplicateCount: number;
  duplicateGroupId?: string;
  validation?: HybridValidationResult;
  reason?: string;
}

export interface ConcertIntelligenceSummary {
  jobId?: string;
  scrapedCount: number;
  normalizedCount: number;
  persistedCount: number;
  duplicateCount: number;
  validatedCount: number;
  results: ConcertIntelligenceEventResult[];
  errors: string[];
}

export class ConcertIntelligenceService {
  async runDiscoveryPipeline(options: ConcertIntelligenceOptions): Promise<ConcertIntelligenceSummary> {
    // Concert scraping is now handled by the Python mad_analytics scheduler.
    // This pipeline processes any events passed directly or from the DB.
    const normalizedEvents = eventNormalizationService.normalizeBatch([] as RawConcertEvent[]);
    const results: ConcertIntelligenceEventResult[] = [];

    for (const event of normalizedEvents) {
      try {
        const deduplication = await duplicateDetectionService.detect(event);

        if (options.dryRun) {
          results.push({
            action: 'dry_run',
            event,
            duplicateCount: deduplication.duplicates.length,
          });
          continue;
        }

        const persistence = await duplicateMergeService.persistNormalizedEvent(event, deduplication);
        const validation = await hybridValidationService.validate(event, {
          canonicalEventId: persistence.canonicalEventId,
          duplicateDetected: persistence.action === 'merged' || deduplication.duplicates.length > 0,
        });

        results.push({
          canonicalEventId: persistence.canonicalEventId,
          action: persistence.action,
          event,
          duplicateCount: deduplication.duplicates.length,
          duplicateGroupId: persistence.duplicateGroupId,
          validation,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({
          action: 'skipped',
          event,
          duplicateCount: 0,
          reason: message,
        });
      }
    }

    return {
      jobId: 'python-scheduler',
      scrapedCount: 0,
      normalizedCount: normalizedEvents.length,
      persistedCount: results.filter((result) => ['created', 'updated', 'merged'].includes(result.action)).length,
      duplicateCount: results.filter((result) => result.action === 'merged').length,
      validatedCount: results.filter((result) => result.validation).length,
      results,
      errors: [],
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async enqueueDiscoveryPipeline(_options: ConcertIntelligenceOptions): Promise<string> {
    // Scraping is now handled by the Python mad_analytics background scheduler.
    return 'scraping-handled-by-python-scheduler';
  }

  async ingestRawEvents(
    rawEvents: RawConcertEvent[],
    options: Omit<ConcertIntelligenceOptions, 'sources'> = {}
  ): Promise<ConcertIntelligenceSummary> {
    const normalizedEvents = eventNormalizationService.normalizeBatch(rawEvents);
    const results = await this.processNormalizedEvents(normalizedEvents, options);

    return {
      scrapedCount: rawEvents.length,
      normalizedCount: normalizedEvents.length,
      persistedCount: results.filter((result) => ['created', 'updated', 'merged'].includes(result.action)).length,
      duplicateCount: results.filter((result) => result.action === 'merged').length,
      validatedCount: results.filter((result) => result.validation).length,
      results,
      errors: [],
    };
  }

  private async processNormalizedEvents(
    normalizedEvents: NormalizedConcertEvent[],
    options: ConcertIntelligenceOptions
  ): Promise<ConcertIntelligenceEventResult[]> {
    const results: ConcertIntelligenceEventResult[] = [];

    for (const event of normalizedEvents) {
      try {
        const deduplication = await duplicateDetectionService.detect(event);

        if (options.dryRun) {
          results.push({
            action: 'dry_run',
            event,
            duplicateCount: deduplication.duplicates.length,
          });
          continue;
        }

        const persistence = await duplicateMergeService.persistNormalizedEvent(event, deduplication);
        const validation = await hybridValidationService.validate(event, {
          canonicalEventId: persistence.canonicalEventId,
          duplicateDetected: persistence.action === 'merged' || deduplication.duplicates.length > 0,
        });

        results.push({
          canonicalEventId: persistence.canonicalEventId,
          action: persistence.action,
          event,
          duplicateCount: deduplication.duplicates.length,
          duplicateGroupId: persistence.duplicateGroupId,
          validation,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({
          action: 'skipped',
          event,
          duplicateCount: 0,
          reason: message,
        });
      }
    }

    return results;
  }
}

export const concertIntelligenceService = new ConcertIntelligenceService();

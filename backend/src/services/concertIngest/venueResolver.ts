/**
 * concertIngest/venueResolver.ts
 *
 * Reusable venue matching for any concert ingestion source. Given a real
 * (non-placeholder) venue, either match an existing Venue row or produce a
 * plan to create one. Never writes — the caller decides when/if to persist,
 * so this is safe for dry-runs and reusable by the future scrapers.
 *
 * Matching is by normalized(name) within the same normalized(city) + country,
 * which is tolerant of case/punctuation differences while respecting the
 * Venue @@unique([name, city, country]) constraint.
 */
import type { PrismaClient } from '@prisma/client';
import { normalizeComparableName } from './normalize';

export interface VenueQuery {
  /** Cleaned, real venue name (caller must have classified it as real). */
  name: string;
  city: string;
  country: string;
  state?: string | null;
}

export interface PlannedVenue {
  name: string;
  city: string;
  state: string | null;
  country: string;
}

export type VenueResolution =
  | { action: 'match'; venueId: string; matchedName: string }
  | { action: 'create'; plan: PlannedVenue };

/** Minimal Prisma surface needed — keeps this unit-testable with a fake. */
type VenueReader = Pick<PrismaClient['venue'], 'findMany'>;

/**
 * Resolve a single venue against the DB (read-only).
 *
 * `seenPlans` lets the caller dedup venues *within one import run* so the same
 * new venue isn't proposed (or later created) twice. Keyed by
 * normalized(name)|normalized(city)|normalized(country).
 */
export async function resolveVenue(
  venue: { findMany: VenueReader['findMany'] },
  query: VenueQuery,
  seenPlans?: Map<string, PlannedVenue>
): Promise<VenueResolution> {
  const normName = normalizeComparableName(query.name);
  const normCity = normalizeComparableName(query.city);
  const normCountry = normalizeComparableName(query.country);
  const runKey = `${normName}|${normCity}|${normCountry}`;

  // Read candidates in the same city (case-insensitive), then compare on the
  // normalized name to absorb punctuation/casing differences.
  const candidates = await venue.findMany({
    where: {
      city: { equals: query.city, mode: 'insensitive' },
      country: { equals: query.country, mode: 'insensitive' },
    },
    select: { id: true, name: true, city: true, country: true },
  });

  const match = candidates.find((c) => normalizeComparableName(c.name) === normName);
  if (match) {
    return { action: 'match', venueId: match.id, matchedName: match.name };
  }

  const plan: PlannedVenue = {
    name: query.name,
    city: query.city,
    state: query.state ?? null,
    country: query.country,
  };

  if (seenPlans) {
    const existingPlan = seenPlans.get(runKey);
    if (existingPlan) {
      // Already planned earlier in this run — reuse, don't double-propose.
      return { action: 'create', plan: existingPlan };
    }
    seenPlans.set(runKey, plan);
  }

  return { action: 'create', plan };
}

/** Stable in-run key for a venue (name|city|country), all normalized. */
export function venueRunKey(name: string, city: string, country: string): string {
  return [normalizeComparableName(name), normalizeComparableName(city), normalizeComparableName(country)].join('|');
}

/**
 * mapper.ts (BookMyShow)
 *
 * Converts BookMyShow's raw discover-API events into RawConcertEvent rows.
 * Kept separate from bookMyShowScraper.ts so it can be unit-tested independently
 * (same separation as viberate/mapper.ts).
 */

import { RawConcertEvent } from '../types';
import { BookMyShowDiscoverResponse, BookMyShowRawEvent } from './types';

// Matches the "ET00500758" style ID at the end of a BookMyShow event URL.
const EVENT_ID_PATTERN = /(ET\d+)(?:[/?].*)?$/i;

function extractEventId(url: string): string | undefined {
  const match = url.match(EVENT_ID_PATTERN);
  return match ? match[1].toUpperCase() : undefined;
}

// BookMyShow's location.name is formatted "Venue Name: City" -- strip the
// city suffix so venueName doesn't duplicate the separate `city` field.
function cleanVenueName(locationName: string | undefined, city: string): string | undefined {
  if (!locationName) return undefined;
  const suffix = `: ${city}`;
  if (locationName.toLowerCase().endsWith(suffix.toLowerCase())) {
    return locationName.slice(0, locationName.length - suffix.length).trim();
  }
  return locationName.trim();
}

function titleMatchesArtist(title: string, artist: string): boolean {
  return title.toLowerCase().includes(artist.toLowerCase());
}

export function mapDiscoverResponseToEvents(
  response: BookMyShowDiscoverResponse,
  city: string,
  country: string,
  requestedArtists?: string[]
): RawConcertEvent[] {
  const rawEvents: BookMyShowRawEvent[] = response.meta?.ldSchema?.eventsSchema ?? [];
  const events: RawConcertEvent[] = [];

  for (const raw of rawEvents) {
    const matchedArtist = requestedArtists?.find((artist) => titleMatchesArtist(raw.name, artist));

    // BookMyShow has no structured artist field -- if specific artists were
    // requested, only keep events whose title actually references one of them.
    if (requestedArtists && requestedArtists.length > 0 && !matchedArtist) {
      continue;
    }

    events.push({
      // Best-effort: when no artist filter was given, fall back to the event
      // title itself (many listings are literally named after the performer,
      // but this is a heuristic, not a guarantee, for this data source).
      artistName: matchedArtist ?? raw.name,
      eventName: raw.name,
      venueName: cleanVenueName(raw.location?.name, city),
      city,
      country,
      eventDate: raw.startDate,
      sourcePlatform: 'BOOKMYSHOW',
      sourceUrl: raw.url,
      sourceEventId: extractEventId(raw.url),
      confidenceScore: matchedArtist ? 0.8 : 0.5,
      rawPayload: raw as unknown as Record<string, unknown>,
    });
  }

  return events;
}

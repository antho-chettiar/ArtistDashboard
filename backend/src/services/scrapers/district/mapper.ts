/**
 * mapper.ts (District)
 *
 * Converts District's JSON-LD event items into RawConcertEvent rows.
 * Kept separate from districtScraper.ts so it can be unit-tested independently
 * (same separation as bookmyshow/mapper.ts and viberate/mapper.ts).
 */

import { RawConcertEvent } from '../types';
import { DistrictEventListItem } from './types';

function titleMatchesArtist(title: string, artist: string): boolean {
  return title.toLowerCase().includes(artist.toLowerCase());
}

// District has no separate numeric event ID (unlike BookMyShow's "ET00xxxx")
// -- use the last path segment of the event URL as a stable-enough identifier.
function extractSlugId(url: string): string | undefined {
  const match = url.match(/\/events\/([^/?]+)/i);
  return match ? match[1] : undefined;
}

function mapCountryCode(code: string | undefined): string {
  if (!code) return 'India';
  return code.trim().toUpperCase() === 'IN' ? 'India' : code;
}

function parsePriceRange(offer: DistrictEventListItem['offers']): RawConcertEvent['ticketPriceRange'] {
  if (!offer?.price) return undefined;
  const price = Number(offer.price);
  if (Number.isNaN(price)) return undefined;
  return { min: price, max: price, currency: offer.priceCurrency ?? 'INR' };
}

export function mapEventListToEvents(
  items: DistrictEventListItem[],
  requestedArtists?: string[],
  requestedCities?: string[]
): RawConcertEvent[] {
  const events: RawConcertEvent[] = [];

  for (const item of items) {
    const matchedArtist = requestedArtists?.find((artist) => titleMatchesArtist(item.name, artist));

    // Same best-effort heuristic as bookmyshow/mapper.ts: District has no
    // structured artist field, so only keep events whose title actually
    // references a requested artist when a filter was given.
    if (requestedArtists && requestedArtists.length > 0 && !matchedArtist) {
      continue;
    }

    // District's city isn't selectable per-job (unlike BookMyShow) -- filter
    // per-event against each item's own embedded city instead.
    const city = item.location?.address?.addressLocality;
    if (requestedCities && requestedCities.length > 0) {
      const cityMatches = !!city && requestedCities.some((c) => c.trim().toLowerCase() === city.toLowerCase());
      if (!cityMatches) {
        continue;
      }
    }

    events.push({
      artistName: matchedArtist ?? item.name,
      eventName: item.name,
      venueName: item.location?.name,
      city,
      country: mapCountryCode(item.location?.address?.addressCountry),
      eventDate: item.startDate,
      sourcePlatform: 'ZOMATO',
      sourceUrl: item.url,
      sourceEventId: extractSlugId(item.url),
      ticketPriceRange: parsePriceRange(item.offers),
      confidenceScore: matchedArtist ? 0.8 : 0.5,
      rawPayload: item as unknown as Record<string, unknown>,
    });
  }

  return events;
}

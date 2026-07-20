/**
 * types.ts (District)
 *
 * Local types for the District (Zomato) scraper only. Kept out of the shared
 * scrapers/types.ts on purpose -- same convention as bookmyshow/types.ts:
 * that file holds types shared across multiple scrapers/consumers, while
 * these have exactly one consumer: districtScraper.ts.
 */

// ─── JSON-LD event shape ─────────────────────────────────────────────────────
// Confirmed via live extraction of the <script type="application/ld+json">
// ItemList embedded directly in the server-rendered HTML of
// https://www.district.in/events/ -- no separate API call needed.

export interface DistrictEventOffer {
  price?: string;
  priceCurrency?: string;
}

export interface DistrictEventLocation {
  name?: string;
  address?: {
    addressLocality?: string; // city, e.g. "Delhi/NCR"
    addressCountry?: string; // ISO code, e.g. "IN"
  };
}

export interface DistrictEventListItem {
  '@type': string; // "Event" -- filtered on this when parsing itemListElement
  name: string;
  url: string;
  startDate: string; // ISO datetime, e.g. "2026-08-01T07:30:00.000Z"
  endDate?: string;
  location?: DistrictEventLocation;
  offers?: DistrictEventOffer;
}

// ─── Job queue payload ───────────────────────────────────────────────────────
// One job = one known-working URL to extract an ItemList from. Currently
// exactly one (DEFAULT_EVENTS_URL) -- District's events page has no
// confirmed pagination or city-selection parameter (both tested live and
// found to be no-ops), so there is nothing else to fan out over yet.
export interface DistrictJob {
  id: string;
  url: string;
  label: string;
}

export const DEFAULT_EVENTS_URL = 'https://www.district.in/events/';

// Country aliases this scraper recognizes as "India" (district.in is
// India-only, same stance as the BookMyShow scraper).
export const SUPPORTED_COUNTRY_ALIASES = ['india', 'in'];

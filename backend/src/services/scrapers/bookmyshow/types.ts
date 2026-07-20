/**
 * types.ts (BookMyShow)
 *
 * Local types for the BookMyShow scraper only. Kept out of the shared
 * scrapers/types.ts on purpose -- that file holds types shared across
 * multiple scrapers/consumers (ConcertSourcePlatform, ScrapeQuery, etc.),
 * while these have exactly one consumer: bookMyShowScraper.ts.
 */

// ─── Raw discover-API response shape ────────────────────────────────────────
// Confirmed via live network capture against in.bookmyshow.com's internal
// (undocumented) JSON API: GET /api/explore/v1/discover/concerts-{citySlug}
// Only the fields this scraper actually reads are typed here.

export interface BookMyShowEventLocation {
  name?: string; // e.g. "Mahalaxmi Race Course: Mumbai" -- "Venue: City"
  address?: {
    streetAddress?: string;
    addressCountry?: string;
  };
}

export interface BookMyShowRawEvent {
  url: string;
  name: string;
  startDate: string; // ISO date, e.g. "2026-07-25"
  endDate?: string;
  location?: BookMyShowEventLocation;
  image?: string[];
}

export interface BookMyShowDiscoverResponse {
  scrollId?: string;
  pageId?: string;
  filterRoute?: string;
  meta?: {
    ldSchema?: {
      eventsSchema?: BookMyShowRawEvent[];
    };
  };
}

// ─── Job queue payload ───────────────────────────────────────────────────────
// One job = one city's full paginated scrape.

export interface BookMyShowJob {
  id: string;
  city: string;
  region: string;
  lat: number;
  lon: number;
  slug: string;
}

// ─── City lookup table ───────────────────────────────────────────────────────
// `mumbai` verified live (region/lat/lon confirmed via real navigation +
// network capture). The rest are best-effort, following the same
// uppercase-city-name region-code convention observed for Mumbai --
// NOT independently verified. A bad entry here fails that one city
// gracefully (see bookMyShowScraper.ts's fatal-status handling) rather
// than breaking the whole scrape.
export interface CityRegionEntry {
  region: string;
  lat: number;
  lon: number;
  slug: string; // BookMyShow's URL slug for this city, e.g. "mumbai"
}

export const CITY_REGION_MAP: Record<string, CityRegionEntry> = {
  mumbai: { region: 'MUMBAI', lat: 19.076, lon: 72.8777, slug: 'mumbai' }, // verified live
  delhi: { region: 'DELHI', lat: 28.7041, lon: 77.1025, slug: 'delhi-ncr' },
  bengaluru: { region: 'BENGALURU', lat: 12.9716, lon: 77.5946, slug: 'bengaluru' },
  bangalore: { region: 'BENGALURU', lat: 12.9716, lon: 77.5946, slug: 'bengaluru' },
  pune: { region: 'PUNE', lat: 18.5204, lon: 73.8567, slug: 'pune' },
  hyderabad: { region: 'HYDERABAD', lat: 17.385, lon: 78.4867, slug: 'hyderabad' },
  chennai: { region: 'CHENNAI', lat: 13.0827, lon: 80.2707, slug: 'chennai' },
  kolkata: { region: 'KOLKATA', lat: 22.5726, lon: 88.3639, slug: 'kolkata' },
};

export const DEFAULT_CITIES = ['Mumbai'];

// Country aliases this scraper recognizes as "India" (BookMyShow is
// in.bookmyshow.com only -- no other country is supported).
export const SUPPORTED_COUNTRY_ALIASES = ['india', 'in'];

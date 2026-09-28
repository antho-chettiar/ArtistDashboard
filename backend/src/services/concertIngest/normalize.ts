/**
 * concertIngest/normalize.ts
 *
 * Framework-agnostic normalization helpers shared by every concert ingestion
 * source (historical Excel import now; BookMyShow / District scrapers later).
 *
 * Pure functions only — no DB, no I/O. Everything here is unit-testable and
 * deliberately free of Excel- or scraper-specific assumptions so both callers
 * can reuse the exact same city/venue/date/identity logic.
 */

// ── Text cleaning ────────────────────────────────────────────────────────────

/** Collapse internal whitespace and trim. Always returns a string. */
export function collapseWhitespace(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cleaned text, or null when the value is empty/whitespace-only. */
export function cleanText(value: unknown): string | null {
  const cleaned = collapseWhitespace(value);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Comparable form used for matching/dedup (venue, city, artist).
 * Lowercase, ASCII-fold, `&`→`and`, strip punctuation, collapse spaces.
 * Intentionally does NOT strip words like "live"/"tour" — those can
 * distinguish real venues, and over-stripping would merge distinct rows.
 */
export function normalizeComparableName(value: unknown): string {
  return collapseWhitespace(value)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Date handling ────────────────────────────────────────────────────────────

export interface ParsedDate {
  /** UTC date-only (midnight) when valid, else null. */
  date: Date | null;
  /** True when the cell was a bare year (e.g. 2001, 2023) — the malformed rows. */
  malformedYearOnly: boolean;
}

// Excel's 1900 date system, using the 1899-12-30 epoch that already accounts
// for the historical 1900-leap-year bug (correct for every date after
// 1900-03-01, which covers all concert dates here).
const EXCEL_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;
// Real Excel serials for modern concert dates are ~39000+. Anything small is a
// bare year, not a serial (year 1908 ≈ serial 3000), so 3000 cleanly separates
// the two without ever misclassifying a real date.
const SERIAL_THRESHOLD = 3000;

function toUtcDateOnly(y: number, m0: number, d: number): Date {
  return new Date(Date.UTC(y, m0, d));
}

/**
 * Parse a concert date from any source form:
 *   - number  : Excel serial (>= threshold) → date; small number → bare year (malformed)
 *   - Date    : re-expressed as UTC date-only (TZ-safe)
 *   - string  : "2001" bare year → malformed; otherwise Date.parse
 */
export function parseConcertDate(value: unknown): ParsedDate {
  if (value === null || value === undefined || value === '') {
    return { date: null, malformedYearOnly: false };
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value < SERIAL_THRESHOLD) {
      // Bare year like 2001 / 2023 — cannot resolve to a real date.
      return { date: null, malformedYearOnly: isYearLike(value) };
    }
    const ms = EXCEL_EPOCH_UTC_MS + Math.round(value) * MS_PER_DAY;
    const d = new Date(ms);
    return { date: toUtcDateOnly(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), malformedYearOnly: false };
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return { date: toUtcDateOnly(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()), malformedYearOnly: false };
  }

  const str = collapseWhitespace(value);
  if (/^\d{4}$/.test(str) && isYearLike(Number(str))) {
    return { date: null, malformedYearOnly: true };
  }
  const parsed = new Date(str);
  if (Number.isNaN(parsed.getTime())) {
    return { date: null, malformedYearOnly: false };
  }
  return { date: toUtcDateOnly(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()), malformedYearOnly: false };
}

function isYearLike(n: number): boolean {
  return Number.isInteger(n) && n >= 1900 && n <= 2100;
}

/** UTC yyyy-mm-dd for a date-only value (used in event identity + reports). */
export function toIsoDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ── Venue classification ─────────────────────────────────────────────────────

export type VenueKind = 'blank' | 'placeholder' | 'real';

export interface VenueClassification {
  kind: VenueKind;
  /** Sub-reason for placeholders: which rule matched. */
  reason: string;
  /** Text to preserve on the Concert row (null only when blank). */
  text: string | null;
  /** Comparable venue name — only set for real venues. */
  normalizedName: string | null;
}

// Explicit "no real venue named" phrasings observed in the dataset.
const PLACEHOLDER_TEXT_PATTERNS: RegExp[] = [
  /\bto be announced\b/i,
  /\btba\b/i,
  /\bnot identified\b/i,
  /\bnot specified\b/i,
  /\bnot publicly (verified|specified|available|known)\b/i,
  /\bnot (verified|available|known|confirmed)\b/i,
  /\bvenue not\b/i,
  /^not specified$/i,
];

// Non-specific / online "venues" that should also not become Venue records.
const NONSPECIFIC_VENUE_PATTERNS: RegExp[] = [
  /^online\b/i,
  /\blive stream\b/i,
  /\(online\)/i,
  /online\s*\/\s*facebook/i,
  /^festival venues?$/i,
  /^conference venue$/i,
  /^festival venue$/i,
];

/**
 * Decide how a raw venue string should be handled.
 *   blank        → venueName NULL, no Venue record
 *   placeholder  → preserve text on Concert, no Venue record
 *   real         → preserve text on Concert AND find/create a Venue record
 *
 * `city` is required because "Mumbai" listed as the venue of a Mumbai concert
 * is a city-as-venue placeholder, not a real venue.
 *
 * `knownPlaces` (optional) is a set of normalized city/region names. When the
 * venue text is itself one of those bare place names (e.g. venue "Delhi" for a
 * concert in "New Delhi"), it is treated as non-identifiable — this catches the
 * city-as-venue case even when the venue's place name differs from the row's
 * own city string. Callers pass a gazetteer (the workbook's cities now; a
 * scraper's city list later).
 */
export function classifyVenue(
  rawVenue: unknown,
  city: unknown,
  knownPlaces?: Set<string>
): VenueClassification {
  const text = cleanText(rawVenue);
  if (text === null) {
    return { kind: 'blank', reason: 'blank', text: null, normalizedName: null };
  }

  if (PLACEHOLDER_TEXT_PATTERNS.some((re) => re.test(text))) {
    return { kind: 'placeholder', reason: 'no-venue-text', text, normalizedName: null };
  }

  const normVenue = normalizeComparableName(text);
  const normCity = normalizeComparableName(city);
  if (normVenue.length > 0 && normVenue === normCity) {
    return { kind: 'placeholder', reason: 'city-as-venue', text, normalizedName: null };
  }

  if (normVenue.length > 0 && knownPlaces?.has(normVenue)) {
    return { kind: 'placeholder', reason: 'bare-place-name', text, normalizedName: null };
  }

  if (NONSPECIFIC_VENUE_PATTERNS.some((re) => re.test(text))) {
    return { kind: 'placeholder', reason: 'nonspecific-or-online', text, normalizedName: null };
  }

  return { kind: 'real', reason: 'real', text, normalizedName: normVenue };
}

// ── Country inference ────────────────────────────────────────────────────────

export type CountryReason =
  | 'india-state'
  | 'india-city'
  | 'foreign-state'
  | 'foreign-city'
  | 'virtual'
  | 'ambiguous';

export interface CountryInference {
  /** Resolved country, or null when it must NOT be invented (ambiguous/virtual). */
  country: string | null;
  reason: CountryReason;
}

// Full Indian states + union territories (normalized) — reusable across sources.
const INDIAN_STATES = new Set<string>([
  'andhra pradesh', 'arunachal pradesh', 'assam', 'bihar', 'chhattisgarh', 'goa',
  'gujarat', 'haryana', 'himachal pradesh', 'jharkhand', 'karnataka', 'kerala',
  'madhya pradesh', 'maharashtra', 'manipur', 'meghalaya', 'mizoram', 'nagaland',
  'odisha', 'punjab', 'rajasthan', 'sikkim', 'tamil nadu', 'telangana', 'tripura',
  'uttar pradesh', 'uttarakhand', 'west bengal',
  // Union territories
  'andaman and nicobar islands', 'chandigarh', 'dadra and nagar haveli',
  'daman and diu', 'dadra and nagar haveli and daman and diu', 'delhi',
  'jammu and kashmir', 'ladakh', 'lakshadweep', 'puducherry',
]);

// Minimal foreign lookups covering this dataset; extend as scrapers add sources.
const FOREIGN_STATE = new Map<string, string>([
  ['uae', 'UAE'],
  ['united arab emirates', 'UAE'],
]);
const FOREIGN_CITY = new Map<string, string>([
  ['abu dhabi', 'UAE'],
  ['dubai', 'UAE'],
  ['sharjah', 'UAE'],
]);
const VIRTUAL_TOKENS = new Set<string>(['online', 'virtual']);

/**
 * Infer a concert's country ONLY when the location is explicit and unambiguous.
 * Returns country=null (never invented) for virtual/online or ambiguous rows so
 * the caller can hold them out rather than mislabel them.
 */
export function inferCountry(city: unknown, state: unknown): CountryInference {
  const c = normalizeComparableName(city);
  const s = normalizeComparableName(state);

  if (VIRTUAL_TOKENS.has(c) || VIRTUAL_TOKENS.has(s) || /\b(live stream|livestream|streaming|webcast)\b/.test(c)) {
    return { country: null, reason: 'virtual' };
  }
  const fState = FOREIGN_STATE.get(s);
  if (fState) return { country: fState, reason: 'foreign-state' };
  const fCity = FOREIGN_CITY.get(c);
  if (fCity) return { country: fCity, reason: 'foreign-city' };
  if (s === 'india' || INDIAN_STATES.has(s)) return { country: 'India', reason: 'india-state' };

  return { country: null, reason: 'ambiguous' };
}

// ── Event identity ───────────────────────────────────────────────────────────

export interface EventIdentityParts {
  artistId: string;
  date: Date;
  city: string;
  /** Cleaned real venue name, if any. */
  venueName?: string | null;
  /** Event name, used as the fallback discriminator when venue is missing. */
  eventName?: string | null;
}

/**
 * Application-level event identity (the agreed dedup key):
 *   artistId | yyyy-mm-dd | normalizedCity | (normalizedVenue OR normalizedEvent OR 'unknown')
 *
 * Shared by the historical import and future scrapers so both converge on one
 * row per real event. Venue is preferred; when it's blank/placeholder we fall
 * back to the event name so same-artist/same-city/same-day rows stay distinct.
 */
export function buildEventIdentity(parts: EventIdentityParts): string {
  const city = normalizeComparableName(parts.city);
  const venue = normalizeComparableName(parts.venueName ?? '');
  const event = normalizeComparableName(parts.eventName ?? '');
  const discriminator = venue || event || 'unknown';
  return [parts.artistId, toIsoDateOnly(parts.date), city, discriminator].join('|');
}

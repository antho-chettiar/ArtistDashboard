/**
 * import-historical-concerts.ts
 *
 * Dedicated importer for the historical concert workbook
 * (Artist Concert Data.xlsx). One sheet per artist; the sheet NAME is the
 * artist name. Uses the EXISTING Concert and Venue models — no schema change.
 *
 * All source-agnostic logic (normalization, venue matching, event identity)
 * lives in src/services/concertIngest/* so the future BookMyShow/District
 * ingestion can reuse it. This script only does the Excel-specific parts:
 * reading sheets/columns and orchestrating the report.
 *
 * SAFE BY DEFAULT: dry-run — reads the DB but writes NOTHING. Pass --commit to
 * persist (Venues upserted into the catalog, then Concerts inserted).
 *
 * Usage:
 *   npx tsx scripts/import-historical-concerts.ts [path/to.xlsx]           # dry-run
 *   npx tsx scripts/import-historical-concerts.ts --sample 10              # dry-run, N samples
 *   npx tsx scripts/import-historical-concerts.ts --commit                 # WRITE (not for now)
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as XLSX from 'xlsx';
import { PrismaClient, Prisma } from '@prisma/client';
import {
  cleanText,
  parseConcertDate,
  classifyVenue,
  inferCountry,
  normalizeComparableName,
  toIsoDateOnly,
} from '../src/services/concertIngest/normalize';
import { resolveVenue, venueRunKey, PlannedVenue } from '../src/services/concertIngest/venueResolver';
import { detectDuplicateConcert } from '../src/services/concertIngest/concertResolver';

/**
 * Explicit artist aliases: normalized sheet name → target artistName in the DB.
 * Used ONLY to map a workbook sheet onto an EXISTING Artist. Never creates one.
 * "Sachet Parampara" (space) → "Sachet-Parampara" (hyphen) is the known case.
 */
const ARTIST_ALIASES: Record<string, string> = {
  'sachet parampara': 'Sachet-Parampara',
};

// ── Args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const sampleIdx = args.indexOf('--sample');
const SAMPLE_N = sampleIdx >= 0 && args[sampleIdx + 1] ? parseInt(args[sampleIdx + 1], 10) : 10;
const filePathArg = args.find((a) => !a.startsWith('--') && a !== String(SAMPLE_N));
const FILE = filePathArg
  ? path.resolve(filePathArg)
  : path.resolve('C:\\Users\\Anthony.C\\Downloads\\Artist Concert Data.xlsx');

const CURRENCY = 'INR';

const prisma = new PrismaClient();

// ── Report accumulators ──────────────────────────────────────────────────────
interface ConcertPlan {
  artistName: string;
  artistId: string;
  concertDate: string;
  city: string;
  state: string | null;
  venueName: string | null;
  venueKind: string;
  country: string;
  currency: string;
  capacity: null;
  avgTicketPrice: null;
  totalRevenue: null;
  ticketsSold: number; // schema default 0 = UNKNOWN, not real zero sales
  demandScore: null;
  verificationStatus: 'PENDING';
  notes: string | null; // Excel "Event Name" (also the venue-fallback for identity)
  identity: string;
}

interface VenueAction {
  action: 'match' | 'create';
  name: string;
  city: string;
  detail: string;
}

const stats = {
  sheetsProcessed: 0,
  unmatchedArtists: [] as string[],
  matchedArtists: [] as string[],
  aliasMappings: [] as string[],
  rowsRead: 0,
  malformedDatesIgnored: 0,
  otherInvalidDates: 0,
  missingCity: 0,
  validConcerts: 0,
  duplicatesInFile: 0,
  duplicatesInDb: 0,
  venuesReal: 0,
  venuesNewProposed: 0,
  venuesExistingMatched: 0,
  blankVenues: 0,
  cityAsVenue: 0,
  explicitPlaceholder: 0,
  onlineNonspecific: 0,
  countryUnresolved: 0,
};

const concertPlans: ConcertPlan[] = [];
const venueActions: VenueAction[] = [];
const nonIndiaRecords: string[] = [];
const unresolvedCountryRecords: string[] = [];
const anomalies: string[] = [];

// In-run dedup state
const seenIdentities = new Set<string>();
const seenVenuePlans = new Map<string, PlannedVenue>();
const proposedVenueKeys = new Set<string>();

// Gazetteer of bare place names (normalized) built from the workbook's own
// City/State columns; lets classifyVenue reject "Delhi" as a venue in "New Delhi".
const knownPlaces = new Set<string>();

interface ArtistResolution {
  id: string;
  artistName: string;
  via: 'exact' | 'alias' | 'normalized';
  aliasNote?: string;
}

async function resolveArtistId(sheetName: string): Promise<ArtistResolution | null> {
  const name = cleanText(sheetName);
  if (!name) return null;

  // 1) Exact (case-insensitive) artistName match.
  const exact = await prisma.artist.findFirst({
    where: { artistName: { equals: name, mode: 'insensitive' } },
    select: { id: true, artistName: true },
  });
  if (exact) return { ...exact, via: 'exact' };

  // 2) Explicit alias mapping (sheet name → existing DB artistName). No creation.
  const aliasTarget = ARTIST_ALIASES[normalizeComparableName(name)];
  if (aliasTarget) {
    const aliased = await prisma.artist.findFirst({
      where: { artistName: { equals: aliasTarget, mode: 'insensitive' } },
      select: { id: true, artistName: true },
    });
    if (aliased) {
      return { ...aliased, via: 'alias', aliasNote: `"${name}" → "${aliased.artistName}"` };
    }
  }

  // 3) Normalized-name fallback (hyphen/punctuation/case-insensitive) against
  //    existing artists only — still never creates a new Artist.
  const normSheet = normalizeComparableName(name);
  const all = await prisma.artist.findMany({ select: { id: true, artistName: true } });
  const hit = all.find((a) => normalizeComparableName(a.artistName) === normSheet);
  if (hit) {
    return { ...hit, via: 'normalized', aliasNote: `"${name}" ≈ "${hit.artistName}"` };
  }

  return null;
}

async function processRow(
  artist: { id: string; artistName: string },
  row: Record<string, unknown>
): Promise<void> {
  stats.rowsRead++;

  // ── Date ──
  const parsed = parseConcertDate(row['Date']);
  if (parsed.malformedYearOnly) {
    stats.malformedDatesIgnored++;
    return;
  }
  if (!parsed.date) {
    stats.otherInvalidDates++;
    anomalies.push(`Unparseable date on ${artist.artistName}: ${JSON.stringify(row['Date'])}`);
    return;
  }
  const date = parsed.date;

  // ── City / State (city is NOT NULL in schema) ──
  const city = cleanText(row['City']);
  if (!city) {
    stats.missingCity++;
    anomalies.push(`Missing city on ${artist.artistName} @ ${toIsoDateOnly(date)} — skipped`);
    return;
  }
  const state = cleanText(row['State']);
  const eventName = cleanText(row['Event Name']);

  // ── Country inference (never invented for virtual/ambiguous) ──
  const countryInfo = inferCountry(city, state);
  if (countryInfo.country === null) {
    stats.countryUnresolved++;
    unresolvedCountryRecords.push(
      `${artist.artistName} | ${toIsoDateOnly(date)} | ${city}, ${state ?? '-'} | reason=${countryInfo.reason} | event="${eventName ?? ''}"`
    );
    return; // held out — country is NOT NULL in schema and must not be invented
  }
  const country = countryInfo.country;
  if (country !== 'India') {
    nonIndiaRecords.push(
      `${artist.artistName} | ${toIsoDateOnly(date)} | ${city}, ${state ?? '-'} | country=${country} (${countryInfo.reason}) | event="${eventName ?? ''}"`
    );
  }

  // ── Venue classification ──
  const venueClass = classifyVenue(row['Venue'], city, knownPlaces);
  if (venueClass.kind === 'blank') stats.blankVenues++;
  else if (venueClass.kind === 'placeholder') {
    if (venueClass.reason === 'city-as-venue' || venueClass.reason === 'bare-place-name') stats.cityAsVenue++;
    else if (venueClass.reason === 'no-venue-text') stats.explicitPlaceholder++;
    else if (venueClass.reason === 'nonspecific-or-online') stats.onlineNonspecific++;
  }

  // Rule 2 & 3: only a genuinely identifiable (real) venue keeps a venueName and
  // becomes a Venue record. Blank / city-as-venue / placeholder / online → NULL.
  const realVenueName = venueClass.kind === 'real' ? venueClass.text : null;
  const storedVenueName = realVenueName;

  // For non-real venues, preserve the original venue text in notes when it adds
  // information (i.e. not blank and not a mere city echo).
  const preserveVenueText =
    venueClass.kind === 'placeholder' &&
    venueClass.reason !== 'city-as-venue' &&
    venueClass.reason !== 'bare-place-name'
      ? venueClass.text
      : null;
  const notes = [eventName, preserveVenueText ? `(listed venue: ${preserveVenueText})` : null]
    .filter(Boolean)
    .join(' ') || null;

  // ── Concert dedup (query-before-insert, read-only) ──
  const dup = await detectDuplicateConcert(
    prisma.concert,
    { artistId: artist.id, date, city, venueName: realVenueName, eventName },
    seenIdentities
  );
  if (dup.isDuplicate) {
    if (dup.existingConcertId) stats.duplicatesInDb++;
    else stats.duplicatesInFile++;
    return;
  }

  // ── Venue resolution (only for real venues), country from inference ──
  if (realVenueName) {
    stats.venuesReal++;
    const resolution = await resolveVenue(
      prisma.venue,
      { name: realVenueName, city, country, state },
      seenVenuePlans
    );
    if (resolution.action === 'match') {
      stats.venuesExistingMatched++;
      venueActions.push({ action: 'match', name: realVenueName, city, detail: `→ existing "${resolution.matchedName}"` });
    } else {
      const key = venueRunKey(realVenueName, city, country);
      if (!proposedVenueKeys.has(key)) {
        proposedVenueKeys.add(key);
        stats.venuesNewProposed++;
        venueActions.push({ action: 'create', name: realVenueName, city, detail: `NEW venue proposed (${country})` });
      }
    }
  }

  // ── Build the Concert plan (all economic fields NULL; ticketsSold=0=unknown) ──
  stats.validConcerts++;
  concertPlans.push({
    artistName: artist.artistName,
    artistId: artist.id,
    concertDate: toIsoDateOnly(date),
    city,
    state,
    venueName: storedVenueName,
    venueKind: venueClass.reason,
    country,
    currency: CURRENCY,
    capacity: null,
    avgTicketPrice: null,
    totalRevenue: null,
    ticketsSold: 0,
    demandScore: null,
    verificationStatus: 'PENDING',
    notes,
    identity: dup.identity,
  });
}

async function commitPlans(): Promise<void> {
  // Persist in one transaction: upsert Venue catalog first, then insert Concerts.
  // Generous timeout: ~300 sequential ops over the Supabase pooler exceed the
  // 5s interactive-transaction default.
  await prisma.$transaction(async (tx) => {
    for (const plan of seenVenuePlans.values()) {
      await tx.venue.upsert({
        where: { name_city_country: { name: plan.name, city: plan.city, country: plan.country } },
        update: {},
        create: {
          name: plan.name,
          city: plan.city,
          state: plan.state,
          country: plan.country,
          source: 'HISTORICAL_EXCEL',
          verified: false,
        },
      });
    }
    for (const c of concertPlans) {
      await tx.concert.create({
        data: {
          artistId: c.artistId,
          artistName: c.artistName,
          concertDate: new Date(`${c.concertDate}T00:00:00.000Z`),
          city: c.city,
          state: c.state,
          country: c.country,
          currency: c.currency,
          venueName: c.venueName,
          // capacity / avgTicketPrice / totalRevenue / demandScore left unset -> NULL
          verificationStatus: 'PENDING',
          source: 'HISTORICAL_EXCEL',
          notes: c.notes,
        } satisfies Prisma.ConcertUncheckedCreateInput,
      });
    }
  }, { timeout: 120_000, maxWait: 20_000 });
}

/** Evenly-spaced sample so the preview spans multiple artists, not just the first. */
function representativeSample<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  const step = items.length / n;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[Math.floor(i * step)]);
  return out;
}

function printReport(sheetNames: string[]): void {
  const line = '─'.repeat(64);
  console.log(`\n${line}`);
  console.log('HISTORICAL CONCERT IMPORT — DRY RUN REPORT');
  console.log(line);
  console.log(`File:            ${FILE}`);
  console.log(`Mode:            ${COMMIT ? 'COMMIT (writes enabled)' : 'DRY-RUN (no DB writes)'}`);
  console.log(`Sheets in file:  ${sheetNames.length}  [${sheetNames.join(', ')}]`);
  console.log(line);
  console.log('ARTISTS');
  console.log(`  Sheets in workbook:            ${sheetNames.length}`);
  console.log(`  Sheets processed:              ${stats.sheetsProcessed}`);
  console.log(`  Artists matched:               ${stats.matchedArtists.length}`);
  stats.matchedArtists.forEach((a) => console.log(`      • ${a}`));
  console.log(`  Artists UNMATCHED (skipped):   ${stats.unmatchedArtists.length}  [${stats.unmatchedArtists.join(', ') || 'none'}]`);
  console.log(`  Alias mappings used:           ${stats.aliasMappings.length}`);
  stats.aliasMappings.forEach((a) => console.log(`      • ${a}`));
  console.log(line);
  console.log('ROWS');
  console.log(`  Rows read (matched sheets):    ${stats.rowsRead}`);
  console.log(`  Year-only rows ignored:        ${stats.malformedDatesIgnored}`);
  console.log(`  Other invalid dates skipped:   ${stats.otherInvalidDates}`);
  console.log(`  Missing-city rows skipped:     ${stats.missingCity}`);
  console.log(`  Country-unresolved (held out): ${stats.countryUnresolved}`);
  console.log(`  Duplicate rows — in file:      ${stats.duplicatesInFile}`);
  console.log(`  Duplicate rows — in DB:        ${stats.duplicatesInDb}`);
  console.log(`  VALID rows (to insert):        ${stats.validConcerts}`);
  console.log(line);
  console.log('VENUES');
  console.log(`  Real identifiable venues:      ${stats.venuesReal} rows`);
  console.log(`  New Venue records proposed:    ${stats.venuesNewProposed} (unique)`);
  console.log(`  Existing Venues matched:       ${stats.venuesExistingMatched}`);
  console.log(`  Blank venues (→ NULL):         ${stats.blankVenues}`);
  console.log(`  City-as-venue (→ NULL):        ${stats.cityAsVenue}`);
  console.log(`  Explicit placeholder (→ NULL): ${stats.explicitPlaceholder}`);
  console.log(`  Online/non-specific (→ NULL):  ${stats.onlineNonspecific}`);
  console.log(line);
  console.log('COUNTRY');
  console.log(`  Non-India records:             ${nonIndiaRecords.length}`);
  nonIndiaRecords.forEach((r) => console.log(`      • ${r}`));
  console.log(`  Country-unresolved (held):     ${unresolvedCountryRecords.length}`);
  unresolvedCountryRecords.forEach((r) => console.log(`      • ${r}`));
  console.log(line);
  console.log('ECONOMIC DATA (every valid Concert)');
  console.log('  capacity=NULL  avgTicketPrice=NULL  ticketTiers=NULL  totalRevenue=NULL');
  console.log('  demandScore=NULL  artistCityPopularity=NULL');
  console.log('  ticketsSold=0  →  UNKNOWN (schema default, NOT real zero sales)');
  console.log(line);
  console.log('FINAL INSERT COUNTS');
  console.log(`  Concerts to insert:            ${stats.validConcerts}`);
  console.log(`  Venues to insert:              ${stats.venuesNewProposed}`);
  console.log(line);

  console.log(`SAMPLE — ${Math.min(SAMPLE_N, concertPlans.length)} representative Concert plans:`);
  representativeSample(concertPlans, SAMPLE_N).forEach((c, i) => {
    console.log(
      `  ${String(i + 1).padStart(2)}. ${c.artistName} | ${c.concertDate} | ${c.city}` +
        `${c.state ? ', ' + c.state : ''} | ${c.country} | venue=${c.venueName ?? 'NULL'} (${c.venueKind})` +
        ` | cap/price/rev/demand=NULL ticketsSold=0[UNKNOWN] | ${c.verificationStatus}` +
        ` | notes="${c.notes ?? ''}"`
    );
  });

  console.log(`\nSAMPLE — ${Math.min(SAMPLE_N, venueActions.length)} Venue plans:`);
  representativeSample(venueActions, SAMPLE_N).forEach((v, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. [${v.action.toUpperCase()}] ${v.name} @ ${v.city} — ${v.detail}`);
  });

  if (anomalies.length) {
    console.log(`\nOTHER DATA-QUALITY FLAGS (${anomalies.length}) — first 10:`);
    anomalies.slice(0, 10).forEach((a) => console.log(`  • ${a}`));
  }

  console.log(`\n${line}`);
  if (COMMIT) {
    console.log('COMMIT MODE: rows were written to the DB.');
  } else {
    console.log('DRY-RUN COMPLETE — ZERO DB WRITES PERFORMED.');
    console.log(`Would insert ${stats.validConcerts} concerts and ${stats.venuesNewProposed} new venues.`);
  }
  console.log(line);
}

async function main(): Promise<void> {
  if (!fs.existsSync(FILE)) {
    console.error(`File not found: ${FILE}`);
    process.exit(1);
  }
  console.log(`[historical-import] Reading ${FILE} ...`);
  // raw:true keeps date cells as Excel serials (parseConcertDate handles them
  // and detects bare-year malformed values); no cellDates to avoid TZ drift.
  const wb = XLSX.readFile(FILE, { raw: true });
  const sheetNames = wb.SheetNames;

  // Pre-pass: build the place-name gazetteer from every sheet's City/State so a
  // venue that is merely a bare city/region name is rejected as non-identifiable.
  for (const sheetName of sheetNames) {
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[sheetName], { defval: null, raw: true });
    for (const row of rows) {
      const nc = normalizeComparableName(row['City']);
      const ns = normalizeComparableName(row['State']);
      if (nc) knownPlaces.add(nc);
      if (ns) knownPlaces.add(ns);
    }
  }
  // Common Indian city aliases (normalized) so variants are also caught.
  ['bombay', 'bangalore', 'calcutta', 'madras', 'gurgaon', 'delhi', 'new delhi'].forEach((p) => knownPlaces.add(p));

  for (const sheetName of sheetNames) {
    const artist = await resolveArtistId(sheetName);
    if (!artist) {
      stats.unmatchedArtists.push(sheetName);
      continue;
    }
    stats.sheetsProcessed++;
    stats.matchedArtists.push(`${artist.artistName} (${artist.via})`);
    if (artist.via !== 'exact' && artist.aliasNote) {
      stats.aliasMappings.push(`${artist.aliasNote} [${artist.via}] → artistId=${artist.id}`);
    }

    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[sheetName], {
      defval: null,
      raw: true,
    });
    for (const row of rows) {
      await processRow(artist, row);
    }
  }

  if (COMMIT) {
    console.log('[historical-import] --commit passed: writing to DB...');
    await commitPlans();
  }

  printReport(sheetNames);
}

main()
  .catch((err) => {
    console.error('[historical-import] FAILED:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

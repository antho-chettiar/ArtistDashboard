/**
 * ingest-concerts-mvp.ts — Sprint 5.1 MVP concert ingestion (Path C: TS scrapers + Prisma)
 *
 * Reuses the EXISTING BookMyShow + District TS scrapers and writes matched concerts
 * straight into the `concerts` table via Prisma. Application-level idempotency by a
 * normalized (artist|venue|city|date) key — NO schema change, NO new dependency.
 *
 * SAFE BY DEFAULT: dry-run (prints, writes nothing). Pass --commit to persist.
 *
 * Usage:
 *   npx tsx scripts/ingest-concerts-mvp.ts                 # dry-run, default cities
 *   npx tsx scripts/ingest-concerts-mvp.ts --cities Mumbai --max-pages 1
 *   npx tsx scripts/ingest-concerts-mvp.ts --commit        # actually write to DB
 */
import { PrismaClient } from '@prisma/client';
import { bookMyShowScraper } from '../src/services/scrapers/bookmyshow/bookMyShowScraper';
import { districtScraper } from '../src/services/scrapers/district/districtScraper';
import type { RawConcertEvent } from '../src/services/scrapers/types';

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const citiesArg = args.indexOf('--cities');
const CITIES = citiesArg >= 0 && args[citiesArg + 1] ? args[citiesArg + 1].split(',') : ['Mumbai'];
const mpArg = args.indexOf('--max-pages');
const MAX_PAGES = mpArg >= 0 && args[mpArg + 1] ? parseInt(args[mpArg + 1], 10) : 1;

const norm = (s?: string | null): string =>
  (s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();

const mapSource = (p: string): string => (p === 'ZOMATO' ? 'DISTRICT' : p);

const avgPrice = (r?: { min?: number; max?: number }): number | null => {
  if (!r) return null;
  const vals = [r.min, r.max].filter((v): v is number => typeof v === 'number' && v > 0);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
};

async function main() {
  console.log(`\n=== MVP Concert Ingestion (${COMMIT ? 'COMMIT' : 'DRY-RUN'}) ===`);
  console.log(`cities=${CITIES.join(',')} maxPages=${MAX_PAGES}\n`);

  const dbArtists = await prisma.artist.findMany({ select: { id: true, artistName: true } });
  const artistIndex = dbArtists.map((a) => ({ ...a, key: norm(a.artistName) }));
  const artistNames = dbArtists.map((a) => a.artistName);

  const matchArtist = (raw?: string): { id: string; artistName: string } | null => {
    const n = norm(raw);
    if (!n) return null;
    let hit = artistIndex.find((a) => a.key === n);
    if (!hit) hit = artistIndex.find((a) => a.key && (n.includes(a.key) || a.key.includes(n)));
    return hit ? { id: hit.id, artistName: hit.artistName } : null;
  };

  const events: RawConcertEvent[] = [];
  for (const [name, scraper] of [['BookMyShow', bookMyShowScraper], ['District', districtScraper]] as const) {
    try {
      const cityFilter = (CITIES.length === 1 && CITIES[0].toLowerCase() === 'all') ? undefined : CITIES;
      const res = await scraper.scrape({ artists: artistNames, cities: cityFilter, country: 'India', maxPages: MAX_PAGES });
      console.log(`[${name}] ${res.events.length} raw events, ${res.errors.length} error(s)`);
      if (res.errors.length) console.log(`  errors: ${res.errors.slice(0, 3).join(' | ')}`);
      events.push(...res.events);
    } catch (e: any) {
      console.log(`[${name}] SCRAPE FAILED: ${e?.message || e}`);
    }
  }

  const seen = new Set<string>();
  let matched = 0, unmatched = 0, dupes = 0, wrote = 0;
  const unmatchedNames = new Set<string>();

  console.log(`\n--- Extracted records ---`);
  for (const ev of events) {
    const artist = matchArtist(ev.artistName);
    const dateStr = ev.eventDate ? new Date(ev.eventDate).toISOString().slice(0, 10) : '';
    const key = `${norm(ev.artistName)}|${norm(ev.venueName)}|${norm(ev.city)}|${dateStr}`;
    const dup = seen.has(key);
    seen.add(key);
    if (dup) dupes++;
    if (!artist) { unmatched++; unmatchedNames.add(ev.artistName || '(blank)'); }
    else matched++;

    console.log(
      `  [${mapSource(ev.sourcePlatform)}] artist=${JSON.stringify(ev.artistName)} → match=${artist?.artistName ?? 'NONE'} dup=${dup}\n` +
      `     event=${JSON.stringify(ev.eventName)?.slice(0, 60)} date=${dateStr} city=${JSON.stringify(ev.city)} venue=${JSON.stringify(ev.venueName)}\n` +
      `     price=${ev.ticketPriceRange?.min ?? '?'}-${ev.ticketPriceRange?.max ?? '?'} ${ev.ticketPriceRange?.currency ?? ''} avg=${avgPrice(ev.ticketPriceRange) ?? '?'} url=${(ev.sourceUrl || '').slice(0, 55)}`
    );

    if (COMMIT && artist && !dup && dateStr) {
      const existing = await prisma.concert.findFirst({
        where: { artistId: artist.id, concertDate: new Date(dateStr), city: ev.city || undefined, venueName: ev.venueName || undefined },
        select: { id: true },
      });
      if (!existing) {
        const ap = avgPrice(ev.ticketPriceRange);
        await prisma.concert.create({
          data: {
            artistId: artist.id,
            artistName: artist.artistName,
            concertDate: new Date(dateStr),
            city: ev.city || 'Unknown',
            country: ev.country || 'India',
            venueName: ev.venueName || null,
            avgTicketPrice: ap ?? undefined,
            ticketPriceMin: ev.ticketPriceRange?.min ?? undefined,
            ticketPriceMax: ev.ticketPriceRange?.max ?? undefined,
            currency: ev.ticketPriceRange?.currency || 'INR',
            source: mapSource(ev.sourcePlatform),
            sourceUrl: ev.sourceUrl || null,
            verificationStatus: 'PENDING',
            notes: `MVP ingest ${mapSource(ev.sourcePlatform)}. Event: ${ev.eventName ?? ''}`,
          },
        });
        wrote++;
      }
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(`  raw events:        ${events.length}`);
  console.log(`  matched artist:    ${matched}`);
  console.log(`  unmatched:         ${unmatched}  ${unmatchedNames.size ? '[' + [...unmatchedNames].slice(0, 8).join(', ') + ']' : ''}`);
  console.log(`  duplicates:        ${dupes}`);
  console.log(`  concerts written:  ${COMMIT ? wrote : '(dry-run — 0)'}`);

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });

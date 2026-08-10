/**
 * viberate-slugs.ts
 *
 * Maps artistName (as stored in the DB) to Viberate URL slugs.
 * Run this AFTER importing artists (scripts/import-artist-baseline.ts) so every
 * imported artist receives its viberateSlug before collector/sync/scorer run.
 * Run this whenever you add new artists or correct a slug.
 *
 * Usage:
 *   npx tsx prisma/viberate-slugs.ts
 */

import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const SLUGS: Record<string, string> = {
  // Confirmed slugs from Viberate
  'Shreya Ghoshal':    'shreya-ghoshal',
  'Arijit Singh':      'arijit-singh',
  'Vishal Mishra':     'vishal-mishra',
  'Sonu Nigam':        'sonu-nigam',
  'Ayushmann Khurrana': 'ayushmann-khurrana',
  'Aparshakti Khurana': 'aparshakti-khurana',
  'Armaan Malik':      'armaan-malik',
  'Amaal Mallik':      'amaal-mallik',
  'Sachet Parampara':  'sachet-parampara',
  'Neeraj Shridhar':   'neeraj-shridhar',
  'Hansraj Raghuwanshi': 'hansraj-raghuwanshi',
};

// Normalize a name for matching: lowercase, punctuation → spaces, collapse whitespace.
// Lets DB names that differ only by case/punctuation (e.g. "SONU NIGAM",
// "Sachet-Parampara") still match their slug entry.
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function main() {
  console.log('Updating Viberate slugs...\n');

  // Build a normalized lookup from the slug map.
  const normalizedSlugs = new Map<string, { canonicalName: string; slug: string }>();
  for (const [name, slug] of Object.entries(SLUGS)) {
    normalizedSlugs.set(normalizeName(name), { canonicalName: name, slug });
  }

  const artists = await prisma.artist.findMany({ select: { id: true, artistName: true } });

  let updated = 0;
  let notFound = 0;
  const matchedKeys = new Set<string>();

  for (const artist of artists) {
    const key = normalizeName(artist.artistName);
    const entry = normalizedSlugs.get(key);
    if (!entry) continue;

    await prisma.artist.update({
      where: { id: artist.id },
      data: { viberateSlug: entry.slug },
    });
    matchedKeys.add(key);
    console.log(`  ✓ ${artist.artistName} → ${entry.slug}`);
    updated++;
  }

  // Report slug-map entries that matched no artist in the DB.
  for (const [key, entry] of normalizedSlugs) {
    if (!matchedKeys.has(key)) {
      console.log(`  ✗ ${entry.canonicalName} → NOT FOUND in DB (artist may not exist yet)`);
      notFound++;
    }
  }

  console.log(`\nDone. Updated: ${updated}, Not found in DB: ${notFound}`);

  if (notFound > 0) {
    console.log('\nFor artists not found: add them to the artists table first,');
    console.log('then re-run this script.');
  }

  await prisma.$disconnect();
}

main().catch(console.error);

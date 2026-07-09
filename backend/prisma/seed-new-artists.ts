/**
 * seed-new-artists.ts
 *
 * Creates the 6 artists that don't exist in the DB yet,
 * then sets their Viberate slugs so the collector picks them up.
 *
 * Safe to re-run — uses upsert so it won't create duplicates.
 *
 * Usage:
 *   npx ts-node prisma/seed-new-artists.ts
 */

import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const NEW_ARTISTS = [
  {
    artistName: 'Ayushmann Khurrana',
    displayName: 'Ayushmann Khurrana',
    nationality: 'Indian',
    genre: 'Bollywood',
    viberateSlug: 'ayushmann-khurrana',
  },
  {
    artistName: 'Aparshakti Khurana',
    displayName: 'Aparshakti Khurana',
    nationality: 'Indian',
    genre: 'Bollywood',
    viberateSlug: 'aparshakti-khurana',
  },
  {
    artistName: 'Armaan Malik',
    displayName: 'Armaan Malik',
    nationality: 'Indian',
    genre: 'Bollywood',
    viberateSlug: 'armaan-malik',
  },
  {
    artistName: 'Amaal Mallik',
    displayName: 'Amaal Mallik',
    nationality: 'Indian',
    genre: 'Bollywood',
    viberateSlug: 'amaal-mallik',
  },
  {
    artistName: 'Sachet Parampara',
    displayName: 'Sachet-Parampara',
    nationality: 'Indian',
    genre: 'Bollywood',
    viberateSlug: 'sachet-parampara',
  },
  {
    artistName: 'Neeraj Shridhar',
    displayName: 'Neeraj Shridhar',
    nationality: 'Indian',
    genre: 'Bollywood',
    viberateSlug: 'neeraj-shridhar',
  },
];

async function main() {
  console.log('Seeding new artists...\n');

  let created = 0;
  let existing = 0;

  for (const artist of NEW_ARTISTS) {
    const result = await prisma.artist.upsert({
      where: { artistName: artist.artistName },
      update: {
        // Only update the slug if artist already exists
        viberateSlug: artist.viberateSlug,
      },
      create: {
        artistName: artist.artistName,
        displayName: artist.displayName,
        nationality: artist.nationality,
        genre: artist.genre,
        viberateSlug: artist.viberateSlug,
        active: true,
      },
    });

    // Check if it was a create or update by comparing timestamps
    const wasCreated =
      Math.abs(result.created_at.getTime() - result.updated_at.getTime()) < 1000;

    if (wasCreated) {
      console.log(`  ✓ Created: ${artist.artistName} → ${artist.viberateSlug}`);
      created++;
    } else {
      console.log(`  ~ Already exists: ${artist.artistName} → slug updated to ${artist.viberateSlug}`);
      existing++;
    }
  }

  console.log(`\nDone. Created: ${created}, Already existed: ${existing}`);
  console.log('\nNext step: run the collector to backfill their data.');
  console.log('  npx ts-node src/services/scrapers/viberate/collector.ts');

  await prisma.$disconnect();
}

main().catch(console.error);

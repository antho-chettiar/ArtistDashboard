/**
 * viberate-slugs.ts
 *
 * Maps artistName (as stored in the DB) to Viberate URL slugs.
 * Run this whenever you add new artists or correct a slug.
 *
 * Usage:
 *   npx ts-node prisma/viberate-slugs.ts
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
};

async function main() {
  console.log('Updating Viberate slugs...\n');

  let updated = 0;
  let notFound = 0;

  for (const [name, slug] of Object.entries(SLUGS)) {
    const result = await prisma.artist.updateMany({
      where: { artistName: name },
      data: { viberateSlug: slug },
    });

    if (result.count > 0) {
      console.log(`  ✓ ${name} → ${slug}`);
      updated++;
    } else {
      console.log(`  ✗ ${name} → NOT FOUND in DB (artist may not exist yet)`);
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

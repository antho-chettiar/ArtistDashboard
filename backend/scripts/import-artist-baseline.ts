/**
 * import-artist-baseline.ts
 * One-off importer for the baseline artist stats spreadsheet (artist_data.xlsx).
 * Upserts each artist by artistName with current-total follower/listener columns.
 *
 * Usage: npx tsx scripts/import-artist-baseline.ts [path/to/artist_data.xlsx]
 * Defaults to the repo-relative data/artists/artist_data.xlsx when no path is given.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as XLSX from 'xlsx';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const FILE = process.argv[2] || path.resolve(__dirname, '..', '..', 'data', 'artists', 'artist_data.xlsx');

function toBigInt(v: unknown): bigint | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return BigInt(Math.round(n));
}
function str(v: unknown): string | null {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  return String(v).trim();
}

async function main() {
  console.log('[import-artists] Baseline artist import — single source of truth for artists');
  console.log(`[import-artists] Reading: ${FILE}`);

  if (!fs.existsSync(FILE)) {
    console.error(`[import-artists] File not found: ${FILE}`);
    console.error('[import-artists] Place artist_data.xlsx in data/artists/ or pass a path argument.');
    process.exit(1);
  }

  const wb = XLSX.readFile(FILE);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);

  let created = 0;
  let updated = 0;
  let skipped = 0;
  for (const r of rows) {
    const name = str(r['Artist Name']);
    if (!name) {
      skipped++;
      continue;
    }
    const data = {
      nationality: str(r['Country']),
      genre: str(r['Genre']),
      spotifyMonthlyListeners: toBigInt(r['Spotify Monthly Listeners Total']),
      spotifyFollowers: toBigInt(r['Spotify Followers Total']),
      youtubeSubscribers: toBigInt(r['YouTube Subscribers Total']),
      instagramFollowers: toBigInt(r['Instagram Followers Total']),
      facebookFollowers: toBigInt(r['Facebook Followers Total']),
      active: true,
    };
    // upsert keys on the unique artistName, so re-runs update in place (never duplicates)
    const result = await prisma.artist.upsert({
      where: { artistName: name },
      update: data,
      create: { artistName: name, ...data },
    });
    const wasCreated =
      Math.abs(result.created_at.getTime() - result.updated_at.getTime()) < 1000;
    if (wasCreated) created++;
    else updated++;
    console.log(
      `  ${wasCreated ? '+ created' : '~ updated'} ${name.padEnd(22)} spotifyML=${data.spotifyMonthlyListeners} yt=${data.youtubeSubscribers} ig=${data.instagramFollowers} fb=${data.facebookFollowers}`
    );
  }
  console.log(
    `\n[import-artists] Done. Created: ${created}, Updated: ${updated}, Skipped(no name): ${skipped}, Total rows: ${rows.length}`
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

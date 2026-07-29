/**
 * import-artist-baseline.ts
 * One-off importer for the baseline artist stats spreadsheet (artist_data.xlsx).
 * Upserts each artist by artistName with current-total follower/listener columns.
 *
 * Usage: npx tsx scripts/import-artist-baseline.ts "C:\\path\\to\\artist_data.xlsx"
 */
import * as XLSX from 'xlsx';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const FILE = process.argv[2] || 'C:\\Users\\antho\\Downloads\\artist_data.xlsx';

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
  const wb = XLSX.readFile(FILE);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);

  let count = 0;
  for (const r of rows) {
    const name = str(r['Artist Name']);
    if (!name) continue;
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
    await prisma.artist.upsert({
      where: { artistName: name },
      update: data,
      create: { artistName: name, ...data },
    });
    count++;
    console.log(
      `  ✓ ${name.padEnd(22)} spotifyML=${data.spotifyMonthlyListeners} yt=${data.youtubeSubscribers} ig=${data.instagramFollowers} fb=${data.facebookFollowers}`
    );
  }
  console.log(`\nImported/updated ${count} artists.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

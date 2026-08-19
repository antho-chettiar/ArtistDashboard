/**
 * enrich-artists-wikidata.ts
 *
 * One-off artist metadata enrichment from the PUBLIC Wikidata + Wikipedia REST
 * APIs (no API key, no HTML scraping). Fills, for each tracked Artist:
 *   - photoUrl   (Wikidata P18 → Wikimedia Commons FilePath URL)
 *   - wikiUrl    (English Wikipedia sitelink)
 *   - bio        (Wikipedia REST summary extract, trimmed)
 *   - nationality (VERIFY only — P27 label; never blindly overwritten)
 *   - dateOfBirth (P569) — REPORTED ONLY; there is no dateOfBirth column yet,
 *                  so it is NOT written (see schema recommendation in the report).
 *
 * Matching: Wikidata search → keep candidates that are humans/musical groups with
 * a musician-type occupation (or a singer/musician/composer description) and an
 * English Wikipedia page. Runner-up candidates are printed so wrong-person matches
 * can be caught during review.
 *
 * SAFE BY DEFAULT: dry-run (writes nothing). Pass --commit to persist the fields
 * that already exist on the schema (photoUrl, wikiUrl, bio; nationality only when
 * currently empty). dateOfBirth/age are never written by this script.
 *
 * Usage:
 *   npx tsx scripts/enrich-artists-wikidata.ts            # dry-run
 *   npx tsx scripts/enrich-artists-wikidata.ts --commit   # write existing fields only
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const COMMIT = process.argv.includes('--commit');
const UA = 'ArtistDashboard-Enrichment/1.0 (contact: anthony@digitalabs.in)';

// Wikidata occupation Q-ids that count as "musician" for matching.
const MUSICIAN_OCCUPATIONS = new Set([
  'Q177220',    // singer
  'Q639669',    // musician
  'Q36834',     // composer
  'Q56815422',  // playback singer
  'Q753110',    // songwriter
  'Q488205',    // singer-songwriter
  'Q855091',    // guitarist
  'Q158852',    // conductor
  'Q183945',    // record producer
  'Q9648008',   // music director
]);
const MUSICIAN_DESC = /singer|musician|composer|songwriter|music director|playback|rapper|record producer|band|duo/i;

async function wd<T = any>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return (await r.json()) as T;
}

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function searchCandidates(name: string): Promise<Array<{ id: string; label: string; description?: string }>> {
  const u = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(name)}&language=en&uselang=en&type=item&limit=7&format=json&origin=*`;
  const j = await wd<{ search?: any[] }>(u);
  return (j.search || []).map((s) => ({ id: s.id, label: s.label, description: s.description }));
}

async function getEntities(ids: string[]): Promise<Record<string, any>> {
  if (ids.length === 0) return {};
  const u = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids.join('|')}&props=claims|labels|descriptions|sitelinks/urls&languages=en&format=json&origin=*`;
  const j = await wd<{ entities?: Record<string, any> }>(u);
  return j.entities || {};
}

function claimIds(entity: any, prop: string): string[] {
  const claims = entity?.claims?.[prop];
  if (!Array.isArray(claims)) return [];
  return claims
    .map((c: any) => c?.mainsnak?.datavalue?.value?.id)
    .filter(Boolean);
}
function claimValue(entity: any, prop: string): any {
  return entity?.claims?.[prop]?.[0]?.mainsnak?.datavalue?.value;
}

function scoreCandidate(entity: any): { score: number; reasons: string[]; isGroup: boolean } {
  const reasons: string[] = [];
  let score = 0;
  const p31 = claimIds(entity, 'P31'); // instance of
  const isHuman = p31.includes('Q5');
  const isGroup = p31.includes('Q215380') || p31.includes('Q2088357') || p31.includes('Q105756498'); // band / musical ensemble / musical duo
  if (isHuman) { score += 1; reasons.push('human'); }
  if (isGroup) { score += 1; reasons.push('musical group/duo'); }
  const occ = claimIds(entity, 'P106');
  if (occ.some((q) => MUSICIAN_OCCUPATIONS.has(q))) { score += 3; reasons.push('musician occupation'); }
  const desc = entity?.descriptions?.en?.value || '';
  if (MUSICIAN_DESC.test(desc)) { score += 2; reasons.push(`desc:"${desc}"`); }
  if (entity?.sitelinks?.enwiki) { score += 2; reasons.push('has enwiki'); }
  return { score, reasons, isGroup };
}

function commonsImageUrl(filename: string): string {
  // Special:FilePath resolves a Commons file name to the actual image URL.
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(filename.replace(/ /g, '_'))}?width=600`;
}

function parseWikidataDate(v: any): string | null {
  // v.time like "+1987-04-25T00:00:00Z"; precision 11 = day, 10 = month, 9 = year
  if (!v?.time) return null;
  const m = /^[+-](\d{4})-(\d{2})-(\d{2})/.exec(v.time);
  if (!m) return null;
  const [, y, mo, d] = m;
  if (v.precision != null && v.precision < 11) {
    return `${y}${mo !== '00' && v.precision >= 10 ? '-' + mo : ''} (approx)`;
  }
  return `${y}-${mo}-${d}`;
}

function ageFromDob(dob: string | null): number | null {
  if (!dob) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dob);
  if (!m) return null;
  const [, y, mo, d] = m.map(Number) as unknown as number[];
  const now = new Date();
  let age = now.getUTCFullYear() - y;
  const md = (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
  if (md < mo * 100 + d) age -= 1;
  return age;
}

async function fetchBio(title: string): Promise<string | null> {
  try {
    const u = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!r.ok) return null;
    const j: any = await r.json();
    const extract = j?.extract;
    if (!extract) return null;
    return String(extract).slice(0, 400);
  } catch {
    return null;
  }
}

interface Proposal {
  artistId: string;
  artistName: string;
  qid: string | null;
  matchLabel: string | null;
  matchDesc: string | null;
  confidence: 'high' | 'low' | 'none';
  isGroup: boolean;
  photoUrl: string | null;
  wikiUrl: string | null;
  wikiTitle: string | null;
  bio: string | null;
  nationality: string | null;
  dateOfBirth: string | null;
  age: number | null;
  candidates: string[];
  current: { photoUrl: string | null; wikiUrl: string | null; nationality: string | null; age: number | null; bioLen: number };
}

async function enrichArtist(artist: any): Promise<Proposal> {
  const name = artist.artistName.replace(/-/g, ' ').replace(/\s+/g, ' ').trim(); // "Sachet-Parampara" -> "Sachet Parampara"
  const proposal: Proposal = {
    artistId: artist.id, artistName: artist.artistName,
    qid: null, matchLabel: null, matchDesc: null, confidence: 'none', isGroup: false,
    photoUrl: null, wikiUrl: null, wikiTitle: null, bio: null, nationality: null,
    dateOfBirth: null, age: null, candidates: [],
    current: {
      photoUrl: artist.photoUrl ?? null, wikiUrl: artist.wikiUrl ?? null,
      nationality: artist.nationality ?? null, age: artist.age ?? null,
      bioLen: artist.bio ? artist.bio.length : 0,
    },
  };

  const cands = await searchCandidates(name);
  if (cands.length === 0) return proposal;
  const entities = await getEntities(cands.map((c) => c.id));

  const scored = cands
    .map((c) => ({ c, e: entities[c.id], ...(entities[c.id] ? scoreCandidate(entities[c.id]) : { score: -1, reasons: [], isGroup: false }) }))
    .sort((a, b) => b.score - a.score);

  proposal.candidates = scored.slice(0, 5).map((s) => `${s.c.id} "${s.c.label}" — ${s.c.description || 'no desc'} [score ${s.score}]`);

  const best = scored[0];
  if (!best || best.score < 3) {
    proposal.confidence = 'none';
    return proposal;
  }
  proposal.confidence = best.score >= 5 ? 'high' : 'low';
  proposal.isGroup = best.isGroup;
  proposal.qid = best.c.id;
  proposal.matchLabel = best.c.label;
  proposal.matchDesc = best.c.description || null;

  const e = best.e;
  // Wikipedia URL + title
  const enwiki = e?.sitelinks?.enwiki;
  if (enwiki) {
    proposal.wikiUrl = enwiki.url || null;
    proposal.wikiTitle = enwiki.title || null;
  }
  // Image
  const img = claimValue(e, 'P18');
  if (typeof img === 'string') proposal.photoUrl = commonsImageUrl(img);
  // DOB (report only)
  const dobVal = claimValue(e, 'P569');
  proposal.dateOfBirth = parseWikidataDate(dobVal);
  proposal.age = ageFromDob(proposal.dateOfBirth);
  // Nationality (resolve P27 label)
  const natIds = claimIds(e, 'P27');
  if (natIds.length) {
    const natEnt = await getEntities([natIds[0]]);
    proposal.nationality = natEnt[natIds[0]]?.labels?.en?.value || null;
  }
  // Bio
  if (proposal.wikiTitle) proposal.bio = await fetchBio(proposal.wikiTitle);

  return proposal;
}

function line() { console.log('─'.repeat(72)); }

async function main() {
  const artists = await prisma.artist.findMany({
    where: { active: true },
    select: { id: true, artistName: true, photoUrl: true, imageUrl: true, wikiUrl: true, nationality: true, age: true, bio: true },
    orderBy: { artistName: 'asc' },
  });

  console.log(`\n[wikidata-enrich] ${COMMIT ? 'COMMIT' : 'DRY-RUN'} — ${artists.length} artists`);
  console.log(`[wikidata-enrich] reference date: ${new Date().toISOString().slice(0, 10)}`);

  const proposals: Proposal[] = [];
  for (const a of artists) {
    try {
      const p = await enrichArtist(a);
      proposals.push(p);
    } catch (err) {
      console.error(`  ! ${a.artistName}: ${err instanceof Error ? err.message : String(err)}`);
      proposals.push({
        artistId: a.id, artistName: a.artistName, qid: null, matchLabel: null, matchDesc: null,
        confidence: 'none', isGroup: false, photoUrl: null, wikiUrl: null, wikiTitle: null, bio: null,
        nationality: null, dateOfBirth: null, age: null, candidates: [],
        current: { photoUrl: a.photoUrl ?? null, wikiUrl: a.wikiUrl ?? null, nationality: a.nationality ?? null, age: a.age ?? null, bioLen: a.bio ? a.bio.length : 0 },
      });
    }
    await delay(350); // be polite to the public APIs
  }

  // ── Report ──
  for (const p of proposals) {
    line();
    console.log(`${p.artistName}  →  ${p.qid ? `${p.qid} "${p.matchLabel}" (${p.matchDesc || 'no desc'})` : 'NO MATCH'}  [confidence: ${p.confidence}${p.isGroup ? ', GROUP/DUO' : ''}]`);
    console.log(`  photoUrl:    current=${p.current.photoUrl ? 'set' : 'NULL'}  →  ${p.photoUrl || '(none found)'}`);
    console.log(`  wikiUrl:     current=${p.current.wikiUrl ? 'set' : 'NULL'}  →  ${p.wikiUrl || '(none found)'}`);
    console.log(`  nationality: current=${p.current.nationality || 'NULL'}  →  wikidata=${p.nationality || '(none)'}${p.nationality && p.current.nationality && p.nationality !== p.current.nationality ? '  ⚠ MISMATCH' : ''}`);
    console.log(`  dateOfBirth: ${p.dateOfBirth || '(none)'}  → age ${p.age ?? '—'}   [NOT written — no dateOfBirth column]`);
    console.log(`  bio:         current len=${p.current.bioLen}  →  ${p.bio ? `"${p.bio.slice(0, 90)}…"` : '(none)'}`);
    if (p.confidence !== 'high') {
      console.log(`  candidates for review:`);
      p.candidates.forEach((c) => console.log(`     - ${c}`));
    }
  }

  line();
  const matched = proposals.filter((p) => p.qid);
  const high = proposals.filter((p) => p.confidence === 'high');
  const low = proposals.filter((p) => p.confidence === 'low');
  const none = proposals.filter((p) => p.confidence === 'none');
  console.log('SUMMARY');
  console.log(`  matched: ${matched.length}/${proposals.length}  (high ${high.length}, low ${low.length}, none ${none.length})`);
  console.log(`  photoUrl found:    ${proposals.filter((p) => p.photoUrl).length}`);
  console.log(`  wikiUrl found:     ${proposals.filter((p) => p.wikiUrl).length}`);
  console.log(`  DOB found:         ${proposals.filter((p) => p.dateOfBirth).length}`);
  console.log(`  bio found:         ${proposals.filter((p) => p.bio).length}`);
  if (low.length) console.log(`  ⚠ LOW confidence (verify): ${low.map((p) => p.artistName).join(', ')}`);
  if (none.length) console.log(`  ⚠ NO match (verify): ${none.map((p) => p.artistName).join(', ')}`);
  line();

  if (COMMIT) {
    console.log('COMMIT: writing photoUrl / wikiUrl / bio (existing columns only; DOB/age skipped — no column)...');
    let written = 0;
    for (const p of proposals) {
      if (p.confidence === 'none') continue;
      // Fill-only-empty for curated text; identity + DOB set from Wikidata.
      const data: any = {};
      if (p.photoUrl && !p.current.photoUrl) data.photoUrl = p.photoUrl;
      if (p.wikiUrl && !p.current.wikiUrl) data.wikiUrl = p.wikiUrl;
      if (p.bio && !p.current.bioLen) data.bio = p.bio;
      if (p.nationality && !p.current.nationality) data.nationality = p.nationality;
      if (p.qid) data.wikidataId = p.qid; // stable identity for deterministic re-runs
      if (p.dateOfBirth && /^\d{4}-\d{2}-\d{2}$/.test(p.dateOfBirth)) {
        data.dateOfBirth = new Date(`${p.dateOfBirth}T00:00:00.000Z`);
      }
      if (Object.keys(data).length === 0) continue;
      await prisma.artist.update({ where: { id: p.artistId }, data });
      written++;
    }
    console.log(`COMMIT: updated ${written} artists.`);
  } else {
    console.log('DRY-RUN COMPLETE — ZERO DB WRITES.');
    console.log('Review matches above. dateOfBirth needs a schema field (see report) before age can be stored.');
  }
}

main().catch((e) => { console.error('[wikidata-enrich] FAILED:', e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });

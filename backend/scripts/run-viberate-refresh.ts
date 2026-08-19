/**
 * run-viberate-refresh.ts
 *
 * Standalone, run-to-completion Viberate refresh for a DEDICATED Render Cron Job
 * (NOT the public API process). Reuses the existing collector → sync → scorer
 * unchanged; adds only orchestration, session provisioning, structured logging,
 * scoping flags, and a same-day snapshot guard.
 *
 * Flow:
 *   provision session → session health → chromium launch test
 *   → collector → sync → scorer (skipping artists already scored today)
 *   → exit 0 on success, non-zero on failure.
 *
 * Flags (for controlled tests):
 *   --slug <artistSlug>   collect/sync/score only this Viberate slug
 *   --limit <N>           cap to N artists
 *
 * Session provisioning (secure, ephemeral-runtime friendly):
 *   - Preferred: a session file already present at VIBERATE_SESSION_PATH
 *     (e.g. a Render Secret File mounted at /etc/secrets/viberate-session.json).
 *   - Otherwise: VIBERATE_SESSION_B64 (base64 of the session JSON) is decoded to
 *     a private temp file at runtime. Session contents are NEVER logged.
 *
 * Usage:
 *   npx tsx scripts/run-viberate-refresh.ts --slug arijit-singh
 *   npx tsx scripts/run-viberate-refresh.ts --limit 1
 *   npx tsx scripts/run-viberate-refresh.ts            # full cohort
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import { PrismaClient } from '@prisma/client';
import { provisionSessionFromEnv } from '../src/services/scrapers/viberate/session';
import { checkSessionHealth } from '../src/services/scrapers/viberate/sessionHealth';
import { runCollection } from '../src/services/scrapers/viberate/collector';
import { runSync } from '../src/services/scrapers/viberate/sync';
import { runScorer } from '../src/services/scrapers/viberate/scorer';

const log = (msg: string) => console.log(`[VIBERATE] ${msg}`);
const fail = (msg: string) => console.error(`[VIBERATE] run failed: ${msg}`);

function parseArgs() {
  const a = process.argv.slice(2);
  const slugIdx = a.indexOf('--slug');
  const limitIdx = a.indexOf('--limit');
  const slug = slugIdx >= 0 && a[slugIdx + 1] ? a[slugIdx + 1] : undefined;
  const limitRaw = limitIdx >= 0 && a[limitIdx + 1] ? parseInt(a[limitIdx + 1], 10) : undefined;
  const limit = limitRaw && limitRaw > 0 ? limitRaw : undefined;
  return { slug, limit };
}

async function computeSkipArtistIds(prisma: PrismaClient): Promise<string[]> {
  // Same-day guard: any artist that already has a snapshot dated today (UTC)
  // is skipped by the scorer, so repeated runs never create duplicate snapshots.
  const now = new Date();
  const startOfDayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const scored = await prisma.artistPopularityV2Snapshot.findMany({
    where: { computedAt: { gte: startOfDayUtc } },
    select: { artistId: true },
    distinct: ['artistId'],
  });
  return scored.map((s) => s.artistId);
}

async function main() {
  const { slug, limit } = parseArgs();
  const scope = slug ? `slug=${slug}` : limit ? `limit=${limit}` : 'full cohort';
  log(`run started (${scope})`);

  // 1. Provision session (never logs contents)
  log('session provisioning...');
  const provision = provisionSessionFromEnv();
  if (provision.source === 'none') {
    fail(`no session available — set VIBERATE_SESSION_B64 or mount a session file at VIBERATE_SESSION_PATH (resolved: ${provision.sessionPath})`);
    process.exit(1);
  }
  log(`session source: ${provision.source} (path: ${provision.sessionPath})`);

  // 2. Session health
  log('session check started');
  const health = await checkSessionHealth();
  if (!health.alive) {
    fail(`session unhealthy — ${health.reason}`);
    process.exit(1);
  }
  log('session healthy');

  // 3. Chromium launch test
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    log('chromium launched');
  } catch (err) {
    fail(`chromium launch failed — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // 4. Collection → sync → scorer
  try {
    log('collection started');
    await runCollection({ slug, limit });
    log('metrics persisted');

    log('sync started');
    await runSync({ slug, limit });
    log('sync completed');

    const guardPrisma = new PrismaClient();
    let skipArtistIds: string[] = [];
    try {
      skipArtistIds = await computeSkipArtistIds(guardPrisma);
    } finally {
      await guardPrisma.$disconnect();
    }
    if (skipArtistIds.length > 0) {
      log(`same-day guard: ${skipArtistIds.length} artist(s) already scored today — skipping those`);
    }

    log('scoring started');
    await runScorer({ slug, limit, skipArtistIds });
    log('scoring completed');

    log('run completed');
    process.exit(0);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

/**
 * scheduler.ts
 *
 * Daily cron scheduler for Viberate data collection.
 * Checks session health before each run — if session is dead,
 * skips collection and sends an alert instead of failing silently.
 *
 * Runs at 6:00 AM IST every day (00:30 UTC).
 *
 * Usage (from server.ts):
 *   import { startViberateScheduler } from './services/scrapers/viberate/scheduler';
 *   startViberateScheduler();
 *
 * Usage (standalone):
 *   npx ts-node backend/src/services/scrapers/viberate/scheduler.ts
 */

import cron from 'node-cron';
import { runCollection } from './collector';
import { runSync } from './sync';
import { runScorer } from './scorer';
import { checkSessionHealth, sendSessionAlert } from './sessionHealth';

// 6:00 AM IST = 00:30 UTC
const CRON_SCHEDULE = '30 0 * * *';

let isRunning = false;

export function startViberateScheduler(): void {
  console.log('[viberate-scheduler] Starting — will run daily at 6:00 AM IST');

  cron.schedule(CRON_SCHEDULE, async () => {
    if (isRunning) {
      console.warn('[viberate-scheduler] Previous run still in progress — skipping');
      return;
    }

    isRunning = true;
    console.log(`[viberate-scheduler] Triggered at ${new Date().toISOString()}`);

    try {
      // Step 1: Check session health before doing anything
      console.log('[viberate-scheduler] Checking session health...');
      const health = await checkSessionHealth();

      if (!health.alive) {
        console.error(`[viberate-scheduler] Session check failed: ${health.reason}`);
        await sendSessionAlert(health);
        console.error('[viberate-scheduler] Collection skipped for today.');
        return;
      }

      console.log('[viberate-scheduler] Session healthy — starting collection');

      // Step 2: Run collection
      await runCollection();

      // Step 3: Sync fresh Viberate data into the legacy Artist columns
      // and PlatformMetric table that the rest of the dashboard reads from
      console.log('[viberate-scheduler] Collection done — running sync');
      await runSync();

      // Step 4: Recompute scores from the fresh data
      console.log('[viberate-scheduler] Sync done — running scorer');
      await runScorer();

    } catch (err) {
      console.error('[viberate-scheduler] Unexpected error:', err);
    } finally {
      isRunning = false;
    }
  }, {
    timezone: 'UTC',
  });
}

// Allow running standalone
if (require.main === module) {
  startViberateScheduler();
  console.log('[viberate-scheduler] Running. Press Ctrl+C to stop.');
}

/**
 * sessionHealth.ts
 *
 * Checks whether the saved Viberate session is still valid
 * before the collector runs. If the session is dead, it logs
 * clearly and optionally sends an email alert so you know
 * to re-run login.ts.
 *
 * Used by scheduler.ts automatically before each daily run.
 * Can also be run standalone to check session status anytime.
 *
 * Usage (standalone):
 *   npx ts-node backend/src/services/scrapers/viberate/sessionHealth.ts
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import nodemailer from 'nodemailer';

const SESSION_PATH = path.resolve(__dirname, 'viberate-session.json');

// Lightweight endpoint — just checks auth, minimal data returned
// Using the user profile endpoint as it's small and always available
const HEALTH_CHECK_URL = 'https://api.viberate.com/api/v1/user/profile/';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SessionHealthResult {
  alive: boolean;
  status: number | null;
  reason: string;
  checkedAt: Date;
}

// ─── Health check ────────────────────────────────────────────────────────────

export async function checkSessionHealth(): Promise<SessionHealthResult> {
  const checkedAt = new Date();

  // Guard: session file must exist on disk
  if (!fs.existsSync(SESSION_PATH)) {
    return {
      alive: false,
      status: null,
      reason: 'Session file not found. Run login.ts to create one.',
      checkedAt,
    };
  }

  // Check how old the session file is — warn if older than 25 days
  // (most SaaS sessions expire between 30-90 days)
  const stats = fs.statSync(SESSION_PATH);
  const ageInDays = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60 * 24);
  if (ageInDays > 25) {
    console.warn(
      `[session-health] ⚠ Session file is ${Math.round(ageInDays)} days old — consider refreshing soon`
    );
  }

  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({ storageState: SESSION_PATH });
    const page = await context.newPage();

    // Navigate to app first — establishes referer/origin context
    await page.goto('https://app.viberate.com/', { waitUntil: 'domcontentloaded' });

    const response = await page.request.get(HEALTH_CHECK_URL);
    const status = response.status();
    const contentType = response.headers()['content-type'] || '';

    await browser.close();

    // 200 + JSON = session alive
    if (status === 200 && contentType.includes('application/json')) {
      return {
        alive: true,
        status,
        reason: 'Session valid',
        checkedAt,
      };
    }

    // 401 / 403 = clearly expired
    if (status === 401 || status === 403) {
      return {
        alive: false,
        status,
        reason: `Session expired (HTTP ${status}). Re-run login.ts to refresh.`,
        checkedAt,
      };
    }

    // 200 but HTML = redirected to login page
    if (status === 200 && !contentType.includes('application/json')) {
      return {
        alive: false,
        status,
        reason: 'Session expired — redirected to login page. Re-run login.ts.',
        checkedAt,
      };
    }

    // Anything else
    return {
      alive: false,
      status,
      reason: `Unexpected response (HTTP ${status}). Check Viberate manually.`,
      checkedAt,
    };

  } catch (err) {
    await browser.close();
    const msg = err instanceof Error ? err.message : String(err);
    return {
      alive: false,
      status: null,
      reason: `Request threw an error: ${msg}`,
      checkedAt,
    };
  }
}

// ─── Alert ───────────────────────────────────────────────────────────────────

export async function sendSessionAlert(result: SessionHealthResult): Promise<void> {
  // Only send if email env vars are configured
  const user = process.env.ALERT_EMAIL_USER;
  const pass = process.env.ALERT_EMAIL_PASS;
  const to   = process.env.ALERT_EMAIL_TO;

  if (!user || !pass || !to) {
    // No email configured — just log loudly to console
    console.error('');
    console.error('╔══════════════════════════════════════════════════════════╗');
    console.error('║  ⚠  VIBERATE SESSION EXPIRED — ACTION REQUIRED          ║');
    console.error('╠══════════════════════════════════════════════════════════╣');
    console.error(`║  Reason:  ${result.reason.padEnd(48)} ║`);
    console.error(`║  Time:    ${result.checkedAt.toISOString().padEnd(48)} ║`);
    console.error('╠══════════════════════════════════════════════════════════╣');
    console.error('║  Fix: cd backend && npx ts-node                          ║');
    console.error('║       src/services/scrapers/viberate/login.ts            ║');
    console.error('╚══════════════════════════════════════════════════════════╝');
    console.error('');
    return;
  }

  // Send email alert
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass },
    });

    await transporter.sendMail({
      from: user,
      to,
      subject: '⚠ ArtistDashboard: Viberate session expired',
      text: [
        'Your Viberate session has expired.',
        '',
        `Reason: ${result.reason}`,
        `Detected at: ${result.checkedAt.toISOString()}`,
        '',
        'The daily collection did NOT run today.',
        '',
        'To fix:',
        '  1. Open a terminal in your backend folder',
        '  2. Run: npx ts-node src/services/scrapers/viberate/login.ts',
        '  3. Log in manually in the browser window that opens',
        '  4. Press Enter to save the new session',
        '',
        'Collection will resume automatically on the next scheduled run.',
      ].join('\n'),
    });

    console.log(`[session-health] Alert email sent to ${to}`);
  } catch (err) {
    console.error('[session-health] Failed to send alert email:', err);
  }
}

// ─── Standalone runner ────────────────────────────────────────────────────────

if (require.main === module) {
  checkSessionHealth().then(result => {
    if (result.alive) {
      console.log(`✓ Session is alive (checked at ${result.checkedAt.toISOString()})`);
    } else {
      console.error(`✗ Session is dead: ${result.reason}`);
      process.exit(1);
    }
  }).catch(err => {
    console.error('Health check failed:', err);
    process.exit(1);
  });
}

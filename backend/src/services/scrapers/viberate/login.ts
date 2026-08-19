/**
 * STAGE 1 — Manual login script.
 *
 * Run this ONCE to create viberate-session.json.
 * You will see a real Chrome window open — log into Viberate manually,
 * then come back to the terminal and press Enter to save the session.
 *
 * Usage:
 *   npx ts-node backend/src/services/scrapers/viberate/login.ts
 */

import { chromium } from 'playwright';
import { getSessionPath } from './session';

const SESSION_PATH = getSessionPath();

async function main() {
  console.log('Launching browser for manual login...');
  console.log('A Chrome window will open. Log into Viberate, then return here.');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://app.viberate.com/login');

  console.log('');
  console.log('--> Log in manually in the browser window now.');
  console.log('--> Once you see your Viberate dashboard, come back here and press Enter.');
  console.log('');

  // Wait for the user to press Enter in the terminal
  await new Promise<void>((resolve) => {
    process.stdin.once('data', () => resolve());
  });

  await context.storageState({ path: SESSION_PATH });
  console.log(`Session saved to: ${SESSION_PATH}`);

  await browser.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('Login script failed:', err);
  process.exit(1);
});

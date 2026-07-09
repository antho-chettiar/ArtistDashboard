/**
 * STAGE 1 — Test fetch script.
 *
 * Goal: confirm that a saved Playwright session can hit Viberate's
 * api.viberate.com endpoints WITHOUT a full browser page load — i.e.
 * using page.request directly, the way the real collector eventually will.
 *
 * This does NOT write to any database. It only prints results to the
 * console so we can see clearly whether auth replay actually works,
 * before building anything else on top of this assumption.
 *
 * Usage:
 *   npx ts-node backend/src/services/scrapers/viberate/test-fetch.ts
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';

const SESSION_PATH = path.resolve(__dirname, 'viberate-session.json');

// One real endpoint we've already confirmed works in the browser
const TEST_URL =
  'https://api.viberate.com/api/v1/artist/sonu-nigam/overview/?metric=spotify_listeners';

async function main() {
  if (!fs.existsSync(SESSION_PATH)) {
    console.error(`No session file found at ${SESSION_PATH}`);
    console.error('Run login.ts first.');
    process.exit(1);
  }

  console.log('Loading saved session...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: SESSION_PATH });

  // We still open a page first — not to scrape it, but because some sites
  // expect a referer/origin that only exists once a real page has loaded
  // in that context. We navigate to the app, then use page.request from there.
  const page = await context.newPage();

  console.log('Navigating to app.viberate.com to establish page context...');
  await page.goto('https://app.viberate.com/', { waitUntil: 'domcontentloaded' });

  console.log(`Requesting: ${TEST_URL}`);

  let response;
  try {
    response = await page.request.get(TEST_URL);
  } catch (err) {
    console.error('Request threw an error:', err);
    await browser.close();
    process.exit(1);
  }

  console.log('Status:', response.status());
  console.log('Status text:', response.statusText());

  const contentType = response.headers()['content-type'] || '';
  console.log('Content-Type:', contentType);

  if (response.status() !== 200) {
    console.error('');
    console.error('--- NON-200 RESPONSE ---');
    const bodyText = await response.text();
    console.error('Body (first 500 chars):', bodyText.slice(0, 500));
    console.error('');
    console.error('This likely means: session expired, missing header, or auth replay does not work this way.');
    await browser.close();
    process.exit(1);
  }

  if (!contentType.includes('application/json')) {
    console.error('');
    console.error('--- UNEXPECTED CONTENT TYPE ---');
    const bodyText = await response.text();
    console.error('Body (first 500 chars):', bodyText.slice(0, 500));
    console.error('');
    console.error('Got a 200 but not JSON — possibly redirected to a login page (HTML).');
    await browser.close();
    process.exit(1);
  }

  const json = await response.json();
  console.log('');
  console.log('--- SUCCESS: RAW JSON RESPONSE ---');
  console.log(JSON.stringify(json, null, 2));

  await browser.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('Test script failed:', err);
  process.exit(1);
});

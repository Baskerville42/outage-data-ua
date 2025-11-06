// Fetch upstream HTML using a real headless browser (Playwright) to bypass anti-bot/WAF.
// Usage:
//   REGION_SOURCES_JSON='{"kyiv":"https://..."}' node scripts/fetch_regions_playwright.mjs           # all regions
//   node scripts/fetch_regions_playwright.mjs kyiv                                                   # only one region
//   REGION=kyiv node scripts/fetch_regions_playwright.mjs                                            # only one via env
//
// Notes:
// - Requires: Node.js 18+, Playwright (Chromium). In CI run: `npx playwright install --with-deps chromium`
// - Outputs: writes HTML to outputs/<region>.html

import fs from 'node:fs/promises';
import path from 'node:path';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch (err) {
  console.error('[ERROR] Playwright is not installed. Install with: npx playwright install --with-deps chromium');
  process.exit(2);
}

const raw = process.env.REGION_SOURCES_JSON || '{}';
/** @type {Record<string,string>} */
let sources;
try {
  sources = JSON.parse(raw);
} catch (e) {
  console.error('[ERROR] REGION_SOURCES_JSON is not valid JSON');
  process.exit(1);
}

const onlyRegion = process.argv[2] || process.env.REGION || null;
const regions = onlyRegion ? [onlyRegion] : Object.keys(sources);

await fs.mkdir('outputs', { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  locale: 'uk-UA',
  timezoneId: 'Europe/Kyiv',
});

for (const r of regions) {
  const url = sources[r];
  if (!url) {
    console.warn(`[WARN] No URL configured for region '${r}' — skipping`);
    continue;
  }
  const outFile = path.join('outputs', `${r}.html`);
  console.log(`[INFO] (PW) Fetching region='${r}' url=${url}`);
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 120_000 });
    const html = await page.content();
    await fs.writeFile(outFile, html);
    console.log(`[OK] (PW) Saved ${outFile} (${html.length} bytes)`);
  } catch (e) {
    console.warn(`[WARN] (PW) Failed region='${r}': ${e?.message || e}`);
  } finally {
    await page.close();
  }
}

await browser.close();

// Fetch upstream HTML using a real headless browser (Playwright) to bypass anti-bot/WAF.
// Adds resilient retries when anti-bot returns a lightweight placeholder page without data.
// Usage:
//   REGION_SOURCES_JSON='{"kyiv":"https://..."}' node scripts/fetch_regions_playwright.mjs           # all regions
//   node scripts/fetch_regions_playwright.mjs kyiv                                                   # only one region
//   REGION=kyiv node scripts/fetch_regions_playwright.mjs                                            # only one via env
//
// Env overrides:
//   MAX_FETCH_RETRY=3           # attempts per region (default 3)
//   MIN_HTML_BYTES=1500         # minimal acceptable HTML size (default 1500)
//   FETCH_BACKOFF_MS=2000       # base backoff in ms (default 2000)
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

const MAX_RETRY = Number(process.env.MAX_FETCH_RETRY || 3);
const MIN_BYTES = Number(process.env.MIN_HTML_BYTES || 1500);
const BACKOFF_MS = Number(process.env.FETCH_BACKOFF_MS || 2000);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isSuspectHtml(html) {
  if (!html) return true;
  const len = html.length;
  // Heuristic: anti-bot pages are very small and do not contain the expected markers
  const hasMarkers = html.includes('DisconSchedule.fact') && html.includes('DisconSchedule.preset');
  return len < MIN_BYTES || !hasMarkers;
}

async function fetchWithRetry(ctx, url, region) {
  let lastHtml = '';
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    const page = await ctx.newPage();
    try {
      if (attempt > 1) {
        console.log(`[INFO] (PW RETRY) Attempt ${attempt}/${MAX_RETRY} region='${region}' url=${url}`);
      } else {
        console.log(`[INFO] (PW) Fetching region='${region}' url=${url}`);
      }
      await page.goto(url, { waitUntil: 'networkidle', timeout: 120_000 });
      // Small extra wait to let client-side scripts settle if any
      await page.waitForTimeout(500);
      const html = await page.content();
      lastHtml = html;
      const suspect = isSuspectHtml(html);
      const bytes = html.length;
      if (!suspect) {
        return { ok: true, html, bytes, attempt };
      }
      // Log reason and backoff before next try (unless last)
      const reason = `${bytes} bytes${bytes < MIN_BYTES ? ' < MIN_HTML_BYTES' : ''}${html.includes('DisconSchedule.fact') ? '' : ', missing DisconSchedule.fact'}${html.includes('DisconSchedule.preset') ? '' : ', missing DisconSchedule.preset'}`;
      console.warn(`[WARN] (PW) Suspect HTML for region='${region}' on attempt ${attempt}/${MAX_RETRY}: ${reason}`);
      if (attempt < MAX_RETRY) {
        const jitter = Math.floor(Math.random() * 400);
        await sleep(BACKOFF_MS * attempt + jitter);
      }
    } catch (e) {
      console.warn(`[WARN] (PW) Error attempt ${attempt}/${MAX_RETRY} region='${region}': ${e?.message || e}`);
      if (attempt < MAX_RETRY) {
        const jitter = Math.floor(Math.random() * 400);
        await sleep(BACKOFF_MS * attempt + jitter);
      }
    } finally {
      await page.close();
    }
  }
  return { ok: false, html: lastHtml, bytes: (lastHtml || '').length, attempt: MAX_RETRY };
}

for (const r of regions) {
  const url = sources[r];
  if (!url) {
    console.warn(`[WARN] No URL configured for region '${r}' — skipping`);
    continue;
  }
  const outFile = path.join('outputs', `${r}.html`);
  const res = await fetchWithRetry(context, url, r);
  if (res.ok) {
    await fs.writeFile(outFile, res.html);
    console.log(`[OK] (PW) Saved ${outFile} (${res.bytes} bytes)`);
  } else {
    // Save whatever we could fetch for diagnostics
    await fs.writeFile(outFile, res.html || '<!-- empty -->');
    console.warn(`[WARN] (PW) Saved suspect HTML after ${res.attempt} attempts for region='${r}' (${res.bytes} bytes)`);
  }
}

await browser.close();

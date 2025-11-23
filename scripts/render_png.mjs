// Render PNG image of the schedule that visually matches our HTML design template
// Usage examples:
//   node scripts/render_png.mjs --json data/kyiv-region.json --gpv GPV1.2 --out images/kyiv-region/gpv-1-2.png
//   node scripts/render_png.mjs --json data/odesa.json --gpv GPV3.1 --html templates/html/full-template.html --out images/odesa/gpv-3-1.png
//   node scripts/render_png.mjs --theme dark --scale 2            # optional dark theme and higher DPR
//   node scripts/render_png.mjs --max                             # render at maximum quality (DPR=4 unless --scale provided)
//
// Requirements:
//   Node.js 18+
//   Playwright Chromium installed: npx playwright install --with-deps chromium
//
// Notes:
// - Uses templates/html/full-template.html by default. Data is injected into the page (window.__SCHEDULE__).
// - Also sets window.__GPV_KEY__ so the template can render the requested GPV group.
// - The screenshot is taken from the .container element to match the exact UI area without extra browser margins.

import http from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch (err) {
  console.error('[ERROR] Playwright is not installed. Install with: npx playwright install --with-deps chromium');
  process.exit(2);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      args[key] = val;
    }
  }
  return args;
}

const args = parseArgs(process.argv);
const projectRoot = process.cwd();

const htmlPath = path.resolve(args.html || 'templates/html/full-template.html');
const jsonPath = path.resolve(args.json || 'data/kyiv-region.json');
const outPath = path.resolve(args.out || 'images/kyiv-region/gpv-1-2.png');
const gpvKey = args.gpv || null; // e.g., GPV1.2
const dayArg = args.day || null; // e.g., 'tomorrow'
const theme = (args.theme === 'dark') ? 'dark' : 'light';
// Determine desired device scale factor (DPR). If --scale provided, use it. If --max or --quality max provided, use 4.
let deviceScaleFactor = Number(args.scale || NaN);
if (!Number.isFinite(deviceScaleFactor) || deviceScaleFactor <= 0) {
  if (args.max === true || String(args.quality || '').toLowerCase() === 'max') {
    deviceScaleFactor = 4; // maximum crispness, larger files
  } else {
    deviceScaleFactor = 4; // default to high quality by default
  }
}
// Cap to a reasonable upper bound to avoid extreme memory usage in CI
if (deviceScaleFactor > 4) deviceScaleFactor = 4;
const timeoutMs = Number(args.timeout || 30000);

async function ensureExists(p) {
  try { await stat(p); } catch (e) { return false; }
  return true;
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.mjs': return 'text/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.png': return 'image/png';
    case '.svg': return 'image/svg+xml';
    default: return 'application/octet-stream';
  }
}

async function startStaticServer(rootDir) {
  const server = http.createServer(async (req, res) => {
    try {
      const parsed = url.parse(req.url);
      let filePath = decodeURIComponent(parsed.pathname || '/');
      if (filePath === '/') {
        // Default to project README if someone hits root by accident
        filePath = '/README.md';
      }
      const abs = path.join(rootDir, filePath);
      const data = await readFile(abs);
      res.writeHead(200, { 'Content-Type': contentTypeFor(abs) });
      res.end(data);
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const baseURL = `http://${addr.address}:${addr.port}`;
  return { server, baseURL };
}

(async () => {
  if (!(await ensureExists(htmlPath))) {
    console.error(`[ERROR] HTML template not found: ${htmlPath}`);
    process.exit(1);
  }
  if (!(await ensureExists(jsonPath))) {
    console.error(`[ERROR] JSON data file not found: ${jsonPath}`);
    process.exit(1);
  }

  await mkdir(path.dirname(outPath), { recursive: true });

  const { server, baseURL } = await startStaticServer(projectRoot);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    deviceScaleFactor,
    locale: 'uk-UA',
    timezoneId: 'Europe/Kyiv',
  });
  const page = await context.newPage();

  // Inject JSON data and GPV key directly into the page before any scripts run
  const jsonBuf = await readFile(jsonPath, 'utf8');
  let scheduleData = null;
  try { scheduleData = JSON.parse(jsonBuf); } catch (e) {
    console.error('[ERROR] Failed to parse JSON:', e?.message || e);
    process.exit(1);
  }
  await page.addInitScript(({ data, gpv }) => {
    window.__SCHEDULE__ = data;
    if (gpv) window.__GPV_KEY__ = gpv;
  }, { data: scheduleData, gpv: gpvKey });

  const relHtml = path.relative(projectRoot, htmlPath).split(path.sep).join('/');
  const urlToOpen = `${baseURL}/${relHtml}?theme=${theme}${dayArg ? `&day=${dayArg}` : ''}`;
  try {
    await page.goto(urlToOpen, { waitUntil: 'networkidle', timeout: Math.max(timeoutMs, 10000) });

    // Wait for content depending on template: some templates may only have #today or only #matrix or be a summary card
    const hasMatrix = await page.$('#matrix');
    const hasToday = await page.$('#today');
    const hasSummary = await page.$('.summary-card');
    if (hasMatrix) {
      await page.waitForSelector('#matrix tbody tr:last-child td:last-child', { timeout: timeoutMs });
    }
    if (hasToday) {
      await page.waitForSelector('#today tbody tr td:last-child', { timeout: timeoutMs });
    }
    if (hasSummary) {
      // Summary readiness: either intervals are rendered (OFF case) OR status badge shows ON (all day)
      const waitIntervals = page.waitForSelector('.summary-intervals > div', { timeout: timeoutMs }).catch(() => null);
      const waitOnBadge = page.waitForSelector('.status-badge.badge-on', { timeout: timeoutMs }).catch(() => null);
      const winner = await Promise.race([waitIntervals, waitOnBadge]);
      if (!winner) {
        throw new Error('Summary template did not render intervals or ON badge in time');
      }
    }
    if (!hasMatrix && !hasToday && !hasSummary) {
      throw new Error('Template did not render #matrix nor #today nor summary-card');
    }

    const container = page.locator('.container');
    // Compute expected size for logging
    const bbox = await container.boundingBox();
    if (!bbox) throw new Error('Failed to measure .container bounding box');

    // Take element screenshot (includes element backgrounds, excludes extra page margins)
    await container.screenshot({ path: outPath, type: 'png' });

    console.log(`[OK] Saved PNG: ${outPath} (${Math.round(bbox.width)}x${Math.round(bbox.height)} @ dpr=${deviceScaleFactor})`);
  } catch (e) {
    console.error('[ERROR] Rendering failed:', e?.message || e);
    process.exitCode = 1;
  } finally {
    await page.close();
    await context.close();
    await browser.close();
    server.close();
  }
})();

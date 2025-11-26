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

import path from 'node:path';
import { ensureExists, startStaticServer, createBrowser, renderPage } from './lib/renderer.mjs';

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
    deviceScaleFactor = 1; // default to 1x (keeps images under 1000px width for Telegram)
  }
}
// Cap to a reasonable upper bound to avoid extreme memory usage in CI
if (deviceScaleFactor > 4) deviceScaleFactor = 4;
const timeoutMs = Number(args.timeout || 30000);

(async () => {
  if (!(await ensureExists(htmlPath))) {
    console.error(`[ERROR] HTML template not found: ${htmlPath}`);
    process.exit(1);
  }
  if (!(await ensureExists(jsonPath))) {
    console.error(`[ERROR] JSON data file not found: ${jsonPath}`);
    process.exit(1);
  }

  // Ensure output directory exists (handled by renderer.mjs ensureExists? No, that's for input. We need mkdir here or in renderer)
  // The original script did mkdir. The new renderer.mjs doesn't seem to do mkdir for output.
  // Wait, I should check renderer.mjs again. It doesn't do mkdir. I should do it here.
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.dirname(outPath), { recursive: true });

  let server, baseURL, browser;
  try {
    ({ server, baseURL } = await startStaticServer(projectRoot));
    browser = await createBrowser();

    const { width, height } = await renderPage({
      browser,
      baseURL,
      htmlPath,
      jsonPath,
      outPath,
      gpvKey,
      dayArg,
      theme,
      deviceScaleFactor,
      timeoutMs,
      projectRoot
    });

    console.log(`[OK] Saved PNG: ${outPath} (${width}x${height} @ dpr=${deviceScaleFactor})`);
  } catch (e) {
    console.error('[ERROR] Rendering failed:', e?.message || e);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (server) server.close();
  }
})();

// Batch render PNG schedules for all regions and all GPV groups using Playwright renderer
// Usage:
//   node scripts/batch_render.mjs                     # render all data/*.json, light theme, scale=1
//   node scripts/batch_render.mjs --theme dark        # dark theme
//   node scripts/batch_render.mjs --scale 2           # HiDPI export
//   node scripts/batch_render.mjs --region kyiv-region  # only one region (by regionId or by file stem)
//
// Requirements: Node.js 18+, Playwright installed (chromium).

import { readdir, readFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer, createBrowser, renderPage } from './lib/renderer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    args[k] = v;
  }
  return args;
}

const args = parseArgs(process.argv);
const theme = (args.theme === 'dark') ? 'dark' : 'light';
// Accept explicit --scale; otherwise rely on single renderer's high-DPI default (DPR=4). Support --max passthrough.
const scale = Number(args.scale || NaN);
const onlyRegion = args.region || null; // regionId or file stem
// Support passing a comma-separated list of specific JSON files to process
const specificFiles = args.files ? args.files.split(',').map(f => f.trim()).filter(Boolean) : null;

const dataDir = path.join(projectRoot, 'data');
const imagesDir = path.join(projectRoot, 'images');
const templateFull = path.join(projectRoot, 'templates', 'html', 'full-template.html');
const templateEmergency = path.join(projectRoot, 'templates', 'html', 'emergency-template.html');
const templateWeek = path.join(projectRoot, 'templates', 'html', 'week-template.html');
const templateGroups = path.join(projectRoot, 'templates', 'html', 'groups-template.html');
const templateSummary = path.join(projectRoot, 'templates', 'html', 'summary-item.html');

function normalizeRegionId(json, fileStem) {
  return (json && typeof json.regionId === 'string' && json.regionId.trim()) || fileStem;
}

function gpvToFileName(gpvKey) {
  // GPV1.2 -> gpv-1-2.png
  const m = String(gpvKey).match(/^GPV(\d+)\.(\d+)$/i);
  if (!m) {
    // fallback: sanitize
    return `gpv-${String(gpvKey).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
  }
  return `gpv-${m[1]}-${m[2]}.png`;
}

async function fileExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

// Simple concurrency limiter
async function runParallel(tasks, concurrency) {
  const results = [];
  const executing = [];
  for (const task of tasks) {
    const p = Promise.resolve().then(() => task());
    results.push(p);
    const e = p.then(() => executing.splice(executing.indexOf(e), 1));
    executing.push(e);
    if (executing.length >= concurrency) {
      await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

(async () => {
  // Verify templates exist
  let missing = false;
  for (const [name, p] of [['full', templateFull], ['emergency', templateEmergency], ['week', templateWeek], ['groups', templateGroups], ['summary', templateSummary]]) {
    if (!(await fileExists(p))) {
      console.error(`[ERROR] HTML template not found (${name}): ${p}`);
      missing = true;
    }
  }
  if (missing) process.exit(1);

  await mkdir(imagesDir, { recursive: true });

  const entries = await readdir(dataDir, { withFileTypes: true });
  let jsonFiles = entries.filter(e => e.isFile() && e.name.endsWith('.json')).map(e => path.join(dataDir, e.name));

  if (specificFiles && specificFiles.length > 0) {
    // Filter the list to only include files that match the basenames or full paths provided
    const allowed = new Set(specificFiles.map(f => path.basename(f)));
    jsonFiles = jsonFiles.filter(p => allowed.has(path.basename(p)));
    console.log(`[INFO] Filtering to ${jsonFiles.length} specific files from --files argument`);
  }

  if (jsonFiles.length === 0) {
    console.warn('[WARN] No JSON files found in data/ (or none matched filter)');
    process.exit(0);
  }

  // Determine scale factor once
  let deviceScaleFactor = scale;
  if (!Number.isFinite(deviceScaleFactor) || deviceScaleFactor <= 0) {
    if (args.max === true || String(args.quality || '').toLowerCase() === 'max') {
      deviceScaleFactor = 4;
    } else {
      deviceScaleFactor = 1;
    }
  }
  if (deviceScaleFactor > 4) deviceScaleFactor = 4;

  console.log('[INFO] Starting static server and browser...');
  const { server, baseURL } = await startStaticServer(projectRoot);
  const browser = await createBrowser();

  const tasks = [];
  let total = 0;

  const toEmergencyName = (base) => base.replace(/\.png$/i, '-emergency.png');
  const toWeekName = (base) => base.replace(/\.png$/i, '-week.png');
  const toSummaryName = (base) => base.replace(/\.png$/i, '-summary.png');

  for (const jf of jsonFiles) {
    const fileStem = path.basename(jf, '.json');
    try {
      const buf = await readFile(jf, 'utf8');
      const json = JSON.parse(buf);
      if (!json || typeof json !== 'object' || !json.preset || !json.fact) {
        continue;
      }
      const regionId = normalizeRegionId(json, fileStem);
      if (onlyRegion && (onlyRegion !== regionId && onlyRegion !== fileStem)) {
        continue;
      }

      const presetData = json?.preset?.data || {};
      const gpvKeys = Object.keys(presetData).filter(k => /^GPV\d+\.\d+$/i.test(k)).sort((a, b) => {
        const pa = a.match(/\d+|\.|/g)?.join('') || '';
        const pb = b.match(/\d+|\.|/g)?.join('') || '';
        return pa.localeCompare(pb, 'en', { numeric: true });
      });
      if (gpvKeys.length === 0) {
        console.warn(`[WARN] No GPV groups in ${jf} — skipping`);
        continue;
      }

      for (const gpv of gpvKeys) {
        const outDir = path.join(imagesDir, regionId);
        const baseName = gpvToFileName(gpv);

        // 1) Full template
        tasks.push({
          name: `FULL ${regionId} ${gpv}`,
          run: async () => {
            const outPath = path.join(outDir, baseName);
            await mkdir(path.dirname(outPath), { recursive: true });
            await renderPage({
              browser, baseURL, htmlPath: templateFull, jsonPath: jf, gpvKey: gpv, outPath,
              theme, deviceScaleFactor, projectRoot
            });
            console.log(`[INFO] Rendered FULL ${regionId} ${gpv}`);
          }
        });

        // 2) Emergency
        tasks.push({
          name: `EMERGENCY ${regionId} ${gpv}`,
          run: async () => {
            const outPath = path.join(outDir, toEmergencyName(baseName));
            await mkdir(path.dirname(outPath), { recursive: true });
            await renderPage({
              browser, baseURL, htmlPath: templateEmergency, jsonPath: jf, gpvKey: gpv, outPath,
              theme, deviceScaleFactor, projectRoot
            });
            console.log(`[INFO] Rendered EMERGENCY ${regionId} ${gpv}`);
          }
        });

        // 3) Week
        tasks.push({
          name: `WEEK ${regionId} ${gpv}`,
          run: async () => {
            const outPath = path.join(outDir, toWeekName(baseName));
            await mkdir(path.dirname(outPath), { recursive: true });
            await renderPage({
              browser, baseURL, htmlPath: templateWeek, jsonPath: jf, gpvKey: gpv, outPath,
              theme, deviceScaleFactor, projectRoot
            });
            console.log(`[INFO] Rendered WEEK ${regionId} ${gpv}`);
          }
        });

        // 4) Summary
        tasks.push({
          name: `SUMMARY ${regionId} ${gpv}`,
          run: async () => {
            const outPath = path.join(outDir, toSummaryName(baseName));
            await mkdir(path.dirname(outPath), { recursive: true });
            await renderPage({
              browser, baseURL, htmlPath: templateSummary, jsonPath: jf, gpvKey: gpv, outPath,
              theme, deviceScaleFactor, projectRoot
            });
            console.log(`[INFO] Rendered SUMMARY ${regionId} ${gpv}`);
          }
        });
      }

      // 5) Groups matrix (today)
      tasks.push({
        name: `GROUPS/TODAY ${regionId}`,
        run: async () => {
          const outDir = path.join(imagesDir, regionId);
          const outPath = path.join(outDir, 'gpv-all-today.png');
          await mkdir(path.dirname(outPath), { recursive: true });
          await renderPage({
            browser, baseURL, htmlPath: templateGroups, jsonPath: jf, outPath,
            theme, deviceScaleFactor, projectRoot
          });
          console.log(`[INFO] Rendered GROUPS/TODAY ${regionId}`);
        }
      });

      // 6) Groups matrix (tomorrow)
      tasks.push({
        name: `GROUPS/TOMORROW ${regionId}`,
        run: async () => {
          const outDir = path.join(imagesDir, regionId);
          const outPath = path.join(outDir, 'gpv-all-tomorrow.png');
          await mkdir(path.dirname(outPath), { recursive: true });
          await renderPage({
            browser, baseURL, htmlPath: templateGroups, jsonPath: jf, outPath,
            dayArg: 'tomorrow', theme, deviceScaleFactor, projectRoot
          });
          console.log(`[INFO] Rendered GROUPS/TOMORROW ${regionId}`);
        }
      });

    } catch (e) {
      console.warn(`[WARN] Failed to prepare tasks for ${jf}: ${e?.message || e}`);
    }
  }

  total = tasks.length;
  console.log(`[INFO] Found ${total} rendering tasks. Executing with concurrency=4...`);

  let ok = 0;
  let failed = 0;

  // Wrap tasks to track success/failure
  const wrappedTasks = tasks.map(t => async () => {
    try {
      await t.run();
      ok++;
    } catch (e) {
      console.error(`[ERROR] Task '${t.name}' failed: ${e?.message || e}`);
      failed++;
    }
  });

  try {
    await runParallel(wrappedTasks, 4);
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`[SUMMARY] Rendered: ${ok}/${total} succeeded, ${failed} failed. Theme=${theme} Scale=${deviceScaleFactor}`);
  process.exit(failed > 0 ? 1 : 0);
})();

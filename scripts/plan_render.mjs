import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { expectedImages, needsRender, renderAssetsHash, renderKey, stampRender } from './lib/render-state.mjs';

// Both workflow jobs use the same checkout, data artifact and reference time.
const root = process.cwd();
const {
  REGION, REGION_SOURCES_JSON = '{}', FORCE_RENDER, GITHUB_OUTPUT,
  RENDER_AT = new Date().toISOString(), RENDER_KEY, RENDER_OUTPUT = 'images',
} = process.env;
const stamp = process.argv.includes('--stamp');
const regions = REGION ? [REGION] : Object.keys(JSON.parse(REGION_SOURCES_JSON));
const assetsHash = await renderAssetsHash(root);
const plan = [];

for (const region of regions) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(region)) throw new Error(`Invalid region: ${region}`);
  let data;
  try {
    data = JSON.parse(await readFile(path.join(root, 'data', region + '.json'), 'utf8'));
  } catch (error) {
    if (stamp || error.code !== 'ENOENT') throw error;
    console.warn(`[WARN] No JSON to render for ${region}`);
    continue;
  }
  if (data.regionId && data.regionId !== region) throw new Error(`Unexpected region in ${region}.json`);
  const files = expectedImages(data);
  if (!data.fact || !files.length) {
    if (stamp) throw new Error(`No valid schedule to render for ${region}`);
    console.warn(`[WARN] No valid schedule to render for ${region}`);
    continue;
  }
  const key = renderKey(data, RENDER_AT, assetsHash);
  const dir = path.join(RENDER_OUTPUT, region);
  if (stamp) {
    if (key !== RENDER_KEY) throw new Error(`Render input changed for ${region}`);
    await stampRender(dir, key, files);
  } else if (await needsRender(dir, key, files, FORCE_RENDER === 'true')) {
    plan.push({ region, key });
  }
}

if (!stamp) {
  console.log(`[INFO] Render regions: ${plan.map(({ region }) => region).join(', ') || '(none)'}`);
  if (GITHUB_OUTPUT) {
    await appendFile(GITHUB_OUTPUT, `regions=${JSON.stringify(plan)}\nrender_at=${RENDER_AT}\n`);
  }
}

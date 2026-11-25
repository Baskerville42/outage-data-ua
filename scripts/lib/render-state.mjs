import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const kyivDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
});
const stateFile = 'render-state.json';

function stableJson(value) {
  return JSON.stringify(value, (_, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
      : item
  );
}

export function imageRenderInfo(data, asOf, renderedAt = asOf) {
  const rawDate = data?.fact?.today;
  const scheduleDate = new Date(rawDate == null || rawDate === '' ? NaN : Number(rawDate) * 1000);
  const day = kyivDate.format(new Date(asOf));
  return {
    renderedAt,
    day,
    dateMismatch: !Number.isFinite(scheduleDate.getTime()) || kyivDate.format(scheduleDate) !== day,
    fetchFailed: data?.lastUpdateStatus?.ok === false,
  };
}

export const gpvKeys = data => Object.keys(data?.preset?.data ?? {}).filter(key => /^GPV\d+\.\d+$/i.test(key));
export const gpvImageName = key => key.replace(/^GPV(\d+)\.(\d+)$/i, 'gpv-$1-$2.png');
const groupVariants = ['', '-emergency', '-week', '-summary'];

export function expectedImages(data) {
  const keys = gpvKeys(data);
  if (!keys.length) return [];
  return [
    ...keys.flatMap(key => groupVariants.map(suffix => gpvImageName(key).replace(/\.png$/, suffix + '.png'))),
    'gpv-all-today.png',
    'gpv-all-tomorrow.png',
  ].sort();
}

export function renderKey(data, renderedAt, assetsHash) {
  const { day, dateMismatch, fetchFailed } = imageRenderInfo(data, renderedAt);
  const status = data.lastUpdateStatus;
  return createHash('sha256').update(stableJson({
    assetsHash, day, dateMismatch, fetchFailed,
    status: status?.status, code: status?.code,
    fact: data.fact, preset: data.preset, attention: data.attention,
    regionId: data.regionId, regionAffiliation: data.regionAffiliation,
    contentHash: data.meta?.contentHash,
  })).digest('hex');
}

async function filesBelow(root, dir) {
  const entries = await readdir(path.join(root, dir), { withFileTypes: true });
  const files = await Promise.all(entries.map(entry => {
    const relative = path.join(dir, entry.name);
    return entry.isDirectory() ? filesBelow(root, relative) : [relative];
  }));
  return files.flat();
}

export async function renderAssetsHash(root) {
  const files = [
    ...await filesBelow(root, 'templates/html'),
    '.github/workflows/scheduled.yml', 'package-lock.json', 'scripts/batch_render.mjs',
    'scripts/lib/renderer.mjs', 'scripts/lib/render-state.mjs', 'scripts/plan_render.mjs',
  ].sort();
  const hash = createHash('sha256');
  for (const file of files) {
    const fileHash = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
    hash.update(file + '\0' + fileHash + '\n');
  }
  return hash.digest('hex');
}

async function hasCompleteImages(dir, files) {
  const results = await Promise.all(files.map(async file => {
    try {
      const info = await stat(path.join(dir, file));
      return info.isFile() && info.size > 0;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return false;
    }
  }));
  return files.length > 0 && results.every(Boolean);
}

export async function needsRender(dir, key, files, force = false) {
  if (force) return true;
  try {
    const state = JSON.parse(await readFile(path.join(dir, stateFile), 'utf8'));
    if (state?.key !== key) return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return true;
    throw error;
  }
  return !(await hasCompleteImages(dir, files));
}

export async function stampRender(dir, key, files) {
  if (!(await hasCompleteImages(dir, files))) throw new Error(`Incomplete render in ${dir}`);
  await writeFile(path.join(dir, stateFile), JSON.stringify({ key }) + '\n');
}

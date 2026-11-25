import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { expectedImages, imageRenderInfo, needsRender, renderKey, stampRender } from '../scripts/lib/render-state.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = JSON.parse(await readFile(new URL('./fixtures/kyiv-midnight.json', import.meta.url)));
const today = '2026-10-30T00:01:00+02:00';
const later = '2026-10-30T00:06:00+02:00';
const key = (data, at = today, assets = 'templates-v1') => renderKey(data, at, assets);

test('quiet cycles keep the same render key but preserve different JSON freshness', () => {
  const a = { ...fixture, lastUpdated: today, lastUpdateStatus: { status: 'parsed', code: 200, ok: true, at: today, attempt: 1 } };
  const b = { ...a, lastUpdated: later, lastUpdateStatus: { ...a.lastUpdateStatus, at: later, attempt: 2 } };
  assert.notDeepEqual(a, b);
  assert.equal(key(a), key(b, later));
});

test('schedule, notice add/edit/removal, status, midnight and asset edits invalidate images', () => {
  const a = { ...fixture, attention: null, lastUpdateStatus: { status: 'parsed', code: 200, ok: true } };
  const changed = structuredClone(a);
  const group = Object.keys(a.preset.data)[0];
  changed.fact.data = { [a.fact.today]: { [group]: { 1: 'no' } } };
  assert.notEqual(key(a), key(changed));
  const alert = { ...a, attention: 'Аварійні відключення' };
  const otherAlert = { ...a, attention: 'Оновлено повідомлення' };
  assert.notEqual(key(a), key(alert));
  assert.notEqual(key(alert), key(otherAlert));
  assert.equal(key({ ...alert, attention: null }), key(a));
  const error = { ...a, lastUpdateStatus: { status: 'fetch_failed', code: 503, ok: false } };
  assert.notEqual(key(a), key(error));
  assert.equal(key(error), key({ ...error, lastUpdateStatus: { ...error.lastUpdateStatus, attempt: 2, at: later } }, later));
  assert.equal(imageRenderInfo(error, today).fetchFailed, true);
  assert.equal(imageRenderInfo(a, today).fetchFailed, false);
  assert.equal(imageRenderInfo(a, today).dateMismatch, false);
  const tomorrow = '2026-10-30T22:00:00Z';
  assert.notEqual(key(a), key(a, tomorrow));
  assert.equal(imageRenderInfo(a, tomorrow).dateMismatch, true);
  assert.equal(imageRenderInfo(a, '2026-10-30T21:59:59Z').dateMismatch, false);
  assert.notEqual(key(a), key(a, today, 'templates-v2'));
});

test('only a verified, complete set of public filenames can be reused', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'outage-render-state-'));
  try {
    const images = expectedImages(fixture);
    assert.ok(images.includes('gpv-45-1.png'));
    assert.ok(images.includes('gpv-45-1-emergency.png'));
    assert.ok(images.includes('gpv-45-1-week.png'));
    assert.ok(images.includes('gpv-45-1-summary.png'));
    assert.ok(images.includes('gpv-all-today.png'));
    assert.ok(images.includes('gpv-all-tomorrow.png'));
    assert.equal(await needsRender(dir, 'key', images), true);
    await assert.rejects(stampRender(dir, 'key', images), /Incomplete render/);
    await Promise.all(images.map(file => writeFile(path.join(dir, file), 'png stub')));
    await stampRender(dir, 'key', images);
    assert.equal(await needsRender(dir, 'key', images), false);
    assert.equal(await needsRender(dir, 'key', images, true), true);
    assert.equal(await needsRender(dir, 'next-key', images), true);
    await rm(path.join(dir, images[0]));
    assert.equal(await needsRender(dir, 'key', images), true);
    await writeFile(path.join(dir, 'render-state.json'), '{');
    assert.equal(await needsRender(dir, 'key', images), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('workflow planner and stamp skip a fresh JSON-only write without touching image files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'outage-render-plan-'));
  try {
    for (const subtree of ['scripts', 'templates', '.github']) await cp(path.join(root, subtree), path.join(dir, subtree), { recursive: true });
    await cp(path.join(root, 'package-lock.json'), path.join(dir, 'package-lock.json'));
    await mkdir(path.join(dir, 'data'));
    const region = fixture.regionId;
    const files = expectedImages(fixture);
    const json = path.join(dir, 'data', region + '.json');
    const regionOutput = path.join(dir, 'rendered', region);
    const output = path.join(dir, 'workflow-outputs');
    const run = (args = [], flags = {}) => execFileSync(process.execPath, ['scripts/plan_render.mjs', ...args], {
      cwd: dir, env: { ...process.env, REGION: region, GITHUB_OUTPUT: output, RENDER_AT: today, ...flags },
      stdio: 'pipe',
    });
    const plan = async flags => {
      await writeFile(output, '');
      run([], flags);
      return JSON.parse((await readFile(output, 'utf8')).match(/^regions=(.*)$/m)[1]);
    };

    await writeFile(json, JSON.stringify({ ...fixture, lastUpdated: today }));
    const first = await plan();
    assert.equal(first.length, 1);
    await mkdir(regionOutput, { recursive: true });
    for (const image of files) await writeFile(path.join(regionOutput, image), 'png stub');
    assert.throws(() => run(['--stamp'], { RENDER_OUTPUT: 'rendered', RENDER_KEY: 'wrong' }), /Render input changed/);
    run(['--stamp'], { RENDER_OUTPUT: 'rendered', RENDER_KEY: first[0].key });
    await cp(path.join(dir, 'rendered'), path.join(dir, 'images'), { recursive: true });
    const stamped = await readFile(path.join(dir, 'images', region, 'render-state.json'), 'utf8');
    await writeFile(json, JSON.stringify({ ...fixture, lastUpdated: later, lastUpdateStatus: { ...fixture.lastUpdateStatus, at: later, attempt: 40 } }));
    assert.deepEqual(await plan({ RENDER_AT: later }), []);
    assert.equal(await readFile(path.join(dir, 'images', region, 'render-state.json'), 'utf8'), stamped);
    assert.equal(JSON.parse(await readFile(json, 'utf8')).lastUpdated, later);
    assert.equal((await plan({ FORCE_RENDER: 'true' })).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

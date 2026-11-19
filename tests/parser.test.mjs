import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const incident = JSON.parse(await readFile(new URL('fixtures/kyiv-midnight.json', import.meta.url), 'utf8'));

test('parser preserves source facts and reports missing current-day data', async t => {
  const today = incident.fact.today;
  const cases = [
    ['midnight rollover', [], true],
    ['empty object', {}, true],
    ['only yesterday remains', { [today - 86400]: { 'GPV45.1': { '1': 'no' } } }, true],
    ['today is published', { [today]: { 'GPV45.1': { '1': 'yes' } } }, false],
  ];
  for (const [name, data, warning] of cases) {
    await t.test(name, async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'outage-parser-'));
      try {
        const fact = { ...incident.fact, data };
        const input = path.join(dir, 'source.html');
        const output = path.join(dir, 'kyiv.json');
        // A new empty day must not silently inherit yesterday's factual schedule.
        await writeFile(output, JSON.stringify({ ...incident, fact: { ...fact, data: { [today - 86400]: { 'GPV45.1': { '1': 'no' } } } } }));
        await writeFile(input, `<script>DisconSchedule.fact = ${JSON.stringify(fact)};\nDisconSchedule.preset = ${JSON.stringify(incident.preset)};</script>`);
        const result = spawnSync(process.execPath, [path.join(root, 'scripts/parse_fact.js'), '--region', 'kyiv', '--in', input, '--out', output], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(await readFile(output, 'utf8')).fact, fact);
        assert.equal(result.stderr.includes('No fact groups for today'), warning);
        const summary = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('[INFO] Fact summary ')).slice('[INFO] Fact summary '.length));
        assert.equal(summary.today, today);
        assert.equal(summary.update, '28.10.2026 23:35');
        assert.deepEqual(summary.dayKeys, Object.keys(data));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

test('parser stores the attention banner without changing contentHash', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'outage-parser-'));
  try {
    const parse = async banner => {
      const input = path.join(dir, 'source.html');
      const output = path.join(dir, 'kyiv.json');
      await writeFile(input, `${banner}<script>DisconSchedule.fact = ${JSON.stringify(incident.fact)};\nDisconSchedule.preset = ${JSON.stringify(incident.preset)};</script>`);
      const result = spawnSync(process.execPath, [path.join(root, 'scripts/parse_fact.js'), '--region', 'kyiv', '--in', input, '--out', output], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(await readFile(output, 'utf8'));
    };
    // Shortened markup of dtek-krem.com.ua as served on 09.11.2026
    const withBanner = await parse('<div class="m-attention__body"><div class="m-attention__text"><p>В <strong>Білоцерківському та Обухівському районах</strong> введені <strong>екстрені відключення.</strong>&nbsp;</p>\n<p>В інших районах області&nbsp; діють стабілізаційні відключення.<br>Дякуємо за ваше розуміння!&nbsp;&nbsp;</p>\n<p>&nbsp;</p></div></div>');
    const text = 'В Білоцерківському та Обухівському районах введені екстрені відключення.\nВ інших районах області діють стабілізаційні відключення.\nДякуємо за ваше розуміння!';
    assert.deepEqual(withBanner.attention, { text });
    assert.equal(withBanner.meta.attentionHash, createHash('sha256').update(text).digest('hex'));

    const withoutBanner = await parse('');
    assert.equal(withoutBanner.attention, null);
    assert.equal(withoutBanner.meta.attentionHash, null);
    assert.equal(withBanner.meta.contentHash, withoutBanner.meta.contentHash);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

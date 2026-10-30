import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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

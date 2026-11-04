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

// Announcement markup as published by the provider (trimmed from real snapshots of 04.11.2026).
const attention = inner => `<div class="m-attention__body" style="padding-top: 37px">
  <div class="m-attention__text">${inner}</div>
</div>`;
const announcements = {
  kyiv: ['<p>За наказом НЕК Укренерго введені <strong>екстрені</strong> відключення електроенергії.&nbsp;&nbsp;<br>Графіки відключень при цьому не діють.  Будь ласка, розумно споживайте електроенергію.</p>\n<p>&nbsp;</p>',
    { active: true, schedulesSuspended: true, summary: 'За наказом НЕК Укренерго введені екстрені відключення електроенергії.' }],
  dnipro: ['<p>За розпорядженням НЕК Укренерго в<strong> м. Дніпро</strong> застосовуються <strong>екстрені </strong>відключення.&nbsp;&nbsp;</p>\n<p>В області діють графіки стабілізаційних відключень.</p>',
    { active: true, schedulesSuspended: false, summary: 'За розпорядженням НЕК Укренерго в м. Дніпро застосовуються екстрені відключення.' }],
  odesa: ['<p>За наказом <strong>НЕК Укренерго</strong> сьогодні з <strong>00:00 до 24:00</strong>&nbsp;діють <strong>стабілізаційні відключення</strong> електроенергії.</p>\n<p>Будь ласка, розумно споживайте електроенергію — це допоможе уникнути екстрених відключень.<!--EndFragment--></p>',
    { active: false, schedulesSuspended: false, summary: null }],
};

test('parser detects announced emergency outages without false positives', async t => {
  for (const [name, [inner, expected]] of Object.entries(announcements)) {
    await t.test(name, async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'outage-parser-'));
      try {
        const input = path.join(dir, 'source.html');
        const output = path.join(dir, 'out.json');
        await writeFile(input, `${attention(inner)}<script>DisconSchedule.fact = ${JSON.stringify(incident.fact)};\nDisconSchedule.preset = ${JSON.stringify(incident.preset)};</script>`);
        const result = spawnSync(process.execPath, [path.join(root, 'scripts/parse_fact.js'), '--region', name, '--in', input, '--out', output], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        const { emergency } = JSON.parse(await readFile(output, 'utf8'));
        const { text, ...flags } = emergency;
        assert.deepEqual(flags, expected);
        assert.ok(!/[<&]|nbsp/.test(text), text);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

test('parser sets emergency to null when the announcement block is absent', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'outage-parser-'));
  try {
    const input = path.join(dir, 'source.html');
    const output = path.join(dir, 'out.json');
    await writeFile(input, `<script>DisconSchedule.fact = ${JSON.stringify(incident.fact)};</script>`);
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/parse_fact.js'), '--region', 'kyiv', '--in', input, '--out', output], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(await readFile(output, 'utf8')).emergency, null);
    assert.match(result.stderr, /m-attention__text not found/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

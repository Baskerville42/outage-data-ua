import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer, createBrowser, renderPage } from '../../scripts/lib/renderer.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const incident = JSON.parse(await readFile(new URL('../fixtures/kyiv-midnight.json', import.meta.url), 'utf8'));
const gpv = 'GPV45.1';
const today = incident.fact.today;
const allYes = () => Object.fromEntries(Array.from({ length: 24 }, (_, i) => [String(i + 1), 'yes']));
const withSchedule = schedule => ({ ...incident, fact: { ...incident.fact, data: { [today]: { [gpv]: schedule } } } });
let browser, server, baseURL;

before(async () => {
  ({ server, baseURL } = await startStaticServer(root));
  browser = await createBrowser();
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function view(template, data, check, day = 'today') {
  // Date rendering must be independent of the host/browser timezone.
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'America/Los_Angeles' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.addInitScript(({ data, gpv }) => { window.__SCHEDULE__ = data; window.__GPV_KEY__ = gpv; }, { data, gpv });
    await page.goto(`${baseURL}/templates/html/${template}?day=${day}`);
    const selector = template === 'summary-item.html' ? '.summary-card' : template === 'groups-template.html' || template === 'week-template.html' ? '#matrix' : '#today';
    await page.waitForSelector(`${selector}[data-schedule-ready="true"]`, { timeout: 3000 });
    assert.deepEqual(errors, []);
    await check(page);
  } finally {
    await context.close();
  }
}

test('incident snapshot shows missing data and separates source and received timestamps', async () => {
  await view('emergency-template.html', incident, async page => {
    assert.equal(await page.locator('#today tbody tr th').first().textContent(), '30 жовтня');
    assert.equal(await page.locator('.schedule-missing').textContent(), 'Дані графіка відсутні');
    assert.equal(await page.locator('#today tbody td').count(), 0);
    const timestamp = await page.locator('#lastUpdated').textContent();
    assert.match(timestamp, /Оновлення розкладу в джерелі: 28\.10\.2026 23:35/);
    assert.match(timestamp, /Дані отримано: 30\.10\.2026,? 00:01/);
  });
});

test('missing variants never imply uninterrupted power in emergency or summary', async t => {
  const variants = [[], {}, null, { [today]: {} }, { [today]: { [gpv]: {} } }, { [today]: { 'GPV46.1': allYes() } }, { [today - 86400]: { [gpv]: allYes() } }];
  for (const [i, data] of variants.entries()) {
    await t.test(`variant ${i + 1}`, async () => {
      const fixture = { ...incident, fact: { ...incident.fact, data } };
      await view('emergency-template.html', fixture, async page => {
        assert.equal(await page.locator('#today tbody tr').count(), 1);
        assert.equal(await page.locator('.schedule-missing').count(), 1);
      });
      await view('summary-item.html', fixture, async page => {
        assert.equal(await page.locator('.summary-status').textContent(), 'Дані графіка відсутні');
        assert.equal(await page.locator('.badge-unknown').textContent(), '?');
        assert.equal(await page.locator('.badge-on, .badge-off').count(), 0);
      });
    });
  }
});

test('partial or invalid slots stay unknown rather than white or ON', async t => {
  for (const value of [undefined, 'invalid']) {
    await t.test(String(value), async () => {
      const schedule = allYes();
      if (value === undefined) delete schedule['12']; else schedule['12'] = value;
      await view('emergency-template.html', withSchedule(schedule), async page => {
        assert.equal(await page.locator('td.state-unknown').textContent(), '?');
        assert.equal(await page.locator('td.state-yes').count(), 23);
        assert.equal(await page.locator('.legend-unknown').count(), 1);
      });
      await view('summary-item.html', withSchedule(schedule), async page => {
        assert.equal(await page.locator('.summary-status').textContent(), 'Дані графіка неповні');
        assert.equal(await page.locator('.badge-unknown').textContent(), '?');
      });
    });
  }
});

test('24 explicit yes slots still produce ON all day', async () => {
  await view('summary-item.html', withSchedule(allYes()), async page => {
    assert.equal(await page.locator('.badge-on').textContent(), 'ON');
    assert.equal(await page.locator('.summary-status').textContent(), 'світло буде весь день');
    assert.equal(await page.locator('.summary-intervals > div').count(), 0);
  });
});

test('all-groups matrix includes missing groups from a partially published day', async () => {
  const fixture = withSchedule(allYes());
  fixture.preset = { ...incident.preset, data: { ...incident.preset.data, 'GPV46.1': incident.preset.data[gpv] } };
  await view('groups-template.html', fixture, async page => {
    assert.equal(await page.locator('#matrix tbody tr').count(), 2);
    assert.equal(await page.locator('td.state-yes').count(), 24);
    assert.match(await page.locator('tr[data-schedule-status="missing"]').textContent(), /46\.1.*Дані графіка відсутні/);
  });
});

test('known outage slots preserve icons and half-hour intervals', async () => {
  const schedule = { ...allYes(), '12': 'no', '13': 'first', '19': 'second', '22': 'mfirst', '24': 'msecond' };
  const fixture = withSchedule(schedule);
  await view('emergency-template.html', fixture, async page => {
    assert.equal(await page.locator('#today tbody td').count(), 24);
    assert.equal(await page.locator('#today tbody img').count(), 5);
    assert.equal(await page.locator('td.state-unknown').count(), 0);
  });
  await view('summary-item.html', fixture, async page => {
    assert.equal(await page.locator('.badge-off').textContent(), 'OFF');
    assert.deepEqual(await page.locator('.summary-intervals > div').allTextContents(), [
      'з 11:00 до 12:30', 'з 18:30 до 19:00', 'з 21:00 до 21:30', 'з 23:30 до 24:00',
    ]);
  });
});

test('tomorrow never falls back to today, yesterday, or a later available day', async () => {
  const fixture = withSchedule(allYes());
  fixture.fact.data[today - 86400] = { [gpv]: allYes() };
  fixture.fact.data[today + 2 * 86400] = { [gpv]: allYes() };
  await view('groups-template.html', fixture, async page => {
    assert.match(await page.locator('h1').textContent(), /31 жовтня/);
    assert.match(await page.locator('.schedule-missing').textContent(), /31 жовтня/);
    assert.equal(await page.locator('tbody td').count(), 0);
  }, 'tomorrow');
  await view('emergency-template.html', fixture, async page => {
    assert.equal(await page.locator('#today tbody tr').count(), 1);
    assert.equal(await page.locator('#today tbody tr th').first().textContent(), '30 жовтня');
  });
});

test('tomorrow follows Kyiv calendar across DST and year boundaries', async t => {
  for (const [from, to, label] of [
    ['2026-03-29T00:00:00+02:00', '2026-03-30T00:00:00+03:00', '30 березня'],
    ['2026-10-25T00:00:00+03:00', '2026-10-26T00:00:00+02:00', '26 жовтня'],
    ['2026-12-31T00:00:00+02:00', '2027-01-01T00:00:00+02:00', '1 січня'],
  ]) {
    await t.test(from, async () => {
      const epoch = Date.parse(from) / 1000;
      const next = Date.parse(to) / 1000;
      const fixture = { ...incident, fact: { ...incident.fact, today: epoch, data: { [next]: { [gpv]: allYes() } } } };
      await view('groups-template.html', fixture, async page => {
        assert.match(await page.locator('h1').textContent(), new RegExp(label));
        assert.equal(await page.locator('td.state-yes').count(), 24);
      }, 'tomorrow');
      await view('emergency-template.html', fixture, async page => {
        assert.equal(await page.locator('#today tbody tr').count(), 2);
        assert.equal(await page.locator('#today tbody tr:last-child th').textContent(), label);
      });
    });
  }
});

test('full and week templates report completed rendering', async () => {
  for (const template of ['full-template.html', 'week-template.html']) {
    await view(template, incident, async page => {
      assert.equal(await page.locator('#matrix[data-schedule-ready="true"]').count(), 1);
    });
  }
});

test('PNG renderer accepts explicit empty states and rejects uninitialized summary markup', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'outage-render-'));
  try {
    for (const template of ['emergency-template.html', 'full-template.html', 'groups-template.html', 'summary-item.html']) {
      const outPath = path.join(dir, template + '.png');
      const size = await renderPage({ browser, baseURL, projectRoot: root, htmlPath: path.join(root, 'templates/html', template),
        jsonPath: path.join(root, 'tests/fixtures/kyiv-midnight.json'), gpvKey: gpv, outPath, theme: 'light', deviceScaleFactor: 1 });
      assert.ok(size.width > 0 && size.height > 0);
      assert.ok((await stat(outPath)).size > 0);
    }
    const invalidPath = path.join(dir, 'invalid.json');
    await writeFile(invalidPath, JSON.stringify({ ...incident, preset: null }));
    await assert.rejects(renderPage({ browser, baseURL, projectRoot: root,
      htmlPath: path.join(root, 'templates/html/summary-item.html'), jsonPath: invalidPath,
      gpvKey: gpv, outPath: path.join(dir, 'invalid.png'), theme: 'light', deviceScaleFactor: 1, timeoutMs: 200 }), /Timeout/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

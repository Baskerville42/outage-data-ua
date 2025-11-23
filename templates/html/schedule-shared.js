/* Shared JS logic for schedule templates (full, emergency, week, groups)
 * Exposes global: window.Schedule.scheduleInit(options)
 * Options: { mode: 'full' | 'emergency' | 'week' | 'groups' | 'summary' | 'auto' }
 * Behavior keeps parity with previous inline scripts in all templates.
 */
(function () {
  'use strict';

  function initThemeFromQuery() {
    try {
      const qs = new URLSearchParams(location.search);
      if (qs.get('theme') === 'dark') document.body.classList.add('theme-dark');
    } catch (_) { }
  }

  function pickGpvKey(data) {
    try {
      const qs = new URLSearchParams(location.search);
      const fromUrl = qs.get('gpv');
      if (fromUrl && data?.preset?.data && data.preset.data[fromUrl]) return fromUrl;
    } catch (e) { }
    if (window.__GPV_KEY__ && data?.preset?.data && data.preset.data[window.__GPV_KEY__]) return window.__GPV_KEY__;
    const keys = Object.keys(data?.preset?.data || {});
    const firstGpv = keys.find(k => /^GPV\d+\.\d+$/.test(k));
    return firstGpv || 'GPV1.2';
  }

  // Map cell state to icon file path
  function stateIconSrc(state) {
    switch (state) {
      case 'no': return 'icons/no.svg';
      case 'maybe': return 'icons/maybe.svg';
      case 'mfirst':
      case 'first': return 'icons/mfirst.svg';
      case 'msecond':
      case 'second': return 'icons/msecond.svg';
      default: return null;
    }
  }

  // For the Today table we use a different pair of icons for half-hour markers
  function stateIconSrcToday(state) {
    if (state === 'mfirst' || state === 'first') return 'icons/nfirst.svg';
    if (state === 'msecond' || state === 'second') return 'icons/nsecond.svg';
    return stateIconSrc(state);
  }

  // ===== Helpers for mapping update timestamps to time slot columns =====
  function parseTimeLabelStartMinutes(label) {
    if (!label) return NaN;
    const s = String(label).trim();
    let m = s.match(/^([0-9]{1,2}):([0-9]{2})$/);
    if (m) {
      const hh = Math.min(24, Math.max(0, Number(m[1])));
      const mm = Math.min(59, Math.max(0, Number(m[2])));
      return (hh * 60) + mm;
    }
    m = s.match(/^([0-9]{1,2})\s*-\s*([0-9]{1,2})$/);
    if (m) {
      const hh = Math.min(24, Math.max(0, Number(m[1])));
      return hh * 60;
    }
    m = s.match(/^([0-9]{1,2})$/);
    if (m) {
      const hh = Math.min(24, Math.max(0, Number(m[1])));
      return hh * 60;
    }
    return NaN;
  }

  function buildStartsMinutesFromPreset(preset) {
    const tzKeys = Object.keys(preset?.time_zone || {}).map(Number).sort((a, b) => a - b);
    const labels = tzKeys.map(k => preset.time_zone[String(k)]?.[0] || '');
    const starts = labels.map(parseTimeLabelStartMinutes);
    return { tzKeys, starts };
  }

  function parseUpdateToMinutes(str) {
    if (!str || typeof str !== 'string') return NaN;
    // Expected like "DD.MM.YYYY HH:mm" or "DD.MM HH:mm" (rare). We only need time of day.
    const m = str.match(/(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?\s+(\d{1,2}):(\d{2})/);
    if (!m) return NaN;
    const hh = Math.min(24, Math.max(0, Number(m[4])));
    const mi = Math.min(59, Math.max(0, Number(m[5])));
    return hh * 60 + mi;
  }

  // Parse "DD.MM[.YYYY] HH:mm" and return comparable tuple { y, m, d, hh, mi }
  function parseUpdateToParts(str) {
    if (!str || typeof str !== 'string') return null;
    const m = str.trim().match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?\s+(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const dd = Math.min(31, Math.max(1, Number(m[1])));
    const mm = Math.min(12, Math.max(1, Number(m[2])));
    let yyyy = m[3] ? Number(m[3]) : NaN;
    if (!Number.isFinite(yyyy)) {
      try {
        // Current year in Europe/Kyiv
        const now = new Date();
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric' }).formatToParts(now);
        yyyy = Number(parts.find(p => p.type === 'year')?.value) || now.getFullYear();
      } catch (_) { yyyy = new Date().getFullYear(); }
    }
    const hh = Math.min(23, Math.max(0, Number(m[4])));
    const mi = Math.min(59, Math.max(0, Number(m[5])));
    return { y: yyyy, m: mm, d: dd, hh, mi };
  }

  function compareUpdateParts(a, b) {
    if (!a && !b) return 0; if (!a) return -1; if (!b) return 1;
    if (a.y !== b.y) return a.y - b.y;
    if (a.m !== b.m) return a.m - b.m;
    if (a.d !== b.d) return a.d - b.d;
    if (a.hh !== b.hh) return a.hh - b.hh;
    return a.mi - b.mi;
  }

  function mapMinutesToIndex(starts, mins) {
    if (!Array.isArray(starts) || !Number.isFinite(mins)) return -1;
    if (starts.length === 0) return -1;
    // Find the last start <= mins
    let idx = 0;
    for (let i = 0; i < starts.length; i++) {
      if (!Number.isFinite(starts[i])) continue;
      if (starts[i] <= mins) idx = i;
    }
    return idx;
  }

  function highlightColumn(tableId, colIdx, className) {
    if (!Number.isFinite(colIdx) || colIdx < 0) return;
    const table = document.getElementById(tableId);
    if (!table) return;
    const theadRow = table.querySelector('thead tr');
    if (theadRow) {
      const ths = theadRow.querySelectorAll('th');
      const th = ths[1 + colIdx]; // +1 due to row header corner cell
      if (th) th.classList.add(className);
    }
    const rows = table.querySelectorAll('tbody tr');
    rows.forEach(tr => {
      const tds = tr.querySelectorAll('td');
      const td = tds[colIdx];
      if (td) td.classList.add(className);
    });
  }

  async function loadData() {
    if (window.__SCHEDULE__) return window.__SCHEDULE__;
    let regionId = 'kyiv-region';
    try {
      const qs = new URLSearchParams(location.search);
      regionId = qs.get('region') || regionId;
    } catch (e) { }
    const url = `../data/${regionId}.json`;
    try {
      const res = await fetch(url);
      return await res.json();
    } catch (e) {
      const meta = document.getElementById('meta');
      if (meta) meta.textContent = 'Не вдалося завантажити дані (' + url + '). Запустіть локальний сервер (наприклад: npx serve або python3 -m http.server) з кореня проєкту.';
      throw e;
    }
  }

  function formatLastUpdated(data) {
    // Choose timestamp for "last updated" from either preset.updateFact or fact.update (or preset.update fallback).
    // If both exist, pick the later one by date/time (Europe/Kyiv). Otherwise return whichever is present.
    const factUpd = (data?.fact?.update || '').trim();
    const presetUpd = (data?.preset?.updateFact || data?.preset?.update || '').trim();
    const hasFact = !!factUpd;
    const hasPreset = !!presetUpd;
    if (hasFact && hasPreset) {
      const a = parseUpdateToParts(factUpd);
      const b = parseUpdateToParts(presetUpd);
      if (a && b) {
        // compareUpdateParts returns negative if a < b
        return compareUpdateParts(a, b) >= 0 ? factUpd : presetUpd;
      }
      // If parsing failed for one of them, return the one that parses, else prefer fact
      if (a && !b) return factUpd;
      if (!a && b) return presetUpd;
      return factUpd; // both unparsed: prefer fact by convention
    }
    if (hasFact) return factUpd;
    if (hasPreset) return presetUpd;
    return '';
  }

  function injectLastUpdatedIfPresent(data) {
    const el = document.getElementById('lastUpdated');
    if (!el) return;
    // Requirement: show date/time from fact.update if present
    const preferFact = (data?.fact?.update || '').trim();
    const label = preferFact || formatLastUpdated(data);
    if (label) el.textContent = 'Дата та час останнього оновлення інформації на графіку: ' + label;
  }

  function injectMetaIfPresent(data) {
    const meta = document.getElementById('meta');
    if (!meta) return;
    const hash = data.meta && data.meta.contentHash;
    if (hash) {
      meta.textContent = 'contentHash: ' + hash;
    } else if (data.fact && data.fact.update) {
      meta.textContent = 'Оновлено: ' + data.fact.update;
    }
  }

  function injectGroupBadgeIfPresent(data, gpvKey) {
    try {
      const h1 = document.querySelector('.container > h1');
      if (h1) {
        const names = data?.preset?.sch_names || {};
        let label = names[gpvKey] || '';
        if (label) {
          label = label.replace(/^Черга\b\s*/, 'Черга: ');
        } else if (gpvKey) {
          const m = String(gpvKey).match(/^GPV(\d+)\.(\d+)$/);
          if (m) label = `Черга: ${m[1]}.${m[2]}`;
        }
        if (label) {
          let badge = h1.querySelector('.group-badge');
          if (!badge) {
            badge = document.createElement('span');
            badge.className = 'group-badge';
            h1.appendChild(badge);
          }
          badge.textContent = label;
        }
      }
    } catch (_) { }
  }

  function computeTodayWeekdayIdx(data) {
    let todayIdx = null;
    try {
      const epoch = data?.fact?.today;
      if (epoch != null) {
        const baseDate = new Date(Number(epoch) * 1000);
        const w = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', weekday: 'short' }).format(baseDate);
        const map = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
        todayIdx = map[w] || null;
      }
    } catch (_) { }
    return todayIdx;
  }

  function buildWeek(preset, gpvKey, todayWeekdayIdx) {
    const table = document.getElementById('matrix');
    if (!table) return;
    table.innerHTML = '';

    const tzKeys = Object.keys(preset.time_zone).map(Number).sort((a, b) => a - b);
    const times = tzKeys.map(k => preset.time_zone[String(k)][0]);

    const dayKeys = Object.keys(preset.days).map(Number).sort((a, b) => a - b);

    const thead = document.createElement('thead');
    const hr = document.createElement('tr');

    const corner = document.createElement('th');
    corner.innerHTML = 'Часові<br>проміжки';
    hr.appendChild(corner);

    for (const t of times) {
      const th = document.createElement('th');
      const div = document.createElement('div');
      div.className = 'vlabel';
      div.textContent = t;
      th.appendChild(div);
      hr.appendChild(th);
    }
    thead.appendChild(hr);

    const tbody = document.createElement('tbody');
    const schedule = preset.data && preset.data[gpvKey];

    if (!schedule) {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.textContent = 'Помилка: відсутні дані для ' + gpvKey;
      th.colSpan = 1 + tzKeys.length;
      tr.appendChild(th);
      tbody.appendChild(tr);
      table.appendChild(thead);
      table.appendChild(tbody);
      return;
    }

    dayKeys.forEach(dk => {
      const dayName = preset.days[String(dk)];
      const tr = document.createElement('tr');
      if (todayWeekdayIdx && Number(dk) === Number(todayWeekdayIdx)) {
        tr.classList.add('is-today');
      }
      const th = document.createElement('th');
      th.textContent = dayName; tr.appendChild(th);

      tzKeys.forEach(hk => {
        const td = document.createElement('td');
        const value = schedule?.[String(dk)]?.[String(hk)];
        if (value) {
          td.classList.add('state-' + value);
          const timeLabel = preset.time_zone[String(hk)]?.[0] || '';
          const desc = preset.time_type?.[value] || value;
          td.title = dayName + ' ' + timeLabel + ' — ' + desc;
          const iconSrc = stateIconSrc(value);
          if (iconSrc) {
            const img = document.createElement('img');
            img.className = 'cell-icon';
            img.src = iconSrc;
            img.width = 20; img.height = 20; img.alt = ''; img.setAttribute('aria-hidden', 'true'); img.decoding = 'async';
            td.appendChild(img);
          }
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });

    table.appendChild(thead);
    table.appendChild(tbody);

    // Return tzKeys for highlighting
    return { tzKeys, times };
  }

  function buildToday(preset, fact, gpvKey) {
    const table = document.getElementById('today');
    if (!table) return;
    table.innerHTML = '';

    const tzKeys = Object.keys(preset.time_zone).map(Number).sort((a, b) => a - b);

    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    const corner = document.createElement('th');
    corner.innerHTML = 'Часові<br>проміжки';
    hr.appendChild(corner);
    for (const hk of tzKeys) {
      const th = document.createElement('th');
      const div = document.createElement('div');
      div.className = 'vlabel';
      div.textContent = preset.time_zone[String(hk)]?.[0] || '';
      th.appendChild(div);
      hr.appendChild(th);
    }
    thead.appendChild(hr);

    function renderRow(label, dayEpoch) {
      const tr = document.createElement('tr');
      const rowTh = document.createElement('th');
      rowTh.textContent = label;
      tr.appendChild(rowTh);

      const dayObj = fact && fact.data && (dayEpoch != null) && fact.data[String(dayEpoch)];
      const schedule = dayObj && (dayObj[gpvKey]);

      tzKeys.forEach(hk => {
        const td = document.createElement('td');
        const raw = schedule?.[String(hk)];
        if (raw) td.classList.add('state-' + raw);
        const timeLabel = preset.time_zone[String(hk)]?.[0] || '';
        const desc = raw ? (preset.time_type?.[raw] || raw) : '';
        if (desc) td.title = label + ' ' + timeLabel + ' — ' + desc;
        const iconSrc = raw ? stateIconSrcToday(raw) : null;
        if (iconSrc) {
          const img = document.createElement('img');
          img.className = 'cell-icon';
          img.src = iconSrc;
          img.width = 20; img.height = 20; img.alt = ''; img.setAttribute('aria-hidden', 'true'); img.decoding = 'async';
          td.appendChild(img);
        }
        tr.appendChild(td);
      });
      return tr;
    }

    const tbody = document.createElement('tbody');

    // Format epoch seconds (00:00 of a day) to 'D місяця' in Ukrainian, Europe/Kyiv timezone
    function formatUkDate(epochSec) {
      try {
        const d = new Date(Number(epochSec) * 1000);
        return new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: 'numeric', month: 'long' }).format(d);
      } catch (_) { return ''; }
    }

    const todayEpoch = (fact && fact.today != null) ? Number(fact.today) : null;
    if (todayEpoch != null) {
      const todayLabel = formatUkDate(todayEpoch) || 'Сьогодні';
      tbody.appendChild(renderRow(todayLabel, todayEpoch));
    }

    let tomorrowEpoch = null;
    try {
      const keys = Object.keys(fact?.data || {}).map(Number).filter(n => !Number.isNaN(n));
      if (keys.length) {
        const greater = keys.filter(k => todayEpoch != null ? k > todayEpoch : true).sort((a, b) => a - b);
        tomorrowEpoch = greater[0] ?? keys.find(k => k !== todayEpoch) ?? null;
      }
    } catch (_) { }

    if (tomorrowEpoch != null && tomorrowEpoch !== todayEpoch) {
      const label = formatUkDate(tomorrowEpoch) || 'Завтра';
      tbody.appendChild(renderRow(label, tomorrowEpoch));
    }

    table.appendChild(thead);
    table.appendChild(tbody);

    // Return tzKeys for highlighting
    return { tzKeys };
  }

  // Build matrix with rows = GPV groups available for target epoch (default today) and columns = time slots
  function buildGroups(preset, fact, targetEpoch) {
    const table = document.getElementById('matrix');
    if (!table) return;
    table.innerHTML = '';

    const tzKeys = Object.keys(preset.time_zone).map(Number).sort((a, b) => a - b);
    const times = tzKeys.map(k => preset.time_zone[String(k)]?.[0] || '');

    // Determine target epoch and the set of groups present
    const epochStr = (targetEpoch != null) ? String(targetEpoch) : ((fact && fact.today != null) ? String(fact.today) : null);
    const dayObj = (epochStr && fact && fact.data) ? fact.data[epochStr] : null;
    const gpvKeys = dayObj ? Object.keys(dayObj).filter(k => /^GPV\d+\.\d+$/.test(k)).sort((a, b) => {
      const pa = a.match(/\d+|\.|/g)?.join('') || '';
      const pb = b.match(/\d+|\.|/g)?.join('') || '';
      return pa.localeCompare(pb, 'en', { numeric: true });
    }) : [];

    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    const corner = document.createElement('th');
    corner.className = 'corner-split';
    corner.innerHTML = '<span class="corner-top">Час</span><span class="corner-bottom">Черга</span>';
    hr.appendChild(corner);
    for (const t of times) {
      const th = document.createElement('th');
      const div = document.createElement('div');
      div.className = 'vlabel';
      div.textContent = t;
      th.appendChild(div);
      hr.appendChild(th);
    }
    thead.appendChild(hr);

    const tbody = document.createElement('tbody');

    if (!gpvKeys.length) {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.textContent = 'Помилка: відсутні дані на ' + (targetEpoch ? 'обрану дату' : 'сьогодні');
      th.colSpan = 1 + tzKeys.length;
      tr.appendChild(th);
      tbody.appendChild(tr);
      table.appendChild(thead);
      table.appendChild(tbody);
      return;
    }

    const names = preset?.sch_names || {};

    for (const gpvKey of gpvKeys) {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.textContent = names[gpvKey] || gpvKey.replace(/^GPV/, 'Черга ');
      tr.appendChild(th);

      tzKeys.forEach(hk => {
        const td = document.createElement('td');
        const raw = dayObj?.[gpvKey]?.[String(hk)];
        if (raw) td.classList.add('state-' + raw);
        const timeLabel = preset.time_zone[String(hk)]?.[0] || '';
        const desc = raw ? (preset.time_type?.[raw] || raw) : '';
        if (desc) td.title = (names[gpvKey] || gpvKey) + ' ' + timeLabel + ' — ' + desc;
        // For groups template, use the 'nfirst/nsecond' icons like in the Today table
        const iconSrc = raw ? stateIconSrcToday(raw) : null;
        if (iconSrc) {
          const img = document.createElement('img');
          img.className = 'cell-icon';
          img.src = iconSrc;
          img.width = 20; img.height = 20; img.alt = ''; img.setAttribute('aria-hidden', 'true'); img.decoding = 'async';
          td.appendChild(img);
        }
        tr.appendChild(td);
      });

      tbody.appendChild(tr);
    }

    table.appendChild(thead);
    table.appendChild(tbody);

    return { tzKeys, times };
  }

  function extractGroupNumber(gpvKey, names) {
    // Return string like "1.2" from GPV1.2 or from the sch_names label
    if (gpvKey) {
      const m = String(gpvKey).match(/^GPV(\d+)\.(\d+)$/);
      if (m) return `${m[1]}.${m[2]}`;
    }
    const label = names && gpvKey ? names[gpvKey] : '';
    if (label) {
      const mm = label.match(/(\d+)\.(\d+)/);
      if (mm) return `${mm[1]}.${mm[2]}`;
    }
    return '';
  }

  function buildSummary(preset, fact, gpvKey) {
    // Elements expected in summary template
    const badge = document.querySelector('.group-badge-left');
    const note = document.querySelector('.summary-status');
    const dateEl = document.querySelector('.summary-date');
    const list = document.querySelector('.summary-intervals');
    const statusBadge = document.querySelector('.status-badge');
    if (!note || !list) return;

    // Replace the static label "Черга" in the summary title with regionAffiliation from JSON
    try {
      const titleEl = document.querySelector('.summary-title');
      if (titleEl) {
        const dataAll = (typeof window !== 'undefined') ? (window.__SCHEDULE__ || null) : null;
        const aff = (dataAll && typeof dataAll.regionAffiliation === 'string') ? dataAll.regionAffiliation.trim() : '';
        if (aff) {
          // Remove any existing text nodes (including the original "Черга")
          const toRemove = [];
          titleEl.childNodes.forEach(n => { if (n.nodeType === Node.TEXT_NODE) toRemove.push(n); });
          toRemove.forEach(n => titleEl.removeChild(n));

          // Insert a single text node with a leading space right after the badge (if present)
          const badgeEl = titleEl.querySelector('.group-badge-left');
          const textNode = document.createTextNode(' ' + aff);
          if (badgeEl && badgeEl.nextSibling) {
            titleEl.insertBefore(textNode, badgeEl.nextSibling);
          } else if (badgeEl) {
            // No nextSibling: append after badge
            titleEl.appendChild(textNode);
          } else {
            // No badge for some reason — append at the end
            titleEl.appendChild(textNode);
          }
        }
      }
    } catch (_) { }

    // Build today OFF intervals (strict OFF = state 'no', plus half-hour first/second)
    const todayEpoch = (fact && fact.today != null) ? Number(fact.today) : null;
    const dayObj = (todayEpoch != null) ? (fact && fact.data && fact.data[String(todayEpoch)]) : null;
    const schedule = dayObj && (dayObj[gpvKey]);

    // Inject date line with full Ukrainian date like "8 листопада,"
    if (dateEl && Number.isFinite(todayEpoch)) {
      try {
        const d = new Date(todayEpoch * 1000);
        const longDate = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: 'numeric', month: 'long' }).format(d);
        if (longDate) dateEl.textContent = `${longDate},`;
      } catch (_) { }
    }

    const tzKeys = Object.keys(preset.time_zone || {}).map(Number).sort((a, b) => a - b);
    const labels = tzKeys.map(k => preset.time_zone[String(k)]?.[0] || '');

    // Parse time label to start minutes (00:00 = 0)
    function parseStartMinutes(label) {
      if (!label) return NaN;
      const s = String(label).trim();
      // 1) HH:MM or H:MM
      let m = s.match(/^([0-9]{1,2}):([0-9]{2})$/);
      if (m) {
        const hh = Math.min(24, Math.max(0, Number(m[1])));
        const mm = Math.min(59, Math.max(0, Number(m[2])));
        return (hh * 60) + mm;
      }
      // 2) "H-H+1" or "HH-HH" — take the first hour as start
      m = s.match(/^([0-9]{1,2})\s*-\s*([0-9]{1,2})$/);
      if (m) {
        const hh = Math.min(24, Math.max(0, Number(m[1])));
        return hh * 60;
      }
      // 3) plain hour "H" or "HH"
      m = s.match(/^([0-9]{1,2})$/);
      if (m) {
        const hh = Math.min(24, Math.max(0, Number(m[1])));
        return hh * 60;
      }
      return NaN;
    }
    const startsMin = labels.map(parseStartMinutes);

    // Build 30/60-minute aware OFF chunks and merge into intervals
    const intervals = [];
    let allYes = false;
    if (schedule) {
      const chunks = []; // array of [startMin, endMin] in minutes from 00:00
      const getState = (idx) => schedule[String(tzKeys[idx])] || '';
      let yesOnly = true;
      for (let i = 0; i < tzKeys.length; i++) {
        const s = startsMin[i];
        const e = (i + 1 < tzKeys.length) ? startsMin[i + 1] : 24 * 60;
        if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
        const st = getState(i);
        if (st === 'no') {
          chunks.push([s, e]);
          yesOnly = false;
        } else if (st === 'first' || st === 'mfirst') {
          const mid = Math.min(s + 30, e);
          if (mid > s) chunks.push([s, mid]);
          yesOnly = false;
        } else if (st === 'second' || st === 'msecond') {
          const mid = Math.min(s + 30, e);
          if (e > mid) chunks.push([mid, e]);
          yesOnly = false;
        } else if (st === 'maybe') {
          yesOnly = false; // not strictly yes
        } else if (st === 'yes') {
          // keep yesOnly true
        } else {
          // unknown -> not strictly yes
          yesOnly = false;
        }
      }

      // Merge contiguous/overlapping chunks into consolidated intervals
      if (chunks.length) {
        chunks.sort((a, b) => a[0] - b[0]);
        let cur = chunks[0].slice();
        for (let i = 1; i < chunks.length; i++) {
          const [cs, ce] = chunks[i];
          if (cs <= cur[1]) {
            // overlap or touching -> extend
            cur[1] = Math.max(cur[1], ce);
          } else {
            intervals.push(cur);
            cur = [cs, ce];
          }
        }
        intervals.push(cur);
      }
      allYes = yesOnly;
    }

    // Render
    list.innerHTML = '';
    const pad = (n) => String(n).padStart(2, '0');
    const fmt = (mins) => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;

    if (intervals.length === 0 && allYes) {
      // All YES for today: ON all day
      note.textContent = 'світло буде весь день';
      if (statusBadge) {
        statusBadge.textContent = 'ON';
        statusBadge.className = 'badge-on status-badge';
      }
      // No intervals/placeholder needed when ON all day
    } else if (intervals.length === 0) {
      // No OFF chunks but not all strictly yes (missing data or maybe values)
      note.textContent = 'Відключень за даними графіка не очікується';
      if (statusBadge) {
        statusBadge.textContent = 'OFF';
        statusBadge.className = 'legend-box state-no badge-off status-badge';
      }
      const div = document.createElement('div');
      div.textContent = '—';
      list.appendChild(div);
    } else {
      // There are OFF intervals
      note.textContent = 'світло буде відсутнє';
      if (statusBadge) {
        statusBadge.textContent = 'OFF';
        statusBadge.className = 'legend-box state-no badge-off status-badge';
      }
      for (const [s, e] of intervals) {
        const row = document.createElement('div');
        row.textContent = `з ${fmt(s)} до ${fmt(e)}`;
        list.appendChild(row);
      }
    }

    // Badge number only (e.g., 1.2)
    if (badge) {
      const num = extractGroupNumber(gpvKey, preset?.sch_names || {});
      if (num) badge.textContent = num;
    }
  }

  function applyUpdateHighlights(preset, data) {
    const { tzKeys, starts } = buildStartsMinutesFromPreset(preset);
    if (!tzKeys || !tzKeys.length) return;
    const factMins = parseUpdateToMinutes(data?.fact?.update || data?.fact?.updateFact || '');
    const presetMins = parseUpdateToMinutes(data?.preset?.updateFact || data?.preset?.update || '');
    const factIdx = Number.isFinite(factMins) ? mapMinutesToIndex(starts, factMins) : -1;
    const presetIdx = Number.isFinite(presetMins) ? mapMinutesToIndex(starts, presetMins) : -1;
    // Apply to today table (if exists)
    if (document.getElementById('today')) {
      if (factIdx >= 0) highlightColumn('today', factIdx, 'col-update');
      if (presetIdx >= 0) highlightColumn('today', presetIdx, 'col-update');
    }
    // Apply to weekly matrix (if exists)
    if (document.getElementById('matrix')) {
      if (factIdx >= 0) highlightColumn('matrix', factIdx, 'col-update');
      if (presetIdx >= 0) highlightColumn('matrix', presetIdx, 'col-update');
    }
  }

  function extractDayMonthFromFactUpdate(data) {
    const upd = (data?.fact?.update || '').trim();
    if (!upd) return '';
    const m = upd.match(/^(\d{1,2})\.(\d{1,2})/);
    if (!m) return '';
    const dd = String(m[1]).padStart(2, '0');
    const mm = String(m[2]).padStart(2, '0');
    return `(${dd}.${mm})`;
  }

  // ===== Region affiliation injection helpers =====
  function getRegionAffiliation(data) {
    const aff = (data && typeof data.regionAffiliation === 'string') ? data.regionAffiliation.trim() : '';
    return aff;
  }

  function h1TextNode(el) {
    if (!el) return null;
    // Prefer the first text node
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) return n;
    }
    return el.firstChild || null;
  }

  function insertAffilBeforeColon(el, affil) {
    const tn = h1TextNode(el);
    if (!tn) return;
    const txt = tn.nodeValue || '';
    const marker = `(${affil})`;
    if (!affil || !txt || txt.includes(marker)) return;
    const idx = txt.indexOf(':');
    if (idx === -1) {
      // no colon — append at the end with a space
      tn.nodeValue = `${txt} ${marker}`.trim();
    } else {
      tn.nodeValue = `${txt.slice(0, idx).trim()} ${marker}${txt.slice(idx)}`;
    }
  }

  function appendAffilAtEnd(el, affil) {
    const tn = h1TextNode(el);
    if (!tn) return;
    const txt = tn.nodeValue || '';
    const marker = `(${affil})`;
    if (!affil || !txt || txt.includes(marker)) return;
    // Ensure a space before
    tn.nodeValue = `${txt.trim()} ${marker}`;
  }

  async function scheduleInit(options) {
    const mode = (options && options.mode) || 'auto';
    const dayOption = (options && options.day) || 'today'; // 'today' or 'tomorrow'
    initThemeFromQuery();

    let data;
    try {
      data = await loadData();
    } catch (e) {
      // data failed to load; stop here
      return;
    }

    const gpvKey = pickGpvKey(data);

    // lastUpdated/meta only if such elements exist (full template)
    injectLastUpdatedIfPresent(data);

    // For groups mode: replace word "сьогодні" with full date (e.g., "8 листопада") and remove short (DD.MM)
    if (mode === 'groups') {
      try {
        const todayEpoch = (data && data.fact && data.fact.today != null) ? Number(data.fact.today) : null;
        let targetEpoch = todayEpoch;

        if (dayOption === 'tomorrow') {
          // Find next available day after today
          try {
            const keys = Object.keys(data?.fact?.data || {}).map(Number).filter(n => !Number.isNaN(n));
            if (keys.length) {
              const greater = keys.filter(k => todayEpoch != null ? k > todayEpoch : true).sort((a, b) => a - b);
              const nextDay = greater[0] ?? keys.find(k => k !== todayEpoch) ?? null;
              if (nextDay != null) targetEpoch = nextDay;
            }
          } catch (_) { }
        }

        let longDate = '';
        if (Number.isFinite(targetEpoch)) {
          try {
            const d = new Date(targetEpoch * 1000);
            longDate = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: 'numeric', month: 'long' }).format(d);
          } catch (_) { longDate = ''; }
        }
        if (longDate) {
          // Update document.title: replace '(сьогодні ...)' or '(сьогодні)' with '(D місяця)'
          const cur = document.title || '';
          let next = cur.replace(/\(сьогодні\s*\(\d{2}\.\d{2}\)\)/i, `(${longDate})`)
            .replace(/\(сьогодні\)/i, `(${longDate})`);
          if (next !== cur) {
            document.title = next;
          } else if (!/\([^)]*\)/.test(cur)) {
            // No parentheses at all — append date in parentheses
            document.title = `${cur} (${longDate})`;
          }

          // Update H1: replace 'на сьогодні (DD.MM)' or 'на сьогодні' with 'на D місяця'
          const h1 = document.querySelector('.container > h1');
          if (h1 && h1.firstChild) {
            const text = h1.firstChild.nodeValue || '';
            let updated = text.replace(/на сьогодні\s*\(\d{2}\.\d{2}\)/i, `на ${longDate}`)
              .replace(/на сьогодні/i, `на ${longDate}`);
            // If we are showing tomorrow, we might want to replace "на сьогодні" with "на завтра" or just the date.
            // The regex above handles "на сьогодні" -> "на D місяця".
            // If the text was "Графік відключень на сьогодні ...", it becomes "Графік відключень на D місяця ...".
            if (updated !== text) {
              h1.firstChild.nodeValue = updated;
            }
          }
        }
      } catch (_) { }
    }

    // Inject region affiliation into H1 per template requirements
    try {
      const aff = getRegionAffiliation(data);
      if (aff) {
        const h1 = document.querySelector('.container > h1');
        if (h1) {
          if (mode === 'groups') {
            // groups-template.html — after "всіх групах" (append at the end)
            appendAffilAtEnd(h1, aff);
          } else if (mode === 'emergency') {
            // emergency-template.html — before ':'
            insertAffilBeforeColon(h1, aff);
          } else if (mode === 'full') {
            // full-template.html — first H1 "Графік відключень:" before ':'
            insertAffilBeforeColon(h1, aff);
          } else if (mode === 'week') {
            // week-template.html — H1 "Графік відключень на тиждень:" before ':'
            insertAffilBeforeColon(h1, aff);
          }
        }
      }
    } catch (_) { }

    // For summary/groups modes, do not auto-inject the default badge (we show all groups or custom badge)
    const suppressBadge = (mode === 'summary' || mode === 'groups');
    if (!suppressBadge) {
      // badge is shown in all templates where an H1 exists
      injectGroupBadgeIfPresent(data, gpvKey);
    }

    const hasToday = !!document.getElementById('today');
    const hasMatrix = !!document.getElementById('matrix');

    if (mode === 'full' || (mode === 'auto' && hasToday && hasMatrix)) {
      buildToday(data.preset, data.fact, gpvKey);
      const idx = computeTodayWeekdayIdx(data);
      buildWeek(data.preset, gpvKey, idx);
      injectMetaIfPresent(data);
      return;
    }

    if ((mode === 'emergency' || mode === 'auto') && hasToday) {
      buildToday(data.preset, data.fact, gpvKey);
      // also inject meta hash if element exists
      injectMetaIfPresent(data);
    }

    if ((mode === 'week' || mode === 'auto') && hasMatrix) {
      const idx = computeTodayWeekdayIdx(data);
      buildWeek(data.preset, gpvKey, idx);
      // also inject meta hash if element exists
      injectMetaIfPresent(data);
    }

    if ((mode === 'groups' || mode === 'auto') && hasMatrix) {
      // Pass the determined targetEpoch (if we are in groups mode and calculated it)
      // If mode is auto, we default to today (which is what targetEpoch is init to if not 'tomorrow')
      // But we need to make sure we calculated targetEpoch above.
      // The block above runs `if (mode === 'groups')`.
      // Let's recalculate targetEpoch if needed or scope it better.
      // For safety, let's just re-derive if not set, or move the logic up.
      // Actually, let's just duplicate the simple logic here or assume 'today' if not 'groups' mode.

      let effectiveEpoch = (data && data.fact && data.fact.today != null) ? Number(data.fact.today) : null;
      if (mode === 'groups' && dayOption === 'tomorrow') {
        // Re-find next available day
        try {
          const keys = Object.keys(data?.fact?.data || {}).map(Number).filter(n => !Number.isNaN(n));
          const t = (data && data.fact && data.fact.today != null) ? Number(data.fact.today) : null;
          if (keys.length) {
            const greater = keys.filter(k => t != null ? k > t : true).sort((a, b) => a - b);
            const nextDay = greater[0] ?? keys.find(k => k !== t) ?? null;
            if (nextDay != null) effectiveEpoch = nextDay;
          }
        } catch (_) { }
      }

      buildGroups(data.preset, data.fact, effectiveEpoch);
      injectMetaIfPresent(data);
      return;
    }

    if (mode === 'summary' || (mode === 'auto' && document.querySelector('.summary-card'))) {
      buildSummary(data.preset, data.fact, gpvKey);
      // inject meta hash for summary template if present
      injectMetaIfPresent(data);
    }
  }

  // Export
  window.Schedule = {
    scheduleInit,
    // exposing helpers for potential debugging
    _pickGpvKey: pickGpvKey,
    _computeTodayIdx: computeTodayWeekdayIdx
  };
})();

#!/usr/bin/env node
/**
 * Extracts `DisconSchedule.fact = {...}` and `DisconSchedule.preset = {...}` from an HTML file
 * and writes them verbatim to data/<region>.json with top-level `fact` and `preset` fields.
 *
 * Usage:
 *   node scripts/parse_fact.js --region <id> --in outputs/<region>.html --out data/<region>.json [--pretty]
 *
 * Notes:
 * - The script is defensive: it never overwrites the output with invalid/empty data.
 * - It attempts JSON.parse first; if that fails (JS literal), it falls back to a safe eval via Function().
 * - Output schema is defined by templates/json/data.json. Meta is minimal per requirements.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--region') args.region = argv[++i];
    else if (a === '--in') args.input = argv[++i];
    else if (a === '--out') args.output = argv[++i];
    else if (a === '--upstream') args.upstream = argv[++i];
    else if (a === '--pretty') args.pretty = true;
  }
  return args;
}

function readFile(file) {
  return fs.readFileSync(file, 'utf8');
}

function writeFileAtomic(file, content) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function isoNow() {
  return new Date().toISOString();
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function extractDisconObject(html, key) {
  const marker = `DisconSchedule.${key} =`;
  const idx = html.indexOf(marker);
  if (idx === -1) {
    return { error: `Marker \`DisconSchedule.${key} =\` not found` };
  }
  let i = idx + marker.length;
  // Skip whitespace
  while (i < html.length && /\s/.test(html[i])) i++;
  const opener = html[i];
  if (opener !== '{' && opener !== '[') {
    return { error: `Expected '{' or '[' after \`DisconSchedule.${key} =\`` };
  }
  // Extract balanced braces/brackets, counting both types
  let depthCurly = 0;
  let depthSquare = 0;
  let start = i;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (ch === '{') depthCurly++;
    else if (ch === '}') depthCurly--;
    else if (ch === '[') depthSquare++;
    else if (ch === ']') depthSquare--;
    if (depthCurly === 0 && depthSquare === 0) {
      const jsonLike = html.slice(start, i + 1);
      return { jsonLike, startIndex: start, endIndex: i + 1 };
    }
  }
  return { error: `Unbalanced braces while extracting ${key} object` };
}

function tryParseObject(text) {
  // First, try strict JSON
  try {
    return { value: JSON.parse(text), method: 'json' };
  } catch (_) {}
  // Fallback: attempt to evaluate as JS object literal safely.
  try {
    // Wrap in parentheses to form an expression
    const val = Function('"use strict"; return (' + text + ');')();
    return { value: val, method: 'eval' };
  } catch (e) {
    return { error: 'Failed to parse object: ' + e.message };
  }
}

function loadExisting(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function loadTemplateBase(regionId) {
  let template = null;
  try {
    const tplPath = path.join(__dirname, '..', 'templates', 'json', 'data.json');
    template = JSON.parse(fs.readFileSync(tplPath, 'utf8'));
  } catch (_) {
    // Fallback minimal template if _template.json is unavailable
    template = {
      regionId: regionId || null,
      regionAffiliation: null,
      lastUpdated: null,
      fact: null,
      preset: null,
      lastUpdateStatus: { status: 'idle', ok: true, code: null, message: null, at: null, attempt: 0 },
      meta: {
        schemaVersion: '1.0.0',
        contentHash: null
      }
    };
  }
  // Apply regionId if provided
  template.regionId = regionId || template.regionId || null;
  return template;
}

function updateStatusOnError(existingObj, regionId, _upstream, code, message) {
  const now = isoNow();
  const base = existingObj || loadTemplateBase(regionId);
  // preserve fact/preset and lastUpdated as-is; only update status/meta fields
  const prevAttempt = (base.lastUpdateStatus && typeof base.lastUpdateStatus.attempt === 'number') ? base.lastUpdateStatus.attempt : 0;
  base.lastUpdateStatus = {
    status: 'error',
    ok: false,
    code: code,
    message: message,
    at: now,
    attempt: prevAttempt + 1,
  };
  // meta remains minimal per new schema
  if (base.meta && typeof base.meta === 'object') {
    base.meta.schemaVersion = base.meta.schemaVersion || '1.0.0';
  }
  return base;
}

function isObject(x) { return x && typeof x === 'object' && !Array.isArray(x); }

function logFactSummary(regionId, fact) {
  const data = isObject(fact?.data) ? fact.data : {};
  const dayKeys = Object.keys(data).sort((a, b) => Number(a) - Number(b));
  const groupCounts = Object.fromEntries(dayKeys.map(day => [
    day,
    isObject(data[day]) ? Object.keys(data[day]).filter(key => /^GPV\d+\.\d+$/i.test(key)).length : 0,
  ]));
  const today = fact?.today ?? null;
  const summary = { region: regionId, today, update: fact?.update ?? null, dayKeys, groupCounts };
  console.log(`[INFO] Fact summary ${JSON.stringify(summary)}`);
  if (!groupCounts[String(today)]) {
    console.warn(`[WARN] No fact groups for today ${JSON.stringify(summary)}`);
  }
}

function pad2(n) { return String(n).padStart(2, '0'); }

function tzOffsetMinutes(utcTs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const parts = dtf.formatToParts(new Date(utcTs));
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const asUTC = Date.UTC(parseInt(map.year), parseInt(map.month) - 1, parseInt(map.day), parseInt(map.hour), parseInt(map.minute), parseInt(map.second));
  // Difference between local wall clock expressed as UTC and the actual UTC instant gives offset
  return (asUTC - utcTs) / 60000;
}

function zonedTimeToUtc(dateStr, timeStr, timeZone) {
  const [Y, M, D] = dateStr.split('-').map(Number);
  const [h, m] = timeStr.split(':').map(Number);
  // Initial guess: UTC timestamp with same components
  let ts = Date.UTC(Y, (M || 1) - 1, D || 1, h || 0, m || 0, 0);
  // Compute offset for this instant, then adjust to get the UTC instant corresponding to the given local wall time
  const off = tzOffsetMinutes(ts, timeZone);
  ts = ts - off * 60000;
  return new Date(ts);
}

function formatOffset(totalMinutes) {
  const sign = totalMinutes >= 0 ? '+' : '-';
  const a = Math.abs(totalMinutes);
  const hh = pad2(Math.floor(a / 60));
  const mm = pad2(a % 60);
  return `${sign}${hh}:${mm}`;
}

function toKyivIso(dateStr, timeStr) {
  const tz = 'Europe/Kyiv';
  const utcDate = zonedTimeToUtc(dateStr, timeStr, tz);
  const off = tzOffsetMinutes(utcDate.getTime(), tz);
  const [Y, M, D] = [utcDate.getUTCFullYear(), pad2(utcDate.getUTCMonth() + 1), pad2(utcDate.getUTCDate())];
  const [h, m, s] = [pad2(utcDate.getUTCHours()), pad2(utcDate.getUTCMinutes()), pad2(utcDate.getUTCSeconds())];
  const offsetStr = formatOffset(off);
  return `${Y}-${M}-${D}T${h}:${m}:${s}${offsetStr}`;
}

function extractGroupsWithIso(data) {
  // Keep only keys that look like group identifiers (e.g., GPV1.1, GPV4.1)
  const out = {};
  if (!isObject(data)) return null;
  const keys = Object.keys(data);
  const groupKeyRe = /^[A-ZА-Я]{2,}\d+\.\d+$/i; // broad match
  for (const k of keys) {
    const v = data[k];
    if (!groupKeyRe.test(k)) continue;
    if (!Array.isArray(v)) { out[k] = v; continue; }
    // Try to map entries with date/start/end into ISO tuples
    const items = [];
    for (const entry of v) {
      if (isObject(entry)) {
        const date = entry.date || entry.day || entry.d || null;
        let start = entry.start || entry.from || entry.begin || entry.s || null;
        let end = entry.end || entry.to || entry.finish || entry.e || null;
        const timeRe = /^\d{1,2}:\d{2}$/;
        if (date && start && end && timeRe.test(start) && timeRe.test(end)) {
          // Normalize HH:mm
          if (start.length === 4) start = '0' + start;
          if (end.length === 4) end = '0' + end;
          try {
            const startISO = toKyivIso(String(date), String(start));
            const endISO = toKyivIso(String(date), String(end));
            items.push({ date: String(date), startLocal: startISO, endLocal: endISO });
            continue;
          } catch (_) {}
        }
      }
      // Fallback: keep raw entry if we couldn't normalize
      items.push(entry);
    }
    out[k] = items;
  }
  return Object.keys(out).length ? out : null;
}

function buildOutput(regionId, factObj, presetObj) {
  const now = isoNow();
  return {
    regionId,
    lastUpdated: now,
    fact: factObj,
    preset: presetObj,
    lastUpdateStatus: {
      status: 'parsed',
      ok: true,
      code: 200,
      message: null,
      at: now,
      attempt: 1,
    },
    meta: {
      schemaVersion: '1.0.0',
      contentHash: null,
    },
  };
}

function updateMetaFromExisting(existing, now) {
  if (!existing) return;
  // Preserve fileCreated if present
  if (existing.meta && existing.meta.fileCreated) return existing.meta.fileCreated;
  return now;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.region || !args.input || !args.output) {
    console.error('[ERROR] Usage: --region <id> --in <input.html> --out <output.json> [--upstream <url>] [--pretty]');
    process.exit(2);
  }

  const regionId = args.region;

  if (!fs.existsSync(args.input)) {
    console.error(`[WARN] Input not found: ${args.input}`);
    const existing = loadExisting(args.output);
    const errObj = updateStatusOnError(existing, regionId, null, 404, `Input not found: ${args.input}`);
    const jsonText = args.pretty ? JSON.stringify(errObj, null, 2) : JSON.stringify(errObj);
    writeFileAtomic(args.output, jsonText);
    process.exit(0); // skip gracefully
  }

  const html = readFile(args.input);
  const factExt = extractDisconObject(html, 'fact');
  if (factExt.error) {
    console.error('[WARN] ' + factExt.error + ` in ${args.input}`);
    const existing = loadExisting(args.output);
    const errObj = updateStatusOnError(existing, regionId, null, 422, factExt.error + ` in ${args.input}`);
    const jsonText = args.pretty ? JSON.stringify(errObj, null, 2) : JSON.stringify(errObj);
    writeFileAtomic(args.output, jsonText);
    process.exit(0);
  }

  const presetExt = extractDisconObject(html, 'preset');
  // preset is optional; if missing, we'll leave it null.

  const factParsed = tryParseObject(factExt.jsonLike);
  if (factParsed.error) {
    console.error('[WARN] ' + factParsed.error + ` in ${args.input}`);
    const existing = loadExisting(args.output);
    const errObj = updateStatusOnError(existing, regionId, null, 422, factParsed.error + ` in ${args.input}`);
    const jsonText = args.pretty ? JSON.stringify(errObj, null, 2) : JSON.stringify(errObj);
    writeFileAtomic(args.output, jsonText);
    process.exit(0);
  }

  let presetParsed = null;
  if (!presetExt.error) {
    const pp = tryParseObject(presetExt.jsonLike);
    if (pp.error) {
      console.error('[WARN] ' + pp.error + ` (preset) in ${args.input}`);
      // If preset failed to parse, proceed with null but record error status
      presetParsed = null;
    } else {
      presetParsed = pp.value;
    }
  }

  const now = isoNow();

  let outObj = buildOutput(regionId, factParsed.value, presetParsed);

  // Merge with existing to increment attempts
  const existing = loadExisting(args.output);
  // Preserve regionAffiliation if it exists in the current file
  if (existing && typeof existing.regionAffiliation === 'string' && existing.regionAffiliation.trim()) {
    outObj.regionAffiliation = existing.regionAffiliation.trim();
  } else if (!('regionAffiliation' in outObj)) {
    // Ensure field exists (even if null) to avoid stripping it from schema
    outObj.regionAffiliation = null;
  }
  const prevAttempt = (existing && existing.lastUpdateStatus && typeof existing.lastUpdateStatus.attempt === 'number') ? existing.lastUpdateStatus.attempt : 0;
  outObj.lastUpdateStatus = {
    status: 'parsed',
    ok: true,
    code: 200,
    message: null,
    at: now,
    attempt: prevAttempt + 1,
  };

  // Compute content hash based on the extracted JSON text of fact + preset (if any)
  const hashInput = factExt.jsonLike + '|' + (presetExt.error ? '' : presetExt.jsonLike);
  const hash = sha256(hashInput);
  outObj.meta.contentHash = hash;

  const jsonText = args.pretty ? JSON.stringify(outObj, null, 2) : JSON.stringify(outObj);
  writeFileAtomic(args.output, jsonText);
  logFactSummary(regionId, factParsed.value);
  console.log(`[OK] Parsed ${args.region} → ${args.output} (factMethod=${factParsed.method}${presetParsed ? `, presetMethod=${presetExt.error ? 'n/a' : (tryParseObject.name && 'parsed')}` : ''}, bytes=${jsonText.length})`);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('[WARN] parse_fact crashed: ' + e.message);
    // On crash, also update status in output file if possible
    try {
      const args = parseArgs(process.argv);
      const regionId = args.region;
      const upstream = args.upstream || null;
      const existing = args.output ? loadExisting(args.output) : null;
      const errObj = updateStatusOnError(existing, regionId, upstream, 500, 'parse_fact crashed: ' + e.message);
      if (args.output) {
        const jsonText = args.pretty ? JSON.stringify(errObj, null, 2) : JSON.stringify(errObj);
        writeFileAtomic(args.output, jsonText);
      }
    } catch (_) {}
    process.exit(0);
  }
}

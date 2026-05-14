/**
 * Missed Calls Report - server-side data.
 *
 * Migration of MissedCallsReport.js from the legacy DQE Report Apps Script
 * project. Reads the 19 missed-call time-slot columns (K-AC) and the
 * abandoned-missed-times column (AF) from DQE Historical Data, filtering
 * by the same date + scope rules as the main dashboard.
 *
 * Public entry (callable via google.script.run):
 *   getMissedCallsReport({ department, from, to, scope })
 *
 * Returns:
 *   {
 *     meta: { department, from, to, scope, rosterSize, rowsMatched,
 *             agentCount, totalMissed, generatedAt, cacheHit, computeMs },
 *     agents: [{ name, missedTimes: [{ date, time, label, abandoned }], total }],
 *     chart:  { labels: [..18], counts: [..18] }
 *   }
 *
 * Cached 5 min per (dept, from, to, scope) tuple. Best-effort -- large
 * ranges may exceed CacheService's per-value 100KB limit; if put fails
 * we log and continue.
 *
 * Notes on data shape:
 *   - K-AC columns store comma-separated CST H:MM:SS timestamps already
 *     converted from PST by the source pipeline (buildDQEHistoricalData
 *     .gs). No further timezone math here. (INV-20)
 *   - AF stores the same H:MM:SS strings for the subset of timestamps
 *     that were part of an abandoned call. Cross-referencing K-AC
 *     entries against AF yields the "abandoned" boolean per timestamp.
 *   - Chart range is 8 AM - 5 PM CST (INV-18). The work window itself
 *     is 8:30 AM - 5 PM CST; chart starts earlier so early-morning
 *     rings aren't silently dropped.
 */

const MISSED_CHART_START_HOUR = 8;    // 8:00 AM CST
const MISSED_CHART_END_HOUR   = 17;   // 5:00 PM CST (exclusive)
const MISSED_BUCKET_MINUTES   = 30;   // 30-min buckets -> 18 total

const HISTORICAL_TIME_SLOTS_START = 11;  // K
const HISTORICAL_TIME_SLOTS_END   = 29;  // AC
const HISTORICAL_ABANDONED_MISSED_TIMES = 32;  // AF

function getMissedCallsReport(req) {
  const email = Session.getActiveUser().getEmail();
  const user = resolveUser_(email);
  if (user.role === 'none') {
    throw new Error('Not authorized.');
  }

  const dept = String((req && req.department) || '').trim();
  if (!dept) throw new Error('Department is required.');
  if (user.role === 'manager' && dept !== user.department) {
    throw new Error('Not authorized for this department.');
  }
  if (user.role === 'admin' && getAllDepartments_().indexOf(dept) === -1) {
    throw new Error('Unknown department: ' + dept);
  }

  const from = String((req && req.from) || '').trim();
  const to   = String((req && req.to)   || '').trim();
  if (!isIsoDate_(from) || !isIsoDate_(to)) {
    throw new Error('from/to must be YYYY-MM-DD.');
  }
  if (from > to) throw new Error('from must be on or before to.');

  let scope = String((req && req.scope) || 'roster').trim();
  if (scope !== 'roster' && scope !== 'queue' && scope !== 'both') {
    scope = 'roster';
  }

  const cache = CacheService.getScriptCache();
  // v2: added normalized abandoned matching (handles AM/PM + hour-padding
  // mismatches between K-AC and AF) and meta.abandonedCount diagnostic.
  const cacheKey = 'missed:v2:' + dept + ':' + scope + ':' + from + ':' + to;
  const cached = cache.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      parsed.meta.cacheHit = true;
      return parsed;
    } catch (e) { /* recompute */ }
  }

  const t0 = Date.now();
  const data = computeMissedCallsReport_(dept, from, to, scope);
  data.meta.computeMs = Date.now() - t0;
  data.meta.cacheHit = false;

  try {
    cache.put(cacheKey, JSON.stringify(data), CACHE_TTL_SECONDS);
  } catch (e) {
    // Large ranges may exceed cache value size; harmless.
    Logger.log('MissedCallsReport cache put failed: %s', e);
  }

  return data;
}

function computeMissedCallsReport_(dept, from, to, scope) {
  const roster = getRosterForDepartment_(dept);
  const rosterSet = {};
  for (let i = 0; i < roster.names.length; i++) rosterSet[roster.names[i]] = true;
  const deptExtensions = roster.allExtensions;

  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.HISTORICAL);
  if (!sheet) {
    throw new Error('Sheet "' + SHEETS.HISTORICAL + '" not found.');
  }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return emptyMissedReport_(dept, from, to, scope, roster.names.length);
  }

  const ssTZ = ss.getSpreadsheetTimeZone();

  // Read cols 1..AH. Need date (col 2) and agent (col 3) for filtering,
  // K-AC for missed times, AF for abandoned cross-reference.
  const numCols = HISTORICAL_COLS.CSR_AVG_ABD_WAIT;
  const range = sheet.getRange(2, 1, lastRow - 1, numCols);
  const values = range.getValues();
  const displays = range.getDisplayValues();

  // Chart buckets: 8 AM-5 PM CST in 30-min slots = 18 buckets
  const totalBuckets = (MISSED_CHART_END_HOUR - MISSED_CHART_START_HOUR)
                       * (60 / MISSED_BUCKET_MINUTES);
  const chartCounts = new Array(totalBuckets).fill(0);
  const startMin = MISSED_CHART_START_HOUR * 60;
  const endMin   = MISSED_CHART_END_HOUR   * 60;

  // Per-agent aggregator
  const agentMap = {};   // agent -> { missedTimes: [], total: 0 }
  let rowsMatched = 0;
  let totalMissed = 0;
  let abandonedCount = 0;  // diagnostic: how many matched as abandoned

  for (let i = 0; i < values.length; i++) {
    const r  = values[i];
    const rd = displays[i];

    const dateIso = rowDateIso_(r[HISTORICAL_COLS.DATE - 1], ssTZ);
    if (!dateIso || dateIso < from || dateIso > to) continue;

    const agent = String(r[HISTORICAL_COLS.AGENT - 1] || '').trim();
    if (!agent) continue;

    // Scope filter (same semantics as Data.gs computeSummary_)
    const inRoster = !!rosterSet[agent];
    let inQueue = false;
    if (scope !== 'roster') {
      const rowExts = parseExtensions_(r[HISTORICAL_COLS.QUEUE_EXT - 1]);
      for (let j = 0; j < rowExts.length; j++) {
        if (deptExtensions[rowExts[j]]) { inQueue = true; break; }
      }
    }
    let include;
    if (scope === 'roster')     include = inRoster;
    else if (scope === 'queue') include = inQueue;
    else                        include = inRoster || inQueue;
    if (!include) continue;

    rowsMatched++;

    // Collect all missed-call timestamps from K-AC (19 columns).
    // We keep both the raw display label (for rendering) and a
    // normalized 24-hour key (for matching against AF).
    const slotTimes = [];  // [{ label, key }]
    for (let c = HISTORICAL_TIME_SLOTS_START; c <= HISTORICAL_TIME_SLOTS_END; c++) {
      const cell = String(rd[c - 1] || '').trim();
      if (!cell) continue;
      cell.split(',').forEach(function (t) {
        const trimmed = t.trim();
        if (!trimmed) return;
        slotTimes.push({ label: trimmed, key: normTimeKey_(trimmed) });
      });
    }

    if (slotTimes.length === 0) continue;

    // Build the set of abandoned-missed timestamps (col AF). Normalize
    // the same way as slot times so AM/PM differences or 24-vs-12 hour
    // formatting in either column don't break the cross-reference.
    const abandonedStr = String(rd[HISTORICAL_ABANDONED_MISSED_TIMES - 1] || '').trim();
    const abandonedKeys = {};
    if (abandonedStr) {
      abandonedStr.split(',').forEach(function (t) {
        const k = normTimeKey_(t.trim());
        if (k) abandonedKeys[k] = true;
      });
    }

    if (!agentMap[agent]) {
      agentMap[agent] = { missedTimes: [], total: 0 };
    }

    slotTimes.forEach(function (item) {
      const isAbandoned = !!abandonedKeys[item.key];
      if (isAbandoned) abandonedCount++;
      agentMap[agent].missedTimes.push({
        date: dateIso,
        time: item.label,
        // Use the normalized 24h key as the formatter input so AM/PM
        // is computed from the hour value, not from any AM/PM suffix
        // that may already be present in the raw cell display.
        label: formatHmsToAmPm_(item.key),
        abandoned: isAbandoned,
      });
      agentMap[agent].total++;
      totalMissed++;

      // Bucket into the histogram (uses normalized key's hour/min)
      const minutes = parseHmsKeyToMinutes_(item.key);
      if (minutes >= startMin && minutes < endMin) {
        const bucketIdx = Math.floor((minutes - startMin) / MISSED_BUCKET_MINUTES);
        if (bucketIdx >= 0 && bucketIdx < totalBuckets) {
          chartCounts[bucketIdx]++;
        }
      }
    });
  }

  // Sort each agent's missedTimes by date then time, for stable display
  const agents = Object.keys(agentMap)
    .sort()
    .map(function (name) {
      const list = agentMap[name].missedTimes.slice();
      list.sort(function (a, b) {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return a.time < b.time ? -1 : a.time > b.time ? 1 : 0;
      });
      return {
        name: name,
        missedTimes: list,
        total: agentMap[name].total,
      };
    });

  // Chart labels
  const chartLabels = [];
  for (let i = 0; i < totalBuckets; i++) {
    chartLabels.push(formatMinutesAmPm_(startMin + i * MISSED_BUCKET_MINUTES));
  }

  return {
    meta: {
      department: dept,
      from: from, to: to,
      scope: scope,
      rosterSize: roster.names.length,
      rowsMatched: rowsMatched,
      agentCount: agents.length,
      totalMissed: totalMissed,
      abandonedCount: abandonedCount,
      generatedAt: new Date().toISOString(),
    },
    agents: agents,
    chart: {
      labels: chartLabels,
      counts: chartCounts,
    },
  };
}

function emptyMissedReport_(dept, from, to, scope, rosterSize) {
  return {
    meta: {
      department: dept,
      from: from, to: to,
      scope: scope,
      rosterSize: rosterSize || 0,
      rowsMatched: 0,
      agentCount: 0,
      totalMissed: 0,
      generatedAt: new Date().toISOString(),
    },
    agents: [],
    chart: { labels: [], counts: [] },
  };
}

/**
 * Normalizes a time string to a canonical 24-hour "H:MM:SS" key for
 * cross-column matching. Handles:
 *   - 24-hour "21:15:23"     -> "21:15:23"
 *   - 12-hour "9:15:23 PM"   -> "21:15:23"
 *   - 12-hour "9:15:23 AM"   -> "9:15:23"
 *   - "12:30:00 AM"          -> "0:30:00"
 *   - "12:30:00 PM"          -> "12:30:00"
 *   - Hour-padding "09:15:23" -> "9:15:23"
 *   - Missing seconds "9:15"  -> "9:15:00"
 *
 * Returns '' if unparseable.
 */
function normTimeKey_(s) {
  if (s == null || s === '') return '';
  let str = String(s).trim().toUpperCase();
  const isPM = /\bPM\b/.test(str);
  const isAM = /\bAM\b/.test(str);
  str = str.replace(/\s*(AM|PM)\s*/, '').trim();

  const parts = str.split(':');
  if (parts.length < 2) return '';
  let h = parseInt(parts[0]) || 0;
  const m = parseInt(parts[1]) || 0;
  const sec = parts.length >= 3 ? (parseInt(parts[2]) || 0) : 0;

  if (isPM && h < 12) h += 12;
  else if (isAM && h === 12) h = 0;

  const pad = function (n) { return n < 10 ? '0' + n : String(n); };
  return h + ':' + pad(m) + ':' + pad(sec);
}

/**
 * Normalized "H:MM:SS" key -> minutes past midnight.
 */
function parseHmsKeyToMinutes_(key) {
  if (!key) return -1;
  const parts = key.split(':');
  if (parts.length < 2) return -1;
  const h = parseInt(parts[0]) || 0;
  const m = parseInt(parts[1]) || 0;
  return h * 60 + m;
}

/**
 * "9:15:23" (24-hour) -> "9:15:23 AM". Preserves seconds for parity with
 * the legacy missed-timestamp display.
 */
function formatHmsToAmPm_(timeStr) {
  if (!timeStr) return '';
  const parts = String(timeStr).trim().split(':');
  if (parts.length < 2) return timeStr;
  let h = parseInt(parts[0]) || 0;
  const m = String(parts[1] || '00').padStart(2, '0');
  const s = String(parts[2] || '00').padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return h + ':' + m + ':' + s + ' ' + ampm;
}

/**
 * Total-minutes-past-midnight -> "H:MM AM/PM" label (no seconds, used
 * for chart bucket labels).
 */
function formatMinutesAmPm_(totalMinutes) {
  let h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return h + ':' + (m < 10 ? '0' + m : m) + ' ' + ampm;
}

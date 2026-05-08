/**
 * Data layer.
 *
 * Public API (called via google.script.run from the client):
 *   getDepartmentSummary({ department, from, to })
 *     -> { meta, rows, totals }
 *
 * Authorization: every request re-resolves the caller and rejects
 *   any cross-department access. Admins can request any department
 *   that exists in the dept list; managers are pinned to theirs.
 *
 * Caching: 5-minute (CACHE_TTL_SECONDS) per (dept, from, to) tuple.
 *   Cached payload is the full response with meta.cacheHit overwritten
 *   to true on serve.
 *
 * Performance: one bulk getValues() over cols A..AH of DQE Historical
 *   Data, in-memory date filter + roster filter + aggregation. Roster
 *   read separately from DO NOT EDIT! (cheap, one column).
 */

function getDepartmentSummary(req) {
  const email = Session.getActiveUser().getEmail();
  const user = resolveUser_(email);

  if (user.role === 'none') {
    throw new Error('Not authorized.');
  }

  const dept = String((req && req.department) || '').trim();
  if (!dept) {
    throw new Error('Department is required.');
  }
  if (user.role === 'manager' && dept !== user.department) {
    throw new Error('Not authorized for this department.');
  }
  if (user.role === 'admin' && getAllDepartments_().indexOf(dept) === -1) {
    throw new Error('Unknown department: ' + dept);
  }

  const from = String((req && req.from) || '').trim();
  const to = String((req && req.to) || '').trim();
  if (!isIsoDate_(from) || !isIsoDate_(to)) {
    throw new Error('from/to must be YYYY-MM-DD.');
  }
  if (from > to) {
    throw new Error('from must be on or before to.');
  }

  const cache = CacheService.getScriptCache();
  const cacheKey = 'summary:v1:' + dept + ':' + from + ':' + to;
  const cached = cache.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      parsed.meta.cacheHit = true;
      return parsed;
    } catch (e) {
      // Corrupted cache entry -- fall through to recompute.
      Logger.log('Cache parse failed, recomputing: %s', e);
    }
  }

  const t0 = Date.now();
  const data = computeSummary_(dept, from, to);
  data.meta.computeMs = Date.now() - t0;
  data.meta.cacheHit = false;

  try {
    cache.put(cacheKey, JSON.stringify(data), CACHE_TTL_SECONDS);
  } catch (e) {
    // CacheService values are capped at ~100KB. A single dept's
    // summary is well under that, but log if it ever fails.
    Logger.log('Cache put failed: %s', e);
  }

  return data;
}

function isIsoDate_(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

/**
 * Reads + aggregates. Pure -- no caching here, that's the caller's job.
 */
function computeSummary_(dept, from, to) {
  const roster = getAgentsForDepartment_(dept);
  const agentSet = {};
  for (let i = 0; i < roster.length; i++) agentSet[roster[i]] = true;

  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.HISTORICAL);
  if (!sheet) {
    throw new Error('Sheet "' + SHEETS.HISTORICAL + '" not found.');
  }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return emptySummary_(dept, from, to, roster.length, 0);
  }

  // Read only the columns we need (1..AH = 1..34). Single bulk read.
  const numCols = HISTORICAL_COLS.CSR_AVG_ABD_WAIT;
  const values = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();

  const acc = {};
  let rowsMatched = 0;

  for (let i = 0; i < values.length; i++) {
    const r = values[i];
    const dateIso = rowDateIso_(r[HISTORICAL_COLS.DATE - 1]);
    if (!dateIso || dateIso < from || dateIso > to) continue;

    const agent = String(r[HISTORICAL_COLS.AGENT - 1] || '').trim();
    if (!agent || !agentSet[agent]) continue;

    rowsMatched++;
    let a = acc[agent];
    if (!a) {
      a = {
        agent: agent,
        totalUnique: 0,
        totalRung: 0,
        totalMissed: 0,
        totalAnswered: 0,
        tttSeconds: 0,
        // Fallback ATT averaging if totalAnswered is zero on a row.
        attSecondsSum: 0, attSecondsCount: 0,
        // Abandoned-wait columns are already-averaged per row; we take
        // a simple mean across rows. True weighting would need raw
        // abandoned-call counts, which the historical sheet doesn't
        // expose as a separate column.
        avgAbdWaitSecondsSum: 0, avgAbdWaitSecondsCount: 0,
        csrAvgAbdWaitSecondsSum: 0, csrAvgAbdWaitSecondsCount: 0,
        days: {},
      };
      acc[agent] = a;
    }

    a.totalUnique   += Number(r[HISTORICAL_COLS.TOTAL_UNIQUE - 1])   || 0;
    a.totalRung     += Number(r[HISTORICAL_COLS.TOTAL_RUNG - 1])     || 0;
    a.totalMissed   += Number(r[HISTORICAL_COLS.TOTAL_MISSED - 1])   || 0;
    a.totalAnswered += Number(r[HISTORICAL_COLS.TOTAL_ANSWERED - 1]) || 0;
    a.tttSeconds    += toSeconds_(r[HISTORICAL_COLS.TTT - 1]);

    const att = toSeconds_(r[HISTORICAL_COLS.ATT - 1]);
    if (att) { a.attSecondsSum += att; a.attSecondsCount++; }

    const aaw = toSeconds_(r[HISTORICAL_COLS.AVG_ABD_WAIT - 1]);
    if (aaw) { a.avgAbdWaitSecondsSum += aaw; a.avgAbdWaitSecondsCount++; }

    const caw = toSeconds_(r[HISTORICAL_COLS.CSR_AVG_ABD_WAIT - 1]);
    if (caw) { a.csrAvgAbdWaitSecondsSum += caw; a.csrAvgAbdWaitSecondsCount++; }

    a.days[dateIso] = true;
  }

  // Finalize per-agent rows.
  const rows = [];
  for (const k in acc) {
    if (!Object.prototype.hasOwnProperty.call(acc, k)) continue;
    const a = acc[k];
    rows.push({
      agent: a.agent,
      totalUnique: a.totalUnique,
      totalRung: a.totalRung,
      totalMissed: a.totalMissed,
      totalAnswered: a.totalAnswered,
      tttSeconds: a.tttSeconds,
      // Prefer weighted ATT (TTT / Answered); fall back to mean of row
      // ATTs if no answered calls in range (rare but possible).
      attSeconds: a.totalAnswered
        ? Math.round(a.tttSeconds / a.totalAnswered)
        : (a.attSecondsCount ? Math.round(a.attSecondsSum / a.attSecondsCount) : 0),
      avgAbdWaitSeconds: a.avgAbdWaitSecondsCount
        ? Math.round(a.avgAbdWaitSecondsSum / a.avgAbdWaitSecondsCount) : 0,
      csrAvgAbdWaitSeconds: a.csrAvgAbdWaitSecondsCount
        ? Math.round(a.csrAvgAbdWaitSecondsSum / a.csrAvgAbdWaitSecondsCount) : 0,
      daysActive: Object.keys(a.days).length,
    });
  }

  // Default initial sort: missed desc, agent asc tiebreak. The client
  // can re-sort via column clicks; this just gives a sensible first paint.
  rows.sort(function (x, y) {
    if (y.totalMissed !== x.totalMissed) return y.totalMissed - x.totalMissed;
    return x.agent.localeCompare(y.agent);
  });

  // Totals: sum the summables; weighted ATT; simple-mean abd waits.
  const totals = { totalUnique:0, totalRung:0, totalMissed:0, totalAnswered:0, tttSeconds:0 };
  for (let i = 0; i < rows.length; i++) {
    totals.totalUnique   += rows[i].totalUnique;
    totals.totalRung     += rows[i].totalRung;
    totals.totalMissed   += rows[i].totalMissed;
    totals.totalAnswered += rows[i].totalAnswered;
    totals.tttSeconds    += rows[i].tttSeconds;
  }
  totals.attSeconds = totals.totalAnswered
    ? Math.round(totals.tttSeconds / totals.totalAnswered) : 0;
  totals.avgAbdWaitSeconds = avg_(rows, 'avgAbdWaitSeconds');
  totals.csrAvgAbdWaitSeconds = avg_(rows, 'csrAvgAbdWaitSeconds');

  return {
    meta: {
      department: dept,
      from: from,
      to: to,
      rowsScanned: values.length,
      rowsMatched: rowsMatched,
      rosterSize: roster.length,
      agentsWithData: rows.length,
      generatedAt: new Date().toISOString(),
    },
    rows: rows,
    totals: totals,
  };
}

function emptySummary_(dept, from, to, rosterSize, rowsScanned) {
  return {
    meta: {
      department: dept,
      from: from, to: to,
      rowsScanned: rowsScanned || 0,
      rowsMatched: 0,
      rosterSize: rosterSize || 0,
      agentsWithData: 0,
      generatedAt: new Date().toISOString(),
    },
    rows: [],
    totals: {
      totalUnique: 0, totalRung: 0, totalMissed: 0, totalAnswered: 0,
      tttSeconds: 0, attSeconds: 0,
      avgAbdWaitSeconds: 0, csrAvgAbdWaitSeconds: 0,
    },
  };
}

/**
 * Returns the agent-name list for a department from DO NOT EDIT!.
 * Empty array if the dept column doesn't exist or the sheet's missing.
 */
function getAgentsForDepartment_(dept) {
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.ROSTER);
  if (!sheet) return [];

  const lastCol = sheet.getLastColumn();
  if (lastCol < ROSTER.DEPT_FIRST_COL) return [];

  const headerRow = sheet
    .getRange(ROSTER.HEADER_ROW, ROSTER.DEPT_FIRST_COL,
              1, lastCol - ROSTER.DEPT_FIRST_COL + 1)
    .getValues()[0];

  let foundCol = -1;
  for (let i = 0; i < headerRow.length; i++) {
    const v = String(headerRow[i] || '').trim();
    if (!v) break; // first blank ends the dept block
    if (v === dept) { foundCol = ROSTER.DEPT_FIRST_COL + i; break; }
  }
  if (foundCol === -1) return [];

  const lastRow = sheet.getLastRow();
  if (lastRow < ROSTER.DATA_START_ROW) return [];

  const cells = sheet
    .getRange(ROSTER.DATA_START_ROW, foundCol,
              lastRow - ROSTER.DATA_START_ROW + 1, 1)
    .getValues();
  return cells
    .map(function (r) { return String(r[0] || '').trim(); })
    .filter(function (s) { return s.length > 0; });
}

/**
 * Normalizes a date cell into YYYY-MM-DD. Accepts Date objects (the
 * common case when the cell is formatted as date), MM/DD/YYYY strings,
 * MM/DD/YY strings (2-digit year, pivoted at 70: 00-69 -> 2000s,
 * 70-99 -> 1900s), YYYY-MM-DD strings, and Sheets serial-date numbers
 * (days since 1899-12-30). Anything else returns '' and the row is
 * filtered out.
 */
function rowDateIso_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  }
  // Sheets serial date: e.g. 45726 = 2025-03-09. Plausible date range
  // (~1982 to ~2100) keeps us from misinterpreting small ints.
  if (typeof v === 'number' && v > 30000 && v < 100000) {
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (!isNaN(d.getTime())) {
      return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
    }
    return '';
  }
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  // MM/DD/YYYY or M/D/YYYY
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return m[3] + '-' + pad2_(Number(m[1])) + '-' + pad2_(Number(m[2]));
  // MM/DD/YY or M/D/YY -- pivot 00-69 to 2000s, 70-99 to 1900s.
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (m) {
    const yy = Number(m[3]);
    const yyyy = yy < 70 ? 2000 + yy : 1900 + yy;
    return yyyy + '-' + pad2_(Number(m[1])) + '-' + pad2_(Number(m[2]));
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return '';
}

function pad2_(n) { return n < 10 ? ('0' + n) : String(n); }

/**
 * Cell value -> seconds. Accepts:
 *   - Number (Sheets duration, fraction of a day)
 *   - Date (time-of-day; happens when cell is formatted as time)
 *   - String "H:MM:SS" or "M:SS"
 *   - Anything else -> 0
 */
function toSeconds_(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return Math.round(v * 86400);
  if (v instanceof Date) {
    return v.getHours() * 3600 + v.getMinutes() * 60 + v.getSeconds();
  }
  const s = String(v).trim();
  if (!s) return 0;
  if (s.indexOf(':') !== -1) {
    const parts = s.split(':');
    const nums = [];
    for (let i = 0; i < parts.length; i++) nums.push(Number(parts[i]) || 0);
    if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
    if (nums.length === 2) return nums[0] * 60 + nums[1];
  }
  return Number(s) || 0;
}

function avg_(arr, key) {
  if (!arr.length) return 0;
  let s = 0, n = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = Number(arr[i][key]) || 0;
    if (v) { s += v; n++; }
  }
  return n ? Math.round(s / n) : 0;
}

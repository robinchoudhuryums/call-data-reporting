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
  // Bump the version suffix any time the aggregation rules change so
  // stale caches are invalidated instantly across all dept/range
  // tuples. v2: switched ATT from weighted (TTT/Answered) to simple
  // mean of source-stored ATT values.
  const cacheKey = 'summary:v2:' + dept + ':' + from + ':' + to;
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

  // Pre-fetch the spreadsheet's TZ once. Used by rowDateIso_ to
  // correctly interpret any date cells that come back as Date
  // objects (currently your dates are strings, so this is mostly
  // belt-and-suspenders -- but if the column is ever reformatted
  // to a date type, this prevents the same TZ-shift bug we hit on
  // the duration columns.
  const ssTZ = ss.getSpreadsheetTimeZone();

  // Read both numeric/Date values AND display strings on the same
  // range. Duration cells (TTT/ATT/abd-wait) get parsed from their
  // display strings to avoid spreadsheet-vs-script timezone drift:
  // when getValue() returns a Date for a duration cell, the Date is
  // interpreted using the SPREADSHEET'S timezone, while our local-
  // time extraction (getHours/Min/Sec) uses the SCRIPT'S timezone.
  // Any mismatch (e.g. Mexico City TZ vs Chicago TZ) silently shifts
  // every duration by the offset. Display values are TZ-free.
  const numCols = HISTORICAL_COLS.CSR_AVG_ABD_WAIT;
  const range = sheet.getRange(2, 1, lastRow - 1, numCols);
  const values = range.getValues();
  const displays = range.getDisplayValues();

  const acc = {};
  let rowsMatched = 0;

  for (let i = 0; i < values.length; i++) {
    const r = values[i];
    const dateIso = rowDateIso_(r[HISTORICAL_COLS.DATE - 1], ssTZ);
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

    const rd = displays[i];
    a.totalUnique   += Number(r[HISTORICAL_COLS.TOTAL_UNIQUE - 1])   || 0;
    a.totalRung     += Number(r[HISTORICAL_COLS.TOTAL_RUNG - 1])     || 0;
    a.totalMissed   += Number(r[HISTORICAL_COLS.TOTAL_MISSED - 1])   || 0;
    a.totalAnswered += Number(r[HISTORICAL_COLS.TOTAL_ANSWERED - 1]) || 0;
    a.tttSeconds    += parseHmsDisplay_(rd[HISTORICAL_COLS.TTT - 1]);

    const att = parseHmsDisplay_(rd[HISTORICAL_COLS.ATT - 1]);
    if (att) { a.attSecondsSum += att; a.attSecondsCount++; }

    const aaw = parseHmsDisplay_(rd[HISTORICAL_COLS.AVG_ABD_WAIT - 1]);
    if (aaw) { a.avgAbdWaitSecondsSum += aaw; a.avgAbdWaitSecondsCount++; }

    const caw = parseHmsDisplay_(rd[HISTORICAL_COLS.CSR_AVG_ABD_WAIT - 1]);
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
      // ATT: simple mean of the source sheet's stored per-row ATT
      // values. For single-day ranges this matches the source row
      // exactly (which is what the existing DQE Report shows); for
      // multi-day, it's the simple mean across that agent's rows in
      // range. We intentionally do NOT compute weighted TTT/Answered
      // here: the source's stored ATT is sometimes derived from a
      // denominator other than Total Answered, so a weighted formula
      // would silently disagree with the source for those rows.
      attSeconds: a.attSecondsCount
        ? Math.round(a.attSecondsSum / a.attSecondsCount) : 0,
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

  // Totals: sum the summables; simple-mean the per-row averages so
  // every "average" column in the totals row uses the same method
  // it uses in the agent rows.
  const totals = { totalUnique:0, totalRung:0, totalMissed:0, totalAnswered:0, tttSeconds:0 };
  for (let i = 0; i < rows.length; i++) {
    totals.totalUnique   += rows[i].totalUnique;
    totals.totalRung     += rows[i].totalRung;
    totals.totalMissed   += rows[i].totalMissed;
    totals.totalAnswered += rows[i].totalAnswered;
    totals.tttSeconds    += rows[i].tttSeconds;
  }
  totals.attSeconds = avg_(rows, 'attSeconds');
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
 *
 * Roster cells embed each agent's queue extensions after the name,
 * comma-separated: "Robin Choudhury, 139" or "Robin Choudhury, 139,
 * 165". This function strips the extensions and returns only names;
 * Step E reads the same cells to extract per-dept queue lists.
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
  const names = [];
  for (let i = 0; i < cells.length; i++) {
    const name = parseRosterAgentName_(cells[i][0]);
    if (name) names.push(name);
  }
  return names;
}

/**
 * Extracts the agent name from a roster cell. The cell may contain
 * just a name ("Dalia Nared") or a name with extensions appended
 * ("Robin Choudhury, 139" or "Robin Choudhury, 139, 165"). Returns
 * everything before the first comma, trimmed. Empty string if the
 * cell is blank.
 */
function parseRosterAgentName_(cellValue) {
  const raw = String(cellValue == null ? '' : cellValue).trim();
  if (!raw) return '';
  const commaIdx = raw.indexOf(',');
  return commaIdx === -1 ? raw : raw.substring(0, commaIdx).trim();
}

/**
 * Normalizes a date cell into YYYY-MM-DD. Accepts Date objects (the
 * common case when the cell is formatted as date), MM/DD/YYYY strings,
 * MM/DD/YY strings (2-digit year, pivoted at 70: 00-69 -> 2000s,
 * 70-99 -> 1900s), YYYY-MM-DD strings, and Sheets serial-date numbers
 * (days since 1899-12-30). Anything else returns '' and the row is
 * filtered out.
 *
 * tz is the spreadsheet's timezone, used to interpret Date objects
 * returned by getValue() for date-formatted cells. Pass it explicitly
 * (computeSummary_ does) so the spreadsheet TZ is honored even if it
 * differs from the script's TZ -- same root cause as the duration
 * column issue. Falls back to the script's TZ if omitted.
 */
function rowDateIso_(v, tz) {
  const useTz = tz || TZ;
  if (v instanceof Date) {
    return Utilities.formatDate(v, useTz, 'yyyy-MM-dd');
  }
  // Sheets serial date: e.g. 45726 = 2025-03-09. Plausible date range
  // (~1982 to ~2100) keeps us from misinterpreting small ints.
  if (typeof v === 'number' && v > 30000 && v < 100000) {
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (!isNaN(d.getTime())) {
      return Utilities.formatDate(d, useTz, 'yyyy-MM-dd');
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
 * Display-string -> seconds. Parses the formatted text shown in a
 * duration cell, e.g. "6:04:50" or "0:23:17" or "45" (raw seconds).
 * Preferred over toSeconds_ for duration cells because it bypasses
 * the spreadsheet-vs-script timezone issue described in
 * computeSummary_.
 */
function parseHmsDisplay_(s) {
  if (s == null || s === '') return 0;
  const str = String(s).trim();
  if (!str) return 0;
  if (str.indexOf(':') === -1) {
    return Number(str) || 0;
  }
  const parts = str.split(':');
  const nums = [];
  for (let i = 0; i < parts.length; i++) nums.push(Number(parts[i]) || 0);
  if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
  if (nums.length === 2) return nums[0] * 60 + nums[1];
  return 0;
}

/**
 * Cell value -> seconds. Accepts:
 *   - Number (Sheets duration, fraction of a day)
 *   - Date (time-of-day; happens when cell is formatted as time)
 *   - String "H:MM:SS" or "M:SS"
 *   - Anything else -> 0
 *
 * Kept for diagnostics. Production summary code uses parseHmsDisplay_
 * on the display strings instead -- see computeSummary_.
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

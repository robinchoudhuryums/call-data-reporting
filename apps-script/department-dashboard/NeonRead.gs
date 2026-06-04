/**
 * Neon READ layer (Phase 3 / F1 read-back -- step 1).
 *
 * The dashboard has always read DQE metrics from the `DQE Historical Data`
 * sheet (re-scanning the whole sheet per request -- the F1 scaling cliff).
 * This file is the first, ADDITIVE, fully-reversible step toward reading
 * from Neon's `dqe_history` instead:
 *
 *   - `getDqeReadSource_()`  -- the cutover switch (Script Property
 *       `DQE_READ_SOURCE` = 'sheet' (default) | 'neon'). NOTHING in the
 *       production read path consumes it yet; the per-report cutover
 *       (Phase 3.2) will route readers through it. Default 'sheet' means
 *       this file changes ZERO production behavior on deploy.
 *   - `neonFetchDqeRows_(from, to)` / `sheetFetchDqeRows_(from, to)` --
 *       symmetric DAL primitives that return per-(date, agent) DQE rows in
 *       the SAME normalized shape from each source, so they can be diffed
 *       and (later) swapped behind the flag.
 *   - `compareDqeSources_()` -- editor-run parity diagnostic. Reads a date
 *       range from BOTH sources and reports row-count + value mismatches.
 *       This is the GATE for the read-back: when it shows 0 missing-in-Neon
 *       and 0 value mismatches over a representative range, `dqe_history`
 *       is trustworthy to read from.
 *
 * Requires (already set for orphan-rename-to-Neon): the dashboard project's
 * NEON_HOST/NEON_DB/NEON_USER/NEON_PASS Script Properties + the
 * `script.external_request` OAuth scope. Reads sidestep the INV-02 duration
 * TZ gotcha entirely: Neon stores ttt/att/abd-wait as the same H:MM:SS
 * strings the sheet DISPLAYS, so both sources parse via `parseHmsDisplay_`.
 */

/**
 * Cutover switch. 'neon' only when the Script Property is explicitly set;
 * anything else (incl. unset) => 'sheet'. No production reader consumes
 * this yet -- it's scaffolding for the Phase 3.2 per-report cutover.
 */
function getDqeReadSource_() {
  var v = String(PropertiesService.getScriptProperties()
                   .getProperty('DQE_READ_SOURCE') || 'sheet').toLowerCase().trim();
  return v === 'neon' ? 'neon' : 'sheet';
}

/**
 * Opens a Neon connection from the dashboard project's NEON_* properties.
 * Returns null (logged) when unconfigured or unreachable -- callers treat
 * null as "fall back to the sheet". Caller owns closing it.
 */
function getDashboardNeonConn_() {
  var p = PropertiesService.getScriptProperties();
  var host = p.getProperty('NEON_HOST');
  if (!host) { Logger.log('getDashboardNeonConn_: NEON_HOST not set.'); return null; }
  try {
    var url = 'jdbc:postgresql://' + host + '/' + p.getProperty('NEON_DB');
    return Jdbc.getConnection(url, p.getProperty('NEON_USER'), p.getProperty('NEON_PASS'));
  } catch (e) {
    Logger.log('getDashboardNeonConn_ failed: ' + (e && e.message ? e.message : e));
    return null;
  }
}

/**
 * MAX(call_date) from dqe_history as a 'yyyy-MM-dd' string, or null on
 * no data / unreachable / error. One indexed query vs a whole-column
 * sheet scan -- the F1 read-back's cheapest win. Best-effort: callers
 * treat null as "fall back to the sheet".
 */
function neonGetMaxDqeDate_() {
  var conn = getDashboardNeonConn_();
  if (!conn) return null;
  try {
    var stmt = conn.createStatement();
    var rs = stmt.executeQuery('SELECT MAX(call_date)::text AS d FROM dqe_history');
    var d = rs.next() ? rs.getString('d') : null;
    rs.close(); stmt.close();
    return d ? String(d).trim() : null;
  } catch (e) {
    Logger.log('neonGetMaxDqeDate_ failed: ' + (e && e.message ? e.message : e));
    return null;
  } finally {
    try { conn.close(); } catch (ce) {}
  }
}

/**
 * Normalized DQE row shape (both fetchers return this), keyed downstream
 * on (dateIso, agent):
 *   { dateIso, agent, monthYear, queueExt,
 *     totalUnique, totalRung, totalMissed, totalAnswered,
 *     tttSec, attSec, avgAbdWaitSec, csrAvgAbdWaitSec }
 * Durations are SECONDS (parsed via parseHmsDisplay_) so the two sources
 * compare regardless of string formatting. Scope: the core metric columns
 * used by computeSummary_ / IR / PR / CR; the Missed-report slot + abandoned
 * -ID columns are a follow-on (Phase 3.2) and intentionally not fetched here.
 */

/** Reads dqe_history for [fromIso, toIso] (inclusive). Returns [] on no conn. */
function neonFetchDqeRows_(fromIso, toIso) {
  var conn = getDashboardNeonConn_();
  if (!conn) return [];
  var out = [];
  try {
    // PERF: Apps Script JDBC iterates a ResultSet one CELL at a time, which
    // is catastrophically slow over the thousands of rows the IR/PR 12-month
    // trend window (and CR's year-over-year window) pull -- ~0.5s/row, so a
    // year of data is 20+ minutes. Aggregate the entire result set into ONE
    // json string server-side (json_agg) and fetch it with a SINGLE
    // rs.getString, instead of ~12 getXXX calls per row. Turns ~150k JDBC
    // round-trips into 1. Order is irrelevant -- downstream maps by
    // (date, agent). COALESCE so an empty range returns '[]' not null.
    var sql = "SELECT COALESCE(json_agg(t), '[]')::text AS j FROM ("
            + "SELECT month_year, call_date::text AS d, agent_name, queue_extensions, "
            + "total_unique, total_rung, total_missed, total_answered, "
            + "ttt, att, avg_abd_wait, csr_avg_abd_wait "
            + "FROM dqe_history WHERE call_date BETWEEN ?::date AND ?::date) t";
    var stmt = conn.prepareStatement(sql);
    stmt.setString(1, fromIso);
    stmt.setString(2, toIso);
    var rs = stmt.executeQuery();
    var json = rs.next() ? rs.getString('j') : '[]';
    rs.close(); stmt.close();
    var arr = JSON.parse(json || '[]');
    for (var i = 0; i < arr.length; i++) {
      var r = arr[i];
      var agent = String(r.agent_name || '').trim();
      if (!agent) continue;
      out.push({
        dateIso:          String(r.d || '').trim(),
        agent:            agent,
        monthYear:        String(r.month_year || '').trim(),
        queueExt:         String(r.queue_extensions || '').trim(),
        totalUnique:      Number(r.total_unique)   || 0,
        totalRung:        Number(r.total_rung)     || 0,
        totalMissed:      Number(r.total_missed)   || 0,
        totalAnswered:    Number(r.total_answered) || 0,
        tttSec:           parseHmsDisplay_(r.ttt),
        attSec:           parseHmsDisplay_(r.att),
        avgAbdWaitSec:    parseHmsDisplay_(r.avg_abd_wait),
        csrAvgAbdWaitSec: parseHmsDisplay_(r.csr_avg_abd_wait),
      });
    }
  } catch (e) {
    Logger.log('neonFetchDqeRows_ failed: ' + (e && e.message ? e.message : e));
  } finally {
    try { conn.close(); } catch (ce) {}
  }
  return out;
}

/**
 * Reads DQE Historical Data (the sheet) for [fromIso, toIso] into the same
 * normalized shape as neonFetchDqeRows_. Uses getDisplayValues() for the
 * duration columns (INV-02). Includes queue-sentinel rows (Neon mirrors
 * them too), so the parity comparison is faithful.
 */
function sheetFetchDqeRows_(fromIso, toIso) {
  var ss = openSpreadsheet_();
  var sheet = ss.getSheetByName(SHEETS.HISTORICAL);
  if (!sheet) return [];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var ssTZ = ss.getSpreadsheetTimeZone();
  var numCols = HISTORICAL_COLS.CSR_AVG_ABD_WAIT;
  var range = sheet.getRange(2, 1, lastRow - 1, numCols);
  var values = range.getValues();
  var displays = range.getDisplayValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var r = values[i], rd = displays[i];
    var dateIso = rowDateIso_(r[HISTORICAL_COLS.DATE - 1], ssTZ);
    if (!dateIso || dateIso < fromIso || dateIso > toIso) continue;
    var agent = String(r[HISTORICAL_COLS.AGENT - 1] || '').trim();
    if (!agent) continue;
    out.push({
      dateIso:          dateIso,
      agent:            agent,
      monthYear:        String(r[HISTORICAL_COLS.MONTH_YEAR - 1] || '').trim(),
      queueExt:         String(r[HISTORICAL_COLS.QUEUE_EXT - 1] || '').trim(),
      totalUnique:      Number(r[HISTORICAL_COLS.TOTAL_UNIQUE - 1])   || 0,
      totalRung:        Number(r[HISTORICAL_COLS.TOTAL_RUNG - 1])     || 0,
      totalMissed:      Number(r[HISTORICAL_COLS.TOTAL_MISSED - 1])   || 0,
      totalAnswered:    Number(r[HISTORICAL_COLS.TOTAL_ANSWERED - 1]) || 0,
      tttSec:           parseHmsDisplay_(rd[HISTORICAL_COLS.TTT - 1]),
      attSec:           parseHmsDisplay_(rd[HISTORICAL_COLS.ATT - 1]),
      avgAbdWaitSec:    parseHmsDisplay_(rd[HISTORICAL_COLS.AVG_ABD_WAIT - 1]),
      csrAvgAbdWaitSec: parseHmsDisplay_(rd[HISTORICAL_COLS.CSR_AVG_ABD_WAIT - 1]),
    });
  }
  return out;
}

/**
 * Editor-run parity diagnostic for the F1 read-back gate. Edit COMPARE_FROM
 * / COMPARE_TO below to a representative range (start with ~1 week to keep
 * the sheet read cheap), then Run this from the Apps Script editor and read
 * the Execution log.
 *
 * Reports, for [COMPARE_FROM, COMPARE_TO]:
 *   - row counts from each source
 *   - keys (date|agent) present in the sheet but MISSING in Neon
 *     (= a dqe_history backfill gap -- run backfillDQEHistory())
 *   - keys present in Neon but not the sheet (= stale / over-mirrored rows)
 *   - per-key VALUE mismatches across the compared fields (+ up to 10 samples)
 *
 * GATE: 0 missing-in-Neon and 0 value mismatches over a representative
 * range => dqe_history is trustworthy to read from, and the Phase 3.2
 * per-report cutover can begin.
 */
function compareDqeSources_() {
  var COMPARE_FROM = '2026-05-23';   // <-- edit
  var COMPARE_TO   = '2026-05-29';   // <-- edit

  Logger.log('=== compareDqeSources_  %s .. %s ===', COMPARE_FROM, COMPARE_TO);
  Logger.log('DQE_READ_SOURCE = %s (production readers still use the sheet)',
             getDqeReadSource_());

  var sheetRows = sheetFetchDqeRows_(COMPARE_FROM, COMPARE_TO);
  var neonRows  = neonFetchDqeRows_(COMPARE_FROM, COMPARE_TO);
  Logger.log('sheet rows: %s | neon rows: %s', sheetRows.length, neonRows.length);
  if (!neonRows.length) {
    Logger.log('No Neon rows -- check NEON_* Script Properties + the '
             + 'script.external_request scope on THIS project, or that '
             + 'dqe_history has data in range.');
    return;
  }

  var keyOf = function (r) { return r.dateIso + '|' + r.agent; };
  var FIELDS = ['totalUnique', 'totalRung', 'totalMissed', 'totalAnswered',
                'tttSec', 'attSec', 'avgAbdWaitSec', 'csrAvgAbdWaitSec', 'queueExt'];

  var sMap = {}, nMap = {};
  sheetRows.forEach(function (r) { sMap[keyOf(r)] = r; });
  neonRows.forEach(function (r)  { nMap[keyOf(r)] = r; });

  var missingInNeon = [], extraInNeon = [], mismatches = [];
  Object.keys(sMap).forEach(function (k) {
    if (!nMap[k]) { missingInNeon.push(k); return; }
    var s = sMap[k], n = nMap[k], diffs = [];
    FIELDS.forEach(function (f) {
      if (String(s[f]) !== String(n[f])) {
        diffs.push(f + ' sheet=' + s[f] + ' neon=' + n[f]);
      }
    });
    if (diffs.length) mismatches.push(k + ' :: ' + diffs.join(', '));
  });
  Object.keys(nMap).forEach(function (k) { if (!sMap[k]) extraInNeon.push(k); });

  Logger.log('--- missing in Neon (sheet rows not mirrored): %s', missingInNeon.length);
  missingInNeon.slice(0, 10).forEach(function (k) { Logger.log('   %s', k); });
  Logger.log('--- extra in Neon (not on sheet): %s', extraInNeon.length);
  extraInNeon.slice(0, 10).forEach(function (k) { Logger.log('   %s', k); });
  Logger.log('--- value mismatches on common keys: %s', mismatches.length);
  mismatches.slice(0, 10).forEach(function (m) { Logger.log('   %s', m); });

  var clean = (missingInNeon.length === 0 && mismatches.length === 0);
  Logger.log('=== PARITY %s ===', clean
    ? 'CLEAN -- dqe_history matches the sheet for this range; read-back gate PASSED'
    : 'MISMATCH -- resolve before cutover (run backfillDQEHistory() for gaps)');
}

/**
 * Editor-run wrapper for compareDqeSources_.
 *
 * WHY THIS EXISTS: the Apps Script editor's "Run" function picker HIDES any
 * function whose name ends in `_` (the same trailing-underscore convention
 * that blocks google.script.run). So `compareDqeSources_` -- and every other
 * `_`-suffixed helper -- is NOT selectable from the dropdown ("No functions"
 * if it's the only thing you're looking at). This non-underscore wrapper is
 * selectable; pick `runDqeParityCheck` from the picker and Run it, then read
 * the Execution log. (Edit the COMPARE_FROM / COMPARE_TO range inside
 * compareDqeSources_ above first.) Same trick applies to any other
 * `_`-suffixed function you need to run by hand: add a one-line wrapper.
 */
function runDqeParityCheck() {
  return compareDqeSources_();
}

/**
 * Lightweight read-timing log for the F1 cutover readers. Emits one line
 * to the Execution log / Cloud Logging per DQE read so you can compare
 * sheet-vs-neon cost in the editor's Executions panel without guessing:
 *
 *   [dqe-read] <label> source=<neon|sheet> rows=<n> ms=<elapsed>
 *
 * `source` is the EFFECTIVE source that served the rows (so a neon read
 * that fell back to the sheet logs source=sheet). Best-effort; never throws.
 */
function logDqeReadTiming_(label, source, startMs, rowCount) {
  try {
    Logger.log('[dqe-read] %s source=%s rows=%s ms=%s',
      label, source,
      (rowCount === null || rowCount === undefined) ? '?' : rowCount,
      (Date.now() - startMs));
  } catch (e) { /* best-effort */ }
}



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
    recordNeonReadFailure_('getDashboardNeonConn_', e);   // F4: unreachable != unconfigured
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
    clearNeonReadFailure_();   // F4: reachable -> reset the failure streak
    return d ? String(d).trim() : null;
  } catch (e) {
    Logger.log('neonGetMaxDqeDate_ failed: ' + (e && e.message ? e.message : e));
    recordNeonReadFailure_('neonGetMaxDqeDate_', e);
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

/**
 * Distinct (agent_name, queue_extensions) pairs across ALL of dqe_history,
 * for the getDeptQueueExts_ DERIVED path. Replaces a whole-sheet cols-A..D
 * scan when DQE_READ_SOURCE=neon: Postgres collapses the ~16k+ rows to the
 * handful of distinct (agent, ext-string) pairs each agent has ever used,
 * aggregated to ONE json string (json_agg) so it's a single rs.getString
 * (same anti-per-row-JDBC discipline as neonFetchDqeRows_). Small result,
 * so it's cached REPORT_CACHE_TTL_SECONDS (changes only when the daily
 * ingest adds a new ext, or an orphan rename lands). Returns an array of
 * { agent_name, queue_extensions } or null on no-conn/error (caller falls
 * back to the cheap sheet read).
 */
function neonGetAgentExtPairs_() {
  var cache = CacheService.getScriptCache();
  var KEY = 'neonAgentExts:v1';
  var hit = cache.get(KEY);
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* recompute */ } }
  var conn = getDashboardNeonConn_();
  if (!conn) return null;
  try {
    var sql = "SELECT COALESCE(json_agg(t), '[]')::text AS j FROM ("
            + "SELECT DISTINCT agent_name, queue_extensions FROM dqe_history "
            + "WHERE queue_extensions IS NOT NULL AND queue_extensions <> '') t";
    var stmt = conn.createStatement();
    var rs = stmt.executeQuery(sql);
    var json = rs.next() ? rs.getString('j') : '[]';
    rs.close(); stmt.close();
    var arr = JSON.parse(json || '[]');
    try { cache.put(KEY, json, REPORT_CACHE_TTL_SECONDS); } catch (ce) { /* harmless */ }
    clearNeonReadFailure_();   // F4: a successful read (even empty) means Neon is healthy
    return arr;
  } catch (e) {
    // F4: record a hard error durably + distinctly so it isn't mistaken
    // for an unconfigured/empty result when the caller falls back to the sheet.
    Logger.log('neonGetAgentExtPairs_ failed: ' + (e && e.message ? e.message : e));
    recordNeonReadFailure_('neonGetAgentExtPairs_', e);
    return null;
  } finally {
    try { conn.close(); } catch (ce) {}
  }
}

// The 19 slot columns (sheet cols K..AC) in order, as written by
// cdr-import's writeDQERowsToNeon. Used by the includeMissedDetail
// fetch below; the order MUST mirror HISTORICAL_COLS.TIME_SLOTS_START..
// TIME_SLOTS_END so the Missed Calls grid adapter can map positionally.
var NEON_DQE_SLOT_COLS = [
  'slot_0800_0830', 'slot_0830_0900', 'slot_0900_0930', 'slot_0930_1000',
  'slot_1000_1030', 'slot_1030_1100', 'slot_1100_1130', 'slot_1130_1200',
  'slot_1200_1230', 'slot_1230_1300', 'slot_1300_1330', 'slot_1330_1400',
  'slot_1400_1430', 'slot_1430_1500', 'slot_1500_1530', 'slot_1530_1600',
  'slot_1600_1630', 'slot_1630_1700', 'slot_1700_1730',
];

/**
 * Reads dqe_history for [fromIso, toIso] (inclusive). Returns [] on no conn.
 * `opts.includeMissedDetail` additionally selects the 19 slot columns +
 * abandoned_parent_ids + abandoned_missed_times (the Missed Calls reader's
 * inputs); each row then carries `slots` (string[19], positional K..AC),
 * `abandonedParentIds`, and `abandonedMissedTimes`. With opts absent the
 * SQL and row shape are byte-identical to the pre-DAL-cutover behavior,
 * so the existing cut-over readers are untouched.
 */
function neonFetchDqeRows_(fromIso, toIso, opts) {
  var includeMissedDetail = !!(opts && opts.includeMissedDetail);
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
    var detailCols = includeMissedDetail
      ? ', ' + NEON_DQE_SLOT_COLS.join(', ') + ', abandoned_parent_ids, abandoned_missed_times'
      : '';
    var sql = "SELECT COALESCE(json_agg(t), '[]')::text AS j FROM ("
            + "SELECT month_year, call_date::text AS d, agent_name, queue_extensions, "
            + "total_unique, total_rung, total_missed, total_answered, "
            + "ttt, att, avg_abd_wait, csr_avg_abd_wait" + detailCols + " "
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
      var row = {
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
      };
      if (includeMissedDetail) {
        row.slots = NEON_DQE_SLOT_COLS.map(function (c) {
          return String(r[c] == null ? '' : r[c]).trim();
        });
        row.abandonedParentIds   = String(r.abandoned_parent_ids   == null ? '' : r.abandoned_parent_ids).trim();
        row.abandonedMissedTimes = String(r.abandoned_missed_times == null ? '' : r.abandoned_missed_times).trim();
      }
      out.push(row);
    }
    clearNeonReadFailure_();   // F4: a successful read (even empty) means Neon is healthy
  } catch (e) {
    // F4: a hard error here (SQL / JSON-parse failure) is recorded
    // durably + distinctly so it isn't mistaken for a legitimately
    // empty range when the cut-over reader falls back to the sheet.
    Logger.log('neonFetchDqeRows_ failed: ' + (e && e.message ? e.message : e));
    recordNeonReadFailure_('neonFetchDqeRows_', e);
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

/**
 * F4: durable, operator-inspectable record of Neon READ failures.
 *
 * The cut-over readers (computeSummary_, getCompanyOverview,
 * getLatestDataDate) fall back to the sheet on any Neon null/empty/error
 * -- correct as a safety net, but it makes a genuine Neon failure
 * (connection unreachable, SQL / JSON-parse error) indistinguishable
 * from a legitimately empty range, so the degradation was previously
 * only an ephemeral Logger.log. Once DQE_READ_SOURCE=neon and the sheet
 * is allowed to age, that means the dashboard can serve stale data with
 * no surfaced signal.
 *
 * This records the last error + a running streak count to the
 * NEON_READ_LAST_ERROR Script Property (queryable now; surfaceable in
 * the admin Overview pipeline banner as a follow-on) and emits a
 * distinctly-tagged log line. Best-effort: never throws -- observability
 * must not block a read. Only exercised when DQE_READ_SOURCE=neon, so
 * there is zero overhead in the default sheet configuration.
 */
function recordNeonReadFailure_(label, err) {
  try {
    var props = PropertiesService.getScriptProperties();
    var msg = (err && err.message) ? err.message : String(err);
    var prev = 0;
    try {
      prev = Number((JSON.parse(props.getProperty('NEON_READ_LAST_ERROR') || '{}') || {}).count) || 0;
    } catch (e) { prev = 0; }
    props.setProperty('NEON_READ_LAST_ERROR', JSON.stringify({
      at:      Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'),
      label:   String(label || ''),
      message: String(msg).slice(0, 300),
      count:   prev + 1,
    }));
    Logger.log('[dqe-read][error] %s neon read FAILED -- serving sheet fallback: %s', label, msg);
  } catch (e) { /* best-effort */ }
}

/**
 * Clears NEON_READ_LAST_ERROR on a successful read so the streak count
 * reflects only the CURRENT outage (a "repeated failures" signal) and a
 * transient blip self-heals once Neon recovers. Cheap on the healthy
 * path: a single getProperty returning null, no write.
 */
function clearNeonReadFailure_() {
  try {
    var props = PropertiesService.getScriptProperties();
    if (props.getProperty('NEON_READ_LAST_ERROR') !== null) {
      props.deleteProperty('NEON_READ_LAST_ERROR');
    }
  } catch (e) { /* best-effort */ }
}



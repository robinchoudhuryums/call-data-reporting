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
function getDashboardNeonConn_(opts) {
  var p = PropertiesService.getScriptProperties();
  var host = p.getProperty('NEON_HOST');
  if (!host) { Logger.log('getDashboardNeonConn_: NEON_HOST not set.'); return null; }
  try {
    var url = 'jdbc:postgresql://' + host + '/' + p.getProperty('NEON_DB');
    return Jdbc.getConnection(url, p.getProperty('NEON_USER'), p.getProperty('NEON_PASS'));
  } catch (e) {
    Logger.log('getDashboardNeonConn_ failed: ' + (e && e.message ? e.message : e));
    // F4: a hard connection failure (unreachable != unconfigured) is recorded
    // durably so the admin read-back health line can show it. F29: callers that
    // are NOT DQE reads -- the keep-warm ping -- pass {skipReadHealth:true} so
    // their failures don't pollute the DQE read-back streak (which is surfaced
    // independent of DQE_READ_SOURCE and would otherwise show a sticky false
    // "read-back FAILING" even while reads are on the sheet).
    if (!(opts && opts.skipReadHealth)) recordNeonReadFailure_('getDashboardNeonConn_', e);
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
 *
 * F2: `opts.includeMissedDetail` additionally returns the 19 slot columns
 * (K..AC) + abandoned_parent_ids (AD) + abandoned_missed_times (AF) as DISPLAY
 * strings, mirroring neonFetchDqeRows_'s includeMissedDetail shape -- so the
 * parity gate can certify the Missed-Calls Neon reader's inputs (previously
 * uncovered). With opts absent the shape is byte-identical to before, so the
 * existing parity comparison + any other caller is unaffected.
 */
function sheetFetchDqeRows_(fromIso, toIso, opts) {
  var includeMissedDetail = !!(opts && opts.includeMissedDetail);
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
    var row = {
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
    };
    if (includeMissedDetail) {
      // Slots K..AC + abandoned IDs/times as DISPLAY strings (TZ-safe per INV-02;
      // Neon stores the same display strings, so a string diff is faithful).
      var slots = [];
      for (var s = HISTORICAL_COLS.TIME_SLOTS_START; s <= HISTORICAL_COLS.TIME_SLOTS_END; s++) {
        slots.push(String(rd[s - 1] == null ? '' : rd[s - 1]).trim());
      }
      row.slots = slots;
      row.abandonedParentIds   = String(rd[HISTORICAL_COLS.ABANDONED_PARENT_IDS - 1]   == null ? '' : rd[HISTORICAL_COLS.ABANDONED_PARENT_IDS - 1]).trim();
      row.abandonedMissedTimes = String(rd[HISTORICAL_COLS.ABANDONED_MISSED_TIMES - 1] == null ? '' : rd[HISTORICAL_COLS.ABANDONED_MISSED_TIMES - 1]).trim();
    }
    out.push(row);
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
  // F2: the range is read from Script Properties DQE_PARITY_FROM / DQE_PARITY_TO
  // (falling back to the edit-in-source defaults) so the gate can run unattended
  // -- e.g. from a scheduled wrapper -- without editing source each time.
  var _props = PropertiesService.getScriptProperties();
  var COMPARE_FROM = _props.getProperty('DQE_PARITY_FROM') || '2026-05-23';   // <-- edit or set Script Property
  var COMPARE_TO   = _props.getProperty('DQE_PARITY_TO')   || '2026-05-29';   // <-- edit or set Script Property

  Logger.log('=== compareDqeSources_  %s .. %s ===', COMPARE_FROM, COMPARE_TO);
  Logger.log('DQE_READ_SOURCE = %s (production readers still use the sheet)',
             getDqeReadSource_());

  // F2: include the Missed-Calls detail columns (19 slots + abandoned IDs/times)
  // in the parity diff so a CLEAN result also certifies the Missed-Calls Neon
  // reader -- previously these were uncovered and required a manual spot-check.
  var detailOpts = { includeMissedDetail: true };
  var sheetRows = sheetFetchDqeRows_(COMPARE_FROM, COMPARE_TO, detailOpts);
  var neonRows  = neonFetchDqeRows_(COMPARE_FROM, COMPARE_TO, detailOpts);
  Logger.log('sheet rows: %s | neon rows: %s', sheetRows.length, neonRows.length);
  if (!neonRows.length) {
    Logger.log('No Neon rows -- check NEON_* Script Properties + the '
             + 'script.external_request scope on THIS project, or that '
             + 'dqe_history has data in range.');
    return;
  }

  var keyOf = function (r) { return r.dateIso + '|' + r.agent; };
  // F2: 'slots' compares the 19-element array via String() (comma-join) -- both
  // sources return string[19], so equality holds iff every slot matches;
  // abandonedParentIds / abandonedMissedTimes are display strings.
  var FIELDS = ['totalUnique', 'totalRung', 'totalMissed', 'totalAnswered',
                'tttSec', 'attSec', 'avgAbdWaitSec', 'csrAvgAbdWaitSec', 'queueExt',
                'slots', 'abandonedParentIds', 'abandonedMissedTimes'];

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
  assertAdmin_();   // F-28: editor-run wrapper, but the bare name is RPC-reachable
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

/**
 * F3: surfaces the durable Neon READ-failure signal (NEON_READ_LAST_ERROR,
 * written by recordNeonReadFailure_) so an admin can SEE that the read-back is
 * failing instead of having to inspect a Script Property by hand. Consumed by
 * getAlertsInit -> the Alerts modal, alongside the F2 mirror-health line.
 *
 * Why this matters: once DQE_READ_SOURCE=neon and the sheet is allowed to age,
 * a sustained Neon read outage degrades SILENTLY to the (possibly stale) sheet
 * -- the cut-over readers fall back correctly but emit only an ephemeral log.
 * This makes the streak visible.
 *
 * Returns { configured, source, status, at, label, message, count }:
 *   status 'ok'      - no recorded read failure (healthy, or never failed)
 *   status 'failing' - a failure is on record; `count` is the consecutive
 *                      streak, `at`/`label`/`message` describe the last one.
 * Best-effort: never throws; on any error returns a benign 'ok' shape.
 */
function computeNeonReadHealth_() {
  var out = { configured: false, source: 'sheet', status: 'ok',
              at: null, label: null, message: null, count: 0 };
  try {
    var props = PropertiesService.getScriptProperties();
    out.configured = !!props.getProperty('NEON_HOST');
    out.source = getDqeReadSource_();
    var raw = props.getProperty('NEON_READ_LAST_ERROR');
    if (!raw) return out;   // no failure on record
    var rec = JSON.parse(raw) || {};
    out.status  = 'failing';
    out.at      = rec.at || null;
    out.label   = rec.label || null;
    out.message = rec.message || null;
    out.count   = Number(rec.count) || 0;
    return out;
  } catch (e) {
    Logger.log('computeNeonReadHealth_ failed: ' + (e && e.message ? e.message : e));
    return out;
  }
}

/**
 * F2 divergence detector. The DQE pipeline writes the sheet first and mirrors
 * to dqe_history best-effort; a transient Neon outage during a build can leave
 * a date in the sheet but not in Neon. The dup-guard re-mirror (cdr-import
 * buildDQEHistoricalData) self-heals it on the next import of that date, but
 * until then a `DQE_READ_SOURCE=neon` deployment would serve data missing that
 * date with no surfaced signal. This compares the SHEET's MAX(call_date)
 * against dqe_history's MAX(call_date) so an admin can spot the divergence in
 * the Alerts modal.
 *
 * Returns { configured, status, sheetMax, neonMax, gapDays }:
 *   'unconfigured' - NEON_HOST not set (Neon mirror not used here) -> hidden
 *   'error'        - Neon configured but the MAX query failed/returned nothing
 *   'ok'           - neonMax >= sheetMax (mirror current, or ahead of a pruned
 *                    sheet) -> gapDays 0
 *   'behind'       - neonMax < sheetMax: the mirror is stale by gapDays.
 *                    Re-import the missing date(s) (the dup-guard re-mirror
 *                    heals it) or run backfillDQEHistoryUpsert().
 *
 * NOTE: this is a MAX-date proxy (the audit's lightweight check) -- it reliably
 * catches the common "most-recent date(s) un-mirrored" outage but not an
 * interior gap where both ends mirrored. Best-effort: never throws.
 */
function computeNeonMirrorHealth_() {
  var out = { configured: false, status: 'unconfigured',
              sheetMax: null, neonMax: null, gapDays: null };
  try {
    if (!PropertiesService.getScriptProperties().getProperty('NEON_HOST')) return out;
    out.configured = true;
    // Source-INDEPENDENT sheet max (NOT getLatestDataDate, which reads Neon
    // when DQE_READ_SOURCE=neon -- that would compare Neon against itself).
    out.sheetMax = dqeSheetMaxDate_();
    out.neonMax  = neonGetMaxDqeDate_();
    if (!out.neonMax) { out.status = 'error'; return out; }
    if (!out.sheetMax) { out.status = 'ok'; return out; }   // nothing to compare
    if (out.neonMax >= out.sheetMax) { out.status = 'ok'; out.gapDays = 0; return out; }
    out.status = 'behind';
    out.gapDays = neonMirrorGapDays_(out.neonMax, out.sheetMax);
    return out;
  } catch (e) {
    Logger.log('computeNeonMirrorHealth_ failed: ' + (e && e.message ? e.message : e));
    out.status = 'error';
    return out;
  }
}

/**
 * Source-independent MAX(call_date) from the DQE Historical Data SHEET, as a
 * 'yyyy-MM-dd' string (or null). Scans only the date column. Used by the F2
 * divergence detector so it always reflects the sheet regardless of
 * DQE_READ_SOURCE. Best-effort: null on any error.
 */
function dqeSheetMaxDate_() {
  try {
    var ss = openSpreadsheet_();
    var sheet = ss.getSheetByName(SHEETS.HISTORICAL);
    if (!sheet) return null;
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return null;
    var ssTZ = ss.getSpreadsheetTimeZone();
    var values = sheet.getRange(2, HISTORICAL_COLS.DATE, lastRow - 1, 1).getValues();
    var max = '';
    for (var i = 0; i < values.length; i++) {
      var iso = rowDateIso_(values[i][0], ssTZ);
      if (iso && iso > max) max = iso;
    }
    return max || null;
  } catch (e) {
    Logger.log('dqeSheetMaxDate_ failed: ' + (e && e.message ? e.message : e));
    return null;
  }
}

/** Calendar-day gap between two 'yyyy-MM-dd' strings (sheetMax - neonMax). */
function neonMirrorGapDays_(neonMax, sheetMax) {
  try {
    var a = new Date(neonMax  + 'T00:00:00Z').getTime();
    var b = new Date(sheetMax + 'T00:00:00Z').getTime();
    if (isNaN(a) || isNaN(b)) return null;
    return Math.round((b - a) / 86400000);
  } catch (e) { return null; }
}

/**
 * Editor-run drift check for the DQE history backfill (the "before you paste
 * older rows" gate). Reads the OLD spreadsheet's DQE sheet + the CURRENT
 * `DQE Historical Data`, finds the (date, agent) keys present in BOTH (the
 * overlap window), and reports how many match exactly vs differ on the core
 * metric columns -- so you can quantify any calculation drift before relying
 * on the older data for the trend charts.
 *
 * Durations are compared via getDisplayValues (TZ-agnostic strings, INV-02),
 * so a different spreadsheet timezone on the old workbook doesn't create false
 * mismatches. Read-only; never writes.
 *
 * Use the `runHistoricalBackfillCheck` wrapper (the Run picker hides
 * `_`-suffixed functions); edit OLD_SS_ID / OLD_SHEET there first.
 */
function validateHistoricalDqeBackfill_(oldSsId, oldSheetName) {
  var readDqe = function (ss, sheetName) {
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) throw new Error('Sheet "' + sheetName + '" not found in ' + ss.getId());
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return {};
    var tz = ss.getSpreadsheetTimeZone();
    var numCols = HISTORICAL_COLS.CSR_AVG_ABD_WAIT;
    var range = sheet.getRange(2, 1, lastRow - 1, numCols);
    var vals = range.getValues();
    var disp = range.getDisplayValues();
    var out = {};
    for (var i = 0; i < vals.length; i++) {
      var r = vals[i], rd = disp[i];
      var iso = rowDateIso_(r[HISTORICAL_COLS.DATE - 1], tz);
      var agent = String(r[HISTORICAL_COLS.AGENT - 1] || '').trim();
      if (!iso || !agent) continue;
      out[iso + '|' + agent] = {
        unique:   Number(r[HISTORICAL_COLS.TOTAL_UNIQUE - 1])   || 0,
        rung:     Number(r[HISTORICAL_COLS.TOTAL_RUNG - 1])     || 0,
        missed:   Number(r[HISTORICAL_COLS.TOTAL_MISSED - 1])   || 0,
        answered: Number(r[HISTORICAL_COLS.TOTAL_ANSWERED - 1]) || 0,
        tttSec:   parseHmsDisplay_(rd[HISTORICAL_COLS.TTT - 1]),
        attSec:   parseHmsDisplay_(rd[HISTORICAL_COLS.ATT - 1]),
      };
    }
    return out;
  };

  var oldRows = readDqe(SpreadsheetApp.openById(oldSsId), oldSheetName);
  var curRows = readDqe(openSpreadsheet_(), SHEETS.HISTORICAL);

  var FIELDS = ['unique', 'rung', 'missed', 'answered', 'tttSec', 'attSec'];
  var overlap = 0, matches = 0, mismatches = [];
  Object.keys(oldRows).forEach(function (k) {
    if (!curRows[k]) return;   // not in the overlap window
    overlap++;
    var o = oldRows[k], c = curRows[k], diffs = [];
    FIELDS.forEach(function (f) {
      if (String(o[f]) !== String(c[f])) diffs.push(f + ' old=' + o[f] + ' cur=' + c[f]);
    });
    if (diffs.length) mismatches.push(k + ' :: ' + diffs.join(', '));
    else matches++;
  });

  Logger.log('=== DQE backfill drift check ===');
  Logger.log('old rows: %s | current rows: %s', Object.keys(oldRows).length, Object.keys(curRows).length);
  Logger.log('overlapping (date|agent) keys: %s', overlap);
  Logger.log('exact matches: %s | mismatches: %s', matches, mismatches.length);
  mismatches.slice(0, 15).forEach(function (m) { Logger.log('   %s', m); });
  if (overlap === 0) {
    Logger.log('NOTE: no overlap -- the old sheet and current DQE Historical Data share no '
             + '(date, agent) keys, so drift can\'t be measured. Check the date ranges/sheet name.');
  } else {
    var pct = Math.round((matches / overlap) * 1000) / 10;
    Logger.log('=== %s%% of overlapping rows match exactly ===', pct);
    Logger.log(mismatches.length === 0
      ? 'CLEAN -- the older data was computed the same way; safe to paste the pre-overlap rows.'
      : 'DRIFT -- review the mismatches above to decide if the older data is close enough for trend context.');
  }
  return { overlap: overlap, matches: matches, mismatches: mismatches.length };
}

/**
 * Editor wrapper for validateHistoricalDqeBackfill_ (the Run picker hides
 * `_`-suffixed functions). Edit OLD_SS_ID + OLD_SHEET to point at the
 * spreadsheet holding your Nov-2024+ DQE history, then Run this and read the
 * Execution log.
 */
function runHistoricalBackfillCheck() {
  assertAdmin_();   // F-28: editor-run wrapper, but the bare name is RPC-reachable
  var OLD_SS_ID = 'PASTE_OLD_SPREADSHEET_ID_HERE';   // <-- edit
  var OLD_SHEET = 'DQE Historical Data';             // <-- edit if the old tab is named differently
  if (OLD_SS_ID === 'PASTE_OLD_SPREADSHEET_ID_HERE') {
    Logger.log('Edit OLD_SS_ID (and OLD_SHEET if needed) in runHistoricalBackfillCheck first.');
    return;
  }
  return validateHistoricalDqeBackfill_(OLD_SS_ID, OLD_SHEET);
}



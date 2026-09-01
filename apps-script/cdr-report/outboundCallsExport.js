// ============================================================================
// outboundCallsExport.js — mirror Neon `outbound_calls` into a CDR Report tab
// ----------------------------------------------------------------------------
// The outbound twin of inboundCallsExport.js, and the KEYSTONE of the
// Neon-outage story: `outbound_calls` (written by cdr-import/outboundCalls.js)
// had NO sheet primary and no fallback copy, so a Neon outage took THREE
// surfaces fully dark at once -- the Outbound report, the call-path drill's
// OUTBOUND arm (`getCallJourney({kind:'outbound'})`), and Caller Lookup's
// outbound section. This tab is the durable copy those three degrade to.
//
// It deliberately mirrors inboundCallsExport.js function-for-function (same
// refresh-in-window semantics, the same F-10 date-coercion normalizer, the
// same R8-E3 per-date replace, the same journey retention window, the same
// prune + Pipeline Health trigger shape) so the two are read and maintained
// as one pattern. Where a rule differs it is because the DATA differs, and
// the difference is commented.
//
// exportOutboundCalls(fromIso?, toIso?) -- EDITOR-RUN (also schedulable):
//   - No args: refreshes from the last date already in the "Outbound Calls"
//     tab through today (first run seeds the last 30 days), starting AT that
//     last date so late/re-imported rows are picked up, never skipped.
//   - Explicit range: refreshes exactly that [from, to] window.
//   Both DELETE the sheet's rows for the DATES the fetch returned before
//   appending, so re-runs are idempotent and Neon corrections propagate,
//   while dates Neon no longer has keep their fallback rows (R8-E3).
//
// PHI: `callee_hash` is the HMAC, never a raw number -- the same hash space
// Caller Lookup queries by, which is what makes the fallback lookup possible.
// `journey` is already MASKED at capture (a phone-shaped callee renders
// "(external number)"), so no raw number reaches this tab either.
// Fetches via json_agg (one rs.getString) -- per-row JDBC is ~0.5s/row.
// Reuses getNeonConn() from dbHistorical.js.
// ============================================================================

var OUTBOUND_EXPORT_SHEET = 'Outbound Calls';

// Column order is a CONTRACT: OutboundReport.gs / CallerLookup.gs read this
// tab BY POSITION (the Inbound tab's cols 16-17 / 18-22 lesson). Append any
// future column at the END, never between.
var OUTBOUND_EXPORT_HEADERS = [
  'Call Date', 'Call ID', 'Callee Hash', 'Agent Name', 'Agent Ext',
  'Department', 'Connected', 'Talk Sec', 'Ring Sec', 'Attempts',
  'Call Start', 'Journey',
];
// 1-indexed positions used by the writer + the dashboard readers.
var OUTBOUND_EXPORT_CALL_START_COL = 11;   // time-shaped -> plain-text before write
var OUTBOUND_EXPORT_JOURNEY_COL = 12;

var OUTBOUND_EXPORT_SEED_DAYS = 30;              // first-run lookback when the tab is empty
var OUTBOUND_EXPORT_JOURNEY_DAYS_DEFAULT = 90;   // OUTBOUND_EXPORT_JOURNEY_DAYS overrides
var OUTBOUND_EXPORT_TRIGGER_HOUR = 9;            // script TZ (America/Chicago)
var OUTBOUND_EXPORT_KEEP_DAYS_DEFAULT = 400;     // OUTBOUND_EXPORT_KEEP_DAYS overrides

function oc_journeyDays_() {
  var v = parseInt(PropertiesService.getScriptProperties()
                     .getProperty('OUTBOUND_EXPORT_JOURNEY_DAYS'), 10);
  return (v > 0) ? v : OUTBOUND_EXPORT_JOURNEY_DAYS_DEFAULT;
}

function oc_isoToday_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}
function oc_isoDaysAgo_(n) {
  return Utilities.formatDate(new Date(Date.now() - n * 86400000),
                              Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

// F-10 (the date-string coercion class): col A is WRITTEN as "YYYY-MM-DD"
// but Sheets coerces date-shaped strings to Date VALUES, so getValues()
// returns Dates whose String() never matches the ISO pattern -- which
// silently broke the inbound twin's refresh-delete AND its incremental
// max-date detection. Normalize a col-A DISPLAY string (either shape) to ISO.
function oc_cellDateIso_(disp) {
  var s = String(disp == null ? '' : disp).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return '';
  var mm = ('0' + parseInt(m[1], 10)).slice(-2);
  var dd = ('0' + parseInt(m[2], 10)).slice(-2);
  return m[3] + '-' + mm + '-' + dd;
}

/**
 * Removes data rows whose Call Date (col A) is inside [startIso, endIso] AND
 * (when `onlyDates` is given) whose date the fresh fetch actually returned --
 * the R8-E3 per-date replace that keeps the fallback's rows for interior
 * dates Neon has lost. Crash-safe: kept rows + blank padding go back in ONE
 * setValues over the original height. Returns the removed count.
 */
function oc_removeRowsInRange_(sheet, startIso, endIso, onlyDates) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  var width = OUTBOUND_EXPORT_HEADERS.length;
  var range = sheet.getRange(2, 1, lastRow - 1, width);
  var values = range.getValues();
  var dateDisp = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
  var kept = [];
  var removed = 0;
  for (var i = 0; i < values.length; i++) {
    var d = oc_cellDateIso_(dateDisp[i][0]);
    if (d && d >= startIso && d <= endIso && (!onlyDates || onlyDates[d])) {
      removed++;
    } else {
      kept.push(values[i]);
    }
  }
  if (removed === 0) return 0;
  var blankRow = new Array(width).fill('');
  var newValues = kept.slice();
  while (newValues.length < values.length) newValues.push(blankRow.slice());
  range.setValues(newValues);
  return removed;
}

function exportOutboundCalls(fromIso, toIso) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(OUTBOUND_EXPORT_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(OUTBOUND_EXPORT_SHEET);
    sheet.getRange(1, 1, 1, OUTBOUND_EXPORT_HEADERS.length).setValues([OUTBOUND_EXPORT_HEADERS])
         .setFontWeight('bold').setBackground('#f3f4f6');
    sheet.setFrozenRows(1);
  }
  // Widen BEFORE touching any range past getMaxColumns (a getRange past it
  // THROWS -- REP-10), then rewrite the header row. Idempotent.
  if (sheet.getMaxColumns() < OUTBOUND_EXPORT_HEADERS.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(),
                             OUTBOUND_EXPORT_HEADERS.length - sheet.getMaxColumns());
  }
  sheet.getRange(1, 1, 1, OUTBOUND_EXPORT_HEADERS.length).setValues([OUTBOUND_EXPORT_HEADERS]);
  var lastRow = sheet.getLastRow();
  var hasData = lastRow >= 2;

  var endIso = toIso || oc_isoToday_();
  var startIso;
  if (fromIso) {
    startIso = fromIso;
  } else if (hasData) {
    var existing = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues()
                        .map(function (r) { return oc_cellDateIso_(r[0]); })
                        .filter(function (s) { return !!s; });
    var maxIso = existing.sort().pop();
    startIso = maxIso || oc_isoDaysAgo_(OUTBOUND_EXPORT_SEED_DAYS);
  } else {
    startIso = oc_isoDaysAgo_(OUTBOUND_EXPORT_SEED_DAYS);
  }
  if (startIso > endIso) {
    Logger.log('exportOutboundCalls: nothing to refresh (start %s > end %s).', startIso, endIso);
    return { written: 0, replaced: 0 };
  }

  var conn = getNeonConn();
  try {
    // A not-yet-created outbound_calls table is a CLEAN skip, not an error:
    // the dashboard can be deployed ahead of the capture (the NeonCoverage
    // ncMissingTableError_ precedent), and a daily trigger must not log a
    // failure row for it every morning.
    var exists = false;
    try {
      var chk = conn.createStatement();
      var crs = chk.executeQuery("SELECT to_regclass('public.outbound_calls') IS NOT NULL AS ok");
      exists = crs.next() ? String(crs.getString('ok')) === 'true' : false;
      crs.close(); chk.close();
    } catch (eChk) { exists = false; }
    if (!exists) {
      Logger.log('exportOutboundCalls: outbound_calls does not exist yet — nothing to export.');
      return { written: 0, replaced: 0, skipped: 'no-table' };
    }

    var sql =
      "SELECT COALESCE(json_agg(json_build_array(" +
      "o.call_date::text, o.call_id, COALESCE(o.callee_hash,''), " +
      "COALESCE(o.agent_name,''), COALESCE(o.agent_ext,''), COALESCE(o.department,''), " +
      "COALESCE(o.connected, FALSE), COALESCE(o.talk_seconds,0), " +
      "COALESCE(o.ring_seconds,0), COALESCE(o.attempts,0), " +
      "COALESCE(o.call_start,''), " +
      // Journey only within the retention window -- it is the only HEAVY
      // column, and the 400-day row retention stays cheap without it.
      "CASE WHEN o.call_date >= ?::date THEN COALESCE(o.journey,'') ELSE '' END" +
      ") ORDER BY o.call_date, o.call_id), '[]')::text AS j " +
      "FROM outbound_calls o " +
      "WHERE o.call_date BETWEEN ?::date AND ?::date";
    var stmt = conn.prepareStatement(sql);
    stmt.setString(1, oc_isoDaysAgo_(oc_journeyDays_()));
    stmt.setString(2, startIso);
    stmt.setString(3, endIso);
    var rs = stmt.executeQuery();
    var json = rs.next() ? rs.getString('j') : '[]';
    cdrNoteEgress_(json ? json.length : 0, 'export:outbound');   // daily trigger
    rs.close(); stmt.close();

    var rows = JSON.parse(json || '[]');
    if (!rows.length) {
      // An unexpectedly empty Neon result must NEVER blank the fallback copy.
      Logger.log('exportOutboundCalls: no outbound_calls rows for %s..%s — sheet left untouched.',
                 startIso, endIso);
      return { written: 0, replaced: 0 };
    }
    var fetchedDates = {};
    for (var fd = 0; fd < rows.length; fd++) {
      if (rows[fd][0]) fetchedDates[String(rows[fd][0])] = true;
    }
    var replaced = oc_removeRowsInRange_(sheet, startIso, endIso, fetchedDates);
    var values = rows.map(function (r) {
      r[6] = r[6] === true ? 'TRUE' : (r[6] === false ? 'FALSE' : '');   // Connected
      // D-3: agent/department/journey strings originate in the external CDR
      // feed -- neutralize a leading =/+/@ so a crafted value can't land as a
      // live formula (typeof guard: helper lives in dashboardCDR.js, same
      // project global scope).
      return r.map(function (v) {
        if (v == null) return '';
        return (typeof crSheetSafeCell_ === 'function') ? crSheetSafeCell_(v) : v;
      });
    });
    // Plain-text Call Start BEFORE the write or Sheets coerces "10:23:33" to
    // an 1899-epoch time serial (the K-AC class). Full current height (so the
    // post-append sort can't move a time string onto an unformatted cell),
    // then -- after pre-expanding the grid so the append can't spill past
    // getMaxRows unformatted -- the EXACT write range.
    var writeStart = sheet.getLastRow() + 1;
    sheet.getRange(2, OUTBOUND_EXPORT_CALL_START_COL, sheet.getMaxRows() - 1, 1)
         .setNumberFormat('@');
    var rowsShort = writeStart + values.length - 1 - sheet.getMaxRows();
    if (rowsShort > 0) sheet.insertRowsAfter(sheet.getMaxRows(), rowsShort);
    sheet.getRange(writeStart, OUTBOUND_EXPORT_CALL_START_COL, values.length, 1)
         .setNumberFormat('@');
    sheet.getRange(writeStart, 1, values.length, OUTBOUND_EXPORT_HEADERS.length).setValues(values);
    var finalLastRow = sheet.getLastRow();
    if (finalLastRow > 2) {
      sheet.getRange(2, 1, finalLastRow - 1, OUTBOUND_EXPORT_HEADERS.length)
           .sort({ column: 1, ascending: true });
    }
    Logger.log('exportOutboundCalls: wrote %s rows for %s..%s (%s replaced; sheet now %s rows).',
               values.length, startIso, endIso, replaced, finalLastRow - 1);
    return { written: values.length, replaced: replaced };
  } finally {
    try { conn.close(); } catch (ce) {}
  }
}

/**
 * Drops rows older than the keep window (OUTBOUND_EXPORT_KEEP_DAYS, default
 * 400 days). The tab is date-sorted ascending, so the prune is a contiguous
 * head block -- one deleteRows call. Returns the pruned count.
 */
function oc_pruneOldRows_(sheet) {
  var keep = parseInt(PropertiesService.getScriptProperties()
                        .getProperty('OUTBOUND_EXPORT_KEEP_DAYS'), 10);
  if (!(keep > 0)) keep = OUTBOUND_EXPORT_KEEP_DAYS_DEFAULT;
  var cutoffIso = oc_isoDaysAgo_(keep);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  var disp = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
  var n = 0;
  while (n < disp.length) {
    var d = oc_cellDateIso_(disp[n][0]);
    if (d && d < cutoffIso) n++; else break;
  }
  if (n > 0) sheet.deleteRows(2, n);
  return n;
}

/** Trigger handler: incremental export + prune, one Pipeline Health row. */
function runOutboundCallsExport_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var t0 = Date.now();
  try {
    var res = exportOutboundCalls() || { written: 0, replaced: 0 };
    var pruned = 0;
    var sheet = ss.getSheetByName(OUTBOUND_EXPORT_SHEET);
    if (sheet) pruned = oc_pruneOldRows_(sheet);
    if (typeof logPipelineHealth_ === 'function') {
      logPipelineHealth_(ss, {
        step: 'outboundExport', status: 'success', rows: res.written,
        durationMs: Date.now() - t0,
        notes: res.replaced + ' replaced, ' + pruned + ' pruned'
               + (res.skipped ? (' (' + res.skipped + ')') : ''),
      });
    }
  } catch (e) {
    // Neon-down is the EXPECTED failure here (the copy just stays at its last
    // good date), so this path is log + Pipeline Health only -- never email.
    if (typeof logPipelineHealth_ === 'function') {
      logPipelineHealth_(ss, {
        step: 'outboundExport', status: 'failure',
        durationMs: Date.now() - t0,
        notes: String((e && e.message) || e),
      });
    }
    Logger.log('runOutboundCallsExport_ failed (expected during a Neon outage): '
               + ((e && e.message) || e));
  }
}

function installOutboundExportTrigger() {
  uninstallOutboundExportTrigger();
  ScriptApp.newTrigger('runOutboundCallsExport_')
    .timeBased().everyDays(1).atHour(OUTBOUND_EXPORT_TRIGGER_HOUR).create();
  Logger.log('Outbound export trigger installed (daily at %s:00 script-TZ).',
             OUTBOUND_EXPORT_TRIGGER_HOUR);
}

function uninstallOutboundExportTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runOutboundCallsExport_') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  Logger.log('Outbound export trigger: removed %s existing trigger(s).', removed);
}

/** Editor/menu-callable one-shot (same body the trigger runs). */
function runOutboundCallsExportNow() { runOutboundCallsExport_(); }

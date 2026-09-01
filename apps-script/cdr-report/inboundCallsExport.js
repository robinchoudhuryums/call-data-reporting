// ============================================================================
// inboundCallsExport.js — mirror Neon `inbound_calls` into a CDR Report tab
// ----------------------------------------------------------------------------
// A durable, pivot-friendly fallback copy of the per-call inbound data that
// lives in Neon (written by cdr-import/inboundCalls.js). The dashboard's
// Inbound report is the live analytical surface; this sheet is the
// navigable/malleable store that survives a Neon outage.
//
// exportInboundCalls(fromIso?, toIso?) -- EDITOR-RUN (also schedulable):
//   - With no args: REFRESHES from the last date already in the
//     "Inbound Calls" tab through today (first run seeds the last 30 days).
//     Starting AT the last exported date (not the day after) + the
//     delete-then-append below means rows that landed in Neon AFTER the
//     previous export run (late import, re-import) are picked up instead
//     of being skipped forever.
//   - With an explicit range: refreshes exactly that [from, to] window.
//   Both paths DELETE the sheet's existing rows inside the window before
//   appending the fresh Neon rows, so re-runs are idempotent (no
//   duplicates) and corrections that were DO-UPDATE'd into Neon (e.g. a
//   force re-import) propagate into this fallback copy.
//
// Joins insurance_numbers so each call carries its insurer label (blank when
// unlabeled / anonymous). Fetches via json_agg (one rs.getString) so it stays
// fast over thousands of rows -- per-row JDBC reads would take many minutes.
// Reuses getNeonConn() from dbHistorical.js.
// ============================================================================

var INBOUND_EXPORT_SHEET = 'Inbound Calls';
// Cols 16-17 (Call Start / Is Internal) were APPENDED for the dashboard's
// heatmap sheet fallback (InboundReport.gs::inboundHeatmapSheetFallback_
// reads them BY POSITION) -- append any future column after them, never
// between. Call Start is a time-shaped string ("10:23:33", raw PST) and is
// plain-text (@) formatted before every write, or Sheets coerces it to an
// 1899-epoch time serial (the K-AC coercion class).
var INBOUND_EXPORT_HEADERS = [
  'Call Date', 'Call ID', 'Insurer', 'Caller Hash', 'Dial-In', 'Disposition',
  'Abandon Stage', 'Abandoned On Hold', 'Hold Sec', 'Wait Sec',
  'Entry Queue', 'Final Queue', 'Final Dept', '# Queues', '# Transfers',
  'Call Start', 'Is Internal',
  // Cols 18-22: the call-path drill's sheet fallback
  // (InboundReport.gs::inboundCallJourneySheetFallback_ reads them BY
  // POSITION, like the heatmap's 16-17). Journey is the masked leg-by-leg
  // JSON (starts with '[', so it is NOT formula-leading and needs no '@'
  // format -- unlike Call Start); it is the tab's only HEAVY column
  // (0.2-6 KB/row), so it is populated only within
  // INBOUND_EXPORT_JOURNEY_DAYS and blank beyond -- the 400-day row
  // retention stays cheap while the path fallback covers what the sheet
  // can afford. The origin/related columns are small and always exported.
  'Journey', 'Origin Agent', 'Origin Dept', 'Related Call Id', 'Related Call Kind'
];
var INBOUND_EXPORT_CALL_START_COL = 16;   // plain-texted every run (see above)
var INBOUND_EXPORT_SEED_DAYS = 30;   // first-run lookback when the tab is empty
// Journey-cell retention: rows whose call_date is older than this many days
// export a BLANK Journey cell (Script Property INBOUND_EXPORT_JOURNEY_DAYS
// overrides). The path drill's sheet fallback then serves the entry->final
// SUMMARY for those dates instead of the full timeline -- disclosed, never
// silently truncated. Sized against the whole-spreadsheet 10M-cell ceiling:
// journey cells are the only ones that matter to it.
var INBOUND_EXPORT_JOURNEY_DAYS_DEFAULT = 90;

function ic_journeyDays_() {
  var v = parseInt(PropertiesService.getScriptProperties()
                     .getProperty('INBOUND_EXPORT_JOURNEY_DAYS'), 10);
  return (v > 0) ? v : INBOUND_EXPORT_JOURNEY_DAYS_DEFAULT;
}

function ic_isoToday_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}
function ic_isoDaysAgo_(n) {
  return Utilities.formatDate(new Date(Date.now() - n * 86400000),
                              Session.getScriptTimeZone(), 'yyyy-MM-dd');
}
/**
 * Removes existing data rows whose Call Date (col A) falls inside
 * [startIso, endIso] so the caller can re-append fresh Neon rows for the
 * window without duplicating. Crash-safe: kept rows + blank padding are
 * written back in ONE setValues over the original data height (same
 * pattern as autoImport's deleteHistoricalRowsForDate), so a mid-write
 * failure can't leave the sheet half-cleared. Returns the removed count.
 */
// F-10: col A is written as "YYYY-MM-DD" strings, but Sheets auto-coerces
// date-shaped strings into Date VALUES, so getValues() returns Dates whose
// String() form never matches /^\d{4}-\d{2}-\d{2}$/ -- which silently broke
// BOTH the refresh-in-window delete (0 rows ever removed -> a duplicate
// ~30-day window appended on every no-arg run) and the incremental max-date
// detection (fell back to the 30-day seed forever). Normalize a col-A
// DISPLAY string ("2026-06-22" pre-coercion, "6/22/2026" post-coercion)
// to ISO; '' when it isn't a date. Same class + fix as Direct Call
// History's dcDateIso_ (see CLAUDE.md's date-string coercion gotcha).
function ic_cellDateIso_(disp) {
  var s = String(disp == null ? '' : disp).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return '';
  var mm = ('0' + parseInt(m[1], 10)).slice(-2);
  var dd = ('0' + parseInt(m[2], 10)).slice(-2);
  return m[3] + '-' + mm + '-' + dd;
}

// R8-E3: optional `onlyDates` (dict of ISO date -> true) narrows the delete
// to rows whose date the fresh Neon fetch actually RETURNED. The sheet is
// the durable fallback copy that "survives a Neon outage" -- the old
// whole-window delete erased the fallback's rows for interior dates Neon
// had lost (or that predate capture), replacing the unique surviving copy
// with nothing. Per-date replace preserves exactly the fallback property.
function ic_removeRowsInRange_(sheet, startIso, endIso, onlyDates) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  var width = INBOUND_EXPORT_HEADERS.length;
  var range = sheet.getRange(2, 1, lastRow - 1, width);
  var values = range.getValues();
  // Parallel col-A DISPLAY read for the date test (F-10) -- `values` stays
  // the write-back source so kept rows round-trip unchanged.
  var dateDisp = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
  var kept = [];
  var removed = 0;
  for (var i = 0; i < values.length; i++) {
    var d = ic_cellDateIso_(dateDisp[i][0]);
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

function exportInboundCalls(fromIso, toIso) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(INBOUND_EXPORT_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(INBOUND_EXPORT_SHEET);
    sheet.getRange(1, 1, 1, INBOUND_EXPORT_HEADERS.length).setValues([INBOUND_EXPORT_HEADERS])
         .setFontWeight('bold').setBackground('#f3f4f6');
    sheet.setFrozenRows(1);
  }
  // Schema upgrade for pre-extension tabs (15 cols): widen BEFORE any range
  // past getMaxColumns is touched (a getRange past it THROWS, REP-10), then
  // refresh the header row so the appended Call Start / Is Internal headers
  // exist. Idempotent -- a current tab is untouched by the widen and the
  // header rewrite is byte-identical.
  if (sheet.getMaxColumns() < INBOUND_EXPORT_HEADERS.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(),
                             INBOUND_EXPORT_HEADERS.length - sheet.getMaxColumns());
  }
  sheet.getRange(1, 1, 1, INBOUND_EXPORT_HEADERS.length).setValues([INBOUND_EXPORT_HEADERS]);
  var lastRow = sheet.getLastRow();
  var hasData = lastRow >= 2;

  // Resolve the window. The incremental (no-arg) path starts AT the last
  // exported date -- not the day after -- so that day is re-fetched and
  // refreshed: rows that landed in Neon after the previous export run
  // (a later import, or a force re-import that DO-UPDATE'd the date)
  // would otherwise be skipped forever.
  var endIso = toIso || ic_isoToday_();
  var startIso;
  if (fromIso) {
    startIso = fromIso;
  } else if (hasData) {
    var existing = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues()
                        .map(function (r) { return ic_cellDateIso_(r[0]); })
                        .filter(function (s) { return !!s; });
    var maxIso = existing.sort().pop();
    startIso = maxIso || ic_isoDaysAgo_(INBOUND_EXPORT_SEED_DAYS);
  } else {
    startIso = ic_isoDaysAgo_(INBOUND_EXPORT_SEED_DAYS);
  }
  if (startIso > endIso) {
    Logger.log('exportInboundCalls: nothing to refresh (start %s > end %s).', startIso, endIso);
    return { written: 0, replaced: 0 };
  }

  var conn = getNeonConn();
  try {
    // Aggregate the whole result set to ONE json string (json_agg) and fetch
    // it with a single getString -- per-row JDBC reads are ~0.5s/row.
    var sql =
      "SELECT COALESCE(json_agg(json_build_array(" +
      "c.call_date::text, c.call_id, COALESCE(i.insurance_name,''), " +
      "COALESCE(c.caller_hash,''), COALESCE(c.dial_in_number,''), c.disposition, " +
      "COALESCE(c.abandon_stage,''), c.abandoned_on_hold, c.hold_seconds, c.wait_seconds, " +
      "COALESCE(c.entry_queue,''), COALESCE(c.final_queue,''), COALESCE(c.final_dept,''), " +
      "c.num_queues, c.num_transfers, COALESCE(c.call_start,''), " +
      "COALESCE(c.is_internal, FALSE), " +
      // Journey only within the retention window (see ic_journeyDays_ above);
      // the small origin/related columns always.
      "CASE WHEN c.call_date >= ?::date THEN COALESCE(c.journey,'') ELSE '' END, " +
      "COALESCE(c.origin_agent,''), COALESCE(c.origin_dept,''), " +
      "COALESCE(c.related_call_id,''), COALESCE(c.related_call_kind,'')" +
      ") ORDER BY c.call_date, c.call_id), '[]')::text AS j " +
      "FROM inbound_calls c " +
      "LEFT JOIN insurance_numbers i ON i.phone_hash = c.caller_hash " +
      "WHERE c.call_date BETWEEN ?::date AND ?::date";
    var stmt = conn.prepareStatement(sql);
    stmt.setString(1, ic_isoDaysAgo_(ic_journeyDays_()));
    stmt.setString(2, startIso);
    stmt.setString(3, endIso);
    var rs = stmt.executeQuery();
    var json = rs.next() ? rs.getString('j') : '[]';
    // Meter the read (post-fetch, best-effort, never gates the parse below).
    // This runs DAILY on a trigger and json_aggs a whole window, so it is one
    // of the two largest unmetered readers the transfer-cap round found.
    cdrNoteEgress_(json ? json.length : 0, 'export:inbound');
    rs.close(); stmt.close();

    var rows = JSON.parse(json || '[]');
    if (!rows.length) {
      // Don't touch existing sheet rows when Neon returns nothing for the
      // window -- an unexpectedly empty Neon result must not blank the
      // fallback copy.
      Logger.log('exportInboundCalls: no inbound_calls rows for %s..%s — sheet left untouched.', startIso, endIso);
      return { written: 0, replaced: 0 };
    }
    // Refresh-in-window: drop existing sheet rows for the DATES the fetch
    // actually returned (R8-E3 per-date replace) so the append below can't
    // duplicate them -- dates Neon no longer has keep their fallback rows.
    // Only done AFTER a non-empty fetch (above guard).
    var fetchedDates = {};
    for (var fd = 0; fd < rows.length; fd++) {
      if (rows[fd][0]) fetchedDates[String(rows[fd][0])] = true;
    }
    var replaced = ic_removeRowsInRange_(sheet, startIso, endIso, fetchedDates);
    // Normalize booleans/nulls for the sheet.
    var values = rows.map(function (r) {
      r[7] = r[7] === true ? 'TRUE' : (r[7] === false ? 'FALSE' : '');
      r[16] = r[16] === true ? 'TRUE' : (r[16] === false ? 'FALSE' : '');   // Is Internal
      // D-3: queue/insurer/journey strings originate in the external feed --
      // neutralize a leading =/+/@ so a crafted name can't land as a live
      // formula in this tab (typeof guard: helper lives in dashboardCDR.js,
      // same project global scope).
      return r.map(function (v) {
        if (v == null) return '';
        return (typeof crSheetSafeCell_ === 'function') ? crSheetSafeCell_(v) : v;
      });
    });
    // Plain-text the Call Start column BEFORE the write or Sheets coerces the
    // "10:23:33" strings to 1899-epoch time serials (the K-AC class). Two
    // ranges: the full current height (so the post-append SORT can never move
    // a time string onto an unformatted cell), plus -- after pre-expanding the
    // grid so the append can't spill past getMaxRows unformatted (the
    // buildDQE recurrence vector) -- the EXACT write range.
    var writeStart = sheet.getLastRow() + 1;
    sheet.getRange(2, INBOUND_EXPORT_CALL_START_COL, sheet.getMaxRows() - 1, 1)
         .setNumberFormat('@');
    var rowsShort = writeStart + values.length - 1 - sheet.getMaxRows();
    if (rowsShort > 0) sheet.insertRowsAfter(sheet.getMaxRows(), rowsShort);
    sheet.getRange(writeStart, INBOUND_EXPORT_CALL_START_COL, values.length, 1)
         .setNumberFormat('@');
    sheet.getRange(writeStart, 1, values.length, INBOUND_EXPORT_HEADERS.length).setValues(values);
    // Keep the tab chronological -- an explicit mid-history range would
    // otherwise leave its refreshed rows appended at the bottom. Same
    // post-write sort pattern the historical sheets use.
    var finalLastRow = sheet.getLastRow();
    if (finalLastRow > 2) {
      sheet.getRange(2, 1, finalLastRow - 1, INBOUND_EXPORT_HEADERS.length)
           .sort({ column: 1, ascending: true });
    }
    Logger.log('exportInboundCalls: wrote %s rows for %s..%s (%s replaced; sheet now %s rows).',
               values.length, startIso, endIso, replaced, finalLastRow - 1);
    return { written: values.length, replaced: replaced };
  } finally {
    try { conn.close(); } catch (ce) {}
  }
}

// ── Scheduled refresh (heatmap-sheet-fallback Phase 2) ───────────────────────
// Keeps the fallback copy fresh without an operator run. Daily time-driven
// trigger (menu-installed, the retention-prune pattern -- no *_ENABLED flag,
// so it stays off the six-engine readiness matrix); each run logs ONE
// `inboundExport` Pipeline Health row. Neon-down is the EXPECTED failure
// here (usage ceiling / free-tier suspend): the copy just stays at its last
// good date, so the failure path is log-only -- no email, ever. The prune
// keeps the tab bounded (the daily append would otherwise grow it without
// limit and slow every fallback read).

var INBOUND_EXPORT_TRIGGER_HOUR = 9;          // script TZ (America/Chicago)
var INBOUND_EXPORT_KEEP_DAYS_DEFAULT = 400;   // prune floor; INBOUND_EXPORT_KEEP_DAYS overrides

/**
 * Drops rows older than the keep window (INBOUND_EXPORT_KEEP_DAYS Script
 * Property, default 400 days). The tab is date-sorted ascending, so the
 * prune is a contiguous head block -- one deleteRows call. Returns the
 * pruned count.
 */
function ic_pruneOldRows_(sheet) {
  var keep = parseInt(PropertiesService.getScriptProperties()
                        .getProperty('INBOUND_EXPORT_KEEP_DAYS'), 10);
  if (!(keep > 0)) keep = INBOUND_EXPORT_KEEP_DAYS_DEFAULT;
  var cutoffIso = ic_isoDaysAgo_(keep);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  var disp = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
  var n = 0;
  while (n < disp.length) {
    var d = ic_cellDateIso_(disp[n][0]);
    if (d && d < cutoffIso) n++; else break;
  }
  if (n > 0) sheet.deleteRows(2, n);
  return n;
}

/** Trigger handler: incremental export + prune, one Pipeline Health row. */
function runInboundCallsExport_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var t0 = Date.now();
  try {
    var res = exportInboundCalls() || { written: 0, replaced: 0 };
    var pruned = 0;
    var sheet = ss.getSheetByName(INBOUND_EXPORT_SHEET);
    if (sheet) pruned = ic_pruneOldRows_(sheet);
    if (typeof logPipelineHealth_ === 'function') {
      logPipelineHealth_(ss, {
        step: 'inboundExport', status: 'success', rows: res.written,
        durationMs: Date.now() - t0,
        notes: res.replaced + ' replaced, ' + pruned + ' pruned',
      });
    }
  } catch (e) {
    if (typeof logPipelineHealth_ === 'function') {
      logPipelineHealth_(ss, {
        step: 'inboundExport', status: 'failure',
        durationMs: Date.now() - t0,
        notes: String((e && e.message) || e),
      });
    }
    Logger.log('runInboundCallsExport_ failed (expected during a Neon outage): '
               + ((e && e.message) || e));
  }
}

function installInboundExportTrigger() {
  uninstallInboundExportTrigger();
  ScriptApp.newTrigger('runInboundCallsExport_')
    .timeBased().everyDays(1).atHour(INBOUND_EXPORT_TRIGGER_HOUR).create();
  Logger.log('Inbound export trigger installed (daily at %s:00 script-TZ).',
             INBOUND_EXPORT_TRIGGER_HOUR);
}

function uninstallInboundExportTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runInboundCallsExport_') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  Logger.log('Inbound export trigger: removed %s existing trigger(s).', removed);
}

/** Editor/menu-callable one-shot (same body the trigger runs). */
function runInboundCallsExportNow() { runInboundCallsExport_(); }

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
var INBOUND_EXPORT_HEADERS = [
  'Call Date', 'Call ID', 'Insurer', 'Caller Hash', 'Dial-In', 'Disposition',
  'Abandon Stage', 'Abandoned On Hold', 'Hold Sec', 'Wait Sec',
  'Entry Queue', 'Final Queue', 'Final Dept', '# Queues', '# Transfers'
];
var INBOUND_EXPORT_SEED_DAYS = 30;   // first-run lookback when the tab is empty

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

function ic_removeRowsInRange_(sheet, startIso, endIso) {
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
    if (d && d >= startIso && d <= endIso) {
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
    return;
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
      "c.num_queues, c.num_transfers) ORDER BY c.call_date, c.call_id), '[]')::text AS j " +
      "FROM inbound_calls c " +
      "LEFT JOIN insurance_numbers i ON i.phone_hash = c.caller_hash " +
      "WHERE c.call_date BETWEEN ?::date AND ?::date";
    var stmt = conn.prepareStatement(sql);
    stmt.setString(1, startIso);
    stmt.setString(2, endIso);
    var rs = stmt.executeQuery();
    var json = rs.next() ? rs.getString('j') : '[]';
    rs.close(); stmt.close();

    var rows = JSON.parse(json || '[]');
    if (!rows.length) {
      // Don't touch existing sheet rows when Neon returns nothing for the
      // window -- an unexpectedly empty Neon result must not blank the
      // fallback copy.
      Logger.log('exportInboundCalls: no inbound_calls rows for %s..%s — sheet left untouched.', startIso, endIso);
      return;
    }
    // Refresh-in-window: drop any existing sheet rows inside [start, end]
    // so the append below can't duplicate them, then append the fresh
    // Neon rows. Only done AFTER a non-empty fetch (above guard).
    var replaced = ic_removeRowsInRange_(sheet, startIso, endIso);
    // Normalize booleans/nulls for the sheet.
    var values = rows.map(function (r) {
      r[7] = r[7] === true ? 'TRUE' : (r[7] === false ? 'FALSE' : '');
      return r.map(function (v) { return v == null ? '' : v; });
    });
    sheet.getRange(sheet.getLastRow() + 1, 1, values.length, INBOUND_EXPORT_HEADERS.length).setValues(values);
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
  } finally {
    try { conn.close(); } catch (ce) {}
  }
}

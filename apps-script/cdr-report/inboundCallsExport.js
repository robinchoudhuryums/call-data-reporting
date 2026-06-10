// ============================================================================
// inboundCallsExport.js — mirror Neon `inbound_calls` into a CDR Report tab
// ----------------------------------------------------------------------------
// A durable, pivot-friendly fallback copy of the per-call inbound data that
// lives in Neon (written by cdr-import/inboundCalls.js). The dashboard's
// Inbound report is the live analytical surface; this sheet is the
// navigable/malleable store that survives a Neon outage.
//
// exportInboundCalls(fromIso?, toIso?) -- EDITOR-RUN (also schedulable):
//   - With no args: APPENDS the days AFTER the last date already in the
//     "Inbound Calls" tab, through today (first run seeds the last 30 days).
//     Run it daily (or on a trigger) and it accumulates without duplicates.
//   - With an explicit range: appends exactly that [from, to] window.
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
function ic_isoNextDay_(iso) {
  var p = String(iso).split('-');
  var d = new Date(+p[0], +p[1] - 1, +p[2] + 1);
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
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

  // Resolve the window.
  var endIso = toIso || ic_isoToday_();
  var startIso;
  if (fromIso) {
    startIso = fromIso;
  } else if (hasData) {
    var existing = sheet.getRange(2, 1, lastRow - 1, 1).getValues()
                        .map(function (r) { return String(r[0]); })
                        .filter(function (s) { return /^\d{4}-\d{2}-\d{2}$/.test(s); });
    var maxIso = existing.sort().pop();
    startIso = maxIso ? ic_isoNextDay_(maxIso) : ic_isoDaysAgo_(INBOUND_EXPORT_SEED_DAYS);
  } else {
    startIso = ic_isoDaysAgo_(INBOUND_EXPORT_SEED_DAYS);
  }
  if (startIso > endIso) {
    Logger.log('exportInboundCalls: already current (start %s > end %s) — nothing to append.', startIso, endIso);
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
      Logger.log('exportInboundCalls: no inbound_calls rows for %s..%s.', startIso, endIso);
      return;
    }
    // Normalize booleans/nulls for the sheet.
    var values = rows.map(function (r) {
      r[7] = r[7] === true ? 'TRUE' : (r[7] === false ? 'FALSE' : '');
      return r.map(function (v) { return v == null ? '' : v; });
    });
    sheet.getRange(sheet.getLastRow() + 1, 1, values.length, INBOUND_EXPORT_HEADERS.length).setValues(values);
    Logger.log('exportInboundCalls: appended %s rows for %s..%s (sheet now %s rows).',
               values.length, startIso, endIso, sheet.getLastRow() - 1);
  } finally {
    try { conn.close(); } catch (ce) {}
  }
}

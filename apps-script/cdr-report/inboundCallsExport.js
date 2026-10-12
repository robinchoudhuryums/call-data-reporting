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
//     "Inbound Calls" tab through today (first run seeds the last 30 days),
//     starting AT that last date so its late rows are picked up -- PLUS
//     (TOOL-1, broad-scan 2026-10-12) every OLDER date whose Neon rows
//     changed since the previous run (`updated_at` past the stored
//     INBOUND_EXPORT_WATERMARK): a parked-then-fixed date, a force
//     re-import of an older day, the PC-1 name rewrite, the BF-1 ring
//     backfill. Before this, only the newest date was ever re-read, so
//     those corrections never reached the outage copy. At most
//     IC_EXPORT_MAX_CHANGED_DATES_ such dates per run, newest first; the
//     rest wait in INBOUND_EXPORT_PENDING for the next run.
//   - With an explicit range: refreshes exactly that [from, to] window.
//   Both paths APPEND the fresh Neon rows and only then remove the sheet's
//   older rows for the dates the fetch returned (TOOL-3: a failed append --
//   e.g. at the cell cap -- now leaves the previous copy in place), so
//   re-runs are idempotent (no duplicates) and corrections propagate.
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
  'Journey', 'Origin Agent', 'Origin Dept', 'Related Call Id', 'Related Call Kind',
  // Cols 23-24 (FO-2): the direct-line callback figures' sheet fallback
  // (OutboundReport.gs::obDirectSheetFallback_ reads them BY POSITION): the
  // first person the call rang (inbound_calls.first_agent, roster spelling)
  // and how long that ring lasted (first_ring_seconds, the misdial filter;
  // blank = unknown, never 0).
  'First Agent', 'First Ring Sec'
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
 * [startIso, endIso] (and in `onlyDates` when given) as contiguous blocks,
 * bottom-up; kept rows are never rewritten (CRT-1 below). With `maxRow`
 * (TOOL-3) only rows 2..maxRow are candidates -- the rows ABOVE a fresh
 * append -- and no padding is inserted (the appended rows already keep the
 * sheet from being emptied). Returns the removed count.
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
function ic_removeRowsInRange_(sheet, startIso, endIso, onlyDates, maxRow) {
  var lastRow = maxRow || sheet.getLastRow();
  if (lastRow < 2) return 0;
  // CRT-1 (broad-scan 2026-09-23): this used to read the whole tab with
  // getValues, drop the matching rows and setValues the KEPT rows back. A
  // cell neutralized with a leading apostrophe (crSheetSafeCell_) reads back
  // WITHOUT the apostrophe, so every daily re-export re-armed it as a live
  // formula in every kept row (the R8-3 mechanism) -- and only Call Start is
  // '@'-formatted. It now reads ONLY the date column (DISPLAY values, F-10)
  // and deletes the matching rows as contiguous blocks, bottom-up: kept rows
  // are never rewritten. Padding goes in FIRST (so a window covering every
  // data row never tries to delete all non-frozen rows, which Sheets refuses)
  // and leaves getMaxRows where it was.
  var dateDisp = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
  var matchRows = [];   // 1-based sheet rows, ascending
  for (var i = 0; i < dateDisp.length; i++) {
    var d = ic_cellDateIso_(dateDisp[i][0]);
    if (d && d >= startIso && d <= endIso && (!onlyDates || onlyDates[d])) matchRows.push(i + 2);
  }
  if (!matchRows.length) return 0;
  var blocks = [];
  var bStart = matchRows[0], prev = matchRows[0];
  for (var k = 1; k < matchRows.length; k++) {
    if (matchRows[k] === prev + 1) { prev = matchRows[k]; continue; }
    blocks.push([bStart, prev - bStart + 1]);
    bStart = prev = matchRows[k];
  }
  blocks.push([bStart, prev - bStart + 1]);
  if (!maxRow) sheet.insertRowsAfter(sheet.getMaxRows(), matchRows.length);
  for (var b = blocks.length - 1; b >= 0; b--) sheet.deleteRows(blocks[b][0], blocks[b][1]);
  return matchRows.length;
}

// TOOL-1: at most this many changed OLDER dates are re-read per run (newest
// first); the rest wait in INBOUND_EXPORT_PENDING. Bounds a one-off
// history-wide change (the PC-1 rewrite touches every date) to a few days a
// run instead of one huge read past the execution ceiling.
var IC_EXPORT_MAX_CHANGED_DATES_ = 10;
// The watermark is the run's START minus this margin (script clock vs Neon
// clock skew); a row changed inside the margin is simply re-read once more.
var IC_EXPORT_WATERMARK_MARGIN_MS_ = 3600000;

/** PURE (TOOL-1): merge changed + pending dates, newest first, cap; the rest stay pending. */
function ic_planChangedDates_(changed, pending, cap) {
  var seen = {};
  var all = [].concat(changed || [], pending || []).filter(function (d) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d)) || seen[d]) return false;
    seen[d] = true;
    return true;
  }).sort().reverse();
  return { now: all.slice(0, cap), later: all.slice(cap) };
}

/**
 * TOOL-1: the OLDER dates (before `beforeIso`, inside the keep window) whose
 * inbound_calls rows changed since `sinceIso` -- dates only, so the read is
 * tiny. Every insert/upsert sets updated_at = now(), and so do the one-off
 * correction UPDATEs in cdr-import (PC-1, BF-1).
 */
function ic_changedDatesSince_(conn, sinceIso, beforeIso, floorIso) {
  var stmt = conn.prepareStatement(
    "SELECT COALESCE(json_agg(d ORDER BY d), '[]')::text AS j FROM (" +
    "SELECT DISTINCT c.call_date::text AS d FROM inbound_calls c " +
    "WHERE c.updated_at > ?::timestamptz AND c.call_date < ?::date AND c.call_date >= ?::date) x");
  stmt.setString(1, sinceIso);
  stmt.setString(2, beforeIso);
  stmt.setString(3, floorIso);
  var rs = stmt.executeQuery();
  var json = rs.next() ? rs.getString('j') : '[]';
  rs.close(); stmt.close();
  var out = JSON.parse(json || '[]');
  return Array.isArray(out) ? out : [];
}

function ic_keepCutoffIso_() {
  var keep = parseInt(PropertiesService.getScriptProperties()
                        .getProperty('INBOUND_EXPORT_KEEP_DAYS'), 10);
  return ic_isoDaysAgo_((keep > 0) ? keep : INBOUND_EXPORT_KEEP_DAYS_DEFAULT);
}

/** One windowed json_agg read of inbound_calls (see the column notes inline). */
function ic_fetchRows_(conn, startIso, endIso) {
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
    "COALESCE(c.related_call_id,''), COALESCE(c.related_call_kind,''), " +
    // first_ring_seconds is read through to_jsonb so this export keeps
    // working when it runs before cdr-import has added the column (a
    // missing key reads NULL; a direct column reference would fail the
    // whole query). Do not "simplify" it to c.first_ring_seconds.
    "COALESCE(c.first_agent,''), (to_jsonb(c) ->> 'first_ring_seconds')::int" +
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
  return JSON.parse(json || '[]');
}

/**
 * Appends one window's fresh rows, THEN removes the older copy of the dates
 * the fetch returned (R8-E3 per-date replace). TOOL-3: the old order (delete,
 * then append) lost the window's rows until the next good run whenever the
 * append failed -- at the cell cap the grid insert is exactly what fails. A
 * failure in the removal rolls the append back (it is the bottom block until
 * the final sort), so a run never leaves both copies. Does not sort.
 */
function ic_writeWindow_(sheet, rows, startIso, endIso) {
  var fetchedDates = {};
  for (var fd = 0; fd < rows.length; fd++) {
    if (rows[fd][0]) fetchedDates[String(rows[fd][0])] = true;
  }
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
  var oldLastRow = sheet.getLastRow();
  var writeStart = oldLastRow + 1;
  sheet.getRange(2, INBOUND_EXPORT_CALL_START_COL, sheet.getMaxRows() - 1, 1)
       .setNumberFormat('@');
  var rowsShort = writeStart + values.length - 1 - sheet.getMaxRows();
  if (rowsShort > 0) sheet.insertRowsAfter(sheet.getMaxRows(), rowsShort);
  sheet.getRange(writeStart, INBOUND_EXPORT_CALL_START_COL, values.length, 1)
       .setNumberFormat('@');
  sheet.getRange(writeStart, 1, values.length, INBOUND_EXPORT_HEADERS.length).setValues(values);
  var replaced;
  try {
    replaced = ic_removeRowsInRange_(sheet, startIso, endIso, fetchedDates, oldLastRow);
  } catch (e) {
    try {
      var lr = sheet.getLastRow();
      sheet.deleteRows(lr - values.length + 1, values.length);
    } catch (e2) { /* the rethrow below is the signal */ }
    throw e;
  }
  return { written: values.length, replaced: replaced };
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

  // TOOL-1: the watermark this run will store, taken at its START (minus a
  // clock-skew margin) so a row changed while the run is reading is re-read
  // next time rather than skipped.
  var props = PropertiesService.getScriptProperties();
  var runStartIso = new Date(Date.now() - IC_EXPORT_WATERMARK_MARGIN_MS_).toISOString();
  var conn;
  try { conn = getNeonConn(); } catch (eConn) {
    // TOOL-2: only a failure to CONNECT is the expected Neon outage; the
    // runner tags its row so the dashboard's failure watchdog stays quiet
    // for it (any other failure -- a SQL error, the cell cap -- still emails).
    if (eConn && typeof eConn === 'object') eConn.neonUnreachable = true;
    throw eConn;
  }
  try {
    var written = 0, replaced = 0, changedDone = [], changedLater = [];
    var rows = ic_fetchRows_(conn, startIso, endIso);
    if (rows.length) {
      // Only AFTER a non-empty fetch: an unexpectedly empty Neon result must
      // never blank the fallback copy (dates Neon no longer has keep theirs).
      var r0 = ic_writeWindow_(sheet, rows, startIso, endIso);
      written += r0.written; replaced += r0.replaced;
    } else {
      Logger.log('exportInboundCalls: no inbound_calls rows for %s..%s — window left untouched.', startIso, endIso);
    }
    if (!fromIso) {
      // TOOL-1: older dates whose Neon rows changed since the last run.
      var since = props.getProperty('INBOUND_EXPORT_WATERMARK');
      var pending = [];
      try { pending = JSON.parse(props.getProperty('INBOUND_EXPORT_PENDING') || '[]') || []; } catch (ep) { pending = []; }
      var floorIso = ic_keepCutoffIso_();
      var changed = since ? ic_changedDatesSince_(conn, since, startIso, floorIso) : [];
      var plan = ic_planChangedDates_(changed, pending.filter(function (d) { return d >= floorIso && d < startIso; }),
                                      IC_EXPORT_MAX_CHANGED_DATES_);
      for (var ci = 0; ci < plan.now.length; ci++) {
        var d = plan.now[ci];
        var dRows = ic_fetchRows_(conn, d, d);
        if (dRows.length) {
          var rd = ic_writeWindow_(sheet, dRows, d, d);
          written += rd.written; replaced += rd.replaced;
        }
        changedDone.push(d);
      }
      changedLater = plan.later;
      props.setProperty('INBOUND_EXPORT_WATERMARK', runStartIso);
      props.setProperty('INBOUND_EXPORT_PENDING', JSON.stringify(changedLater));
    }
    // Keep the tab chronological -- an explicit mid-history range and the
    // changed older dates are appended at the bottom. Same post-write sort
    // pattern the historical sheets use.
    var finalLastRow = sheet.getLastRow();
    if (written && finalLastRow > 2) {
      sheet.getRange(2, 1, finalLastRow - 1, INBOUND_EXPORT_HEADERS.length)
           .sort({ column: 1, ascending: true });
    }
    Logger.log('exportInboundCalls: wrote %s rows for %s..%s + %s changed older date(s) (%s replaced; %s still pending; sheet now %s rows).',
               written, startIso, endIso, changedDone.length, replaced, changedLater.length, finalLastRow - 1);
    return { written: written, replaced: replaced, changedDates: changedDone, pendingDates: changedLater.length };
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
// good date. TOOL-2 (owner 2026-10-12): that row's notes start with
// EXPORT_NEON_UNREACHABLE_TAG_, and the dashboard's Pipeline-failure watchdog
// does not email a tagged export row (the capture's own rows already report
// the outage); every OTHER export failure -- a SQL error, the cell cap --
// still emails. The Health page shows both kinds. The prune
// keeps the tab bounded (the daily append would otherwise grow it without
// limit and slow every fallback read).

// TOOL-2: the notes prefix of an export failure that is the expected Neon
// outage. The dashboard's PipelineWatch.gs keys on the SAME literal
// (PIPELINE_WATCH_QUIET_TAG_) -- cross-file-pins keeps them equal. Shared by
// outboundCallsExport.js (one project scope).
var EXPORT_NEON_UNREACHABLE_TAG_ = 'Neon unreachable (expected; copy kept): ';

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
        notes: ((e && e.neonUnreachable) ? EXPORT_NEON_UNREACHABLE_TAG_ : '') + String((e && e.message) || e),
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

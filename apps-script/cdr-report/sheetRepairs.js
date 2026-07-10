// ============================================================================
// sheetRepairs.js — one-off DQE Historical Data sheet repairs (cdr-report).
// ----------------------------------------------------------------------------
// Editor-run maintenance utilities. NOT part of the daily pipeline. Each is
// idempotent and safe to re-run. Run from the CDR Report Apps Script editor's
// Run dropdown (the picker hides `_`-suffixed helpers, so the two entry points
// below are non-underscore).
// ============================================================================


// -- Slot/abandoned-time coercion repair (cols K-AC + AF) --------------------
//
// Background: cols K-AC of "DQE Historical Data" hold comma-joined CST
// missed-time strings (e.g. "10:23:33,10:08:41"). A cell with a SINGLE
// timestamp ("10:23:33") gets auto-coerced by Google Sheets into a time VALUE
// (a date-time serial whose date part is the epoch, Dec 30 1899) UNLESS the
// column is plain text. Such a cell then renders as "12/30/1899" (or a raw
// serial decimal), so getDisplayValues() returns garbage instead of the time --
// breaking the Neon slot_* mirror and the Missed Calls report for that cell.
// Multi-value cells escape (not a parseable single time).
//
// AF (col 32, "Abandoned Missed Leg Times") holds the SAME kind of comma-joined
// H:MM:SS strings (built via pstToCSTStr, like K-AC) and coerces identically,
// so it is recovered here too. AD/AE (cols 30-31) are big-integer call IDs --
// NOT time columns -- and are handled separately by repairDqeAbandonedIds; the
// fractional-day recovery here would wrongly turn an ID into "0:00:00" (and,
// conversely, the abandoned-ID repair would wrongly mark a coerced AF time
// serial as "#REBUILD"), which is why AF belongs in THIS repair, not that one.
//
// The daily build now plain-text-protects K-AC going forward
// (buildDQEHistoricalData.js setNumberFormat('@')). This repairs rows that were
// already corrupted before that protection landed and whose Raw Data is gone
// (so a rebuild can't fix them).
//
// TZ-safe by design: it reads the numeric SERIAL (after a numeric-format lens)
// and derives the time arithmetically from the fractional day -- avoiding the
// 1899-LMT offset that getValue() would drag in on a date-typed cell (the same
// INV-02 hazard the rest of the codebase dodges via getDisplayValues).
//
// Usage:
//   1. (Recommended) Run previewDqeSlotTimestampRepair() first -- logs the
//      count + up to 12 "serial -> H:mm:ss" samples, writes NOTHING.
//   2. Run repairDqeSlotTimestamps() to apply: it locks K-AC + AF to plain text
//      and rewrites the recovered timestamps as text.
//   3. If DQE_READ_SOURCE=neon, re-mirror the affected dates afterward
//      (backfillDQEHistoryUpsert()) so dqe_history picks up the corrected rows.

/** Preview only: report what WOULD change; no writes. */
function previewDqeSlotTimestampRepair() {
  return repairDqeSlotTimestamps_(/*dryRun=*/true);
}

/** Apply the repair: recover coerced slot timestamps and store them as text. */
function repairDqeSlotTimestamps() {
  return repairDqeSlotTimestamps_(/*dryRun=*/false);
}

function repairDqeSlotTimestamps_(dryRun) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('DQE Historical Data');
  if (!sheet) { Logger.log('repairDqeSlotTimestamps: sheet "DQE Historical Data" not found.'); return; }
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('repairDqeSlotTimestamps: no data rows.'); return; }
  var n = lastRow - 1;

  // Two time-of-day column groups that coerce IDENTICALLY: the 19 slot columns
  // K-AC (missed times) and AF (abandoned missed-leg times). Both hold
  // comma-joined H:MM:SS strings, and a SINGLE-value cell auto-coerces to a time
  // serial the same way. AD/AE (cols 30-31) are big-integer call IDs -- NOT time
  // columns -- and are DELIBERATELY excluded: the fractional-day recovery below
  // would turn an integer ID into "0:00:00" (those are handled by
  // repairDqeAbandonedIds).
  var groups = [
    { label: 'K-AC', start: 11, count: 19 },          // HISTORICAL_COLS TIME_SLOTS_START..END
    { label: 'AF',   start: 32, count: 1  }            // Abandoned Missed Leg Times
  ];

  var fixed = 0, samples = [];
  var pending = [];                                    // [{ range, vals }] to write back on apply
  for (var g = 0; g < groups.length; g++) {
    var start = groups[g].start, label = groups[g].label;
    var range = sheet.getRange(2, start, n, groups[g].count);

    // F-52: snapshot the existing per-cell formats so the DRY RUN can
    // restore them EXACTLY. The preview previously restored '@' (plain
    // text), which changed what every getDisplayValues consumer -- the
    // Missed report's sheet path, the Neon backfills -- saw for
    // still-coerced cells (a bare serial like "0.43302..." instead of
    // their date/time render) until the real repair was applied: a
    // dry-run-parity violation mid-repair.
    var priorFormats = dryRun ? range.getNumberFormats() : null;

    // Numeric lens: a coerced time-VALUE cell now returns its serial NUMBER
    // (not a 1899-epoch Date). Already-text cells stay strings. Applied even on
    // a dry run so the scan sees the serials; the ORIGINAL formats are
    // restored on a dry run, '@' on apply.
    range.setNumberFormat('0.############');
    SpreadsheetApp.flush();
    var vals = range.getValues();

    for (var i = 0; i < vals.length; i++) {
      for (var j = 0; j < vals[i].length; j++) {
        var v = vals[i][j];
        if (typeof v === 'number') {                   // coerced cell
          var secs = Math.round((v - Math.floor(v)) * 86400);
          if (secs >= 86400) secs -= 86400;            // guard rounding at midnight
          var h = Math.floor(secs / 3600),
              m = Math.floor((secs % 3600) / 60),
              s = secs % 60;
          var str = h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
          if (samples.length < 12) {
            samples.push('R' + (i + 2) + 'C' + (start + j) + ' (' + label + '): ' + v + ' -> ' + str);
          }
          vals[i][j] = str;
          fixed++;
        }
        // strings (incl. comma-joined + already-correct singles) and '' left as-is
      }
    }
    pending.push({ range: range, vals: vals, priorFormats: priorFormats });
    // REP-9: on APPLY, finish THIS column group end-to-end right away
    // ('@' + write-back + flush) instead of committing the numeric lens
    // across ALL groups first and writing later -- a crash/timeout in that
    // gap left every still-coerced K-AC/AF cell DISPLAYING as a bare
    // serial ("0.43302...") to all getDisplayValues consumers until the
    // repair was re-run to completion. The exposure window is now a single
    // group's read->write, and each completed group is durably repaired.
    if (!dryRun) {
      range.setNumberFormat('@');
      range.setValues(vals);
      SpreadsheetApp.flush();
    }
  }

  if (dryRun) {
    // F-52: restore the ORIGINAL formats -- a preview must leave the sheet
    // byte-identical for every downstream reader. Do NOT rewrite values.
    for (var p = 0; p < pending.length; p++) pending[p].range.setNumberFormats(pending[p].priorFormats);
    SpreadsheetApp.flush();
    Logger.log('previewDqeSlotTimestampRepair: %s coerced slot/AF cell(s) WOULD be recovered. '
      + 'Samples: %s', fixed, JSON.stringify(samples));
    return { fixed: fixed, applied: false, samples: samples };
  }

  // K-AC + AF were locked to plain text and written back PER GROUP inside
  // the loop above (REP-9) -- nothing left to write here.
  Logger.log('repairDqeSlotTimestamps: recovered %s coerced slot/AF cell(s). Samples: %s',
    fixed, JSON.stringify(samples));
  return { fixed: fixed, applied: true, samples: samples };
}


// -- Abandoned ID coercion repair (cols AD/AE = 30-31) -----------------------
//
// Scope note: AF (col 32, "Abandoned Missed Leg Times") was previously lumped
// in here, but it is a TIME-of-day column (comma-joined H:MM:SS, like K-AC),
// NOT an ID column. A coerced single AF time is a fractional serial, so this
// helper's Number.isSafeInteger() test would wrongly mark it "#REBUILD" and
// destroy a recoverable value. AF is now recovered by repairDqeSlotTimestamps
// (the slot/abandoned-time coercion repair). This repair handles AD/AE only.
//
// Background: cols AD/AE of "DQE Historical Data" hold comma-joined big
// integers -- abandoned parent IDs (AD) and abandoned missed-leg IDs (AE). A
// MULTI-value cell like
// "1762242202191,1762242165529" gets auto-coerced by Sheets into a single
// Number (the comma read as a thousands group), concatenating the digits into a
// ~26-digit value that exceeds 2^53 -- so precision past ~15 digits is LOST and
// the cell re-renders as e.g. "17,622,419,789,481,700,000,000,000". A
// SINGLE-value cell ("1762242202191") is < 2^53, so it coerces LOSSLESSLY (only
// its display gains thousand separators, which downstream then mis-splits on).
//
// Two outcomes, handled differently:
//   * Single-value coerced cell  -> RECOVERABLE: Number.isSafeInteger(v) is
//     true; rewrite String(v) as plain text. Lossless.
//   * Multi-value coerced cell   -> UNRECOVERABLE: !Number.isSafeInteger(v); the
//     lower digits are gone for good. The original IDs CANNOT be reconstructed
//     from the cell -- the only true fix is rebuilding that date from Raw Data
//     (buildDQEHistoricalData), where the source still exists. This helper
//     REPORTS those rows + their distinct dates and marks the cells with the
//     DQE_ABANDONED_LOST_SENTINEL ("#REBUILD") so downstream reads "abandoned
//     detail unavailable -- rebuild" instead of mistaking it for "0 abandoned".
//
// Accuracy scope: AD/AE/AF feed ONLY the Missed Calls report's abandoned-call
// detail (queue-only unique counts via INV-23 parent-ID dedup, per-call parentId
// badges, abandoned timestamps) and their Neon mirror (dqe_history.abandoned_*).
// They do NOT feed the per-agent Unique/Rung/Missed/Answered/TTT/ATT metrics or
// AvgAbdWait/CSRAvgAbdWait -- those are computed independently and are unaffected.
//
// The daily build plain-text-protects AD-AF going forward
// (buildDQEHistoricalData.js setNumberFormat('@')); this repairs rows corrupted
// before that protection landed (or any that slipped through).
//
// Usage:
//   1. previewDqeAbandonedIdRepair()  -- dry run; logs recoverable +
//      unrecoverable counts, samples, and the distinct dates needing a rebuild.
//   2. repairDqeAbandonedIds()        -- recover the lossless single-value cells,
//      mark unrecoverable cells "#REBUILD" (so they read as unavailable, not 0),
//      and lock AD-AF to plain text.
//   3. If you've started the Neon backfill (or DQE_READ_SOURCE=neon): re-mirror
//      the affected dates with backfillDQEHistoryUpsert() -- its ON CONFLICT DO
//      UPDATE OVERWRITES the rows already backfilled from the bad cells. No new
//      upsert function is needed; backfillDQEHistory()'s DO NOTHING would SKIP
//      them, so use the Upsert variant. For UNRECOVERABLE dates, rebuild from Raw
//      Data first (if it still exists), THEN upsert -- otherwise the upsert just
//      re-mirrors the blank/garbage.

// Unrecoverable cells are marked with DQE_ABANDONED_LOST_SENTINEL (defined once
// in neonbackfill.js, shared across the cdr-report project's global scope) so
// "corrupted -- rebuild" is distinguishable from a genuinely-empty "0 abandoned"
// cell; the dashboard's classifyAbandonedCell_ (Util.gs) recognizes it.

/** Preview only: report what WOULD change; no writes. */
function previewDqeAbandonedIdRepair() {
  return repairDqeAbandonedIds_(/*dryRun=*/true);
}

/**
 * Apply the repair: recover lossless single-value coerced cells as text, mark
 * unrecoverable multi-value cells with the lost sentinel, and lock AD-AF to
 * plain text.
 */
function repairDqeAbandonedIds() {
  return repairDqeAbandonedIds_(/*dryRun=*/false);
}

function repairDqeAbandonedIds_(dryRun) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('DQE Historical Data');
  if (!sheet) { Logger.log('repairDqeAbandonedIds: sheet "DQE Historical Data" not found.'); return; }
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('repairDqeAbandonedIds: no data rows.'); return; }

  var START_COL = 30, NUM_COLS = 2;            // AD..AE (abandoned parent IDs / missed-leg IDs). AF (32) is a TIME column -- recovered by repairDqeSlotTimestamps, NOT here.
  var range = sheet.getRange(2, START_COL, lastRow - 1, NUM_COLS);
  var vals  = range.getValues();               // coerced cells come back as Numbers; text/'' stay as-is
  var dates = sheet.getRange(2, 2, lastRow - 1, 1).getDisplayValues();   // col B = Date (for reporting)

  var recovered = 0, markedLost = 0;
  var recSamples = [], lostSamples = [];
  var lostDates = {};
  for (var i = 0; i < vals.length; i++) {
    for (var j = 0; j < vals[i].length; j++) {
      var v = vals[i][j];
      if (typeof v !== 'number') continue;     // already text (or '') -> fine
      if (Number.isSafeInteger(v)) {           // single-value coercion -> lossless
        var str = String(v);
        if (recSamples.length < 12) recSamples.push('R' + (i + 2) + 'C' + (START_COL + j) + ': ' + v + ' -> ' + str);
        vals[i][j] = str;
        recovered++;
      } else {                                 // multi-value -> precision lost, unrecoverable
        var d = (dates[i] && dates[i][0]) || '?';
        lostDates[d] = (lostDates[d] || 0) + 1;
        if (lostSamples.length < 12) lostSamples.push('R' + (i + 2) + 'C' + (START_COL + j) + ': ' + v);
        vals[i][j] = DQE_ABANDONED_LOST_SENTINEL;   // mark lost so it's never mistaken for 0
        markedLost++;
      }
    }
  }

  var dateList = Object.keys(lostDates).sort();
  if (dryRun) {
    Logger.log('previewDqeAbandonedIdRepair: %s recoverable (single-value) cell(s) WOULD be rewritten as text; '
      + '%s UNRECOVERABLE (multi-value, precision lost) WOULD be marked "%s" across %s date(s): %s. '
      + 'Recoverable samples: %s | Lost samples: %s',
      recovered, markedLost, DQE_ABANDONED_LOST_SENTINEL, dateList.length, JSON.stringify(dateList),
      JSON.stringify(recSamples), JSON.stringify(lostSamples));
    return { recovered: recovered, markedLost: markedLost, lostDates: dateList,
             applied: false, recSamples: recSamples, lostSamples: lostSamples };
  }

  // Lock AD-AF to plain text (so recovered values + the sentinel STAY text and
  // the column can't re-coerce), then write back.
  range.setNumberFormat('@');
  range.setValues(vals);
  SpreadsheetApp.flush();
  Logger.log('repairDqeAbandonedIds: recovered %s single-value cell(s); marked %s unrecoverable cell(s) "%s" '
    + 'across %s date(s): %s. Rebuild those dates from Raw Data (buildDQEHistoricalData) to restore them, then '
    + 're-mirror with backfillDQEHistoryUpsert(). Recoverable samples: %s',
    recovered, markedLost, DQE_ABANDONED_LOST_SENTINEL, dateList.length, JSON.stringify(dateList),
    JSON.stringify(recSamples));
  return { recovered: recovered, markedLost: markedLost, lostDates: dateList,
           applied: true, recSamples: recSamples, lostSamples: lostSamples };
}


// -- Old-dataset PST -> CST timestamp shift (cols K-AC + AF) ------------------
//
// Background: the "DQE Historical Data" sheet spans two pipeline eras divided at
// 2026-03-09. Rows on/after that date were written by the CURRENT pipeline,
// which buckets missed-call times by PST slot windows (DQE_TIME_SLOTS, slot 0 =
// 6:00-6:30 PST = the "8-8:30 AM" CST column) and stores the CST string
// (pstToCSTStr = +2h). Rows BEFORE 2026-03-09 came from the OLD pipeline, which
// bucketed into the SAME slot columns but stored the RAW PST string (the +2h
// CST conversion was missing). So in old rows the COLUMN is already correct;
// only the stored time-of-day VALUE is 2 hours behind (e.g. a call shown as
// "6:13:19" in the "8-8:30 AM" column should read "8:13:19").
//
// Pacific<->Central is a constant 2h offset year-round (both observe DST in
// lockstep), so a flat +7200s on the time-of-day string is correct on any date
// and never crosses midnight (the work window is mid-day: 6:30-15:00 PST =
// 8:30-17:00 CST).
//
// What this shifts (time-of-day strings only):
//   * K-AC (cols 11-29) -- the 19 half-hour slot missed-times.
//   * AF   (col 32)     -- "Abandoned Missed Leg Times" (also pstToCSTStr CST
//                          time-of-day strings in the current pipeline; AD/AE
//                          are epoch-style IDs and are NOT touched).
// NOT shifted: TTT/ATT (I/J), AvgAbdWait/CSRAvgAbdWait (AG/AH) -- all DURATIONS,
// TZ-independent -- the counts (E-H), the Date (B), AD/AE (IDs). The per-agent
// Rung/Missed/Answered/TTT/ATT metrics do NOT depend on these strings, so this
// repair is display/detail-only and cannot move the headline numbers.
//
// Why it matters downstream: the dashboard's Missed Calls report buckets by
// PARSING the stored time against the 8 AM-5 PM CST chart range
// (MissedCallsReport.gs). Old PST values read 2h early -> calls physically at
// 8:00-10:00 CST fall BEFORE 8:00 and drop off the chart (bucket -1); later
// calls land in the wrong (2h-early) bucket; per-agent timelines show the time
// 2h early. This repair fixes all of that for old dates.
//
// Safety (idempotent / re-run-safe by construction):
//   * Date gate: only rows with Date < 2026-03-09 are candidates.
//   * Per-row PST-window validation: a candidate row is shifted ONLY if its
//     non-empty K-AC times sit in the PST window for their column AND none sit
//     in the already-CST window. Rows that look already-CST, mixed, or have
//     out-of-window/garbage times are SKIPPED and reported -- so a second run,
//     or a pre-2026-03-09 row that was already rebuilt in CST, is never
//     double-shifted.
//   * AF follows the row's slot decision (abandoned times are a subset of the
//     missed times, so they share the row's TZ state). AF is left untouched if
//     it is the #REBUILD sentinel or contains any non-time token.
//   * Writes are SURGICAL -- only changed rows' K-AC ranges + AF cells are
//     rewritten (as plain text); untouched and post-cutoff cells are never
//     rewritten.
//
// Run ORDER (so all cells are clean text before the shift):
//   1. repairDqeSlotTimestamps()  -- recover any coerced K-AC + AF time cells (above).
//   2. repairDqeAbandonedIds()    -- recover/mark AD-AE ID coercion (above).
//   3. previewDqeOldPstTimestampShift()  -- dry run; logs counts + samples.
//   4. repairDqeOldPstTimestampShift()   -- apply the +2h shift.
//   5. If DQE_READ_SOURCE=neon or the Neon mirror is consumed: re-mirror the
//      affected dates with backfillDQEHistoryUpsert() (ON CONFLICT DO UPDATE).

var DQE_TZ_SHIFT_CUTOFF_YYYYMMDD = 20260309;   // rows strictly BEFORE this are candidates
var DQE_TZ_SHIFT_SECONDS         = 7200;       // PST -> CST (+2h)

/** Preview only: report what WOULD shift; no writes. */
function previewDqeOldPstTimestampShift() {
  return repairDqeOldPstTimestampShift_(/*dryRun=*/true);
}

/** Apply the +2h PST->CST shift to old-dataset K-AC slot + AF timestamps. */
function repairDqeOldPstTimestampShift() {
  return repairDqeOldPstTimestampShift_(/*dryRun=*/false);
}

function repairDqeOldPstTimestampShift_(dryRun) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('DQE Historical Data');
  if (!sheet) { Logger.log('repairDqeOldPstTimestampShift: sheet "DQE Historical Data" not found.'); return; }
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('repairDqeOldPstTimestampShift: no data rows.'); return; }

  var SLOT_START = 11, SLOT_N = 19, AF_COL = 32, SHIFT = DQE_TZ_SHIFT_SECONDS;
  var n = lastRow - 1;
  // TZ-safe reads: getDisplayValues returns the H:MM:SS strings (getValues would
  // drag the spreadsheet-vs-script TZ shift onto time-typed cells -- INV-02).
  var dates    = sheet.getRange(2, 2, n, 1).getDisplayValues();
  var slotVals = sheet.getRange(2, SLOT_START, n, SLOT_N).getDisplayValues();
  var afVals   = sheet.getRange(2, AF_COL, n, 1).getDisplayValues();

  function parseHms(str) {
    if (str === null || str === undefined) return null;
    var t = String(str).trim();
    if (!t) return null;
    var p = t.split(':');
    if (p.length < 3) return null;
    var h = Number(p[0]), m = Number(p[1]), s = Number(p[2]);
    if (!isFinite(h) || !isFinite(m) || !isFinite(s)) return null;
    if (h < 0 || h > 23 || m < 0 || m > 59 || s < 0 || s > 59) return null;
    return h * 3600 + m * 60 + s;
  }
  function fmtHms(sec) {
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function parseYmd(str) {
    if (!str) return null;
    var datePart = String(str).trim().split(' ')[0];
    var p = datePart.split('/');                 // col B is M/D/YYYY
    if (p.length < 3) return null;
    var mo = parseInt(p[0], 10), da = parseInt(p[1], 10), yr = parseInt(p[2], 10);
    if (!yr || !mo || !da) return null;
    return yr * 10000 + mo * 100 + da;
  }

  var SENTINEL = (typeof DQE_ABANDONED_LOST_SENTINEL !== 'undefined') ? DQE_ABANDONED_LOST_SENTINEL : '#REBUILD';

  var stats = {
    candidates: 0, shiftedRows: 0, shiftedSlotCells: 0, afShiftedCells: 0,
    alreadyCstRows: 0, mixedRows: 0, anomalyRows: 0, afOrphanRows: 0,
    afSentinelSkipped: 0, afUnparseable: 0, unparsedDateRows: 0
  };
  var samples = { shifted: [], alreadyCst: [], anomaly: [], af: [] };
  var changes = [];   // { rowNum, slots:[19], af:string|null }

  for (var i = 0; i < n; i++) {
    var rowNum = i + 2;
    var ymd = parseYmd(dates[i][0]);
    if (ymd === null) { stats.unparsedDateRows++; continue; }
    if (ymd >= DQE_TZ_SHIFT_CUTOFF_YYYYMMDD) continue;   // current/CST era -- never touched
    stats.candidates++;

    var rowPst = 0, rowCst = 0, rowAnom = 0;
    for (var c = 0; c < SLOT_N; c++) {
      var cell = slotVals[i][c];
      if (!cell) continue;
      var pstLo = 6 * 3600 + c * 1800, pstHi = pstLo + 1800;
      var cstLo = pstLo + SHIFT,        cstHi = pstHi + SHIFT;
      var times = String(cell).split(',');
      for (var k = 0; k < times.length; k++) {
        var sec = parseHms(times[k]);
        if (sec === null)                       rowAnom++;
        else if (sec >= pstLo && sec < pstHi)   rowPst++;
        else if (sec >= cstLo && sec < cstHi)   rowCst++;
        else                                    rowAnom++;
      }
    }

    // Row decision.
    if (rowAnom > 0) {
      stats.anomalyRows++;
      if (samples.anomaly.length < 12) samples.anomaly.push('R' + rowNum + ' (' + dates[i][0] + ')');
      continue;
    }
    if (rowPst > 0 && rowCst > 0) {
      stats.mixedRows++;
      if (samples.anomaly.length < 12) samples.anomaly.push('R' + rowNum + ' MIXED (' + dates[i][0] + ')');
      continue;
    }
    if (rowPst === 0 && rowCst > 0) {
      stats.alreadyCstRows++;
      if (samples.alreadyCst.length < 12) samples.alreadyCst.push('R' + rowNum + ' (' + dates[i][0] + ')');
      continue;
    }
    if (rowPst === 0 && rowCst === 0) {
      // No slot times at all. AF without any slot evidence is contradictory
      // (abandoned missed legs are a subset of missed legs) -- skip + flag.
      if (afVals[i][0] && String(afVals[i][0]).trim() && String(afVals[i][0]).trim() !== SENTINEL) {
        stats.afOrphanRows++;
        if (samples.af.length < 12) samples.af.push('R' + rowNum + ' AF-without-slots (' + dates[i][0] + ')');
      }
      continue;
    }

    // rowPst > 0 && rowCst === 0 && rowAnom === 0  -> PST row, SHIFT it.
    var newSlots = [];
    var cells = 0;
    for (var c2 = 0; c2 < SLOT_N; c2++) {
      var cell2 = slotVals[i][c2];
      if (!cell2) { newSlots.push(''); continue; }
      var parts = String(cell2).split(',');
      var shifted = [];
      for (var k2 = 0; k2 < parts.length; k2++) shifted.push(fmtHms(parseHms(parts[k2]) + SHIFT));
      newSlots.push(shifted.join(','));
      cells += parts.length;
    }

    // AF: follow the row's PST decision; guard sentinel + non-time tokens.
    var afCell = afVals[i][0];
    var afNew = afCell;                 // default: unchanged
    var afTrim = afCell ? String(afCell).trim() : '';
    if (afTrim && afTrim !== SENTINEL) {
      var afTokens = afTrim.split(',');
      var afShift = [], afOk = true;
      for (var a = 0; a < afTokens.length; a++) {
        var asec = parseHms(afTokens[a]);
        if (asec === null || asec + SHIFT >= 86400) { afOk = false; break; }
        afShift.push(fmtHms(asec + SHIFT));
      }
      if (afOk) { afNew = afShift.join(','); stats.afShiftedCells++; }
      else {
        stats.afUnparseable++;
        if (samples.af.length < 12) samples.af.push('R' + rowNum + ' AF non-time, left as-is (' + dates[i][0] + ')');
      }
    } else if (afTrim === SENTINEL) {
      stats.afSentinelSkipped++;
    }

    stats.shiftedRows++;
    stats.shiftedSlotCells += cells;
    if (samples.shifted.length < 12) {
      samples.shifted.push('R' + rowNum + ' (' + dates[i][0] + '): slot[0..]="' + slotVals[i].join('|').slice(0, 60) + '" -> shifted +2h');
    }
    changes.push({ rowNum: rowNum, slots: newSlots, af: afNew });
  }

  var summary = 'candidates(pre-' + DQE_TZ_SHIFT_CUTOFF_YYYYMMDD + ')=' + stats.candidates
    + ' shiftRows=' + stats.shiftedRows + ' slotCells=' + stats.shiftedSlotCells
    + ' afCells=' + stats.afShiftedCells + ' | skipped: alreadyCST=' + stats.alreadyCstRows
    + ' mixed=' + stats.mixedRows + ' anomaly=' + stats.anomalyRows
    + ' afOrphan=' + stats.afOrphanRows + ' afSentinel=' + stats.afSentinelSkipped
    + ' afNonTime=' + stats.afUnparseable + ' unparsedDate=' + stats.unparsedDateRows;

  if (dryRun) {
    Logger.log('previewDqeOldPstTimestampShift: WOULD shift %s. \nShift samples: %s\nAlready-CST: %s\nAnomalies/mixed: %s\nAF notes: %s',
      summary, JSON.stringify(samples.shifted), JSON.stringify(samples.alreadyCst),
      JSON.stringify(samples.anomaly), JSON.stringify(samples.af));
    return { applied: false, stats: stats, samples: samples };
  }

  // Apply: rewrite ONLY changed rows (K-AC range + AF cell), as plain text.
  for (var x = 0; x < changes.length; x++) {
    var ch = changes[x];
    var sr = sheet.getRange(ch.rowNum, SLOT_START, 1, SLOT_N);
    sr.setNumberFormat('@');
    sr.setValues([ch.slots]);
    var ar = sheet.getRange(ch.rowNum, AF_COL, 1, 1);
    ar.setNumberFormat('@');
    ar.setValue(ch.af === null || ch.af === undefined ? '' : ch.af);
  }
  SpreadsheetApp.flush();
  Logger.log('repairDqeOldPstTimestampShift: shifted %s. \nShift samples: %s\nAlready-CST (untouched): %s\nAnomalies/mixed (untouched, review): %s\nAF notes: %s\n'
    + 'If DQE_READ_SOURCE=neon or the Neon mirror is consumed, re-mirror the shifted dates with backfillDQEHistoryUpsert().',
    summary, JSON.stringify(samples.shifted), JSON.stringify(samples.alreadyCst),
    JSON.stringify(samples.anomaly), JSON.stringify(samples.af));
  return { applied: true, stats: stats, samples: samples };
}

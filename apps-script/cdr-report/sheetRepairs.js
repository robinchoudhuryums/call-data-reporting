// ============================================================================
// sheetRepairs.js — one-off DQE Historical Data sheet repairs (cdr-report).
// ----------------------------------------------------------------------------
// Editor-run maintenance utilities. NOT part of the daily pipeline. Each is
// idempotent and safe to re-run. Run from the CDR Report Apps Script editor's
// Run dropdown (the picker hides `_`-suffixed helpers, so the two entry points
// below are non-underscore).
// ============================================================================


// -- Slot-timestamp coercion repair (cols K-AC) ------------------------------
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
//   2. Run repairDqeSlotTimestamps() to apply: it locks K-AC to plain text and
//      rewrites the recovered timestamps as text.
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

  var START_COL = 11, NUM_COLS = 19;          // K..AC (HISTORICAL_COLS TIME_SLOTS_START..END)
  var range = sheet.getRange(2, START_COL, lastRow - 1, NUM_COLS);

  // 1) Numeric lens: a coerced time-VALUE cell now returns its serial NUMBER
  //    (not a 1899-epoch Date). Already-text cells stay strings. (Even on a
  //    dry run we apply this lens so the scan sees the serials; the dry run
  //    just doesn't rewrite values -- the format is restored to '@' either way.)
  range.setNumberFormat('0.############');
  SpreadsheetApp.flush();
  var vals = range.getValues();

  var fixed = 0, samples = [];
  for (var i = 0; i < vals.length; i++) {
    for (var j = 0; j < vals[i].length; j++) {
      var v = vals[i][j];
      if (typeof v === 'number') {                       // coerced cell
        var secs = Math.round((v - Math.floor(v)) * 86400);
        if (secs >= 86400) secs -= 86400;                // guard rounding at midnight
        var h = Math.floor(secs / 3600),
            m = Math.floor((secs % 3600) / 60),
            s = secs % 60;
        var str = h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
        if (samples.length < 12) {
          samples.push('R' + (i + 2) + 'C' + (START_COL + j) + ': ' + v + ' -> ' + str);
        }
        vals[i][j] = str;
        fixed++;
      }
      // strings (incl. comma-joined + already-correct singles) and '' left as-is
    }
  }

  if (dryRun) {
    // Restore plain-text format (harmless, and what the apply path would set)
    // but do NOT rewrite values.
    range.setNumberFormat('@');
    SpreadsheetApp.flush();
    Logger.log('previewDqeSlotTimestampRepair: %s coerced slot cell(s) WOULD be recovered. '
      + 'Samples: %s', fixed, JSON.stringify(samples));
    return { fixed: fixed, applied: false, samples: samples };
  }

  // 2) Lock K-AC to plain text, then write the recovered strings so they STAY
  //    text (and the pipeline's matching setNumberFormat('@') keeps it that way).
  range.setNumberFormat('@');
  range.setValues(vals);
  SpreadsheetApp.flush();
  Logger.log('repairDqeSlotTimestamps: recovered %s coerced slot cell(s). Samples: %s',
    fixed, JSON.stringify(samples));
  return { fixed: fixed, applied: true, samples: samples };
}


// -- Abandoned ID/time coercion repair (cols AD/AE/AF = 30-32) ---------------
//
// Background: cols AD/AE/AF of "DQE Historical Data" hold comma-joined big
// integers -- abandoned parent IDs (AD), abandoned missed-leg IDs (AE), and
// abandoned missed-leg times in epoch-ms (AF). A MULTI-value cell like
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
//     REPORTS those rows + their distinct dates and, with
//     { blankUnrecoverable: true }, blanks them so downstream reads "no
//     abandoned detail" instead of garbage.
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
//   2. repairDqeAbandonedIds()        -- recover the lossless single-value cells
//      and lock AD-AF to plain text. Unrecoverable cells are reported and left
//      as plain-text (no longer comma-splittable). Pass
//      repairDqeAbandonedIds({ blankUnrecoverable: true }) to instead blank them.
//   3. If you've started the Neon backfill (or DQE_READ_SOURCE=neon): re-mirror
//      the affected dates with backfillDQEHistoryUpsert() -- its ON CONFLICT DO
//      UPDATE OVERWRITES the rows already backfilled from the bad cells. No new
//      upsert function is needed; backfillDQEHistory()'s DO NOTHING would SKIP
//      them, so use the Upsert variant. For UNRECOVERABLE dates, rebuild from Raw
//      Data first (if it still exists), THEN upsert -- otherwise the upsert just
//      re-mirrors the blank/garbage.

/** Preview only: report what WOULD change; no writes. */
function previewDqeAbandonedIdRepair() {
  return repairDqeAbandonedIds_(/*dryRun=*/true, /*blankUnrecoverable=*/false);
}

/**
 * Apply the repair: recover lossless single-value coerced cells as text, lock
 * AD-AF to plain text, and report unrecoverable multi-value cells.
 * @param {{blankUnrecoverable?: boolean}=} opts  blank the unrecoverable cells too.
 */
function repairDqeAbandonedIds(opts) {
  return repairDqeAbandonedIds_(/*dryRun=*/false, !!(opts && opts.blankUnrecoverable));
}

function repairDqeAbandonedIds_(dryRun, blankUnrecoverable) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('DQE Historical Data');
  if (!sheet) { Logger.log('repairDqeAbandonedIds: sheet "DQE Historical Data" not found.'); return; }
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('repairDqeAbandonedIds: no data rows.'); return; }

  var START_COL = 30, NUM_COLS = 3;            // AD..AF (abandoned parent IDs / missed IDs / times)
  var range = sheet.getRange(2, START_COL, lastRow - 1, NUM_COLS);
  var vals  = range.getValues();               // coerced cells come back as Numbers; text/'' stay as-is
  var dates = sheet.getRange(2, 2, lastRow - 1, 1).getDisplayValues();   // col B = Date (for reporting)

  var recovered = 0, unrecoverable = 0, blanked = 0;
  var recSamples = [], unrecSamples = [];
  var unrecDates = {};
  var changed = false;
  for (var i = 0; i < vals.length; i++) {
    for (var j = 0; j < vals[i].length; j++) {
      var v = vals[i][j];
      if (typeof v !== 'number') continue;     // already text (or '') -> fine
      if (Number.isSafeInteger(v)) {           // single-value coercion -> lossless
        var str = String(v);
        if (recSamples.length < 12) recSamples.push('R' + (i + 2) + 'C' + (START_COL + j) + ': ' + v + ' -> ' + str);
        vals[i][j] = str;
        recovered++; changed = true;
      } else {                                 // multi-value -> precision lost, unrecoverable
        unrecoverable++;
        var d = (dates[i] && dates[i][0]) || '?';
        unrecDates[d] = (unrecDates[d] || 0) + 1;
        if (unrecSamples.length < 12) unrecSamples.push('R' + (i + 2) + 'C' + (START_COL + j) + ': ' + v);
        if (blankUnrecoverable) { vals[i][j] = ''; blanked++; changed = true; }
        // else: leave the value; the format flip below stores it as plain text
        // (no thousand-separator commas), so it no longer mis-splits downstream.
      }
    }
  }

  var dateList = Object.keys(unrecDates).sort();
  if (dryRun) {
    Logger.log('previewDqeAbandonedIdRepair: %s recoverable (single-value) cell(s) WOULD be rewritten as text; '
      + '%s UNRECOVERABLE (multi-value, precision lost) across %s date(s): %s. '
      + 'Recoverable samples: %s | Unrecoverable samples: %s',
      recovered, unrecoverable, dateList.length, JSON.stringify(dateList),
      JSON.stringify(recSamples), JSON.stringify(unrecSamples));
    return { recovered: recovered, unrecoverable: unrecoverable, unrecoverableDates: dateList,
             applied: false, recSamples: recSamples, unrecSamples: unrecSamples };
  }

  // Lock AD-AF to plain text (so recovered values STAY text + the column can't
  // re-coerce), then write back. Setting '@' on the whole range also strips the
  // misleading thousand separators from any leftover unrecoverable numbers.
  range.setNumberFormat('@');
  range.setValues(vals);
  SpreadsheetApp.flush();
  Logger.log('repairDqeAbandonedIds: recovered %s single-value cell(s); %s unrecoverable%s across %s date(s): %s. '
    + 'Rebuild those dates from Raw Data (buildDQEHistoricalData) to restore them, then re-mirror with '
    + 'backfillDQEHistoryUpsert(). Recoverable samples: %s',
    recovered, unrecoverable, (blankUnrecoverable ? (' (blanked ' + blanked + ')') : ''),
    dateList.length, JSON.stringify(dateList), JSON.stringify(recSamples));
  return { recovered: recovered, unrecoverable: unrecoverable, unrecoverableDates: dateList,
           blanked: blanked, applied: true, recSamples: recSamples, unrecSamples: unrecSamples };
}

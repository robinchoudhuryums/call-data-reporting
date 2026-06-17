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

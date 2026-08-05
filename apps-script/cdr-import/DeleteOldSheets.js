/**
 * Call_Legs_* retention prune. Deletes per-day leg sheets older than
 * RETENTION_CUTOFF_DAYS (14). This window is LOAD-BEARING far beyond disk
 * hygiene: the inbound/outbound journey backfills, the per-queue split
 * backfill (Operator State #40), and the deferred mirror's pruned-sheet
 * detection all assume it runs -- see Operator State #43.
 *
 * C-3: this used to have NO in-repo installer, menu item, caller, or
 * telemetry -- it survived only as a hand-made trigger invisible to the
 * repo. It now has:
 *   - installRetentionPruneTrigger / uninstallRetentionPruneTrigger
 *     (editor-run or CDR Tools menu; daily, early morning);
 *   - runRetentionPrune_ (the trigger handler): logs a `retentionPrune`
 *     Pipeline Health row per run (success + deleted count, or failure),
 *     so the Health page's "Recent pipeline step failures" and the
 *     PipelineWatch push both see a broken prune -- and the row's very
 *     existence is the proof-of-life the checklist item asks about.
 *
 * deleteOldCDRSheets() stays hand-runnable and keeps its name (any
 * pre-existing hand-made trigger on it keeps working); it now returns
 * the counts instead of only logging.
 */

var RETENTION_SHEET_PREFIX = 'Call_Legs_';
var RETENTION_CUTOFF_DAYS = 14;

function deleteOldCDRSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss && typeof getTargetSsId_ === 'function') {
    // Time triggers on an unbound context have no active spreadsheet --
    // fall back to the configured target workbook (where the per-day
    // Call_Legs_* sheets live).
    ss = SpreadsheetApp.openById(getTargetSsId_());
  }
  var sheets = ss.getSheets();

  var today = new Date();
  today.setHours(0, 0, 0, 0);

  var deleted = 0, kept = 0;
  // Reverse loop so deletions don't shift the un-visited entries.
  for (var i = sheets.length - 1; i >= 0; i--) {
    var sheet = sheets[i];
    var name = sheet.getName();
    if (name.indexOf(RETENTION_SHEET_PREFIX) !== 0) continue;
    var dateMatch = name.match(/Call_Legs_(\d{4})-(\d{2})-(\d{2})/);
    if (!dateMatch) continue;
    var sheetDate = new Date(+dateMatch[1], +dateMatch[2] - 1, +dateMatch[3]);
    var dayDiff = (today.getTime() - sheetDate.getTime()) / (1000 * 3600 * 24);
    if (dayDiff > RETENTION_CUTOFF_DAYS) {
      ss.deleteSheet(sheet);
      deleted++;
      Logger.log('Deleted old sheet: ' + name);
    } else {
      kept++;
    }
  }
  Logger.log('deleteOldCDRSheets: deleted ' + deleted + ', kept ' + kept
    + ' (cutoff ' + RETENTION_CUTOFF_DAYS + 'd).');
  return { deleted: deleted, kept: kept };
}

/** Time-trigger handler: prune + a Pipeline Health row per run (C-3). */
function runRetentionPrune_() {
  var t0 = Date.now();
  try {
    var res = deleteOldCDRSheets();
    try {
      if (typeof logPipelineHealthWithFallback_ === 'function') {
        logPipelineHealthWithFallback_(null, {
          step: 'retentionPrune',
          status: 'success',
          rows: res.deleted,
          durationMs: Date.now() - t0,
          notes: 'deleted ' + res.deleted + ' Call_Legs sheet(s), ' + res.kept
            + ' within the ' + RETENTION_CUTOFF_DAYS + 'd window',
        });
      }
    } catch (logErr) { /* best-effort */ }
  } catch (e) {
    var msg = (e && e.message) ? e.message : String(e);
    Logger.log('runRetentionPrune_ failed: ' + msg);
    try {
      if (typeof logPipelineHealthWithFallback_ === 'function') {
        logPipelineHealthWithFallback_(null, {
          step: 'retentionPrune',
          status: 'failure',
          rows: null,
          durationMs: Date.now() - t0,
          notes: msg,
        });
      }
    } catch (logErr) { /* best-effort */ }
  }
}

/** Menu/editor wrapper (the runNeonMirrorNow naming precedent). */
function runRetentionPruneNow() { runRetentionPrune_(); }

function installRetentionPruneTrigger() {
  uninstallRetentionPruneTrigger();
  ScriptApp.newTrigger('runRetentionPrune_').timeBased().everyDays(1).atHour(3).create();
  Logger.log('Retention prune trigger installed (runRetentionPrune_, daily ~3 AM). '
    + 'If a hand-made trigger on deleteOldCDRSheets exists, delete it in the '
    + 'Triggers panel so the prune does not run twice (harmless but noisy).');
}

function uninstallRetentionPruneTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runRetentionPrune_') ScriptApp.deleteTrigger(t);
  });
  Logger.log('Retention prune trigger removed (if it existed).');
}

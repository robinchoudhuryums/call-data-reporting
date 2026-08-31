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
  if (!ss) {
    // P18: the old fallback opened getTargetSsId_() -- the CDR REPORT
    // workbook -- but the per-day Call_Legs_* sheets live in the IMPORT
    // (container-bound) workbook, like every other consumer reads them
    // (backfillInboundCalls, getLatestValidSheet, the previews). If that
    // fallback ever fired, the prune no-op'd against the wrong workbook
    // while runRetentionPrune_ logged a green "deleted 0, kept 0" success
    // row -- the load-bearing ~14-day retention silently stopped being
    // enforced. There is no property naming the source workbook, so the
    // honest move is to FAIL LOUDLY: runRetentionPrune_'s catch turns this
    // into a retentionPrune FAILURE Pipeline Health row.
    throw new Error('deleteOldCDRSheets: no active spreadsheet (unbound context?) — '
      + 'the Call_Legs_* sheets live in the CDR Import container workbook, and there '
      + 'is no configured pointer to it. Run from the bound project.');
  }
  var sheets = ss.getSheets();

  // Age is compared in WHOLE CALENDAR DAYS via Date.UTC, not by dividing a
  // local-midnight millisecond difference by 86_400_000. The old arithmetic
  // was DST-sensitive: a window containing the 25-hour fall-back day yielded
  // 14.0417 for a nominally-14-day-old tab, which cleared the `> 14` cutoff
  // and pruned it a day EARLY -- narrowing the load-bearing retention window
  // to 13 days for ~2 weeks each November, against a window the queue-split
  // backfill (Operator State #40) already races. Deletion is irreversible and
  // the per-leg queue identity exists nowhere else, so the safe direction is
  // to keep a tab a day too long, never to drop one a day too soon.
  // Date.UTC on the LOCAL y/m/d of each side removes the offset entirely, so
  // the difference is always an exact integer count of calendar days.
  var now = new Date();
  var todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());

  var deleted = 0, kept = 0;
  // Reverse loop so deletions don't shift the un-visited entries.
  for (var i = sheets.length - 1; i >= 0; i--) {
    var sheet = sheets[i];
    var name = sheet.getName();
    if (name.indexOf(RETENTION_SHEET_PREFIX) !== 0) continue;
    var dateMatch = name.match(/Call_Legs_(\d{4})-(\d{2})-(\d{2})/);
    if (!dateMatch) continue;
    // Reject out-of-range components instead of letting Date normalise them.
    // Date.UTC(2020, 12, 99) is a real timestamp (2021-04-09), so a nonsense
    // suffix used to be aged as whatever it rolled over to and could then be
    // deleted on that basis. For an irreversible delete the correct posture is
    // "this name is not one I understand, so I will not act on it": an
    // unparseable tab is skipped and therefore kept. The trade-off is that a
    // hand-made bad name accumulates rather than ageing out -- visible and
    // harmless, unlike deleting on a date nobody wrote.
    var sy = +dateMatch[1], sm = +dateMatch[2], sd = +dateMatch[3];
    if (sm < 1 || sm > 12 || sd < 1 || sd > 31) continue;
    var sheetUtc = Date.UTC(sy, sm - 1, sd);
    // Catches the day-vs-month combinations the range check above cannot
    // (Feb 30, Apr 31): if normalisation moved any component, the date the
    // name claims does not exist.
    var back = new Date(sheetUtc);
    if (back.getUTCFullYear() !== sy || back.getUTCMonth() !== sm - 1
        || back.getUTCDate() !== sd) continue;
    var dayDiff = (todayUtc - sheetUtc) / (1000 * 3600 * 24);
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

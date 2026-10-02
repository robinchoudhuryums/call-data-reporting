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

// ING-5 (broad-scan 2026-09-23, Batch 8): the documented RECOVERY for a date
// past the window is to recreate its Call_Legs_<date> tab from the provider CSV
// and re-run the build / backfill -- but the nightly prune deleted that tab
// again before anyone got to it, since by definition it is older than the
// cutoff. A recovered tab is now HELD: the RETENTION_HOLD Script Property maps
// tab name -> hold-until (ms), the prune skips a held tab and drops expired
// holds. importBulkCSVsFromDrive holds every tab it creates; a tab recreated
// by hand is held by running holdCallLegsForRecovery() from the editor.
var RETENTION_HOLD_PROP = 'RETENTION_HOLD';
var RETENTION_RECOVERY_HOLD_DAYS = 3;

function retentionHoldRead_() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(RETENTION_HOLD_PROP);
    var m = raw ? JSON.parse(raw) : {};
    return (m && typeof m === 'object') ? m : {};
  } catch (e) { return {}; }
}
function retentionHoldWrite_(map) {
  try {
    var props = PropertiesService.getScriptProperties();
    if (Object.keys(map).length) props.setProperty(RETENTION_HOLD_PROP, JSON.stringify(map));
    else props.deleteProperty(RETENTION_HOLD_PROP);
  } catch (e) { Logger.log('retentionHoldWrite_: ' + e); }
}
/** Holds the named Call_Legs tabs from the prune for `days` (default 3). */
function retentionHoldTabs_(names, days) {
  var map = retentionHoldRead_();
  var until = Date.now() + (days || RETENTION_RECOVERY_HOLD_DAYS) * 86400000;
  (names || []).forEach(function (n) { if (n) map[n] = Math.max(Number(map[n]) || 0, until); });
  retentionHoldWrite_(map);
  return until;
}
/**
 * Editor-run (ING-5): after recreating Call_Legs_* tabs BY HAND for a
 * recovery, run this so the next prune does not delete them before the
 * rebuild / backfill runs. Holds every Call_Legs tab currently older than
 * the cutoff for RETENTION_RECOVERY_HOLD_DAYS.
 */
function holdCallLegsForRecovery() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('holdCallLegsForRecovery: run from the bound CDR Import project.');
  var now = new Date();
  var todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  var names = ss.getSheets().map(function (sh) { return sh.getName(); }).filter(function (n) {
    var m = n.match(/^Call_Legs_(\d{4})-(\d{2})-(\d{2})$/);
    return !!m && (todayUtc - Date.UTC(+m[1], +m[2] - 1, +m[3])) / 86400000 > RETENTION_CUTOFF_DAYS;
  });
  var until = retentionHoldTabs_(names, RETENTION_RECOVERY_HOLD_DAYS);
  Logger.log('holdCallLegsForRecovery: held ' + names.length + ' tab(s) until ' + new Date(until)
    + (names.length ? ': ' + names.join(', ') : ''));
  return { held: names.length, until: new Date(until).toISOString(), tabs: names };
}

// PIPE-2 (broad-scan 2026-10-01): the prune was AGE-ONLY, so a tab that was
// never imported -- the pending loop stalled on a bad tab (PIPE-1), a
// future-dated tab hid the real ones, a partial bulk recovery lost its hold --
// was deleted at 15 days with the day's data never landing anywhere. An
// over-age tab is now deleted only when the date is PROVEN imported: its name
// is in the `lastSheets` memo, or its date is in DQE or QCD Historical Data
// (the memo is capped at 60 names, so history is the authoritative check, read
// once and only when some over-age tab is not in the memo). A tab that cannot
// be proven imported is KEPT and named in the prune's Pipeline Health row; if
// the history read itself fails, every unproven tab is kept and the row is a
// FAILURE (retention is then not being enforced).
/** Union of the ISO dates present in DQE (col B) and QCD (col C) Historical Data. */
function retentionHistoryIsos_() {
  var target = SpreadsheetApp.openById(getTargetSsId_());
  var dqe = buildHistoryDateSet(target, 'DQE Historical Data', 2);
  var qcd = buildHistoryDateSet(target, 'QCD Historical Data', 3);
  return { has: function (iso) { return dqe.has(iso) || qcd.has(iso); } };
}

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

  var deleted = 0, kept = 0, held = 0;
  var unimported = [], historyError = null;   // PIPE-2
  var lastSheets = {};
  try {
    JSON.parse(PropertiesService.getScriptProperties().getProperty('lastSheets') || '[]')
      .forEach(function (n) { lastSheets[String(n)] = true; });
  } catch (e) { /* an unreadable memo just means every date is checked against history */ }
  var historyIsos = null;
  var provenImported = function (name, iso) {
    if (lastSheets[name]) return true;
    if (historyIsos === null && historyError === null) {
      try { historyIsos = retentionHistoryIsos_(); }
      catch (e) { historyError = (e && e.message) ? e.message : String(e); }
    }
    return historyError === null && historyIsos.has(iso);
  };
  // ING-5: recovery holds. Expired holds are dropped on the way.
  var holds = retentionHoldRead_(), holdsChanged = false, nowMs = Date.now();
  Object.keys(holds).forEach(function (n) {
    if (!(Number(holds[n]) > nowMs)) { delete holds[n]; holdsChanged = true; }
  });
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
    if (dayDiff > RETENTION_CUTOFF_DAYS && holds[name]) {
      held++;   // ING-5: a recovery tab, kept until its hold expires
      Logger.log('Kept held recovery sheet: ' + name);
    } else if (dayDiff > RETENTION_CUTOFF_DAYS
               && !provenImported(name, dateMatch[1] + '-' + dateMatch[2] + '-' + dateMatch[3])) {
      unimported.push(name);   // PIPE-2: never imported (or unverifiable) -- kept
      Logger.log('Kept over-age sheet that is not proven imported: ' + name);
    } else if (dayDiff > RETENTION_CUTOFF_DAYS) {
      ss.deleteSheet(sheet);
      deleted++;
      Logger.log('Deleted old sheet: ' + name);
    } else {
      kept++;
    }
  }
  if (holdsChanged) retentionHoldWrite_(holds);
  unimported.sort();
  Logger.log('deleteOldCDRSheets: deleted ' + deleted + ', kept ' + kept
    + (held ? ', held for recovery ' + held : '')
    + (unimported.length ? ', kept NOT-imported ' + unimported.length + ' (' + unimported.join(', ') + ')' : '')
    + (historyError ? ' -- history check FAILED: ' + historyError : '')
    + ' (cutoff ' + RETENTION_CUTOFF_DAYS + 'd).');
  return { deleted: deleted, kept: kept, held: held, unimported: unimported, historyError: historyError };
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
          // PIPE-2: a failed history check means retention is NOT being
          // enforced (every unproven tab was kept) -- that is a failure. A tab
          // merely kept because it was never imported is named, not failed:
          // the stall that caused it already logged its own failure
          // (autoImport / autoImport:parked).
          status: res.historyError ? 'failure' : 'success',
          rows: res.deleted,
          durationMs: Date.now() - t0,
          notes: 'deleted ' + res.deleted + ' Call_Legs sheet(s), ' + res.kept
            + ' within the ' + RETENTION_CUTOFF_DAYS + 'd window'
            + (res.held ? ', ' + res.held + ' held for recovery (ING-5)' : '')
            + (res.unimported && res.unimported.length
              ? ', KEPT ' + res.unimported.length + ' never-imported (PIPE-2): '
                + res.unimported.join(', ') + ' -- import (Manual Processing) or delete by hand'
              : '')
            + (res.historyError ? ' | history check failed, nothing unproven deleted: ' + res.historyError : ''),
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

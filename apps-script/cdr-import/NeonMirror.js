// NeonMirror.js — deferred (off-the-synchronous-import-path) Neon mirror.
// =============================================================================
// Phase 1, FLAG-GATED. Default behavior is UNCHANGED: when the
// `NEON_MIRROR_MODE` Script Property is unset or 'inline' (the default),
// processIntegratedHistory mirrors to Neon inline exactly as before and this
// module is dormant. Set NEON_MIRROR_MODE='deferred' to move the mirror off
// the synchronous import path:
//
//   - The daily import writes ONLY the sheets, then enqueues the processed
//     date to a `Neon Mirror Queue` tab in the CDR Report spreadsheet
//     (the cross-project shared channel -- cdr-import and the dashboard /
//     cdr-report have separate Script Properties, but share this workbook).
//   - A time-driven `runNeonMirror_` trigger (installed here in cdr-import via
//     installNeonMirrorTrigger / the CDR Tools menu) drains the queue a few
//     minutes later, RE-DERIVING each payload from the Historical Data sheets
//     and upserting to Neon via the SAME local writers the inline path uses
//     (writeCDRRowsToNeon / writeQCDRowsToNeon / writeDQERowsToNeon /
//     backfillInboundCalls). All writers are idempotent (ON CONFLICT), so a
//     partially-failed or Neon-unreachable date is simply left in the queue
//     and retried on the next run.
//
// Why re-derive from sheets (not replay an in-memory payload): the Historical
// Data sheets are the source of truth and we read durations via
// getDisplayValues() so the INV-02 spreadsheet-vs-script TZ +36:36 offset is
// avoided -- the field mappings below are faithful to the proven whole-sheet
// backfills in cdr-report/neonbackfill.js (CDR cols, DQE 36-col incl. slots,
// QCD 12-col) and to the inline payload shapes in autoImport.js.
//
// Operator notes (deferred mode only):
//   - Install the trigger once: run installNeonMirrorTrigger() (editor) or use
//     the CDR Tools menu. Set NEON_MIRROR_MODE='deferred' to activate the
//     enqueue. Revert any time by setting it back to 'inline' (or clearing it)
//     -- the inline path returns immediately with zero code change.
//   - The cdr-report standalone runDailyDQEBuild_ safety-net trigger still
//     mirrors DQE inline; in deferred mode that just makes the queued DQE
//     mirror redundant (harmless -- ON CONFLICT). Uninstall it once the
//     integrated path is trusted, per Operator State #8.
//   - INV-16: this module calls buildDQEHistoricalData with { skipNeon: true }
//     from autoImport in deferred mode; the duplicated buildDQEHistoricalData.js
//     copies are untouched.
// =============================================================================

var NEON_MIRROR_QUEUE_SHEET   = 'Neon Mirror Queue';
// Col 4 (Attempts) added by IMP-6 -- counts HARD-error drains (throws, not
// Neon-unreachable) so a poison-pill date can't retry + email forever.
// Pre-existing queue tabs keep their 3-col header; the reader treats a
// blank col 4 as 0, so no migration is needed.
var NEON_MIRROR_QUEUE_HEADERS = ['Enqueued At', 'Call Date', 'Source', 'Attempts'];

// IMP-6: after this many HARD-error drain attempts (throws -- e.g. a SQL
// error; Neon-UNREACHABLE never counts and retries indefinitely), the date
// is DROPPED from the queue with a loud `neonMirror:gave-up` failure row +
// one final email, instead of a failure email every 15-minute run forever.
// Script-Property-tunable like NEON_MIRROR_TAIL_ROWS.
var NEON_MIRROR_MAX_ATTEMPTS_DEFAULT = 8;

function nmMaxAttempts_() {
  var raw = null;
  try { raw = PropertiesService.getScriptProperties().getProperty('NEON_MIRROR_MAX_ATTEMPTS'); } catch (e) {}
  var n = parseInt(raw, 10);
  return (isFinite(n) && n > 0) ? n : NEON_MIRROR_MAX_ATTEMPTS_DEFAULT;
}

/**
 * Returns 'deferred' only when the NEON_MIRROR_MODE Script Property is
 * explicitly set to 'deferred' (case-insensitive); otherwise 'inline'.
 * Unset => 'inline' => byte-identical to the pre-feature daily import.
 */
function getNeonMirrorMode_() {
  var v = PropertiesService.getScriptProperties().getProperty('NEON_MIRROR_MODE');
  return (String(v || '').trim().toLowerCase() === 'deferred') ? 'deferred' : 'inline';
}

/**
 * Append one date to the shared Neon Mirror Queue tab. Best-effort: a logging
 * failure must never break the import (the sheets are already written).
 */
function enqueueNeonMirror_(targetSS, dateObj) {
  try {
    var iso = Utilities.formatDate(dateObj, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    var sh = targetSS.getSheetByName(NEON_MIRROR_QUEUE_SHEET);
    if (!sh) {
      sh = targetSS.insertSheet(NEON_MIRROR_QUEUE_SHEET);
      sh.appendRow(NEON_MIRROR_QUEUE_HEADERS);
      sh.setFrozenRows(1);
    }
    sh.appendRow([new Date(), iso, 'processIntegratedHistory', 0]);
    Logger.log('enqueueNeonMirror_: queued %s for deferred Neon mirror.', iso);
  } catch (e) {
    Logger.log('enqueueNeonMirror_ failed (best-effort): ' + e);
  }
}

/**
 * Trigger entry point. Drains the Neon Mirror Queue: for each distinct pending
 * date, re-derives CDR/QCD/DQE/Inbound from the sheets and upserts to Neon.
 * Dates that fully succeed are removed from the queue; dates that hit a
 * Neon-unreachable/error (or throw) are LEFT for the next run (writers are
 * idempotent). Serialized via LockService so it never overlaps an import or
 * another mirror run.
 */
function runNeonMirror_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('runNeonMirror_: lock busy, skipping this run.'); return; }
  try {
    var ss = SpreadsheetApp.openById(getTargetSsId_());
    var sh = ss.getSheetByName(NEON_MIRROR_QUEUE_SHEET);
    if (!sh || sh.getLastRow() < 2) { Logger.log('runNeonMirror_: queue empty.'); return; }

    var tz   = Session.getScriptTimeZone();
    var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues();
    var isoOfRow = function (r) {
      return (r[1] instanceof Date)
        ? Utilities.formatDate(r[1], tz, 'yyyy-MM-dd')
        : String(r[1] || '').trim();
    };

    // Distinct pending dates, in first-seen order. Per-date attempts = the
    // MAX of the date's rows' col-4 values (blank on pre-IMP-6 rows -> 0).
    var dates = [];
    var seen = {};
    var attemptsByDate = {};
    rows.forEach(function (r) {
      var iso = isoOfRow(r);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;
      if (!seen[iso]) { seen[iso] = true; dates.push(iso); }
      var a = parseInt(r[3], 10) || 0;
      if (!(iso in attemptsByDate) || a > attemptsByDate[iso]) attemptsByDate[iso] = a;
    });

    var done = {};
    var hardFailed = {};   // iso -> error message (a THROW, not Neon-unreachable)
    dates.forEach(function (iso) {
      try {
        if (neonMirrorDate_(ss, iso)) done[iso] = true;
        else Logger.log('runNeonMirror_: %s incomplete (Neon unreachable?), leaving queued.', iso);
      } catch (e) {
        hardFailed[iso] = (e && e.message) ? e.message : String(e);
        Logger.log('runNeonMirror_: %s failed, leaving queued: %s', iso, e);
        try { notifyNeonWriteFailure('runNeonMirror_ (' + iso + ')', hardFailed[iso]); }
        catch (ne) { /* best-effort */ }
      }
    });

    // Rewrite the queue with only the rows whose date didn't fully process.
    // IMP-6 retry cap: a HARD-error date increments its Attempts; at
    // nmMaxAttempts_() it is DROPPED (parked) with a `neonMirror:gave-up`
    // failure row + one final email, so a poison-pill date can't email every
    // 15-min run forever. Neon-UNREACHABLE dates never increment -- an
    // outage retries indefinitely, as before.
    var maxAttempts = nmMaxAttempts_();
    var gaveUp = [];
    var remaining = [];
    rows.forEach(function (r) {
      var iso = isoOfRow(r);
      if (done[iso]) return;
      var attempts = attemptsByDate[iso] || 0;
      if (hardFailed[iso]) {
        attempts += 1;
        if (attempts >= maxAttempts) {
          if (gaveUp.indexOf(iso) === -1) gaveUp.push(iso);
          return;   // dropped from the queue
        }
      }
      remaining.push([r[0], r[1], r[2], attempts]);
    });
    gaveUp.forEach(function (iso) {
      neonMirrorLog_(ss, 'neonMirror:gave-up', 'failure', null, Date.now(),
        iso + ' | dropped from the queue after ' + maxAttempts + ' failed attempts: '
        + (hardFailed[iso] || '') + ' -- fix the cause, then re-enqueue the date '
        + '(append a row to the Neon Mirror Queue tab) or run the per-type backfills.');
    });
    if (gaveUp.length) {
      try {
        notifyNeonWriteFailure('runNeonMirror_ GAVE UP: ' + gaveUp.join(', '),
          'Dropped from the deferred-mirror queue after ' + maxAttempts
          + ' failed attempts each (this is the LAST email for these dates).\n\n'
          + gaveUp.map(function (iso) { return iso + ': ' + (hardFailed[iso] || ''); }).join('\n')
          + '\n\nFix the cause, then re-enqueue each date (append a row to the '
          + '"Neon Mirror Queue" tab in the CDR Report spreadsheet) or run the '
          + 'per-type backfills for it.');
      } catch (ne) { /* best-effort */ }
    }
    sh.getRange(2, 1, sh.getMaxRows() - 1, 4).clearContent();
    if (remaining.length) sh.getRange(2, 1, remaining.length, 4).setValues(remaining);
    Logger.log('runNeonMirror_: processed %s date(s); %s row(s) left queued; %s date(s) gave up.',
      Object.keys(done).length, remaining.length, gaveUp.length);
  } finally {
    lock.releaseLock();
  }
}

/** Manual on-demand drain (editor / menu). Same as the trigger body. */
function runNeonMirrorNow() { runNeonMirror_(); }

/**
 * Mirror all four outputs for ONE date from the sheets to Neon. Returns true
 * only if every applicable mirror succeeded (or had nothing to mirror); false
 * if any reported Neon-unreachable, so the caller keeps the date queued.
 * Each type logs its own Pipeline Health row (INV-44).
 */
function neonMirrorDate_(ss, iso) {
  var allOk = true;
  var step = function (label, fn) {
    var t0 = Date.now();
    var res;
    try {
      res = fn();
    } catch (e) {
      allOk = false;
      neonMirrorLog_(ss, 'neonMirror:' + label, 'failure', null, t0, iso + ' | ' + ((e && e.message) ? e.message : String(e)));
      throw e;   // a hard error keeps the date queued AND surfaces upstream
    }
    if (res && res.unreachable) {
      allOk = false;
      neonMirrorLog_(ss, 'neonMirror:' + label, 'failure', null, t0, iso + ' | Neon unreachable');
    } else {
      // F6: writers may attach a `note` (e.g. CDR's phone-child count) so a
      // secondary-mirror outcome is visible in the Pipeline Health row.
      neonMirrorLog_(ss, 'neonMirror:' + label, 'success', (res && res.rows) || 0, t0,
        iso + ((res && res.note) ? ' | ' + res.note : ''));
    }
    return res;
  };

  step('CDR', function () { return mirrorCdrForDate_(ss, iso); });
  step('QCD', function () { return mirrorQcdForDate_(ss, iso); });
  step('DQE', function () { return mirrorDqeForDate_(ss, iso); });
  step('Inbound', function () { return mirrorInboundForDate_(iso); });

  return allOk;
}

function neonMirrorLog_(ss, stepName, status, rows, t0, notes) {
  try {
    logPipelineHealthWithFallback_(ss, {
      step: stepName, status: status, rows: rows,
      durationMs: Date.now() - t0, notes: notes,
    });
  } catch (e) { /* best-effort */ }
}

// --- F-20: bounded tail-scan for the per-date sheet reads --------------------
//
// Each drained date used to re-read the ENTIRE historical sheet (CDR 26-col /
// QCD 12-col / DQE 36-col getDisplayValues), making every queued date cost
// O(full history) -- a multi-date backlog could stop catching up as history
// grows. The queue only ever holds recently-imported dates and the sheets are
// APPEND-ORDERED (a build writes a date's rows in one contiguous append; a
// force re-import deletes the date's rows then re-appends at the bottom), so
// the target block lives near the bottom. Scan a bounded tail window and
// WIDEN (x4, up to the full sheet) whenever:
//   - no row matched (an OLD date was queued -- must still mirror correctly), or
//   - the window's TOP row matches the date (the block may extend above it).
// A window is accepted only when it contains matches AND a non-matching row
// sits above the topmost match -- with contiguous per-date blocks that means
// the COMPLETE block is inside the window, so the result is row-for-row
// identical to a full scan. Window size tunable via the cdr-import Script
// Property NEON_MIRROR_TAIL_ROWS (default 3000 -- weeks of daily volume).

var NEON_MIRROR_TAIL_ROWS_DEFAULT = 3000;

function nmTailRows_() {
  var raw = null;
  try { raw = PropertiesService.getScriptProperties().getProperty('NEON_MIRROR_TAIL_ROWS'); } catch (e) {}
  var n = parseInt(raw, 10);
  return (isFinite(n) && n > 0) ? n : NEON_MIRROR_TAIL_ROWS_DEFAULT;
}

/**
 * Returns the DISPLAY rows (width numCols) whose date column (0-based
 * dateCol0, matched via parseDateForNeon) equals `iso`, reading as little
 * of the sheet as the widening rules above allow.
 */
function nmReadDateRowsTail_(sheet, numCols, dateCol0, iso) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var win = nmTailRows_();
  for (;;) {
    var start = Math.max(2, lastRow - win + 1);
    var data = sheet.getRange(start, 1, lastRow - start + 1, numCols).getDisplayValues();
    var matches = [];
    var topMatches = false;
    for (var i = 0; i < data.length; i++) {
      var cell = data[i][dateCol0];
      if (cell && parseDateForNeon(cell) === iso) {
        if (i === 0) topMatches = true;
        matches.push(data[i]);
      }
    }
    if (start === 2) return matches;                    // full sheet covered
    if (matches.length && !topMatches) return matches;  // complete block inside the window
    win = win * 4;                                       // widen: old date, or block clipped at the top
  }
}

// --- Per-date re-derivations (faithful to neonbackfill.js + the inline shapes) ---

/** CDR Historical Data (26 cols) -> writeCDRRowsToNeon, filtered to `iso`. */
function mirrorCdrForDate_(ss, iso) {
  var sheet = ss.getSheetByName('CDR Historical Data');
  if (!sheet || sheet.getLastRow() < 2) return { rows: 0 };
  var data = nmReadDateRowsTail_(sheet, 26, 2, iso);   // F-20 bounded tail-scan
  // (writeCDRRowsToNeon resets the per-run CDR_HMAC_CACHE_ memo itself.)
  var batch = [];
  data.forEach(function (r) {
    if (!r[2] || !r[4]) return;                 // need a date (col 3) + agent (col 5)
    batch.push({
      callDate:   parseDateForNeon(r[2]),       // writeCDRRowsToNeon binds callDate raw
      dept:       r[3] || 'Unassigned',
      agentName:  r[4],
      obTotal:    r[5],  obAns:     r[6],  obMiss:     r[7],
      obListTot:  r[8],  obListAns: r[9],  obListMiss: r[10],
      ibTotal:    r[11], ibAns:     r[12], ibMiss:     r[13],
      ibAnsInt:   r[14], ibAnsExt:  r[15],
      ibListTot:  r[16], ibListAns: r[17], ibListMiss: r[18],
      obExtTotal: r[19], obExtAns:  r[20],
      obExtTTT:   r[21], obExtATT:  r[22],
      phonesX:    r[23], phonesY:   r[24], phonesZ:    r[25],
    });
  });
  if (!batch.length) return { rows: 0 };
  var res = writeCDRRowsToNeon(batch);
  if (res && res.skipped) return { unreachable: true, rows: 0 };
  // F6: surface the phone-child row count in the Pipeline Health note so the
  // secondary mirror (call_history_phones) is observable. (A phone-insert
  // failure already throws out of writeCDRRowsToNeon and is caught by
  // neonMirrorDate_'s step, which keeps the date queued -- so this is the
  // observability gap, not a silent-loss path.)
  return { rows: batch.length, note: 'phones=' + ((res && res.phones) || 0) };
}

/** QCD Historical Data (12 cols) -> writeQCDRowsToNeon, filtered to `iso`. */
function mirrorQcdForDate_(ss, iso) {
  var sheet = ss.getSheetByName('QCD Historical Data');
  if (!sheet || sheet.getLastRow() < 2) return { rows: 0 };
  var data = nmReadDateRowsTail_(sheet, 12, 2, iso);   // F-20 bounded tail-scan
  var batch = [];
  data.forEach(function (r) {
    if (!r[2] || !r[3] || !r[4]) return;        // date (col 3), queue (col 4), source (col 5)
    batch.push({
      monthYear:     r[0],  week:          r[1],  callDate:      r[2],  // writer normalizes callDate
      callQueue:     r[3],  callSource:    r[4],
      totalCalls:    r[5],  totalAnswered: r[6],  abandoned:     r[7],
      longestWait:   r[8],  avgAnswer:     r[9],
      abandonedPct:  r[10], violations:    r[11],
    });
  });
  if (!batch.length) return { rows: 0 };
  var res = writeQCDRowsToNeon(batch);
  if (res && res.skipped) return { unreachable: true, rows: 0 };
  return { rows: batch.length };
}

// Coerced-abandoned-cell guard. KEPT BYTE-IDENTICAL to
// cdr-report/neonbackfill.js::sanitizeAbandonedCellForNeon_ (Apps Script has no
// cross-project sharing; both copies must agree). Recovers LOSSLESS single
// values and marks genuinely-lost multi-value coercions with the #REBUILD
// sentinel that the dashboard's classifyAbandonedCell_ recognizes. 15 digits is
// the safe-integer ceiling (2^53 ~ 9.0e15); a real abandoned ID / epoch-ms time
// is 13 digits, so a correct single value always survives.
var DQE_ABANDONED_LOST_SENTINEL = '#REBUILD';

function sanitizeAbandonedCellForNeon_(raw) {
  var s = (raw == null ? '' : String(raw)).trim();
  if (!s) return null;                                   // genuinely empty (0 abandoned)
  if (s === DQE_ABANDONED_LOST_SENTINEL) return DQE_ABANDONED_LOST_SENTINEL;  // already marked
  // Coerced + re-rendered as a float: scientific notation or a decimal point.
  if (/[eE][+\-]?\d/.test(s) || s.indexOf('.') !== -1) return DQE_ABANDONED_LOST_SENTINEL;
  // Thousands-separated number: 1-3 leading digits then only 3-digit groups.
  if (/^\d{1,3}(,\d{3})+$/.test(s)) {
    var digits = s.replace(/,/g, '');
    // single value (<=15 digits) is recoverable; multi-value lost past 2^53.
    return digits.length <= 15 ? digits : DQE_ABANDONED_LOST_SENTINEL;
  }
  // Bare digit run, no separators, too long to be one real ID -> coerced + lost.
  if (/^\d+$/.test(s) && s.length > 15) return DQE_ABANDONED_LOST_SENTINEL;
  // Otherwise: a correct single long ID, or a comma-list of long IDs. Keep.
  return s;
}


// F-51: the 19 slot columns (K-AC) hold comma-joined H:MM:SS times and
// coerce like AF -- but the sheet->Neon paths mirrored them VERBATIM, so a
// still-coerced cell (a "12/30/1899 10:23:33" date render, or a bare serial
// decimal) landed in slot_* as an unparseable token. Pass clean cells
// through, recover the lossless single-value date-render coercion (keep the
// time part), and EXCLUDE (null) anything else rather than mirror garbage --
// the run-order discipline ("run repairDqeSlotTimestamps first") is now a
// safety net instead of the only protection. KEEP THIS COPY IDENTICAL in
// cdr-report/neonbackfill.js and cdr-import/NeonMirror.js -- enforced by
// scripts/check-duplicated-files.sh's function-level check.
function sanitizeSlotCellForNeon_(raw) {
  var s = (raw == null ? '' : String(raw)).trim();
  if (!s) return '';
  var tokens = s.split(',').map(function (t) { return t.trim(); }).filter(function (t) { return !!t; });
  var timeRe = /^\d{1,2}:\d{2}(:\d{2})?$/;
  var ok = tokens.length > 0;
  for (var i = 0; i < tokens.length; i++) {
    if (!timeRe.test(tokens[i])) { ok = false; break; }
  }
  if (ok) return tokens.join(',');
  var m = s.match(/^\d{1,2}\/\d{1,2}\/\d{4}\s+(\d{1,2}:\d{2}:\d{2})/);
  if (m) return m[1];
  return null;
}

/** DQE Historical Data (36 cols, incl. 19 time-slot cols) -> writeDQERowsToNeon. */
function mirrorDqeForDate_(ss, iso) {
  var sheet = ss.getSheetByName('DQE Historical Data');
  if (!sheet || sheet.getLastRow() < 2) return { rows: 0 };
  var data = nmReadDateRowsTail_(sheet, 36, 1, iso);   // F-20 bounded tail-scan
  var batch = [];
  data.forEach(function (r) {
    if (!r[1] || !r[2]) return;                 // date (col 2), agent (col 3)
    batch.push({
      monthYear:        r[0]  || null,
      callDate:         r[1],                    // writer normalizes callDate
      agentName:        r[2],
      queueExtensions:  r[3]  || null,
      totalUnique:      parseInt(r[4]) || 0,
      totalRung:        parseInt(r[5]) || 0,
      totalMissed:      parseInt(r[6]) || 0,
      totalAnswered:    parseInt(r[7]) || 0,
      ttt:              r[8]  || null,
      att:              r[9]  || null,
      slots:            r.slice(10, 29).map(sanitizeSlotCellForNeon_),   // F-51
      // F3: route the comma-joined abandoned-ID/time cells (AD/AE/AF, cols
      // 30-32) through the same coercion guard the whole-sheet backfill uses
      // (cdr-report/neonbackfill.js). getDisplayValues on a pre-protection
      // coerced cell returns a thousands-separated / scientific number that,
      // written as-is, mis-splits on the separator commas downstream; the
      // sanitizer recovers lossless single values and marks genuinely-lost
      // multi-value cells with the #REBUILD sentinel. Without this the
      // deferred mirror wrote garbage where the backfill wrote a clean value.
      abParentIds:      sanitizeAbandonedCellForNeon_(r[29]),
      abMissedIds:      sanitizeAbandonedCellForNeon_(r[30]),
      abMissedTimes:    sanitizeAbandonedCellForNeon_(r[31]),
      avgAbdWait:       r[32] || null,
      csrAvgAbdWait:    r[33] || null,
    });
  });
  if (!batch.length) return { rows: 0 };
  var res = writeDQERowsToNeon(batch);
  if (res && res.skipped) return { unreachable: true, rows: 0 };
  return { rows: batch.length };
}

/**
 * Inbound mirror for one date. Reuses the proven backfillInboundCalls
 * (reads Call_Legs_* sheets; force=true refreshes via ON CONFLICT). Note the
 * ~14-day Call_Legs retention -- the trigger runs minutes after import, well
 * inside it. backfillInboundCalls logs its own outcome; we surface a coarse
 * row count and treat a throw as a hard failure (date stays queued).
 */
function mirrorInboundForDate_(iso) {
  // F1: backfillInboundCalls now returns a structured outcome
  // { inserted, unreachable, failures, ... }. Honor it so a Neon-unreachable
  // or hard-failed date stays queued. Previously the function returned
  // undefined, so `res` was always falsy: this helper reported { rows: 0 }
  // success unconditionally and the date got dequeued -- silently dropping
  // unrecoverable inbound_calls data (no sheet primary) on any inbound outage.
  var res = backfillInboundCalls(iso, iso, true);
  if (res && res.unreachable) return { unreachable: true, rows: 0 };
  if (res && res.failures) {
    // A hard write error (not reachability) -- throw so neonMirrorDate_'s step
    // logs a real failure and keeps the date queued (mirrors how the CDR/QCD/
    // DQE writers surface a non-skip error).
    throw new Error('inbound mirror failed for ' + iso + ' (' + res.failures + ' write failure(s))');
  }
  return { rows: (res && res.inserted) || 0 };
}

// --- Trigger lifecycle (editor / CDR Tools menu) -----------------------------

function installNeonMirrorTrigger() {
  uninstallNeonMirrorTrigger();
  ScriptApp.newTrigger('runNeonMirror_').timeBased().everyMinutes(15).create();
  Logger.log('Neon mirror trigger installed (runNeonMirror_, every 15 min). '
    + 'Set Script Property NEON_MIRROR_MODE=deferred to start enqueuing.');
}

function uninstallNeonMirrorTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runNeonMirror_') ScriptApp.deleteTrigger(t);
  });
  Logger.log('Neon mirror trigger removed (if it existed).');
}

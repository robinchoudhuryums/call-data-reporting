/**
 * Pipeline-failure watchdog (optional, admin-toggled). Testing-feedback #3.
 *
 * The System Health page ("Recent pipeline step failures") and the Overview
 * Pipeline Health banner surface pipeline FAILURE rows PASSIVELY -- an admin
 * only sees them if they happen to open the dashboard. This watchdog PUSHES
 * them: an hourly time trigger scans the `Pipeline Health` sheet for rows with
 * status `failure` newer than a stored watermark and emails the admins a digest
 * of the new failures. So a mid-import step failure (a `:DQE` / `:QCD` / `:neon`
 * mirror error, a `buildDQE` throw, a `neonMirror:gave-up`, ...) reaches an
 * admin's inbox without anyone opening the dashboard.
 *
 * It COMPLEMENTS the ingest-failure watchdog (IngestWatchdog.gs): that one
 * pushes STALENESS (no fresh DQE build landed at all); this one pushes explicit
 * FAILURE rows (a step ran and errored). Both are pull-vs-push companions to the
 * passive banner.
 *
 * Dedup / no-spam:
 *  - A watermark (`PIPELINE_WATCH_LAST_TS`, epoch ms) advances past every row
 *    examined, so each failure row is alerted AT MOST ONCE and a later success
 *    row can't re-surface an old failure (Pipeline Health is append-only +
 *    chronological, so a new failure always has a later timestamp).
 *  - All new failures since the last run are batched into ONE email.
 *  - The FIRST run (no watermark) establishes the baseline SILENTLY -- it never
 *    blasts the backlog of historical failures at install time.
 *
 * Gating + safety:
 *  - No-ops cheaply (a property read) when `PIPELINE_WATCH_ENABLED` != 'true'.
 *  - Runs hourly, any day (pipeline failures aren't weekday-only -- a nightly
 *    mirror drain can fail on a Sunday).
 *  - Best-effort: the trigger entry point never throws. On a mail-send failure
 *    the watermark is LEFT UN-advanced so the same failures retry next run
 *    (the OPS-1 "arm only on a confirmed send" discipline).
 *
 * Scope: reuses script.scriptapp (trigger management) + script.send_mail
 * (already present, INV-31). No new OAuth scope.
 *
 * Operator setup (editor-run, admin):
 *   installPipelineWatchTrigger()    // sets PIPELINE_WATCH_ENABLED + installs trigger
 *   uninstallPipelineWatchTrigger()  // removes trigger + clears the flag
 *   getPipelineWatchStatus()         // read current state
 * Tunable Script Property:
 *   PIPELINE_WATCH_SCAN_ROWS  (default 300; tail of Pipeline Health scanned per run)
 */

var PIPELINE_WATCH_DEFAULT_SCAN_ROWS = 300;
var PIPELINE_WATCH_MAX_EMAIL_ROWS = 25;   // cap the digest body (a burst can be large)

// ── Public (admin-gated) API ──────────────────────────────────────────

/** Admin-only status read. */
function getPipelineWatchStatus() {
  assertAdmin_();
  return getPipelineWatchStatus_();
}

/** Admin-only: enable + install the watchdog trigger. Returns status. */
function installPipelineWatchTrigger() {
  assertAdmin_();
  PropertiesService.getScriptProperties().setProperty('PIPELINE_WATCH_ENABLED', 'true');
  installPipelineWatchTrigger_();
  return getPipelineWatchStatus_();
}

/** Admin-only: uninstall the trigger + clear the enabled flag. Returns status. */
function uninstallPipelineWatchTrigger() {
  assertAdmin_();
  uninstallPipelineWatchTrigger_();
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty('PIPELINE_WATCH_ENABLED');
  return getPipelineWatchStatus_();
}

// ── Trigger entry point ───────────────────────────────────────────────

/**
 * Time-driven target (underscore-suffixed so google.script.run can't reach it;
 * ScriptApp dispatch still calls it by name). Best-effort: never throws.
 */
function runPipelineWatch_() {
  // Gap #3: piggyback the hourly cadence for the count-only pending-review
  // ping (Escalations.gs; its OWN NOTIFY_PENDING_REVIEW flag, default off --
  // a no-op unless explicitly enabled). Dispatched FIRST because the
  // pipeline scan below has several early returns (disabled / empty sheet /
  // baseline / no failures) that must not starve it; itself best-effort.
  try {
    if (typeof escPendingReviewPing_ === 'function') escPendingReviewPing_();
  } catch (pe) {
    Logger.log('escPendingReviewPing_ dispatch failed: ' + (pe && pe.message ? pe.message : pe));
  }
  try {
    var props = PropertiesService.getScriptProperties();
    if (String(props.getProperty('PIPELINE_WATCH_ENABLED') || '') !== 'true') return;

    var scanRows = pipelineWatchScanRows_(props.getProperty('PIPELINE_WATCH_SCAN_ROWS'));
    var rows = pipelineWatchReadRows_(scanRows);
    if (!rows.length) return;   // empty / missing sheet -- nothing to do

    var lastTsRaw = props.getProperty('PIPELINE_WATCH_LAST_TS');
    var firstRun = (lastTsRaw == null || lastTsRaw === '');
    var sinceMs = firstRun ? null : (parseFloat(lastTsRaw) || 0);

    // O-6: the fixed tail read + watermark-advance pair silently skipped rows.
    // If the OLDEST examined row is still newer than the watermark AND the
    // read came back clipped (exactly the requested row count), failures may
    // sit between the watermark and the window top -- a retry storm (the LM1
    // class that logs >300 rows in one interval) would evict them, and
    // advancing the watermark below then silenced them FOREVER. Widen the
    // read x4 (the F-20 tail-scan pattern) until the window reaches the
    // watermark or the whole sheet, bounded at 3 widenings (x64 = 19,200
    // rows -- far beyond any real storm).
    var widenGuard = 0;
    while (pipelineWatchTailClipped_(rows, scanRows, sinceMs) && widenGuard < 3) {
      scanRows = scanRows * 4;
      rows = pipelineWatchReadRows_(scanRows);
      widenGuard++;
    }

    var scan = pipelineWatchScan_(rows, sinceMs);

    if (firstRun) {
      // Baseline: record the newest row so future runs only alert on rows that
      // land AFTER install. Never email the historical backlog. The "ok " prefix
      // keeps the System Health outcome row green (OPS-8: its classifier paints
      // amber on a "fail"/"error" substring UNLESS the result starts with "ok").
      pipelineWatchRecord_(props, scan.maxTsMs, 'ok (baseline established)');
      return;
    }

    if (!scan.newFailures.length) {
      // Advance past the examined rows so they aren't rescanned; no email. "ok "
      // prefix so the healthy "no new failures" line doesn't read as a warning
      // via the OPS-8 "failures" substring.
      pipelineWatchRecord_(props, Math.max(sinceMs, scan.maxTsMs), 'ok (no new failures)');
      return;
    }

    var sent = notifyPipelineFailures_(scan.newFailures);
    if (sent) {
      pipelineWatchRecord_(props, Math.max(sinceMs, scan.maxTsMs),
        scan.newFailures.length + ' failure(s) emailed');
    } else {
      // OPS-1: mail failed -- DON'T advance the watermark, so the same failures
      // (plus any newer ones) retry on the next run instead of being silenced.
      try {
        props.setProperty('PIPELINE_WATCH_LAST', new Date().toISOString());
        props.setProperty('PIPELINE_WATCH_LAST_RESULT',
          scan.newFailures.length + ' failure(s) -- email send FAILED, will retry next run');
      } catch (pe) { /* best-effort */ }
    }
  } catch (e) {
    Logger.log('runPipelineWatch_ failed: ' + (e && e.message ? e.message : e));
  }
}

function pipelineWatchRecord_(props, watermarkMs, result) {
  try {
    if (watermarkMs != null && isFinite(watermarkMs)) {
      props.setProperty('PIPELINE_WATCH_LAST_TS', String(watermarkMs));
    }
    props.setProperty('PIPELINE_WATCH_LAST', new Date().toISOString());
    props.setProperty('PIPELINE_WATCH_LAST_RESULT', result);
  } catch (pe) { /* best-effort */ }
}

/**
 * O-6 pure predicate (unit-tested): TRUE when the tail read is CLIPPED (came
 * back with exactly the requested row count, so older rows exist beyond the
 * window top) AND the oldest examined row is still newer than the watermark --
 * i.e. there may be unexamined rows the watermark hasn't cleared. First-run
 * baselines (sinceMs null/0) never widen: the baseline intentionally ignores
 * the backlog.
 */
function pipelineWatchTailClipped_(rows, requestedRows, sinceMs) {
  if (sinceMs == null || !(sinceMs > 0)) return false;
  if (!rows || rows.length < requestedRows) return false;   // whole sheet already read
  var oldest = rows[0] && rows[0].tsMs;
  return oldest != null && isFinite(oldest) && oldest > sinceMs;
}

/**
 * Pure scan (unit-tested): given Pipeline Health rows (each with a numeric
 * `tsMs`, `status`, ...) and a watermark `sinceMs` (or null on the first run),
 * returns the FAILURE rows newer than the watermark (ascending by time, for a
 * readable email) plus `maxTsMs` = the newest timestamp across ALL rows (so the
 * caller can advance past successes too). `sinceMs === null` yields no failures
 * (first-run baseline) while still computing `maxTsMs`.
 */
function pipelineWatchScan_(rows, sinceMs) {
  var maxTsMs = (sinceMs == null) ? 0 : sinceMs;
  var newFailures = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var ts = r.tsMs;
    if (ts != null && isFinite(ts) && ts > maxTsMs) maxTsMs = ts;
    if (sinceMs == null) continue;   // baseline run: never flag failures
    if (ts == null || !isFinite(ts)) continue;   // no usable timestamp -> can't dedup
    if (ts <= sinceMs) continue;
    if (String(r.status || '').toLowerCase() === 'failure') newFailures.push(r);
  }
  newFailures.sort(function (a, b) { return (a.tsMs || 0) - (b.tsMs || 0); });
  return { newFailures: newFailures, maxTsMs: maxTsMs };
}

/**
 * Emails the admins a digest of the new failures. Returns TRUE only on a
 * confirmed send (OPS-1); a swallowed MailApp failure / no-admins returns
 * false so the caller leaves the watermark un-advanced and retries.
 */
function notifyPipelineFailures_(failures) {
  try {
    var to = getAdminEmails_().join(',');
    if (!to) return false;
    var url = PropertiesService.getScriptProperties().getProperty('DASHBOARD_URL') || '';
    var shown = failures.slice(0, PIPELINE_WATCH_MAX_EMAIL_ROWS);
    var lines = shown.map(function (f) {
      return '  • ' + (f.timestamp || '(no time)') + '   ' + (f.step || '(step?)')
           + '   [' + (f.status || 'failure') + ']'
           + (f.notes ? '   — ' + f.notes : '');
    });
    var more = failures.length > PIPELINE_WATCH_MAX_EMAIL_ROWS
      ? ('\n  … and ' + (failures.length - PIPELINE_WATCH_MAX_EMAIL_ROWS) + ' more.') : '';
    var n = failures.length;
    MailApp.sendEmail({
      to:      to,
      subject: '[Dashboard] Pipeline failure' + (n === 1 ? '' : 's') + ': ' + n + ' new',
      body:    n + ' new Pipeline Health failure' + (n === 1 ? '' : 's') + ' logged:\n\n'
             + lines.join('\n') + more + '\n\n'
             + 'Each is a pipeline step whose run logged a failure. Investigate via:\n'
             + '  1. System Health (Admin ▾ → Health) — "Recent pipeline step failures"\n'
             + '  2. The cdr-import / cdr-report execution log for the failing step\n'
             + '  3. Pipeline Health sheet (Alerts modal → Pipeline Health)\n'
             + (url ? '\nDashboard: ' + url + '\n' : '')
             + '\nOne email per new batch; you will not be re-alerted for these same rows.',
    });
    return true;
  } catch (mailErr) {
    Logger.log('notifyPipelineFailures_ mail failed: ' + mailErr);
    return false;
  }
}

// ── Internals ─────────────────────────────────────────────────────────

/**
 * Reads the last `maxRows` Pipeline Health rows, keeping the RAW timestamp as
 * epoch ms (`tsMs`) for watermark comparison -- unlike Alerts.gs's
 * `readPipelineHealth_`, which formats to a minute-precision string. Returns
 * oldest-first. INV-44 schema: Timestamp | Step | Status | Rows | Duration | Notes.
 */
function pipelineWatchReadRows_(maxRows) {
  var ss = openSpreadsheet_();
  var sheet = ss.getSheetByName(SHEETS.PIPELINE_HEALTH);
  if (!sheet) return [];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var startRow = Math.max(2, lastRow - maxRows + 1);
  var vals = sheet.getRange(startRow, 1, lastRow - startRow + 1,
                            PIPELINE_HEALTH_HEADERS.length).getValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    var ts = r[0];
    var tsMs = (ts instanceof Date) ? ts.getTime()
             : (ts ? Date.parse(String(ts)) : NaN);
    out.push({
      tsMs:      isFinite(tsMs) ? tsMs : null,
      timestamp: (ts instanceof Date) ? Utilities.formatDate(ts, TZ, 'yyyy-MM-dd HH:mm')
                                       : String(ts || ''),
      step:      String(r[1] || ''),
      status:    String(r[2] || ''),
      rows:      r[3] === '' || r[3] == null ? null : r[3],
      notes:     String(r[5] || ''),
    });
  }
  return out;
}

function pipelineWatchScanRows_(raw) {
  var n = parseInt(raw, 10);
  return (isFinite(n) && n > 0) ? n : PIPELINE_WATCH_DEFAULT_SCAN_ROWS;
}

function installPipelineWatchTrigger_() {
  uninstallPipelineWatchTrigger_();
  ScriptApp.newTrigger('runPipelineWatch_')
    .timeBased()
    .everyHours(1)
    .create();
}

function uninstallPipelineWatchTrigger_() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runPipelineWatch_') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}

function getPipelineWatchStatus_() {
  var props = PropertiesService.getScriptProperties();
  var installed = false;
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runPipelineWatch_') { installed = true; break; }
  }
  var lastTs = props.getProperty('PIPELINE_WATCH_LAST_TS');
  return {
    installed:   installed,
    enabled:     String(props.getProperty('PIPELINE_WATCH_ENABLED') || '') === 'true',
    scanRows:    pipelineWatchScanRows_(props.getProperty('PIPELINE_WATCH_SCAN_ROWS')),
    lastRun:     props.getProperty('PIPELINE_WATCH_LAST') || null,
    lastResult:  props.getProperty('PIPELINE_WATCH_LAST_RESULT') || null,
    watermark:   (lastTs != null && lastTs !== '')
                   ? Utilities.formatDate(new Date(parseFloat(lastTs)), TZ, 'yyyy-MM-dd HH:mm')
                   : null,
    adminCount:  getAdminEmails_().length,
  };
}

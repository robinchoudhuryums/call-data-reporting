/**
 * execCeilingProbe.js -- MEASURE the Apps Script execution ceiling once.
 *
 * P-3 (broad-scan 2026-09-17): this repo carried TWO beliefs about the
 * per-execution ceiling -- "30 min" (the bulk budget's comment, the inbound
 * backfill's) and "6 min" (the dashboard docs, an OBSERVED kill). Whichever is
 * right, one family of time budgets is wrong, and a wrong budget is not a
 * tuning problem: a run killed at the ceiling dies PAST its catch blocks, so
 * the bulk path's pause never fires and the in-flight date's failure row is
 * never written. The number depends on the account type and is not derivable
 * from code, so it is measured:
 *
 *   1. CDR Tools -> "Measure execution ceiling (one-shot probe)" installs a
 *      one-shot time trigger that runs `runExecCeilingProbe_` in ~1 min (a
 *      TRIGGER, not an editor run -- the trigger ceiling is the one the daily
 *      import and the mirror drain live under).
 *   2. The probe sleeps in 10 s steps for up to EXEC_CEILING_PROBE_MAX_MS,
 *      writing its elapsed time to `EXEC_CEILING_PROBE_LAST_MS` after every
 *      step. When the platform kills it, the last value written IS the
 *      ceiling (to within 10 s). If it finishes, the ceiling is above the max.
 *   3. CDR Tools -> "Read execution-ceiling probe result" reads the properties
 *      and says what to set `BULK_TIME_LIMIT_MS` / `IC_BACKFILL_TIME_LIMIT_MS`
 *      to (ceiling minus ~2 min for the in-flight date + the final archive).
 *
 * Read-only apart from its own three Script Properties. Never leaves its
 * trigger behind: the probe deletes it on completion, and the installer
 * replaces any earlier copy.
 */

var EXEC_CEILING_PROBE_HANDLER_ = 'runExecCeilingProbe_';
var EXEC_CEILING_PROBE_MAX_MS = 40 * 60 * 1000;   // above any documented Apps Script ceiling
var EXEC_CEILING_PROBE_STEP_MS = 10 * 1000;

function installExecCeilingProbeTrigger() {
  deleteExecCeilingProbeTriggers_();
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty('EXEC_CEILING_PROBE_LAST_MS');
  props.deleteProperty('EXEC_CEILING_PROBE_FINISHED');
  props.setProperty('EXEC_CEILING_PROBE_STARTED', 'scheduled ' + new Date().toISOString());
  ScriptApp.newTrigger(EXEC_CEILING_PROBE_HANDLER_).timeBased().after(60 * 1000).create();
  var msg = 'A one-shot trigger will run the probe in ~1 minute and sleep until the platform '
    + 'kills it (at most ' + Math.round(EXEC_CEILING_PROBE_MAX_MS / 60000) + ' min). Come back in '
    + '~45 minutes and run "Read execution-ceiling probe result". Nothing else runs meanwhile; '
    + 'avoid a Manual Export while it is in flight.';
  try { SpreadsheetApp.getUi().alert('Execution-ceiling probe scheduled', msg, SpreadsheetApp.getUi().ButtonSet.OK); }
  catch (e) { Logger.log('installExecCeilingProbeTrigger: ' + msg); }
}

/** Trigger body. Sleeps in steps, recording elapsed ms after each one. */
function runExecCeilingProbe_() {
  var props = PropertiesService.getScriptProperties();
  var t0 = Date.now();
  props.setProperty('EXEC_CEILING_PROBE_STARTED', new Date(t0).toISOString());
  props.deleteProperty('EXEC_CEILING_PROBE_FINISHED');
  while (Date.now() - t0 < EXEC_CEILING_PROBE_MAX_MS) {
    Utilities.sleep(EXEC_CEILING_PROBE_STEP_MS);
    props.setProperty('EXEC_CEILING_PROBE_LAST_MS', String(Date.now() - t0));
  }
  props.setProperty('EXEC_CEILING_PROBE_FINISHED',
    'ran the full ' + Math.round(EXEC_CEILING_PROBE_MAX_MS / 60000) + ' min without being killed');
  deleteExecCeilingProbeTriggers_();
}

function deleteExecCeilingProbeTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === EXEC_CEILING_PROBE_HANDLER_) ScriptApp.deleteTrigger(t);
  });
}

/**
 * PURE. Interpret the probe's recorded state. `lastMs` is the last elapsed
 * value written (null = never ran / no step completed), `finished` the
 * completion note (null = killed or still running), `startedIso` when it
 * started. Returns { verdict, ceilingMs, recommendMs, text }.
 */
function execCeilingVerdict_(lastMs, finished, startedIso, nowMs) {
  var last = parseInt(lastMs, 10);
  var out = { verdict: 'NO-DATA', ceilingMs: null, recommendMs: null, text: '' };
  if (finished) {
    out.verdict = 'ABOVE-MAX';
    out.text = 'The probe ' + finished + ' -- the trigger ceiling is ABOVE that. The 30-min budgets '
      + '(BULK_TIME_LIMIT_MS / IC_BACKFILL_TIME_LIMIT_MS default 15 min) are safe as they are.';
    return out;
  }
  if (!isFinite(last) || last <= 0) {
    out.text = 'No elapsed value recorded yet' + (startedIso ? ' (started ' + startedIso + ')' : '')
      + '. Either the probe has not fired, or it is still inside its first 10 s step. Wait and re-read.';
    return out;
  }
  var startMs = Date.parse(String(startedIso || ''));
  var stillRunning = isFinite(startMs) && nowMs != null && (nowMs - startMs) < EXEC_CEILING_PROBE_MAX_MS + 2 * 60000;
  if (stillRunning && (nowMs - startMs) - last < 3 * EXEC_CEILING_PROBE_STEP_MS) {
    out.verdict = 'RUNNING';
    out.text = 'The probe is still running (' + Math.round(last / 1000) + ' s so far). Re-read once it stops advancing.';
    return out;
  }
  out.verdict = 'KILLED';
  out.ceilingMs = last;
  // Budgets leave ~2 min for the in-flight date + the final archive, floored at 1 min.
  out.recommendMs = Math.max(60000, Math.round((last - 2 * 60000) / 60000) * 60000);
  var ceilMin = Math.round(last / 60000);
  // WHICH belief the measurement settles depends on the measurement. This
  // clause used to assert unconditionally that the "30-min ceiling" comments
  // were wrong -- written on the assumption the real ceiling would come in
  // LOWER. Measured at ~30 min (2026-09-21, Operator State #70) it inverted
  // the tool's own finding and told the operator to disbelieve the comments
  // the probe had just confirmed.
  out.settles = (ceilMin >= 25) ? '30min-confirmed' : (ceilMin <= 7 ? '6min-confirmed' : 'neither');
  var settles = (out.settles === '30min-confirmed')
    ? ' That CONFIRMS the "30-min ceiling" comments (the bulk budget\'s, the inbound backfill\'s)'
      + ' and disproves the "~6 min" ones -- including the rationale printed beside'
      + ' NEON_MIRROR_BUDGET_MS. Correct those comments; the 4-min mirror budget itself may still'
      + ' be deliberate for other reasons, so do not raise it on the strength of this number alone.'
    : (out.settles === '6min-confirmed')
      ? ' That CONFIRMS the "~6 min" comments and makes every "30-min ceiling" comment wrong --'
        + ' the deferred mirror\'s NEON_MIRROR_BUDGET_MS (default ~4 min) is already right.'
      : ' That matches NEITHER standing belief ("30 min" or "~6 min"), so treat both as wrong'
        + ' and use the measured number.';
  out.text = 'The platform killed the probe at ~' + Math.round(last / 1000) + ' s (~' + ceilMin + ' min) -- '
    + 'that is the trigger execution ceiling. Set BULK_TIME_LIMIT_MS and IC_BACKFILL_TIME_LIMIT_MS to '
    + out.recommendMs + ' (' + Math.round(out.recommendMs / 60000) + ' min) in the cdr-import Script '
    + 'Properties (no redeploy).' + settles;
  return out;
}

function readExecCeilingProbe() {
  var props = PropertiesService.getScriptProperties();
  var v = execCeilingVerdict_(props.getProperty('EXEC_CEILING_PROBE_LAST_MS'),
                              props.getProperty('EXEC_CEILING_PROBE_FINISHED'),
                              props.getProperty('EXEC_CEILING_PROBE_STARTED'), Date.now());
  var msg = v.verdict + '\n\n' + v.text;
  try { SpreadsheetApp.getUi().alert('Execution-ceiling probe', msg, SpreadsheetApp.getUi().ButtonSet.OK); }
  catch (e) { Logger.log('readExecCeilingProbe: ' + msg); }
  return v;
}

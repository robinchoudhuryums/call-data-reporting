/**
 * Neon retention prune (R27) -- keeps the Neon project under its storage cap
 * the way the Call_Legs_* prune keeps the import workbook bounded: old rows
 * leave on a schedule, so the database never reaches the ceiling.
 *
 * WHY. The free tier is 0.5 GB. In 2026-09 the project hit 89% of it, and the
 * growth was structural: the two per-call tables (`inbound_calls` /
 * `outbound_calls`) carry a `journey` text column that dominates their row
 * size (per-leg events, ~0.2-6 KB per call) and nothing ever removed a row.
 * The dashboard's per-call READERS only ever need the journey for RECENT
 * calls (the call-path drill, Caller Lookup's per-call sections); the
 * aggregate readers (the Inbound / Outbound reports, the abandon heatmap,
 * the dial counts) read the scalar columns only. So the journey can be
 * nulled well before the row itself needs to go.
 *
 * WHAT IT DOES, per run (each step independent, each ctid-batched so a
 * statement never touches more than NEON_RETENTION_BATCH_ROWS_ rows and the
 * lock it takes stays short; the run stops at NEON_RETENTION_BUDGET_MS_ and
 * picks up where it left off next time -- a first-run backlog drains over a
 * few weekly runs, and that is `ok`, not a failure):
 *   1. `journey = NULL` on inbound_calls / outbound_calls rows older than
 *      NEON_RETENTION_JOURNEY_DAYS (default 90);
 *   2. DELETE inbound_calls / outbound_calls rows older than
 *      NEON_RETENTION_CALL_DAYS (default 400);
 *   3. DELETE dqe_history / qcd_history rows older than
 *      NEON_RETENTION_HISTORY_MONTHS (default 13) -- the sheet is the
 *      authority for both (Neon mirrors it), and every DQE/QCD reader is
 *      bounded by the INV-29 12-month trend window.
 *
 * WHAT IT NEVER TOUCHES: `call_history_phones` (retired by the
 * CDR_PHONES_MIRROR gate + the Operator State #57 runbook -- the pre-capture
 * block it keeps is history that exists nowhere else), `call_history_dept`,
 * `direct_call_history`, `escalations` / `escalation_activity`, the coaching
 * tables. Adding a table here is a design decision, not a tunable.
 *
 * FLOORS (not just defaults): the coverage checks (NeonCoverage.gs /
 * SheetCoverage.gs) accept a window of at most 366 days, and the call-row
 * horizon must stay ABOVE that so a pruned date can never read as a coverage
 * gap -- neon-retention.test.js pins the floor against NeonCoverage's cap.
 * The journey floor keeps the call-path drill's recent window intact; the
 * history floor keeps every 12-month trend whole on the Neon read path.
 *
 * Interaction with the Neon backup (NeonBackup.gs): closed months of the two
 * per-call tables are written ONCE and then skipped, and every horizon here
 * is longer than a month, so a row is always backed up (journey included)
 * before this prune can reach it. Run order on the weekend is backup
 * Saturday, prune Sunday.
 *
 * Flag-gated engine (the SheetCoverage/PipelineWatch pattern): the weekly
 * handler no-ops on a property read unless NEON_RETENTION_ENABLED='true';
 * registered in SystemHealth's svc() list WITH its flag, plus an outcome row
 * off NEON_RETENTION_LAST / NEON_RETENTION_LAST_RESULT (OPS-8 prefix-coded:
 * `ok ...` / `FAILED ...` / `skipped ...`). Admins are emailed only on a
 * FAILED run. Editor-run: `runNeonRetentionPrune()` (admin-gated).
 */

var NEON_RETENTION_DEFAULTS_ = Object.freeze({ journeyDays: 90, callDays: 400, historyMonths: 13 });
// callDays floor 367 = strictly above the coverage checks' 366-day max window.
var NEON_RETENTION_FLOORS_   = Object.freeze({ journeyDays: 30, callDays: 367, historyMonths: 13 });
var NEON_RETENTION_BATCH_ROWS_ = 5000;
var NEON_RETENTION_BUDGET_MS_  = 4 * 60 * 1000;   // under the 6-min ceiling with margin
var NEON_RETENTION_STMT_TIMEOUT_S_ = 120;
var NEON_RETENTION_TRIGGER_HOUR_ = 3;              // Sunday, script TZ (backup runs Saturday)

/** Effective horizons: Script Property override, floored, else the default. */
function neonRetentionSettings_(props) {
  function floored(raw, key) {
    var n = parseInt(raw, 10);
    if (!isFinite(n)) n = NEON_RETENTION_DEFAULTS_[key];
    return Math.max(NEON_RETENTION_FLOORS_[key], n);
  }
  return {
    journeyDays:   floored(props.getProperty('NEON_RETENTION_JOURNEY_DAYS'), 'journeyDays'),
    callDays:      floored(props.getProperty('NEON_RETENTION_CALL_DAYS'), 'callDays'),
    historyMonths: floored(props.getProperty('NEON_RETENTION_HISTORY_MONTHS'), 'historyMonths'),
  };
}

/**
 * PURE. The ordered step list for one run. Every statement is ctid-batched
 * (`WHERE ctid IN (SELECT ctid ... LIMIT n)`) and self-limiting, so it is
 * re-run safe: a step is done when a batch affects fewer than `batch` rows.
 * Integers only reach the SQL through parseInt (settings) -- no string
 * interpolation of operator input.
 */
function neonRetentionPlan_(settings, batch) {
  batch = batch || NEON_RETENTION_BATCH_ROWS_;
  var j = parseInt(settings.journeyDays, 10), c = parseInt(settings.callDays, 10),
      m = parseInt(settings.historyMonths, 10);
  function journeyStep(table) {
    return { key: table + ':journey', table: table, action: 'null-journey',
      sql: 'UPDATE ' + table + ' SET journey = NULL WHERE ctid IN (SELECT ctid FROM ' + table
        + ' WHERE journey IS NOT NULL AND call_date < CURRENT_DATE - ' + j + ' LIMIT ' + batch + ')' };
  }
  function deleteStep(table, whereOld) {
    return { key: table + ':rows', table: table, action: 'delete-rows',
      sql: 'DELETE FROM ' + table + ' WHERE ctid IN (SELECT ctid FROM ' + table
        + ' WHERE ' + whereOld + ' LIMIT ' + batch + ')' };
  }
  var callOld = 'call_date < CURRENT_DATE - ' + c;
  var histOld = "call_date < (CURRENT_DATE - INTERVAL '" + m + " months')::date";
  return [
    journeyStep('inbound_calls'),
    journeyStep('outbound_calls'),
    deleteStep('inbound_calls', callOld),
    deleteStep('outbound_calls', callOld),
    deleteStep('dqe_history', histOld),
    deleteStep('qcd_history', histOld),
  ];
}

/**
 * Executes the plan on an open connection. Each step is independently
 * try/caught (a missing table -- capture not yet deployed -- is a clean
 * per-step skip, not a run failure); the budget is checked before every
 * batch. `opts.now` is injectable for tests. Returns the per-step tally.
 */
function neonRetentionExecute_(conn, plan, opts) {
  opts = opts || {};
  var now = opts.now || function () { return Date.now(); };
  var batch = opts.batch || NEON_RETENTION_BATCH_ROWS_;
  var budgetMs = opts.budgetMs || NEON_RETENTION_BUDGET_MS_;
  var t0 = now();
  var out = { steps: [], errors: [], budgetHit: false, rows: 0 };
  for (var i = 0; i < plan.length; i++) {
    var step = { key: plan[i].key, action: plan[i].action, rows: 0, batches: 0, done: false };
    out.steps.push(step);
    if (out.budgetHit) continue;
    try {
      for (;;) {
        if (now() - t0 > budgetMs) { out.budgetHit = true; break; }
        var stmt = conn.createStatement();
        try { stmt.setQueryTimeout(NEON_RETENTION_STMT_TIMEOUT_S_); } catch (te) { /* shim */ }
        var n = stmt.executeUpdate(plan[i].sql);
        stmt.close();
        n = (typeof n === 'number' && n >= 0) ? n : 0;
        step.rows += n; step.batches++; out.rows += n;
        if (n < batch) { step.done = true; break; }
      }
    } catch (e) {
      var msg = (e && e.message) ? e.message : String(e);
      if (/relation "[^"]*" does not exist/i.test(msg)) {
        step.skipped = 'table not created yet'; step.done = true;
      } else {
        step.error = msg;
        out.errors.push(plan[i].key + ': ' + msg);
      }
    }
  }
  out.ms = now() - t0;
  return out;
}

/** PURE. OPS-8 prefix-coded summary line. */
function neonRetentionSummary_(settings, res) {
  var parts = res.steps.map(function (s) {
    if (s.error) return s.key + '=ERR';
    if (s.skipped) return s.key + '=n/a';
    return s.key + '=' + s.rows + (s.done ? '' : '+');
  });
  var horizons = 'journey>' + settings.journeyDays + 'd rows>' + settings.callDays
    + 'd history>' + settings.historyMonths + 'mo';
  var tail = ' [' + parts.join(' ') + '] ' + horizons + ' | ' + (res.ms || 0) + 'ms';
  if (res.errors.length) return 'FAILED ' + res.errors.length + ' step(s) threw' + tail + ' :: ' + res.errors.join('; ');
  if (res.budgetHit) return 'ok pruned ' + res.rows + ' row(s), budget hit -- continues next run (or re-run runNeonRetentionPrune now)' + tail;
  return 'ok pruned ' + res.rows + ' row(s)' + tail;
}

/** Admin-only editor/RPC entry point. Returns the tally. */
function runNeonRetentionPrune() {
  assertAdmin_();
  return neonRetentionRun_();
}

function neonRetentionRun_() {
  var props = PropertiesService.getScriptProperties();
  var settings = neonRetentionSettings_(props);
  var conn = (typeof getDashboardNeonConn_ === 'function') ? getDashboardNeonConn_() : null;
  if (!conn) {
    neonRetentionRecord_('skipped (Neon unreachable/unconfigured)');
    return { skipped: true, settings: settings };
  }
  var res;
  try {
    res = neonRetentionExecute_(conn, neonRetentionPlan_(settings));
  } finally {
    try { conn.close(); } catch (ce) { /* best-effort */ }
  }
  var summary = neonRetentionSummary_(settings, res);
  neonRetentionRecord_(summary);
  Logger.log('=== NEON RETENTION %s ===', summary);
  if (res.errors.length) neonRetentionNotify_(summary);
  res.settings = settings;
  res.summary = summary;
  return res;
}

function neonRetentionRecord_(summary) {
  try {
    var props = PropertiesService.getScriptProperties();
    props.setProperty('NEON_RETENTION_LAST', new Date().toISOString());
    props.setProperty('NEON_RETENTION_LAST_RESULT', String(summary).slice(0, 2000));
  } catch (e) { /* best-effort */ }
}

/** Emails admins ONLY on a FAILED run (the OPS-8 rule). */
function neonRetentionNotify_(summary) {
  try {
    var to = getAdminEmails_().join(',');
    if (!to) return;
    sendAppEmail_({
      to: to,
      subject: '[Dashboard] Neon retention prune FAILED',
      body: 'A step of the weekly Neon retention prune threw. The other steps ran; the failed one '
        + 'retries next run. Operator State #57 has the runbook.\n\n' + summary,
      notice: {
        tone: 'bad', kicker: 'Admin notice · Neon retention', title: 'Weekly prune: a step threw',
        subtitle: 'The other steps ran; the failed one retries next run',
        callout: { kicker: 'What to do', html: 'Open the Neon console and check the failing table\'s state; a lock timeout or a '
          + 'suspended compute is the usual cause. Re-run <strong>runNeonRetentionPrune()</strong> from the dashboard editor once it clears.', tone: 'warn' },
        mono: { title: 'Result', text: summary },
        ctaUrl: appDashUrl_('#/admin/health'), ctaLabel: 'Open System Health',
        footerHtml: 'Sent by the weekly Neon retention prune (Operator State #57); a clean run is silent.',
      },
    });
  } catch (e) {
    Logger.log('neonRetentionNotify_ failed (best-effort): ' + (e && e.message ? e.message : e));
  }
}

// ── Weekly trigger (flag-gated engine) ───────────────────────────────────

/** Trigger handler: flag-gated, never throws to the trigger runner. */
function runNeonRetentionWeekly_() {
  try {
    var props = PropertiesService.getScriptProperties();
    if (String(props.getProperty('NEON_RETENTION_ENABLED') || '') !== 'true') return;
    neonRetentionRun_();
  } catch (e) {
    try { neonRetentionRecord_('FAILED ' + ((e && e.message) || e)); } catch (e2) {}
    Logger.log('runNeonRetentionWeekly_ failed: ' + ((e && e.message) || e));
  }
}

/** Admin-only: install the weekly trigger + set the enabled flag. */
function installNeonRetentionTrigger() {
  assertAdmin_();
  PropertiesService.getScriptProperties().setProperty('NEON_RETENTION_ENABLED', 'true');
  installNeonRetentionTrigger_();
  return logStatusReturn_(getNeonRetentionStatus_());
}

/** Admin-only: uninstall the trigger + clear the flag (fully reversible). */
function uninstallNeonRetentionTrigger() {
  assertAdmin_();
  uninstallNeonRetentionTrigger_();
  PropertiesService.getScriptProperties().deleteProperty('NEON_RETENTION_ENABLED');
  return logStatusReturn_(getNeonRetentionStatus_());
}

function installNeonRetentionTrigger_() {
  uninstallNeonRetentionTrigger_();
  ScriptApp.newTrigger('runNeonRetentionWeekly_')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY)
    .atHour(NEON_RETENTION_TRIGGER_HOUR_)
    .create();
  Logger.log('Neon retention trigger installed (Sundays ~%s:00 script-TZ).', NEON_RETENTION_TRIGGER_HOUR_);
}

function uninstallNeonRetentionTrigger_() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runNeonRetentionWeekly_') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  return removed;
}

/** {enabled, installed, last, lastResult, settings} -- the install-readiness shape. */
function getNeonRetentionStatus_() {
  var props = PropertiesService.getScriptProperties();
  var installed = false;
  try {
    var triggers = ScriptApp.getProjectTriggers();
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === 'runNeonRetentionWeekly_') { installed = true; break; }
    }
  } catch (e) { /* scope not yet consented -- report as not installed */ }
  return {
    enabled: String(props.getProperty('NEON_RETENTION_ENABLED') || '') === 'true',
    installed: installed,
    last: props.getProperty('NEON_RETENTION_LAST') || '',
    lastResult: props.getProperty('NEON_RETENTION_LAST_RESULT') || '',
    settings: neonRetentionSettings_(props),
  };
}

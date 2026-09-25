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
 *      NEON_RETENTION_HISTORY_MONTHS (default 25, OD-4) -- the sheet is the
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
 * history floor (25 months, OD-4) keeps a 12-month trend AND its same-length
 * INV-28 prior window whole on the Neon read path for windows ending recently.
 *
 * Interaction with the Neon backup (NeonBackup.gs): a closed month of the two
 * per-call tables is rewritten by the backup until a run lands at least
 * NB_FINAL_GRACE_DAYS_ after it closed, then skipped (ENG-1 -- before that
 * fix the month froze at its last IN-month Saturday and its tail days were
 * never backed up). Every horizon here is longer than a month, so a row is
 * backed up (journey included) before this prune can reach it -- PROVIDED
 * the backup is running; neonRetentionBackupGate_ (ENG-2) refuses to prune
 * when it is not. Run order on the weekend is backup Saturday, prune Sunday.
 *
 * Flag-gated engine (the SheetCoverage/PipelineWatch pattern): the weekly
 * handler no-ops on a property read unless NEON_RETENTION_ENABLED='true';
 * registered in SystemHealth's svc() list WITH its flag, plus an outcome row
 * off NEON_RETENTION_LAST / NEON_RETENTION_LAST_RESULT (OPS-8 prefix-coded:
 * `ok ...` / `FAILED ...` / `skipped ...`). Admins are emailed only on a
 * FAILED run. Editor-run: `runNeonRetentionPrune()` (admin-gated).
 */

// OD-4 (broad-scan 2026-09-17): historyMonths 25, not 13. The Neon read path
// asks for MORE than 12 months: a 12-month window's INV-29 trend reaches 12
// months before its END, and its INV-28 prior window (same length, ending the
// day before the window starts) reaches ~24 months back for a window ending
// today. At 13 months a `DQE_READ_SOURCE=neon` trend was silently truncated
// and the prior window read "no prior data" (LM2 trusts a reachable-empty
// read, so no sheet fallback ran). 25 covers every window that ends within
// the last month; a window ending N months ago still reaches 24+N months
// back -- the documented limit. `neonGetAgentExtPairs_` (NeonRead.gs) shares
// the horizon: an ext last used before it is absent from the Neon-derived
// set while the sheet path still sees all history (INV-53 floater
// recognition can differ by source on a >2-year-idle extension).
var NEON_RETENTION_DEFAULTS_ = Object.freeze({ journeyDays: 90, callDays: 400, historyMonths: 25 });
// callDays floor 367 = strictly above the coverage checks' 366-day max window.
var NEON_RETENTION_FLOORS_   = Object.freeze({ journeyDays: 30, callDays: 367, historyMonths: 25 });
var NEON_RETENTION_BATCH_ROWS_ = 5000;
var NEON_RETENTION_BUDGET_MS_  = 4 * 60 * 1000;   // under the 6-min ceiling with margin
var NEON_RETENTION_STMT_TIMEOUT_S_ = 120;
var NEON_RETENTION_TRIGGER_HOUR_ = 3;              // Sunday, script TZ (backup runs Saturday)

// ENG-2: the tables with no sheet primary, whose prune waits on a healthy
// backup, and how old the last clean backup may be. 15 days = two weekly
// runs, so one missed or failed Saturday does not hold the prune (every row
// old enough to prune was backed up by a run long before it) while a backup
// that is off or keeps failing does.
var NEON_RETENTION_PERCALL_TABLES_ = ['inbound_calls', 'outbound_calls'];
var NEON_RETENTION_BACKUP_MAX_AGE_MS_ = 15 * 24 * 3600 * 1000;

/**
 * ENG-2. null when the per-call prune may run, else the reason it is held:
 * the Neon backup (NeonBackup.gs) has never run, last ran more than
 * NEON_RETENTION_BACKUP_MAX_AGE_MS_ ago, or its last outcome was not `ok`.
 * `NEON_RETENTION_WITHOUT_BACKUP=true` is the operator's explicit opt-out
 * (pruning rows that then exist nowhere).
 */
function neonRetentionBackupGate_(props, nowMs) {
  if (String(props.getProperty('NEON_RETENTION_WITHOUT_BACKUP') || '') === 'true') return null;
  var last = props.getProperty('NEON_BACKUP_LAST') || '';
  if (!last) return 'no Neon backup has run (install it: Operator State #28)';
  var t = Date.parse(last);
  if (!isFinite(t)) return 'the last Neon backup time is unreadable (' + last + ')';
  if (nowMs - t > NEON_RETENTION_BACKUP_MAX_AGE_MS_) {
    return 'the last Neon backup ran ' + Math.floor((nowMs - t) / 86400000) + ' days ago';
  }
  var res = String(props.getProperty('NEON_BACKUP_LAST_RESULT') || '');
  if (!/^ok\b/.test(res)) return 'the last Neon backup did not finish clean (' + res.slice(0, 120) + ')';
  return null;
}

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
  // ENG-2: the per-call tables (inbound_calls / outbound_calls) have NO sheet
  // primary -- once the ~14-day Call_Legs window passes, the Drive backup is
  // their only other copy. Their prune steps run only while that backup is
  // healthy; the dqe/qcd steps (sheet-primary) always run, so the storage
  // control keeps working while the per-call steps are held.
  var hold = neonRetentionBackupGate_(props, Date.now());
  var plan = neonRetentionPlan_(settings);
  if (hold) {
    plan = plan.filter(function (s) { return NEON_RETENTION_PERCALL_TABLES_.indexOf(s.table) === -1; });
  }
  var res;
  try {
    res = neonRetentionExecute_(conn, plan);
  } finally {
    try { conn.close(); } catch (ce) { /* best-effort */ }
  }
  var summary = neonRetentionSummary_(settings, res);
  if (hold) {
    // PARTIAL (not ok) so the Health row warns: a hold that nobody sees would
    // let the per-call tables grow toward the storage cap unnoticed.
    var note = 'per-call prune HELD -- ' + hold
      + '. Fix the Neon backup, or set NEON_RETENTION_WITHOUT_BACKUP=true to prune without one';
    summary = res.errors.length ? summary + ' :: ' + note : 'PARTIAL ' + note + ' | ' + summary;
    res.heldPerCall = hold;
  }
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

// ── Storage by table (the Health page's gauge) ──────────────────────────
//
// The Neon console's storage gauge was a SURPRISE twice in a month (89% ->
// reclaim -> 84%) because nothing on our side measured it: every probe on the
// Health page said "reachable" and the prune said "ok", while the per-call
// tables grew with call volume. One round trip answers "how big, and which
// table" -- the two inputs the roadmap's Neon storage decision needs (pay for
// the paid tier, or set the NEON_RETENTION_* horizons to what the free tier
// holds). Read as a FLOOR: `pg_database_size` is the live data files only;
// the console figure ALSO counts Neon's history retention (point-in-time
// restore), which no query inside the database can see. And a DELETE (the
// weekly prune included) does NOT move it -- Postgres returns disk only on
// TRUNCATE or VACUUM FULL (Operator State #57's reclaim runbook) -- so a
// flat line after a big prune is expected, not a prune that failed.

var NEON_STORAGE_TOP_N_ = 5;
var NEON_STORAGE_STMT_TIMEOUT_S_ = 20;

/**
 * ONE json round-trip: the database's on-disk size plus every public table's
 * total size (heap + indexes + TOAST), largest first. Returns
 * `{ dbBytes, tables: [{table, bytes}] }`; throws on a JDBC error so the
 * caller's probe-failed branch renders (never a fake zero).
 * JDBC discipline: a single `rs.getString` of one json text, never per-row
 * iteration (the ~0.5 s/row rule in CLAUDE.md).
 */
function neonStorageByTable_(conn) {
  var sql = "SELECT json_build_object("
          + "'db', pg_database_size(current_database()),"
          + "'tables', COALESCE((SELECT json_agg(json_build_object('t', c.relname, 'b', pg_total_relation_size(c.oid))"
          +                     " ORDER BY pg_total_relation_size(c.oid) DESC)"
          +                     " FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace"
          +                     " WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')), '[]'::json)"
          + ")::text AS j";
  var stmt = conn.createStatement();
  try { stmt.setQueryTimeout(NEON_STORAGE_STMT_TIMEOUT_S_); } catch (e) { /* not every driver -- the probe still runs */ }
  var rs = stmt.executeQuery(sql);
  var json = rs.next() ? rs.getString('j') : '';
  rs.close(); stmt.close();
  if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(json ? json.length : 0, 'neon-storage');   // OD-3
  var parsed = JSON.parse(json || '{}') || {};
  var tables = (parsed.tables || []).map(function (t) {
    return { table: String(t && t.t || ''), bytes: Number(t && t.b) || 0 };
  }).filter(function (t) { return !!t.table; });
  // The ORDER BY inside json_agg is the contract, but a driver that ignores
  // it must not reorder the Health row's "top" list -- sort defensively.
  tables.sort(function (a, b) { return b.bytes - a.bytes || (a.table < b.table ? -1 : 1); });
  return { dbBytes: Number(parsed.db) || 0, tables: tables };
}

/** Bytes -> "12.3 MB" (one decimal); the Health row's unit everywhere. */
function neonStorageMb_(bytes) {
  return Math.round(((Number(bytes) || 0) / (1024 * 1024)) * 10) / 10;
}

/**
 * PURE. The Health row's verdict from a storage reading + the optional
 * NEON_STORAGE_CAP_MB Script Property (0 / unset = no declared cap):
 * `{ status, value, hint }`. No cap -> informational (muted): the plan's cap
 * is a billing fact this code cannot discover, and inventing one would either
 * cry wolf or reassure wrongly (the egress row's rule). With a cap: warn at
 * 80%, matching the egress gauge, and the hint names the levers in #57.
 */
function neonStorageVerdict_(reading, capMb) {
  var cap = Number(capMb) || 0;
  var dbMb = neonStorageMb_(reading.dbBytes);
  var value = dbMb + ' MB on disk';
  var status = 'muted';
  var pct = 0;
  if (cap > 0) {
    pct = Math.round((dbMb / cap) * 100);
    value += ' — ' + pct + '% of the ' + cap + ' MB cap';
    status = pct >= 80 ? 'warn' : 'ok';
  }
  var top = (reading.tables || []).slice(0, NEON_STORAGE_TOP_N_);
  if (top.length) {
    value += ' · top: ' + top.map(function (t) { return t.table + ' ' + neonStorageMb_(t.bytes) + ' MB'; }).join(', ');
  }
  var hint = (cap > 0
      ? 'Warns at 80% of NEON_STORAGE_CAP_MB. '
      : 'Set the NEON_STORAGE_CAP_MB Script Property to your plan\'s storage '
        + 'allowance (the free tier is 512) to turn this into a threshold. ')
    + 'A FLOOR: the console figure also counts Neon\'s history retention, which '
    + 'no query inside the database can see. A DELETE (the weekly prune included) '
    + 'does not shrink this -- Postgres returns disk only on TRUNCATE or VACUUM '
    + 'FULL -- so a flat line after a prune is expected. Levers, in order: the '
    + 'NEON_RETENTION_* horizons, the CDR_PHONES_MIRROR gate, and the reclaim '
    + 'runbook (Operator State #57).';
  if (status === 'warn') {
    hint = 'Near the cap: at 100% every Neon WRITE fails (escalations, coaching, '
      + 'the daily mirrors) while every read still says "reachable". ' + hint;
  }
  return { status: status, value: value, hint: hint, pct: pct, dbMb: dbMb };
}

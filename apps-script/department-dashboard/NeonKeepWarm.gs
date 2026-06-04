/**
 * Neon keep-warm (F1 read-back companion).
 *
 * Neon's free tier scale-to-zero suspends the compute after ~5 minutes
 * with no connections, so the FIRST request after an idle stretch pays a
 * cold-start wake penalty. When DQE_READ_SOURCE=neon, that penalty lands
 * on whichever manager happens to make the first DQE read of the lull.
 *
 * This optional, admin-toggled trigger pings Neon (`SELECT 1`) on a short
 * interval DURING A BOUNDED BUSINESS-HOURS WINDOW so the instance stays
 * warm through the part of the day managers actually use the dashboard --
 * without keeping it awake 24/7 (which would blow the free monthly
 * compute-hour budget).
 *
 * Budget math: Neon free tier includes ~190 compute-hours/month (default
 * 0.25 CU). The default window (07:00-13:00 Central, weekdays only) keeps
 * the instance awake ~6h x ~22 weekdays = ~132h/month -- comfortably under
 * budget with margin for the daily import's own Neon writes. Widen the
 * window via the NEON_KEEPWARM_START_HOUR / NEON_KEEPWARM_END_HOUR Script
 * Properties, but watch the estimated monthly hours surfaced in the Alerts
 * modal so you stay under your plan's allowance.
 *
 * Gating: the trigger fires project-wide every 5 minutes, but keepNeonWarm_
 * cheaply no-ops (a property read + a clock check, NO Neon connection)
 * outside the window / on weekends / when disabled -- so the only Neon
 * compute spent is inside the configured window. Reuses the dashboard
 * project's NEON_* Script Properties + the script.external_request scope
 * (same as the F1 read-back and orphan-rename mirror); no new scope.
 *
 * Reversible: uninstall removes the trigger and clears the enabled flag.
 * Independent of DQE_READ_SOURCE -- you can keep Neon warm while still
 * reading from the sheet, or disable keep-warm and accept cold starts.
 */

// Window defaults (Central / script TZ). Start inclusive, end exclusive.
var NEON_KEEPWARM_DEFAULT_START_HOUR = 7;    // 07:00
var NEON_KEEPWARM_DEFAULT_END_HOUR   = 13;   // 13:00 -> 6-hour window
// Ping cadence. Neon suspends at ~5 min idle; 5-min pings keep it warm.
// (Interval doesn't change the compute-hour cost -- the instance is awake
// for the whole window regardless -- it only affects how reliably we beat
// the suspend timer. Drop to 1 if cold starts still slip through.)
var NEON_KEEPWARM_EVERY_MINUTES = 5;

// ── Public (admin-gated) API ──────────────────────────────────────────

/** Admin-only status read for the Alerts modal. */
function getNeonKeepWarmStatus() {
  assertAdmin_();
  return getNeonKeepWarmStatus_();
}

/** Admin-only: enable + install the keep-warm trigger. Returns status. */
function installNeonKeepWarmTrigger() {
  assertAdmin_();
  PropertiesService.getScriptProperties().setProperty('NEON_KEEPWARM_ENABLED', 'true');
  installNeonKeepWarmTrigger_();
  return getNeonKeepWarmStatus_();
}

/** Admin-only: uninstall the trigger + clear the enabled flag. Returns status. */
function uninstallNeonKeepWarmTrigger() {
  assertAdmin_();
  uninstallNeonKeepWarmTrigger_();
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty('NEON_KEEPWARM_ENABLED');
  return getNeonKeepWarmStatus_();
}

// ── Trigger entry point ───────────────────────────────────────────────

/**
 * Time-driven target (underscore-suffixed so google.script.run can't reach
 * it; ScriptApp dispatch still calls it by name). Fires every few minutes
 * project-wide but only opens a Neon connection inside the configured
 * weekday business-hours window. Best-effort: never throws, records the
 * last ping outcome to Script Properties for the modal's status line.
 */
function keepNeonWarm_() {
  var props = PropertiesService.getScriptProperties();
  if (String(props.getProperty('NEON_KEEPWARM_ENABLED') || '') !== 'true') return;

  // Weekday + window gate, evaluated in the script TZ. 'u' = ISO day
  // (1=Mon..7=Sun); 'H' = 24h hour. Cheap -- no Neon connection yet.
  var now = new Date();
  var dow = parseInt(Utilities.formatDate(now, TZ, 'u'), 10);
  if (dow === 6 || dow === 7) return;   // Sat / Sun
  var hour = parseInt(Utilities.formatDate(now, TZ, 'H'), 10);
  var startH = neonKeepWarmHour_(props.getProperty('NEON_KEEPWARM_START_HOUR'), NEON_KEEPWARM_DEFAULT_START_HOUR);
  var endH   = neonKeepWarmHour_(props.getProperty('NEON_KEEPWARM_END_HOUR'),   NEON_KEEPWARM_DEFAULT_END_HOUR);
  if (hour < startH || hour >= endH) return;

  var result;
  var conn = (typeof getDashboardNeonConn_ === 'function') ? getDashboardNeonConn_() : null;
  if (!conn) {
    result = 'unreachable';
  } else {
    try {
      var stmt = conn.createStatement();
      var rs = stmt.executeQuery('SELECT 1');
      rs.close(); stmt.close();
      result = 'ok';
    } catch (e) {
      result = 'error: ' + ((e && e.message) ? e.message : String(e));
    } finally {
      try { conn.close(); } catch (ce) {}
    }
  }
  try {
    props.setProperty('NEON_KEEPWARM_LAST', new Date().toISOString());
    props.setProperty('NEON_KEEPWARM_LAST_RESULT', result);
  } catch (pe) { /* best-effort */ }
}

// ── Internals ─────────────────────────────────────────────────────────

function neonKeepWarmHour_(raw, dflt) {
  var n = parseInt(raw, 10);
  return (isFinite(n) && n >= 0 && n <= 23) ? n : dflt;
}

function installNeonKeepWarmTrigger_() {
  uninstallNeonKeepWarmTrigger_();
  ScriptApp.newTrigger('keepNeonWarm_')
    .timeBased()
    .everyMinutes(NEON_KEEPWARM_EVERY_MINUTES)
    .create();
}

function uninstallNeonKeepWarmTrigger_() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'keepNeonWarm_') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}

function getNeonKeepWarmStatus_() {
  var props = PropertiesService.getScriptProperties();
  var installed = false;
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'keepNeonWarm_') { installed = true; break; }
  }
  var startH = neonKeepWarmHour_(props.getProperty('NEON_KEEPWARM_START_HOUR'), NEON_KEEPWARM_DEFAULT_START_HOUR);
  var endH   = neonKeepWarmHour_(props.getProperty('NEON_KEEPWARM_END_HOUR'),   NEON_KEEPWARM_DEFAULT_END_HOUR);
  var windowHours = Math.max(0, endH - startH);
  return {
    installed:       installed,
    enabled:         String(props.getProperty('NEON_KEEPWARM_ENABLED') || '') === 'true',
    startHour:       startH,
    endHour:         endH,
    everyMinutes:    NEON_KEEPWARM_EVERY_MINUTES,
    neonConfigured:  !!props.getProperty('NEON_HOST'),
    readSource:      (typeof getDqeReadSource_ === 'function') ? getDqeReadSource_() : 'sheet',
    lastPing:        props.getProperty('NEON_KEEPWARM_LAST') || null,
    lastResult:      props.getProperty('NEON_KEEPWARM_LAST_RESULT') || null,
    // ~22 weekdays/month. Rough monthly compute-hours estimate so the admin
    // can keep the window under their Neon plan's allowance.
    estMonthlyHours: Math.round(windowHours * 22),
  };
}

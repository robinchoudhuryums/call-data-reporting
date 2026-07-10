/**
 * Proactive ingest-failure alert (optional, admin-toggled).
 *
 * The Overview Pipeline Health banner + the header freshness pill surface a
 * stale ingest PASSIVELY -- an admin only sees them if they happen to open the
 * dashboard. This watchdog PUSHES that same signal: a weekday-morning time
 * trigger checks DQE freshness using the SAME `computeOverviewPipelineFreshness_`
 * the banner uses (OVERVIEW_PIPELINE_STALE_HOURS, default 36h) and emails the
 * admins when no fresh DQE build has landed in time -- i.e. the daily import or
 * the DQE rebuild silently failed to run.
 *
 * Dedup: ONE email per stale EPISODE. It alerts when freshness first goes stale
 * and then stays quiet (the `INGEST_WATCHDOG_ALERTED` flag) until a later check
 * finds a fresh build and clears the flag -- so a multi-day outage, or the
 * weekday-after-weekend gap, doesn't spam the admins. The next stale stretch
 * re-arms automatically.
 *
 * Gating + safety:
 *  - No-ops cheaply (a property read) when INGEST_WATCHDOG_ENABLED != 'true'.
 *  - Skips Sat/Sun (no ingest expected on weekends).
 *  - A null freshness read (missing/empty Pipeline Health, transient error) is
 *    treated as INCONCLUSIVE, not stale, so a flaky read can't false-alarm.
 *  - Best-effort: the trigger entry point never throws.
 *
 * Scope: reuses script.scriptapp (trigger management) + script.send_mail
 * (already present, INV-31). No new OAuth scope.
 *
 * Operator setup (editor-run, admin):
 *   installIngestWatchdogTrigger()    // sets INGEST_WATCHDOG_ENABLED + installs trigger
 *   uninstallIngestWatchdogTrigger()  // removes trigger + clears the flag
 *   getIngestWatchdogStatus()         // read current state
 * Tunable Script Properties:
 *   INGEST_WATCHDOG_HOUR         (0-23, default 10; weekday run hour, Central)
 *   INGEST_WATCHDOG_STALE_HOURS  (default OVERVIEW_PIPELINE_STALE_HOURS = 36)
 */

var INGEST_WATCHDOG_DEFAULT_HOUR = 10;   // 10:00 Central, after the morning ingest

// ── Public (admin-gated) API ──────────────────────────────────────────

/** Admin-only status read. */
function getIngestWatchdogStatus() {
  assertAdmin_();
  return getIngestWatchdogStatus_();
}

/** Admin-only: enable + install the watchdog trigger. Returns status. */
function installIngestWatchdogTrigger() {
  assertAdmin_();
  PropertiesService.getScriptProperties().setProperty('INGEST_WATCHDOG_ENABLED', 'true');
  installIngestWatchdogTrigger_();
  return getIngestWatchdogStatus_();
}

/** Admin-only: uninstall the trigger + clear the enabled flag. Returns status. */
function uninstallIngestWatchdogTrigger() {
  assertAdmin_();
  uninstallIngestWatchdogTrigger_();
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty('INGEST_WATCHDOG_ENABLED');
  return getIngestWatchdogStatus_();
}

// ── Trigger entry point ───────────────────────────────────────────────

/**
 * Time-driven target (underscore-suffixed so google.script.run can't reach it;
 * ScriptApp dispatch still calls it by name). Best-effort: never throws.
 */
function runIngestWatchdog_() {
  try {
    var props = PropertiesService.getScriptProperties();
    if (String(props.getProperty('INGEST_WATCHDOG_ENABLED') || '') !== 'true') return;

    // Weekday gate (script TZ). 'u' = ISO day 1=Mon..7=Sun.
    var dow = parseInt(Utilities.formatDate(new Date(), TZ, 'u'), 10);
    if (dow === 6 || dow === 7) return;   // Sat / Sun -- no ingest expected

    // OPS-7: company holidays are non-ingest days too, like weekends (the
    // same gate runDailyAlerts_/runDailyDigests_ gained in S5).
    var todayIso = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
    if (typeof isCompanyHoliday_ === 'function' && isCompanyHoliday_(todayIso)) return;

    var fresh = (typeof computeOverviewPipelineFreshness_ === 'function')
      ? computeOverviewPipelineFreshness_() : null;

    // null = couldn't read Pipeline Health (missing/empty sheet, parse error).
    // Treat as inconclusive rather than stale so a transient read failure
    // can't push a false alarm; the next run re-checks.
    if (!fresh) return;

    var staleHours = ingestWatchdogStaleHours_(props.getProperty('INGEST_WATCHDOG_STALE_HOURS'));
    // OPS-7: credit 24h per weekend/company-holiday day inside the stale
    // gap. A zero-activity holiday produces an EXPECTED rows:0 DQE build
    // (which deliberately doesn't reset the freshness clock, F5), so the
    // morning after a holiday the raw gap exceeds the threshold even
    // though the pipeline is healthy -- and the false alarm's episode
    // flag would then SUPPRESS a real outage starting later that week.
    var effectiveStale = staleHours
      + ingestWatchdogNonBusinessCredit_(fresh.hoursSinceFresh);
    var isStale = (fresh.hoursSinceFresh == null) || (fresh.hoursSinceFresh > effectiveStale);
    var alreadyAlerted = String(props.getProperty('INGEST_WATCHDOG_ALERTED') || '') === 'true';

    if (!isStale) {
      // Healthy / recovered: clear the episode flag so the next stale stretch
      // alerts again.
      if (alreadyAlerted) props.deleteProperty('INGEST_WATCHDOG_ALERTED');
      try {
        props.setProperty('INGEST_WATCHDOG_LAST', new Date().toISOString());
        props.setProperty('INGEST_WATCHDOG_LAST_RESULT', 'fresh');
      } catch (pe) { /* best-effort */ }
      return;
    }

    // Stale: email once per episode. OPS-1: the episode flag arms ONLY on a
    // CONFIRMED send -- notifyIngestStale_ swallowing a MailApp failure
    // (quota-exhausted morning) previously still armed the flag, silencing
    // the entire stale episode while LAST_RESULT claimed "alert sent".
    var result;
    if (!alreadyAlerted) {
      var sent = notifyIngestStale_(fresh, effectiveStale);
      if (sent) {
        try { props.setProperty('INGEST_WATCHDOG_ALERTED', 'true'); } catch (pe) {}
        result = 'stale (alert sent)';
      } else {
        result = 'stale (alert send FAILED -- will retry next run)';
      }
    } else {
      result = 'stale (already alerted)';
    }
    try {
      props.setProperty('INGEST_WATCHDOG_LAST', new Date().toISOString());
      props.setProperty('INGEST_WATCHDOG_LAST_RESULT', result);
    } catch (pe) { /* best-effort */ }
  } catch (e) {
    Logger.log('runIngestWatchdog_ failed: ' + (e && e.message ? e.message : e));
  }
}

/**
 * Emails the admins. Returns TRUE only on a confirmed send (OPS-1) --
 * the caller arms the once-per-episode flag on that, so a swallowed
 * MailApp failure retries on the next run instead of silencing the
 * whole episode.
 */
function notifyIngestStale_(fresh, staleHours) {
  try {
    var to = getAdminEmails_().join(',');
    if (!to) return false;
    var lastTs = fresh.latestTimestamp || '(none found in recent Pipeline Health)';
    var hrs = (fresh.hoursSinceFresh == null) ? 'unknown' : fresh.hoursSinceFresh;
    var url = PropertiesService.getScriptProperties().getProperty('DASHBOARD_URL') || '';
    MailApp.sendEmail({
      to:      to,
      subject: '[Dashboard] Ingest stale: no fresh DQE build in ' + staleHours + 'h',
      body:    'The daily ingest watchdog did not find a fresh DQE build.\n\n'
             + 'Most recent DQE-freshness Pipeline Health success: ' + lastTs + '\n'
             + 'Hours since: ' + hrs + ' (threshold ' + staleHours + 'h)\n\n'
             + 'Likely the daily import or the DQE rebuild has not run. Check:\n'
             + '  1. DQE Historical Data latest date (CDR Report sheet)\n'
             + '  2. cdr-import execution log / Pipeline Health (autoImport, *:DQE rows)\n'
             + '  3. All trigger types installed (Operator State #8)\n'
             + (url ? '\nDashboard: ' + url + '\n' : '')
             + '\nYou will get ONE alert per stale episode; the next fresh build re-arms it.',
    });
    return true;
  } catch (mailErr) {
    Logger.log('notifyIngestStale_ mail failed: ' + mailErr);
    return false;
  }
}

// ── Internals ─────────────────────────────────────────────────────────

/**
 * OPS-7: 24h of staleness allowance per weekend/company-holiday day
 * inside the gap since the last fresh build. Walks back at most 14
 * calendar days (past that a real outage should alarm regardless).
 */
function ingestWatchdogNonBusinessCredit_(hoursSinceFresh) {
  if (hoursSinceFresh == null || !isFinite(hoursSinceFresh)) return 0;
  var days = Math.min(14, Math.ceil(hoursSinceFresh / 24));
  var credit = 0;
  for (var d = 1; d <= days; d++) {
    var dt = new Date(Date.now() - d * 86400000);
    var dow = parseInt(Utilities.formatDate(dt, TZ, 'u'), 10);
    var iso = Utilities.formatDate(dt, TZ, 'yyyy-MM-dd');
    var holiday = (typeof isCompanyHoliday_ === 'function') && isCompanyHoliday_(iso);
    if (dow === 6 || dow === 7 || holiday) credit += 24;
  }
  return credit;
}

function ingestWatchdogStaleHours_(raw) {
  var n = parseFloat(raw);
  if (isFinite(n) && n > 0) return n;
  return (typeof OVERVIEW_PIPELINE_STALE_HOURS !== 'undefined')
    ? OVERVIEW_PIPELINE_STALE_HOURS : 36;
}

function ingestWatchdogHour_(raw, dflt) {
  var n = parseInt(raw, 10);
  return (isFinite(n) && n >= 0 && n <= 23) ? n : dflt;
}

function installIngestWatchdogTrigger_() {
  uninstallIngestWatchdogTrigger_();
  var hour = ingestWatchdogHour_(
    PropertiesService.getScriptProperties().getProperty('INGEST_WATCHDOG_HOUR'),
    INGEST_WATCHDOG_DEFAULT_HOUR);
  ScriptApp.newTrigger('runIngestWatchdog_')
    .timeBased()
    .everyDays(1)
    .atHour(hour)
    .create();
}

function uninstallIngestWatchdogTrigger_() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runIngestWatchdog_') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}

function getIngestWatchdogStatus_() {
  var props = PropertiesService.getScriptProperties();
  var installed = false;
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runIngestWatchdog_') { installed = true; break; }
  }
  return {
    installed:  installed,
    enabled:    String(props.getProperty('INGEST_WATCHDOG_ENABLED') || '') === 'true',
    hour:       ingestWatchdogHour_(props.getProperty('INGEST_WATCHDOG_HOUR'), INGEST_WATCHDOG_DEFAULT_HOUR),
    staleHours: ingestWatchdogStaleHours_(props.getProperty('INGEST_WATCHDOG_STALE_HOURS')),
    lastRun:    props.getProperty('INGEST_WATCHDOG_LAST') || null,
    lastResult: props.getProperty('INGEST_WATCHDOG_LAST_RESULT') || null,
    inEpisode:  String(props.getProperty('INGEST_WATCHDOG_ALERTED') || '') === 'true',
    adminCount: getAdminEmails_().length,
  };
}

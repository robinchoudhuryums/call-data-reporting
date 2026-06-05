/**
 * Report cache warming (perf companion to the F1 read-back).
 *
 * The heavy per-(dept,range) report aggregations cache 30 min
 * (REPORT_CACHE_TTL_SECONDS), but the FIRST request after the morning
 * ingest is a cold fresh-read -- whichever manager opens the dashboard
 * first that day eats the full aggregation cost. This optional,
 * admin-toggled trigger pre-warms the most-common caches shortly after
 * the ingest window so that first open is a cache hit.
 *
 * What it warms (as the trigger owner -- an admin -- so cross-dept access
 * is allowed; the caches are keyed by (dept,range), NOT per-user, so the
 * warmed entries serve everyone):
 *   - getCompanyOverview() -- the shared Overview blob.
 *   - getDepartmentSummary({dept, latest, latest}) for every dept -- the
 *     My Department default range (INV-43 snaps From/To to the latest date).
 *
 * NOTE: CacheService is per-Apps-Script-PROJECT, so this MUST run in the
 * dashboard project (it can't be warmed from the cdr-import ingest project).
 * It's a time trigger rather than an ingest hook for that reason; default
 * fire hour is after the 7 AM DQE build / morning import (CACHE_WARM_HOUR
 * Script Property, default 9 Central). Best-effort: per-dept failures are
 * logged, never thrown. Reuses the existing script.scriptapp scope; no new
 * scope. Independent of DQE_READ_SOURCE -- warming helps the sheet path too.
 */

var CACHE_WARM_DEFAULT_HOUR = 9;   // Central; after the morning ingest window

// ── Public (admin-gated) API ──────────────────────────────────────────

function getCacheWarmStatus() {
  assertAdmin_();
  return getCacheWarmStatus_();
}

function installCacheWarmTrigger() {
  assertAdmin_();
  installCacheWarmTrigger_();
  return getCacheWarmStatus_();
}

function uninstallCacheWarmTrigger() {
  assertAdmin_();
  uninstallCacheWarmTrigger_();
  return getCacheWarmStatus_();
}

// Manual one-shot warm (admin) -- handy to prime caches on demand.
function warmReportCachesNow() {
  assertAdmin_();
  warmReportCaches_();
  return getCacheWarmStatus_();
}

// ── Trigger entry point ───────────────────────────────────────────────

/**
 * Time-driven target (underscore-suffixed so google.script.run can't reach
 * it; ScriptApp dispatch still calls it by name). Warms the Overview blob
 * + each dept's My Department default-range summary. Best-effort.
 */
function warmReportCaches_() {
  var start = Date.now();
  var warmed = 0, failed = 0, latest = null;
  try { latest = getLatestDataDate(); }
  catch (e) { Logger.log('warmReportCaches_: getLatestDataDate failed: ' + e); }
  if (!latest) {
    Logger.log('warmReportCaches_: no latest date; skipping.');
    recordCacheWarm_('skipped (no latest date)');
    return;
  }
  try { getCompanyOverview(); warmed++; }
  catch (e) { failed++; Logger.log('warmReportCaches_: overview failed: ' + e); }

  var depts = [];
  try { depts = getAllDepartments_(); }
  catch (e) { Logger.log('warmReportCaches_: getAllDepartments_ failed: ' + e); }
  for (var i = 0; i < depts.length; i++) {
    try {
      getDepartmentSummary({ department: depts[i], from: latest, to: latest });
      warmed++;
    } catch (e) {
      failed++;
      Logger.log('warmReportCaches_: ' + depts[i] + ' failed: '
        + (e && e.message ? e.message : e));
    }
  }
  var ms = Date.now() - start;
  Logger.log('warmReportCaches_: warmed=' + warmed + ' failed=' + failed
    + ' for ' + latest + ' in ' + ms + 'ms');
  recordCacheWarm_('ok (' + warmed + ' warmed'
    + (failed ? ', ' + failed + ' failed' : '') + ', ' + ms + 'ms)');
}

// ── Internals ─────────────────────────────────────────────────────────

function recordCacheWarm_(outcome) {
  try {
    var props = PropertiesService.getScriptProperties();
    props.setProperty('CACHE_WARM_LAST', new Date().toISOString());
    props.setProperty('CACHE_WARM_LAST_RESULT', outcome);
  } catch (e) { /* best-effort */ }
}

function cacheWarmHour_(raw, dflt) {
  var n = parseInt(raw, 10);
  return (isFinite(n) && n >= 0 && n <= 23) ? n : dflt;
}

function installCacheWarmTrigger_() {
  uninstallCacheWarmTrigger_();
  var hour = cacheWarmHour_(
    PropertiesService.getScriptProperties().getProperty('CACHE_WARM_HOUR'),
    CACHE_WARM_DEFAULT_HOUR);
  ScriptApp.newTrigger('warmReportCaches_').timeBased().everyDays(1).atHour(hour).create();
}

function uninstallCacheWarmTrigger_() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'warmReportCaches_') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}

function getCacheWarmStatus_() {
  var props = PropertiesService.getScriptProperties();
  var installed = false;
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'warmReportCaches_') { installed = true; break; }
  }
  return {
    installed:  installed,
    hour:       cacheWarmHour_(props.getProperty('CACHE_WARM_HOUR'), CACHE_WARM_DEFAULT_HOUR),
    lastRun:    props.getProperty('CACHE_WARM_LAST') || null,
    lastResult: props.getProperty('CACHE_WARM_LAST_RESULT') || null,
  };
}

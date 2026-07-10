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
 *   - getQcdAllDepartments(yesterday, yesterday) -- the exact key the
 *     all-departments Daily Queue Report modal pre-loads (6h qcdAll TTL);
 *     freshness-guarded so a late ingest can't pin an empty blob.
 *   - getInsightsReport({dept, last-30-days, agents: []}) for every dept --
 *     the agent-free launcher window both Overview chips auto-run; runs
 *     LAST under a 4-minute runtime budget (partial warm is fine).
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
  // F-27: suppress Report Usage telemetry for this execution -- warm
  // traffic isn't real manager usage. Reset in the finally below.
  REPORT_USAGE_SUPPRESS_ = true;
  try {
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

  // All-departments Daily Queue Report (owner request): the Overview-launched
  // modal PRE-LOADS yesterday on open, so warming that exact (yesterday,
  // yesterday) key makes the first open of the day an instant cache hit --
  // and the 6h qcdAll TTL (QCD_ALLDEPT_CACHE_TTL_SECONDS) keeps it hot for
  // the working morning. GUARDED on QCD freshness: if the morning ingest
  // hasn't landed yesterday's QCD rows yet, warming would pin an
  // empty/partial report for the long TTL, so we skip instead (the first
  // organic request after ingest computes fresh and caches correctly).
  try {
    var yesterday = Utilities.formatDate(
      new Date(Date.now() - 86400000), TZ, 'yyyy-MM-dd');
    var dates = null;
    try { dates = getLatestDataDates(); } catch (e2) { dates = null; }
    var qcdLatest = dates && dates.qcd;
    if (qcdLatest && qcdLatest >= yesterday) {
      getQcdAllDepartments({ from: yesterday, to: yesterday });
      warmed++;
    } else {
      Logger.log('warmReportCaches_: skipping qcdAll warm (QCD latest '
        + (qcdLatest || 'unknown') + ' < ' + yesterday + ')');
    }
  } catch (e) {
    failed++;
    Logger.log('warmReportCaches_: qcdAll warm failed: '
      + (e && e.message ? e.message : e));
  }

  // Agent-free Insights per dept, over the Overview launcher window (last
  // 30 days ending yesterday, empty selection = whole roster -- the exact
  // request BOTH launcher chips auto-run, so the key matches). This is the
  // heaviest per-dept aggregation, so it runs LAST under a runtime budget:
  // Apps Script kills triggers around the 6-minute mark, and a partial
  // warm is fine -- unwarmed depts just take the normal cold path.
  var INSIGHTS_WARM_BUDGET_MS = 4 * 60 * 1000;
  var insFrom = Utilities.formatDate(new Date(Date.now() - 30 * 86400000), TZ, 'yyyy-MM-dd');
  var insTo   = Utilities.formatDate(new Date(Date.now() - 86400000), TZ, 'yyyy-MM-dd');
  var insSkipped = 0;
  for (var j = 0; j < depts.length; j++) {
    if (Date.now() - start > INSIGHTS_WARM_BUDGET_MS) { insSkipped = depts.length - j; break; }
    try {
      getInsightsReport({ department: depts[j], from: insFrom, to: insTo, agents: [] });
      warmed++;
    } catch (e) {
      failed++;
      Logger.log('warmReportCaches_: insights ' + depts[j] + ' failed: '
        + (e && e.message ? e.message : e));
    }
  }
  if (insSkipped) {
    Logger.log('warmReportCaches_: insights warm budget hit -- '
      + insSkipped + ' dept(s) left cold.');
  }

  var ms = Date.now() - start;
  Logger.log('warmReportCaches_: warmed=' + warmed + ' failed=' + failed
    + ' for ' + latest + ' in ' + ms + 'ms');
  recordCacheWarm_('ok (' + warmed + ' warmed'
    + (failed ? ', ' + failed + ' failed' : '')
    + (insSkipped ? ', ' + insSkipped + ' insights skipped on budget' : '')
    + ', ' + ms + 'ms)');
  } finally {
    REPORT_USAGE_SUPPRESS_ = false;
  }
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

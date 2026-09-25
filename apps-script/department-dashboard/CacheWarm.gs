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
 *   - getQcdAllDepartments(latestQcd, latestQcd) -- the exact key the
 *     all-departments Daily Queue Report modal pre-loads (6h qcdAll TTL;
 *     ENG-10: the LATEST QCD date, never calendar yesterday); freshness-
 *     guarded against the previous business day.
 *   - getInsightsReport for every dept, most-used first (PERF-1): the
 *     agent-free dept-page default (latest..latest -- what the inline
 *     Insights section loads on every My Department open), then the
 *     quick-start chip request (S2A-4: same window, the picker's ACTIVE
 *     agents). Runs LAST under a shared 4-minute runtime budget (a partial
 *     warm is fine).
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
// O-4: a WHOLE-RUN budget. Apps Script kills a trigger around 6 minutes and
// the kill skips catch/finally, so a run that overran never reached
// recordCacheWarm_ -- the previous day's "ok" stayed on the Health page. Only
// the Insights phase had a budget; the Overview + per-dept summaries + qcdAll
// phases were unbudgeted (an all-dept compute on the sheet-fallback path has
// measured 730s+). Each phase now checks this before starting a unit of work
// and records what it skipped, so the run always ends by recording.
var CACHE_WARM_TOTAL_BUDGET_MS = 5 * 60 * 1000;

/**
 * S2A-4: warms the quick-start chip request per dept -- (dept, latest,
 * latest, the picker's active agents). Returns the number of depts left cold
 * by the budget; `tally(ok)` counts each attempt.
 */
function warmInsightsChips_(depts, latest, start, budgetMs, tally) {
  for (var j = 0; j < depts.length; j++) {
    if (Date.now() - start > budgetMs) {
      Logger.log('warmReportCaches_: insights (chips) budget hit -- ' + (depts.length - j) + ' dept(s) left cold.');
      return depts.length - j;
    }
    try {
      var init = getInsightsReportInit({ department: depts[j], from: latest, to: latest }) || {};
      var picked = (init.activeAgents && init.activeAgents.length) ? init.activeAgents : (init.agents || []);
      if (!picked.length) continue;   // empty roster: the chip runs agent-free, warmed above
      getInsightsReport({ department: depts[j], from: latest, to: latest, agents: picked });
      tally(true);
    } catch (e) {
      tally(false);
      Logger.log('warmReportCaches_: insights (chips) ' + depts[j] + ' failed: ' + (e && e.message ? e.message : e));
    }
  }
  return 0;
}

// ── Public (admin-gated) API ──────────────────────────────────────────

function getCacheWarmStatus() {
  assertAdmin_();
  return logStatusReturn_(getCacheWarmStatus_());
}

function installCacheWarmTrigger() {
  assertAdmin_();
  installCacheWarmTrigger_();
  return logStatusReturn_(getCacheWarmStatus_());
}

function uninstallCacheWarmTrigger() {
  assertAdmin_();
  uninstallCacheWarmTrigger_();
  return logStatusReturn_(getCacheWarmStatus_());
}

// Manual one-shot warm (admin) -- handy to prime caches on demand.
function warmReportCachesNow() {
  assertAdmin_();
  warmReportCaches_();
  return logStatusReturn_(getCacheWarmStatus_());
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
  var overBudget_ = function () { return Date.now() - start > CACHE_WARM_TOTAL_BUDGET_MS; };
  var sumSkipped = 0, qcdSkipped = 0;
  for (var i = 0; i < depts.length; i++) {
    if (overBudget_()) { sumSkipped = depts.length - i; break; }   // O-4
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
  // ENG-10 (broad-scan 2026-09-23, Batch 8): the modal does NOT preload
  // calendar yesterday -- qcdAllDeptDefaultDates_ (script-11) opens on the
  // LATEST QCD date, falling back to the previous workday. Warming literal
  // yesterday missed every Monday and every post-holiday morning (a weekend
  // day has no queue data, and it is not the key the modal asks for). Warm the
  // latest QCD date, and only once it has reached the previous BUSINESS day
  // (the same freshness guard, now weekend/holiday-aware).
  try {
    var expectedQcd = prevBusinessDayIso_(new Date());
    var dates = null;
    try { dates = getLatestDataDates(); } catch (e2) { dates = null; }
    var qcdLatest = dates && dates.qcd;
    if (overBudget_()) {
      qcdSkipped = 1;   // O-4
      Logger.log('warmReportCaches_: skipping qcdAll warm (run budget hit)');
    } else if (qcdLatest && qcdLatest >= expectedQcd) {
      getQcdAllDepartments({ from: qcdLatest, to: qcdLatest });
      warmed++;
    } else {
      Logger.log('warmReportCaches_: skipping qcdAll warm (QCD latest '
        + (qcdLatest || 'unknown') + ' < ' + expectedQcd + ')');
    }
  } catch (e) {
    failed++;
    Logger.log('warmReportCaches_: qcdAll warm failed: '
      + (e && e.message ? e.message : e));
  }

  // Agent-free Insights per dept (empty selection = whole roster, INV-45).
  // The heaviest per-dept aggregation, so it runs LAST under a runtime
  // budget: Apps Script kills triggers around the 6-minute mark, and a
  // partial warm is fine -- unwarmed depts just take the normal cold path.
  //
  // PERF-1: TWO windows, most-used first. Insights renders INLINE on My
  // Department and takes that page's window (the N1 merge + the M2
  // one-date-authority rule), so the window every manager actually loads
  // is the dept default -- `latest..latest`, INV-43 -- NOT the 30-day
  // launcher window this only used to warm. The cache key carries the
  // window (`insights:v24:<dept>:<from>:<to>:...`), so warming just the
  // 30-day key left EVERY first dept open paying a full cold aggregation
  // while the warm sat unread. The quick-start chip request is warmed
  // second (S2A-4 below).
  // Cost note: a 1-day window is NOT cheaper to compute than a 30-day one
  // -- both fetch the whole 12-month trend range (computeTrendStartDate_,
  // INV-29) -- so ordering, not window size, is what the budget buys.
  var INSIGHTS_WARM_BUDGET_MS = Math.min(4 * 60 * 1000, CACHE_WARM_TOTAL_BUDGET_MS);
  var insSkipped = 0;
  var warmInsightsWindow_ = function (from, to, label) {
    var skipped = 0;
    for (var j = 0; j < depts.length; j++) {
      if (Date.now() - start > INSIGHTS_WARM_BUDGET_MS) { skipped = depts.length - j; break; }
      try {
        getInsightsReport({ department: depts[j], from: from, to: to, agents: [] });
        warmed++;
      } catch (e) {
        failed++;
        Logger.log('warmReportCaches_: insights (' + label + ') ' + depts[j]
          + ' failed: ' + (e && e.message ? e.message : e));
      }
    }
    if (skipped) {
      Logger.log('warmReportCaches_: insights (' + label + ') budget hit -- '
        + skipped + ' dept(s) left cold.');
    }
    return skipped;
  };
  // 1. The dept-page default window -- what an inline Insights section
  //    loads on every My Department open.
  insSkipped += warmInsightsWindow_(latest, latest, 'dept default');
  // 2. S2A-4 (broad-scan 2026-09-23, Batch 8): the quick-start chips. This
  //    used to warm the whole roster over the last 30 days, but a chip
  //    (launcherOpenInsights_) runs over the DEPT window -- latest..latest by
  //    default -- with the ACTIVE agents ticked (selectAllActiveAgents_), and
  //    the insights key carries hashAgents_(agents). The warm never matched a
  //    single chip request. Warm that exact selection: the init endpoint the
  //    picker itself calls, its active list (or the whole list when nobody is
  //    active, which is what the picker then ticks). Best effort: a sub-queue
  //    parent's picker can group differently, and then this just misses.
  insSkipped += warmInsightsChips_(depts, latest, start, INSIGHTS_WARM_BUDGET_MS, function (ok) {
    if (ok) warmed++; else failed++;
  });

  var ms = Date.now() - start;
  Logger.log('warmReportCaches_: warmed=' + warmed + ' failed=' + failed
    + ' for ' + latest + ' in ' + ms + 'ms');
  // O-1 (broad-scan 2026-09-17): the OPS-8 contract is prefix-coded and the
  // Health classifier paints an `ok` prefix green -- so a run in which EVERY
  // warm threw recorded "ok (0 warmed, 16 failed …)" and rendered healthy. A
  // run that warmed nothing while something failed is FAILED-ALL (the
  // QueueReport / Digest rule); partial failures stay ok (the detail names
  // them) because the caches that DID warm are real work.
  var warmPrefix = (warmed === 0 && failed > 0) ? 'FAILED-ALL' : 'ok';
  recordCacheWarm_(warmPrefix + ' (' + warmed + ' warmed'
    + (failed ? ', ' + failed + ' failed' : '')
    + (sumSkipped ? ', ' + sumSkipped + ' summaries skipped on budget' : '')
    + (qcdSkipped ? ', qcdAll skipped on budget' : '')
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

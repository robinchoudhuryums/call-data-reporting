/**
 * Company Overview - cross-dept landing view.
 *
 * Single public entry callable via google.script.run:
 *   getCompanyOverview() -> {
 *     latestDate:       'yyyy-MM-dd' | null,
 *     trendIsoLabels:   ['yyyy-MM-dd', ...]    (30 entries, oldest first)
 *     trendLabels:      ['Apr 21', ...],        (human-readable, x-axis)
 *     depts: [
 *       { name, parent, activeAgents, recentlyActiveCount,
 *         rosterSize, alertedOnLatest,
 *         latest: { rung, missed, answered, pct, pctFormatted,
 *                   attFormatted },
 *         wow:   { curPct, prevPct, deltaPct } | null,
 *         trend: [pct | null, ...]              (per-day % Answered;
 *                                                 null on no-data days
 *                                                 so the chart can gap),
 *       },
 *       ...
 *     ],
 *     companyAggregate: {            // admin only; stripped for managers
 *       rung, missed, answered, pct, pctFormatted, attFormatted,
 *       activeAgents, recentlyActiveCount, rosterSize,
 *       trend: [pct | null, ...],     // 30-day company-wide trend
 *     } | undefined,
 *     pipelineFreshness: {           // admin only; stripped for managers
 *       latestTimestamp: 'yyyy-MM-dd HH:mm' | null,
 *       hoursSinceFresh: number | null,
 *       isStale: boolean,             // true if > OVERVIEW_PIPELINE_STALE_HOURS
 *     } | null | undefined,
 *     orphanNag: {                   // admin only; stripped for managers
 *       activeCount: number,          // orphans whose lastSeen is within
 *                                     // OVERVIEW_ORPHAN_NAG_DAYS
 *       totalCount:  number,          // all orphans regardless of recency
 *       sampleNames: [string, ...],   // up to 3, highest-row-count first
 *     } | null | undefined,
 *     viewerRole: 'admin' | 'manager',
 *     viewerDept: string | null,
 *   }
 *
 * Accessibility: any authenticated user (manager or admin). The
 * legacy DQE Report spreadsheet let managers see other depts' data
 * (read-only), and reinstating that visibility is part of the
 * design intent for this view.
 *
 * Caching: REPORT_CACHE_TTL_SECONDS under `companyOverview:v20` (the
 * COMPANY_OVERVIEW_CACHE_KEY constant below). Cached blob is shared
 * across all users; admin-only fields (`companyAggregate`,
 * `pipelineFreshness`, `orphanNag`) are stripped on serve for
 * non-admins, and viewer-personalized fields (viewerRole/viewerDept)
 * are injected per-request, never cached.
 *
 * Performance notes: one bulk read over the historical sheet (last
 * 30 days' worth of rows are scanned). Roster reads done once per
 * dept upfront. For ~14 depts and ~30 days * ~14 agents per dept,
 * this fits comfortably in a single Apps Script execution.
 */

// v8: dept.wow gains an optional `driver` field describing the
//     per-agent change that most contributed to the WoW shift
//     (Strategic 5 -- "what changed" insight on Overview tiles).
// v9: each dept gains a `qcd` field with the latest day's QCD
//     snapshot (totalCalls / abandonedPct / violations) read from
//     QCD Historical Data. Visible to everyone (no admin gate).
// v9: dept.qcd snapshot field added.
// v10: dept.qcd switched to a dept->queues filter (was strict dept-name match,
//      which never matched because QCD col D holds raw A_Q_* queue names).
//      Also adds dept.qcd.violationsMtd = month-to-date violations sum.
// v11: parent depts auto-include sub-queue queues via queuesForDept_
//      (Sales+PAP, Power+PAK, CSR+Spanish), matching the QCD modal's
//      and My Department's rollup behavior.
// v12: QCD snapshot includes perQueue array for per-queue tile rendering.
// v13: admin-only `pipelineFreshness` + `orphanNag` fields added for
//      the Overview Pipeline Health banner (E1) and Orphan Fix nag
//      (E12-reframed) introduced in the Phase B redesign rollout.
//      Both are stripped for non-admins by personalizeOverview_.
// v15: per-dept QCD snapshots use DIRECT queues only (sub-queue
// separation -- children carry their own tiles; the parent-expansion
// overwrite pass was removed).
// v18 (F-14): MTD violations no longer truncated by the 30-day snapshot
// window filter (see computeQcdSnapshots_).
// v19: each dept carries per-day `trendAbandoned` (QCD abandoned count) +
// `trendAbandonedPct` series aligned to trendIsoLabels, feeding the Overview
// chart's new Abandoned calls / Abandoned % metric views.
// v20: the multi-dept CHART series moved to a 90-day window (`trendChart` /
// `trendChartAbandoned` / `trendChartAbandonedPct` + top-level
// `chartTrendIsoLabels` / `chartTrendLabels`), client-sliced to 30/60/90;
// the 30-day `trend` stays for the card sparklines. Each dept also gains a
// `periods` block (yesterday/last30/ytd) for the card period slider (the DQE
// read is widened to Jan 1 to source YTD). The v19 30-day `trendAbandoned` /
// `trendAbandonedPct` are removed (superseded by the 90-day chart series).
const COMPANY_OVERVIEW_CACHE_KEY = 'companyOverview:v20';

/**
 * The Overview cache key, suffixed with the combined DQE+QCD read source
 * (CORE-3, extended for #3). ONE place so the read, the write, and every bust
 * site (OrphanFix, DeptConfig) target the identical key -- a suffix that the
 * busts didn't mirror would leak stale Overview data after an orphan rename /
 * dept-config save. Defaults to '...:sheet-sheet' when the flags are unset.
 */
function overviewCacheKey_() {
  var tag = (typeof readSourceCacheTag_ === 'function') ? readSourceCacheTag_() : 'sheet-sheet';
  return COMPANY_OVERVIEW_CACHE_KEY + ':' + tag;
}

// Chart-range slider (hybrid). The multi-dept chart ships a 90-day series
// (client-sliced to 30/60/90) kept SEPARATE from the 30-day sparkline / "X of
// Y active" data so those stay unchanged; YTD is fetched on demand via
// getOverviewChartTrend (below), never in the shared blob (100KB cap).
var OV_CHART_TREND_DAYS = 90;
var OVERVIEW_CHART_TREND_CACHE_PREFIX = 'overviewChartYtd:v1';

/**
 * Weekday-only ISO labels (skips Sat/Sun) from fromIso..toIso inclusive -- the
 * same axis convention as the 30-day trend. Shared by the 90-day payload chart
 * series and the on-demand YTD endpoint.
 */
function ovWeekdayIsoLabels_(fromIso, toIso) {
  var out = [];
  var f = parseIsoNoon_(fromIso), t = parseIsoNoon_(toIso);
  if (!f || !t) return out;
  for (var ms = f.getTime(); ms <= t.getTime(); ms += 86400000) {
    var d = new Date(ms);
    var dow = parseInt(Utilities.formatDate(d, TZ, 'u'), 10);
    if (dow === 6 || dow === 7) continue;
    out.push(Utilities.formatDate(d, TZ, 'yyyy-MM-dd'));
  }
  return out;
}

/** 'MMM d' display labels for a weekday ISO list. */
function ovTrendDisplayLabels_(isoLabels) {
  return isoLabels.map(function (iso) {
    var p = iso.split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    return Utilities.formatDate(d, TZ, 'MMM d');
  });
}

/**
 * One dept's chart series (answered % + abandoned count + abandoned %) aligned
 * to `labels`, from a DQE per-day {rung,answered} map and a QCD per-day
 * {totalCalls,abandoned} map. Null on days with no rows (weekday gaps / unmapped
 * QCD). Shared by getCompanyOverview (90-day) and getOverviewChartTrend (YTD).
 */
function ovDeptChartSeries_(labels, dqeDaily, qcdDaily) {
  dqeDaily = dqeDaily || {}; qcdDaily = qcdDaily || {};
  return {
    trend: labels.map(function (iso) {
      var d = dqeDaily[iso];
      return (d && d.rung > 0) ? round1_((d.answered / d.rung) * 100) : null;
    }),
    trendAbandoned: labels.map(function (iso) {
      var q = qcdDaily[iso];
      return q ? q.abandoned : null;
    }),
    trendAbandonedPct: labels.map(function (iso) {
      var q = qcdDaily[iso];
      return (q && q.totalCalls > 0) ? round1_((q.abandoned / q.totalCalls) * 100) : null;
    }),
  };
}

// Pipeline freshness threshold (hours). If the most recent successful
// DQE-freshness Pipeline Health row is older than this many hours, the
// Overview banner picks up the .is-stale variant and warns admins.
// Matches the header freshness pill's 36h threshold so the two
// surfaces agree on what "stale" means.
const OVERVIEW_PIPELINE_STALE_HOURS = 36;

// LM1: how many recent Pipeline Health rows computeOverviewPipelineFreshness_
// scans for the latest DQE-freshness success. This was hardcoded to 40 -- too
// tight: the deferred Neon mirror (NeonMirror.js) can append up to 4
// `neonMirror:*` FAILURE rows every 15 min per queued date during a retry
// storm (~16/hr), which evicts the morning's DQE success row from a 40-row
// window within a couple hours even though the DQE SHEET build is healthy.
// When no DQE row is found, freshness resolves to {hoursSinceFresh:null,
// isStale:true} -> the ingest watchdog false-alarms (and OPS-1 then suppresses
// a later real episode) AND the Overview pipeline banner falsely warns. A
// genuine outage keeps the DQE row visible (nothing new is appended when the
// pipeline is down), so widening the window strictly reduces false positives
// without missing a real stall. 250 covers ~2+ weeks of normal logging
// (~7-15 rows/day) and a moderate storm; readPipelineHealth_ is one bounded
// range read (cheap, and this field is cached inside getCompanyOverview).
const OVERVIEW_PIPELINE_FRESHNESS_SCAN_ROWS = 250;

// Orphan nag window (days). An orphan is "active" if its lastSeen in
// DQE Historical Data is within this many days of today. Active
// orphans are the ones likely produced by recent CDR imports, so
// they're the most useful to surface to admins for triage.
const OVERVIEW_ORPHAN_NAG_DAYS = 7;

// Window (in days) over which we consider an agent "recently
// active". Used as the denominator for the "X of Y agents" caption
// on each tile -- ex-employees who are kept on the roster sheet for
// historical-data preservation should fall out of this count. Tied
// to the same trend window we already scan, so it costs nothing
// extra to compute.
const OVERVIEW_RECENT_ACTIVE_DAYS = 30;

/**
 * Overview-only parent->children dept relationships. The "Overview"
 * tile grid renders each parent followed by its child sub-queues,
 * visually nested. Each dept is still independent everywhere else
 * (Reports modals, admin dept dropdown, alerts) -- this nesting
 * only affects the Company Overview display.
 *
 * Add a row here when a new sub-queue is introduced; the child's
 * dept name must match the column header in DO NOT EDIT! exactly.
 */
const OVERVIEW_PARENT_OF = Object.freeze({
  // Sub-queue names appear here verbatim as they're written in the
  // DO NOT EDIT! sheet's column headers. Aliases (e.g. "PAP" vs
  // "PAP Q") are tolerated -- only the matching key takes effect.
  'PAP':     'Sales',
  'PAP Q':   'Sales',
  'Spanish': 'CSR',
  'PAK':     'Power',
});

/**
 * Departments excluded from the Company Overview entirely. Still
 * accessible elsewhere; this just hides them from the cross-dept
 * landing view (e.g. "CSR Backup" is a coverage queue, not a
 * department worth surfacing at a glance).
 */
const OVERVIEW_HIDDEN_DEPTS = Object.freeze(['CSR Backup']);

function getCompanyOverview(req) {
  const email = Session.getActiveUser().getEmail();
  const realUser = resolveUser_(email);
  if (realUser.role === 'none') throw new Error('Not authorized.');

  // View-as (admin-only preview): an admin may request the MANAGER-personalized
  // Overview for a department to see exactly what that manager sees. SAFE --
  // admins are entitled to all data, so this only HIDES admin-only fields
  // (companyAggregate / pipelineFreshness / orphanNag / unmappedQcd, stripped
  // by personalizeOverview_) and sets viewerRole='manager'. Non-admin callers
  // and unknown depts are ignored (no privilege change). All personalization
  // below runs against this effective user.
  let user = realUser;
  const viewAsDept = req && String(req.viewAsDept || '').trim();
  if (realUser.role === 'admin' && viewAsDept
      && getAllDepartments_().indexOf(viewAsDept) !== -1) {
    user = { email: realUser.email, role: 'manager', department: viewAsDept, departments: [viewAsDept] };
  }

  const cache = CacheService.getScriptCache();
  // CORE-3 (extended for #3): the Overview blob embeds BOTH the DQE aggregate
  // AND the per-dept QCD chips, so key it by the combined read source -- a flip
  // of EITHER DQE_READ_SOURCE or QCD_READ_SOURCE can't serve a cross-source
  // blob. The write (below) + every bust site (OrphanFix, DeptConfig) use this
  // SAME suffixed key via overviewCacheKey_().
  const ovCacheKey = overviewCacheKey_();
  const cached = cache.get(ovCacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      return personalizeOverview_(parsed, user);
    } catch (e) { /* recompute */ }
  }

  const latestDate = getLatestDataDate();
  if (!latestDate) {
    return personalizeOverview_(
      { latestDate: null, trendIsoLabels: [], trendLabels: [], depts: [] }, user);
  }

  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.HISTORICAL);
  // F-35: hard-require the DQE sheet only when it IS the read source (see
  // the report readers). The Neon fallback below (sheetFetchDqeRows_) does
  // its own missing-sheet handling and returns [] -- an empty-but-rendered
  // Overview -- instead of the driver-free empty payload here.
  const ovDqeSource = (typeof getDqeReadSource_ === 'function') ? getDqeReadSource_() : 'sheet';
  const ovNeonCapable = (ovDqeSource === 'neon' && typeof neonFetchDqeRows_ === 'function');
  if (!ovNeonCapable) {
    if (!sheet) return personalizeOverview_(
      { latestDate: null, trendIsoLabels: [], trendLabels: [], depts: [] }, user);
    if (sheet.getLastRow() < 2) return personalizeOverview_(
      { latestDate: latestDate, trendIsoLabels: [], trendLabels: [], depts: [] }, user);
  }
  const ssTZ = ss.getSpreadsheetTimeZone();

  // 30-day window ending on latestDate (inclusive).
  const latestDateObj = parseIsoNoon_(latestDate);
  const trendDays = 30;
  const trendStart = new Date(latestDateObj.getTime() - (trendDays - 1) * 86400000);
  const trendStartIso = Utilities.formatDate(trendStart, TZ, 'yyyy-MM-dd');

  const trendIsoLabels = [];
  for (let i = 0; i < trendDays; i++) {
    const d = new Date(trendStart.getTime() + i * 86400000);
    // Skip Saturdays + Sundays. The work window is weekdays only, so a
    // weekend point is always 0/no-data and renders as a sawtooth dip in
    // every chart that consumes this axis (per-dept card sparklines, the
    // company sparkline, and the multi-dept overview chart). 'u' = ISO day
    // (1=Mon..7=Sun) in the script TZ. The Neon/sheet FETCH range below
    // stays the full calendar window so all weekday rows are captured.
    const dow = parseInt(Utilities.formatDate(d, TZ, 'u'), 10);
    if (dow === 6 || dow === 7) continue;
    trendIsoLabels.push(Utilities.formatDate(d, TZ, 'yyyy-MM-dd'));
  }
  const trendLabels = trendIsoLabels.map(function (iso) {
    const p = iso.split('-');
    const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    return Utilities.formatDate(d, TZ, 'MMM d');
  });

  // 90-day CHART window (client-sliced to 30/60/90). Separate axis from the
  // 30-day trendIsoLabels above so the card sparklines + active-count stay
  // 30-day. YTD start (for the card period slider) too. The DQE read below is
  // widened to cover the earliest of these so no extra read is needed.
  const chartTrendStart = new Date(latestDateObj.getTime() - (OV_CHART_TREND_DAYS - 1) * 86400000);
  const chartTrendStartIso = Utilities.formatDate(chartTrendStart, TZ, 'yyyy-MM-dd');
  const chartTrendIsoLabels = ovWeekdayIsoLabels_(chartTrendStartIso, latestDate);
  const chartTrendLabels = ovTrendDisplayLabels_(chartTrendIsoLabels);
  const ytdStartIso = Utilities.formatDate(
    new Date(latestDateObj.getFullYear(), 0, 1), TZ, 'yyyy-MM-dd');
  const readFromIso = [ytdStartIso, chartTrendStartIso].sort()[0];

  // Load every dept's roster up front. Build a name->dept lookup so
  // we can attribute each row to the right dept(s) in O(1) inside
  // the bulk scan.  Agents on multiple rosters count in each.
  const allDepts = getAllDepartments_();

  // Merged child->parent map (OVERVIEW_PARENT_OF constant + any
  // admin-authored Dept Config overrides, via DeptConfig.gs). Used
  // both for the misconfig check here and the per-dept `parent` field
  // in formatDept below.
  const overviewParentMap = getOverviewParentMap_();

  // Surface parent-map misconfigurations early: if a key doesn't
  // match any real dept header, the sub-queue silently renders as a
  // standalone top-level tile with no warning. A Logger entry shows
  // up in the project's execution log and is grep-able when something
  // looks off.
  Object.keys(overviewParentMap).forEach(function (childKey) {
    if (allDepts.indexOf(childKey) === -1) {
      Logger.log(
        'Overview parent map: key "%s" -> parent "%s" does not match any '
        + 'DO NOT EDIT! column header. The sub-queue nesting will not apply '
        + '(the dept either does not exist or is named differently in the '
        + 'roster sheet).',
        childKey, overviewParentMap[childKey]
      );
    }
  });

  const rosterByDept = {};
  const deptsForAgent = {};
  allDepts.forEach(function (d) {
    const roster = getRosterForDepartment_(d);
    rosterByDept[d] = roster;
    roster.names.forEach(function (name) {
      if (!deptsForAgent[name]) deptsForAgent[name] = [];
      deptsForAgent[name].push(d);
    });
  });

  // Per-dept aggregators. trendByDate keyed on ISO day; latestDay
  // is the same shape but only for latestDate. recentlyActiveAgents
  // captures anyone with ANY activity in the trend window -- used
  // as the denominator for the "X of Y agents" caption so ex-
  // employees still on the roster sheet (kept for historical-data
  // preservation) don't dilute the count.
  const deptStats = {};
  allDepts.forEach(function (d) {
    deptStats[d] = {
      latestDay: { rung: 0, missed: 0, answered: 0, att_sum: 0, activeAgents: {} },
      trendByDate: {},  // iso -> { rung, answered }
      recentlyActiveAgents: {},
      // Per-agent per-day series used by computeWowDriver_ to
      // explain which agent contributed most to the dept's WoW
      // delta. Keyed agent -> iso -> { rung, answered, missed }.
      // Only populated for non-sentinel real agents.
      agentTrendByDate: {},
    };
  });

  // On-roster, non-hidden-dept population. The company aggregate's
  // volume AND its active/recently-active counts are both scoped to
  // this set so the admin hero's numerator and denominator are drawn
  // from the same population (and the hero reconciles with the sum of
  // the visible dept tiles). Built before the scan so the loop can gate
  // accumulation directly. (Also reused below for rosterSize.)
  const companyRosterUnion = {};
  allDepts.forEach(function (d) {
    if (OVERVIEW_HIDDEN_DEPTS.indexOf(d) !== -1) return;
    rosterByDept[d].names.forEach(function (n) { companyRosterUnion[n] = true; });
  });

  // Company-wide aggregator for latestDate. Computed unconditionally
  // (cost is identical whether we use it or not); admin-only on serve
  // via personalizeOverview_. Unlike the per-dept aggregator, this
  // counts each row ONCE regardless of which roster(s) the agent
  // belongs to -- so total company volume isn't inflated by floaters
  // on multiple rosters. companyTrendByDate is the per-day series
  // used for the aggregate tile's sparkline.
  const companyLatest = {
    rung: 0, missed: 0, answered: 0, att_sum: 0, activeAgents: {},
  };
  const companyRecentlyActive = {};
  const companyTrendByDate = {};

  // F1 cutover #2: source the trend-window DQE rows from Neon when
  // DQE_READ_SOURCE=neon, else the sheet. Both fetchers return the same
  // normalized per-(date,agent) shape (durations already in seconds), so
  // the aggregation loop below is source-agnostic. Neon falls back to the
  // sheet on empty/error so a Neon hiccup can't blank the Overview.
  // Default 'sheet' => behavior identical to pre-cutover: sheetFetchDqeRows_
  // reads the same whole-sheet range and filters [trendStart, latest],
  // which equals the old ">= trendStart" filter since latest is the max date.
  // (Cache note: the Overview key IS source-suffixed via overviewCacheKey_()
  // -- CORE-3 extended for the #3 QCD read-back -- so a DQE_READ_SOURCE OR
  // QCD_READ_SOURCE flip can never serve the prior source's blob. The bust
  // sites, OrphanFix + DeptConfig, use the same suffixed key.)
  let dqeRows;
  let effectiveSource = 'sheet';
  const _tRead = Date.now();
  if (ovNeonCapable) {
    dqeRows = neonFetchDqeRows_(readFromIso, latestDate);
    if (!neonDqeRowsUsable_(dqeRows)) {   // LM2: reachable-empty is trusted; only unreachable falls back
      Logger.log('getCompanyOverview: neon returned no rows; falling back to sheet.');
      dqeRows = (typeof sheetFetchDqeRows_ === 'function')
        ? sheetFetchDqeRows_(readFromIso, latestDate) : [];
    } else {
      effectiveSource = 'neon';
    }
  } else {
    dqeRows = (typeof sheetFetchDqeRows_ === 'function')
      ? sheetFetchDqeRows_(readFromIso, latestDate) : [];
  }
  if (typeof logDqeReadTiming_ === 'function') logDqeReadTiming_('getCompanyOverview', effectiveSource, _tRead, dqeRows.length);
  for (let i = 0; i < dqeRows.length; i++) {
    const row = dqeRows[i];
    const dateIso = row.dateIso;
    if (!dateIso || dateIso < trendStartIso) continue;
    const agent = row.agent;
    if (!agent) continue;
    if (/^A_Q_/.test(agent) || agent === 'Backup CSR') continue;

    const rung     = Number(row.totalRung)     || 0;
    const missed   = Number(row.totalMissed)   || 0;
    const answered = Number(row.totalAnswered) || 0;
    const attAvg   = Number(row.attSec)        || 0;   // already parsed to seconds
    const attTotal = answered > 0 ? attAvg * answered : 0;

    // Company aggregate: count this row once on latestDate before
    // any per-dept attribution. Scoped to companyRosterUnion (on-roster,
    // non-hidden depts) so the hero's volume, % Answered, sparkline, and
    // active-count caption all share one population -- an off-roster or
    // hidden-dept-only agent's volume would otherwise inflate the hero
    // without appearing on any visible dept tile or in the active count.
    // companyTrendByDate accumulates the per-day series for the
    // aggregate tile's sparkline.
    const hadActivity = rung > 0 || answered > 0 || missed > 0;
    if (companyRosterUnion[agent]) {
      let cTrend = companyTrendByDate[dateIso];
      if (!cTrend) {
        cTrend = { rung: 0, answered: 0 };
        companyTrendByDate[dateIso] = cTrend;
      }
      cTrend.rung     += rung;
      cTrend.answered += answered;
      if (dateIso === latestDate) {
        companyLatest.rung     += rung;
        companyLatest.missed   += missed;
        companyLatest.answered += answered;
        companyLatest.att_sum  += attTotal;
        if (hadActivity) companyLatest.activeAgents[agent] = true;
      }
      if (hadActivity) companyRecentlyActive[agent] = true;
    }

    const ownerDepts = deptsForAgent[agent];
    if (!ownerDepts || !ownerDepts.length) continue;

    ownerDepts.forEach(function (d) {
      const stats = deptStats[d];
      let trendDay = stats.trendByDate[dateIso];
      if (!trendDay) {
        trendDay = { rung: 0, answered: 0 };
        stats.trendByDate[dateIso] = trendDay;
      }
      trendDay.rung     += rung;
      trendDay.answered += answered;
      if (hadActivity) stats.recentlyActiveAgents[agent] = true;

      // Per-agent per-day breakdown -- only kept inside the trend
      // window we already scan, so cost is bounded at ~14 depts ×
      // ~14 agents × 30 days = a few thousand small objects.
      let agentBuckets = stats.agentTrendByDate[agent];
      if (!agentBuckets) {
        agentBuckets = {};
        stats.agentTrendByDate[agent] = agentBuckets;
      }
      let agentDay = agentBuckets[dateIso];
      if (!agentDay) {
        agentDay = { rung: 0, answered: 0, missed: 0 };
        agentBuckets[dateIso] = agentDay;
      }
      agentDay.rung     += rung;
      agentDay.answered += answered;
      agentDay.missed   += missed;

      if (dateIso === latestDate) {
        const ld = stats.latestDay;
        ld.rung     += rung;
        ld.missed   += missed;
        ld.answered += answered;
        ld.att_sum  += attTotal;
        if (hadActivity) ld.activeAgents[agent] = true;
      }
    });
  }

  // ── Card period aggregates + 90-day chart series ────────────────────
  // Isolated pass over the SAME dqeRows (already read back to readFromIso).
  // Kept SEPARATE from the main loop above so that loop's 30-day gate -- and
  // every existing output (sparklines, company aggregate, WoW, recentlyActive)
  // -- is untouched. Builds: per-dept period SUMS (yesterday/last30/ytd) for
  // the card slider, and a per-dept per-day {rung,answered} map over the 90-day
  // chart window for the chart's answered series.
  const deptPeriodAcc = {};
  const deptChartDaily = {};
  allDepts.forEach(function (d) {
    deptPeriodAcc[d] = {
      yesterday: { rung: 0, missed: 0, answered: 0, att_sum: 0 },
      last30:    { rung: 0, missed: 0, answered: 0, att_sum: 0 },
      ytd:       { rung: 0, missed: 0, answered: 0, att_sum: 0 },
    };
    deptChartDaily[d] = {};
  });
  for (let pi = 0; pi < dqeRows.length; pi++) {
    const pr = dqeRows[pi];
    const pDate = pr.dateIso;
    if (!pDate || pDate < readFromIso) continue;
    const pAgent = pr.agent;
    if (!pAgent || /^A_Q_/.test(pAgent) || pAgent === 'Backup CSR') continue;
    const owners = deptsForAgent[pAgent];
    if (!owners || !owners.length) continue;
    const pRung     = Number(pr.totalRung)     || 0;
    const pMissed   = Number(pr.totalMissed)   || 0;
    const pAnswered = Number(pr.totalAnswered) || 0;
    const pAttTotal = pAnswered > 0 ? (Number(pr.attSec) || 0) * pAnswered : 0;
    const inYtd    = (pDate >= ytdStartIso);
    const inLast30 = (pDate >= trendStartIso);
    const isLatest = (pDate === latestDate);
    const inChart  = (pDate >= chartTrendStartIso);
    owners.forEach(function (d) {
      const pa = deptPeriodAcc[d];
      if (pa) {
        const bump = function (b) { b.rung += pRung; b.missed += pMissed; b.answered += pAnswered; b.att_sum += pAttTotal; };
        if (inYtd)    bump(pa.ytd);
        if (inLast30) bump(pa.last30);
        if (isLatest) bump(pa.yesterday);
      }
      if (inChart) {
        const cd = deptChartDaily[d];
        let cday = cd[pDate];
        if (!cday) { cday = { rung: 0, answered: 0 }; cd[pDate] = cday; }
        cday.rung     += pRung;
        cday.answered += pAnswered;
      }
    });
  }
  const fmtPeriod_ = function (b) {
    const pct = b.rung > 0 ? (b.answered / b.rung) * 100 : 0;
    const att = b.answered > 0 ? b.att_sum / b.answered : 0;
    return {
      rung: b.rung, missed: b.missed, answered: b.answered,
      pct: round1_(pct), pctFormatted: pct.toFixed(1) + '%',
      attFormatted: formatSecondsHms_(att),
    };
  };

  // Format per-dept output. Hidden depts (OVERVIEW_HIDDEN_DEPTS)
  // are skipped entirely; sub-queues get a `parent` reference and
  // are slotted right after their parent in the output order.
  // Top-level depts sorted by latest-day rung desc so busier
  // teams surface first; children sorted alphabetically inside
  // their parent group (their volumes vary too much to use rung
  // for sub-ordering meaningfully).
  const alertedSet = computeAlertedDeptsForDate_(latestDate, ssTZ);
  // Per-dept QCD snapshot read once for all depts; cheap (one extra
  // sheet read of QCD Historical Data, scoped to the last 30 days).
  // Returns dept -> { latestDate, totalCalls, abandonedPct,
  // violations } or null if no QCD rows for that dept in window.
  // computeQcdSnapshots_ scanned with the 90-day chart window so its per-dept
  // `daily` map covers the full chart series (the tile-chip latest/MTD fields
  // are date-gated and unaffected by the wider window).
  const qcdSnapshotsByDept = computeQcdSnapshots_(allDepts, chartTrendStartIso, ssTZ);
  const formatDept = function (d) {
    const stats = deptStats[d];
    const ld = stats.latestDay;
    const pct = ld.rung > 0 ? (ld.answered / ld.rung) * 100 : 0;
    const att = ld.answered > 0 ? ld.att_sum / ld.answered : 0;
    // 30-day sparkline series (answered %) -- card sparklines only.
    const trend = trendIsoLabels.map(function (iso) {
      const day = stats.trendByDate[iso];
      if (!day || day.rung <= 0) return null;
      return round1_((day.answered / day.rung) * 100);
    });
    // 90-day CHART series (client-sliced to 30/60/90): answered % from the
    // per-day DQE map + abandoned count/% from the QCD snapshot's `daily` map,
    // both aligned to chartTrendIsoLabels. Null on gap days / QCD-unmapped depts.
    const snap = qcdSnapshotsByDept[d] || null;
    const qcdDaily = (snap && snap.daily) || {};
    const chartSeries = ovDeptChartSeries_(chartTrendIsoLabels, deptChartDaily[d], qcdDaily);
    if (snap) delete snap.daily;   // don't ship the raw per-day map on the tile chip
    return {
      name: d,
      parent: overviewParentMap[d] || null,
      activeAgents: Object.keys(ld.activeAgents).length,
      // "Recently active" = anyone with any call activity in the
      // last OVERVIEW_RECENT_ACTIVE_DAYS days. Used as the
      // denominator in tile captions; ex-employees who are kept on
      // the roster sheet for historical-data preservation fall out
      // of this count naturally.
      recentlyActiveCount: Object.keys(stats.recentlyActiveAgents).length,
      rosterSize: rosterByDept[d].names.length,
      alertedOnLatest: !!alertedSet[d],
      latest: {
        rung:           ld.rung,
        missed:         ld.missed,
        answered:       ld.answered,
        pct:            round1_(pct),
        pctFormatted:   pct.toFixed(1) + '%',
        attFormatted:   formatSecondsHms_(att),
      },
      wow: computeWowDelta_(stats, latestDate),
      // QCD snapshot from the most recent date in the trend window.
      // Visible to everyone (no admin gate) -- managers see the same
      // QCD numbers their own dept's full report shows.
      qcd: snap,
      trend: trend,                                     // 30-day sparkline
      trendChart: chartSeries.trend,                    // 90-day chart (answered %)
      trendChartAbandoned: chartSeries.trendAbandoned,  // 90-day chart (abandoned count)
      trendChartAbandonedPct: chartSeries.trendAbandonedPct,
      // Card period slider (Yesterday / Last 30 / YTD). `latest` above stays
      // the Yesterday view for back-compat; the client picks a block here.
      periods: {
        yesterday: fmtPeriod_(deptPeriodAcc[d].yesterday),
        last30:    fmtPeriod_(deptPeriodAcc[d].last30),
        ytd:       fmtPeriod_(deptPeriodAcc[d].ytd),
      },
    };
  };
  const allFormatted = allDepts
    .filter(function (d) { return OVERVIEW_HIDDEN_DEPTS.indexOf(d) === -1; })
    .map(formatDept);

  const topLevel = allFormatted
    .filter(function (d) { return !d.parent; })
    .sort(function (a, b) { return b.latest.rung - a.latest.rung; });
  const childrenByParent = {};
  allFormatted.forEach(function (d) {
    if (!d.parent) return;
    (childrenByParent[d.parent] = childrenByParent[d.parent] || []).push(d);
  });
  Object.keys(childrenByParent).forEach(function (parent) {
    childrenByParent[parent].sort(function (a, b) {
      return a.name.localeCompare(b.name);
    });
  });

  const depts = [];
  const flushed_ = {};
  topLevel.forEach(function (p) {
    depts.push(p);
    flushed_[p.name] = true;
    (childrenByParent[p.name] || []).forEach(function (c) { depts.push(c); });
  });
  // RPT-5: a dept whose configured parent isn't a RENDERED top-level dept
  // (parent is hidden via OVERVIEW_HIDDEN_DEPTS, a typo'd non-dept string
  // in the constant, or a constant-level cycle) used to vanish entirely --
  // excluded from topLevel (it has a parent) AND never flushed (its parent
  // isn't in topLevel). Surface such orphans as top-level tiles with a log
  // line so the misconfig is visible instead of silently hiding a dept.
  Object.keys(childrenByParent).forEach(function (parent) {
    if (flushed_[parent]) return;
    childrenByParent[parent].forEach(function (c) {
      Logger.log('getCompanyOverview: dept "%s" has parent "%s" which is not a rendered '
        + 'top-level dept (hidden / typo / cycle) -- rendering it as top-level instead.',
        c.name, parent);
      c.parent = null;   // don't claim a nesting the grid can't draw
      depts.push(c);
    });
  });

  // Company-wide aggregate for latestDate. Total roster size is the
  // union of agent names across all non-hidden depts (companyRosterUnion,
  // built before the scan loop above; dedupes floaters who appear on
  // multiple rosters). The scan already gated company accumulation on
  // that same union, so the active / recently-active sets are inherently
  // scoped to the on-roster, non-hidden population that feeds rosterSize
  // -- the "X of Y agents active" caption can't exceed 100%, and the
  // numerator/denominator share one population. The filter below is a
  // belt-and-suspenders no-op kept for defensiveness.
  const activeAgentsFiltered = {};
  Object.keys(companyLatest.activeAgents).forEach(function (a) {
    if (companyRosterUnion[a]) activeAgentsFiltered[a] = true;
  });
  const recentlyActiveFiltered = {};
  Object.keys(companyRecentlyActive).forEach(function (a) {
    if (companyRosterUnion[a]) recentlyActiveFiltered[a] = true;
  });
  const cPct = companyLatest.rung > 0
    ? (companyLatest.answered / companyLatest.rung) * 100 : 0;
  const cAtt = companyLatest.answered > 0
    ? companyLatest.att_sum / companyLatest.answered : 0;
  // Company trend series in the same shape as per-dept trend
  // (per-ISO-day % Answered, null on no-data days). Reused for the
  // aggregate tile's sparkline.
  const companyTrend = trendIsoLabels.map(function (iso) {
    const day = companyTrendByDate[iso];
    if (!day || day.rung <= 0) return null;
    return round1_((day.answered / day.rung) * 100);
  });

  const companyAggregate = {
    rung:         companyLatest.rung,
    missed:       companyLatest.missed,
    answered:     companyLatest.answered,
    pct:          round1_(cPct),
    pctFormatted: cPct.toFixed(1) + '%',
    attFormatted: formatSecondsHms_(cAtt),
    // Both counts drawn from the same on-roster, non-hidden-dept
    // population that rosterSize uses, so the tile's "X of Y" caption
    // is internally consistent.
    activeAgents:        Object.keys(activeAgentsFiltered).length,
    recentlyActiveCount: Object.keys(recentlyActiveFiltered).length,
    rosterSize:          Object.keys(companyRosterUnion).length,
    trend:               companyTrend,
  };

  const result = {
    latestDate:       latestDate,
    trendIsoLabels:   trendIsoLabels,
    trendLabels:      trendLabels,
    // 90-day chart axis (client slices to 30/60/90; YTD fetched on demand).
    chartTrendIsoLabels: chartTrendIsoLabels,
    chartTrendLabels:    chartTrendLabels,
    depts:            depts,
    companyAggregate: companyAggregate,
    // Admin-only surface fields (stripped by personalizeOverview_ for
    // managers). Computed lazily inside try/catch so a Pipeline Health
    // sheet outage or a slow orphan scan never blocks the Overview.
    pipelineFreshness: computeOverviewPipelineFreshness_(),
    orphanNag:         computeOverviewOrphanNag_(),
    unmappedQcd:       computeOverviewUnmappedQcd_(),
    // viewerRole and viewerDept are NOT cached; personalizeOverview_
    // injects them per-request so a payload warmed by user A still
    // serves user B's identity correctly.
  };

  if (typeof deptConfigReadFailed_ === 'function' && deptConfigReadFailed_()) {
    // R8-C4: config read errored -> QCD snapshots / parent map may be
    // constant-only this request; don't pin the shared blob for the TTL.
    Logger.log('getCompanyOverview: Dept Config read errored -- skipping cache put.');
  } else {
    try { cache.put(ovCacheKey, JSON.stringify(result), REPORT_CACHE_TTL_SECONDS); }
    catch (e) { Logger.log('CompanyOverview cache put failed: %s', e); }
  }

  return personalizeOverview_(result, user);
}

/**
 * On-demand YTD chart series for the Overview chart-range slider's YTD button.
 * Returns ONLY the per-dept trend series (answered % + abandoned count/%) over
 * the year-to-date window -- NOT the full Overview payload -- so the big YTD
 * series never rides the shared companyOverview blob (100KB cap). Cached
 * separately with a size guard. Visible to any signed-in user (the Overview
 * dept lines are, too). All depts (no admin-only fields), so no personalize.
 *
 *  -> { available, latestDate, trendIsoLabels, trendLabels,
 *       depts: [{ name, parent, trend, trendAbandoned, trendAbandonedPct }] }
 */
function getOverviewChartTrend(req) {
  const user = resolveUser_(Session.getActiveUser().getEmail());
  if (!user || user.role === 'none') throw new Error('Not authorized.');

  const latestDate = getLatestDataDate();
  if (!latestDate) return { available: false };

  const cache = CacheService.getScriptCache();
  const tag = (typeof readSourceCacheTag_ === 'function') ? readSourceCacheTag_() : 'sheet-sheet';
  const cacheKey = OVERVIEW_CHART_TREND_CACHE_PREFIX + ':' + latestDate + ':' + tag;
  const cached = cache.get(cacheKey);
  if (cached) { try { return JSON.parse(cached); } catch (e) { /* recompute */ } }

  const ss = openSpreadsheet_();
  const ssTZ = ss.getSpreadsheetTimeZone();
  const latestDateObj = parseIsoNoon_(latestDate);
  const ytdStartIso = Utilities.formatDate(new Date(latestDateObj.getFullYear(), 0, 1), TZ, 'yyyy-MM-dd');
  const labels = ovWeekdayIsoLabels_(ytdStartIso, latestDate);
  const displayLabels = ovTrendDisplayLabels_(labels);

  // Roster attribution (agent -> dept[]), same as getCompanyOverview.
  const allDepts = getAllDepartments_();
  const overviewParentMap = getOverviewParentMap_();
  const deptsForAgent = {};
  allDepts.forEach(function (d) {
    getRosterForDepartment_(d).names.forEach(function (n) {
      (deptsForAgent[n] = deptsForAgent[n] || []).push(d);
    });
  });

  // DQE read [ytdStart, latest] -> per-dept per-day {rung, answered}.
  let dqeRows;
  const dqeSource = (typeof getDqeReadSource_ === 'function') ? getDqeReadSource_() : 'sheet';
  if (dqeSource === 'neon' && typeof neonFetchDqeRows_ === 'function') {
    dqeRows = neonFetchDqeRows_(ytdStartIso, latestDate);
    if (typeof neonDqeRowsUsable_ === 'function' && !neonDqeRowsUsable_(dqeRows)) {
      dqeRows = (typeof sheetFetchDqeRows_ === 'function') ? sheetFetchDqeRows_(ytdStartIso, latestDate) : [];
    }
  } else {
    dqeRows = (typeof sheetFetchDqeRows_ === 'function') ? sheetFetchDqeRows_(ytdStartIso, latestDate) : [];
  }
  const deptDaily = {};
  allDepts.forEach(function (d) { deptDaily[d] = {}; });
  for (let i = 0; i < dqeRows.length; i++) {
    const r = dqeRows[i];
    const iso = r.dateIso;
    if (!iso || iso < ytdStartIso) continue;
    const agent = r.agent;
    if (!agent || /^A_Q_/.test(agent) || agent === 'Backup CSR') continue;
    const owners = deptsForAgent[agent];
    if (!owners || !owners.length) continue;
    const rung = Number(r.totalRung) || 0, answered = Number(r.totalAnswered) || 0;
    owners.forEach(function (d) {
      const cd = deptDaily[d];
      let day = cd[iso];
      if (!day) { day = { rung: 0, answered: 0 }; cd[iso] = day; }
      day.rung += rung; day.answered += answered;
    });
  }

  // QCD per-day (abandoned) over the YTD window (reuses the snapshot's `daily`).
  const qcdSnaps = computeQcdSnapshots_(allDepts, ytdStartIso, ssTZ);

  const depts = allDepts
    .filter(function (d) { return OVERVIEW_HIDDEN_DEPTS.indexOf(d) === -1; })
    .map(function (d) {
      const snap = qcdSnaps[d] || null;
      const series = ovDeptChartSeries_(labels, deptDaily[d], (snap && snap.daily) || {});
      return { name: d, parent: overviewParentMap[d] || null,
               trend: series.trend, trendAbandoned: series.trendAbandoned, trendAbandonedPct: series.trendAbandonedPct };
    });

  const data = {
    available: true, latestDate: latestDate,
    trendIsoLabels: labels, trendLabels: displayLabels, depts: depts,
  };
  const json = JSON.stringify(data);
  // Size guard: skip caching an oversized blob (CacheService ~100KB cap) rather
  // than silently failing the put; the YTD fetch is on-demand + rare, so an
  // uncached recompute is acceptable on a very large install.
  if (json.length <= 92000) {
    try { cache.put(cacheKey, json, REPORT_CACHE_TTL_SECONDS); }
    catch (e) { Logger.log('overviewChartTrend cache put failed: %s', e); }
  }
  return data;
}

/**
 * Scans the most recent Pipeline Health entries for the latest
 * `success` row whose step participates in DQE freshness
 * (`buildDQE`, `processIntegratedHistory:DQE`, `bulkBackfill:DQE` --
 * per INV-44). Returns a small summary describing when that row
 * landed and whether the gap to "now" exceeds OVERVIEW_PIPELINE_STALE_HOURS.
 *
 * Best-effort: any failure (missing sheet, parse error, etc.)
 * returns null so the Overview still renders. Admin-only on serve
 * via personalizeOverview_.
 */
function computeOverviewPipelineFreshness_() {
  try {
    const rows = readPipelineHealth_(OVERVIEW_PIPELINE_FRESHNESS_SCAN_ROWS);   // LM1: widened from 40
    if (!rows || !rows.length) return null;
    const dqeSteps = {
      'buildDQE':                       true,
      'processIntegratedHistory:DQE':   true,
      'bulkBackfill:DQE':               true,
    };
    let latestTs = null;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.status !== 'success') continue;
      if (!dqeSteps[r.step]) continue;
      // F5: a rows:0 "success" (a no-op build -- date already in history, or
      // no new data) is NOT evidence that fresh DQE data landed. Require a
      // positive row count so a no-op re-import can't reset the staleness clock.
      if (!(Number(r.rows) > 0)) continue;
      // r.timestamp is 'yyyy-MM-dd HH:mm' in script TZ; parse via
      // Utilities to honor that TZ instead of letting Date treat it
      // as local-machine time.
      const ts = parsePipelineHealthTimestamp_(r.timestamp);
      if (!ts) continue;
      if (!latestTs || ts.getTime() > latestTs.getTime()) latestTs = ts;
    }
    if (!latestTs) {
      return {
        latestTimestamp: null,
        latestStep:      null,
        hoursSinceFresh: null,
        isStale:         true,
      };
    }
    const hoursSinceFresh = (Date.now() - latestTs.getTime()) / 3600000;
    return {
      latestTimestamp: Utilities.formatDate(latestTs, TZ, 'yyyy-MM-dd HH:mm'),
      hoursSinceFresh: Math.round(hoursSinceFresh * 10) / 10,
      isStale:         hoursSinceFresh > OVERVIEW_PIPELINE_STALE_HOURS,
    };
  } catch (e) {
    Logger.log('computeOverviewPipelineFreshness_ failed: %s', e);
    return null;
  }
}

function parsePipelineHealthTimestamp_(s) {
  // 'yyyy-MM-dd HH:mm' -> Date in script TZ. Use a manual parse so
  // we don't depend on the JS engine treating the string as local.
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(s || '');
  if (!m) return null;
  const iso = m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':00';
  // Interpret the wall-clock values in the script TZ via
  // Utilities.parseDate, which resolves the correct offset (incl. DST)
  // for the given date -- we don't roll our own offset math or rely on
  // the JS engine treating the bare string as local.
  try {
    return Utilities.parseDate(iso, TZ, "yyyy-MM-dd'T'HH:mm:ss");
  } catch (e) {
    return null;
  }
}

/**
 * Counts orphan agent names whose lastSeen date in DQE Historical
 * Data is within OVERVIEW_ORPHAN_NAG_DAYS of today. Reuses
 * computeOrphans_ (OrphanFix.gs) for the underlying scan -- safe to
 * call from here because computeOrphans_ has no admin assertion
 * (it's gated by its public caller getOrphanFixInit, which does).
 *
 * Best-effort: returns null on failure so a slow scan or missing
 * sheet doesn't block Overview rendering. Admin-only on serve via
 * personalizeOverview_.
 */
function computeOverviewOrphanNag_() {
  try {
    const orphans = computeOrphans_();
    if (!orphans || !orphans.length) {
      return { activeCount: 0, totalCount: 0, sampleNames: [] };
    }
    const cutoff = new Date(Date.now() - OVERVIEW_ORPHAN_NAG_DAYS * 86400000);
    const cutoffIso = Utilities.formatDate(cutoff, TZ, 'yyyy-MM-dd');
    const active = orphans.filter(function (o) {
      return o.lastSeen && o.lastSeen >= cutoffIso;
    });
    return {
      activeCount: active.length,
      totalCount:  orphans.length,
      // Surface up to 3 names so the banner can be specific without
      // wrapping. Sorted by row count desc so the highest-impact
      // orphans show first.
      sampleNames: active
        .slice()
        .sort(function (a, b) { return b.rows - a.rows; })
        .slice(0, 3)
        .map(function (o) { return o.name; }),
    };
  } catch (e) {
    Logger.log('computeOverviewOrphanNag_ failed: %s', e);
    return null;
  }
}

/**
 * Admin-only Overview nag (F onboarding): QCD queues SEEN in the data but
 * mapped to NO department -- their calls never surface in any dept's QCD
 * report until an admin assigns them in Dept Config. Reuses the real
 * discovery (`discoverQueues_` -> the 180-day QCD scan + the effective
 * per-dept map), so it invents no mapping. Best-effort (null on any error);
 * stripped for non-admins by personalizeOverview_. Returns up to 3 sample
 * queue names (busiest first -- discoverQueues_ already sorts unmapped-first
 * then by rows).
 */
function computeOverviewUnmappedQcd_() {
  try {
    const discovered = discoverQueues_(getAllDepartments_());
    const unmapped = (discovered || []).filter(function (q) { return !q.mappedTo; });
    return {
      count:       unmapped.length,
      sampleNames: unmapped.slice(0, 3).map(function (q) { return q.queue; }),
    };
  } catch (e) {
    Logger.log('computeOverviewUnmappedQcd_ failed: %s', e);
    return null;
  }
}

/**
 * Personalize a cached Overview blob for a specific viewer. Strips
 * the admin-only companyAggregate field for non-admins and stamps
 * the viewer's role + dept onto the response.
 *
 * Deep-clones via JSON round-trip so any future personalize step
 * that mutates nested fields (e.g. `out.depts[i].foo = bar`) can't
 * leak into the cached blob or into another viewer's response.
 * Payload is small (~14 depts plus light metadata), so the
 * round-trip cost is negligible.
 */
function personalizeOverview_(blob, user) {
  let out;
  try {
    out = JSON.parse(JSON.stringify(blob || {}));
  } catch (e) {
    // Cached blob unexpectedly contains a non-serializable value
    // (should be impossible for this plain-data blob). FAIL CLOSED:
    // do NOT fall back to a shallow copy. The non-admin strip below
    // mutates nested dept objects (`delete d.wow.driver`), and a
    // shallow copy shares those nested references with the cached
    // blob -- so the strip would leak across viewers and corrupt the
    // shared cache. Admins see everything anyway, so a shallow copy is
    // safe for them; non-admins get a minimal driver-free view rather
    // than risk the leak.
    Logger.log('personalizeOverview_ deep clone failed: %s', e);
    if (user.role === 'admin') {
      out = {};
      for (const k in blob) {
        if (Object.prototype.hasOwnProperty.call(blob, k)) out[k] = blob[k];
      }
      out.viewerRole = user.role;
      out.viewerDept = user.department || null;
      return out;
    }
    return {
      latestDate:     (blob && blob.latestDate) || null,
      trendIsoLabels: (blob && blob.trendIsoLabels) || [],
      trendLabels:    (blob && blob.trendLabels) || [],
      depts:          [],
      viewerRole:     user.role,
      viewerDept:     user.department || null,
    };
  }
  if (user.role !== 'admin') {
    delete out.companyAggregate;
    delete out.pipelineFreshness;
    delete out.orphanNag;
    delete out.unmappedQcd;
    // INV-48: managers see the WoW "driver" (a named individual agent +
    // delta) only for their OWN dept; admins see drivers for all depts.
    // The dept aggregate tiles stay cross-dept-visible by design, but the
    // per-agent attribution is stripped from other depts' tiles so a
    // manager can't see which named individual drove another team's shift.
    // #1: an all-departments manager sees every dept's data, so it keeps all
    // drivers (only single-dept managers are restricted here).
    if (Array.isArray(out.depts) && !user.allDepts) {
      out.depts.forEach(function (d) {
        if (d && d.wow && d.wow.driver && d.name !== user.department) {
          delete d.wow.driver;
        }
      });
    }
  }
  out.viewerRole = user.role;
  out.viewerDept = user.department || null;
  out.viewerAllDepts = !!user.allDepts;
  return out;
}

/**
 * Week-over-week delta on % Answered. Compares the 7-day window
 * ending on latestDate against the 7 days immediately preceding it.
 * Returns null if either window has no rung activity (insufficient
 * data to compute a delta).
 *
 * When the WoW delta is "notable" (|deltaPct| >= WOW_DRIVER_THRESHOLD),
 * also attaches a `driver` field describing the single agent whose
 * activity change most explains the dept's shift. The driver is
 * narrative-only: see computeWowDriver_ for the selection rule.
 */
const WOW_DRIVER_THRESHOLD = 1.5;   // percentage points
// Minimum net-calls a candidate agent must explain (the driver `score`:
// answered-delta minus missed-delta, or the inverse on a drop) before the
// "what changed" driver surfaces. Stops trivial one-/two-call wiggles
// ("Agent X +1 call") from cluttering the Overview queue cards / digest.
const WOW_DRIVER_MIN_DELTA = 5;     // net calls

function computeWowDelta_(stats, latestDate) {
  const latestObj = parseIsoNoon_(latestDate);
  const curIsoSet  = {};
  const prevIsoSet = {};
  const cur  = { rung: 0, answered: 0 };
  const prev = { rung: 0, answered: 0 };
  for (let i = 0; i < 7; i++) {
    const isoCur = Utilities.formatDate(
      new Date(latestObj.getTime() - i * 86400000), TZ, 'yyyy-MM-dd');
    const isoPrev = Utilities.formatDate(
      new Date(latestObj.getTime() - (i + 7) * 86400000), TZ, 'yyyy-MM-dd');
    curIsoSet[isoCur]   = true;
    prevIsoSet[isoPrev] = true;
    const dC = stats.trendByDate[isoCur];
    if (dC) { cur.rung += dC.rung; cur.answered += dC.answered; }
    const dP = stats.trendByDate[isoPrev];
    if (dP) { prev.rung += dP.rung; prev.answered += dP.answered; }
  }
  if (cur.rung === 0 || prev.rung === 0) return null;
  const curPct  = (cur.answered  / cur.rung)  * 100;
  const prevPct = (prev.answered / prev.rung) * 100;
  const deltaPct = curPct - prevPct;
  const out = {
    curPct:   round1_(curPct),
    prevPct:  round1_(prevPct),
    deltaPct: round1_(deltaPct),
  };
  if (Math.abs(deltaPct) >= WOW_DRIVER_THRESHOLD) {
    const driver = computeWowDriver_(stats, curIsoSet, prevIsoSet, deltaPct);
    if (driver) out.driver = driver;
  }
  return out;
}

/**
 * Picks the agent whose net activity change most "explains" the
 * dept's WoW shift. Score per agent:
 *   if dept WoW is positive (answer-rate went UP):
 *     score = (cur.answered - prev.answered) - (cur.missed - prev.missed)
 *   if dept WoW is negative:
 *     score = (cur.missed - prev.missed) - (cur.answered - prev.answered)
 *
 * I.e. when the dept is improving we surface the biggest answered-
 * delta (positive contributor); when regressing we surface the
 * biggest missed-delta (biggest contributor to the slide). The
 * agent with the largest score is the driver.
 *
 * Returns null if no agent meets a minimum activity bar (need at
 * least 3 events in EITHER window to avoid one-call outliers) AND a
 * minimum net contribution (score >= WOW_DRIVER_MIN_DELTA) so a
 * trivial "+1 call" change never surfaces as the driver.
 */
function computeWowDriver_(stats, curIsoSet, prevIsoSet, deltaPct) {
  const isPositive = deltaPct > 0;
  let bestAgent = null;
  let bestScore = 0;
  let bestData  = null;
  Object.keys(stats.agentTrendByDate).forEach(function (agent) {
    const buckets = stats.agentTrendByDate[agent];
    const cur  = { answered: 0, missed: 0, total: 0 };
    const prev = { answered: 0, missed: 0, total: 0 };
    Object.keys(buckets).forEach(function (iso) {
      const b = buckets[iso];
      if (curIsoSet[iso]) {
        cur.answered += b.answered; cur.missed += b.missed;
        cur.total    += b.answered + b.missed;
      } else if (prevIsoSet[iso]) {
        prev.answered += b.answered; prev.missed += b.missed;
        prev.total    += b.answered + b.missed;
      }
    });
    if (cur.total < 3 && prev.total < 3) return;   // too quiet to attribute
    const ansDelta = cur.answered - prev.answered;
    const missDelta = cur.missed  - prev.missed;
    const score = isPositive ? (ansDelta - missDelta) : (missDelta - ansDelta);
    if (score > bestScore) {
      bestScore = score;
      bestAgent = agent;
      bestData = {
        answeredDelta: ansDelta,
        missedDelta:   missDelta,
        curAnswered:   cur.answered,
        curMissed:     cur.missed,
        prevAnswered:  prev.answered,
        prevMissed:    prev.missed,
      };
    }
  });
  // Require a meaningful net contribution (WOW_DRIVER_MIN_DELTA), not just
  // any positive score, so a +1/+2-call agent never surfaces as the driver.
  if (!bestAgent || bestScore < WOW_DRIVER_MIN_DELTA) return null;
  // Pick the narrative based on which delta dominates. RPT-7: the
  // dominance check runs on BOTH directions -- an improving dept whose
  // driver score came from a missed-call DROP (answered flat) now reads
  // "missed N fewer calls" instead of "answered +0". On the positive
  // side the missed delta must actually be a drop (a dominant missed
  // INCREASE on a net-positive score still narrates via answered);
  // ties fall back to 'answered' on both sides.
  const useMissedNarrative =
    Math.abs(bestData.missedDelta) > Math.abs(bestData.answeredDelta)
    && (isPositive ? bestData.missedDelta < 0 : true);
  return {
    agent:    bestAgent,
    metric:   useMissedNarrative ? 'missed' : 'answered',
    delta:    useMissedNarrative ? bestData.missedDelta : bestData.answeredDelta,
    cur:      useMissedNarrative ? bestData.curMissed   : bestData.curAnswered,
    prev:     useMissedNarrative ? bestData.prevMissed  : bestData.prevAnswered,
    positive: isPositive,
  };
}

/**
 * Reads the Alert Log and returns a set { dept: true } of depts that
 * triggered a "sent" alert on `latestDate`. Read window is the last
 * 200 log rows -- comfortably wider than any single day's worth of
 * dept alerts. Safe no-op if the Alert Log sheet is missing.
 */
/**
 * Reads QCD Historical Data and returns one snapshot per dept,
 * aggregated across the dept's mapped queues. Two parts per dept:
 *   - Latest day's totals (sum across the dept's queues for the
 *     most recent date that has Total Calls rows for any of them).
 *   - Month-to-date violations count (sum across the dept's
 *     queues, from the 1st of the current month through latest).
 *
 * QCD col D holds raw A_Q_* queue names (not dept names), so we
 * route through DEPT_QCD_QUEUES from Config.gs. Depts that aren't
 * in the mapping return absent (no Overview QCD caption).
 *
 * Safe no-op if the sheet is missing.
 */
function computeQcdSnapshots_(allDepts, sinceIso, ssTZ) {
  const out = {};
  try {
    // R-1: source-aware read (readQcdGrid_, QCDReport.gs) so the Overview
    // QCD chips honor QCD_READ_SOURCE. The existing row filter below keeps
    // only rows >= min(sinceIso, mtdStart), so a Neon window of exactly
    // [min(sinceIso, mtdStart), today] is equivalent to the old whole-sheet
    // scan; the sheet path still reads the whole sheet (unchanged, and now
    // memo-shared with the other QCD readers).
    const _tzWin = ssTZ || TZ;
    const _nowWin = new Date();
    const _mtdStartWin = Utilities.formatDate(
      new Date(_nowWin.getFullYear(), _nowWin.getMonth(), 1), _tzWin, 'yyyy-MM-dd');
    const _readFrom = (sinceIso && sinceIso < _mtdStartWin) ? sinceIso : _mtdStartWin;
    const _readTo = Utilities.formatDate(_nowWin, _tzWin, 'yyyy-MM-dd');
    const grid = (typeof readQcdGrid_ === 'function') ? readQcdGrid_(_readFrom, _readTo) : null;
    if (!grid || grid.missing || grid.empty) return out;

    // Build queue -> [depts] lookup from each dept's effective DIRECT
    // queue list (Dept Config sheet overriding the DEPT_QCD_QUEUES
    // constant; see DeptConfig.gs). A queue normally belongs to exactly
    // one dept, but if a queue is (mis)configured into two depts' lists
    // we attribute its rows to BOTH -- matching the per-dept QCD report,
    // which counts a queue for every dept that lists it -- rather than
    // first-write-wins silently dropping the queue from the second
    // dept's Overview tile.
    const queueToDepts = {};
    allDepts.forEach(function (d) {
      getDeptQcdQueues_(d).forEach(function (q) {
        if (!queueToDepts[q]) queueToDepts[q] = [];
        queueToDepts[q].push(d);
      });
    });
    // NOTE (sub-queue separation, v15): each dept's snapshot uses its
    // DIRECT queue list only. The former second pass that overwrote a
    // parent's snapshot with the child-expanded rollup was removed --
    // children render their own nested tiles with their own QCD chips,
    // so the rollup double-displayed the child's numbers on the parent
    // tile. The QCD Report's "Include sub-queues" toggle is now the
    // place to see the combined view.

    const tz = ssTZ || TZ;
    const values = grid.values;

    // First pass: track the latest date per dept (so we can grab
    // the right "latest day" totals in a second pass).
    const latestDateByDept = {};   // dept -> isoDate
    // Month-to-date cutoff: 1st of the current month.
    const now = new Date();
    const mtdStart = Utilities.formatDate(
      new Date(now.getFullYear(), now.getMonth(), 1), tz, 'yyyy-MM-dd');

    // Single pass accumulating both latestDay and MTD violations.
    const acc = {};   // dept -> { latestDay: {date, total, abandoned, violations}, mtdViolations }
    for (let i = 0; i < values.length; i++) {
      const r = values[i];
      const source = String(r[QCD_HISTORICAL_COLS.CALL_SOURCE - 1] || '').trim();
      if (source !== 'Total Calls') continue;
      const queue = String(r[QCD_HISTORICAL_COLS.CALL_QUEUE - 1] || '').trim();
      const depts = queueToDepts[queue];
      if (!depts || !depts.length) continue;
      const dateIso = rowDateIso_(r[QCD_HISTORICAL_COLS.DATE - 1], tz);
      if (!dateIso) continue;
      // F-14: keep a row if it's inside the snapshot window OR inside the
      // current month. The old single `< sinceIso` filter ran BEFORE the
      // MTD accumulation, so in months longer than the window (e.g. day 31
      // of a 31-day month) the 1st's violations silently dropped from the
      // "X viol MTD" chip while the QCD modal's full-scan MTD kept them.
      // MTD-only rows are OLDER than every in-window row, so they cannot
      // perturb the latest-day max-date tracking below.
      if (dateIso < sinceIso && dateIso < mtdStart) continue;

      const totalCalls = Number(r[QCD_HISTORICAL_COLS.TOTAL_CALLS - 1]) || 0;
      const abandoned  = Number(r[QCD_HISTORICAL_COLS.ABANDONED   - 1]) || 0;
      const violations = Number(r[QCD_HISTORICAL_COLS.VIOLATIONS  - 1]) || 0;

      depts.forEach(function (dept) {
        let a = acc[dept];
        if (!a) {
          a = {
            latestDate:      '',
            latestTotal:     0,
            latestAbandoned: 0,
            latestViolations: 0,
            mtdViolations:   0,
            perQueue:        {},   // queue -> { totalCalls, abandoned, violations }
            daily:           {},   // iso -> { totalCalls, abandoned } (window rows, summed across queues) -- feeds the Overview chart's Abandoned metrics
          };
          acc[dept] = a;
        }

        // MTD violations: any row dated >= mtdStart contributes.
        if (dateIso >= mtdStart) a.mtdViolations += violations;

        // Per-day (in-window) abandoned series for the Overview trend chart's
        // Abandoned calls / Abandoned % metric views. Only window rows
        // (>= sinceIso) count -- MTD-only older rows are excluded from the axis.
        if (dateIso >= sinceIso) {
          var dday = a.daily[dateIso];
          if (!dday) { dday = { totalCalls: 0, abandoned: 0 }; a.daily[dateIso] = dday; }
          dday.totalCalls += totalCalls;
          dday.abandoned  += abandoned;
        }

        // Latest-day totals: accumulate across queues for the latest
        // date we've seen. If we see a newer date, reset.
        if (dateIso > a.latestDate) {
          a.latestDate = dateIso;
          a.latestTotal = totalCalls;
          a.latestAbandoned = abandoned;
          a.latestViolations = violations;
          a.perQueue = {};
          a.perQueue[queue] = { totalCalls: totalCalls, abandoned: abandoned, violations: violations };
        } else if (dateIso === a.latestDate) {
          a.latestTotal     += totalCalls;
          a.latestAbandoned += abandoned;
          a.latestViolations += violations;
          var pq = a.perQueue[queue];
          if (!pq) { pq = { totalCalls: 0, abandoned: 0, violations: 0 }; a.perQueue[queue] = pq; }
          pq.totalCalls += totalCalls;
          pq.abandoned  += abandoned;
          pq.violations += violations;
        }
      });
    }

    Object.keys(acc).forEach(function (dept) {
      const a = acc[dept];
      if (!a.latestDate) return;
      const pct = a.latestTotal > 0 ? (a.latestAbandoned / a.latestTotal) * 100 : 0;
      var perQueueOut = [];
      Object.keys(a.perQueue).forEach(function (qName) {
        var pq = a.perQueue[qName];
        var qPct = pq.totalCalls > 0 ? (pq.abandoned / pq.totalCalls) * 100 : 0;
        perQueueOut.push({
          queue: qName,
          totalCalls: pq.totalCalls,
          abandoned: pq.abandoned,
          abandonedPct: round1_(qPct),
          abandonedPctStr: qPct.toFixed(2) + '%',
          violations: pq.violations,
        });
      });
      out[dept] = {
        date:             a.latestDate,
        totalCalls:       a.latestTotal,
        abandoned:        a.latestAbandoned,
        abandonedPct:     round1_(pct),
        abandonedPctStr:  pct.toFixed(2) + '%',
        violations:       a.latestViolations,
        violationsMtd:    a.mtdViolations,
        perQueue:         perQueueOut,
        daily:            a.daily,   // consumed by formatDept -> trendAbandoned/Pct; stripped before the tile-chip payload ships
      };
    });

  } catch (e) {
    Logger.log('computeQcdSnapshots_ failed: %s', e);
  }
  return out;
}

function computeAlertedDeptsForDate_(latestDate, ssTZ) {
  if (typeof readAlertLog_ !== 'function') return {};
  let log;
  try { log = readAlertLog_(200); } catch (e) { return {}; }
  if (!log || !log.length) return {};
  const tz = ssTZ || TZ;
  const set = {};
  for (let i = 0; i < log.length; i++) {
    const e = log[i];
    if (!e.triggered) continue;
    if (String(e.status || '').toLowerCase() !== 'sent') continue;
    const iso = rowDateIso_(e.dateChecked, tz);
    if (iso === latestDate) set[String(e.department || '').trim()] = true;
  }
  return set;
}

function parseIsoNoon_(iso) {
  const p = iso.split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12, 0, 0);
}

/**
 * R11-C0 diagnostic (editor-run, admin-gated, READ-ONLY): why do specific
 * dates render as a GAP on the Overview chart while the parity gate is
 * clean? Both sources verifiably hold the 2026-05-06..26 rows, so the loss
 * must be inside the chart pipeline's own per-row filters. This replays
 * them over OV_PROBE_FROM..OV_PROBE_TO (Script Properties; defaults to the
 * May range) using the ACTIVE read source and logs, per date:
 *   rows fetched | sentinel-skipped | roster-UNMATCHED (with sample names)
 *   | attributed rung total
 * A date whose rows all land in "roster-unmatched" pins the gap on the
 * agent-name -> roster join (INV-04 exact match) and the sample names show
 * exactly which spellings to fix (Outlier Fix / alias). A date with rows
 * but attributed rung 0 pins it on zeroed count columns instead.
 */
function probeOverviewChartDates() {
  assertAdmin_();
  const props = PropertiesService.getScriptProperties();
  const from = props.getProperty('OV_PROBE_FROM') || '2026-05-06';
  const to   = props.getProperty('OV_PROBE_TO')   || '2026-05-26';
  let rows = null, source = 'sheet';
  if (typeof getDqeReadSource_ === 'function' && getDqeReadSource_() === 'neon') {
    rows = neonFetchDqeRows_(from, to);
    source = 'neon';
    if (!(rows && (rows.length || rows._neonReachable))) { rows = null; }
  }
  if (!rows) { rows = sheetFetchDqeRows_(from, to); source = source === 'neon' ? 'neon->sheet-fallback' : 'sheet'; }
  Logger.log('=== probeOverviewChartDates %s..%s | source=%s | rows=%s ===', from, to, source, rows.length);

  const allDepts = getAllDepartments_();
  const deptsForAgent = {};
  allDepts.forEach(function (d) {
    getRosterForDepartment_(d).names.forEach(function (name) {
      if (!deptsForAgent[name]) deptsForAgent[name] = [];
      deptsForAgent[name].push(d);
    });
  });

  const byDate = {};
  rows.forEach(function (r) {
    const iso = r.dateIso;
    if (!iso) return;
    const b = byDate[iso] || (byDate[iso] = { rows: 0, sentinel: 0, unmatched: 0, rung: 0, samples: {} });
    b.rows++;
    const agent = r.agent;
    if (!agent || /^A_Q_/.test(agent) || agent === 'Backup CSR') { b.sentinel++; return; }
    if (!deptsForAgent[agent] || !deptsForAgent[agent].length) {
      b.unmatched++;
      if (Object.keys(b.samples).length < 3) b.samples[agent] = true;
      return;
    }
    b.rung += Number(r.totalRung) || 0;
  });
  Object.keys(byDate).sort().forEach(function (iso) {
    const b = byDate[iso];
    Logger.log('%s | rows=%s sentinel=%s roster-unmatched=%s attributedRung=%s%s',
      iso, b.rows, b.sentinel, b.unmatched, b.rung,
      Object.keys(b.samples).length ? ' | unmatched samples: ' + Object.keys(b.samples).join(', ') : '');
  });
  const isoSet = {};
  rows.forEach(function (r) { if (r.dateIso) isoSet[r.dateIso] = true; });
  Logger.log('Dates with NO rows at all in %s..%s: %s', from, to,
    (function () {
      const missing = [];
      const cur = new Date(Number(from.slice(0,4)), Number(from.slice(5,7)) - 1, Number(from.slice(8,10)), 12);
      const end  = new Date(Number(to.slice(0,4)), Number(to.slice(5,7)) - 1, Number(to.slice(8,10)), 12);
      while (cur <= end) {
        const iso = Utilities.formatDate(cur, TZ, 'yyyy-MM-dd');
        const dow = cur.getDay();
        if (dow !== 0 && dow !== 6 && !isoSet[iso]) missing.push(iso);
        cur.setDate(cur.getDate() + 1);
      }
      return missing.length ? missing.join(', ') : '(none)';
    })());
}

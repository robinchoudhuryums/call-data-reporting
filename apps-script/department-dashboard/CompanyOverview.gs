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
 *     viewerRole: 'admin' | 'manager',
 *     viewerDept: string | null,
 *   }
 *
 * Accessibility: any authenticated user (manager or admin). The
 * legacy DQE Report spreadsheet let managers see other depts' data
 * (read-only), and reinstating that visibility is part of the
 * design intent for this view.
 *
 * Caching: 5 min under `companyOverview:v7`. Cached blob is shared
 * across all users; the admin-only `companyAggregate` field is
 * stripped on serve for non-admins, and viewer-personalized fields
 * (viewerRole/viewerDept) are injected per-request, never cached.
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
const COMPANY_OVERVIEW_CACHE_KEY = 'companyOverview:v10';

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

function getCompanyOverview() {
  const email = Session.getActiveUser().getEmail();
  const user = resolveUser_(email);
  if (user.role === 'none') throw new Error('Not authorized.');

  const cache = CacheService.getScriptCache();
  const cached = cache.get(COMPANY_OVERVIEW_CACHE_KEY);
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
  if (!sheet) return personalizeOverview_(
    { latestDate: null, trendIsoLabels: [], trendLabels: [], depts: [] }, user);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return personalizeOverview_(
    { latestDate: latestDate, trendIsoLabels: [], trendLabels: [], depts: [] }, user);
  const ssTZ = ss.getSpreadsheetTimeZone();

  // 30-day window ending on latestDate (inclusive).
  const latestDateObj = parseIsoNoon_(latestDate);
  const trendDays = 30;
  const trendStart = new Date(latestDateObj.getTime() - (trendDays - 1) * 86400000);
  const trendStartIso = Utilities.formatDate(trendStart, TZ, 'yyyy-MM-dd');

  const trendIsoLabels = [];
  for (let i = 0; i < trendDays; i++) {
    const d = new Date(trendStart.getTime() + i * 86400000);
    trendIsoLabels.push(Utilities.formatDate(d, TZ, 'yyyy-MM-dd'));
  }
  const trendLabels = trendIsoLabels.map(function (iso) {
    const p = iso.split('-');
    const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    return Utilities.formatDate(d, TZ, 'MMM d');
  });

  // Load every dept's roster up front. Build a name->dept lookup so
  // we can attribute each row to the right dept(s) in O(1) inside
  // the bulk scan.  Agents on multiple rosters count in each.
  const allDepts = getAllDepartments_();

  // Surface OVERVIEW_PARENT_OF misconfigurations early: if a key
  // doesn't match any real dept header, the sub-queue silently
  // renders as a standalone top-level tile with no warning. A
  // Logger entry shows up in the project's execution log and is
  // grep-able when something looks off.
  Object.keys(OVERVIEW_PARENT_OF).forEach(function (childKey) {
    if (allDepts.indexOf(childKey) === -1) {
      Logger.log(
        'OVERVIEW_PARENT_OF: key "%s" -> parent "%s" does not match any '
        + 'DO NOT EDIT! column header. The sub-queue nesting will not apply '
        + '(the dept either does not exist or is named differently in the '
        + 'roster sheet).',
        childKey, OVERVIEW_PARENT_OF[childKey]
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

  // Bulk scan -- only the last `trendDays` worth of rows matter.
  const range = sheet.getRange(2, 1, lastRow - 1, HISTORICAL_COLS.CSR_AVG_ABD_WAIT);
  const values   = range.getValues();
  const displays = range.getDisplayValues();
  for (let i = 0; i < values.length; i++) {
    const r  = values[i];
    const rd = displays[i];
    const dateIso = rowDateIso_(r[HISTORICAL_COLS.DATE - 1], ssTZ);
    if (!dateIso || dateIso < trendStartIso) continue;
    const agent = String(r[HISTORICAL_COLS.AGENT - 1] || '').trim();
    if (!agent) continue;
    if (/^A_Q_/.test(agent) || agent === 'Backup CSR') continue;

    const rung     = Number(r[HISTORICAL_COLS.TOTAL_RUNG - 1])     || 0;
    const missed   = Number(r[HISTORICAL_COLS.TOTAL_MISSED - 1])   || 0;
    const answered = Number(r[HISTORICAL_COLS.TOTAL_ANSWERED - 1]) || 0;
    const attAvg   = parseHmsDisplay_(rd[HISTORICAL_COLS.ATT - 1]);
    const attTotal = answered > 0 ? attAvg * answered : 0;

    // Company aggregate: count this row once on latestDate before
    // any per-dept attribution. Agents not on any roster still count
    // here (real volume), but they won't be attributed to any dept
    // tile below. companyTrendByDate accumulates the per-day series
    // for the aggregate tile's sparkline.
    const hadActivity = rung > 0 || answered > 0 || missed > 0;
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
  const qcdSnapshotsByDept = computeQcdSnapshots_(allDepts, trendStartIso, ssTZ);
  const formatDept = function (d) {
    const stats = deptStats[d];
    const ld = stats.latestDay;
    const pct = ld.rung > 0 ? (ld.answered / ld.rung) * 100 : 0;
    const att = ld.answered > 0 ? ld.att_sum / ld.answered : 0;
    const trend = trendIsoLabels.map(function (iso) {
      const day = stats.trendByDate[iso];
      if (!day || day.rung <= 0) return null;
      return round1_((day.answered / day.rung) * 100);
    });
    return {
      name: d,
      parent: OVERVIEW_PARENT_OF[d] || null,
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
      qcd: qcdSnapshotsByDept[d] || null,
      trend: trend,
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
  topLevel.forEach(function (p) {
    depts.push(p);
    (childrenByParent[p.name] || []).forEach(function (c) { depts.push(c); });
  });

  // Company-wide aggregate for latestDate. Total roster size is the
  // union of agent names across all non-hidden depts (dedupes
  // floaters who appear on multiple rosters).
  const companyRosterUnion = {};
  allDepts.forEach(function (d) {
    if (OVERVIEW_HIDDEN_DEPTS.indexOf(d) !== -1) return;
    rosterByDept[d].names.forEach(function (n) { companyRosterUnion[n] = true; });
  });
  // Filter the active / recently-active sets to the same on-roster,
  // non-hidden-dept population that feeds rosterSize, so the tile's
  // "X of Y agents active" caption can't go above 100% just because
  // a hidden-dept-only agent (e.g. CSR Backup floater) had activity
  // today. Without this filter the numerator and denominator are
  // drawn from different populations and produce visibly wrong
  // arithmetic on the admin Overview hero.
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
    depts:            depts,
    companyAggregate: companyAggregate,
    // viewerRole and viewerDept are NOT cached; personalizeOverview_
    // injects them per-request so a payload warmed by user A still
    // serves user B's identity correctly.
  };

  try { cache.put(COMPANY_OVERVIEW_CACHE_KEY, JSON.stringify(result), CACHE_TTL_SECONDS); }
  catch (e) { Logger.log('CompanyOverview cache put failed: %s', e); }

  return personalizeOverview_(result, user);
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
    // Cached blob unexpectedly contains a non-serializable value.
    // Fall back to a shallow copy so the request still serves --
    // the personalize layer's contract is "no leakage", and at
    // least the top-level fields are independent here.
    out = {};
    for (const k in blob) {
      if (Object.prototype.hasOwnProperty.call(blob, k)) out[k] = blob[k];
    }
  }
  if (user.role !== 'admin') delete out.companyAggregate;
  out.viewerRole = user.role;
  out.viewerDept = user.department || null;
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
 * least 3 events in EITHER window to avoid one-call outliers).
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
  if (!bestAgent || bestScore <= 0) return null;
  // Pick the narrative based on which delta dominates. Avoid
  // attributing a "+50% answered" driver to a dept that's actually
  // regressing -- the score guard above already filters those, but
  // belt-and-suspenders.
  const useMissedNarrative = !isPositive
    && Math.abs(bestData.missedDelta) > Math.abs(bestData.answeredDelta);
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
    const ss = openSpreadsheet_();
    const sheet = ss.getSheetByName('QCD Historical Data');
    if (!sheet) return out;
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return out;

    // Build queue -> dept lookup once. A queue can belong to only
    // one dept; first-write wins on duplicates. Skip depts with no
    // mapping in DEPT_QCD_QUEUES.
    const queueToDept = {};
    allDepts.forEach(function (d) {
      const queues = (typeof DEPT_QCD_QUEUES !== 'undefined') && DEPT_QCD_QUEUES[d];
      if (!Array.isArray(queues)) return;
      queues.forEach(function (q) {
        if (!queueToDept[q]) queueToDept[q] = d;
      });
    });

    const tz = ssTZ || TZ;
    const values = sheet.getRange(2, 1, lastRow - 1, 12).getValues();

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
      const dept = queueToDept[queue];
      if (!dept) continue;
      const dateIso = rowDateIso_(r[QCD_HISTORICAL_COLS.DATE - 1], tz);
      if (!dateIso || dateIso < sinceIso) continue;

      const totalCalls = Number(r[QCD_HISTORICAL_COLS.TOTAL_CALLS - 1]) || 0;
      const abandoned  = Number(r[QCD_HISTORICAL_COLS.ABANDONED   - 1]) || 0;
      const violations = Number(r[QCD_HISTORICAL_COLS.VIOLATIONS  - 1]) || 0;

      let a = acc[dept];
      if (!a) {
        a = {
          latestDate:      '',
          latestTotal:     0,
          latestAbandoned: 0,
          latestViolations: 0,
          mtdViolations:   0,
        };
        acc[dept] = a;
      }

      // MTD violations: any row dated >= mtdStart contributes.
      if (dateIso >= mtdStart) a.mtdViolations += violations;

      // Latest-day totals: accumulate across queues for the latest
      // date we've seen. If we see a newer date, reset.
      if (dateIso > a.latestDate) {
        a.latestDate = dateIso;
        a.latestTotal = totalCalls;
        a.latestAbandoned = abandoned;
        a.latestViolations = violations;
      } else if (dateIso === a.latestDate) {
        a.latestTotal     += totalCalls;
        a.latestAbandoned += abandoned;
        a.latestViolations += violations;
      }
    }

    Object.keys(acc).forEach(function (dept) {
      const a = acc[dept];
      if (!a.latestDate) return;
      const pct = a.latestTotal > 0 ? (a.latestAbandoned / a.latestTotal) * 100 : 0;
      out[dept] = {
        date:             a.latestDate,
        totalCalls:       a.latestTotal,
        abandoned:        a.latestAbandoned,
        abandonedPct:     round1_(pct),
        abandonedPctStr:  pct.toFixed(2) + '%',
        violations:       a.latestViolations,
        violationsMtd:    a.mtdViolations,
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

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

const COMPANY_OVERVIEW_CACHE_KEY = 'companyOverview:v7';

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
 * the viewer's role + dept onto the response. Always returns a new
 * object so the cached blob isn't mutated.
 */
function personalizeOverview_(blob, user) {
  const out = {};
  for (const k in blob) {
    if (Object.prototype.hasOwnProperty.call(blob, k)) out[k] = blob[k];
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
 */
function computeWowDelta_(stats, latestDate) {
  const latestObj = parseIsoNoon_(latestDate);
  const cur  = { rung: 0, answered: 0 };
  const prev = { rung: 0, answered: 0 };
  for (let i = 0; i < 7; i++) {
    const isoCur = Utilities.formatDate(
      new Date(latestObj.getTime() - i * 86400000), TZ, 'yyyy-MM-dd');
    const isoPrev = Utilities.formatDate(
      new Date(latestObj.getTime() - (i + 7) * 86400000), TZ, 'yyyy-MM-dd');
    const dC = stats.trendByDate[isoCur];
    if (dC) { cur.rung += dC.rung; cur.answered += dC.answered; }
    const dP = stats.trendByDate[isoPrev];
    if (dP) { prev.rung += dP.rung; prev.answered += dP.answered; }
  }
  if (cur.rung === 0 || prev.rung === 0) return null;
  const curPct  = (cur.answered  / cur.rung)  * 100;
  const prevPct = (prev.answered / prev.rung) * 100;
  return {
    curPct:   round1_(curPct),
    prevPct:  round1_(prevPct),
    deltaPct: round1_(curPct - prevPct),
  };
}

/**
 * Reads the Alert Log and returns a set { dept: true } of depts that
 * triggered a "sent" alert on `latestDate`. Read window is the last
 * 200 log rows -- comfortably wider than any single day's worth of
 * dept alerts. Safe no-op if the Alert Log sheet is missing.
 */
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

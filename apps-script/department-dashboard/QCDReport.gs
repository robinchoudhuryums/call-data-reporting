/**
 * QCD (Queue Call Detail) Report -- server-side data.
 *
 * Reads the `QCD Historical Data` sheet (one row per dept-name-like
 * callQueue value, per callSource, per day; written by
 * cdr-import/autoImport.js's processIntegratedHistory). Surfaces:
 *
 *   - Dept-level KPI tiles (Total Calls, Answered, Abandoned, Avg
 *     Wait, Violations) aggregated over the selected range from
 *     rows where callSource === 'Total Calls'.
 *   - Per-source breakdown table (one row per callSource: CSR,
 *     Ad-campaign, New Call Menu, Non-CSR (internal), and the
 *     Total Calls roll-up row) nested under the dept aggregate.
 *   - 12-month trend chart (monthly buckets) over the same trend
 *     window the Individual / Performance Reports use.
 *
 * Public entries (callable via google.script.run):
 *   getQcdReportInit({ department }) -> { department, defaultStart,
 *     defaultEnd, sources }
 *   getQcdReport({ department, from, to }) -> { meta, dateLabel,
 *     totals, queueBreakdown, trendData }
 *   sendQcdReportEmail({ imageBase64, dateLabel }) -> { to }
 *
 * Authorization: same per-dept model as IR / PR / CR. Managers can
 * only request their own dept; admins can pick any dept from the
 * dropdown.
 *
 * Cache: 30 min per (dept, from, to) tuple under `qcd:v7:` prefix.
 * No agent-list dimension since QCD is queue/dept-scoped, not
 * agent-scoped.
 *
 * IMPORTANT: QCD Historical Data's `callQueue` column (col D) carries
 * raw queue names like "A_Q_CustomerSuccess", "A_Q_Sales", "Backup CSR"
 * -- NOT dashboard dept names. To filter QCD rows for a dashboard dept,
 * use Config.gs::DEPT_QCD_QUEUES[dept] (admin-curated map of dept name
 * to list of queue names). A dept not in that map renders an empty QCD
 * modal with a "No queues mapped" hint.
 */

// v2: callQueue is a raw A_Q_* name, not a dept name; filter by
//     DEPT_QCD_QUEUES[dept] (list of queue names) instead of strict
//     equality. Per-queue breakdown table replaces the prior per-
//     source breakdown.
// v3: parent depts auto-include sub-queue queues via
//     OVERVIEW_PARENT_OF rollup (Sales+PAP, Power+PAK, CSR+Spanish).
//     Adds dailySeries to response; totals.violations replaced
//     with month-to-date count (was selected-range sum).
// v4: avgAnswer changed from mean-of-daily-averages to volume-weighted
//     average (weighted by totalAnswered per day/queue).
// v5: per-queue daily + monthly series for multi-line charts;
//     violationDates per queue for expandable breakdown rows.
// v6: empty/no-data response shape now carries `perQueue` +
//     `trendData.perQueue` to match the populated shape (F5), so a
//     cached old-shape empty payload can't be served (and throw) on
//     the client after deploy.
// v7: cache key + compute gain the includeSubQueues dimension (the
// "Include sub-queues" toggle; default true = legacy INV-51 rollup).
const QCD_CACHE_KEY_PREFIX = 'qcd:v7';

// Source filter: only the "Total Calls" callSource row carries the
// daily aggregate we want; other callSource values are sub-counts
// (CSR / Ad-campaign / etc. -- routing origin breakdowns) that
// would double-count if summed alongside Total Calls. Pin here so
// label-sheet drift doesn't change behavior.
const QCD_TOTAL_CALLS_SOURCE = 'Total Calls';

/**
 * Returns the list of queue names that belong to `dept`, from the
 * admin-curated DEPT_QCD_QUEUES map in Config.gs. When `dept` is a
 * top-level parent per CompanyOverview.gs::OVERVIEW_PARENT_OF, the
 * result also includes every child dept's queues -- so viewing
 * Sales picks up PAP's queues, Power picks up PAK's, CSR picks
 * up Spanish's. Order: parent first, children in OVERVIEW_PARENT_OF
 * iteration order.
 *
 * Returns [] for unmapped depts (caller renders an empty report
 * with a "No queues mapped" hint).
 *
 * Used by QCDReport.gs (the modal), CompanyOverview.gs's tile
 * snapshot, AND Data.gs's My Department snapshot -- so all three
 * QCD surfaces share the same rollup behavior.
 */
function queuesForDept_(dept, opts) {
  const includeChildren = !(opts && opts.includeChildren === false);
  const seen = {};
  const out = [];
  const add = function (q) {
    if (q && !seen[q]) { seen[q] = true; out.push(q); }
  };
  // Effective queue lists + parent map route through DeptConfig.gs so
  // the admin-authored Dept Config sheet (when present) overrides the
  // DEPT_QCD_QUEUES / OVERVIEW_PARENT_OF constants without a redeploy.
  // Falls straight through to the constants when no sheet row exists.
  getDeptQcdQueues_(dept).forEach(add);

  // Sub-queue rollup: append any child whose parent === this dept.
  // opts.includeChildren=false returns the dept's OWN queues only --
  // the QCD report's "Include sub-queues" toggle and the Overview's
  // parent tiles (children render their own tiles) use it; default
  // unchanged so every existing caller keeps INV-51 rollup semantics.
  if (includeChildren) {
    const parentMap = getOverviewParentMap_();
    Object.keys(parentMap).forEach(function (childDept) {
      if (parentMap[childDept] !== dept) return;
      getDeptQcdQueues_(childDept).forEach(add);
    });
  }
  return out;
}

/** True when at least one dept's Overview parent === dept. */
function deptHasSubQueues_(dept) {
  const parentMap = getOverviewParentMap_();
  return Object.keys(parentMap).some(function (child) { return parentMap[child] === dept; });
}

/**
 * Month-to-date violations count for the dept (sum across its
 * mapped queues, including sub-queue rollup). Used for the
 * "Violations (current month)" KPI tile.
 */
function computeMtdViolations_(dept, values, ssTZ, qOpts) {
  const queues = queuesForDept_(dept, qOpts);
  if (queues.length === 0) return 0;
  const queueSet = {};
  queues.forEach(function (q) { queueSet[q] = true; });
  const tz = ssTZ || TZ;
  const now = new Date();
  const mtdStart = Utilities.formatDate(
    new Date(now.getFullYear(), now.getMonth(), 1), tz, 'yyyy-MM-dd');
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    const r = values[i];
    const source = String(r[QCD_HISTORICAL_COLS.CALL_SOURCE - 1] || '').trim();
    if (source !== QCD_TOTAL_CALLS_SOURCE) continue;
    const q = String(r[QCD_HISTORICAL_COLS.CALL_QUEUE - 1] || '').trim();
    if (!queueSet[q]) continue;
    const dateIso = rowDateIso_(r[QCD_HISTORICAL_COLS.DATE - 1], tz);
    if (!dateIso || dateIso < mtdStart) continue;
    total += Number(r[QCD_HISTORICAL_COLS.VIOLATIONS - 1]) || 0;
  }
  return total;
}

function getQcdReportInit(req) {
  const email = Session.getActiveUser().getEmail();
  const user = resolveUser_(email);
  if (user.role === 'none') throw new Error('Not authorized.');

  const dept = String((req && req.department) || '').trim();
  if (!dept) throw new Error('Department is required.');
  assertDeptAccess_(user, dept);

  const tz = TZ;
  const now = new Date();
  const fmt = function (d) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); };
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  return {
    department:   dept,
    defaultStart: fmt(firstOfMonth),
    defaultEnd:   fmt(now),
    queues:       queuesForDept_(dept),
  };
}

function getQcdReport(req) {
  const email = Session.getActiveUser().getEmail();
  const user = resolveUser_(email);
  if (user.role === 'none') throw new Error('Not authorized.');

  const dept = String((req && req.department) || '').trim();
  if (!dept) throw new Error('Department is required.');
  assertDeptAccess_(user, dept);

  const from = String((req && req.from) || '').trim();
  const to   = String((req && req.to)   || '').trim();
  if (!isIsoDate_(from) || !isIsoDate_(to)) {
    throw new Error('from/to must be YYYY-MM-DD.');
  }
  if (from > to) throw new Error('from must be on or before to.');
  // Sub-queue rollup toggle: absent/true = legacy INV-51 rollup;
  // false = the dept's own queues only.
  const includeSubQueues = !(req && req.includeSubQueues === false);

  const cache = CacheService.getScriptCache();
  const cacheKey = QCD_CACHE_KEY_PREFIX + ':' + dept + ':' + from + ':' + to
                 + ':' + (includeSubQueues ? 'roll' : 'own');
  const cached = cache.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      parsed.meta.cacheHit = true;
      logReportUsage_('qcd', dept, user, true);
      return parsed;
    } catch (e) { /* recompute */ }
  }

  const t0 = Date.now();
  const data = computeQcdReport_(dept, from, to, includeSubQueues);
  data.meta.computeMs = Date.now() - t0;
  data.meta.cacheHit  = false;

  const json = JSON.stringify(data);
  if (json.length <= 100000) {
    try { cache.put(cacheKey, json, REPORT_CACHE_TTL_SECONDS); }
    catch (e) { Logger.log('QCDReport cache put failed: %s', e); }
  } else {
    Logger.log('QCDReport: payload %s bytes exceeds 100KB, skipping cache', json.length);
  }

  logReportUsage_('qcd', dept, user, false);
  return data;
}

function computeQcdReport_(dept, from, to, includeSubQueues) {
  const qOpts = { includeChildren: includeSubQueues !== false };
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName('QCD Historical Data');
  if (!sheet) {
    throw new Error('Sheet "QCD Historical Data" not found. Verify the pipeline has run at least once for this dept.');
  }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return emptyQcdReport_(dept, from, to, includeSubQueues);
  }
  const ssTZ = ss.getSpreadsheetTimeZone();

  // Dept -> queue names. Empty = this dept isn't mapped in
  // DEPT_QCD_QUEUES; return the empty shape so the modal shows
  // "No queues mapped" instead of throwing.
  const queues = queuesForDept_(dept, qOpts);
  if (queues.length === 0) {
    const empty = emptyQcdReport_(dept, from, to, includeSubQueues);
    empty.meta.unmapped = true;
    return empty;
  }
  const queueSet = {};
  queues.forEach(function (q) { queueSet[q] = true; });

  // Read all 12 cols. Display values for the H:MM:SS time fields
  // (longestWait / avgAnswer); raw values for everything else.
  const lastCol = 12;
  const range = sheet.getRange(2, 1, lastRow - 1, lastCol);
  const values   = range.getValues();
  const displays = range.getDisplayValues();

  // Trend window: same logic as Individual / Performance Reports
  // (12-mo monthly buckets unless range > 366 days or full year).
  const parseIso_ = function (iso) {
    const p = iso.split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12);
  };
  const startDate = parseIso_(from);
  const endDate   = parseIso_(to);
  const msPerDay = 86400000;
  // Math.round, not ceil: noon-anchored dates wobble +-1h across DST.
  const diffDays = Math.round(Math.abs(endDate - startDate) / msPerDay) + 1;
  const isFullYear =
       startDate.getMonth() === 0 && startDate.getDate() === 1
    && endDate.getMonth()   === 11 && endDate.getDate()   === 31
    && startDate.getFullYear() === endDate.getFullYear();
  let trendStartDate;
  if (diffDays > 366 || isFullYear) {
    trendStartDate = new Date(startDate);
  } else {
    trendStartDate = new Date(endDate);
    trendStartDate.setMonth(trendStartDate.getMonth() - 12);
    trendStartDate.setDate(1);
  }
  const trendStartIso = Utilities.formatDate(trendStartDate, TZ, 'yyyy-MM-dd');
  const trendEndIso   = to;
  const monthKeys = generateMonthList_(trendStartDate, endDate);

  // Per-queue accumulators for the selected range. Only the
  // QCD_TOTAL_CALLS_SOURCE rows are summed -- other callSource
  // values are sub-counts (routing-origin breakdowns) that would
  // double-count if added alongside Total Calls. Each queue
  // tracks its own monthly buckets so the trend chart can roll
  // up across all dept queues at render time.
  const queueAcc = {};
  queues.forEach(function (q) {
    queueAcc[q] = {
      totalCalls:          0,
      totalAnswered:       0,
      abandoned:           0,
      longestWaitSec:      0,
      avgAnswerWeightedSum: 0,
      avgAnswerWeightedN:   0,
      violations:          0,
      violationDates:      [],   // iso dates where violations > 0
      monthly:             {},   // monthKey -> { totalCalls, totalAnswered, abandoned, violations }
      daily:               {},   // iso -> { totalCalls, totalAnswered, abandoned, abandonedPct, violations }
    };
  });
  // Daily series: keyed iso date. Summed across all dept queues
  // per day. Only populated for dates in the selected user range
  // (the trend window's larger daily series would be too dense
  // for the chart and table to be useful).
  const dailyAcc = {};   // iso -> { totalCalls, answered, abandoned, violations }

  for (let i = 0; i < values.length; i++) {
    const r  = values[i];
    const rd = displays[i];
    const dateIso = rowDateIso_(r[QCD_HISTORICAL_COLS.DATE - 1], ssTZ);
    if (!dateIso) continue;
    const callQueue = String(r[QCD_HISTORICAL_COLS.CALL_QUEUE - 1] || '').trim();
    if (!queueSet[callQueue]) continue;
    const source = String(r[QCD_HISTORICAL_COLS.CALL_SOURCE - 1] || '').trim();
    if (source !== QCD_TOTAL_CALLS_SOURCE) continue;   // skip sub-counts

    const inUserRange  = (dateIso >= from && dateIso <= to);
    const inTrendRange = (dateIso >= trendStartIso && dateIso <= trendEndIso);
    if (!inUserRange && !inTrendRange) continue;

    const totalCalls    = Number(r[QCD_HISTORICAL_COLS.TOTAL_CALLS - 1])    || 0;
    const totalAnswered = Number(r[QCD_HISTORICAL_COLS.TOTAL_ANSWERED - 1]) || 0;
    const abandoned     = Number(r[QCD_HISTORICAL_COLS.ABANDONED - 1])      || 0;
    // longestWait + avgAnswer are stored H:MM:SS; parse from display
    // strings so the spreadsheet-TZ-vs-script-TZ duration gotcha
    // (INV-02) doesn't bite. parseHmsDisplay_ is shared from Data.gs.
    const longestWaitSec = parseHmsDisplay_(rd[QCD_HISTORICAL_COLS.LONGEST_WAIT - 1]);
    const avgAnswerSec   = parseHmsDisplay_(rd[QCD_HISTORICAL_COLS.AVG_ANSWER   - 1]);
    const violations     = Number(r[QCD_HISTORICAL_COLS.VIOLATIONS - 1]) || 0;

    const bucket = queueAcc[callQueue];
    if (inUserRange) {
      bucket.totalCalls    += totalCalls;
      bucket.totalAnswered += totalAnswered;
      bucket.abandoned     += abandoned;
      // longestWait: MAX across days. avgAnswer: mean across days
      // with non-zero values (matches legacy buildTable4 semantics).
      if (longestWaitSec > bucket.longestWaitSec) bucket.longestWaitSec = longestWaitSec;
      if (avgAnswerSec > 0 && totalAnswered > 0) {
        bucket.avgAnswerWeightedSum += avgAnswerSec * totalAnswered;
        bucket.avgAnswerWeightedN   += totalAnswered;
      }
      bucket.violations += violations;
      if (violations > 0) bucket.violationDates.push(dateIso);
      // Per-queue daily accumulator for multi-line chart.
      let qDay = bucket.daily[dateIso];
      if (!qDay) {
        qDay = { totalCalls: 0, totalAnswered: 0, abandoned: 0, violations: 0 };
        bucket.daily[dateIso] = qDay;
      }
      qDay.totalCalls    += totalCalls;
      qDay.totalAnswered += totalAnswered;
      qDay.abandoned     += abandoned;
      qDay.violations    += violations;
      // Dept-level daily series (rollup across all queues).
      let dayBucket = dailyAcc[dateIso];
      if (!dayBucket) {
        dayBucket = { totalCalls: 0, totalAnswered: 0, abandoned: 0, violations: 0 };
        dailyAcc[dateIso] = dayBucket;
      }
      dayBucket.totalCalls    += totalCalls;
      dayBucket.totalAnswered += totalAnswered;
      dayBucket.abandoned     += abandoned;
      dayBucket.violations    += violations;
    }
    if (inTrendRange) {
      const monthKey = dateIso.slice(0, 7);
      let mb = bucket.monthly[monthKey];
      if (!mb) {
        mb = { totalCalls: 0, totalAnswered: 0, abandoned: 0, violations: 0 };
        bucket.monthly[monthKey] = mb;
      }
      mb.totalCalls    += totalCalls;
      mb.totalAnswered += totalAnswered;
      mb.abandoned     += abandoned;
      mb.violations    += violations;
    }
  }

  // Per-queue rows in DEPT_QCD_QUEUES order.
  const queueBreakdown = queues.map(function (q) {
    const b = queueAcc[q];
    const pct = b.totalCalls > 0 ? (b.abandoned / b.totalCalls) * 100 : 0;
    return {
      queue:            q,
      totalCalls:       b.totalCalls,
      totalAnswered:    b.totalAnswered,
      abandoned:        b.abandoned,
      abandonedPct:     pct,
      abandonedPctStr:  pct.toFixed(2) + '%',
      longestWait:      formatSecondsHms_(b.longestWaitSec),
      longestWaitSec:   b.longestWaitSec,
      avgAnswer:        formatSecondsHms_(b.avgAnswerWeightedN > 0
                          ? Math.round(b.avgAnswerWeightedSum / b.avgAnswerWeightedN) : 0),
      avgAnswerSec:     b.avgAnswerWeightedN > 0 ? Math.round(b.avgAnswerWeightedSum / b.avgAnswerWeightedN) : 0,
      violations:       b.violations,
      violationDates:   b.violationDates.sort(),
    };
  });

  // Dept totals: sum across all queues for the dept.
  // Avg answer uses volume-weighted averaging (weight by totalAnswered
  // per queue) so high-volume queues dominate the dept average.
  let tTotal = 0, tAns = 0, tAbnd = 0;
  let tLongest = 0;
  let tAvgWSum = 0, tAvgWN = 0;
  queueBreakdown.forEach(function (r) {
    tTotal += r.totalCalls;
    tAns   += r.totalAnswered;
    tAbnd  += r.abandoned;
    if (r.longestWaitSec > tLongest) tLongest = r.longestWaitSec;
    if (r.avgAnswerSec > 0 && r.totalAnswered > 0) {
      tAvgWSum += r.avgAnswerSec * r.totalAnswered;
      tAvgWN   += r.totalAnswered;
    }
  });
  const tPct = tTotal > 0 ? (tAbnd / tTotal) * 100 : 0;
  // Violations on the totals row: month-to-date, NOT selected-range
  // sum. Operationally more useful ("how many bad days has my dept
  // had this month?") and matches the "Violations (current month)"
  // label on the KPI tile. Range-scoped violations are still
  // available per-queue in queueBreakdown[].violations.
  const violationsMtd = computeMtdViolations_(dept, values, ssTZ, qOpts);
  const totals = {
    totalCalls:       tTotal,
    totalAnswered:    tAns,
    abandoned:        tAbnd,
    abandonedPct:     tPct,
    abandonedPctStr:  tPct.toFixed(2) + '%',
    longestWait:      formatSecondsHms_(tLongest),
    avgAnswer:        formatSecondsHms_(tAvgWN > 0 ? Math.round(tAvgWSum / tAvgWN) : 0),
    violations:       violationsMtd,
  };

  // Trend chart series: roll up across all dept queues per month.
  const trendLabels = monthKeys.map(function (m) {
    const parts = m.split('-');
    const d = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
    return Utilities.formatDate(d, TZ, 'MMM, yy');
  });
  const trendSeries = monthKeys.map(function (m) {
    let total = 0, ans = 0, abnd = 0, viol = 0;
    queues.forEach(function (q) {
      const b = queueAcc[q].monthly[m];
      if (!b) return;
      total += b.totalCalls;
      ans   += b.totalAnswered;
      abnd  += b.abandoned;
      viol  += b.violations;
    });
    const pct = total > 0 ? (abnd / total) * 100 : 0;
    return {
      totalCalls:    total,
      totalAnswered: ans,
      abandoned:     abnd,
      abandonedPct:  pct,
      violations:    viol,
    };
  });

  // Daily series for the selected user range (chart "Daily" view +
  // the scrollable daily table). Sorted oldest-first for chart
  // continuity; the table can re-sort newest-first client-side.
  const dailySeries = Object.keys(dailyAcc).sort().map(function (iso) {
    const b = dailyAcc[iso];
    const pct = b.totalCalls > 0 ? (b.abandoned / b.totalCalls) * 100 : 0;
    return {
      date:             iso,
      totalCalls:       b.totalCalls,
      totalAnswered:    b.totalAnswered,
      abandoned:        b.abandoned,
      abandonedPct:     pct,
      abandonedPctStr:  pct.toFixed(2) + '%',
      violations:       b.violations,
    };
  });

  // Per-queue series for multi-line charts. Each queue gets its own
  // monthly and daily arrays keyed on the same label sets as the
  // dept-level data so Chart.js can overlay them.
  const allDailyDates = Object.keys(dailyAcc).sort();
  const perQueue = {};
  queues.forEach(function (q) {
    var acc = queueAcc[q];
    perQueue[q] = {
      monthly: monthKeys.map(function (m) {
        var b = acc.monthly[m];
        if (!b) return { totalCalls: 0, totalAnswered: 0, abandoned: 0, abandonedPct: 0, violations: 0 };
        var pct = b.totalCalls > 0 ? (b.abandoned / b.totalCalls) * 100 : 0;
        return { totalCalls: b.totalCalls, totalAnswered: b.totalAnswered, abandoned: b.abandoned, abandonedPct: pct, violations: b.violations };
      }),
      daily: allDailyDates.map(function (iso) {
        var d = acc.daily[iso];
        if (!d) return { date: iso, totalCalls: 0, totalAnswered: 0, abandoned: 0, abandonedPct: 0, violations: 0 };
        var pct = d.totalCalls > 0 ? (d.abandoned / d.totalCalls) * 100 : 0;
        return { date: iso, totalCalls: d.totalCalls, totalAnswered: d.totalAnswered, abandoned: d.abandoned, abandonedPct: pct, violations: d.violations };
      }),
    };
  });

  const fmt = function (d) { return Utilities.formatDate(d, TZ, 'MMM d, yyyy'); };
  const dateLabel = fmt(startDate) + ' - ' + fmt(endDate);

  return {
    meta: {
      department: dept,
      from: from, to: to,
      trendStart: trendStartIso,
      trendEnd:   trendEndIso,
      queues:     queues,
      unmapped:   false,
      includeSubQueues: includeSubQueues !== false,
      hasSubQueues:     deptHasSubQueues_(dept),
      generatedAt: new Date().toISOString(),
    },
    dateLabel:       dateLabel,
    totals:          totals,
    queueBreakdown:  queueBreakdown,
    trendData:       { labels: trendLabels, series: trendSeries, perQueue: perQueue },
    dailySeries:     dailySeries,
    perQueue:        perQueue,
  };
}

function emptyQcdReport_(dept, from, to, includeSubQueues) {
  const queues = queuesForDept_(dept, { includeChildren: includeSubQueues !== false });
  // Match the populated-path response shape (F5): the populated report
  // always carries a top-level `perQueue` map (queue -> { monthly, daily })
  // and `trendData.perQueue`. The client's multi-queue chart init reads
  // those, so the empty/no-data path must ship the same keys (with empty
  // arrays) rather than omit them -- otherwise a multi-queue dept on a
  // no-data day throws on `data.perQueue[...]` / `trendData.perQueue`.
  const perQueueEmpty = {};
  queues.forEach(function (q) { perQueueEmpty[q] = { monthly: [], daily: [] }; });
  return {
    meta: {
      department: dept,
      from: from, to: to,
      trendStart: from, trendEnd: to,
      queues:     queues,
      unmapped:   queues.length === 0,
      includeSubQueues: includeSubQueues !== false,
      hasSubQueues:     deptHasSubQueues_(dept),
      generatedAt: new Date().toISOString(),
    },
    dateLabel: from + ' - ' + to,
    totals: {
      totalCalls: 0, totalAnswered: 0, abandoned: 0,
      abandonedPct: 0, abandonedPctStr: '0.00%',
      longestWait: '0:00:00', avgAnswer: '0:00:00', violations: 0,
    },
    queueBreakdown: queues.map(function (q) {
      return {
        queue: q,
        totalCalls: 0, totalAnswered: 0, abandoned: 0,
        abandonedPct: 0, abandonedPctStr: '0.00%',
        longestWait: '0:00:00', longestWaitSec: 0,
        avgAnswer: '0:00:00', avgAnswerSec: 0, violations: 0,
      };
    }),
    trendData: { labels: [], series: [], perQueue: perQueueEmpty },
    dailySeries: [],
    perQueue: perQueueEmpty,
  };
}

/**
 * Emails the captured QCD Report PNG to the active user. Same
 * pattern as Individual / Performance / Compare Ranges email
 * exports.
 */
function sendQcdReportEmail(req) {
  const email = Session.getActiveUser().getEmail();
  const user = resolveUser_(email);
  if (user.role === 'none') throw new Error('Not authorized.');

  const dataUrl = String((req && req.imageBase64) || '');
  const dateLabel = String((req && req.dateLabel) || 'QCD Report');
  if (!dataUrl) throw new Error('No image payload.');
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) throw new Error('Malformed image payload.');
  const decoded = Utilities.base64Decode(dataUrl.slice(commaIdx + 1));
  const blob = Utilities.newBlob(decoded, 'image/png', 'QCD_Report.png');

  MailApp.sendEmail({
    to: email,
    subject: 'QCD Report: ' + dateLabel,
    htmlBody:
      '<div style="font-family: sans-serif; color: #444; margin-bottom: 20px;">'
      + 'Here is the visual snapshot of the QCD report (queue / call '
      + 'detail metrics: Total Calls, Abandoned %, Violations, etc.).'
      + '</div>'
      + '<div style="text-align: center; border: 1px solid #eee; padding: 10px;">'
      + '<img src="cid:reportImg" style="width:100%; max-width:1200px; height:auto;">'
      + '</div>',
    inlineImages: { reportImg: blob },
  });
  return { to: email };
}

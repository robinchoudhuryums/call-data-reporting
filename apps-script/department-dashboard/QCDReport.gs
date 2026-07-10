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
 * RETIRED AS A STANDALONE REPORT (QCD->Insights consolidation): the
 * QCD tab/modal and its endpoints (getQcdReport / getQcdReportInit /
 * sendQcdReportEmail, cache prefix `qcd:`) were deleted; the Insights
 * report's Queue health section is the replacement (a data-superset --
 * same computeQcdReport_ underneath). `#/report/qcd` deep-links now
 * land on Insights.
 *
 * Still served from this file:
 *   getQcdAllDepartments({ from, to }) -- the company-wide flat daily
 *     report (any signed-in manager/admin), cache `qcdAll:`.
 *   computeQcdReport_ / queuesForDept_ / qcdSubQueueTags_ /
 *     computeMtdViolations_ -- consumed by Insights Queue health,
 *     the Overview tile snapshots (CompanyOverview.gs), and the My
 *     Department snapshot (Data.gs).
 *
 * IMPORTANT: QCD Historical Data's `callQueue` column (col D) carries
 * raw queue names like "A_Q_CustomerSuccess", "A_Q_Sales", "Backup CSR"
 * -- NOT dashboard dept names. To filter QCD rows for a dashboard dept,
 * use Config.gs::DEPT_QCD_QUEUES[dept] (admin-curated map of dept name
 * to list of queue names). A dept not in that map renders an empty QCD
 * modal with a "No queues mapped" hint.
 */


// All-departments daily report (4b): admin-only, company-wide flat
// queue table reproducing the legacy emailed "Daily Call Queue Report"
// PDF. Cached per (from, to) under its own prefix so it doesn't collide
// with the per-dept qcd: keys. Bump on any aggregation-shape change.
// v2: queue rows gain bySource (per-call-source breakdown) + violationDates
//     for the expandable per-queue detail in the all-dept report.
// v3: (#3) sub-queue nesting -- `parent` per dept + raw longestWaitSec /
//     avgAnswerSec per queue (so the client computes a combined section
//     total) -- plus roll-up queues (Intake / Backup CSR) excluded as
//     double-counts.
// v4: merge bump -- two branches shipped different shapes under v3
//     (F-36: double-mapped queues counted once in the grand total; #3:
//     sub-queue nesting w/ parent + raw longestWaitSec/avgAnswerSec +
//     roll-up exclusions). The merged payload carries BOTH; the 6h TTL
//     makes a stale-shape blob too sticky to risk.
const QCD_ALLDEPT_CACHE_PREFIX = 'qcdAll:v4';

// #3: queues excluded from the all-dept Daily Call Queue Report because their
// calls are ALREADY counted within another queue (Intake / Backup CSR roll
// into A_Q_CustomerSuccess), so listing them separately double-counts. Matched
// case-insensitively against the QCD Call Queue name. Scoped to this report
// only (the per-dept QCD modal / Insights are unchanged).
const QCD_ALLDEPT_EXCLUDE_QUEUES = ['A_Q_Intake', 'Backup CSR'];

// Source filter: only the "Total Calls" callSource row carries the
// daily aggregate we want; other callSource values are sub-counts
// (CSR / Ad-campaign / etc. -- routing origin breakdowns) that
// would double-count if summed alongside Total Calls. Pin here so
// label-sheet drift doesn't change behavior.
const QCD_TOTAL_CALLS_SOURCE = 'Total Calls';

// All-dept report TTL: 6h (CacheService's max) instead of the 30-min
// REPORT_CACHE_TTL_SECONDS. QCD data lands once per day (morning ingest),
// so a warmed yesterday-blob can legitimately serve all day; the trade-off
// is that a rare mid-day force re-import's corrections can lag here up to
// 6h (vs 30 min elsewhere). Paired with the CacheWarm qcdAll warm
// (CacheWarm.gs), which only fires once QCD data for yesterday exists.
const QCD_ALLDEPT_CACHE_TTL_SECONDS = 21600;

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

/**
 * All-departments daily queue report (4b) -- admin-only, company-wide.
 *
 * Reproduces the legacy emailed "Daily Call Queue Report" PDF: one flat
 * table across EVERY mapped department, each dept's own queues listed
 * with Total / Answered / Abandoned / Abandoned % / Longest / Avg ans /
 * Violations, plus a per-dept subtotal and a company grand-total row.
 * Surfaced on the Overview page (admin-only) with CSV + print.
 *
 * Scope: each dept's OWN queues only (queuesForDept_ includeChildren=false)
 * so a child sub-queue appears under its own dept exactly once and there's
 * no parent+child double count. A queue double-mapped across two depts'
 * DEPT_QCD_QUEUES (the M2 case) intentionally appears under both -- this is
 * a flat per-queue listing, not a de-duped rollup.
 *
 * Everything here is RANGE-scoped (unlike the per-dept report's MTD
 * violations tile) so the flat table is internally consistent: dept
 * subtotals and the grand total are summed from the range-scoped
 * queueBreakdown rows. Depts with zero activity in the range are omitted.
 *
 * getQcdAllDepartments({ from, to }) -> { meta, dateLabel, depts:[{dept,
 *   totals, queues:[...]}], grandTotals }
 */
function getQcdAllDepartments(req) {
  // Company-wide view, opened to managers (owner decision): any signed-in
  // manager/admin may read it. It's a read-only company snapshot with no
  // per-dept scoping (every manager sees every dept), so the only gate is
  // "not an unmapped visitor". (Was assertAdmin_.)
  const _user = resolveUser_(Session.getActiveUser().getEmail());
  if (!_user || _user.role === 'none') throw new Error('Not authorized.');

  const from = String((req && req.from) || '').trim();
  const to   = String((req && req.to)   || '').trim();
  if (!isIsoDate_(from) || !isIsoDate_(to)) {
    throw new Error('from/to must be YYYY-MM-DD.');
  }
  if (from > to) throw new Error('from must be on or before to.');

  const cache = CacheService.getScriptCache();
  const cacheKey = QCD_ALLDEPT_CACHE_PREFIX + ':' + from + ':' + to;
  const cached = cache.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      parsed.meta.cacheHit = true;
      return parsed;
    } catch (e) { /* recompute */ }
  }

  const t0 = Date.now();
  const allDepts = getAllDepartments_();
  const depts = [];
  // Parent map for the client to nest sub-queue depts under their parent's
  // banner (#3): Spanish -> CSR, PAK -> Power, PAP -> Sales, etc.
  const parentMap = (typeof getOverviewParentMap_ === 'function') ? getOverviewParentMap_() : {};
  // Case-insensitive exclusion set (Intake / Backup CSR -- double-counts).
  const excludeSet = {};
  QCD_ALLDEPT_EXCLUDE_QUEUES.forEach(function (q) { excludeSet[String(q).toLowerCase()] = true; });

  // Company grand totals (range-scoped; longest = MAX, avg = volume-weighted).
  let gTotal = 0, gAns = 0, gAbnd = 0, gLongest = 0, gAvgWSum = 0, gAvgWN = 0, gViol = 0;
  const gSeenQueues = {};   // F-36: dedupe double-mapped queues in the grand total

  allDepts.forEach(function (dept) {
    // Own queues only -- children listed under their own dept.
    if (queuesForDept_(dept, { includeChildren: false }).length === 0) return;
    const rep = computeQcdReport_(dept, from, to,
                                  /*includeSubQueues=*/ false,
                                  /*separateSubQueues=*/ false);
    // #3: drop roll-up queues already counted within another queue.
    const rows = (rep.queueBreakdown || []).filter(function (r) {
      return !excludeSet[String(r.queue || '').toLowerCase()];
    });

    let dTotal = 0, dAns = 0, dAbnd = 0, dLongest = 0, dAvgWSum = 0, dAvgWN = 0, dViol = 0;
    rows.forEach(function (r) {
      dTotal += r.totalCalls; dAns += r.totalAnswered; dAbnd += r.abandoned;
      if (r.longestWaitSec > dLongest) dLongest = r.longestWaitSec;
      if (r.avgAnswerSec > 0 && r.totalAnswered > 0) {
        dAvgWSum += r.avgAnswerSec * r.totalAnswered;
        dAvgWN   += r.totalAnswered;
      }
      dViol += (Number(r.violations) || 0);
    });
    if (dTotal === 0) return;   // no activity in range: omit (legacy lists active queues)

    const dPct = dTotal > 0 ? (dAbnd / dTotal) * 100 : 0;
    depts.push({
      dept: dept,
      parent: parentMap[dept] || null,   // #3: client nests children under this
      totals: {
        totalCalls:      dTotal,
        totalAnswered:   dAns,
        abandoned:       dAbnd,
        abandonedPct:    dPct,
        abandonedPctStr: dPct.toFixed(2) + '%',
        longestWait:     formatSecondsHms_(dLongest),
        avgAnswer:       formatSecondsHms_(dAvgWN > 0 ? Math.round(dAvgWSum / dAvgWN) : 0),
        violations:      dViol,
      },
      queues: rows.map(function (r) {
        return {
          queue:           r.queue,
          totalCalls:      r.totalCalls,
          totalAnswered:   r.totalAnswered,
          abandoned:       r.abandoned,
          abandonedPct:    r.abandonedPct,
          abandonedPctStr: r.abandonedPctStr,
          longestWait:     r.longestWait,
          avgAnswer:       r.avgAnswer,
          // Raw seconds so the client can compute a combined (parent+children)
          // section total's max-longest / volume-weighted-avg (#3).
          longestWaitSec:  Number(r.longestWaitSec) || 0,
          avgAnswerSec:    Number(r.avgAnswerSec) || 0,
          violations:      r.violations,
          // Per-queue call-source breakdown (data-driven -- each queue shows
          // its own actual sources) + violation dates, for the expandable
          // per-queue detail in the all-dept report.
          bySource:        r.bySource || [],
          violationDates:  r.violationDates || [],
        };
      }),
    });

    // F-36: a queue (mis)configured into TWO depts' DEPT_QCD_QUEUES lists
    // intentionally appears under BOTH dept sections (per-dept view, the M2
    // Overview decision) -- but the COMPANY grand total must count each
    // queue's calls exactly once, so accumulate from unique queue names
    // rather than summing dept subtotals.
    rows.forEach(function (r) {
      if (gSeenQueues[r.queue]) return;
      gSeenQueues[r.queue] = true;
      gTotal += r.totalCalls; gAns += r.totalAnswered; gAbnd += r.abandoned;
      if (r.longestWaitSec > gLongest) gLongest = r.longestWaitSec;
      if (r.avgAnswerSec > 0 && r.totalAnswered > 0) {
        gAvgWSum += r.avgAnswerSec * r.totalAnswered;
        gAvgWN   += r.totalAnswered;
      }
      gViol += (Number(r.violations) || 0);
    });
  });

  depts.sort(function (a, b) { return a.dept < b.dept ? -1 : (a.dept > b.dept ? 1 : 0); });

  const gPct = gTotal > 0 ? (gAbnd / gTotal) * 100 : 0;
  const grandTotals = {
    totalCalls:      gTotal,
    totalAnswered:   gAns,
    abandoned:       gAbnd,
    abandonedPct:    gPct,
    abandonedPctStr: gPct.toFixed(2) + '%',
    longestWait:     formatSecondsHms_(gLongest),
    avgAnswer:       formatSecondsHms_(gAvgWN > 0 ? Math.round(gAvgWSum / gAvgWN) : 0),
    violations:      gViol,
  };

  const parseIso_ = function (iso) {
    const p = iso.split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12);
  };
  const fmt = function (d) { return Utilities.formatDate(d, TZ, 'MMM d, yyyy'); };
  const dateLabel = fmt(parseIso_(from)) + ' - ' + fmt(parseIso_(to));

  const data = {
    meta:        { from: from, to: to, cacheHit: false, computeMs: Date.now() - t0, deptCount: depts.length },
    dateLabel:   dateLabel,
    depts:       depts,
    grandTotals: grandTotals,
  };

  const json = JSON.stringify(data);
  if (json.length <= 100000) {
    try { cache.put(cacheKey, json, QCD_ALLDEPT_CACHE_TTL_SECONDS); }
    catch (e) { Logger.log('QCD all-dept cache put failed: %s', e); }
  }
  return data;
}

/**
 * Tags for sub-queue separation: which queues are the dept's OWN
 * (vs. inherited from child sub-queues per OVERVIEW_PARENT_OF) and the
 * child dept that owns each inherited queue. Mirrors the logic in
 * Data.gs::computeDeptQcdSnapshot_ so all QCD surfaces tag consistently.
 */
function qcdSubQueueTags_(dept) {
  const ownSet = {};
  queuesForDept_(dept, { includeChildren: false }).forEach(function (q) { ownSet[q] = true; });
  const queueOwner = {};
  const parentMap = (typeof getOverviewParentMap_ === 'function') ? getOverviewParentMap_() : {};
  Object.keys(parentMap).forEach(function (child) {
    if (parentMap[child] !== dept) return;
    getDeptQcdQueues_(child).forEach(function (q) { if (!ownSet[q]) queueOwner[q] = child; });
  });
  return { ownSet: ownSet, queueOwner: queueOwner };
}

// Per-EXECUTION memo of the full QCD Historical Data read (values +
// displays + spreadsheet TZ). getQcdAllDepartments calls computeQcdReport_
// once per mapped dept, and Insights' Queue health calls it twice (current
// + prior window) -- each call used to re-read the WHOLE sheet (2 range
// RPCs), so the all-dept report cost ~2 reads x N depts. One execution =
// one snapshot; Apps Script globals reset per request (the
// DEPT_CONFIG_ROWS_MEMO_ pattern), so this can never serve stale data
// across requests. Tests that reinstall the fake spreadsheet reset it
// (h.ctx.QCD_SHEET_DATA_MEMO_ = null), like the Dept Config memo.
var QCD_SHEET_DATA_MEMO_ = null;

function readQcdSheetData_() {
  if (QCD_SHEET_DATA_MEMO_) return QCD_SHEET_DATA_MEMO_;
  const ss = openSpreadsheet_();
  const sheet = ss.getSheetByName('QCD Historical Data');
  if (!sheet) {
    QCD_SHEET_DATA_MEMO_ = { missing: true };
    return QCD_SHEET_DATA_MEMO_;
  }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    QCD_SHEET_DATA_MEMO_ = { empty: true, ssTZ: ss.getSpreadsheetTimeZone() };
    return QCD_SHEET_DATA_MEMO_;
  }
  // Read all 12 cols. Display values for the H:MM:SS time fields
  // (longestWait / avgAnswer); raw values for everything else.
  const range = sheet.getRange(2, 1, lastRow - 1, 12);
  QCD_SHEET_DATA_MEMO_ = {
    values:   range.getValues(),
    displays: range.getDisplayValues(),
    ssTZ:     ss.getSpreadsheetTimeZone(),
  };
  return QCD_SHEET_DATA_MEMO_;
}

function computeQcdReport_(dept, from, to, includeSubQueues, separateSubQueues) {
  const qOpts = { includeChildren: includeSubQueues !== false };
  // separateSubQueues (QCD report only): children stay visible in the
  // breakdown/chart but are tagged + EXCLUDED from the dept total, the
  // dept-total daily/trend series, and the MTD violation count. Insights'
  // Queue-health calls omit this, so their behavior is byte-identical.
  const separate = !!separateSubQueues;
  const tags = separate ? qcdSubQueueTags_(dept) : { ownSet: {}, queueOwner: {} };
  const isOwn = function (q) { return !separate || !!tags.ownSet[q]; };
  const sheetData = readQcdSheetData_();
  if (sheetData.missing) {
    throw new Error('Sheet "QCD Historical Data" not found. Verify the pipeline has run at least once for this dept.');
  }
  if (sheetData.empty) {
    return emptyQcdReport_(dept, from, to, includeSubQueues, separate);
  }
  const ssTZ = sheetData.ssTZ;

  // Dept -> queue names. Empty = this dept isn't mapped in
  // DEPT_QCD_QUEUES; return the empty shape so the modal shows
  // "No queues mapped" instead of throwing.
  const queues = queuesForDept_(dept, qOpts);
  if (queues.length === 0) {
    const empty = emptyQcdReport_(dept, from, to, includeSubQueues, separate);
    empty.meta.unmapped = true;
    return empty;
  }
  const queueSet = {};
  queues.forEach(function (q) { queueSet[q] = true; });

  const values   = sheetData.values;
  const displays = sheetData.displays;

  // Trend window: same logic as Individual / Performance Reports
  // (12-mo monthly buckets unless range > 366 days or full year).
  const parseIso_ = function (iso) {
    const p = iso.split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12);
  };
  const startDate = parseIso_(from);
  const endDate   = parseIso_(to);
  // Trend window resolution (INV-29; shared helper in Util.gs keeps the
  // IR/PR/Insights/QCD 12-month trend axes aligned).
  const trendStartDate = computeTrendStartDate_(startDate, endDate);
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
      bySource:            {},   // 4a: source name -> { totalCalls, totalAnswered, abandoned, longestWaitSec, avgAnswerWeightedSum/N, violations } (selected range)
    };
  });
  // Daily series: keyed iso date. Summed across all dept queues
  // per day. Only populated for dates in the selected user range
  // (the trend window's larger daily series would be too dense
  // for the chart and table to be useful).
  const dailyAcc = {};
  const dailyDateSet = {};   // F-15: union of ALL queues' active dates (axis)   // iso -> { totalCalls, answered, abandoned, violations }

  for (let i = 0; i < values.length; i++) {
    const r  = values[i];
    const rd = displays[i];
    const dateIso = rowDateIso_(r[QCD_HISTORICAL_COLS.DATE - 1], ssTZ);
    if (!dateIso) continue;
    const callQueue = String(r[QCD_HISTORICAL_COLS.CALL_QUEUE - 1] || '').trim();
    if (!queueSet[callQueue]) continue;
    const source = String(r[QCD_HISTORICAL_COLS.CALL_SOURCE - 1] || '').trim();

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

    // 4a: per-call-source breakdown -- accumulate EVERY source (CSR,
    // Ad-campaign, New Call Menu, Non-CSR (internal), ... plus the
    // 'Total Calls' roll-up shown as "Overall") within the user range,
    // so a queue row can expand into its source sub-rows like the legacy
    // emailed Department Call Queue Report. Same per-field math as the
    // queue totals (longestWait MAX, avgAnswer volume-weighted).
    if (inUserRange && source) {
      const sb = bucket.bySource[source] || (bucket.bySource[source] = {
        totalCalls: 0, totalAnswered: 0, abandoned: 0,
        longestWaitSec: 0, avgAnswerWeightedSum: 0, avgAnswerWeightedN: 0, violations: 0,
      });
      sb.totalCalls    += totalCalls;
      sb.totalAnswered += totalAnswered;
      sb.abandoned     += abandoned;
      if (longestWaitSec > sb.longestWaitSec) sb.longestWaitSec = longestWaitSec;
      if (avgAnswerSec > 0 && totalAnswered > 0) {
        sb.avgAnswerWeightedSum += avgAnswerSec * totalAnswered;
        sb.avgAnswerWeightedN   += totalAnswered;
      }
      sb.violations += violations;
    }

    if (source !== QCD_TOTAL_CALLS_SOURCE) continue;   // dept totals/trend/daily are Total-Calls only

    if (inUserRange) {
      bucket.totalCalls    += totalCalls;
      bucket.totalAnswered += totalAnswered;
      bucket.abandoned     += abandoned;
      // longestWait: MAX across days. avgAnswer: answered-volume-WEIGHTED
      // mean (sum(avgAnswer*answered)/sum(answered)). NOTE (RPT-8): this
      // diverges from the legacy buildTable4 day-mean the comment previously
      // claimed parity with -- code is spec pending owner ratification.
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
      // F-15: the daily DATE AXIS covers every in-range row (own + sub
      // queues). It was previously derived from dailyAcc (own rows only),
      // so a date where ONLY a sub-queue had calls silently vanished from
      // the sub-queue's daily chart line (and from Insights' inherited
      // queueHealth.trend daily series).
      dailyDateSet[dateIso] = true;
      // Dept-level daily series. With separateSubQueues, the "Dept total"
      // is the parent's OWN queues only -- children render as their own
      // per-queue lines (perQueue) and are never folded into this rollup.
      if (isOwn(callQueue)) {
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
    const row = {
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
    // 4a: per-call-source rows for the expandable breakdown. The 'Total
    // Calls' roll-up renders first as "Overall"; sub-sources follow by
    // volume desc (matches the legacy emailed report's row order).
    row.bySource = Object.keys(b.bySource).map(function (src) {
      const s = b.bySource[src];
      const sp = s.totalCalls > 0 ? (s.abandoned / s.totalCalls) * 100 : 0;
      return {
        source:          (src === QCD_TOTAL_CALLS_SOURCE) ? 'Overall' : src,
        isOverall:       (src === QCD_TOTAL_CALLS_SOURCE),
        totalCalls:      s.totalCalls,
        totalAnswered:   s.totalAnswered,
        abandoned:       s.abandoned,
        abandonedPct:    sp,
        abandonedPctStr: sp.toFixed(2) + '%',
        longestWait:     formatSecondsHms_(s.longestWaitSec),
        avgAnswer:       formatSecondsHms_(s.avgAnswerWeightedN > 0
                           ? Math.round(s.avgAnswerWeightedSum / s.avgAnswerWeightedN) : 0),
        violations:      s.violations,
      };
    }).sort(function (a, bb) {
      if (a.isOverall !== bb.isOverall) return a.isOverall ? -1 : 1;
      return bb.totalCalls - a.totalCalls;
    });
    // separateSubQueues: tag child-owned queues so the client renders them
    // in a separate group and excludes them from the dept total. Own queues
    // (and the Insights path) carry subDept=null.
    if (separate) row.subDept = tags.queueOwner[q] || null;
    return row;
  });

  // Dept totals: sum across the dept's OWN queues (with separateSubQueues,
  // child sub-queues are excluded -- they have their own rows/lines and are
  // never merged into the parent aggregate). Avg answer uses volume-weighted
  // averaging (weight by totalAnswered per queue).
  let tTotal = 0, tAns = 0, tAbnd = 0;
  let tLongest = 0;
  let tAvgWSum = 0, tAvgWN = 0;
  queueBreakdown.forEach(function (r) {
    if (separate && r.subDept) return;   // child sub-queue: excluded from the dept total
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
  const violationsMtd = computeMtdViolations_(dept, values, ssTZ,
    separate ? { includeChildren: false } : qOpts);
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
  // Dept-total trend line: own queues only when separating (children are
  // separate per-queue lines via trendData.perQueue).
  const trendQueues = separate ? queues.filter(isOwn) : queues;
  const trendSeries = monthKeys.map(function (m) {
    let total = 0, ans = 0, abnd = 0, viol = 0;
    trendQueues.forEach(function (q) {
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
  const dailySeries = Object.keys(dailyDateSet).sort().map(function (iso) {
    // F-15: a date with only sub-queue activity zero-fills the dept-total
    // row (the dept's OWN queues genuinely had no calls that day).
    const b = dailyAcc[iso] || { totalCalls: 0, totalAnswered: 0, abandoned: 0, violations: 0 };
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
  const allDailyDates = Object.keys(dailyDateSet).sort();   // F-15: all queues' dates
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
      subQueuesSeparated: separate,
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

function emptyQcdReport_(dept, from, to, includeSubQueues, separateSubQueues) {
  const queues = queuesForDept_(dept, { includeChildren: includeSubQueues !== false });
  // F-37: mirror the populated shape's sub-queue tagging so the client's
  // separated rendering doesn't regress on a no-data day (the exact
  // empty-vs-populated drift class the F5/v6 bump fixed before).
  const separate = !!separateSubQueues;
  const tags = separate ? qcdSubQueueTags_(dept) : { ownSet: {}, queueOwner: {} };
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
      subQueuesSeparated: separate,   // F-37: populated-shape parity
      generatedAt: new Date().toISOString(),
    },
    dateLabel: from + ' - ' + to,
    totals: {
      totalCalls: 0, totalAnswered: 0, abandoned: 0,
      abandonedPct: 0, abandonedPctStr: '0.00%',
      longestWait: '0:00:00', avgAnswer: '0:00:00', violations: 0,
    },
    queueBreakdown: queues.map(function (q) {
      const row = {
        queue: q,
        totalCalls: 0, totalAnswered: 0, abandoned: 0,
        abandonedPct: 0, abandonedPctStr: '0.00%',
        longestWait: '0:00:00', longestWaitSec: 0,
        avgAnswer: '0:00:00', avgAnswerSec: 0, violations: 0,
        bySource: [],
        violationDates: [],   // F-37: populated rows always carry this
      };
      if (separate) row.subDept = tags.queueOwner[q] || null;   // F-37
      return row;
    }),
    trendData: { labels: [], series: [], perQueue: perQueueEmpty },
    dailySeries: [],
    perQueue: perQueueEmpty,
  };
}


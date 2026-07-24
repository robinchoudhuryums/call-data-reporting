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
const QCD_ALLDEPT_CACHE_PREFIX = 'qcdAll:v5';

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

  const res = qcdAllDeptCachedData_(from, to);
  // RPT-10: the INV-01 telemetry carve-out. 'ALL' because the report has no
  // dept dimension. Logged here (the RPC boundary) with the real cacheHit.
  logReportUsage_('qcdAllDept', 'ALL', _user, res.cacheHit);
  return res.data;
}

/**
 * The cache-checked all-departments QCD compute, shared by the RPC
 * (getQcdAllDepartments) AND the automated email (QueueReportEmail.gs's
 * preview + trigger sends). Batch 1 item 2: the email path used to call the
 * pure computeQcdAllDepartments_ directly, so an admin "Send me a preview"
 * paid the full cold compute (~minutes) even when the web report had just
 * warmed the exact (from,to) blob. Routing both through this helper means the
 * preview reuses the 6h-TTL qcdAll cache -- and, conversely, a preview warms
 * it for the next web open. Returns { data, cacheHit }; NO auth / usage log
 * (those stay with the RPC so a trigger-context send has no Session to feed).
 */
function qcdAllDeptCachedData_(from, to) {
  const cache = CacheService.getScriptCache();
  // CORE-3 pattern: suffix the (6h-TTL) all-dept key with the active QCD read
  // source so flipping QCD_READ_SOURCE can't serve a cross-source blob for the
  // TTL. (The shorter-TTL report caches that embed QCD -- insights/summary/
  // companyOverview, 30min -- are parity-gated and self-heal within the TTL.)
  const qcdSrc = (typeof getQcdReadSource_ === 'function') ? getQcdReadSource_() : 'sheet';
  const cacheKey = QCD_ALLDEPT_CACHE_PREFIX + ':' + from + ':' + to + ':' + qcdSrc;
  const cached = cache.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed && parsed.meta) parsed.meta.cacheHit = true;
      return { data: parsed, cacheHit: true };
    } catch (e) { /* recompute */ }
  }
  const data = computeQcdAllDepartments_(from, to);
  const json = JSON.stringify(data);
  // R8-C4: a failed Dept Config read means the dept->queue maps may be
  // constant-only this request -- and this cache's 6h TTL makes pinning
  // that especially costly. Serve uncached; the next request re-reads.
  const cfgFailed = (typeof deptConfigReadFailed_ === 'function' && deptConfigReadFailed_());
  if (json.length <= 100000 && !cfgFailed) {
    try { cache.put(cacheKey, json, QCD_ALLDEPT_CACHE_TTL_SECONDS); }
    catch (e) { Logger.log('QCD all-dept cache put failed: %s', e); }
  } else if (cfgFailed) {
    Logger.log('qcdAllDeptCachedData_: Dept Config read errored -- skipping cache put.');
  }
  return { data: data, cacheHit: false };
}

// Pure all-departments QCD compute (no auth / cache / usage log), split out so
// the automated Daily Call Queue Report email (QueueReportEmail.gs) can reuse
// the EXACT report compute in a trigger context, which has no Session user to
// feed getQcdAllDepartments' auth gate (the computeDigestStats_ convention).
function computeQcdAllDepartments_(from, to) {
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
  let gTotal = 0, gAns = 0, gAbnd = 0, gLongest = 0, gAvgWSum = 0, gAvgWN = 0, gViol = 0, gViolMtd = 0;
  // R12-24 (owner): the Viol column shows MONTH-TO-DATE violations (through
  // the range END's month), matching the per-dept dashboard tile. The range
  // `violations` field is KEPT (violation-date expands + tier logic); MTD
  // rides alongside as `violationsMtd` via a second range pass over
  // month-start(to)..to (skipped when the range IS that window).
  const mtdFrom = String(to).slice(0, 8) + '01';
  const gSeenQueues = {};   // F-36: dedupe double-mapped queues in the grand total

  allDepts.forEach(function (dept) {
    // Own queues only -- children listed under their own dept.
    if (queuesForDept_(dept, { includeChildren: false }).length === 0) return;
    const rep = computeQcdReport_(dept, from, to,
                                  /*includeSubQueues=*/ false,
                                  /*separateSubQueues=*/ false,
                                  /*rangeOnly=*/ true);   // perf: only queueBreakdown is used
    const mtdRep = (mtdFrom === from)
      ? rep
      : computeQcdReport_(dept, mtdFrom, to, false, false, true);
    const mtdByQueue = {};
    (mtdRep.queueBreakdown || []).forEach(function (r) {
      mtdByQueue[r.queue] = Number(r.violations) || 0;
    });
    // #3: drop roll-up queues already counted within another queue.
    const rows = (rep.queueBreakdown || []).filter(function (r) {
      return !excludeSet[String(r.queue || '').toLowerCase()];
    });

    let dTotal = 0, dAns = 0, dAbnd = 0, dLongest = 0, dAvgWSum = 0, dAvgWN = 0, dViol = 0, dViolMtd = 0;
    rows.forEach(function (r) {
      dTotal += r.totalCalls; dAns += r.totalAnswered; dAbnd += r.abandoned;
      if (r.longestWaitSec > dLongest) dLongest = r.longestWaitSec;
      if (r.avgAnswerSec > 0 && r.totalAnswered > 0) {
        dAvgWSum += r.avgAnswerSec * r.totalAnswered;
        dAvgWN   += r.totalAnswered;
      }
      dViol += (Number(r.violations) || 0);
      dViolMtd += (mtdByQueue[r.queue] || 0);
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
        violationsMtd:   dViolMtd,
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
          violationsMtd:   mtdByQueue[r.queue] || 0,
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
      gViolMtd += (mtdByQueue[r.queue] || 0);
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
    violationsMtd:   gViolMtd,
  };

  const parseIso_ = function (iso) {
    const p = iso.split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12);
  };
  const fmt = function (d) { return Utilities.formatDate(d, TZ, 'MMM d, yyyy'); };
  // R11-B4: a single-day range labels as ONE date -- "Jul 20, 2026", not
  // "Jul 20, 2026 - Jul 20, 2026" (feeds the web header AND the email
  // subject; the report defaults to a single day, so this is the usual case).
  const dateLabel = (from === to)
    ? fmt(parseIso_(from))
    : fmt(parseIso_(from)) + ' - ' + fmt(parseIso_(to));

  const data = {
    meta:        { from: from, to: to, cacheHit: false, computeMs: Date.now() - t0, deptCount: depts.length },
    dateLabel:   dateLabel,
    depts:       depts,
    grandTotals: grandTotals,
  };

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

/**
 * QCD Neon read-back switch (#3), the getDqeReadSource_ pattern. 'neon' only
 * when the Script Property `QCD_READ_SOURCE` is explicitly set; anything else
 * (incl. unset) => 'sheet'. Default 'sheet' keeps the whole-sheet read, so
 * behavior is byte-identical to pre-#3 until flipped -- and every reader
 * falls back to the sheet on any Neon miss, so the flip is reversible with
 * no redeploy. Independent of DQE_READ_SOURCE (QCD is a separate mirror).
 */
function getQcdReadSource_() {
  var v = String(PropertiesService.getScriptProperties()
                   .getProperty('QCD_READ_SOURCE') || 'sheet').toLowerCase().trim();
  return v === 'neon' ? 'neon' : 'sheet';
}

// Per-EXECUTION memo of windowed Neon QCD reads, keyed by 'from|to'. Like the
// QCD_SHEET_DATA_MEMO_ whole-sheet memo, this keeps getQcdAllDepartments (which
// calls computeQcdReport_ once per dept, all with the SAME window) to ONE Neon
// round-trip for the whole page instead of one per dept. Reset per request
// (Apps Script globals reset); tests null it alongside QCD_SHEET_DATA_MEMO_.
var QCD_NEON_GRID_MEMO_ = null;

/**
 * Windowed Neon read of qcd_history for [fromIso, toIso] (inclusive), returned
 * in the SAME sheet-cell shape readQcdSheetData_ produces ({values, displays,
 * ssTZ}) so the computeQcdReport_ loop AND computeMtdViolations_ consume Neon
 * rows byte-identically to sheet rows -- the "grid adapter feeds the UNCHANGED
 * loop" pattern the Missed-Calls DAL cutover uses (missedGridsFromDal_). One
 * json_agg round-trip (never per-row JDBC -- Apps Script JDBC is ~0.5s/row).
 * longest_wait / avg_answer are stored as the same H:MM:SS strings the sheet
 * DISPLAYS, so they go in the `displays` grid and parse via parseHmsDisplay_.
 *
 * Returns null on no-conn / error (caller falls back to the sheet); a
 * reachable-but-empty window returns a valid {values:[], ...} grid (truthy),
 * so the loop produces a correctly-zeroed report without a redundant
 * whole-sheet scan (the LM2 lesson). `conn` (optional) lets a caller share a
 * connection; when omitted we open + close our own. NEO-3: QCD is NOT a DQE
 * read-back reader, so it opens WITHOUT {recordReadHealth} -- a QCD read miss
 * must not pollute the DQE-only NEON_READ_LAST_ERROR health line.
 */
function neonFetchQcdGrid_(fromIso, toIso, conn) {
  var ownConn = !conn;
  if (ownConn) conn = (typeof getDashboardNeonConn_ === 'function') ? getDashboardNeonConn_() : null;
  if (!conn) return null;
  try {
    var sql = "SELECT COALESCE(json_agg(t), '[]')::text AS j FROM ("
            + "SELECT call_date::text AS d, call_queue, call_source, "
            + "total_calls, total_answered, abandoned, longest_wait, avg_answer, violations "
            + "FROM qcd_history WHERE call_date BETWEEN ?::date AND ?::date) t";
    var stmt = conn.prepareStatement(sql);
    stmt.setString(1, fromIso);
    stmt.setString(2, toIso);
    var rs = stmt.executeQuery();
    var json = rs.next() ? rs.getString('j') : '[]';
    rs.close(); stmt.close();
    var arr = JSON.parse(json || '[]');
    var values = [], displays = [];
    for (var i = 0; i < arr.length; i++) {
      var r = arr[i];
      var v = [], d = [];
      for (var c = 0; c < 12; c++) { v.push(''); d.push(''); }
      // rowDateIso_ passes a 'yyyy-MM-dd' string straight through, so the
      // date cell needs no TZ juggling.
      v[QCD_HISTORICAL_COLS.DATE - 1]           = String(r.d || '');
      v[QCD_HISTORICAL_COLS.CALL_QUEUE - 1]     = String(r.call_queue == null ? '' : r.call_queue);
      v[QCD_HISTORICAL_COLS.CALL_SOURCE - 1]    = String(r.call_source == null ? '' : r.call_source);
      v[QCD_HISTORICAL_COLS.TOTAL_CALLS - 1]    = Number(r.total_calls)    || 0;
      v[QCD_HISTORICAL_COLS.TOTAL_ANSWERED - 1] = Number(r.total_answered) || 0;
      v[QCD_HISTORICAL_COLS.ABANDONED - 1]      = Number(r.abandoned)      || 0;
      v[QCD_HISTORICAL_COLS.VIOLATIONS - 1]     = Number(r.violations)     || 0;
      d[QCD_HISTORICAL_COLS.LONGEST_WAIT - 1]   = String(r.longest_wait == null ? '' : r.longest_wait);
      d[QCD_HISTORICAL_COLS.AVG_ANSWER - 1]     = String(r.avg_answer   == null ? '' : r.avg_answer);
      values.push(v); displays.push(d);
    }
    return { values: values, displays: displays, ssTZ: TZ, _neonReachable: true };
  } catch (e) {
    Logger.log('neonFetchQcdGrid_ failed: ' + (e && e.message ? e.message : e));
    return null;
  } finally {
    if (ownConn) { try { conn.close(); } catch (ce) {} }
  }
}

/**
 * Source-aware grid read for computeQcdReport_. When QCD_READ_SOURCE=neon,
 * returns a WINDOWED Neon grid for [readFrom, readTo] (memoized per window so
 * the all-dept report hits Neon once); falls back to the whole-sheet read on
 * any Neon miss. When 'sheet' (default), returns the whole-sheet read exactly
 * as before. The caller passes a window that is a SUPERSET of everything its
 * consumers need (the trend/range rows AND the MTD-violation month), and the
 * existing in-loop date filters keep the result identical to a whole-sheet read.
 */
function readQcdGrid_(readFrom, readTo) {
  if (getQcdReadSource_() === 'neon') {
    if (!QCD_NEON_GRID_MEMO_) QCD_NEON_GRID_MEMO_ = {};
    var key = readFrom + '|' + readTo;
    if (QCD_NEON_GRID_MEMO_[key]) return QCD_NEON_GRID_MEMO_[key];
    var grid = neonFetchQcdGrid_(readFrom, readTo);
    if (grid) { QCD_NEON_GRID_MEMO_[key] = grid; return grid; }
    // Unreachable / error -> fall back to the sheet (may itself be missing).
  }
  return readQcdSheetData_();
}

/**
 * R-1: MAX(call_date) from qcd_history -- the QCD sibling of NeonRead.gs's
 * neonGetMaxDqeDate_, consumed by getLatestDataDates' QCD component when
 * QCD_READ_SOURCE=neon (the freshness pill was the last QCD reader still
 * hard-wired to the sheet). Null on no-conn / error / empty table; the
 * caller falls back to the sheet scan. NEO-3: opens WITHOUT
 * {recordReadHealth} -- QCD reads never pollute the DQE-only read-back
 * health line.
 */
function neonGetMaxQcdDate_() {
  var conn = (typeof getDashboardNeonConn_ === 'function') ? getDashboardNeonConn_() : null;
  if (!conn) return null;
  try {
    var stmt = conn.createStatement();
    var rs = stmt.executeQuery('SELECT MAX(call_date)::text AS d FROM qcd_history');
    var d = rs.next() ? rs.getString('d') : null;
    rs.close(); stmt.close();
    return d || null;
  } catch (e) {
    Logger.log('neonGetMaxQcdDate_ failed: ' + (e && e.message ? e.message : e));
    return null;
  } finally {
    try { conn.close(); } catch (ce) {}
  }
}

// rangeOnly (perf): the all-dept Daily Call Queue Report uses ONLY
// queueBreakdown (range-scoped), never trendData/dailySeries/perQueue -- yet it
// calls this once per dept, each pass iterating the whole 12-month TREND window
// of rows to build a trend it discards. When rangeOnly is set, trend-only rows
// (in the trend window but outside [from,to]) are skipped, so a one-day report
// processes ~1 day of rows per dept instead of ~12 months. Trend-only rows feed
// ONLY the monthly buckets (queueBreakdown/grandTotals come from the in-range
// accumulation), so the outputs the all-dept report reads are byte-identical --
// only trendData/dailySeries go sparse, which that report ignores. Other
// callers (Insights Queue health, snapshots) omit rangeOnly -> full behavior.
function computeQcdReport_(dept, from, to, includeSubQueues, separateSubQueues, rangeOnly) {
  const qOpts = { includeChildren: includeSubQueues !== false };
  // separateSubQueues (QCD report only): children stay visible in the
  // breakdown/chart but are tagged + EXCLUDED from the dept total, the
  // dept-total daily/trend series, and the MTD violation count. Insights'
  // Queue-health calls omit this, so their behavior is byte-identical.
  const separate = !!separateSubQueues;
  const tags = separate ? qcdSubQueueTags_(dept) : { ownSet: {}, queueOwner: {} };
  const isOwn = function (q) { return !separate || !!tags.ownSet[q]; };

  // Trend window: same logic as Individual / Performance Reports
  // (12-mo monthly buckets unless range > 366 days or full year). Computed
  // BEFORE the data read (it needs only from/to) so the read can be WINDOWED
  // on the Neon path (#3) instead of pulling all history.
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

  // Read window (#3, Neon path): a SUPERSET of every window the consumers
  // scan, so the loop's existing date filters + computeMtdViolations_ read the
  // Neon grid byte-identically to a whole-sheet read.
  //   - the main loop needs [rangeOnly ? from : trendStartIso, to]
  //   - computeMtdViolations_ needs [first-of-THIS-month, today] (it keys off
  //     `new Date()`, independent of from/to)
  // so read [min(mainFrom, mtdStart), max(to, today)]. On the sheet path
  // readQcdGrid_ ignores the window and returns the whole sheet (unchanged).
  const _now = new Date();
  const mtdStartIso = Utilities.formatDate(
    new Date(_now.getFullYear(), _now.getMonth(), 1), TZ, 'yyyy-MM-dd');
  const todayIso = Utilities.formatDate(_now, TZ, 'yyyy-MM-dd');
  const mainFrom = rangeOnly ? from : trendStartIso;
  const readFrom = (mainFrom < mtdStartIso) ? mainFrom : mtdStartIso;
  const readTo   = (to > todayIso) ? to : todayIso;
  const sheetData = readQcdGrid_(readFrom, readTo);
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
    // rangeOnly: skip trend-only rows (they feed only the discarded monthly
    // trend). Full mode keeps them for the 12-month chart.
    if (!inUserRange && (rangeOnly || !inTrendRange)) continue;

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
      // mean (sum(avgAnswer*answered)/sum(answered)). RPT-8 (owner-ratified):
      // this INTENTIONALLY diverges from the legacy buildTable4 simple
      // day-mean -- a 2-call day shouldn't weigh like a 200-call day. The
      // weighting is applied consistently across queue rows, dept totals,
      // bySource, and the all-dept report; docs/known-issues.md matches.
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

/**
 * MAX(call_date) from qcd_history as 'yyyy-MM-dd' (or null on no-conn / no
 * data / error). The QCD analog of neonGetMaxDqeDate_, for the QCD mirror-
 * health divergence check. `conn` (optional) shares a caller's connection;
 * omitted, we open + close our own. NEO-3: QCD is not a DQE read-back reader,
 * so opening our own conn does NOT touch NEON_READ_LAST_ERROR.
 */
function neonQcdMaxDate_(conn) {
  var ownConn = !conn;
  if (ownConn) conn = (typeof getDashboardNeonConn_ === 'function') ? getDashboardNeonConn_() : null;
  if (!conn) return null;
  try {
    var stmt = conn.createStatement();
    var rs = stmt.executeQuery('SELECT MAX(call_date)::text AS d FROM qcd_history');
    var d = rs.next() ? rs.getString('d') : null;
    rs.close(); stmt.close();
    return d ? String(d).trim() : null;
  } catch (e) {
    Logger.log('neonQcdMaxDate_ failed: ' + (e && e.message ? e.message : e));
    return null;
  } finally {
    if (ownConn) { try { conn.close(); } catch (ce) {} }
  }
}

/**
 * Source-independent MAX(call_date) from the QCD Historical Data SHEET, as
 * 'yyyy-MM-dd' (or null). Scans only the date column. Used by the QCD mirror-
 * health check so it always reflects the sheet regardless of QCD_READ_SOURCE
 * (the dqeSheetMaxDate_ analog). Best-effort: null on any error.
 */
function qcdSheetMaxDate_() {
  try {
    var ss = openSpreadsheet_();
    var sheet = ss.getSheetByName('QCD Historical Data');
    if (!sheet) return null;
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return null;
    var ssTZ = ss.getSpreadsheetTimeZone();
    var vals = sheet.getRange(2, QCD_HISTORICAL_COLS.DATE, lastRow - 1, 1).getValues();
    var max = '';
    for (var i = 0; i < vals.length; i++) {
      var iso = rowDateIso_(vals[i][0], ssTZ);
      if (iso && iso > max) max = iso;
    }
    return max || null;
  } catch (e) {
    Logger.log('qcdSheetMaxDate_ failed: ' + (e && e.message ? e.message : e));
    return null;
  }
}

/**
 * QCD->Neon mirror divergence check (the computeNeonMirrorHealth_ analog for
 * qcd_history). Compares the SHEET's MAX(call_date) against qcd_history's, so
 * an admin can spot a stale QCD mirror before flipping QCD_READ_SOURCE=neon.
 * Returns { configured, status, sheetMax, neonMax, gapDays } with the same
 * status vocabulary ('unconfigured' | 'error' | 'ok' | 'behind').
 *
 * `conn` (optional) shares the SystemHealth single connection. Contract: when
 * a conn arg is PASSED (even null) the caller owns the lifecycle -- an
 * explicit null means "the shared open already failed", so report 'error'
 * WITHOUT a second handshake; with NO arg we open our own. Best-effort:
 * never throws (reuses neonMirrorGapDays_ from NeonRead.gs).
 */
function computeQcdMirrorHealth_(conn) {
  var out = { configured: false, status: 'unconfigured',
              sheetMax: null, neonMax: null, gapDays: null };
  try {
    if (!PropertiesService.getScriptProperties().getProperty('NEON_HOST')) return out;
    out.configured = true;
    out.sheetMax = qcdSheetMaxDate_();
    var sharedConnProvided = (arguments.length >= 1);
    out.neonMax = sharedConnProvided ? (conn ? neonQcdMaxDate_(conn) : null)
                                     : neonQcdMaxDate_();
    if (!out.neonMax) { out.status = 'error'; return out; }
    if (!out.sheetMax) { out.status = 'ok'; return out; }
    if (out.neonMax >= out.sheetMax) { out.status = 'ok'; out.gapDays = 0; return out; }
    out.status = 'behind';
    out.gapDays = neonMirrorGapDays_(out.neonMax, out.sheetMax);
    return out;
  } catch (e) {
    Logger.log('computeQcdMirrorHealth_ failed: ' + (e && e.message ? e.message : e));
    out.status = 'error';
    return out;
  }
}

/**
 * Editor-run QCD parity gate (the compareDqeSources_ analog). Reads a date
 * range from BOTH sources (whole-sheet filtered to the window vs the windowed
 * Neon grid) and reports per-(date,queue,source) row-count + value mismatches
 * across the metric columns the report consumes. GATE for QCD_READ_SOURCE=neon:
 * 0 missing-in-Neon, 0 extra-in-Neon, 0 value mismatches over a representative
 * range => qcd_history is trustworthy to read from.
 *
 * Range from Script Properties QCD_PARITY_FROM / QCD_PARITY_TO (in-source
 * defaults otherwise), so it can run unattended. Read-only; never writes.
 */
function compareQcdSources_() {
  var _props = PropertiesService.getScriptProperties();
  var COMPARE_FROM = _props.getProperty('QCD_PARITY_FROM') || '2026-05-23';   // <-- edit or set Script Property
  var COMPARE_TO   = _props.getProperty('QCD_PARITY_TO')   || '2026-05-29';   // <-- edit or set Script Property

  Logger.log('=== compareQcdSources_  %s .. %s ===', COMPARE_FROM, COMPARE_TO);
  Logger.log('QCD_READ_SOURCE = %s (neon = the QCD readers are LIVE on qcd_history; sheet = default)',
             getQcdReadSource_());

  var sheetGrid = readQcdSheetData_();
  if (sheetGrid.missing) { Logger.log('QCD Historical Data sheet missing -- nothing to compare.'); return; }
  var neonGrid = neonFetchQcdGrid_(COMPARE_FROM, COMPARE_TO);
  if (!neonGrid) {
    Logger.log('No Neon grid -- check NEON_* Script Properties + the '
             + 'script.external_request scope on THIS project, or that '
             + 'qcd_history has data in range.');
    return;
  }

  // Normalize either grid to comparable rows keyed by date|queue|source over
  // the compare window. `windowed=true` filters (the whole-sheet grid); the
  // Neon grid is already windowed.
  var norm = function (grid, windowed) {
    var m = {};
    var vals = grid.values || [], disps = grid.displays || [];
    var tz = grid.ssTZ || TZ;
    for (var i = 0; i < vals.length; i++) {
      var r = vals[i], rd = disps[i];
      var dateIso = rowDateIso_(r[QCD_HISTORICAL_COLS.DATE - 1], tz);
      if (!dateIso) continue;
      if (windowed && (dateIso < COMPARE_FROM || dateIso > COMPARE_TO)) continue;
      var key = dateIso
        + '|' + String(r[QCD_HISTORICAL_COLS.CALL_QUEUE - 1]  || '').trim()
        + '|' + String(r[QCD_HISTORICAL_COLS.CALL_SOURCE - 1] || '').trim();
      m[key] = {
        totalCalls:     Number(r[QCD_HISTORICAL_COLS.TOTAL_CALLS - 1])    || 0,
        totalAnswered:  Number(r[QCD_HISTORICAL_COLS.TOTAL_ANSWERED - 1]) || 0,
        abandoned:      Number(r[QCD_HISTORICAL_COLS.ABANDONED - 1])      || 0,
        violations:     Number(r[QCD_HISTORICAL_COLS.VIOLATIONS - 1])     || 0,
        longestWaitSec: parseHmsDisplay_(rd[QCD_HISTORICAL_COLS.LONGEST_WAIT - 1]),
        avgAnswerSec:   parseHmsDisplay_(rd[QCD_HISTORICAL_COLS.AVG_ANSWER - 1]),
      };
    }
    return m;
  };
  var sMap = norm(sheetGrid, true);
  var nMap = norm(neonGrid, false);
  Logger.log('sheet rows (in window): %s | neon rows: %s',
             Object.keys(sMap).length, Object.keys(nMap).length);

  // Counts must match EXACTLY; the two duration-derived fields get a ±1s
  // tolerance (R5, owner parity run). WHY: the writer stores avg_answer /
  // longest_wait via normalizeDuration's Math.round(serial * 86400), and an
  // IEEE double puts a x.5-second average at 20.499999999999996 -> 20, while
  // Sheets' own display formatter rounds the SAME serial to "0:00:21". Both
  // sides are then re-parsed from display strings here, so a half-second
  // average deterministically reads 1s apart -- a re-import reproduces it
  // identically (it is NOT drift, and the gate's re-import advice can't
  // clear it). Anything >1s apart is still a real mismatch.
  var EXACT_FIELDS = ['totalCalls', 'totalAnswered', 'abandoned', 'violations'];
  var TOLERANT_FIELDS = ['longestWaitSec', 'avgAnswerSec'];   // ±1s = display-rounding noise
  var missingInNeon = [], extraInNeon = [], mismatches = [], roundingOnly = 0;
  Object.keys(sMap).forEach(function (k) {
    if (!nMap[k]) { missingInNeon.push(k); return; }
    var s = sMap[k], n = nMap[k], diffs = [], hadRounding = false;
    EXACT_FIELDS.forEach(function (f) {
      if (String(s[f]) !== String(n[f])) diffs.push(f + ' sheet=' + s[f] + ' neon=' + n[f]);
    });
    TOLERANT_FIELDS.forEach(function (f) {
      var d = Math.abs((Number(s[f]) || 0) - (Number(n[f]) || 0));
      if (d > 1) diffs.push(f + ' sheet=' + s[f] + ' neon=' + n[f]);
      else if (d === 1) hadRounding = true;
    });
    if (diffs.length) mismatches.push(k + ' :: ' + diffs.join(', '));
    else if (hadRounding) roundingOnly++;
  });
  Object.keys(nMap).forEach(function (k) { if (!sMap[k]) extraInNeon.push(k); });

  Logger.log('--- missing in Neon (sheet rows not mirrored): %s', missingInNeon.length);
  missingInNeon.slice(0, 10).forEach(function (k) { Logger.log('   %s', k); });
  Logger.log('--- extra in Neon (not on sheet): %s', extraInNeon.length);
  extraInNeon.slice(0, 10).forEach(function (k) { Logger.log('   %s', k); });
  Logger.log('--- value mismatches on common keys: %s', mismatches.length);
  mismatches.slice(0, 10).forEach(function (m) { Logger.log('   %s', m); });
  if (roundingOnly) {
    Logger.log('--- ±1s duration rounding diffs (IGNORED -- write-time float rounding '
      + 'vs Sheets display rounding at half-second averages; deterministic, not drift): %s',
      roundingOnly);
  }

  var clean = (missingInNeon.length === 0 && extraInNeon.length === 0 && mismatches.length === 0);
  Logger.log('=== QCD PARITY %s ===', clean
    ? 'CLEAN -- qcd_history matches the sheet for this range; the QCD read-back gate PASSED'
    : 'MISMATCH -- resolve before setting QCD_READ_SOURCE=neon. Re-run the daily import '
      + 'for the affected date(s) (writeQCDRowsToNeon is authoritative per-date), or delete '
      + 'EXTRA-in-Neon phantom rows in SQL, then re-run this check.');
}

/**
 * Editor-run wrapper for compareQcdSources_ (the Run picker hides `_`-suffixed
 * functions). Pick `runQcdParityCheck` from the dropdown and read the log.
 */
function runQcdParityCheck() {
  assertAdmin_();   // editor-run wrapper, but the bare name is RPC-reachable
  return compareQcdSources_();
}


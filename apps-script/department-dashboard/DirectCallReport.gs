/**
 * Direct Call Report -- analytical view of the per-agent-day DIRECT-extension
 * call metrics captured in Neon's `direct_call_history` (written by
 * cdr-import/directCallMetrics.js, Phase 1b). DISTINCT population from the DQE
 * per-agent queue metrics + QCD queue metrics: these are calls to/from an
 * employee's OWN extension (inbound + outbound), with the defining "busy"
 * carve-out -- an inbound ring missed because the agent was already on another
 * call lands in its own `missed_busy` bucket and is EXCLUDED from the answer
 * rate (but still counted + surfaced).
 *
 * Public entry (callable via google.script.run):
 *   getDirectCallReport({ from, to, department? })
 *     -> { meta, kpis, agents }
 *
 * AUTHORIZATION (Inbound-report model -- per-dept gate, opened from admin-only):
 *   - TEMPORARILY admin-only while the numbers are vetted (Phase 2 ships
 *     before much history has accrued; the busy carve-out wants a few weeks
 *     of live spot-checking against Raw Data). The per-dept MANAGER path is
 *     written and kept intact so restoring manager access is a one-line gate
 *     removal + un-hiding the `data-admin-only` tab.
 *   - Admins: department optional. Empty/absent = the company-wide view.
 *     A dept name = that dept's slice.
 *   - Managers (once released): pinned to their own department.
 *
 * DEPT ATTRIBUTION is trivial here (unlike Inbound's queue-name bridge):
 * direct_call_history carries the agent's own `department` column (resolved
 * from the DO NOT EDIT! roster at build time), so a dept slice is a direct
 * `department = <dept>` filter. No queue-name space mismatch.
 *
 * Reads Neon via getDashboardNeonConn_ (same NEON_* props +
 * script.external_request scope as the F1 read-back / Inbound report). ONE
 * round-trip (json_build_object). Best-effort: any Neon null/error returns the
 * empty shape with meta.available=false so the modal renders a clean
 * "unavailable" state rather than throwing.
 *
 * Caching: 6 h (REPORT_CACHE_TTL_SECONDS, R24; keys carry reportFreshnessTag_()) per (dept, from, to) under
 * DIRECT_CALL_CACHE_KEY_PREFIX. Unavailable payloads are intentionally NOT
 * cached so a transient Neon failure isn't pinned for the TTL (Inbound model).
 */

// v1: initial -- team KPIs + per-agent rows (inbound answer rate excluding
// the busy carve-out, inbound ATT, outbound activity + ATT, int/ext split).
// v2 (R11-M): adds `kpisPrior` (scope-level, over the INV-28 immediately-
// preceding same-length window) + `deptsPrior` (per-dept prior aggregates) so
// the client renders delta/trend chips on the KPI cards + dept header rows.
// v3: B-1 -- the company-view agents sub-select groups per (agent, dept)
// instead of collapsing a crossover agent under max(department).
// v5 (D1, owner 2026-10-21): coverage-aware -- the window is clamped to the
// last date with data, workdays with no rows are listed, the prior comparison
// is dropped when either window has a gap, and the full int/ext split ships.
const DIRECT_CALL_CACHE_KEY_PREFIX = 'directCall:v5';
const DIRECT_CALL_MAX_RANGE_DAYS = 366;

/**
 * Shared request gate: resolves the caller, validates from/to, resolves dept
 * scope. Returns { from, to, dept, companyView, user }. Mirrors
 * inboundResolveRequest_ (incl. the temporary admin-only vetting gate).
 */
function directCallResolveRequest_(req) {
  const email = Session.getActiveUser().getEmail();
  const user = resolveUser_(email);
  // A-1 (broad-scan 2026-09-17): ALLOWLIST, never a `role === 'none'`
  // denylist -- the agent role (fail-closed shape, departments:[]) is
  // neither 'none' nor 'manager', so a denylist let it fall through to the
  // admin-style dept branch below the moment the vetting gate is released.
  assertManagerOrAdmin_(user);
  // TEMPORARY admin-only re-scope while the busy carve-out + answer-rate
  // numbers are vetted against Raw Data. The per-dept manager path below is
  // KEPT intact so restoring manager access is a one-line removal.
  if (user.role !== 'admin') {
    throw new Error('The Direct Calls report is admin-only while it is being vetted.');
  }

  const from = String((req && req.from) || '').trim();
  const to   = String((req && req.to)   || '').trim();
  if (!isIsoDate_(from) || !isIsoDate_(to)) throw new Error('from/to must be YYYY-MM-DD.');
  if (from > to) throw new Error('from must be on or before to.');
  const rangeDays = Math.round(
    (new Date(to + 'T00:00:00') - new Date(from + 'T00:00:00')) / 86400000) + 1;
  if (rangeDays > DIRECT_CALL_MAX_RANGE_DAYS) {
    throw new Error('Range is capped at ' + DIRECT_CALL_MAX_RANGE_DAYS + ' days.');
  }

  let dept = String((req && req.department) || '').trim();
  // NEO-6: manager branch FIRST, mirroring inboundResolveRequest_ exactly
  // (the two resolvers promise mirror-image semantics). The old ordering
  // cleared 'ALL' before the manager check, so a manager sending
  // department:'ALL' was silently pinned to their own dept here while the
  // same request THREW on the Inbound resolver -- divergent behavior the
  // day the vetting gates are removed.
  if (user.role === 'manager' && !user.allDepts) {
    // R-3: single-dept managers pinned; the allDepts manager takes the
    // admin-style branch (data breadth) -- mirrors inboundResolveRequest_.
    // Tier C: a multi-dept manager may pass ANY of their assigned depts; a
    // blank/ALL request defaults to their first. (Latent -- this report is
    // admin-only while vetted -- but kept consistent per the R-3 discipline.)
    var mine = (user.departments && user.departments.length) ? user.departments : (user.department ? [user.department] : []);
    if (dept && dept !== 'ALL') {
      if (mine.indexOf(dept) === -1) throw new Error('Not authorized for this department.');
    } else {
      dept = mine[0] || user.department;
    }
  } else if (dept === 'ALL') {
    dept = '';   // admin / allDepts company view
  } else if (dept && getAllDepartments_().indexOf(dept) === -1) {
    throw new Error('Unknown department: ' + dept);
  }

  return { from: from, to: to, dept: dept, companyView: !dept, user: user };
}

function directCallSqlLit_(s) {
  return "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'";
}

// ── D1 COVERAGE (owner 2026-10-21) ────────────────────────────────────────
// A date the import has not reached yet has NO rows, which the sums read as a
// quiet day: a window ending on such a date understated every figure and its
// prior chips compared a part window with a whole one. So the window is
// CLAMPED to the last date with data (`meta.to`, the asked end in
// `meta.requestedTo`), each workday (Mon-Fri, not a company holiday) with no
// row for ANY department is listed, and the prior comparison is dropped when
// either window has such a gap. Presence is company-wide on purpose: one
// department with no direct calls on a day is normal; no row at all is not.

/** PURE. Workdays in [from, to] with no row; at most 60 listed, all counted. */
function dcMissingWorkdays_(from, to, present, isHoliday) {
  var out = [], count = 0;
  if (!isIsoDate_(from) || !isIsoDate_(to) || from > to) return { dates: out, count: 0 };
  var p = from.split('-'), q = to.split('-');
  for (var ms = Date.UTC(+p[0], p[1] - 1, +p[2], 12), end = Date.UTC(+q[0], q[1] - 1, +q[2], 12); ms <= end; ms += 86400000) {
    var d = new Date(ms), dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    var iso = d.toISOString().slice(0, 10);
    if (isHoliday && isHoliday(iso)) continue;
    if (present[iso]) continue;
    count++;
    if (out.length < 60) out.push(iso);
  }
  return { dates: out, count: count };
}

/** The company-holiday test, read ONCE per request (best-effort). */
function dcHolidayFn_() {
  try {
    if (typeof getCompanyHolidayRanges_ === 'function' && typeof isDateInSkipRanges_ === 'function') {
      var ranges = getCompanyHolidayRanges_();
      return function (iso) { return isDateInSkipRanges_(iso, ranges); };
    }
  } catch (e) { /* no holidays known: weekends only */ }
  return null;
}

/**
 * PURE (given isHoliday). Resolves the window the report may honestly show:
 * `mx` = the last date with any row (null = an empty table), `present` = the
 * dates with rows over at least [the unclamped prior window's start, to].
 */
function dcCoverage_(scope, mx, present, isHoliday) {
  var cov = { requestedTo: scope.to, dataThrough: mx || null, to: scope.to, clamped: false,
              noData: false, missing: { dates: [], count: 0 }, priorMissing: { dates: [], count: 0 } };
  if (!mx || mx < scope.from) { cov.noData = true; cov.pw = computePriorWindow_(scope.from, scope.to); return cov; }
  if (mx < scope.to) { cov.to = mx; cov.clamped = true; }
  cov.pw = computePriorWindow_(scope.from, cov.to);
  cov.missing = dcMissingWorkdays_(scope.from, cov.to, present || {}, isHoliday);
  cov.priorMissing = dcMissingWorkdays_(cov.pw.from, cov.pw.to, present || {}, isHoliday);
  return cov;
}

/** Stamps the coverage onto a shaped payload; drops a gap-biased prior. */
function dcApplyCoverageMeta_(out, cov) {
  out.meta.requestedTo = cov.requestedTo;
  out.meta.dataThrough = cov.dataThrough;
  out.meta.clampedTo = cov.clamped;
  out.meta.noDataInRange = cov.noData;
  out.meta.missingDates = cov.missing.dates;
  out.meta.missingCount = cov.missing.count;
  out.meta.priorFrom = cov.pw ? cov.pw.from : null;
  out.meta.priorTo = cov.pw ? cov.pw.to : null;
  out.meta.priorMissingCount = cov.priorMissing.count;
  out.meta.priorSuppressed = !!(cov.missing.count || cov.priorMissing.count);
  if (out.meta.priorSuppressed) { out.kpisPrior = null; out.deptsPrior = []; }
  return out;
}

function emptyDirectCallReport_(scope) {
  return {
    meta: {
      from: scope.from, to: scope.to, department: scope.dept || '',
      companyView: scope.companyView, available: true, vetting: true,
      cacheHit: false, computeMs: 0,
    },
    kpis: {
      agents: 0,
      ibAnswered: 0, ibMissedFree: 0, ibMissedBusy: 0, ibTalkSec: 0,
      ibAnswerRate: null, ibAttSec: 0,
      obTotal: 0, obConnected: 0, obTalkSec: 0, obAttSec: 0,
    },
    kpisPrior: null,   // v2
    deptsPrior: [],    // v2
    agents: [],
  };
}

/** Shape a scope-level prior KPI block from the raw prior sums (v2). */
function directCallPriorKpis_(k) {
  if (!k) return null;
  const ibAnswered = Number(k.ibAnswered) || 0;
  const ibMissedFree = Number(k.ibMissedFree) || 0;
  const ibTalkSec = Number(k.ibTalkSec) || 0;
  const obConnected = Number(k.obConnected) || 0;
  const obTalkSec = Number(k.obTalkSec) || 0;
  return {
    ibAnswered: ibAnswered,
    ibMissedFree: ibMissedFree,
    ibMissedBusy: Number(k.ibMissedBusy) || 0,
    ibTalkSec: ibTalkSec,
    ibAnswerRate: directCallAnswerRate_(ibAnswered, ibMissedFree),
    ibAttSec: ibAnswered ? Math.round(ibTalkSec / ibAnswered) : 0,
    obTotal: Number(k.obTotal) || 0,
    obConnected: obConnected,
    obTalkSec: obTalkSec,
    obAttSec: obConnected ? Math.round(obTalkSec / obConnected) : 0,
  };
}

function getDirectCallReport(req) {
  const scope = directCallResolveRequest_(req);

  const cache = CacheService.getScriptCache();
  const cacheKey = DIRECT_CALL_CACHE_KEY_PREFIX + ':' + (scope.dept || '__all__')
                 + ':' + scope.from + ':' + scope.to + ':' + reportFreshnessTag_();
  const cached = cache.get(cacheKey);
  if (cached) {
    try {
      const p = JSON.parse(cached);
      p.meta.cacheHit = true;
      logReportUsage_('directCall', scope.dept || '(all)', scope.user, true);
      return p;
    } catch (e) { /* recompute */ }
  }

  const t0 = Date.now();
  const data = computeDirectCallReport_(scope);
  data.meta.computeMs = Date.now() - t0;
  data.meta.cacheHit = false;
  // Fallback payloads are NEVER cached -- a recovered Neon must not be
  // masked for the TTL (the unavailable-uncached rule extended to degraded
  // payloads, same as the heatmap fallback).
  // D1: a clamped window or one with a missing workday is never cached --
  // the import filling it in must show at once, not after the TTL.
  if (data.meta.available && !data.meta.fallbackSource && !data.meta.clampedTo
      && !data.meta.missingCount && !data.meta.priorMissingCount) {
    try { cache.put(cacheKey, JSON.stringify(data), REPORT_CACHE_TTL_SECONDS); }
    catch (e) { Logger.log('DirectCallReport cache put failed: %s', e); }
  }
  logReportUsage_('directCall', scope.dept || '(all)', scope.user, false);
  return data;
}

function computeDirectCallReport_(scope) {
  const from = scope.from, to = scope.to;
  const empty = emptyDirectCallReport_(scope);
  let conn = null;
  try {
    conn = (typeof getDashboardNeonConn_ === 'function') ? getDashboardNeonConn_() : null;
    if (!conn) return directCallSheetFallback_(scope, empty);

    // D1: the coverage read first -- the last date with any row, and which
    // dates have rows from the UNCLAMPED prior window's start (the earliest a
    // clamped window's prior can begin) to the asked end.
    const pw0 = computePriorWindow_(from, to);
    const covStmt = conn.createStatement();
    const covRs = covStmt.executeQuery("SELECT json_build_object('mx', (SELECT max(call_date)::text FROM direct_call_history), "
      + "'days', (SELECT COALESCE(json_agg(DISTINCT call_date::text), '[]') FROM direct_call_history "
      + "WHERE call_date BETWEEN '" + pw0.from + "'::date AND '" + to + "'::date))::text AS j");
    const covJson = covRs.next() ? covRs.getString('j') : null;
    if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(covJson ? covJson.length : 0, 'direct');
    covRs.close(); covStmt.close();
    if (!covJson) return directCallSheetFallback_(scope, empty);
    const covObj = JSON.parse(covJson);
    const present = {};
    (covObj.days || []).forEach(function (d) { present[String(d)] = true; });
    const cov = dcCoverage_(scope, covObj.mx || null, present, dcHolidayFn_());
    if (cov.noData) return dcApplyCoverageMeta_(empty, cov);
    const effTo = cov.to;

    // from/to are validated ISO; the dept literal is escaped (and is itself a
    // roster-derived dept header, not free user text). ONE query, ONE getString.
    const deptPred = scope.companyView ? '' : ' AND c.department = ' + directCallSqlLit_(scope.dept);
    const dr = "c.call_date BETWEEN '" + from + "'::date AND '" + effTo + "'::date" + deptPred;
    // v2: INV-28 immediately-preceding same-length window for the delta chips
    // (D1: of the CLAMPED window, so a part window never meets a whole one).
    const pw = cov.pw;
    const priorDr = "c.call_date BETWEEN '" + pw.from + "'::date AND '" + pw.to + "'::date" + deptPred;
    // Scope-level prior KPI sums + per-dept prior aggregates (for the company
    // view's dept header-row deltas). ib_talk kept so ATT can be re-derived.
    const priorKpiSel = "json_build_object(" +
      "'ibAnswered', COALESCE(sum(ib_int_answered+ib_ext_answered),0), " +
      "'ibMissedFree', COALESCE(sum(ib_int_missed_free+ib_ext_missed_free),0), " +
      "'ibMissedBusy', COALESCE(sum(ib_int_missed_busy+ib_ext_missed_busy),0), " +
      "'ibTalkSec', COALESCE(sum(ib_int_talk_sec+ib_ext_talk_sec),0), " +
      "'obTotal', COALESCE(sum(ob_int_total+ob_ext_total),0), " +
      "'obConnected', COALESCE(sum(ob_int_connected+ob_ext_connected),0), " +
      "'obTalkSec', COALESCE(sum(ob_int_talk_sec+ob_ext_talk_sec),0))";

    // Per-agent sums; derived rates computed client-/server-side after the
    // fetch. ib_answered/ib_missed_free drive the answer rate (busy excluded).
    const sql =
      "SELECT json_build_object(" +
        "'kpis', (SELECT json_build_object(" +
            "'agents', count(DISTINCT agent_name), " +
            "'ibAnswered', COALESCE(sum(ib_int_answered+ib_ext_answered),0), " +
            "'ibMissedFree', COALESCE(sum(ib_int_missed_free+ib_ext_missed_free),0), " +
            "'ibMissedBusy', COALESCE(sum(ib_int_missed_busy+ib_ext_missed_busy),0), " +
            "'ibTalkSec', COALESCE(sum(ib_int_talk_sec+ib_ext_talk_sec),0), " +
            "'obTotal', COALESCE(sum(ob_int_total+ob_ext_total),0), " +
            "'obConnected', COALESCE(sum(ob_int_connected+ob_ext_connected),0), " +
            "'obTalkSec', COALESCE(sum(ob_int_talk_sec+ob_ext_talk_sec),0), " +
            // D1: the internal / external split of every figure.
            "'ibIntAnswered', COALESCE(sum(ib_int_answered),0), 'ibExtAnswered', COALESCE(sum(ib_ext_answered),0), " +
            "'ibIntMissedFree', COALESCE(sum(ib_int_missed_free),0), 'ibExtMissedFree', COALESCE(sum(ib_ext_missed_free),0), " +
            "'ibIntMissedBusy', COALESCE(sum(ib_int_missed_busy),0), 'ibExtMissedBusy', COALESCE(sum(ib_ext_missed_busy),0), " +
            "'obIntTotal', COALESCE(sum(ob_int_total),0), 'obExtTotal', COALESCE(sum(ob_ext_total),0), " +
            "'obIntConnected', COALESCE(sum(ob_int_connected),0), 'obExtConnected', COALESCE(sum(ob_ext_connected),0)" +
          ") FROM direct_call_history c WHERE " + dr + "), " +
        // B-1: group per (agent, department) -- direct_call_history is keyed
        // (call_date, department, agent_name), so a crossover agent
        // legitimately has rows in TWO depts. The old GROUP BY agent_name +
        // max(department) collapsed both depts' figures under the
        // lexicographically-max dept, inflating one company-view dept card
        // and dropping the agent from the other (while deptsPrior grouped by
        // department correctly, so the delta chips compared mismatched
        // groupings). Single-dept scope is unchanged: deptPred pins one
        // department, making the extra GROUP BY key a no-op there.
        "'agents', (SELECT COALESCE(json_agg(t ORDER BY t.ib_answered DESC, t.agent), '[]') FROM (" +
            "SELECT agent_name AS agent, department AS dept, " +
              "sum(ib_int_answered+ib_ext_answered) AS ib_answered, " +
              "sum(ib_int_missed_free+ib_ext_missed_free) AS ib_missed_free, " +
              "sum(ib_int_missed_busy+ib_ext_missed_busy) AS ib_missed_busy, " +
              "sum(ib_int_talk_sec+ib_ext_talk_sec) AS ib_talk_sec, " +
              "sum(ib_int_answered) AS ib_int_answered, sum(ib_ext_answered) AS ib_ext_answered, " +
              "sum(ib_int_missed_free) AS ib_int_missed_free, sum(ib_ext_missed_free) AS ib_ext_missed_free, " +
              "sum(ib_int_missed_busy) AS ib_int_missed_busy, sum(ib_ext_missed_busy) AS ib_ext_missed_busy, " +
              "sum(ob_int_connected) AS ob_int_connected, sum(ob_ext_connected) AS ob_ext_connected, " +
              "sum(ob_int_total+ob_ext_total) AS ob_total, " +
              "sum(ob_int_connected+ob_ext_connected) AS ob_connected, " +
              "sum(ob_int_talk_sec+ob_ext_talk_sec) AS ob_talk_sec, " +
              "sum(ob_int_total) AS ob_int_total, sum(ob_ext_total) AS ob_ext_total " +
            "FROM direct_call_history c WHERE " + dr + " GROUP BY agent_name, department) t), " +
        // v2 prior window (deltas):
        "'kpisPrior', (SELECT " + priorKpiSel + " FROM direct_call_history c WHERE " + priorDr + "), " +
        "'deptsPrior', (SELECT COALESCE(json_agg(t2), '[]') FROM (" +
            "SELECT department AS dept, " +
              "sum(ib_int_answered+ib_ext_answered) AS ib_answered, " +
              "sum(ib_int_missed_free+ib_ext_missed_free) AS ib_missed_free, " +
              "sum(ib_int_missed_busy+ib_ext_missed_busy) AS ib_missed_busy, " +
              "sum(ob_int_total+ob_ext_total) AS ob_total " +
            "FROM direct_call_history c WHERE " + priorDr + " GROUP BY department) t2), " +
        // R12-26b: coverage start (earliest direct-call history date, unscoped)
        // so the client can warn when the requested From predates the data.
        "'coverageStart', (SELECT MIN(call_date)::text FROM direct_call_history)" +
      ")::text AS j";

    const stmt = conn.createStatement();
    const rs = stmt.executeQuery(sql);
    const json = rs.next() ? rs.getString('j') : null;
    // F5: meter the bytes this read actually pulled (NeonRead.gs;
    // typeof-guarded like every other cross-file call here).
    if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(json ? json.length : 0, 'direct');
    rs.close(); stmt.close();
    if (!json) return directCallSheetFallback_(scope, empty);

    const shaped = directCallShapePayload_(scope, JSON.parse(json));
    shaped.meta.to = effTo;
    return dcApplyCoverageMeta_(shaped, cov);
  } catch (e) {
    Logger.log('computeDirectCallReport_ failed: ' + (e && e.message ? e.message : e));
    return directCallSheetFallback_(scope, empty);
  } finally {
    try { if (conn) conn.close(); } catch (ce) {}
  }
}

/**
 * Shapes the parsed aggregate object (the Neon query's json_build_object
 * shape: camelCase kpis/kpisPrior, snake_case agents/deptsPrior rows,
 * coverageStart) into the client payload. SHARED by the Neon path and the
 * sheet fallback -- the fallback builds the same intermediate shape from
 * sheet rows and calls this, so the two sources structurally cannot shape
 * a payload differently.
 */
function directCallShapePayload_(scope, obj) {
  const k = obj.kpis || {};
  const agents = (obj.agents || []).map(directCallShapeAgent_);
  const ibAnswered = Number(k.ibAnswered) || 0;
  const ibMissedFree = Number(k.ibMissedFree) || 0;
  const ibTalkSec = Number(k.ibTalkSec) || 0;
  const obConnected = Number(k.obConnected) || 0;
  const obTalkSec = Number(k.obTalkSec) || 0;
  return {
    meta: {
      from: scope.from, to: scope.to, department: scope.dept || '',
      companyView: scope.companyView, available: true, vetting: true,
      coverageStart: obj.coverageStart || null,   // R12-26b
      cacheHit: false, computeMs: 0,
    },
    kpis: {
      agents: Number(k.agents) || 0,
      ibAnswered: ibAnswered,
      ibMissedFree: ibMissedFree,
      ibMissedBusy: Number(k.ibMissedBusy) || 0,
      ibTalkSec: ibTalkSec,
      ibAnswerRate: directCallAnswerRate_(ibAnswered, ibMissedFree),
      ibAttSec: ibAnswered ? Math.round(ibTalkSec / ibAnswered) : 0,
      obTotal: Number(k.obTotal) || 0,
      obConnected: obConnected,
      obTalkSec: obTalkSec,
      obAttSec: obConnected ? Math.round(obTalkSec / obConnected) : 0,
      split: directCallSplit_(k, 'camel'),   // D1
    },
    kpisPrior: directCallPriorKpis_(obj.kpisPrior || null),
    deptsPrior: (obj.deptsPrior || []).map(function (d) {
      const a = Number(d.ib_answered) || 0, mf = Number(d.ib_missed_free) || 0;
      return {
        dept: String(d.dept || ''),
        ibAnswered: a,
        ibMissedFree: mf,
        ibMissedBusy: Number(d.ib_missed_busy) || 0,
        obTotal: Number(d.ob_total) || 0,
        ibAnswerRate: directCallAnswerRate_(a, mf),
      };
    }),
    agents: agents,
  };
}

/** Inbound answer rate as a 0-100 percent, EXCLUDING the busy carve-out. */
function directCallAnswerRate_(answered, missedFree) {
  const denom = answered + missedFree;
  return denom > 0 ? round1_((answered / denom) * 100) : null;
}

/** Shape one per-agent row from the json_agg payload into the client contract. */
function directCallShapeAgent_(r) {
  const ibAnswered = Number(r.ib_answered) || 0;
  const ibMissedFree = Number(r.ib_missed_free) || 0;
  const ibTalkSec = Number(r.ib_talk_sec) || 0;
  const obConnected = Number(r.ob_connected) || 0;
  const obTalkSec = Number(r.ob_talk_sec) || 0;
  return {
    agent: String(r.agent || ''),
    dept: String(r.dept || ''),
    ibAnswered: ibAnswered,
    ibMissedFree: ibMissedFree,
    ibMissedBusy: Number(r.ib_missed_busy) || 0,
    ibTalkSec: ibTalkSec,
    ibAnswerRate: directCallAnswerRate_(ibAnswered, ibMissedFree),
    ibAttSec: ibAnswered ? Math.round(ibTalkSec / ibAnswered) : 0,
    ibIntAnswered: Number(r.ib_int_answered) || 0,
    ibExtAnswered: Number(r.ib_ext_answered) || 0,
    obTotal: Number(r.ob_total) || 0,
    obConnected: obConnected,
    obTalkSec: obTalkSec,
    obAttSec: obConnected ? Math.round(obTalkSec / obConnected) : 0,
    obIntTotal: Number(r.ob_int_total) || 0,
    obExtTotal: Number(r.ob_ext_total) || 0,
    split: directCallSplit_(r, 'snake'),   // D1
  };
}

/**
 * D1: the internal / external split of one row or the scope totals.
 * Internal: an inbound call whose CDR direction is Internal (a coworker
 * dialled the agent's extension); an outbound call to an extension on the
 * roster. External: everything else -- including, for now, an outbound dial
 * to an extension NOT on the roster (a room phone, a staff line nobody
 * rosters), which the capture cannot tell apart (D0 measures it).
 */
function directCallSplit_(r, style) {
  var g = function (camel, snake) { return Number(style === 'camel' ? r[camel] : r[snake]) || 0; };
  return {
    ibAnswered:   { int: g('ibIntAnswered', 'ib_int_answered'),     ext: g('ibExtAnswered', 'ib_ext_answered') },
    ibMissedFree: { int: g('ibIntMissedFree', 'ib_int_missed_free'), ext: g('ibExtMissedFree', 'ib_ext_missed_free') },
    ibMissedBusy: { int: g('ibIntMissedBusy', 'ib_int_missed_busy'), ext: g('ibExtMissedBusy', 'ib_ext_missed_busy') },
    obTotal:      { int: g('obIntTotal', 'ob_int_total'),           ext: g('obExtTotal', 'ob_ext_total') },
    obConnected:  { int: g('obIntConnected', 'ob_int_connected'),   ext: g('obExtConnected', 'ob_ext_connected') },
  };
}

// ── SHEET FALLBACK (Neon-outage degradation) ─────────────────────────────────
// Unlike the inbound tables, `Direct Call History` (CDR Report ss) is the
// PRIMARY for this data -- Neon `direct_call_history` is the mirror -- yet
// the report used to go dark on a Neon failure while the authoritative rows
// sat reachable in the workbook. On any Neon failure the compute now
// re-derives the SAME payload from the sheet: the raw sums are aggregated in
// JS with the SQL's exact grouping rules (per-(agent, dept) rows, B-1;
// distinct-agent kpi count; the INV-28/R24 prior window via the same
// computePriorWindow_), then shaped by the SHARED directCallShapePayload_ so
// the two sources structurally cannot diverge in shaping --
// tests/unit/direct-fallback.test.js pins source parity on one fixture.
// Disclosed via meta.fallbackSource='sheet'; NEVER cached; a missing/empty
// sheet keeps the old behavior (available=false). Sheet columns are read BY
// POSITION per DIRECT_CALL_HISTORY_HEADERS (directCallMetrics.js): 2=Date,
// 3=Department, 4=Agent, 5-8 IB Int (ans/free/busy/talk), 9-12 IB Ext,
// 13-15 OB Int (total/conn/talk), 16-18 OB Ext.

/** Display-cell -> number ('1,234' safe); blanks/garbage -> 0. */
function dcSheetNum_(v) {
  var n = Number(String(v == null ? '' : v).replace(/,/g, '').trim());
  return isFinite(n) ? n : 0;
}

/**
 * Reads `Direct Call History` rows for [fromIso, toIso] as normalized
 * per-row objects, plus coverageStart (unscoped MIN date, mirroring the
 * SQL's unscoped sub-select). Returns null when the sheet is missing/empty.
 */
function directCallSheetRows_(fromIso, toIso) {
  var ss = openSpreadsheet_();
  var sheet = ss.getSheetByName('Direct Call History');
  if (!sheet) return null;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var dates = sheet.getRange(2, 2, lastRow - 1, 1).getDisplayValues();
  var coverageStart = null, maxDate = null, present = {};
  var first = -1, last = -1;
  for (var i = 0; i < dates.length; i++) {
    var d = ncCellDateIso_(dates[i][0]);
    if (!d) continue;
    if (coverageStart === null || d < coverageStart) coverageStart = d;
    if (maxDate === null || d > maxDate) maxDate = d;   // D1: the last date with data
    if (d >= fromIso && d <= toIso) { present[d] = true; if (first < 0) first = i; last = i; }
  }
  if (first < 0) return { rows: [], coverageStart: coverageStart, maxDate: maxDate, present: present };
  var grid = sheet.getRange(2 + first, 1, last - first + 1, 18).getDisplayValues();
  var rows = [];
  for (var r = 0; r < grid.length; r++) {
    var g = grid[r];
    var iso = ncCellDateIso_(g[1]);
    if (!iso || iso < fromIso || iso > toIso) continue;
    rows.push({
      date: iso,
      dept: String(g[2] == null ? '' : g[2]).trim(),
      agent: String(g[3] == null ? '' : g[3]).trim(),
      ibIntAnswered: dcSheetNum_(g[4]), ibIntMissedFree: dcSheetNum_(g[5]),
      ibIntMissedBusy: dcSheetNum_(g[6]), ibIntTalkSec: dcSheetNum_(g[7]),
      ibExtAnswered: dcSheetNum_(g[8]), ibExtMissedFree: dcSheetNum_(g[9]),
      ibExtMissedBusy: dcSheetNum_(g[10]), ibExtTalkSec: dcSheetNum_(g[11]),
      obIntTotal: dcSheetNum_(g[12]), obIntConnected: dcSheetNum_(g[13]),
      obIntTalkSec: dcSheetNum_(g[14]),
      obExtTotal: dcSheetNum_(g[15]), obExtConnected: dcSheetNum_(g[16]),
      obExtTalkSec: dcSheetNum_(g[17]),
    });
  }
  return { rows: rows, coverageStart: coverageStart, maxDate: maxDate, present: present };
}

/** Scope/prior kpi sums over normalized rows (the priorKpiSel shape). */
function dcSumKpis_(rows) {
  var k = { ibAnswered: 0, ibMissedFree: 0, ibMissedBusy: 0, ibTalkSec: 0,
            obTotal: 0, obConnected: 0, obTalkSec: 0 };
  rows.forEach(function (r) {
    k.ibAnswered += r.ibIntAnswered + r.ibExtAnswered;
    k.ibMissedFree += r.ibIntMissedFree + r.ibExtMissedFree;
    k.ibMissedBusy += r.ibIntMissedBusy + r.ibExtMissedBusy;
    k.ibTalkSec += r.ibIntTalkSec + r.ibExtTalkSec;
    k.obTotal += r.obIntTotal + r.obExtTotal;
    k.obConnected += r.obIntConnected + r.obExtConnected;
    k.obTalkSec += r.obIntTalkSec + r.obExtTalkSec;
    ['ibIntAnswered', 'ibExtAnswered', 'ibIntMissedFree', 'ibExtMissedFree', 'ibIntMissedBusy', 'ibExtMissedBusy',
     'obIntTotal', 'obExtTotal', 'obIntConnected', 'obExtConnected'].forEach(function (f) {
      k[f] = (k[f] || 0) + (r[f] || 0);   // D1: the split, the SQL's camelCase kpi keys
    });
  });
  return k;
}

/**
 * Best-effort sheet fallback: builds the SAME intermediate aggregate object
 * the Neon query returns and shapes it through directCallShapePayload_.
 * On any failure degrades to the pre-fallback behavior (available=false).
 */
function directCallSheetFallback_(scope, empty) {
  try {
    var pw0 = computePriorWindow_(scope.from, scope.to);
    var res = directCallSheetRows_(pw0.from, scope.to);   // one read covers both windows (a clamp only narrows them)
    if (!res) { empty.meta.available = false; return empty; }
    // D1: the SAME coverage rule as the Neon path, from the sheet's dates.
    var cov = dcCoverage_(scope, res.maxDate || null, res.present || {}, dcHolidayFn_());
    if (cov.noData) { var e0 = dcApplyCoverageMeta_(empty, cov); e0.meta.fallbackSource = 'sheet'; return e0; }
    var pw = cov.pw, effTo = cov.to;
    var deptF = scope.companyView ? null : scope.dept;
    var cur = [], prior = [];
    res.rows.forEach(function (r) {
      if (deptF && r.dept !== deptF) return;
      if (r.date >= scope.from && r.date <= effTo) cur.push(r);
      else if (r.date >= pw.from && r.date <= pw.to) prior.push(r);
    });

    // kpis: scope sums + DISTINCT agent_name count (the SQL counts names,
    // not (agent, dept) pairs -- a crossover agent is one person).
    var kpis = dcSumKpis_(cur);
    var names = {};
    cur.forEach(function (r) { names[r.agent] = true; });
    kpis.agents = Object.keys(names).length;

    // agents: per-(agent, dept) rows (B-1), snake_case keys matching the
    // SQL aliases so directCallShapeAgent_ consumes them unchanged; ordered
    // ib_answered DESC then agent ASC like the SQL's ORDER BY.
    var byAgent = {};
    cur.forEach(function (r) {
      var key = r.agent + ' ' + r.dept;
      var a = byAgent[key] || (byAgent[key] = {
        agent: r.agent, dept: r.dept,
        ib_answered: 0, ib_missed_free: 0, ib_missed_busy: 0, ib_talk_sec: 0,
        ib_int_answered: 0, ib_ext_answered: 0,
        ob_total: 0, ob_connected: 0, ob_talk_sec: 0,
        ob_int_total: 0, ob_ext_total: 0,
        ib_int_missed_free: 0, ib_ext_missed_free: 0, ib_int_missed_busy: 0, ib_ext_missed_busy: 0,
        ob_int_connected: 0, ob_ext_connected: 0,
      });
      a.ib_answered += r.ibIntAnswered + r.ibExtAnswered;
      a.ib_missed_free += r.ibIntMissedFree + r.ibExtMissedFree;
      a.ib_missed_busy += r.ibIntMissedBusy + r.ibExtMissedBusy;
      a.ib_talk_sec += r.ibIntTalkSec + r.ibExtTalkSec;
      a.ib_int_answered += r.ibIntAnswered;
      a.ib_ext_answered += r.ibExtAnswered;
      a.ob_total += r.obIntTotal + r.obExtTotal;
      a.ob_connected += r.obIntConnected + r.obExtConnected;
      a.ob_talk_sec += r.obIntTalkSec + r.obExtTalkSec;
      a.ob_int_total += r.obIntTotal;
      a.ob_ext_total += r.obExtTotal;
      a.ib_int_missed_free += r.ibIntMissedFree; a.ib_ext_missed_free += r.ibExtMissedFree;
      a.ib_int_missed_busy += r.ibIntMissedBusy; a.ib_ext_missed_busy += r.ibExtMissedBusy;
      a.ob_int_connected += r.obIntConnected; a.ob_ext_connected += r.obExtConnected;
    });
    var agents = Object.keys(byAgent).map(function (k2) { return byAgent[k2]; })
      .sort(function (a, b) {
        return (b.ib_answered - a.ib_answered)
            || (a.agent < b.agent ? -1 : (a.agent > b.agent ? 1 : 0));
      });

    // deptsPrior: per-dept prior aggregates (snake_case, the t2 shape).
    var byDept = {};
    prior.forEach(function (r) {
      var d = byDept[r.dept] || (byDept[r.dept] = {
        dept: r.dept, ib_answered: 0, ib_missed_free: 0, ib_missed_busy: 0, ob_total: 0,
      });
      d.ib_answered += r.ibIntAnswered + r.ibExtAnswered;
      d.ib_missed_free += r.ibIntMissedFree + r.ibExtMissedFree;
      d.ib_missed_busy += r.ibIntMissedBusy + r.ibExtMissedBusy;
      d.ob_total += r.obIntTotal + r.obExtTotal;
    });

    var out = directCallShapePayload_(scope, {
      kpis: kpis,
      agents: agents,
      // The SQL's kpisPrior sub-select always returns the object (zero sums
      // over an empty window), never null -- mirror that.
      kpisPrior: dcSumKpis_(prior),
      deptsPrior: Object.keys(byDept).map(function (k3) { return byDept[k3]; }),
      coverageStart: res.coverageStart,
    });
    out.meta.fallbackSource = 'sheet';
    out.meta.to = effTo;
    return dcApplyCoverageMeta_(out, cov);
  } catch (e) {
    Logger.log('directCallSheetFallback_ failed (best-effort): '
               + (e && e.message ? e.message : e));
    empty.meta.available = false;
    return empty;
  }
}

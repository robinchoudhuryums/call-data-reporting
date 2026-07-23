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
 * Caching: 30 min (REPORT_CACHE_TTL_SECONDS) per (dept, from, to) under
 * DIRECT_CALL_CACHE_KEY_PREFIX. Unavailable payloads are intentionally NOT
 * cached so a transient Neon failure isn't pinned for the TTL (Inbound model).
 */

// v1: initial -- team KPIs + per-agent rows (inbound answer rate excluding
// the busy carve-out, inbound ATT, outbound activity + ATT, int/ext split).
// v2 (R11-M): adds `kpisPrior` (scope-level, over the INV-28 immediately-
// preceding same-length window) + `deptsPrior` (per-dept prior aggregates) so
// the client renders delta/trend chips on the KPI cards + dept header rows.
const DIRECT_CALL_CACHE_KEY_PREFIX = 'directCall:v2';
const DIRECT_CALL_MAX_RANGE_DAYS = 366;

/**
 * Shared request gate: resolves the caller, validates from/to, resolves dept
 * scope. Returns { from, to, dept, companyView, user }. Mirrors
 * inboundResolveRequest_ (incl. the temporary admin-only vetting gate).
 */
function directCallResolveRequest_(req) {
  const email = Session.getActiveUser().getEmail();
  const user = resolveUser_(email);
  if (user.role === 'none') throw new Error('Not authorized.');
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
                 + ':' + scope.from + ':' + scope.to;
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
  if (data.meta.available) {
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
    if (!conn) { empty.meta.available = false; return empty; }

    // from/to are validated ISO; the dept literal is escaped (and is itself a
    // roster-derived dept header, not free user text). ONE query, ONE getString.
    const deptPred = scope.companyView ? '' : ' AND c.department = ' + directCallSqlLit_(scope.dept);
    const dr = "c.call_date BETWEEN '" + from + "'::date AND '" + to + "'::date" + deptPred;
    // v2: INV-28 immediately-preceding same-length window for the delta chips.
    const pw = computePriorWindow_(from, to);
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
            "'obTalkSec', COALESCE(sum(ob_int_talk_sec+ob_ext_talk_sec),0)" +
          ") FROM direct_call_history c WHERE " + dr + "), " +
        "'agents', (SELECT COALESCE(json_agg(t ORDER BY t.ib_answered DESC, t.agent), '[]') FROM (" +
            "SELECT agent_name AS agent, max(department) AS dept, " +
              "sum(ib_int_answered+ib_ext_answered) AS ib_answered, " +
              "sum(ib_int_missed_free+ib_ext_missed_free) AS ib_missed_free, " +
              "sum(ib_int_missed_busy+ib_ext_missed_busy) AS ib_missed_busy, " +
              "sum(ib_int_talk_sec+ib_ext_talk_sec) AS ib_talk_sec, " +
              "sum(ib_int_answered) AS ib_int_answered, sum(ib_ext_answered) AS ib_ext_answered, " +
              "sum(ob_int_total+ob_ext_total) AS ob_total, " +
              "sum(ob_int_connected+ob_ext_connected) AS ob_connected, " +
              "sum(ob_int_talk_sec+ob_ext_talk_sec) AS ob_talk_sec, " +
              "sum(ob_int_total) AS ob_int_total, sum(ob_ext_total) AS ob_ext_total " +
            "FROM direct_call_history c WHERE " + dr + " GROUP BY agent_name) t), " +
        // v2 prior window (deltas):
        "'kpisPrior', (SELECT " + priorKpiSel + " FROM direct_call_history c WHERE " + priorDr + "), " +
        "'deptsPrior', (SELECT COALESCE(json_agg(t2), '[]') FROM (" +
            "SELECT department AS dept, " +
              "sum(ib_int_answered+ib_ext_answered) AS ib_answered, " +
              "sum(ib_int_missed_free+ib_ext_missed_free) AS ib_missed_free, " +
              "sum(ib_int_missed_busy+ib_ext_missed_busy) AS ib_missed_busy, " +
              "sum(ob_int_total+ob_ext_total) AS ob_total " +
            "FROM direct_call_history c WHERE " + priorDr + " GROUP BY department) t2)" +
      ")::text AS j";

    const stmt = conn.createStatement();
    const rs = stmt.executeQuery(sql);
    const json = rs.next() ? rs.getString('j') : null;
    rs.close(); stmt.close();
    if (!json) { empty.meta.available = false; return empty; }

    const obj = JSON.parse(json);
    const k = obj.kpis || {};
    const agents = (obj.agents || []).map(directCallShapeAgent_);
    const ibAnswered = Number(k.ibAnswered) || 0;
    const ibMissedFree = Number(k.ibMissedFree) || 0;
    const ibTalkSec = Number(k.ibTalkSec) || 0;
    const obConnected = Number(k.obConnected) || 0;
    const obTalkSec = Number(k.obTalkSec) || 0;
    return {
      meta: {
        from: from, to: to, department: scope.dept || '',
        companyView: scope.companyView, available: true, vetting: true,
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
  } catch (e) {
    Logger.log('computeDirectCallReport_ failed: ' + (e && e.message ? e.message : e));
    empty.meta.available = false;
    return empty;
  } finally {
    try { if (conn) conn.close(); } catch (ce) {}
  }
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
  };
}

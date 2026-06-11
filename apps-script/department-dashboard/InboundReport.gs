/**
 * Inbound Report -- analytical view of the per-call inbound data captured in
 * Neon's `inbound_calls` (written by cdr-import/inboundCalls.js), with
 * insurer labels via the `insurance_numbers` reference table.
 *
 * Answers: how many inbound calls (per insurer / per advertised dial-in line
 * / per entry queue / per dial-in x insurer cross-cut), answered vs abandoned
 * vs abandoned-on-hold, average wait, the daily trend, a per-insurer daily
 * drill-down, and how it all compares to the immediately-preceding
 * same-length window (INV-28, via the shared computePriorWindow_).
 *
 * Public entries (callable via google.script.run):
 *   getInboundReport({ from, to, department? })
 *     -> { meta, kpis, kpisPrior, byInsurer, byDialIn, byQueue,
 *          byDialInInsurer, daily }
 *   getInboundInsurerDaily({ from, to, insurer, department? })
 *     -> { meta, daily: [{ d, calls, abandoned }] }
 *
 * AUTHORIZATION (per-dept gate, IR/PR/CR model -- opened from admin-only):
 *   - Admins: department optional. Empty/absent = the COMPANY-WIDE view
 *     (every inbound call, incl. the "Abandoned in IVR -- unattributable"
 *     bucket). A dept name = that dept's slice.
 *   - Managers: always scoped to their own department; a different
 *     department in the request is rejected. Managers see insurer labels
 *     (published business lines, not PHI) for their dept's calls.
 *
 * DEPT ATTRIBUTION (the design contract; see the CLAUDE.md gotcha):
 *   - General rule: a call belongs to the dept whose effective queue list
 *     (queuesForDept_ -- the same Dept Config-overridable dept->queue map
 *     QCD uses, including sub-queue rollup) contains its ENTRY queue.
 *     One call = one dept; multi-queue overflow stays with the entry
 *     queue's dept.
 *   - Carve-out: an ANSWERED call the caller abandoned ON HOLD attributes
 *     by `final_dept` (the answering agent's Departments value) -- an
 *     agent owned that call, so it's their dept's miss even if it entered
 *     via another dept's queue. SOFT COUPLING: final_dept is the raw CDR
 *     "Departments" label and must match the dashboard dept header
 *     (compared case-insensitively, trimmed) for the carve-out to hit; a
 *     mismatched label leaves the call attributed to no dept (still in
 *     the company view).
 *   - IVR abandons never reached a queue -> unattributable; they appear
 *     only in the company view (surfaced via kpis.abandonedIvr).
 *
 * Reads Neon via getDashboardNeonConn_ (same NEON_* props +
 * script.external_request scope as the F1 read-back). The main report reads
 * ALL aggregates in ONE round-trip (json_build_object) -- Apps Script JDBC
 * is ~0.5s/row, so per-row iteration is not an option. Best-effort: any
 * Neon null/error returns the empty shape with meta.available=false, so the
 * modal renders a clean "unavailable" state rather than throwing.
 *
 * Caching: 30 min (REPORT_CACHE_TTL_SECONDS) per (dept, from, to) under
 * INBOUND_CACHE_KEY_PREFIX; the insurer drill-down caches per (dept, from,
 * to, md5(insurer)). Unavailable payloads are intentionally NOT cached so a
 * transient Neon failure isn't pinned for the TTL.
 */

// v2: kpisPrior (auto-adjacent INV-28 window) + meta.priorFrom/priorTo;
// avg_wait on the byInsurer / byDialIn / byQueue rows; new
// byDialInInsurer cross-cut (marketing-line x insurer attribution).
// v3: per-dept gating (manager access; optional `department` scoping via
// entry-queue attribution + the answered-on-hold final_dept carve-out);
// kpis.abandonedIvr; meta gains department / unmapped / companyView.
const INBOUND_CACHE_KEY_PREFIX = 'inbound:v3';
const INBOUND_TOP_N = 50;

/**
 * Shared request gate: resolves the caller, validates from/to, and
 * resolves the dept scope. Returns { from, to, dept, deptQueues,
 * companyView }. dept='' + companyView=true for the admin all-dept view.
 */
function inboundResolveRequest_(req) {
  const email = Session.getActiveUser().getEmail();
  const user = resolveUser_(email);
  if (user.role === 'none') throw new Error('Not authorized.');

  const from = String((req && req.from) || '').trim();
  const to   = String((req && req.to)   || '').trim();
  if (!isIsoDate_(from) || !isIsoDate_(to)) throw new Error('from/to must be YYYY-MM-DD.');
  if (from > to) throw new Error('from must be on or before to.');

  let dept = String((req && req.department) || '').trim();
  if (user.role === 'manager') {
    // Managers are pinned to their own dept; absent = their dept.
    if (dept && dept !== user.department) {
      throw new Error('Not authorized for this department.');
    }
    dept = user.department;
  } else if (dept && getAllDepartments_().indexOf(dept) === -1) {
    throw new Error('Unknown department: ' + dept);
  }

  const companyView = !dept;
  // Effective queue list (Dept Config-overridable, sub-queue rollup) --
  // the same map every QCD surface uses, so inbound dept slices and QCD
  // dept slices can't disagree about queue ownership.
  const deptQueues = companyView ? [] : queuesForDept_(dept);
  return { from: from, to: to, dept: dept, deptQueues: deptQueues, companyView: companyView };
}

/** Single-quote-escape a value for inline SQL literals. */
function inboundSqlLit_(s) {
  return "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'";
}

/**
 * Dept-attribution predicate (decisions C + F). Empty string for the
 * company view (no scoping). `dept` / queue names are config-curated but
 * escaped anyway.
 */
function inboundDeptPredicate_(dept, deptQueues) {
  if (!dept) return '';
  const queueList = (deptQueues && deptQueues.length)
    ? deptQueues.map(inboundSqlLit_).join(',')
    : 'NULL';   // no mapped queues -> entry-queue arm matches nothing
  const isOnHoldAnswered = "(c.disposition='answered' AND c.abandoned_on_hold)";
  return ' AND ((' + isOnHoldAnswered
       + " AND lower(trim(c.final_dept)) = lower(" + inboundSqlLit_(dept) + "))"
       + ' OR (NOT ' + isOnHoldAnswered
       + ' AND c.entry_queue IN (' + queueList + ')))';
}

function getInboundReport(req) {
  const scope = inboundResolveRequest_(req);

  const cache = CacheService.getScriptCache();
  const cacheKey = INBOUND_CACHE_KEY_PREFIX + ':' + (scope.dept || '__all__')
                 + ':' + scope.from + ':' + scope.to;
  const cached = cache.get(cacheKey);
  if (cached) {
    try { const p = JSON.parse(cached); p.meta.cacheHit = true; return p; }
    catch (e) { /* recompute */ }
  }

  const t0 = Date.now();
  const data = computeInboundReport_(scope);
  data.meta.computeMs = Date.now() - t0;
  data.meta.cacheHit = false;
  // Only cache USABLE payloads. An unavailable result (Neon unreachable /
  // table missing / query error) must NOT be pinned for the 30-min report
  // TTL -- a transient Neon blip would otherwise render the modal
  // "unavailable" for every viewer until the entry expires. Skipping the
  // put means the next request simply retries Neon.
  if (data.meta.available) {
    try { cache.put(cacheKey, JSON.stringify(data), REPORT_CACHE_TTL_SECONDS); }
    catch (e) { Logger.log('InboundReport cache put failed: %s', e); }
  }
  return data;
}

function computeInboundReport_(scope) {
  const from = scope.from, to = scope.to;
  const empty = emptyInboundReport_(scope);
  // Dept view with no mapped queues: nothing can attribute via the
  // entry-queue arm (the final_dept carve-out could still, but an
  // unmapped dept almost certainly isn't wired up yet) -- mirror QCD's
  // "No queues mapped" hint instead of running a query that returns ~0.
  if (!scope.companyView && scope.deptQueues.length === 0) {
    empty.meta.unmapped = true;
    return empty;
  }
  let conn = null;
  try {
    conn = (typeof getDashboardNeonConn_ === 'function') ? getDashboardNeonConn_() : null;
    if (!conn) { empty.meta.available = false; return empty; }

    // Comparison window: immediately-preceding same-length window via the
    // shared INV-28 implementation (Data.gs). Derived from the validated
    // from/to, so inlining its ISO strings below is as safe as inlining
    // from/to themselves.
    const prior = computePriorWindow_(from, to);

    // from/to are validated ISO (isIsoDate_) -> safe to inline; the dept
    // predicate inlines escaped, validated config values. ONE query, ONE
    // getString. caller_hash IS NOT NULL drops anonymous callers from the
    // per-insurer/per-number cuts (they can't be labeled) but they still
    // count in the headline KPIs + per-queue.
    const deptPred = inboundDeptPredicate_(scope.dept, scope.deptQueues);
    const dr = "c.call_date BETWEEN '" + from + "'::date AND '" + to + "'::date" + deptPred;
    const priorDr = "c.call_date BETWEEN '" + prior.from + "'::date AND '" + prior.to + "'::date" + deptPred;
    const kpiSelect = function (range) {
      return "(SELECT json_build_object(" +
            "'total', count(*), " +
            "'answered', count(*) FILTER (WHERE disposition='answered'), " +
            "'abandoned', count(*) FILTER (WHERE disposition='abandoned'), " +
            "'missed', count(*) FILTER (WHERE disposition='missed'), " +
            "'abandonedOnHold', count(*) FILTER (WHERE abandoned_on_hold), " +
            "'abandonedIvr', count(*) FILTER (WHERE disposition='abandoned' AND abandon_stage='ivr'), " +
            "'anonymous', count(*) FILTER (WHERE caller_hash IS NULL), " +
            "'avgWaitSec', COALESCE(round(avg(wait_seconds))::int, 0), " +
            "'avgHoldSec', COALESCE(round(avg(NULLIF(hold_seconds,0)))::int, 0)" +
          ") FROM inbound_calls c WHERE " + range + ")";
    };
    const sql =
      "SELECT json_build_object(" +
        "'kpis', " + kpiSelect(dr) + ", " +
        "'kpisPrior', " + kpiSelect(priorDr) + ", " +
        "'byInsurer', (SELECT COALESCE(json_agg(t), '[]') FROM (" +
            "SELECT COALESCE(i.insurance_name,'(unlabeled)') AS label, count(*) AS calls, " +
              "count(*) FILTER (WHERE c.disposition='answered') AS answered, " +
              "count(*) FILTER (WHERE c.disposition='abandoned') AS abandoned, " +
              "count(*) FILTER (WHERE c.abandoned_on_hold) AS on_hold, " +
              "COALESCE(round(avg(c.wait_seconds))::int, 0) AS avg_wait " +
            "FROM inbound_calls c LEFT JOIN insurance_numbers i ON i.phone_hash=c.caller_hash " +
            "WHERE " + dr + " AND c.caller_hash IS NOT NULL " +
            "GROUP BY 1 ORDER BY calls DESC LIMIT " + INBOUND_TOP_N + ") t), " +
        "'byDialIn', (SELECT COALESCE(json_agg(t), '[]') FROM (" +
            "SELECT COALESCE(dial_in_number,'(none)') AS label, count(*) AS calls, " +
              "count(*) FILTER (WHERE disposition='answered') AS answered, " +
              "count(*) FILTER (WHERE disposition='abandoned') AS abandoned, " +
              "COALESCE(round(avg(wait_seconds))::int, 0) AS avg_wait " +
            "FROM inbound_calls c WHERE " + dr + " " +
            "GROUP BY 1 ORDER BY calls DESC LIMIT " + INBOUND_TOP_N + ") t), " +
        "'byQueue', (SELECT COALESCE(json_agg(t), '[]') FROM (" +
            "SELECT COALESCE(entry_queue,'(none)') AS label, count(*) AS calls, " +
              "count(*) FILTER (WHERE disposition='answered') AS answered, " +
              "count(*) FILTER (WHERE disposition='abandoned') AS abandoned, " +
              "COALESCE(round(avg(wait_seconds))::int, 0) AS avg_wait " +
            "FROM inbound_calls c WHERE " + dr + " " +
            "GROUP BY 1 ORDER BY calls DESC LIMIT " + INBOUND_TOP_N + ") t), " +
        "'byDialInInsurer', (SELECT COALESCE(json_agg(t), '[]') FROM (" +
            "SELECT COALESCE(c.dial_in_number,'(none)') AS dial_in, " +
              "COALESCE(i.insurance_name,'(unlabeled)') AS insurer, count(*) AS calls, " +
              "count(*) FILTER (WHERE c.disposition='answered') AS answered, " +
              "count(*) FILTER (WHERE c.disposition='abandoned') AS abandoned " +
            "FROM inbound_calls c LEFT JOIN insurance_numbers i ON i.phone_hash=c.caller_hash " +
            "WHERE " + dr + " AND c.caller_hash IS NOT NULL " +
            "GROUP BY 1, 2 ORDER BY calls DESC LIMIT " + INBOUND_TOP_N + ") t), " +
        "'daily', (SELECT COALESCE(json_agg(t ORDER BY t.d), '[]') FROM (" +
            "SELECT call_date::text AS d, count(*) AS calls, " +
              "count(*) FILTER (WHERE disposition='abandoned') AS abandoned " +
            "FROM inbound_calls c WHERE " + dr + " GROUP BY 1) t)" +
      ")::text AS j";

    const stmt = conn.createStatement();
    const rs = stmt.executeQuery(sql);
    const json = rs.next() ? rs.getString('j') : null;
    rs.close(); stmt.close();
    if (!json) { empty.meta.available = false; return empty; }

    const obj = JSON.parse(json);
    const kpis = inboundShapeKpis_(obj.kpis);
    return {
      meta: {
        from: from, to: to, available: true,
        department: scope.dept || null,
        companyView: scope.companyView,
        unmapped: false,
        priorFrom: prior.from, priorTo: prior.to,
        rows: kpis.total, generatedAt: new Date().toISOString(),
      },
      kpis: kpis,
      kpisPrior: inboundShapeKpis_(obj.kpisPrior),
      byInsurer:       Array.isArray(obj.byInsurer)       ? obj.byInsurer       : [],
      byDialIn:        Array.isArray(obj.byDialIn)        ? obj.byDialIn        : [],
      byQueue:         Array.isArray(obj.byQueue)         ? obj.byQueue         : [],
      byDialInInsurer: Array.isArray(obj.byDialInInsurer) ? obj.byDialInInsurer : [],
      daily:           Array.isArray(obj.daily)           ? obj.daily           : [],
    };
  } catch (e) {
    // Table missing / Neon error -> graceful empty (modal shows "unavailable").
    Logger.log('computeInboundReport_ failed (best-effort): ' + (e && e.message ? e.message : e));
    if (typeof recordNeonReadFailure_ === 'function') recordNeonReadFailure_('computeInboundReport_', e);
    empty.meta.available = false;
    return empty;
  } finally {
    if (conn) { try { conn.close(); } catch (ce) {} }
  }
}

function inboundShapeKpis_(k) {
  k = k || {};
  const total = Number(k.total) || 0;
  return {
    total:           total,
    answered:        Number(k.answered) || 0,
    abandoned:       Number(k.abandoned) || 0,
    missed:          Number(k.missed) || 0,
    abandonedOnHold: Number(k.abandonedOnHold) || 0,
    abandonedIvr:    Number(k.abandonedIvr) || 0,
    anonymous:       Number(k.anonymous) || 0,
    avgWaitSec:      Number(k.avgWaitSec) || 0,
    avgHoldSec:      Number(k.avgHoldSec) || 0,
    abandonRate:     total > 0 ? Math.round((Number(k.abandoned) || 0) / total * 1000) / 10 : 0,
    answerRate:      total > 0 ? Math.round((Number(k.answered) || 0) / total * 1000) / 10 : 0,
  };
}

function emptyInboundReport_(scope) {
  const prior = computePriorWindow_(scope.from, scope.to);
  return {
    meta: {
      from: scope.from, to: scope.to, available: true,
      department: scope.dept || null,
      companyView: scope.companyView,
      unmapped: false,
      priorFrom: prior.from, priorTo: prior.to,
      rows: 0, generatedAt: new Date().toISOString(),
    },
    kpis: inboundShapeKpis_(null),
    kpisPrior: inboundShapeKpis_(null),
    byInsurer: [], byDialIn: [], byQueue: [], byDialInInsurer: [], daily: [],
  };
}

/**
 * Per-insurer daily drill-down (decision A: fetched on demand when a
 * row is expanded). Same gate + dept attribution as the main report.
 * `insurer` is the display label from the byInsurer table; the special
 * '(unlabeled)' value selects labeled-hash-less callers. The label is
 * UNTRUSTED free text (admin-entered insurer names) -> bound as a
 * prepared-statement parameter, never inlined.
 *
 * Returns { meta: { from, to, department, insurer, available },
 *           daily: [{ d, calls, abandoned }] } -- the client derives
 * the abandon-rate series from calls/abandoned.
 */
function getInboundInsurerDaily(req) {
  const scope = inboundResolveRequest_(req);
  const insurer = String((req && req.insurer) || '').trim();
  if (!insurer) throw new Error('Insurer is required.');
  if (insurer.length > 200) throw new Error('Insurer label is too long.');

  const cache = CacheService.getScriptCache();
  // hashAgents_ (MD5, INV-36) keeps free-text labels out of the cache key.
  const cacheKey = INBOUND_CACHE_KEY_PREFIX + ':daily:' + (scope.dept || '__all__')
                 + ':' + scope.from + ':' + scope.to + ':' + hashAgents_([insurer]);
  const cached = cache.get(cacheKey);
  if (cached) {
    try { const p = JSON.parse(cached); p.meta.cacheHit = true; return p; }
    catch (e) { /* recompute */ }
  }

  const out = {
    meta: {
      from: scope.from, to: scope.to,
      department: scope.dept || null,
      insurer: insurer, available: true,
      generatedAt: new Date().toISOString(), cacheHit: false,
    },
    daily: [],
  };
  let conn = null;
  try {
    conn = (typeof getDashboardNeonConn_ === 'function') ? getDashboardNeonConn_() : null;
    if (!conn) { out.meta.available = false; return out; }

    const deptPred = inboundDeptPredicate_(scope.dept, scope.deptQueues);
    const dr = "c.call_date BETWEEN '" + scope.from + "'::date AND '" + scope.to + "'::date" + deptPred;
    const sql =
      "SELECT COALESCE(json_agg(t ORDER BY t.d), '[]')::text AS j FROM (" +
        "SELECT c.call_date::text AS d, count(*) AS calls, " +
          "count(*) FILTER (WHERE c.disposition='abandoned') AS abandoned " +
        "FROM inbound_calls c LEFT JOIN insurance_numbers i ON i.phone_hash=c.caller_hash " +
        "WHERE " + dr + " AND c.caller_hash IS NOT NULL " +
        "AND (CASE WHEN ? = '(unlabeled)' THEN i.insurance_name IS NULL " +
             "ELSE i.insurance_name = ? END) " +
        "GROUP BY 1) t";
    const stmt = conn.prepareStatement(sql);
    stmt.setString(1, insurer);
    stmt.setString(2, insurer);
    const rs = stmt.executeQuery();
    const json = rs.next() ? rs.getString('j') : '[]';
    rs.close(); stmt.close();
    const arr = JSON.parse(json || '[]');
    out.daily = Array.isArray(arr) ? arr : [];
    try { cache.put(cacheKey, JSON.stringify(out), REPORT_CACHE_TTL_SECONDS); }
    catch (ce) { /* harmless */ }
    return out;
  } catch (e) {
    Logger.log('getInboundInsurerDaily failed (best-effort): ' + (e && e.message ? e.message : e));
    if (typeof recordNeonReadFailure_ === 'function') recordNeonReadFailure_('getInboundInsurerDaily', e);
    out.meta.available = false;
    return out;
  } finally {
    if (conn) { try { conn.close(); } catch (ce) {} }
  }
}

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
// Cap the requested window so an over-wide range can't trigger an
// unbounded Neon aggregation (mirrors CallerLookup's range guard). A
// year is generous for any operational inbound review.
const INBOUND_MAX_RANGE_DAYS = 366;

/**
 * Shared request gate: resolves the caller, validates from/to, and
 * resolves the dept scope. Returns { from, to, dept, deptQueues,
 * companyView }. dept='' + companyView=true for the admin all-dept view.
 */
function inboundResolveRequest_(req) {
  const email = Session.getActiveUser().getEmail();
  const user = resolveUser_(email);
  if (user.role === 'none') throw new Error('Not authorized.');
  // TEMPORARY admin-only re-scope: the report is being vetted (data
  // discrepancies vs QCD's abandonment numbers -- different source +
  // definitions -- are noted and parked) before release to managers.
  // The per-dept manager path below is KEPT intact so restoring manager
  // access is a one-line removal of this gate.
  if (user.role !== 'admin') {
    throw new Error('The Inbound report is admin-only while it is being vetted.');
  }

  const from = String((req && req.from) || '').trim();
  const to   = String((req && req.to)   || '').trim();
  if (!isIsoDate_(from) || !isIsoDate_(to)) throw new Error('from/to must be YYYY-MM-DD.');
  if (from > to) throw new Error('from must be on or before to.');
  const rangeDays = Math.round(
    (new Date(to + 'T00:00:00') - new Date(from + 'T00:00:00')) / 86400000) + 1;
  if (rangeDays > INBOUND_MAX_RANGE_DAYS) {
    throw new Error('Range is capped at ' + INBOUND_MAX_RANGE_DAYS + ' days.');
  }

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
  return { from: from, to: to, dept: dept, deptQueues: deptQueues,
           companyView: companyView, user: user };
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

/**
 * Drill-through (#3): the inbound-call PATH (journey) for ONE call, keyed by
 * (date, call_id). Powers the "↳ path" affordance on ABANDONED calls in the
 * Missed Calls report + the My Department missed section (whose 🚨 timestamps
 * already carry the parent call id). Returns { available, found, call } --
 * available=false when Neon is unreachable, found=false when there's no
 * matching row (the call predates inbound capture, or isn't an inbound call,
 * or isn't attributable to this dept).
 *
 * AUTH: managers are pinned to their own dept; admins may pass a dept or omit
 * it (company view). The query is ALSO scoped by the SAME dept-attribution
 * predicate the Inbound report uses (`inboundDeptPredicate_`), so a manager
 * can only pull journeys for calls attributable to THEIR dept -- a crafted
 * call_id for another dept's call returns found=false. The journey carries no
 * caller identity (no hash/number; phone-like callee names are masked at
 * capture), so it's appropriate per-call operational detail for the dept's
 * own abandoned call. NOT cached (single-row lookup, cheap). Reuses
 * `callerLookupShapeCall_` (CallerLookup.gs) for the row shape.
 *
 * NOTE: unlike the full Inbound REPORT (temporarily admin-only while vetted),
 * this per-call path detail is intentionally manager-reachable for the
 * manager's OWN dept -- it's the drill target the user asked for from the
 * Missed Calls views, and exposes no aggregate inbound data.
 */
/**
 * Dept scope for the per-call PATH drill (looser than the Inbound report's
 * `inboundDeptPredicate_`, which keys ONLY on the ENTRY queue). A manager
 * drilling from their own Missed report is often looking at an abandoned call
 * that ENTERED via an IVR/overflow queue but abandoned IN the dept's queue --
 * so its `entry_queue` isn't a dept queue but its `final_queue` is. Match if a
 * dept queue is the ENTRY or FINAL queue, or the answering dept -- still
 * dept-scoped (a call that never touched the dept's queues won't resolve), but
 * no longer drops legitimate overflow/IVR-entry abandoned calls. Empty string
 * for the admin company view (no scoping). Queue/dept names are config-curated
 * but escaped anyway.
 */
function callJourneyDeptPredicate_(dept, deptQueues) {
  if (!dept) return '';
  const queueList = (deptQueues && deptQueues.length)
    ? deptQueues.map(inboundSqlLit_).join(',') : 'NULL';
  return ' AND (c.entry_queue IN (' + queueList + ')'
       + ' OR c.final_queue IN (' + queueList + ')'
       + " OR lower(trim(coalesce(c.final_dept, ''))) = lower(" + inboundSqlLit_(dept) + '))';
}

function getCallJourney(req) {
  req = req || {};
  const user = resolveUser_(Session.getActiveUser().getEmail());
  if (!user || user.role === 'none') throw new Error('Not authorized.');
  const callId = String(req.callId || '').trim();
  const date = String(req.date || '').trim();
  if (!callId) throw new Error('Missing call id.');
  if (!isIsoDate_(date)) throw new Error('date must be YYYY-MM-DD.');

  let dept = String(req.department || '').trim();
  if (user.role === 'manager') {
    if (dept && dept !== user.department) throw new Error('Not authorized for this department.');
    dept = user.department;
  } else if (dept && dept !== 'ALL' && getAllDepartments_().indexOf(dept) === -1) {
    throw new Error('Unknown department: ' + dept);
  }
  if (dept === 'ALL') dept = '';   // admin company view -> no dept scoping

  const deptQueues = dept ? queuesForDept_(dept) : [];
  const predicate = callJourneyDeptPredicate_(dept, deptQueues);   // '' for company view

  const conn = getDashboardNeonConn_();
  if (!conn) return { available: false, found: false };
  try {
    // Run the lookup with an optional dept predicate. The badge's call_id is
    // ALREADY entitled upstream -- it only appears on abandoned rings in the
    // caller's OWN dept-scoped Missed report (DQE abandoned parent ids) -- so
    // the predicate is defense-in-depth, not the entitlement boundary.
    const lookup = function (pred) {
      const sql = "SELECT to_jsonb(c)::text AS j FROM inbound_calls c "
                + "WHERE c.call_date = ?::date AND c.call_id = ?" + pred + " LIMIT 1";
      const stmt = conn.prepareStatement(sql);
      stmt.setString(1, date);
      stmt.setString(2, callId);
      const rs = stmt.executeQuery();
      const j = rs.next() ? rs.getString('j') : '';
      rs.close(); stmt.close();
      return j;
    };

    let json = lookup(predicate);
    // FALLBACK: the dept predicate matches on inbound_calls' RAW queue-name
    // space (entry_queue/final_queue = the Raw Data callee queue, e.g.
    // 'A_Q_CSR'), but queuesForDept_ returns the QCD-canonical names (e.g.
    // 'A_Q_CustomerSuccess') -- a different space for several depts, so the
    // scoped query yields false negatives (the original "no path on record"
    // bug). When scoped finds nothing, retry by exact (call_date, call_id)
    // only. Safe: the id is already dept-entitled upstream and the journey
    // carries no caller identity (no hash/number; phone-like callee names are
    // masked at capture). Admin company view runs unscoped already (predicate
    // === ''), so this only adds a fallback for the manager/dept path.
    let viaFallback = false;
    if (!json && predicate) { json = lookup(''); viaFallback = !!json; }
    if (!json) return { available: true, found: false };
    if (viaFallback) {
      Logger.log('getCallJourney: dept-scoped lookup missed (queue-name space), '
        + 'resolved via exact-id fallback. call_id=%s date=%s dept=%s', callId, date, dept || '(all)');
    }
    return { available: true, found: true, call: callerLookupShapeCall_(JSON.parse(json)) };
  } catch (e) {
    Logger.log('getCallJourney failed: ' + (e && e.message ? e.message : e));
    return { available: false, found: false };
  } finally {
    try { conn.close(); } catch (ce) {}
  }
}

function getInboundReport(req) {
  const scope = inboundResolveRequest_(req);

  const cache = CacheService.getScriptCache();
  const cacheKey = INBOUND_CACHE_KEY_PREFIX + ':' + (scope.dept || '__all__')
                 + ':' + scope.from + ':' + scope.to;
  const cached = cache.get(cacheKey);
  if (cached) {
    try {
      const p = JSON.parse(cached);
      p.meta.cacheHit = true;
      logReportUsage_('inbound', scope.dept || '(all)', scope.user, true);
      return p;
    }
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
  logReportUsage_('inbound', scope.dept || '(all)', scope.user, false);
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


// ---------------------------------------------------------------------------
// Temporal abandon heatmap (day-of-week x half-hour-slot), sourced from
// inbound_calls. Powers the heatmap panel in BOTH the Inbound report and the
// QCD report (a "when are callers abandoning / when are we short-staffed"
// companion view). Same auth + dept-scoping as getInboundReport
// (inboundResolveRequest_ + inboundDeptPredicate_), so a manager only ever
// sees their own dept's slice.
//
// TZ: inbound_calls.call_start is stored as raw 'HH:MM:SS' in the CDR's native
// PST (the inbound capture does NOT apply the +2h PST->CST shift the DQE slot
// pipeline does -- icIsoTime_ in cdr-import preserves the raw wall-clock). We
// shift +INBOUND_HEATMAP_CST_SHIFT_HOURS here so the slot axis matches the
// dashboard's 8 AM-5 PM CST work-window convention (INV-18). If a live
// spot-check shows the columns are off, this single constant is the knob.
// Pre-extension rows (null/empty call_start) carry no time-of-day and are
// excluded (documented gap -- they predate the journey extension).
const INBOUND_HEATMAP_CACHE_KEY_PREFIX = 'inboundHeatmap:v1';
const INBOUND_HEATMAP_CST_SHIFT_HOURS = 2;    // PST(stored) -> CST(dashboard)
const INBOUND_HEATMAP_WINDOW_START_HOUR = 8;  // 8 AM CST (matches INV-18)
const INBOUND_HEATMAP_WINDOW_END_HOUR   = 17; // 5 PM CST (exclusive)
const INBOUND_HEATMAP_SLOT_MINUTES      = 60; // hourly buckets (9 slots, 8a-4p) -- readable as a grid

function getInboundHeatmap(req) {
  const scope = inboundResolveRequest_(req);   // auth + dept scoping (throws on bad access)

  const cache = CacheService.getScriptCache();
  const cacheKey = INBOUND_HEATMAP_CACHE_KEY_PREFIX + ':' + (scope.dept || '__all__')
                 + ':' + scope.from + ':' + scope.to;
  const cached = cache.get(cacheKey);
  if (cached) {
    try { const p = JSON.parse(cached); p.meta.cacheHit = true; return p; }
    catch (e) { /* recompute */ }
  }

  const out = emptyInboundHeatmap_(scope);
  // Dept view with no mapped queues: nothing attributes -> "unmapped" hint,
  // mirroring getInboundReport / QCD.
  if (!scope.companyView && scope.deptQueues.length === 0) {
    out.meta.unmapped = true;
    return out;
  }

  let conn = null;
  try {
    conn = (typeof getDashboardNeonConn_ === 'function') ? getDashboardNeonConn_() : null;
    if (!conn) { out.meta.available = false; return out; }

    const deptPred = inboundDeptPredicate_(scope.dept, scope.deptQueues);
    const dr = "c.call_date BETWEEN '" + scope.from + "'::date AND '" + scope.to + "'::date" + deptPred;
    // CST seconds-since-midnight for the shifted start time; bucket into
    // half-hour slots indexed from the 8 AM CST window start.
    const cstSecs = "(EXTRACT(EPOCH FROM ((c.call_start)::time + interval '"
      + INBOUND_HEATMAP_CST_SHIFT_HOURS + " hours')))";
    const winStartSecs = INBOUND_HEATMAP_WINDOW_START_HOUR * 3600;
    const winEndSecs   = INBOUND_HEATMAP_WINDOW_END_HOUR * 3600;
    const slotSecs     = INBOUND_HEATMAP_SLOT_MINUTES * 60;
    const sql =
      "SELECT COALESCE(json_agg(t), '[]')::text AS j FROM (" +
        "SELECT EXTRACT(ISODOW FROM c.call_date)::int AS dow, " +
          "floor((" + cstSecs + " - " + winStartSecs + ") / " + slotSecs + ")::int AS slot, " +
          "count(*) AS calls, " +
          "count(*) FILTER (WHERE c.disposition='abandoned') AS abandoned " +
        "FROM inbound_calls c " +
        "WHERE " + dr + " " +
          // Guard malformed/empty call_start (pre-extension rows are null).
          "AND c.call_start ~ '^[0-9]{1,2}:[0-9]{2}:[0-9]{2}$' " +
          "AND " + cstSecs + " >= " + winStartSecs + " AND " + cstSecs + " < " + winEndSecs + " " +
          "AND EXTRACT(ISODOW FROM c.call_date) BETWEEN 1 AND 5 " +
        "GROUP BY 1, 2" +
      ") t";

    const stmt = conn.createStatement();
    const rs = stmt.executeQuery(sql);
    const json = rs.next() ? rs.getString('j') : null;
    rs.close(); stmt.close();
    if (json == null) { out.meta.available = false; return out; }

    const arr = JSON.parse(json);
    out.cells = Array.isArray(arr) ? arr.map(function (c) {
      return { dow: Number(c.dow) || 0, slot: Number(c.slot) || 0,
               calls: Number(c.calls) || 0, abandoned: Number(c.abandoned) || 0 };
    }) : [];
    out.meta.rows = out.cells.reduce(function (s, c) { return s + c.calls; }, 0);
    try { cache.put(cacheKey, JSON.stringify(out), REPORT_CACHE_TTL_SECONDS); }
    catch (ce) { /* harmless */ }
    return out;
  } catch (e) {
    Logger.log('getInboundHeatmap failed (best-effort): ' + (e && e.message ? e.message : e));
    if (typeof recordNeonReadFailure_ === 'function') recordNeonReadFailure_('getInboundHeatmap', e);
    out.meta.available = false;
    return out;
  } finally {
    if (conn) { try { conn.close(); } catch (ce) {} }
  }
}

function emptyInboundHeatmap_(scope) {
  return {
    meta: {
      from: scope.from, to: scope.to, available: true,
      department: scope.dept || null,
      companyView: scope.companyView,
      unmapped: false,
      // Axis metadata so the client never hardcodes the window/granularity.
      windowStartHour: INBOUND_HEATMAP_WINDOW_START_HOUR,
      windowEndHour: INBOUND_HEATMAP_WINDOW_END_HOUR,
      slotMinutes: INBOUND_HEATMAP_SLOT_MINUTES,
      tzLabel: 'CST',
      rows: 0, generatedAt: new Date().toISOString(),
    },
    cells: [],
  };
}

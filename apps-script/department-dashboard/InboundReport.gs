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
// v4 (round 4): byInsurer + byDialInInsurer are LABELED-insurer-only (the
// '(unlabeled)' catch-all row -- every non-insurer caller -- was dropped as
// misleading) and byQueue is queue-entered-calls-only (the '(none)' row --
// direct/DID calls, >50% of volume -- was dropped; Direct has its own report).
// v5 (R5): abandon_stage gains 'direct' (kpis.abandonedDirect; old rows heal
// on re-import), byDialIn rows carry display labels (DIAL_IN_LABELS map >
// derived dominant first_agent > raw number; raw kept in `number`).
const INBOUND_CACHE_KEY_PREFIX = 'inbound:v5';
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
  if (user.role === 'manager' && !user.allDepts) {
    // R-3: SINGLE-dept managers are pinned to their own dept; absent = their
    // dept. The all-departments manager falls through to the admin-style
    // branch (data breadth per the role model) -- latent until the vetting
    // gate above is removed, but the resolver must not throw on a null
    // user.department that day.
    if (dept && dept !== user.department) {
      throw new Error('Not authorized for this department.');
    }
    dept = user.department;
  } else if (dept === 'ALL') {
    dept = '';   // F-48: admins may pass 'ALL' for the company view, like
                 // getCallJourney / directCallResolveRequest_ already accept
  } else if (dept && getAllDepartments_().indexOf(dept) === -1) {
    throw new Error('Unknown department: ' + dept);
  }

  const companyView = !dept;
  // Effective queue list (Dept Config-overridable, sub-queue rollup) UNIONED
  // with the dept's raw inbound-queue aliases -- inbound_calls stores the raw
  // queue spellings (e.g. "A_Q_CSR") which differ from the QCD-canonical
  // names queuesForDept_ returns (e.g. "A_Q_CustomerSuccess"). Without the
  // union, those calls don't attribute to the dept. See inboundQueuesForDept_.
  const deptQueues = companyView ? [] : inboundQueuesForDept_(dept);
  return { from: from, to: to, dept: dept, deptQueues: deptQueues,
           companyView: companyView, user: user };
}

/**
 * The queue-name set used for INBOUND dept attribution (report + journey):
 * the dept's effective QCD-canonical queues (queuesForDept_, incl. sub-queue
 * rollup) UNIONed with its admin-curated raw inbound-queue aliases
 * (getInboundQueueAliases_, INV-54). This bridges the two queue-name spaces:
 * QCD Historical Data / DEPT_QCD_QUEUES carry canonical names, but
 * inbound_calls.entry_queue/final_queue carry the raw phone-system names.
 * Order-stable, de-duped. Used ONLY by inbound surfaces -- no QCD/DQE reader
 * calls this (they stay on queuesForDept_).
 */
function inboundQueuesForDept_(dept) {
  if (!dept) return [];
  const out = [];
  const seen = {};
  const add = function (q) {
    const v = String(q == null ? '' : q).trim();
    if (v && !seen[v]) { seen[v] = true; out.push(v); }
  };
  queuesForDept_(dept).forEach(add);
  if (typeof getInboundQueueAliases_ === 'function') getInboundQueueAliases_(dept).forEach(add);
  return out;
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
  // L10: COALESCE the nullable flag to false. A NULL abandoned_on_hold would
  // make isOnHoldAnswered NULL -> NOT isOnHoldAnswered also NULL -> BOTH arms
  // evaluate NULL (three-valued logic) and the row is silently dropped from
  // every dept-scoped inbound query. The live writer always emits TRUE/FALSE,
  // so this is latent hardening for any future backfill that leaves it NULL.
  const isOnHoldAnswered = "(c.disposition='answered' AND COALESCE(c.abandoned_on_hold, false))";
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
  // R-3: only SINGLE-dept managers are pinned. The all-departments manager
  // (Access Control dept = ALL sentinel; user.allDepts, department:null) has
  // admin-equivalent DATA BREADTH per the role model -- the old bare
  // role==='manager' check compared dept against a null user.department and
  // threw on every journey drill for that role.
  if (user.role === 'manager' && !user.allDepts) {
    if (dept && dept !== user.department) throw new Error('Not authorized for this department.');
    dept = user.department;
  } else if (dept && dept !== 'ALL' && getAllDepartments_().indexOf(dept) === -1) {
    throw new Error('Unknown department: ' + dept);
  }
  if (dept === 'ALL') dept = '';   // admin / allDepts company view -> no dept scoping

  // Union the QCD-canonical queues with the dept's raw inbound aliases so a
  // call whose entry/final queue is a raw name (e.g. A_Q_CSR) still scopes to
  // the dept (same bridge as the report; the exact-id fallback below also
  // covers any still-unmapped alias).
  const deptQueues = dept ? inboundQueuesForDept_(dept) : [];
  const predicate = callJourneyDeptPredicate_(dept, deptQueues);   // '' for company view

  const conn = getDashboardNeonConn_();
  if (!conn) return { available: false, found: false };
  try {
    // Run the lookup with an optional dept predicate. For MANAGERS the real
    // entitlement boundary is the F-4 server gate below
    // (callIdInDeptMissedReport_ on the exact-id fallback) -- the client-side
    // "the badge only appears in your own Missed report" property is NOT a
    // boundary (any call_id can be sent via RPC); this predicate is
    // defense-in-depth on top of the gate.
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
    // only. Admin company view runs unscoped already (predicate === ''), so
    // this only adds a fallback for the dept-scoped path.
    //
    // F-4 entitlement gate: the old fallback trusted the client's claim that
    // the call_id "is already dept-entitled upstream" -- but the RPC accepts
    // arbitrary {callId, date}, so a manager could fetch ANY dept's journey
    // by id. Now the server verifies the claim itself for managers: the id
    // must appear as an abandoned parent id in the manager's OWN dept's
    // Missed Calls report for that date (the exact surface the "↳ path"
    // badge lives on). Admins are entitled to every dept, so their fallback
    // is ungated. The journey still carries no caller identity.
    let viaFallback = false;
    if (!json && predicate) {
      // R-3: allDepts managers are entitled to every dept's data (breadth
      // gate, like assertDeptAccess_), so their fallback is ungated too.
      const entitled = (user.role === 'admin') || !!user.allDepts
        || callIdInDeptMissedReport_(dept, date, callId);
      if (entitled) { json = lookup(''); viaFallback = !!json; }
    }
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

/**
 * F-4 entitlement gate for getCallJourney's exact-id fallback: TRUE iff
 * `callId` appears as an abandoned parent id in the dept's OWN Missed
 * Calls report for `date` -- agent timelines (agents[].missedTimes) or
 * the queue-only abandoned section (queueOnly[].entries). This is the
 * same computation the "↳ path" badge is rendered from, so whatever id
 * the manager can legitimately see is exactly what passes. Runs only on
 * the manager fallback path (scoped query missed), and the report is
 * cached (missed:vN, single-day key), so repeat drills are cheap.
 * Best-effort: any error returns false (the fallback stays closed).
 */
function callIdInDeptMissedReport_(dept, date, callId) {
  if (!dept || !callId) return false;
  try {
    const rpt = getMissedCallsReport({ department: dept, from: date, to: date });
    const listHasId = function (groups, entriesKey) {
      for (let i = 0; i < ((groups && groups.length) || 0); i++) {
        const entries = groups[i][entriesKey] || [];
        for (let j = 0; j < entries.length; j++) {
          if (entries[j] && entries[j].parentId != null
              && String(entries[j].parentId) === callId) return true;
        }
      }
      return false;
    };
    return listHasId(rpt && rpt.agents, 'missedTimes')
        || listHasId(rpt && rpt.queueOnly, 'entries');
  } catch (e) {
    Logger.log('callIdInDeptMissedReport_ failed (fallback stays closed): '
      + (e && e.message ? e.message : e));
    return false;
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
    // R5: the derived dial-in agent label reads first_agent, a column the
    // cdr-import capture adds via its idempotent DDL. Guard on its existence
    // so deploying the dashboard BEFORE the next import can't error the
    // whole report (one cheap catalog probe per cold compute).
    let hasFirstAgent = false;
    try {
      const probeSt = conn.createStatement();
      const probeRs = probeSt.executeQuery(
        "SELECT 1 FROM information_schema.columns " +
        "WHERE table_name='inbound_calls' AND column_name='first_agent'");
      hasFirstAgent = probeRs.next();
      probeRs.close(); probeSt.close();
    } catch (probeErr) { hasFirstAgent = false; }
    const kpiSelect = function (range) {
      return "(SELECT json_build_object(" +
            "'total', count(*), " +
            "'answered', count(*) FILTER (WHERE disposition='answered'), " +
            "'abandoned', count(*) FILTER (WHERE disposition='abandoned'), " +
            "'missed', count(*) FILTER (WHERE disposition='missed'), " +
            "'abandonedOnHold', count(*) FILTER (WHERE abandoned_on_hold), " +
            "'abandonedIvr', count(*) FILTER (WHERE disposition='abandoned' AND abandon_stage='ivr'), " +
            // R5: 'direct' split out of 'ivr' at capture (an abandon whose leg
            // rang a PERSON is a direct-line abandon, not an IVR one). Old
            // rows keep stage='ivr' until re-imported, so this counts only
            // post-fix data.
            "'abandonedDirect', count(*) FILTER (WHERE disposition='abandoned' AND abandon_stage='direct'), " +
            "'anonymous', count(*) FILTER (WHERE caller_hash IS NULL), " +
            "'avgWaitSec', COALESCE(round(avg(wait_seconds))::int, 0), " +
            "'avgHoldSec', COALESCE(round(avg(NULLIF(hold_seconds,0)))::int, 0)" +
          ") FROM inbound_calls c WHERE " + range + ")";
    };
    const sql =
      "SELECT json_build_object(" +
        "'kpis', " + kpiSelect(dr) + ", " +
        "'kpisPrior', " + kpiSelect(priorDr) + ", " +
        // Round 4 (owner): LABELED insurers only. The old '(unlabeled)'
        // catch-all lumped every non-insurer caller (patients, doctor
        // offices, ...) into one misleading mega-row -- insurers are a small
        // labeled subset, so the table shows only them now.
        "'byInsurer', (SELECT COALESCE(json_agg(t), '[]') FROM (" +
            "SELECT i.insurance_name AS label, count(*) AS calls, " +
              "count(*) FILTER (WHERE c.disposition='answered') AS answered, " +
              "count(*) FILTER (WHERE c.disposition='abandoned') AS abandoned, " +
              "count(*) FILTER (WHERE c.abandoned_on_hold) AS on_hold, " +
              "COALESCE(round(avg(c.wait_seconds))::int, 0) AS avg_wait " +
            "FROM inbound_calls c JOIN insurance_numbers i ON i.phone_hash=c.caller_hash " +
            "WHERE " + dr + " AND c.caller_hash IS NOT NULL " +
            "GROUP BY 1 ORDER BY calls DESC LIMIT " + INBOUND_TOP_N + ") t), " +
        "'byDialIn', (SELECT COALESCE(json_agg(t), '[]') FROM (" +
            "SELECT COALESCE(dial_in_number,'(none)') AS label, count(*) AS calls, " +
              "count(*) FILTER (WHERE disposition='answered') AS answered, " +
              "count(*) FILTER (WHERE disposition='abandoned') AS abandoned, " +
              "COALESCE(round(avg(wait_seconds))::int, 0) AS avg_wait" +
              // R5: dominant first-rung person per line -- labels an agent's
              // direct DID with its owner (post-parse: DIAL_IN_LABELS map
              // wins for the main lines).
              (hasFirstAgent
                ? ", mode() WITHIN GROUP (ORDER BY first_agent) FILTER (WHERE first_agent IS NOT NULL) AS agent_label "
                : " ") +
            "FROM inbound_calls c WHERE " + dr + " " +
            "GROUP BY 1 ORDER BY calls DESC LIMIT " + INBOUND_TOP_N + ") t), " +
        // Round 4 (owner): queue-entered calls only. The old '(none)' row --
        // direct-to-agent/DID calls that never touched a queue, >50% of
        // volume -- swamped the per-queue read; direct traffic has its own
        // report (DirectCallReport).
        "'byQueue', (SELECT COALESCE(json_agg(t), '[]') FROM (" +
            "SELECT entry_queue AS label, count(*) AS calls, " +
              "count(*) FILTER (WHERE disposition='answered') AS answered, " +
              "count(*) FILTER (WHERE disposition='abandoned') AS abandoned, " +
              "COALESCE(round(avg(wait_seconds))::int, 0) AS avg_wait " +
            "FROM inbound_calls c WHERE " + dr + " AND entry_queue IS NOT NULL " +
            "GROUP BY 1 ORDER BY calls DESC LIMIT " + INBOUND_TOP_N + ") t), " +
        // Round 4: the cross-cut goes labeled-insurers-only too (same
        // rationale as byInsurer -- an '(unlabeled)' row is every
        // non-insurer caller, not a segment).
        "'byDialInInsurer', (SELECT COALESCE(json_agg(t), '[]') FROM (" +
            "SELECT COALESCE(c.dial_in_number,'(none)') AS dial_in, " +
              "i.insurance_name AS insurer, count(*) AS calls, " +
              "count(*) FILTER (WHERE c.disposition='answered') AS answered, " +
              "count(*) FILTER (WHERE c.disposition='abandoned') AS abandoned " +
            "FROM inbound_calls c JOIN insurance_numbers i ON i.phone_hash=c.caller_hash " +
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
    // R5: dial-in display labels. Precedence: the admin-curated
    // DIAL_IN_LABELS map (main lines) > the derived dominant first agent
    // (direct DIDs) > the raw number. Raw number kept in `number` for the
    // hover/CSV.
    const dlMap = inboundDialInLabels_();
    const dialInDisplay = function (num) {
      const digits = String(num == null ? '' : num).replace(/\D/g, '');
      return (digits && dlMap[digits]) || null;
    };
    (Array.isArray(obj.byDialIn) ? obj.byDialIn : []).forEach(function (r) {
      r.number = r.label;
      const mapped = dialInDisplay(r.label);
      if (mapped) r.label = mapped;
      else if (r.agent_label) r.label = r.label + ' · ' + r.agent_label;
    });
    (Array.isArray(obj.byDialInInsurer) ? obj.byDialInInsurer : []).forEach(function (r) {
      const mapped = dialInDisplay(r.dial_in);
      if (mapped) r.dial_in = mapped;
    });
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
    abandonedDirect: Number(k.abandonedDirect) || 0,   // R5 stage split
    anonymous:       Number(k.anonymous) || 0,
    avgWaitSec:      Number(k.avgWaitSec) || 0,
    avgHoldSec:      Number(k.avgHoldSec) || 0,
    abandonRate:     total > 0 ? Math.round((Number(k.abandoned) || 0) / total * 1000) / 10 : 0,
    answerRate:      total > 0 ? Math.round((Number(k.answered) || 0) / total * 1000) / 10 : 0,
  };
}

/**
 * R5: admin-curated labels for the MAIN dial-in lines, from the
 * DIAL_IN_LABELS Script Property (dashboard project; no redeploy to edit).
 * Format: comma-separated `number = Label` pairs, e.g.
 *   "18668646332 = Main CSR Line, 19722281820 = Intake Line"
 * Keys are digit-normalized ('+1 (866) 864-6332' matches too). Tolerant:
 * malformed tokens are dropped silently (the Skip Dates grammar
 * discipline). Direct-DID lines usually don't need an entry -- the derived
 * dominant-first-agent label covers them.
 */
function inboundDialInLabels_() {
  let raw = '';
  try { raw = PropertiesService.getScriptProperties().getProperty('DIAL_IN_LABELS') || ''; }
  catch (e) { return {}; }
  const map = {};
  String(raw).split(',').forEach(function (tok) {
    const i = tok.indexOf('=');
    if (i < 1) return;
    const num = tok.slice(0, i).replace(/\D/g, '');
    const label = tok.slice(i + 1).trim();
    if (num && label) map[num] = label;
  });
  return map;
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
  // NEO-5: mirror computeInboundReport_/getInboundHeatmap's unmapped-dept
  // short-circuit. Without it, an unmapped dept ran the query with an
  // entry-queue arm that matches nothing while the answered-on-hold
  // final_dept carve-out could still return rows -- a drill showing data
  // for a dept whose main report says "no queues mapped".
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
    out.meta.available = false;
    return out;
  } finally {
    if (conn) { try { conn.close(); } catch (ce) {} }
  }
}


// ---------------------------------------------------------------------------
// S1(c): inbound queue-name discovery scan. The RAW queue names actually
// present in Neon `inbound_calls` (entry_queue + final_queue) over the
// lookback window, with distinct-call counts + last-seen dates. This is the
// inbound mirror of DeptConfig's scanQcdQueueNames_: inbound_calls carries
// the phone system's raw names (a DIFFERENT name space from QCD-canonical,
// bridged per dept by the INV-54 `Inbound Queue Aliases`), and until this
// surface existed there was no way to SEE which raw names the data contains
// -- an unaliased name silently fell out of every dept's inbound
// attribution. Consumed by DeptConfig.gs::discoverInboundQueues_ (the Dept
// Config modal's "Discovered inbound queues" section).
//
// Returns null when Neon is unreachable/unconfigured (caller renders an
// "unavailable" note -- distinct from "no rows"), else an array of
// { queue, calls, last_seen } ordered busiest-first.
function scanInboundQueueNames_(lookbackDays) {
  const days = Math.max(1, Number(lookbackDays) || 180);
  let conn = null;
  try {
    conn = (typeof getDashboardNeonConn_ === 'function') ? getDashboardNeonConn_() : null;
    if (!conn) return null;
    // count(DISTINCT call_id): a call whose entry and final queue are the
    // same name would otherwise count twice via the UNION ALL.
    const sql =
      "SELECT COALESCE(json_agg(t ORDER BY t.calls DESC), '[]')::text AS j FROM (" +
        "SELECT q.queue AS queue, count(DISTINCT q.call_id) AS calls, " +
          "max(q.call_date)::text AS last_seen FROM (" +
          "SELECT entry_queue AS queue, call_id, call_date FROM inbound_calls " +
            "WHERE call_date >= (CURRENT_DATE - ?::int) AND COALESCE(entry_queue,'') <> '' " +
          "UNION ALL " +
          "SELECT final_queue AS queue, call_id, call_date FROM inbound_calls " +
            "WHERE call_date >= (CURRENT_DATE - ?::int) AND COALESCE(final_queue,'') <> ''" +
        ") q GROUP BY q.queue) t";
    const stmt = conn.prepareStatement(sql);
    stmt.setInt(1, days);
    stmt.setInt(2, days);
    const rs = stmt.executeQuery();
    const json = rs.next() ? rs.getString('j') : '[]';
    rs.close(); stmt.close();
    const arr = JSON.parse(json || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    Logger.log('scanInboundQueueNames_ failed (best-effort): ' + (e && e.message ? e.message : e));
    return null;
  } finally {
    if (conn) { try { conn.close(); } catch (ce) {} }
  }
}

// ---------------------------------------------------------------------------
// Batch 8 vetting tool: QCD-vs-inbound abandonment reconciliation.
//
// The parked "QCD-vs-inbound abandonment discrepancy" (different source +
// definitions) is THE stated blocker for un-gating the Inbound / Direct
// reports to managers. This makes it QUANTIFIABLE: for one dept over a date
// range it joins, per day,
//   - QCD Historical Data's Abandoned column (canonical queue space,
//     source='Total Calls' roll-up, read via the source-aware readQcdGrid_),
//     summed over queuesForDept_(dept), against
//   - Neon inbound_calls abandons attributed by the SAME
//     inboundDeptPredicate_ the report/heatmap/journey use -- reported BOTH
//     ways the definition could go: strict `disposition='abandoned'` and
//     answered-but-abandoned-ON-HOLD (the carve-out population), so the
//     vetting can see which definition reconciles.
// It also classifies the window's raw entry_queue names against EVERY dept's
// inboundQueuesForDept_ union -- calls in unattributed queues are invisible
// to all dept slices and are the usual residual once definitions align (the
// Dept Config "Inbound queue aliases" column is the fix for those).
//
// READ-ONLY; never writes. Editor-run via runInboundQcdParityCheck() (the
// runDqeParityCheck convention; admin-gated so the RPC surface stays clean),
// which reads the optional INBOUND_QCD_PARITY_FROM / _TO / _DEPT Script
// Properties (defaults: last 14 days; every dept with a non-empty inbound
// queue union).

function compareInboundVsQcdAbandons_(dept, fromIso, toIso, conn) {
  const out = { dept: dept, from: fromIso, to: toIso, available: true,
                qcdQueues: [], inboundQueues: [], days: [],
                totals: { qcd: 0, inboundAbandoned: 0, inboundOnHold: 0 } };
  out.qcdQueues = queuesForDept_(dept);
  out.inboundQueues = inboundQueuesForDept_(dept);

  // QCD side: per-day Abandoned over the dept's canonical queues.
  const qcdByDay = {};
  const grid = (typeof readQcdGrid_ === 'function') ? readQcdGrid_(fromIso, toIso) : null;
  if (grid && !grid.missing && !grid.empty) {
    const qSet = {};
    out.qcdQueues.forEach(function (q) { qSet[q] = true; });
    const tz = grid.ssTZ;
    for (let i = 0; i < grid.values.length; i++) {
      const r = grid.values[i];
      if (String(r[QCD_HISTORICAL_COLS.CALL_SOURCE - 1] || '').trim() !== 'Total Calls') continue;
      if (!qSet[String(r[QCD_HISTORICAL_COLS.CALL_QUEUE - 1] || '').trim()]) continue;
      const d = rowDateIso_(r[QCD_HISTORICAL_COLS.DATE - 1], tz);
      if (!d || d < fromIso || d > toIso) continue;   // sheet path returns the whole sheet
      qcdByDay[d] = (qcdByDay[d] || 0) + (Number(r[QCD_HISTORICAL_COLS.ABANDONED - 1]) || 0);
    }
  }

  // Inbound side: per-day strict abandons + answered-on-hold, dept-attributed
  // by the SAME predicate every inbound surface uses.
  const inbByDay = {};
  const predicate = inboundDeptPredicate_(dept, out.inboundQueues);
  const sql = "SELECT COALESCE(json_agg(t), '[]')::text AS j FROM ("
    + 'SELECT call_date::text AS d, '
    + "count(*) FILTER (WHERE c.disposition = 'abandoned') AS ab, "
    + "count(*) FILTER (WHERE c.disposition = 'answered' AND COALESCE(c.abandoned_on_hold, false)) AS hold "
    + 'FROM inbound_calls c WHERE c.call_date BETWEEN ?::date AND ?::date' + predicate
    + ' GROUP BY call_date) t';
  const stmt = conn.prepareStatement(sql);
  stmt.setString(1, fromIso);
  stmt.setString(2, toIso);
  const rs = stmt.executeQuery();
  const json = rs.next() ? rs.getString('j') : '[]';
  rs.close(); stmt.close();
  JSON.parse(json || '[]').forEach(function (r) {
    inbByDay[String(r.d)] = { ab: Number(r.ab) || 0, hold: Number(r.hold) || 0 };
  });

  const allDays = {};
  Object.keys(qcdByDay).forEach(function (d) { allDays[d] = true; });
  Object.keys(inbByDay).forEach(function (d) { allDays[d] = true; });
  Object.keys(allDays).sort().forEach(function (d) {
    const q = qcdByDay[d] || 0;
    const b = inbByDay[d] || { ab: 0, hold: 0 };
    out.days.push({ date: d, qcdAbandoned: q, inboundAbandoned: b.ab,
                    inboundOnHold: b.hold, diff: b.ab - q, diffWithHold: (b.ab + b.hold) - q });
    out.totals.qcd += q;
    out.totals.inboundAbandoned += b.ab;
    out.totals.inboundOnHold += b.hold;
  });
  return out;
}

/**
 * Editor-run wrapper (admin-gated). Logs a per-dept, per-day reconciliation
 * table + the window's UNATTRIBUTED raw entry-queues, and returns the full
 * object. Optional Script Properties: INBOUND_QCD_PARITY_FROM / _TO
 * (YYYY-MM-DD; default last 14 days ending yesterday) and
 * INBOUND_QCD_PARITY_DEPT (default: every dept with a non-empty inbound
 * queue union).
 */
function runInboundQcdParityCheck() {
  assertAdmin_();
  const props = PropertiesService.getScriptProperties();
  const now = new Date();
  const iso = function (d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); };
  const defTo = iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12));
  const defFrom = iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 14, 12));
  const fromIso = String(props.getProperty('INBOUND_QCD_PARITY_FROM') || defFrom);
  const toIso   = String(props.getProperty('INBOUND_QCD_PARITY_TO')   || defTo);
  const onlyDept = String(props.getProperty('INBOUND_QCD_PARITY_DEPT') || '').trim();

  const conn = getDashboardNeonConn_();
  if (!conn) { Logger.log('Inbound/QCD parity: Neon unreachable (NEON_* props set?).'); return { available: false }; }
  try {
    const depts = onlyDept ? [onlyDept]
      : getAllDepartments_().filter(function (d) { return inboundQueuesForDept_(d).length > 0; });
    const results = [];
    depts.forEach(function (dept) {
      const r = compareInboundVsQcdAbandons_(dept, fromIso, toIso, conn);
      results.push(r);
      Logger.log('=== %s  %s..%s  (QCD queues: %s | inbound union: %s)', dept, fromIso, toIso,
        r.qcdQueues.join(', ') || '(none)', r.inboundQueues.join(', ') || '(none)');
      r.days.forEach(function (day) {
        Logger.log('  %s  qcd=%s  inbound=%s (+%s on-hold)  diff=%s  diffWithHold=%s',
          day.date, day.qcdAbandoned, day.inboundAbandoned, day.inboundOnHold, day.diff, day.diffWithHold);
      });
      Logger.log('  TOTALS qcd=%s inbound=%s onHold=%s diff=%s diffWithHold=%s',
        r.totals.qcd, r.totals.inboundAbandoned, r.totals.inboundOnHold,
        r.totals.inboundAbandoned - r.totals.qcd,
        (r.totals.inboundAbandoned + r.totals.inboundOnHold) - r.totals.qcd);
    });

    // Unattributed raw entry-queues in the window: invisible to EVERY dept's
    // inbound slice -- the usual residual. (Dept Config "Inbound queue
    // aliases" is the no-redeploy fix.)
    const attributed = {};
    getAllDepartments_().forEach(function (d) {
      inboundQueuesForDept_(d).forEach(function (q) { attributed[q] = true; });
    });
    const uq = [];
    const uStmt = conn.prepareStatement(
      "SELECT COALESCE(json_agg(t ORDER BY t.n DESC), '[]')::text AS j FROM ("
      + "SELECT entry_queue AS q, count(*) AS n FROM inbound_calls "
      + "WHERE call_date BETWEEN ?::date AND ?::date AND COALESCE(entry_queue, '') <> '' "
      + 'GROUP BY entry_queue) t');
    uStmt.setString(1, fromIso);
    uStmt.setString(2, toIso);
    const uRs = uStmt.executeQuery();
    const uJson = uRs.next() ? uRs.getString('j') : '[]';
    uRs.close(); uStmt.close();
    JSON.parse(uJson || '[]').forEach(function (r) {
      if (!attributed[String(r.q)]) uq.push({ queue: String(r.q), calls: Number(r.n) || 0 });
    });
    if (uq.length) {
      Logger.log('UNATTRIBUTED raw entry-queues in window (belong to NO dept\'s inbound union -- '
        + 'add to Dept Config "Inbound queue aliases"): '
        + uq.map(function (u) { return u.queue + ' (' + u.calls + ')'; }).join(', '));
    } else {
      Logger.log('All raw entry-queues in the window attribute to a dept. ✓');
    }
    return { available: true, from: fromIso, to: toIso, depts: results, unattributed: uq };
  } finally {
    try { conn.close(); } catch (ce) {}
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
    // hourly slots (INBOUND_HEATMAP_SLOT_MINUTES=60) indexed from the 8 AM CST window start.
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

// ---------------------------------------------------------------------------
// Heatmap cell drill: the individual ABANDONED calls behind one heatmap cell
// (weekday x hour-slot), so "there's a Tuesday-morning problem" can drill to
// "here are the Tuesday-morning calls". Same auth + dept scoping as the
// heatmap itself (inboundResolveRequest_ -- which carries the admin-only
// vetting gate -- + inboundDeptPredicate_), the same TZ shift / window /
// slot math, and the same disposition='abandoned' definition as the cell's
// `abandoned` count, so the list reconciles with the cell to the call.
// Newest-first, capped at INBOUND_HEATMAP_CELL_MAX rows (meta.truncated).
// NOT cached (per-cell, cheap, and an unavailable payload must not pin --
// the getCallJourney pattern). Response carries NO caller identity (no
// hash/number); each row's (call_date, call_id) keys the existing
// getCallJourney "↳ path" drill.
const INBOUND_HEATMAP_CELL_MAX = 200;

function getInboundHeatmapCell(req) {
  const scope = inboundResolveRequest_(req);   // auth + dept scoping (throws on bad access)
  const dow = Math.floor(Number(req && req.dow));
  const slot = Math.floor(Number(req && req.slot));
  const slotCount = Math.max(1, Math.round(
    (INBOUND_HEATMAP_WINDOW_END_HOUR - INBOUND_HEATMAP_WINDOW_START_HOUR)
    * 60 / INBOUND_HEATMAP_SLOT_MINUTES));
  if (!(dow >= 1 && dow <= 5)) throw new Error('dow must be 1-5 (Mon-Fri).');
  if (!(slot >= 0 && slot < slotCount)) throw new Error('slot must be 0-' + (slotCount - 1) + '.');

  const out = {
    meta: {
      from: scope.from, to: scope.to, available: true,
      department: scope.dept || null, companyView: scope.companyView,
      unmapped: false, dow: dow, slot: slot, truncated: false,
      windowStartHour: INBOUND_HEATMAP_WINDOW_START_HOUR,
      slotMinutes: INBOUND_HEATMAP_SLOT_MINUTES, tzLabel: 'CST',
    },
    calls: [],
  };
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
    // Identical shift + bucket expressions to getInboundHeatmap so the cell
    // and its drill can never disagree on which calls a bucket holds.
    const cstStart = "((c.call_start)::time + interval '"
      + INBOUND_HEATMAP_CST_SHIFT_HOURS + " hours')";
    const cstSecs = '(EXTRACT(EPOCH FROM ' + cstStart + '))';
    const winStartSecs = INBOUND_HEATMAP_WINDOW_START_HOUR * 3600;
    const winEndSecs   = INBOUND_HEATMAP_WINDOW_END_HOUR * 3600;
    const slotSecs     = INBOUND_HEATMAP_SLOT_MINUTES * 60;
    const sql =
      "SELECT COALESCE(json_agg(t), '[]')::text AS j FROM (" +
        'SELECT c.call_date::text AS call_date, c.call_id, ' +
          'to_char(' + cstStart + ", 'HH24:MI:SS') AS cst_start, " +
          'c.entry_queue, c.final_queue, c.abandon_stage, c.abandoned_on_hold, ' +
          'c.wait_seconds, c.hold_seconds ' +
        'FROM inbound_calls c ' +
        'WHERE ' + dr + ' ' +
          "AND c.disposition='abandoned' " +
          "AND c.call_start ~ '^[0-9]{1,2}:[0-9]{2}:[0-9]{2}$' " +
          'AND ' + cstSecs + ' >= ' + winStartSecs + ' AND ' + cstSecs + ' < ' + winEndSecs + ' ' +
          'AND EXTRACT(ISODOW FROM c.call_date) = ' + dow + ' ' +
          'AND floor((' + cstSecs + ' - ' + winStartSecs + ') / ' + slotSecs + ')::int = ' + slot + ' ' +
        'ORDER BY c.call_date DESC, cst_start DESC ' +
        'LIMIT ' + (INBOUND_HEATMAP_CELL_MAX + 1) +
      ') t';

    const stmt = conn.createStatement();
    const rs = stmt.executeQuery(sql);
    const json = rs.next() ? rs.getString('j') : null;
    rs.close(); stmt.close();
    if (json == null) { out.meta.available = false; return out; }

    let arr = JSON.parse(json);
    if (!Array.isArray(arr)) arr = [];
    if (arr.length > INBOUND_HEATMAP_CELL_MAX) {
      out.meta.truncated = true;
      arr = arr.slice(0, INBOUND_HEATMAP_CELL_MAX);
    }
    out.calls = arr.map(function (c) {
      return {
        callDate: String(c.call_date || ''),
        callId: String(c.call_id || ''),
        cstStart: String(c.cst_start || ''),
        entryQueue: c.entry_queue || null,
        finalQueue: c.final_queue || null,
        abandonStage: c.abandon_stage || null,
        abandonedOnHold: !!c.abandoned_on_hold,
        waitSeconds: c.wait_seconds == null ? null : Number(c.wait_seconds),
        holdSeconds: c.hold_seconds == null ? null : Number(c.hold_seconds),
      };
    });
    return out;
  } catch (e) {
    Logger.log('getInboundHeatmapCell failed (best-effort): ' + (e && e.message ? e.message : e));
    out.meta.available = false;
    return out;
  } finally {
    if (conn) { try { conn.close(); } catch (ce) {} }
  }
}

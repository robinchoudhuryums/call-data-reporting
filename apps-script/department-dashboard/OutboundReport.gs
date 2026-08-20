/**
 * Outbound Report (Batch G) -- the first analytical surface over Neon's
 * per-call `outbound_calls` table (written daily by
 * cdr-import/outboundCalls.js, Option B; previously read ONLY by Caller
 * Lookup). Two questions, in priority order:
 *
 *   1. "Did we call back the ones who abandoned?" -- each dept-attributed,
 *      work-window abandoned inbound call (the same population as the
 *      Inbound report's Abandoned) is matched to the EARLIEST outbound call
 *      to the same caller hash within OUTBOUND_CALLBACK_WINDOW_DAYS.
 *   2. Outbound activity -- per-agent calls / connected / talk / attempts.
 *
 * TWO CAVEATS ARE PART OF THE CONTRACT (they ship as captions in the UI and
 * must never be dropped):
 *   - "Connected" means a Talk>0 Answered external leg. The CDR cannot
 *     distinguish no-answer / voicemail / busy on the unconnected side, so
 *     an un-connected callback attempt still COUNTS as a callback attempt
 *     (we dialed them), and `calledBackConnected` is the stricter subset.
 *   - Dept attribution for AGENTS uses the dialing agent's ROSTER dept
 *     (DO NOT EDIT!, exact INV-04 match via buildDeptsByAgent_), NEVER the
 *     raw CDR org label stored in outbound_calls.department ("Customer
 *     Success", "Inside Sales - Power Mobility") -- that label matches no
 *     dashboard dept header in this install (the same lesson as
 *     inboundDeptPredicate_'s final_dept arm). The SQL deliberately never
 *     selects that column.
 *
 * CALLBACK dept scoping rides the ABANDON side: an abandon belongs to the
 * dept per inboundDeptPredicate_ (entry queue / on-hold label arms), and is
 * work-window-scoped per the owner ruling (out-of-window calls are research
 * data, never a dept metric) via inboundWindowClause_. The callback MATCH is
 * deliberately unscoped -- a callback is a callback no matter which agent or
 * dept dialed it (captioned in the UI). Anonymous abandons (no caller hash)
 * cannot be tracked and are counted separately, never as "not called back".
 *
 * AUTHORIZATION (the Inbound/Direct model): TEMPORARILY admin-only while the
 * numbers are vetted; the per-dept manager path is written and kept intact
 * (R-3 / Tier C shape mirrored from directCallResolveRequest_) so release is
 * a one-line gate removal + un-hiding the data-admin-only menu item.
 *
 * ONE Neon round trip (json_build_object, single getString -- the JDBC
 * discipline), egress-metered. Roster attribution happens dashboard-side
 * AFTER the fetch (the roster lives in the spreadsheet, not Neon): the
 * agents sub-select groups by agent_name only, and the dept view filters to
 * agents on THAT dept's roster. A crossover agent (two roster homes) appears
 * in both depts' views -- whole-agent outbound has no queue dimension, the
 * Phase-0 crossover reality -- and the company view labels them with all
 * homes. Agents on NO roster land under "Unrostered" in the company view and
 * are excluded (with a disclosed count) from dept views.
 *
 * Caching: REPORT_CACHE_TTL_SECONDS per (dept, from, to) under
 * OUTBOUND_CACHE_KEY_PREFIX + reportFreshnessTag_() (the 6 h tier rule:
 * every heavy key carries the freshness anchor). Unavailable payloads are
 * NOT cached. Tracked by cache-version-sync's SPECS (the C2 rule).
 */

// v1: initial -- callback KPIs + per-agent activity + roster attribution.
const OUTBOUND_CACHE_KEY_PREFIX = 'outboundReport:v1';
const OUTBOUND_MAX_RANGE_DAYS = 366;
// An abandon still counts as "called back" if the first matching outbound
// lands within this many CALENDAR days of the abandon (3 covers a Friday
// abandon answered on Monday). Also the reason the report's newest abandons
// can legitimately still be pending -- the client captions that.
const OUTBOUND_CALLBACK_WINDOW_DAYS = 3;

/**
 * Shared request gate -- mirrors directCallResolveRequest_ /
 * inboundResolveRequest_ exactly (the NEO-6 promise: the vetted-report
 * resolvers keep mirror-image semantics, manager branch FIRST).
 */
function outboundResolveRequest_(req) {
  const email = Session.getActiveUser().getEmail();
  const user = resolveUser_(email);
  if (user.role === 'none') throw new Error('Not authorized.');
  // TEMPORARY admin-only re-scope while the callback linkage + roster
  // attribution are vetted. The per-dept manager path below is KEPT intact
  // so restoring manager access is a one-line removal of this gate.
  if (user.role !== 'admin') {
    throw new Error('The Outbound report is admin-only while it is being vetted.');
  }

  const from = String((req && req.from) || '').trim();
  const to   = String((req && req.to)   || '').trim();
  if (!isIsoDate_(from) || !isIsoDate_(to)) throw new Error('from/to must be YYYY-MM-DD.');
  if (from > to) throw new Error('from must be on or before to.');
  const rangeDays = Math.round(
    (new Date(to + 'T00:00:00') - new Date(from + 'T00:00:00')) / 86400000) + 1;
  if (rangeDays > OUTBOUND_MAX_RANGE_DAYS) {
    throw new Error('Range is capped at ' + OUTBOUND_MAX_RANGE_DAYS + ' days.');
  }

  let dept = String((req && req.department) || '').trim();
  if (user.role === 'manager' && !user.allDepts) {
    // R-3: single-dept managers pinned; allDepts takes the admin-style
    // branch. Tier C: a multi-dept manager may pass any assigned dept;
    // blank/ALL -> their first. Latent while the vetting gate stands.
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

function emptyOutboundReport_(scope) {
  return {
    meta: {
      from: scope.from, to: scope.to, department: scope.dept || '',
      companyView: scope.companyView, available: true, vetting: true,
      callbackWindowDays: OUTBOUND_CALLBACK_WINDOW_DAYS,
      coverageStart: null, unrosteredAgents: 0, offRosterAgents: 0,
      cacheHit: false, computeMs: 0,
    },
    kpis: {
      agents: 0, obTotal: 0, obConnected: 0, obConnectRate: null,
      obTalkSec: 0, obAttSec: 0, attempts: 0,
    },
    callback: {
      abandonedTotal: 0, abandonedAnonymous: 0, abandonedTracked: 0,
      calledBack: 0, calledBackConnected: 0, calledBackPct: null,
      medianCallbackSec: null,
    },
    agents: [],
  };
}

function getOutboundReport(req) {
  const scope = outboundResolveRequest_(req);

  const cache = CacheService.getScriptCache();
  const cacheKey = OUTBOUND_CACHE_KEY_PREFIX + ':' + (scope.dept || '__all__')
                 + ':' + scope.from + ':' + scope.to + ':' + reportFreshnessTag_();
  const cached = cache.get(cacheKey);
  if (cached) {
    try {
      const p = JSON.parse(cached);
      p.meta.cacheHit = true;
      logReportUsage_('outbound', scope.dept || '(all)', scope.user, true);
      return p;
    } catch (e) { /* recompute */ }
  }

  const t0 = Date.now();
  const data = computeOutboundReport_(scope);
  data.meta.computeMs = Date.now() - t0;
  data.meta.cacheHit = false;
  if (data.meta.available) {
    try { cache.put(cacheKey, JSON.stringify(data), REPORT_CACHE_TTL_SECONDS); }
    catch (e) { Logger.log('OutboundReport cache put failed: %s', e); }
  }
  logReportUsage_('outbound', scope.dept || '(all)', scope.user, false);
  return data;
}

function computeOutboundReport_(scope) {
  const from = scope.from, to = scope.to;
  const empty = emptyOutboundReport_(scope);
  let conn = null;
  try {
    conn = (typeof getDashboardNeonConn_ === 'function') ? getDashboardNeonConn_() : null;
    if (!conn) { empty.meta.available = false; return empty; }

    // from/to are validated ISO. The abandon side reuses the Inbound report's
    // dept-attribution predicate + work-window clause verbatim, so the
    // callback denominator is EXACTLY the Inbound report's Abandoned
    // population for the same scope -- the two reports must never disagree on
    // what an abandon is.
    const deptQueues = scope.companyView ? [] : inboundQueuesForDept_(scope.dept);
    const abandonWhere = "c.disposition = 'abandoned'"
      + " AND c.call_date BETWEEN '" + from + "'::date AND '" + to + "'::date"
      + ' AND ' + inboundWindowClause_(true)
      + inboundDeptPredicate_(scope.dept, deptQueues);

    // Timestamps: call_start is raw-PST 'HH:MM:SS' text on BOTH tables (the
    // shared INV-18 storage convention), so cross-table ordering needs no TZ
    // shift. NULL call_start (pre-extension rows) coalesces to midnight for
    // ordering -- the date-level match still counts, the delay just skews
    // early -- and delay_sec only feeds the median, where percentile_cont
    // FILTERs to non-negative non-null values.
    const cbLateral =
      'LEFT JOIN LATERAL ('
      +   'SELECT o.connected, EXTRACT(EPOCH FROM ('
      +     "(o.call_date::timestamp + COALESCE(o.call_start,'00:00:00')::interval)"
      +     " - (c.call_date::timestamp + COALESCE(c.call_start,'00:00:00')::interval)"
      +   ')) AS delay_sec '
      +   'FROM outbound_calls o '
      +   'WHERE o.callee_hash = c.caller_hash '            // NULL hash never matches
      +     'AND o.call_date >= c.call_date '
      +     'AND o.call_date <= c.call_date + ' + OUTBOUND_CALLBACK_WINDOW_DAYS + ' '
      +     "AND (o.call_date::timestamp + COALESCE(o.call_start,'00:00:00')::interval)"
      +       " >= (c.call_date::timestamp + COALESCE(c.call_start,'00:00:00')::interval) "
      +   "ORDER BY o.call_date, COALESCE(o.call_start,'00:00:00') LIMIT 1"
      + ') cb ON true';

    // NOTE: the agents sub-select groups by agent_name ONLY and never touches
    // outbound_calls.department (the raw CDR org label) -- roster attribution
    // happens below, dashboard-side. The callback match is likewise
    // deliberately NOT limited to the report window's `to` (a last-day
    // abandon's callback may land after it) nor to the scoped dept's agents.
    const sql =
      'SELECT json_build_object('
      +   "'agents', (SELECT COALESCE(json_agg(t ORDER BY t.ob_total DESC, t.agent), '[]') FROM ("
      +       'SELECT agent_name AS agent, count(*) AS ob_total, '
      +         'count(*) FILTER (WHERE connected) AS ob_connected, '
      +         'COALESCE(sum(talk_seconds),0) AS ob_talk_sec, '
      +         'COALESCE(sum(attempts),0) AS attempts '
      +       "FROM outbound_calls o WHERE o.call_date BETWEEN '" + from + "'::date AND '" + to + "'::date "
      +       'GROUP BY agent_name) t), '
      +   "'callback', (SELECT json_build_object("
      +       "'abandonedTotal', count(*), "
      +       "'abandonedAnonymous', count(*) FILTER (WHERE c.caller_hash IS NULL), "
      +       "'calledBack', count(*) FILTER (WHERE cb.delay_sec IS NOT NULL), "
      +       "'calledBackConnected', count(*) FILTER (WHERE cb.connected), "
      +       "'medianCallbackSec', percentile_cont(0.5) WITHIN GROUP (ORDER BY cb.delay_sec) "
      +         'FILTER (WHERE cb.delay_sec IS NOT NULL AND cb.delay_sec >= 0)'
      +     ') FROM inbound_calls c ' + cbLateral + ' WHERE ' + abandonWhere + '), '
      +   "'coverageStart', (SELECT MIN(call_date)::text FROM outbound_calls)"
      + ')::text AS j';

    const stmt = conn.createStatement();
    const rs = stmt.executeQuery(sql);
    const json = rs.next() ? rs.getString('j') : null;
    if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(json ? json.length : 0);
    rs.close(); stmt.close();
    if (!json) { empty.meta.available = false; return empty; }

    const obj = JSON.parse(json);
    return outboundShapeReport_(scope, obj, buildDeptsByAgent_());
  } catch (e) {
    Logger.log('computeOutboundReport_ failed: ' + (e && e.message ? e.message : e));
    empty.meta.available = false;
    return empty;
  } finally {
    if (conn) { try { conn.close(); } catch (ce) { /* already closed */ } }
  }
}

/**
 * PURE (tests/unit/outbound-report.test.js): roster attribution + KPI
 * derivation over the fetched blob. `deptsByAgent` is the roster map
 * (Data.gs::buildDeptsByAgent_ -- exact INV-04 names, alphabetical homes).
 */
function outboundShapeReport_(scope, obj, deptsByAgent) {
  const out = emptyOutboundReport_(scope);
  out.meta.coverageStart = obj.coverageStart || null;

  let unrostered = 0, offRoster = 0;
  const agents = [];
  (obj.agents || []).forEach(function (r) {
    const name = String(r.agent || '');
    const homes = deptsByAgent[name] || [];
    if (!homes.length) unrostered++;
    if (!scope.companyView) {
      // Dept view: ONLY agents on THIS dept's roster (the caveat: never the
      // raw CDR org label). Off-roster/unrostered dialers are counted for
      // the disclosure caption, not silently dropped.
      if (homes.indexOf(scope.dept) === -1) { offRoster++; return; }
    }
    const obTotal = Number(r.ob_total) || 0;
    const obConnected = Number(r.ob_connected) || 0;
    const obTalkSec = Number(r.ob_talk_sec) || 0;
    agents.push({
      agent: name,
      dept: homes.length ? homes.join(', ') : 'Unrostered',
      obTotal: obTotal,
      obConnected: obConnected,
      obConnectRate: obTotal ? Math.round(obConnected / obTotal * 1000) / 10 : null,
      obTalkSec: obTalkSec,
      obAttSec: obConnected ? Math.round(obTalkSec / obConnected) : 0,
      attempts: Number(r.attempts) || 0,
    });
  });
  out.agents = agents;
  out.meta.unrosteredAgents = unrostered;
  out.meta.offRosterAgents = offRoster;

  // Scope KPIs sum EXACTLY the rows shown (dept view = roster-filtered), so
  // every number reconciles against the table beneath it.
  const k = out.kpis;
  agents.forEach(function (a) {
    k.agents++;
    k.obTotal += a.obTotal; k.obConnected += a.obConnected;
    k.obTalkSec += a.obTalkSec; k.attempts += a.attempts;
  });
  k.obConnectRate = k.obTotal ? Math.round(k.obConnected / k.obTotal * 1000) / 10 : null;
  k.obAttSec = k.obConnected ? Math.round(k.obTalkSec / k.obConnected) : 0;

  const cbRaw = obj.callback || {};
  const cb = out.callback;
  cb.abandonedTotal = Number(cbRaw.abandonedTotal) || 0;
  cb.abandonedAnonymous = Number(cbRaw.abandonedAnonymous) || 0;
  cb.abandonedTracked = cb.abandonedTotal - cb.abandonedAnonymous;
  cb.calledBack = Number(cbRaw.calledBack) || 0;
  cb.calledBackConnected = Number(cbRaw.calledBackConnected) || 0;
  // The rate's denominator is TRACKED abandons only: an anonymous caller
  // CANNOT be called back, so counting them as "not called back" would
  // punish depts for their caller-ID mix.
  cb.calledBackPct = cb.abandonedTracked
    ? Math.round(cb.calledBack / cb.abandonedTracked * 1000) / 10 : null;
  cb.medianCallbackSec = (cbRaw.medianCallbackSec == null)
    ? null : Math.round(Number(cbRaw.medianCallbackSec));
  return out;
}

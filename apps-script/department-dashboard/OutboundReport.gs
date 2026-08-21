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
// v2 (follow-ons): abandon denominator EXCLUDES is_internal rows (v1 missed
// the clause every inbound metric query carries, so its "exactly the Inbound
// report's Abandoned population" claim was slightly off); adds
// callback.pendingTail (tracked, un-called-back abandons still inside the
// callback window as of today), the per-day `daily` series, and the INV-28
// prior-window blocks kpisPrior / callbackPrior (R11-M delta chips).
const OUTBOUND_CACHE_KEY_PREFIX = 'outboundReport:v2';
const OUTBOUND_MAX_RANGE_DAYS = 366;
// An abandon still counts as "called back" if the first matching outbound
// lands within this many CALENDAR days of the abandon (3 covers a Friday
// abandon answered on Monday). Also the reason the report's newest abandons
// can legitimately still be pending -- the client captions that.
const OUTBOUND_CALLBACK_WINDOW_DAYS = 3;
// Cap on the not-called-back drill list (the heatmap cell drill's cap class).
const OUTBOUND_UNCALLED_MAX = 200;

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
    kpisPrior: null,      // v2 (R11-M): prior-window activity, roster-filtered like kpis
    callback: {
      abandonedTotal: 0, abandonedAnonymous: 0, abandonedTracked: 0,
      calledBack: 0, calledBackConnected: 0, calledBackPct: null,
      medianCallbackSec: null, pendingTail: 0,
    },
    callbackPrior: null,  // v2: prior-window callback rate for the delta chip
    daily: [],            // v2: per-day {date, tracked, calledBack, ratePct}
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

/**
 * The abandon-denominator WHERE for a date range: disposition + range +
 * work-window (owner ruling) + is_internal exclusion (every inbound metric
 * query carries it) + the shared dept predicate.
 */
function outboundAbandonWhere_(scope, deptQueues, fromIso, toIso) {
  return "c.disposition = 'abandoned'"
    + " AND c.call_date BETWEEN '" + fromIso + "'::date AND '" + toIso + "'::date"
    + ' AND COALESCE(c.is_internal, FALSE) = FALSE'
    + ' AND ' + inboundWindowClause_(true)
    + inboundDeptPredicate_(scope.dept, deptQueues);
}

function computeOutboundReport_(scope) {
  const from = scope.from, to = scope.to;
  const empty = emptyOutboundReport_(scope);
  let conn = null;
  try {
    conn = (typeof getDashboardNeonConn_ === 'function') ? getDashboardNeonConn_() : null;
    if (!conn) { empty.meta.available = false; return empty; }

    // from/to are validated ISO. The abandon side reuses the Inbound report's
    // dept-attribution predicate + work-window clause verbatim -- AND (v2)
    // the is_internal exclusion every inbound METRIC query carries -- so the
    // callback denominator is EXACTLY the Inbound report's Abandoned
    // population for the same scope: the two reports must never disagree on
    // what an abandon is.
    const deptQueues = scope.companyView ? [] : inboundQueuesForDept_(scope.dept);
    const abandonWhere = outboundAbandonWhere_(scope, deptQueues, from, to);
    // v2: INV-28 prior window (working-day count) for the delta chips.
    // typeof-guarded: computePriorWindow_ lives in Data.gs.
    const pw = (typeof computePriorWindow_ === 'function') ? computePriorWindow_(from, to) : null;
    const priorAbandonWhere = pw ? outboundAbandonWhere_(scope, deptQueues, pw.from, pw.to) : null;

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

    // NOTE: the agents sub-selects group by agent_name ONLY and never touch
    // outbound_calls.department (the raw CDR org label) -- roster attribution
    // happens below, dashboard-side. The callback match is likewise
    // deliberately NOT limited to the report window's `to` (a last-day
    // abandon's callback may land after it) nor to the scoped dept's agents.
    const agentsSel = function (f, t) {
      return "(SELECT COALESCE(json_agg(t ORDER BY t.ob_total DESC, t.agent), '[]') FROM ("
        + 'SELECT agent_name AS agent, count(*) AS ob_total, '
        +   'count(*) FILTER (WHERE connected) AS ob_connected, '
        +   'COALESCE(sum(talk_seconds),0) AS ob_talk_sec, '
        +   'COALESCE(sum(attempts),0) AS attempts '
        + "FROM outbound_calls o WHERE o.call_date BETWEEN '" + f + "'::date AND '" + t + "'::date "
        + 'GROUP BY agent_name) t)';
    };
    const callbackSel = function (where, withDetail) {
      return "(SELECT json_build_object("
        + "'abandonedTotal', count(*), "
        + "'abandonedAnonymous', count(*) FILTER (WHERE c.caller_hash IS NULL), "
        + "'calledBack', count(*) FILTER (WHERE cb.delay_sec IS NOT NULL), "
        + "'calledBackConnected', count(*) FILTER (WHERE cb.connected)"
        + (withDetail
          ? (", 'medianCallbackSec', percentile_cont(0.5) WITHIN GROUP (ORDER BY cb.delay_sec) "
            + 'FILTER (WHERE cb.delay_sec IS NOT NULL AND cb.delay_sec >= 0)'
            // pendingTail: tracked, un-called-back abandons still INSIDE the
            // callback window as of today -- "not called back YET", not a
            // verdict. Client renders it as a count, not a caption guess.
            + ", 'pendingTail', count(*) FILTER (WHERE c.caller_hash IS NOT NULL "
            +   'AND cb.delay_sec IS NULL '
            +   'AND c.call_date > current_date - ' + OUTBOUND_CALLBACK_WINDOW_DAYS + ')')
          : '')
        + ') FROM inbound_calls c ' + cbLateral + ' WHERE ' + where + ')';
    };
    const sql =
      'SELECT json_build_object('
      +   "'agents', " + agentsSel(from, to) + ', '
      +   "'callback', " + callbackSel(abandonWhere, true) + ', '
      // v2: per-day callback series (tracked vs called back), same join.
      +   "'callbackDaily', (SELECT COALESCE(json_agg(t3 ORDER BY t3.d), '[]') FROM ("
      +       'SELECT c.call_date::text AS d, '
      +         'count(*) FILTER (WHERE c.caller_hash IS NOT NULL) AS tracked, '
      +         'count(*) FILTER (WHERE cb.delay_sec IS NOT NULL) AS called_back '
      +       'FROM inbound_calls c ' + cbLateral + ' WHERE ' + abandonWhere
      +       ' GROUP BY c.call_date) t3), '
      + (pw
        ? ("'agentsPrior', " + agentsSel(pw.from, pw.to) + ', '
          + "'callbackPrior', " + callbackSel(priorAbandonWhere, false) + ', ')
        : '')
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

  // Roster-filter + shape one raw agent list (the same rules serve the
  // current AND the prior window, so the delta chips compare like with
  // like). `counts` receives the disclosure tallies for the CURRENT list.
  const shapeAgents = function (raw, counts) {
    const list = [];
    (raw || []).forEach(function (r) {
      const name = String(r.agent || '');
      const homes = deptsByAgent[name] || [];
      if (counts && !homes.length) counts.unrostered++;
      if (!scope.companyView) {
        // Dept view: ONLY agents on THIS dept's roster (the caveat: never
        // the raw CDR org label). Off-roster/unrostered dialers are counted
        // for the disclosure caption, not silently dropped.
        if (homes.indexOf(scope.dept) === -1) { if (counts) counts.offRoster++; return; }
      }
      const obTotal = Number(r.ob_total) || 0;
      const obConnected = Number(r.ob_connected) || 0;
      const obTalkSec = Number(r.ob_talk_sec) || 0;
      list.push({
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
    return list;
  };
  const sumKpis = function (list) {
    const k = { agents: 0, obTotal: 0, obConnected: 0, obConnectRate: null,
                obTalkSec: 0, obAttSec: 0, attempts: 0 };
    list.forEach(function (a) {
      k.agents++;
      k.obTotal += a.obTotal; k.obConnected += a.obConnected;
      k.obTalkSec += a.obTalkSec; k.attempts += a.attempts;
    });
    k.obConnectRate = k.obTotal ? Math.round(k.obConnected / k.obTotal * 1000) / 10 : null;
    k.obAttSec = k.obConnected ? Math.round(k.obTalkSec / k.obConnected) : 0;
    return k;
  };

  const counts = { unrostered: 0, offRoster: 0 };
  const agents = shapeAgents(obj.agents, counts);
  out.agents = agents;
  out.meta.unrosteredAgents = counts.unrostered;
  out.meta.offRosterAgents = counts.offRoster;
  // Scope KPIs sum EXACTLY the rows shown (dept view = roster-filtered), so
  // every number reconciles against the table beneath it.
  out.kpis = sumKpis(agents);

  // v2 (R11-M): prior-window activity through the SAME roster filter.
  if (obj.agentsPrior) out.kpisPrior = sumKpis(shapeAgents(obj.agentsPrior, null));

  // v2: per-day callback series (chart + anything else that wants the trend).
  out.daily = (obj.callbackDaily || []).map(function (d) {
    const tracked = Number(d.tracked) || 0;
    const calledBack = Number(d.called_back) || 0;
    return { date: String(d.d || ''), tracked: tracked, calledBack: calledBack,
             ratePct: tracked ? Math.round(calledBack / tracked * 1000) / 10 : null };
  });

  // v2: prior-window callback rate for the delta chip (tracked denominator,
  // same rule as the current window).
  if (obj.callbackPrior) {
    const p = obj.callbackPrior;
    const pTracked = (Number(p.abandonedTotal) || 0) - (Number(p.abandonedAnonymous) || 0);
    out.callbackPrior = {
      abandonedTracked: pTracked,
      calledBack: Number(p.calledBack) || 0,
      calledBackPct: pTracked ? Math.round((Number(p.calledBack) || 0) / pTracked * 1000) / 10 : null,
    };
  }

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
  cb.pendingTail = Number(cbRaw.pendingTail) || 0;   // v2
  return out;
}

/**
 * v2 (follow-on #2): the NOT-called-back drill list -- the per-call rows
 * behind the callback KPIs. Tracked abandons (caller hash present) in the
 * scope with NO matching outbound inside the callback window, newest first,
 * capped at OUTBOUND_UNCALLED_MAX (meta.truncated). Row shape matches
 * getInboundHeatmapCell's `calls` (the client reuses heatCellDetailHtml_,
 * incl. the "↳ path" journey chip -> getCallJourney). NO caller identity in
 * the response (no hash, no number). Uncached -- per-list, cheap, and an
 * unavailable payload must not pin. Same admin-only vetting gate as the
 * report (outboundResolveRequest_).
 */
function getOutboundUncalled(req) {
  const scope = outboundResolveRequest_(req);
  const out = {
    meta: {
      from: scope.from, to: scope.to, available: true,
      department: scope.dept || null, companyView: scope.companyView,
      truncated: false, scope: 'range', tzLabel: 'CST',
      callbackWindowDays: OUTBOUND_CALLBACK_WINDOW_DAYS,
    },
    calls: [],
  };
  let conn = null;
  try {
    conn = (typeof getDashboardNeonConn_ === 'function') ? getDashboardNeonConn_() : null;
    if (!conn) { out.meta.available = false; return out; }

    const deptQueues = scope.companyView ? [] : inboundQueuesForDept_(scope.dept);
    const where = outboundAbandonWhere_(scope, deptQueues, scope.from, scope.to)
      + ' AND c.caller_hash IS NOT NULL AND cb.delay_sec IS NULL';
    // Same lateral as the report so "not called back" here can never disagree
    // with the KPI above it.
    const cbLateral =
      'LEFT JOIN LATERAL ('
      +   'SELECT EXTRACT(EPOCH FROM ('
      +     "(o.call_date::timestamp + COALESCE(o.call_start,'00:00:00')::interval)"
      +     " - (c.call_date::timestamp + COALESCE(c.call_start,'00:00:00')::interval)"
      +   ')) AS delay_sec '
      +   'FROM outbound_calls o '
      +   'WHERE o.callee_hash = c.caller_hash '
      +     'AND o.call_date >= c.call_date '
      +     'AND o.call_date <= c.call_date + ' + OUTBOUND_CALLBACK_WINDOW_DAYS + ' '
      +     "AND (o.call_date::timestamp + COALESCE(o.call_start,'00:00:00')::interval)"
      +       " >= (c.call_date::timestamp + COALESCE(c.call_start,'00:00:00')::interval) "
      +   "ORDER BY o.call_date, COALESCE(o.call_start,'00:00:00') LIMIT 1"
      + ') cb ON true';
    // CST display time: the heatmap cell drill's shift convention (INV-18;
    // call_start is stored raw PST). Rows with no parseable call_start keep
    // a blank cst_start rather than being dropped -- they are still
    // un-called-back abandons.
    const cstStart = "(CASE WHEN c.call_start ~ '^[0-9]{1,2}:[0-9]{2}:[0-9]{2}$' "
      + "THEN to_char((c.call_start)::time + interval '" + INBOUND_HEATMAP_CST_SHIFT_HOURS
      + " hours', 'HH24:MI:SS') ELSE '' END)";
    const sql =
      "SELECT COALESCE(json_agg(t), '[]')::text AS j FROM ("
      + 'SELECT c.call_date::text AS call_date, c.call_id, '
      +   cstStart + ' AS cst_start, '
      +   'c.entry_queue, c.final_queue, c.abandon_stage, c.abandoned_on_hold, '
      +   'c.wait_seconds, c.hold_seconds '
      + 'FROM inbound_calls c ' + cbLateral + ' '
      + 'WHERE ' + where + ' '
      + "ORDER BY c.call_date DESC, c.call_start DESC NULLS LAST "
      + 'LIMIT ' + (OUTBOUND_UNCALLED_MAX + 1)
      + ') t';

    const stmt = conn.createStatement();
    const rs = stmt.executeQuery(sql);
    const json = rs.next() ? rs.getString('j') : null;
    if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(json ? json.length : 0);
    rs.close(); stmt.close();
    if (json == null) { out.meta.available = false; return out; }

    let arr = JSON.parse(json);
    if (!Array.isArray(arr)) arr = [];
    if (arr.length > OUTBOUND_UNCALLED_MAX) {
      out.meta.truncated = true;
      arr = arr.slice(0, OUTBOUND_UNCALLED_MAX);
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
    Logger.log('getOutboundUncalled failed (best-effort): ' + (e && e.message ? e.message : e));
    out.meta.available = false;
    return out;
  } finally {
    if (conn) { try { conn.close(); } catch (ce) { /* already closed */ } }
  }
}

// ── Vetting instrument (the runInboundQcdParityCheck class) ────────────────
//
// The report is TEMPORARILY admin-only until its numbers are trusted; this
// is the tool that makes "vet it" one execution-log read instead of an
// open-ended chore. EDITOR-RUN, admin-gated, READ-ONLY (no writes, no
// caches, no properties written). Two legs:
//
//   A. PARITY across two independent code paths: the outbound report's
//      callback.abandonedTotal (computeOutboundReport_) must equal the
//      Inbound report's kpis.abandoned (computeInboundReport_) for the same
//      scope -- the contract "the callback denominator IS the Inbound
//      report's Abandoned population", certified against LIVE Neon rather
//      than only by the unit suite's shared-predicate pins.
//   B. SAMPLE VERDICT RE-VERIFICATION: up to OUTBOUND_VETTING_SAMPLE
//      called-back pairs and the same number of not-called-back abandons,
//      each re-checked by a separately-written per-call query (explicit
//      hash-equality + timestamp-ordering EXISTS, bound parameters). Semi-
//      independent by construction (same tables), so its real value is (1)
//      differently-written predicates agreeing and (2) the call ids logged
//      per sample, ready to eyeball in Caller Lookup. No hashes and no
//      numbers are logged -- call ids + dates + raw times only.
//
// Config (Script Properties, all optional): OUTBOUND_VETTING_FROM /
// OUTBOUND_VETTING_TO (default: the 14 days ending yesterday),
// OUTBOUND_VETTING_DEPT ('' = company view), OUTBOUND_VETTING_SAMPLE (=8).
//
// Verdict prefixes are OPS-8 style: 'ok ...' / 'INCONCLUSIVE ...' /
// 'MISMATCH ...' / 'FAILED ...'. **The Batch-6 gate contract applies: a
// window with ZERO abandons proves nothing -- it reports INCONCLUSIVE, and
// the un-gating decision must never be made on an INCONCLUSIVE or FAILED
// run** (the "never flip on error/compared:0" rule, Operator State #19).

function runOutboundVettingCheck() {
  assertAdmin_();
  const props = PropertiesService.getScriptProperties();
  const msDay = 24 * 3600 * 1000;
  const iso = function (d) {
    return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
  };
  const yesterday = new Date(Date.now() - msDay);
  const to = String(props.getProperty('OUTBOUND_VETTING_TO') || iso(yesterday)).trim();
  const from = String(props.getProperty('OUTBOUND_VETTING_FROM')
    || iso(new Date(new Date(to + 'T12:00:00Z').getTime() - 13 * msDay))).trim();
  if (!isIsoDate_(from) || !isIsoDate_(to) || from > to) {
    throw new Error('OUTBOUND_VETTING_FROM/_TO must be YYYY-MM-DD with from <= to (got '
      + from + ' .. ' + to + ').');
  }
  const dept = String(props.getProperty('OUTBOUND_VETTING_DEPT') || '').trim();
  const sampleN = Math.max(1, Math.min(25, Number(props.getProperty('OUTBOUND_VETTING_SAMPLE')) || 8));
  const scope = { from: from, to: to, dept: dept, companyView: !dept, user: { role: 'admin' } };
  const deptQueues = scope.companyView ? [] : inboundQueuesForDept_(dept);
  const label = from + '..' + to + (dept ? (' dept=' + dept) : ' (all departments)');

  // ── Leg A: two-code-path parity ──────────────────────────────────────────
  const ob = computeOutboundReport_(scope);
  if (!ob.meta.available) {
    return logStatusReturn_({ result: 'FAILED (outbound compute unavailable — Neon unreachable?) ' + label });
  }
  const ib = computeInboundReport_({ from: from, to: to, dept: dept,
    deptQueues: deptQueues, companyView: scope.companyView });
  if (!ib || ib.meta.available === false) {
    return logStatusReturn_({ result: 'FAILED (inbound compute unavailable — Neon unreachable?) ' + label });
  }
  if (ib.meta.unmapped) {
    return logStatusReturn_({ result: 'FAILED (dept has no mapped queues — fix Dept Config before vetting) ' + label });
  }
  const obAbandoned = Number(ob.callback.abandonedTotal) || 0;
  const ibAbandoned = Number(ib.kpis.abandoned) || 0;
  Logger.log('parity: outbound callback.abandonedTotal=%s vs inbound kpis.abandoned=%s (%s)',
    obAbandoned, ibAbandoned, label);
  if (obAbandoned !== ibAbandoned) {
    return logStatusReturn_({
      result: 'MISMATCH parity: outbound=' + obAbandoned + ' vs inbound=' + ibAbandoned
        + ' (' + label + ') — the two reports disagree on the Abandoned population; do NOT un-gate.',
      outbound: obAbandoned, inbound: ibAbandoned,
    });
  }
  if (obAbandoned === 0) {
    // The Batch-6 gate contract: parity over nothing certifies nothing.
    return logStatusReturn_({
      result: 'INCONCLUSIVE (0 abandons in range — widen OUTBOUND_VETTING_FROM/_TO; never un-gate on this) ' + label,
      outbound: 0, inbound: 0,
    });
  }

  // ── Leg B: per-sample verdict re-verification ────────────────────────────
  let conn = null;
  try {
    conn = (typeof getDashboardNeonConn_ === 'function') ? getDashboardNeonConn_() : null;
    if (!conn) return logStatusReturn_({ result: 'FAILED (Neon unreachable for the sample leg) ' + label });

    const where = outboundAbandonWhere_(scope, deptQueues, from, to)
      + ' AND c.caller_hash IS NOT NULL';
    const sql =
      "SELECT COALESCE(json_agg(t), '[]')::text AS j FROM ("
      + 'SELECT c.call_id AS a_id, c.call_date::text AS a_date, c.call_start AS a_start, '
      +   'cb.o_id, cb.o_date, cb.o_start '
      + 'FROM inbound_calls c '
      + 'LEFT JOIN LATERAL ('
      +   'SELECT o.call_id AS o_id, o.call_date::text AS o_date, o.call_start AS o_start '
      +   'FROM outbound_calls o '
      +   'WHERE o.callee_hash = c.caller_hash '
      +     'AND o.call_date >= c.call_date '
      +     'AND o.call_date <= c.call_date + ' + OUTBOUND_CALLBACK_WINDOW_DAYS + ' '
      +     "AND (o.call_date::timestamp + COALESCE(o.call_start,'00:00:00')::interval)"
      +       " >= (c.call_date::timestamp + COALESCE(c.call_start,'00:00:00')::interval) "
      +   "ORDER BY o.call_date, COALESCE(o.call_start,'00:00:00') LIMIT 1"
      + ') cb ON true '
      + 'WHERE ' + where + ' '
      + 'ORDER BY c.call_date DESC, c.call_start DESC NULLS LAST LIMIT 200) t';
    const stmt = conn.createStatement();
    const rs = stmt.executeQuery(sql);
    const json = rs.next() ? rs.getString('j') : '[]';
    if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(json ? json.length : 0);
    rs.close(); stmt.close();
    const rows = JSON.parse(json || '[]');
    const calledBack = [], uncalled = [];
    rows.forEach(function (r) {
      if (r.o_id != null && calledBack.length < sampleN) calledBack.push(r);
      else if (r.o_id == null && uncalled.length < sampleN) uncalled.push(r);
    });

    const failures = [];
    // Called-back pairs: the specific outbound row must exist, share the
    // caller's hash, and not precede the abandon. Bound params throughout.
    calledBack.forEach(function (p) {
      const v = conn.prepareStatement(
        'SELECT count(*) AS n FROM outbound_calls o, inbound_calls c '
        + 'WHERE c.call_id = ? AND c.call_date = ?::date '
        +   'AND o.call_id = ? AND o.call_date = ?::date '
        +   'AND o.callee_hash = c.caller_hash '
        +   "AND (o.call_date::timestamp + COALESCE(o.call_start,'00:00:00')::interval)"
        +     " >= (c.call_date::timestamp + COALESCE(c.call_start,'00:00:00')::interval)");
      v.setString(1, String(p.a_id)); v.setString(2, String(p.a_date));
      v.setString(3, String(p.o_id)); v.setString(4, String(p.o_date));
      const vr = v.executeQuery();
      const n = vr.next() ? Number(vr.getString('n')) : 0;
      vr.close(); v.close();
      const ok = n === 1;
      if (!ok) failures.push('called-back ' + p.a_id + '@' + p.a_date + ' -> ' + p.o_id + '@' + p.o_date);
      Logger.log('sample called-back: abandon %s @ %s %s -> outbound %s @ %s %s : %s',
        p.a_id, p.a_date, p.a_start || '(no time)', p.o_id, p.o_date, p.o_start || '(no time)',
        ok ? 'VERIFIED' : 'FAILED');
    });
    // Not-called-back abandons: NO qualifying outbound may exist in-window.
    uncalled.forEach(function (p) {
      const v = conn.prepareStatement(
        'SELECT count(*) AS n FROM outbound_calls o '
        + 'WHERE o.callee_hash = (SELECT caller_hash FROM inbound_calls '
        +   'WHERE call_id = ? AND call_date = ?::date) '
        +   'AND o.call_date >= ?::date '
        +   'AND o.call_date <= ?::date + ' + OUTBOUND_CALLBACK_WINDOW_DAYS + ' '
        +   "AND (o.call_date::timestamp + COALESCE(o.call_start,'00:00:00')::interval)"
        +     " >= (SELECT c.call_date::timestamp + COALESCE(c.call_start,'00:00:00')::interval "
        +       'FROM inbound_calls c WHERE c.call_id = ? AND c.call_date = ?::date)');
      v.setString(1, String(p.a_id)); v.setString(2, String(p.a_date));
      v.setString(3, String(p.a_date)); v.setString(4, String(p.a_date));
      v.setString(5, String(p.a_id)); v.setString(6, String(p.a_date));
      const vr = v.executeQuery();
      const n = vr.next() ? Number(vr.getString('n')) : 0;
      vr.close(); v.close();
      const ok = n === 0;
      if (!ok) failures.push('not-called-back ' + p.a_id + '@' + p.a_date + ' has ' + n + ' match(es)');
      Logger.log('sample not-called-back: abandon %s @ %s %s : %s',
        p.a_id, p.a_date, p.a_start || '(no time)', ok ? 'VERIFIED (0 matches)' : 'FAILED');
    });

    if (failures.length) {
      return logStatusReturn_({
        result: 'MISMATCH samples: ' + failures.length + '/' + (calledBack.length + uncalled.length)
          + ' re-verifications failed (' + label + ') — do NOT un-gate. ' + failures.join('; '),
        parityAbandoned: obAbandoned, failures: failures,
      });
    }
    return logStatusReturn_({
      result: 'ok parity ' + obAbandoned + ' abandons match across both reports; '
        + calledBack.length + ' called-back + ' + uncalled.length
        + ' not-called-back samples re-verified (' + label + '). '
        + 'Spot-check any logged call id in Caller Lookup, then release is a one-line gate removal.',
      parityAbandoned: obAbandoned,
      sampledCalledBack: calledBack.length, sampledUncalled: uncalled.length,
    });
  } finally {
    if (conn) { try { conn.close(); } catch (ce) { /* already closed */ } }
  }
}

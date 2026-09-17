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
// v3 (the six-point round, owner 2026-09-15): four additions, all of them
// changing what the SAME window MEANS, so the prefix moves rather than
// serving a v2 blob missing half the page --
//   (2) callback.calledBackConnectedPct, the connected-callback rate promoted
//       beside the raw one (a callback that rang out is not a save);
//   (3) callback.delayBuckets, the time-to-callback DISTRIBUTION (a median
//       hides the tail, and a two-day-later callback is not the same save as
//       a five-minute one);
//   (4) kpis.obUnconnectedBrief / obUnconnectedReal, splitting unconnected
//       outbound on ring seconds so "effort" and "noise" stop reading alike;
//   (6) callbackByHour, callback rate cut by the ABANDON's hour -- "which
//       abandons fall through the cracks", which the daily series cannot ask.
const OUTBOUND_CACHE_KEY_PREFIX = 'outboundReport:v3';
const OUTBOUND_MAX_RANGE_DAYS = 366;
// An abandon still counts as "called back" if the first matching outbound
// lands within this many CALENDAR days of the abandon (3 covers a Friday
// abandon answered on Monday). Also the reason the report's newest abandons
// can legitimately still be pending -- the client captions that.
const OUTBOUND_CALLBACK_WINDOW_DAYS = 3;
// ── THE RELEASE SWITCH (6c / Operator State #63) ───────────────────────────
// The report is feature-complete; it is admin-only ONLY while the callback
// linkage + roster attribution are being vetted against live data. Releasing
// it to per-dept managers is a TWO-LINE change, and both lines must move
// TOGETHER:
//   1. here: flip OUTBOUND_VETTING_GATE_ to false
//   2. dashboard.html #outbound-report-btn: drop `data-admin-only` and the
//      inline `style="display:none;"`
// A half-release is the failure mode this pairing exists to prevent -- a
// visible menu item over a throwing server reads to a manager as a broken
// app, and a released server behind a hidden button reaches nobody.
// `cross-file-pins.test.js` ("6c: the outbound vetting gate and its menu
// item are released TOGETHER") fails on either half alone.
//
// DO NOT flip this on judgement. Operator State #63 is the runbook: backfill,
// then `runOutboundVettingCheck`, and release ONLY on a CLEAN `ok parity`
// verdict. A zero-abandon window reports INCONCLUSIVE by construction, which
// is NOT a pass.
// `var`, not `const`, so the harness can flip it and prove the RELEASED
// path actually works before anyone flips it for real (a `const` in the
// test vm is unreachable from h.ctx). Apps Script treats the two
// identically at global scope.
var OUTBOUND_VETTING_GATE_ = true;

// (3) Time-to-callback DISTRIBUTION. ONE ordered ladder, read by the SQL
// builder AND the sheet-fallback bucketer, so the two cannot drift into
// different buckets for the same day (the source-parity contract the
// fallback is built on). `maxSec: null` is the open-ended final bucket.
// Boundaries chosen to separate decisions, not to look tidy: inside 15 min
// the caller is plausibly still by the phone; inside an hour is a same-session
// save; past a day it is a courtesy call, not a recovery.
var OUTBOUND_CALLBACK_BUCKETS_ = [
  { key: 'm15',   maxSec: 900,   label: 'within 15 min' },
  { key: 'h1',    maxSec: 3600,  label: 'within 1 hour' },
  { key: 'h4',    maxSec: 14400, label: 'within 4 hours' },
  { key: 'd1',    maxSec: 86400, label: 'within a day' },
  { key: 'later', maxSec: null,  label: 'later' },
];

// (4) The ring-seconds split on UNCONNECTED outbound. The CDR cannot tell
// no-answer from voicemail from busy -- that limitation is real and stays
// disclosed -- but ring LENGTH separates the two cases a manager actually
// cares about: a sub-threshold ring is a misdial or an immediate busy (noise),
// a longer one is a genuine attempt nobody picked up (effort). A HEURISTIC,
// labelled as one wherever it renders; it is not a new CDR fact.
var OUTBOUND_BRIEF_RING_SEC_ = 8;

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
  // A-1 (broad-scan 2026-09-17): ALLOWLIST, never a `role === 'none'`
  // denylist -- the agent role (fail-closed shape, departments:[]) is
  // neither 'none' nor 'manager', so a denylist let it fall through to the
  // admin-style dept branch below the moment the vetting gate is released.
  assertManagerOrAdmin_(user);
  // TEMPORARY admin-only re-scope while the callback linkage + roster
  // attribution are vetted. The per-dept manager path below is KEPT intact,
  // so releasing is flipping OUTBOUND_VETTING_GATE_ (above) -- read its
  // comment before you do: the menu item moves in the same commit.
  if (OUTBOUND_VETTING_GATE_ && user.role !== 'admin') {
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
      // (4) the unconnected split. `Unknown` is the remainder -- rows with no
      // ring_seconds -- and is kept explicit so the three never silently
      // stop summing to obTotal - obConnected.
      obUnconnectedBrief: 0, obUnconnectedReal: 0, obUnconnectedUnknown: 0,
      briefRingSec: OUTBOUND_BRIEF_RING_SEC_,
    },
    kpisPrior: null,      // v2 (R11-M): prior-window activity, roster-filtered like kpis
    callback: {
      abandonedTotal: 0, abandonedAnonymous: 0, abandonedTracked: 0,
      calledBack: 0, calledBackConnected: 0, calledBackPct: null,
      // (2) the connected rate, over the SAME trackable denominator as
      // calledBackPct so the two tiles are directly comparable and the gap
      // between them is readable at a glance.
      calledBackConnectedPct: null,
      medianCallbackSec: null, pendingTail: 0,
      delayBuckets: null,   // (3) { m15, h1, h4, d1, later } | null
    },
    callbackPrior: null,  // v2: prior-window callback rate for the delta chip
    daily: [],            // v2: per-day {date, tracked, calledBack, ratePct}
    callbackByHour: [],   // (6): per abandon-hour {hour, tracked, calledBack, ratePct}
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
  // Fallback payloads are NEVER cached -- a recovered Neon must not be masked
  // for the TTL (the unavailable-uncached rule extended to degraded payloads,
  // same as the Direct report and the heatmap fallback).
  if (data.meta.available && !data.meta.fallbackSource) {
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

/**
 * PURE. The `json_build_object` argument list for the delay-bucket counts,
 * generated from OUTBOUND_CALLBACK_BUCKETS_.
 *
 * Generated rather than hand-written for one reason: the same ladder drives
 * the sheet fallback's JS bucketer (`outboundBucketDelays_`), and two
 * hand-maintained copies of a boundary list is precisely the drift this repo
 * keeps paying for. Edit the ladder; both sides follow.
 *
 * Buckets are CUMULATIVE-exclusive: each counts delays at or below its own
 * maxSec and above the previous one, so they sum to the called-back total.
 * Negative delays cannot occur (the lateral requires the outbound at or after
 * the abandon) but are excluded defensively, matching the median's filter.
 */
function outboundBucketSql_() {
  var parts = [], prev = null;
  OUTBOUND_CALLBACK_BUCKETS_.forEach(function (b) {
    var cond = 'cb.delay_sec IS NOT NULL AND cb.delay_sec >= 0';
    if (prev !== null) cond += ' AND cb.delay_sec > ' + prev;
    if (b.maxSec !== null) cond += ' AND cb.delay_sec <= ' + b.maxSec;
    parts.push("'" + b.key + "', count(*) FILTER (WHERE " + cond + ')');
    prev = b.maxSec;
  });
  return parts.join(', ');
}

/**
 * PURE. Classify ONE unconnected outbound call's ring length:
 * 'brief' | 'real' | 'unknown'.
 *
 * The JS twin of the SQL's two FILTER clauses, extracted so the BOUNDARY is
 * testable on both sides. It is strictly `<` the threshold for brief, so a
 * ring of exactly OUTBOUND_BRIEF_RING_SEC_ is a REAL attempt -- matching
 * `ring_seconds < N` / `ring_seconds >= N`. A one-character drift here
 * (`<=`) would misfile every call sitting exactly on the boundary, and only
 * on the Neon-down path, where nobody would look.
 *
 * A missing / non-numeric ring is 'unknown', never a default bucket: the
 * shaper surfaces unknowns as the remainder so an export column that stops
 * being written shows up as unknowns rather than as a pile of misdials.
 */
function outboundClassifyRing_(ringRaw) {
  if (ringRaw === '' || ringRaw == null) return 'unknown';
  var ring = Number(ringRaw);
  if (!isFinite(ring)) return 'unknown';
  return ring < OUTBOUND_BRIEF_RING_SEC_ ? 'brief' : 'real';
}

/**
 * PURE. The JS twin of outboundBucketSql_, for the sheet fallback. Same
 * ladder, same cumulative-exclusive rule, same non-negative filter -- the
 * source-parity contract means these two must bucket one delay identically.
 */
function outboundBucketDelays_(delays) {
  var out = {};
  OUTBOUND_CALLBACK_BUCKETS_.forEach(function (b) { out[b.key] = 0; });
  (delays || []).forEach(function (d) {
    if (d == null || d < 0) return;
    var prev = null;
    for (var i = 0; i < OUTBOUND_CALLBACK_BUCKETS_.length; i++) {
      var b = OUTBOUND_CALLBACK_BUCKETS_[i];
      if ((prev === null || d > prev) && (b.maxSec === null || d <= b.maxSec)) {
        out[b.key]++;
        return;
      }
      prev = b.maxSec;
    }
  });
  return out;
}

function computeOutboundReport_(scope) {
  const from = scope.from, to = scope.to;
  const empty = emptyOutboundReport_(scope);
  let conn = null;
  try {
    conn = (typeof getDashboardNeonConn_ === 'function') ? getDashboardNeonConn_() : null;
    if (!conn) return outboundSheetFallback_(scope);   // Neon down -> the export tabs

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
        // (4) the ring split. A NULL ring on an unconnected call is UNKNOWN,
        // not brief -- it falls into neither bucket, and the shaper derives
        // "real" by subtraction so the unknowns stay visible as the remainder
        // rather than being quietly filed as effort.
        +   'count(*) FILTER (WHERE NOT connected AND ring_seconds IS NOT NULL '
        +     'AND ring_seconds < ' + OUTBOUND_BRIEF_RING_SEC_ + ') AS ob_unconn_brief, '
        +   'count(*) FILTER (WHERE NOT connected AND ring_seconds IS NOT NULL '
        +     'AND ring_seconds >= ' + OUTBOUND_BRIEF_RING_SEC_ + ') AS ob_unconn_real, '
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
            // (3) the distribution, generated FROM the shared ladder so the
            // SQL cannot drift from the fallback's JS bucketer.
            + ", 'delayBuckets', json_build_object(" + outboundBucketSql_() + ')'
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
      // (6) the same tracked/called-back pair cut by the ABANDON's hour
      // rather than its date. call_start is raw PST text (the INV-18 storage
      // convention) -- the shift to CST is the CLIENT's job, exactly as the
      // per-call lists do it, so the server never guesses a display zone.
      // Rows with no call_start cannot be placed on an hour axis and are
      // excluded here; they still count in every date-scoped figure.
      +   "'callbackByHour', (SELECT COALESCE(json_agg(t4 ORDER BY t4.h), '[]') FROM ("
      +       "SELECT EXTRACT(HOUR FROM c.call_start::interval)::int AS h, "
      +         'count(*) FILTER (WHERE c.caller_hash IS NOT NULL) AS tracked, '
      +         'count(*) FILTER (WHERE cb.delay_sec IS NOT NULL) AS called_back '
      +       'FROM inbound_calls c ' + cbLateral + ' WHERE ' + abandonWhere
      +       ' AND c.call_start IS NOT NULL GROUP BY 1) t4), '
      + (pw
        ? ("'agentsPrior', " + agentsSel(pw.from, pw.to) + ', '
          + "'callbackPrior', " + callbackSel(priorAbandonWhere, false) + ', ')
        : '')
      +   "'coverageStart', (SELECT MIN(call_date)::text FROM outbound_calls)"
      + ')::text AS j';

    const stmt = conn.createStatement();
    const rs = stmt.executeQuery(sql);
    const json = rs.next() ? rs.getString('j') : null;
    if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(json ? json.length : 0, 'outbound');
    rs.close(); stmt.close();
    if (!json) return outboundSheetFallback_(scope);

    const obj = JSON.parse(json);
    return outboundShapeReport_(scope, obj, buildDeptsByAgent_());
  } catch (e) {
    Logger.log('computeOutboundReport_ failed: ' + (e && e.message ? e.message : e));
    return outboundSheetFallback_(scope);
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
      const obBrief = Number(r.ob_unconn_brief) || 0;
      const obReal = Number(r.ob_unconn_real) || 0;
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
        obUnconnectedBrief: obBrief,
        obUnconnectedReal: obReal,
        obUnconnectedUnknown: Math.max(0, obTotal - obConnected - obBrief - obReal),
      });
    });
    return list;
  };
  const sumKpis = function (list) {
    const k = { agents: 0, obTotal: 0, obConnected: 0, obConnectRate: null,
                obTalkSec: 0, obAttSec: 0, attempts: 0,
                obUnconnectedBrief: 0, obUnconnectedReal: 0, obUnconnectedUnknown: 0,
                briefRingSec: OUTBOUND_BRIEF_RING_SEC_ };
    list.forEach(function (a) {
      k.agents++;
      k.obTotal += a.obTotal; k.obConnected += a.obConnected;
      k.obTalkSec += a.obTalkSec; k.attempts += a.attempts;
      k.obUnconnectedBrief += a.obUnconnectedBrief || 0;
      k.obUnconnectedReal += a.obUnconnectedReal || 0;
      k.obUnconnectedUnknown += a.obUnconnectedUnknown || 0;
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

  // (6): the abandon-hour cut. Same tracked/called-back pair as `daily`, so
  // the two views of the same window always sum to the same totals.
  out.callbackByHour = (obj.callbackByHour || []).map(function (r) {
    const tracked = Number(r.tracked) || 0;
    const calledBack = Number(r.called_back) || 0;
    return { hour: Number(r.h) || 0, tracked: tracked, calledBack: calledBack,
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
      // (2) the prior CONNECTED rate, so the new tile gets a real delta chip
      // instead of a blank one. The prior select omits `withDetail`, but
      // calledBackConnected is in the non-detail set, so this costs no SQL.
      calledBackConnectedPct: pTracked
        ? Math.round((Number(p.calledBackConnected) || 0) / pTracked * 1000) / 10 : null,
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
  // (2) The rate that actually reached someone. Same denominator as above --
  // a DIFFERENT one would make the two tiles incomparable, which is the whole
  // point of showing them side by side. calledBackConnected is a strict
  // subset of calledBack, so this can never exceed calledBackPct.
  cb.calledBackConnectedPct = cb.abandonedTracked
    ? Math.round(cb.calledBackConnected / cb.abandonedTracked * 1000) / 10 : null;
  // (3) The distribution. Null (not zeroes) when the source did not supply
  // it, so the client can hide the strip rather than draw an all-zero chart
  // that reads as "every callback was slow".
  cb.delayBuckets = cbRaw.delayBuckets
    ? OUTBOUND_CALLBACK_BUCKETS_.reduce(function (acc, b) {
        acc[b.key] = Number(cbRaw.delayBuckets[b.key]) || 0;
        return acc;
      }, {})
    : null;
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
/**
 * (5) Email the Outbound report (current view) to the CALLER.
 *
 * The gap this closes: Inbound, Individual and Insights all have one and
 * Outbound did not, so the callback rate -- the number most worth noticing
 * without being asked -- was the one you had to go and look up.
 *
 * Same auth + scope as getOutboundReport (it goes through the SAME resolver,
 * so the vetting gate and the per-dept pinning apply identically) and it
 * RECOMPUTES from the same params, so the email cannot disagree with the
 * screen it was sent from. Charts stay in the web app -- the Insights-email
 * precedent -- but the delay distribution ships as text, because a
 * distribution is the part a median was hiding.
 *
 * R28/R30: sent through sendAppEmail_ (BCCs the first admin unless EMAIL_BCC
 * says otherwise) and rendered through ekShellHtml_ WITH a band, like every
 * other report email -- `app-email.test.js` and `email-kit-v2.test.js` sweep
 * for both.
 */
function sendOutboundReportEmail(req) {
  const scope = outboundResolveRequest_(req);
  const email = (scope.user && scope.user.email) || Session.getActiveUser().getEmail();
  const data = computeOutboundReport_(scope);
  if (!data || data.meta.available === false) {
    throw new Error('The Outbound report is unavailable right now — try again shortly.');
  }
  const meta = data.meta || {};
  const k = data.kpis || {};
  const cb = data.callback || {};
  const cbp = data.callbackPrior || {};
  const scopeLabel = meta.companyView ? 'All departments' : (meta.department || '');
  const dateLabel = (meta.from || '') + ' – ' + (meta.to || '');

  // The callback block leads, because it is the report's question. Both
  // rates ride the SAME trackable denominator, and the email says so -- the
  // gap between them is the point (2).
  const cbRows =
      inboundEmailKpiRow_('Abandoned (trackable)',
        fmtNum_(cb.abandonedTracked) + ' of ' + fmtNum_(cb.abandonedTotal), '')
    + inboundEmailKpiRow_('Called back',
        fmtNum_(cb.calledBack) + (cb.calledBackPct != null ? ' (' + cb.calledBackPct + '%)' : ''),
        inboundEmailDelta_(cb.calledBackPct, cbp.calledBackPct, true))
    + inboundEmailKpiRow_('Actually reached',
        fmtNum_(cb.calledBackConnected)
        + (cb.calledBackConnectedPct != null ? ' (' + cb.calledBackConnectedPct + '%)' : ''),
        inboundEmailDelta_(cb.calledBackConnectedPct, cbp.calledBackConnectedPct, true))
    + inboundEmailKpiRow_('Median time to callback',
        cb.medianCallbackSec != null ? inboundEmailDur_(cb.medianCallbackSec) : '—', '')
    + (cb.pendingTail
        ? inboundEmailKpiRow_('Still inside the window', fmtNum_(cb.pendingTail), '')
        : '');

  const actRows =
      inboundEmailKpiRow_('Outbound calls', fmtNum_(k.obTotal), '')
    + inboundEmailKpiRow_('Connected',
        fmtNum_(k.obConnected) + (k.obConnectRate != null ? ' (' + k.obConnectRate + '%)' : ''), '')
    + inboundEmailKpiRow_('Rang out (real attempts)', fmtNum_(k.obUnconnectedReal), '')
    + inboundEmailKpiRow_('Brief / misdial', fmtNum_(k.obUnconnectedBrief), '')
    + inboundEmailKpiRow_('Talk time', inboundEmailDur_(k.obTalkSec), '');

  const dashboardUrl = PropertiesService.getScriptProperties().getProperty('DASHBOARD_URL') || '';
  const htmlBody = ekShellHtml_({
    band: { tone: 'neutral', glyph: '&#9742;' },   // R30: uniform banded header
    kicker: 'Call Data · Outbound calls',
    title: scopeLabel,
    subtitle: dateLabel,
    preheader: scopeLabel + ': '
      + (cb.calledBackPct != null ? cb.calledBackPct + '% of trackable abandons called back' : 'no trackable abandons')
      + ' · ' + dateLabel,
    rowsHtml:
        ekRow_('<div style="font-size:13px;color:#6b7280;margin:0 0 6px;">Did we call back the callers who abandoned?</div>'
          + '<table style="border-collapse:collapse;width:100%;max-width:460px;">' + cbRows + '</table>')
      + ekRow_(outboundEmailDelayTable_(cb.delayBuckets, cb.calledBack), '4px 26px 6px')
      + ekRow_('<div style="font-size:13px;color:#6b7280;margin:10px 0 6px;">Outbound activity</div>'
          + '<table style="border-collapse:collapse;width:100%;max-width:460px;">' + actRows + '</table>',
        '4px 26px 6px'),
    ctaUrl: dashboardUrl,
    ctaLabel: 'Open the Outbound report',
    footerHtml: 'Requested from the Outbound report — sent only to you. '
      + 'Both callback rates divide by the TRACKABLE abandons (an anonymous '
      + 'caller cannot be called back), so a dept is never penalised for its '
      + 'caller-ID mix. “Actually reached” is the stricter subset: the CDR '
      + 'cannot tell a no-answer from a voicemail, so a callback that rang '
      + 'out still counts as called back. The per-day trend, the abandon-hour '
      + 'cut and the not-called-back list are in the web app.',
  });

  sendAppEmail_({ to: email,
    subject: 'Outbound Calls Report: ' + dateLabel + ' (' + scopeLabel + ')',
    htmlBody: htmlBody });
  logReportUsage_('outbound:email', scope.dept || '(all)', scope.user, false);
  return { to: email };
}

/**
 * PURE. The (3) time-to-callback distribution as an email-safe table.
 * Returns '' when there is nothing to distribute -- an all-zero table would
 * read as "every callback was slow" rather than "there were no callbacks".
 */
function outboundEmailDelayTable_(buckets, calledBack) {
  if (!buckets || !calledBack) return '';
  const rows = OUTBOUND_CALLBACK_BUCKETS_.map(function (b) {
    const n = Number(buckets[b.key]) || 0;
    const pct = calledBack ? Math.round(n / calledBack * 1000) / 10 : 0;
    return '<tr>'
      + '<td style="padding:5px 8px;border-bottom:1px solid #f0f0f0;font-size:13px;">'
      +   escapeHtmlServer_(b.label) + '</td>'
      + '<td style="padding:5px 8px;border-bottom:1px solid #f0f0f0;text-align:right;font-size:13px;">'
      +   fmtNum_(n) + '</td>'
      + '<td style="padding:5px 8px;border-bottom:1px solid #f0f0f0;text-align:right;font-size:13px;color:#6b7280;">'
      +   pct + '%</td>'
      + '</tr>';
  }).join('');
  return '<div style="font-size:13px;color:#6b7280;margin:10px 0 6px;">'
    + 'How fast were the callbacks? <span style="color:#9ca3af;">'
    + '(a median hides the tail — two days later is a courtesy call, not a recovery)</span></div>'
    + '<table style="border-collapse:collapse;width:100%;max-width:460px;">' + rows + '</table>';
}

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
    if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(json ? json.length : 0, 'outbound-drill');
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
  // P16: script TZ, like the sibling runInboundQcdParityCheck -- the UTC
  // default meant a run after ~6-7 PM Central defaulted "yesterday" to
  // TODAY in Central, so the vetting window (which the un-gating decision
  // hangs on) ended on a partial, still-importing day.
  const iso = function (d) {
    return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
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
    if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(json ? json.length : 0, 'outbound-vetting');
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
      if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(8, 'outbound-vetting');   // OD-3: a count row
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
      if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(8, 'outbound-vetting');   // OD-3: a count row
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
    // Self-cleaning tool params: only the PASS verdict clears them —
    // MISMATCH / INCONCLUSIVE / FAILED keep the window for the re-run
    // (the OPS-8 gate contract forbids un-gating on those anyway).
    if (typeof clearToolParamsAfterCleanRun_ === 'function') clearToolParamsAfterCleanRun_(
      ['OUTBOUND_VETTING_FROM', 'OUTBOUND_VETTING_TO', 'OUTBOUND_VETTING_DEPT', 'OUTBOUND_VETTING_SAMPLE'],
      'runOutboundVettingCheck');
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

// ---------------------------------------------------------------------------
// probeOutboundAnswerQuality -- STEP 1 of the answer-quality work
// (docs/outbound-callback-dept-plan.md Part 2). Read-only, admin-gated,
// editor-run, sibling of runOutboundVettingCheck. It MEASURES and reports;
// it sets nothing, writes nothing, and changes no payload.
//
// WHY IT EXISTS. `connected` counts a voicemail pickup as a connect, because
// the far end genuinely answers -- that is structural in the CDR and no new
// capture column fixes it. The one unused discriminator already stored is
// `ring_seconds` on a CONNECTED call: when voicemail answers, the handset
// first rang out to the carrier's no-answer timeout, a near-CONSTANT per
// destination. So the ring distribution on connected calls SHOULD be bimodal
// -- a broad low cluster (people) and a tight spike at the timeout.
//
// That spike is the whole basis for a voicemail classifier. If it is there,
// a threshold is defensible; if the distribution is flat or unimodal, it is
// not, and this probe says so rather than handing over a number that merely
// looks principled. Hence the OPS-8 verdict prefixes and the gate contract
// they carry: **never set OUTBOUND_VM_RING_SEC from an INCONCLUSIVE or
// FAILED run** (the same rule as Operator State #19 / #63).
//
// ⚠ ONE CAPTURE DETAIL THE PLAN DID NOT ACCOUNT FOR, and it changes the
// measurement. In cdr-import/outboundCalls.js, `connected` is true when ANY
// external leg had Talk>0 Answered, but `ring_seconds` is measured on the
// FIRST leg only (start -> that leg's connected edge). On a MULTI-ATTEMPT
// call those are two different legs, so the ring length and the connect need
// not belong to the same dial. Mixing them would blur exactly the spike we
// are looking for. The spike detection therefore runs on **attempts = 1**
// rows, where the two provably describe one leg. The all-attempts histogram
// is reported beside it (nothing is hidden), and the by-attempts split is
// one of the five measurements -- if the in-band share climbs with attempts,
// that is the plan's "a 3rd-attempt connect is likelier voicemail" showing up.
//
// FIVE MEASUREMENTS (the plan's list), in two round trips: the histograms
// cannot be cut at a threshold the first query has not derived yet, so
// query 1 measures and query 2 counts at the RESOLVED band.
//   1. ring_seconds histogram on connected rows, 1s buckets to 60s
//   2. talk_seconds histogram on connected rows, 5s buckets to 300s
//   3. the joint quadrant counts (ring band x talk threshold)
//   4. the same split by attempts (1 / 2 / 3+)
//   5. the per-callee-hash repeat check -- the same callee answering at the
//      SAME ring length repeatedly is voicemail with high confidence, and it
//      is the only signal here that can VALIDATE the threshold instead of
//      assuming it. Its modal ring is an INDEPENDENT estimate of the
//      timeout: when it agrees with the spike peak, two different arguments
//      reached the same number.
//
// PHI: aggregates only. No hash, no number, no call id is selected, logged
// or returned -- the repeat check counts GROUPS, never identifies one.
//
// Config (Script Properties, both optional): OUTBOUND_PROBE_FROM /
// OUTBOUND_PROBE_TO (default: the 28 days ending yesterday, script TZ -- the
// P16 lesson; a wider default than the vetting check's 14 because a
// distribution needs more mass than a parity count does). Company-wide by
// design: a carrier timeout is a property of the destination, not of a
// department, and dept scoping would drag the roster join in for nothing.
// Self-clearing on a clean verdict only (the clearToolParamsAfterCleanRun_
// rule), so a re-run after a fix re-measures the same window.

// Tunables. Each gate exists to refuse a number rather than to produce one;
// a run that trips any of them is INCONCLUSIVE, which is a legitimate
// outcome of a measurement and not a failure of it.
var OB_PROBE_RING_MAX_SEC_ = 60;        // 1s buckets to here; longer rings counted as overflow
var OB_PROBE_TALK_MAX_SEC_ = 300;       // talk histogram ceiling
var OB_PROBE_TALK_BUCKET_SEC_ = 5;      // talk bucket width
var OB_PROBE_MIN_CONNECTED_ = 200;      // fewer single-attempt connects than this proves nothing
var OB_PROBE_SPIKE_MIN_RATIO_ = 4;      // peak vs the MEDIAN bucket (a mean would be dragged up by the peak itself)
var OB_PROBE_SPIKE_MIN_SHARE_ = 0.08;   // the spike must hold this share of connects to be worth a rule
var OB_PROBE_SPIKE_MAX_WIDTH_SEC_ = 12; // a carrier timeout is TIGHT; wider is a cluster, not a timeout
var OB_PROBE_VM_FLOOR_SEC_ = 12;        // a peak below this is the human cluster's own mode
var OB_PROBE_MIN_LOW_SHARE_ = 0.15;     // bimodality: a real cluster must sit BELOW the spike
var OB_PROBE_CANDIDATE_MIN_TALK_SEC_ = 10;  // the plan's candidate, used only when no trough is found

/**
 * PURE. Spike detection over the 1s ring histogram.
 *
 * Full-width-at-half-maximum around the modal second, then four independent
 * gates. Returns the same shape whether or not a spike was found, with
 * `reason` naming the FIRST gate that failed in this order: sample size ->
 * peak position -> prominence -> width -> spike share -> bimodality. The
 * order runs cheapest-and-most-fundamental first so the operator is told the
 * one thing most worth acting on ("widen the window" beats "the spike is
 * 3 seconds too wide" when there are 40 rows).
 *
 * `rows` is sparse ([{sec, n}]); it is densified here so the function owns
 * its own domain and a test can hand it a literal.
 */
function obProbeRingSpike_(rows, total) {
  var max = OB_PROBE_RING_MAX_SEC_;
  var counts = [], i;
  for (i = 0; i <= max; i++) counts.push(0);
  (rows || []).forEach(function (r) {
    var s = Math.round(Number(r && r.sec));
    var n = Number(r && r.n) || 0;
    if (!isFinite(s) || s < 0 || s > max) return;   // overflow is counted separately
    counts[s] += n;
  });
  var tot = Number(total) || 0;
  var out = {
    spike: false, reason: '', sampled: tot, peakSec: null, peakN: 0,
    baseline: null, ratio: null, widthSec: null, leftSec: null, rightSec: null,
    spikeCount: 0, spikeShare: 0, belowShare: 0,
    suggestedVmRingSec: null, suggestedToleranceSec: null,
  };
  if (tot < OB_PROBE_MIN_CONNECTED_) {
    out.reason = 'too-few-rows';
    return out;
  }
  // The peak is sought ONLY at or above the timeout floor, never as the
  // global maximum. Taking the global max looks equivalent and is not: in
  // any call centre most calls are answered by PEOPLE, so the human cluster
  // is normally the taller mode, and a global-max search would land on it
  // and reject every genuinely bimodal distribution as "peak too low". The
  // human cluster's job here is to be the mass BELOW the spike (the
  // bimodality gate), not to compete with it for the peak.
  var peakSec = OB_PROBE_VM_FLOOR_SEC_;
  for (i = OB_PROBE_VM_FLOOR_SEC_; i <= max; i++) if (counts[i] > counts[peakSec]) peakSec = i;
  var peakN = counts[peakSec];
  out.peakSec = peakSec; out.peakN = peakN;
  if (!peakN) { out.reason = 'empty-region'; return out; }

  // Baseline = the MEDIAN bucket. Robust by construction: the spike occupies
  // a handful of buckets out of 61, so it cannot move the median, while it
  // would inflate a mean and hide itself.
  var sorted = counts.slice().sort(function (a, b) { return a - b; });
  var mid = Math.floor(sorted.length / 2);
  var baseline = (sorted.length % 2) ? sorted[mid] : ((sorted[mid - 1] + sorted[mid]) / 2);
  out.baseline = baseline;
  // A zero median means most seconds are empty -- itself the concentrated
  // shape we are testing for -- so prominence is unbounded rather than
  // undefined. Reported as null (JSON has no Infinity) with the ratio gate
  // passed; the share and width gates still have to carry it.
  out.ratio = baseline > 0 ? Math.round((peakN / baseline) * 100) / 100 : null;

  // Full width at half maximum. The walk is deliberately NOT stopped at the
  // floor: a "spike" that merges into the human cluster is not separable,
  // and the width gate below is the right place to say so.
  var half = peakN / 2;
  var left = peakSec, right = peakSec;
  while (left > 0 && counts[left - 1] >= half) left--;
  while (right < max && counts[right + 1] >= half) right++;
  out.leftSec = left; out.rightSec = right;
  out.widthSec = right - left + 1;

  var inSpike = 0, below = 0;
  for (i = left; i <= right; i++) inSpike += counts[i];
  for (i = 0; i < left; i++) below += counts[i];
  out.spikeCount = inSpike;
  out.spikeShare = Math.round((inSpike / tot) * 1000) / 1000;
  out.belowShare = Math.round((below / tot) * 1000) / 1000;

  if (baseline > 0 && (peakN / baseline) < OB_PROBE_SPIKE_MIN_RATIO_) { out.reason = 'flat'; return out; }
  if (out.widthSec > OB_PROBE_SPIKE_MAX_WIDTH_SEC_) { out.reason = 'too-wide'; return out; }
  if (out.spikeShare < OB_PROBE_SPIKE_MIN_SHARE_) { out.reason = 'spike-too-small'; return out; }
  if (out.belowShare < OB_PROBE_MIN_LOW_SHARE_) { out.reason = 'unimodal'; return out; }

  out.spike = true;
  out.reason = 'ok';
  // The plan's two parameters, read straight off the measured spike: the
  // threshold is its LEFT edge, the tolerance its half-width.
  out.suggestedVmRingSec = left;
  out.suggestedToleranceSec = Math.ceil((right - left) / 2);
  return out;
}

/**
 * PURE. The talk-histogram trough that would justify OUTBOUND_MIN_TALK_SEC.
 *
 * Looks for a local minimum BELOW the modal bucket -- the dip between
 * "hangups and misdials" and real conversations. Requires the trough to sit
 * at or under half of both shoulders, so a gentle slope does not get read as
 * a boundary. When there is no trough it says so and the candidate default
 * stays what it is: arbitrary. `rows` is sparse ([{sec, n}]), sec being the
 * bucket's LOWER edge.
 */
function obProbeTalkTrough_(rows, total) {
  var w = OB_PROBE_TALK_BUCKET_SEC_;
  var nb = Math.floor(OB_PROBE_TALK_MAX_SEC_ / w) + 1;
  var counts = [], i;
  for (i = 0; i < nb; i++) counts.push(0);
  (rows || []).forEach(function (r) {
    var s = Number(r && r.sec);
    var n = Number(r && r.n) || 0;
    if (!isFinite(s) || s < 0) return;
    var idx = Math.floor(s / w);
    if (idx >= 0 && idx < nb) counts[idx] += n;
  });
  var out = { trough: false, reason: '', troughSec: null, troughN: null,
              modeSec: null, leftPeakSec: null, rightPeakSec: null,
              suggestedMinTalkSec: OB_PROBE_CANDIDATE_MIN_TALK_SEC_,
              suggestedIsMeasured: false, sampled: Number(total) || 0 };
  if (out.sampled < OB_PROBE_MIN_CONNECTED_) { out.reason = 'too-few-rows'; return out; }
  var mode = 0;
  for (i = 0; i < nb; i++) if (counts[i] > counts[mode]) mode = i;
  out.modeSec = mode * w;

  // The trough is sought BETWEEN TWO HUMPS, wherever it sits -- NOT below the
  // mode. The first version searched only below the mode, on the assumption
  // that hangups cluster low and conversations high; the live distribution
  // (2026-09-15) has its mode at 5s with the real dip at 20s ABOVE it,
  // separating short calls from a second hump at 35-40s, and the detector
  // answered "mode-at-floor" -- a wrong answer, not a refusal. Whichever
  // side of the mode the boundary falls on, it is the same boundary.
  //
  // Scored by SEPARATION -- min(tallest to the left, tallest to the right)
  // minus the bucket itself -- so the winner is the split with the most
  // hump on BOTH sides. Scoring by depth alone would pick the emptiest
  // bucket in the tail, where there is no second hump to separate from.
  var leftMax = [], leftArg = [], rightMax = [], rightArg = [];
  var run = 0, arg = 0;
  for (i = 0; i < nb; i++) {                       // strictly BEFORE i
    leftMax[i] = run; leftArg[i] = arg;
    if (counts[i] > run) { run = counts[i]; arg = i; }
  }
  run = 0; arg = nb - 1;
  for (i = nb - 1; i >= 0; i--) {                  // strictly AFTER i
    rightMax[i] = run; rightArg[i] = arg;
    if (counts[i] > run) { run = counts[i]; arg = i; }
  }
  var firstPop = -1, lastPop = -1;
  for (i = 0; i < nb; i++) if (counts[i] > 0) { firstPop = i; break; }
  for (i = nb - 1; i >= 0; i--) if (counts[i] > 0) { lastPop = i; break; }
  if (firstPop < 0 || lastPop - firstPop < 2) { out.reason = 'unimodal'; return out; }
  var best = -1, bestSep = 0;
  for (i = firstPop + 1; i < lastPop; i++) {
    var sep = Math.min(leftMax[i], rightMax[i]) - counts[i];
    if (sep > bestSep) { bestSep = sep; best = i; }
  }
  // No bucket has a taller neighbourhood on BOTH sides: one hump, or a
  // monotonic slope. Either way there is no boundary to name.
  if (best < 0) { out.reason = 'unimodal'; return out; }

  out.troughSec = best * w; out.troughN = counts[best];
  out.leftPeakSec = leftArg[best] * w;
  out.rightPeakSec = rightArg[best] * w;
  // An EMPTY bucket between the humps is absence of data, not a measured
  // minimum -- and it is the shape sparse data takes, so it would otherwise
  // read as the strongest possible trough exactly when the histogram is
  // least trustworthy. Refuse rather than name a boundary the data never
  // showed.
  if (!counts[best]) { out.reason = 'sparse'; return out; }
  var deep = counts[best] <= (leftMax[best] / 2) && counts[best] <= (rightMax[best] / 2);
  if (!deep) { out.reason = 'shallow'; return out; }
  out.trough = true; out.reason = 'ok';
  out.suggestedMinTalkSec = best * w;
  out.suggestedIsMeasured = true;
  return out;
}


/** PURE. The probe's window defaults + validation (shared with the tests). */
function obProbeWindow_(props, nowMs) {
  var msDay = 24 * 3600 * 1000;
  var iso = function (d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); };
  var yesterday = new Date((nowMs || Date.now()) - msDay);
  var to = String(props.getProperty('OUTBOUND_PROBE_TO') || iso(yesterday)).trim();
  var from = String(props.getProperty('OUTBOUND_PROBE_FROM')
    || iso(new Date(new Date(to + 'T12:00:00Z').getTime() - 27 * msDay))).trim();
  if (!isIsoDate_(from) || !isIsoDate_(to) || from > to) {
    throw new Error('OUTBOUND_PROBE_FROM/_TO must be YYYY-MM-DD with from <= to (got '
      + from + ' .. ' + to + ').');
  }
  return { from: from, to: to };
}

/**
 * The ring x talk cross-tab, cut at a given band. Shared by the MEASURED
 * path and the exploratory path so the two cannot compute it differently;
 * what differs between them is the LABEL on the result, never the SQL.
 *
 * Bound params only, in statement order: four quadrant triples, the
 * half-open threshold, the quadrant window, the attempts band, the attempts
 * window. Egress-metered like every other read here.
 */
function obProbeJointCut_(conn, from, to, lo, hi, minTalk) {
  var base = "FROM outbound_calls WHERE call_date BETWEEN ?::date AND ?::date AND connected ";
  var sql2 =
    'SELECT json_build_object('
    + "'quadrants', (SELECT json_build_object("
    // `total` is here so the four cells can be checked to sum: `connected`
    // implies Talk>0 by construction upstream, so a NULL talk_seconds
    // should not exist -- if the cells ever fall short of the total, that
    // assumption has broken and the quadrants are not the whole picture.
    +   "'total', count(*), "
    +   "'bandLongTalk', count(*) FILTER (WHERE ring_seconds BETWEEN ? AND ? AND talk_seconds >= ?), "
    +   "'bandShortTalk', count(*) FILTER (WHERE ring_seconds BETWEEN ? AND ? AND talk_seconds < ?), "
    +   "'outLongTalk', count(*) FILTER (WHERE (ring_seconds IS NULL OR ring_seconds NOT BETWEEN ? AND ?) "
    +     'AND talk_seconds >= ?), '
    +   "'outShortTalk', count(*) FILTER (WHERE (ring_seconds IS NULL OR ring_seconds NOT BETWEEN ? AND ?) "
    +     'AND talk_seconds < ?), '
    // The half-open reading of the same band, so the tight-match and
    // threshold-only definitions can be compared before Part 2 picks one.
    +   "'atOrAboveThreshold', count(*) FILTER (WHERE ring_seconds >= ?)"
    +   ') ' + base + 'AND COALESCE(attempts,1) = 1), '
    // (4) the by-attempts split.
    + "'attempts', (SELECT COALESCE(json_agg(json_build_object("
    +     "'attempts', a, 'n', n, 'inBand', in_band) ORDER BY a), '[]') FROM ("
    +   'SELECT CASE WHEN COALESCE(attempts,1) >= 3 THEN 3 ELSE COALESCE(attempts,1) END AS a, '
    +     'count(*) AS n, count(*) FILTER (WHERE ring_seconds BETWEEN ? AND ?) AS in_band '
    +   base + 'GROUP BY 1) t)'
    + ')::text AS j';
  var ps2 = conn.prepareStatement(sql2);
  var b = 0;
  var bindInt = function (v) { ps2.setInt(++b, v); };
  var bindStr = function (v) { ps2.setString(++b, v); };
  bindInt(lo); bindInt(hi); bindInt(minTalk);          // bandLongTalk
  bindInt(lo); bindInt(hi); bindInt(minTalk);          // bandShortTalk
  bindInt(lo); bindInt(hi); bindInt(minTalk);          // outLongTalk
  bindInt(lo); bindInt(hi); bindInt(minTalk);          // outShortTalk
  bindInt(lo);                                          // atOrAboveThreshold
  bindStr(from); bindStr(to);                           // quadrants window
  bindInt(lo); bindInt(hi);                             // attempts in_band
  bindStr(from); bindStr(to);                           // attempts window
  var rs2 = ps2.executeQuery();
  var json2 = rs2.next() ? rs2.getString('j') : '{}';
  if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(json2 ? json2.length : 0, 'outbound-probe');
  rs2.close(); ps2.close();
  var d2 = JSON.parse(json2 || '{}');
  return { quadrants: d2.quadrants || null, attempts: d2.attempts || [] };
}

function probeOutboundAnswerQuality() {
  assertAdmin_();
  var props = PropertiesService.getScriptProperties();
  var win = obProbeWindow_(props);
  var from = win.from, to = win.to;
  var label = from + '..' + to + ' (all departments)';
  var conn = null;
  try {
    conn = (typeof getDashboardNeonConn_ === 'function') ? getDashboardNeonConn_() : null;
    if (!conn) return logStatusReturn_({ result: 'FAILED (Neon unreachable) ' + label });

    // ── Query 1: the distributions ───────────────────────────────────────
    // One round trip, one getString (the JDBC discipline -- per-row
    // rs.getXXX is ~0.5 s/row here). Bound params: the window only.
    var base = "FROM outbound_calls WHERE call_date BETWEEN ?::date AND ?::date AND connected ";
    var sql =
      'SELECT json_build_object('
      + "'connTotal', (SELECT count(*) " + base + '), '
      + "'conn1', (SELECT count(*) " + base + 'AND COALESCE(attempts,1) = 1), '
      + "'conn1RingNull', (SELECT count(*) " + base + 'AND COALESCE(attempts,1) = 1 AND ring_seconds IS NULL), '
      + "'conn1RingOver', (SELECT count(*) " + base + 'AND COALESCE(attempts,1) = 1 AND ring_seconds > '
        + OB_PROBE_RING_MAX_SEC_ + '), '
      // (1) the ring histogram, single-attempt -- the spike basis.
      + "'ringHist', (SELECT COALESCE(json_agg(json_build_object('sec', sec, 'n', n) ORDER BY sec), '[]') "
      +   'FROM (SELECT ring_seconds::int AS sec, count(*) AS n ' + base
      +     'AND COALESCE(attempts,1) = 1 AND ring_seconds IS NOT NULL AND ring_seconds <= '
      +     OB_PROBE_RING_MAX_SEC_ + ' GROUP BY 1) r), '
      // The all-attempts histogram, reported but NOT used for detection --
      // ring and connect can describe different legs there (see the header).
      + "'ringHistAll', (SELECT COALESCE(json_agg(json_build_object('sec', sec, 'n', n) ORDER BY sec), '[]') "
      +   'FROM (SELECT ring_seconds::int AS sec, count(*) AS n ' + base
      +     'AND ring_seconds IS NOT NULL AND ring_seconds <= ' + OB_PROBE_RING_MAX_SEC_
      +     ' GROUP BY 1) r2), '
      // (2) the talk histogram, 5s buckets.
      + "'talkTotal', (SELECT count(*) " + base + 'AND talk_seconds IS NOT NULL), '
      + "'talkOver', (SELECT count(*) " + base + 'AND talk_seconds > ' + OB_PROBE_TALK_MAX_SEC_ + '), '
      + "'talkHist', (SELECT COALESCE(json_agg(json_build_object('sec', sec, 'n', n) ORDER BY sec), '[]') "
      +   'FROM (SELECT (floor(talk_seconds::numeric / ' + OB_PROBE_TALK_BUCKET_SEC_ + ') * '
      +     OB_PROBE_TALK_BUCKET_SEC_ + ')::int AS sec, count(*) AS n ' + base
      +     'AND talk_seconds IS NOT NULL AND talk_seconds <= ' + OB_PROBE_TALK_MAX_SEC_
      +     ' GROUP BY 1) k), '
      // (5) the repeat check. GROUPS only -- no hash leaves the database.
      + "'repeatGroups', (SELECT count(*) FROM (SELECT callee_hash, ring_seconds " + base
      +   'AND callee_hash IS NOT NULL AND ring_seconds IS NOT NULL '
      +   'GROUP BY 1,2 HAVING count(*) >= 2) g), '
      + "'repeatRingHist', (SELECT COALESCE(json_agg(json_build_object('sec', sec, 'n', n) ORDER BY sec), '[]') "
      +   'FROM (SELECT ring_seconds::int AS sec, count(*) AS n FROM ('
      +     'SELECT callee_hash, ring_seconds ' + base
      +     'AND callee_hash IS NOT NULL AND ring_seconds IS NOT NULL AND ring_seconds <= '
      +     OB_PROBE_RING_MAX_SEC_ + ' GROUP BY 1,2 HAVING count(*) >= 2) gg '
      +   'GROUP BY 1) rr)'
      + ')::text AS j';
    var ps = conn.prepareStatement(sql);
    // The window is the ONLY bound input here, and every occurrence comes
    // from `base` -- which contributes exactly (from, to) in that order --
    // so the binds are derived from the statement rather than hand-counted
    // against a sub-select list that changes whenever one is added.
    var nParams = (sql.match(/\?::date/g) || []).length;
    for (var pi = 1; pi + 1 <= nParams; pi += 2) {
      ps.setString(pi, from); ps.setString(pi + 1, to);
    }
    var rs = ps.executeQuery();
    var json = rs.next() ? rs.getString('j') : '{}';
    if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(json ? json.length : 0, 'outbound-probe');
    rs.close(); ps.close();
    var d = JSON.parse(json || '{}');

    var spike = obProbeRingSpike_(d.ringHist, Number(d.conn1) || 0);
    var trough = obProbeTalkTrough_(d.talkHist, Number(d.talkTotal) || 0);

    // The repeat check's own modal ring -- an INDEPENDENT estimate. It is
    // only meaningful as agreement or disagreement, so it is reported either
    // way and never averaged into the suggestion.
    var repeatMode = null, repeatModeN = 0;
    (d.repeatRingHist || []).forEach(function (r) {
      if ((Number(r.n) || 0) > repeatModeN) { repeatModeN = Number(r.n) || 0; repeatMode = Number(r.sec); }
    });
    var repeatAgrees = (spike.spike && repeatMode !== null
      && repeatMode >= spike.leftSec && repeatMode <= spike.rightSec);

    var out = {
      window: { from: from, to: to },
      connected: { total: Number(d.connTotal) || 0, singleAttempt: Number(d.conn1) || 0,
                   singleAttemptRingNull: Number(d.conn1RingNull) || 0,
                   singleAttemptRingOver60: Number(d.conn1RingOver) || 0 },
      ringHist: d.ringHist || [],
      ringHistAllAttempts: d.ringHistAll || [],
      talk: { measured: Number(d.talkTotal) || 0, over300: Number(d.talkOver) || 0 },
      talkHist: d.talkHist || [],
      spike: spike,
      trough: trough,
      repeat: { groups: Number(d.repeatGroups) || 0, modalRingSec: repeatMode,
                modalRingGroups: repeatModeN, agreesWithSpike: repeatAgrees,
                hist: d.repeatRingHist || [] },
    };

    if (!spike.spike) {
      // INCONCLUSIVE is a RESULT here, not an error: it says the data does
      // not support a voicemail threshold, which is exactly what the probe
      // was run to find out. Tool params are deliberately kept so the
      // widen-and-re-run loop measures the same window.
      //
      // A refusal STILL gets the cross-tab, cut at the OBSERVED peak. The
      // first live run showed why: it refused, so the joint query never ran,
      // and the operator was left with two marginal distributions and no way
      // to ask the question that actually decides this -- a 31s ring with 35s
      // talk is voicemail with high confidence, a 31s ring with 240s talk is
      // a human who took a while. The original "no band, no second query"
      // rule was guarding against MANUFACTURING EVIDENCE for an unmeasured
      // number, and that property is kept intact: this block is labelled
      // exploratory, and `suggested` stays ABSENT, so nothing here can be
      // lifted into a Script Property by mistake.
      //
      // Only when the FWHM edges exist at all -- a too-few-rows or
      // empty-region refusal returns before they are computed, and cutting
      // at nothing would be worse than not cutting.
      if (spike.leftSec !== null && spike.rightSec !== null && spike.peakN > 0) {
        var xcut = obProbeJointCut_(conn, from, to,
          spike.leftSec, spike.rightSec, trough.suggestedMinTalkSec);
        out.exploratory = {
          note: 'EXPLORATORY — cut at the OBSERVED peak, which FAILED the gates below. '
            + 'These are not measured parameters and must not be set as any.',
          refusedBecause: spike.reason,
          observedPeakSec: spike.peakSec,
          observedBand: [spike.leftSec, spike.rightSec],
          minTalkSec: trough.suggestedMinTalkSec,
          minTalkMeasured: trough.suggestedIsMeasured,
          quadrants: xcut.quadrants,
          byAttempts: xcut.attempts,
        };
      }
      out.result = 'INCONCLUSIVE (' + obProbeSpikeHint_(spike) + ') ' + label
        + ' — do NOT set OUTBOUND_VM_RING_SEC or enable OUTBOUND_ANSWER_QUALITY from this run.'
        + (out.exploratory ? ' An EXPLORATORY ring×talk cut at the observed peak is included'
            + ' for diagnosis only — it is not a measurement.' : '');
      Logger.log('[outbound-probe] %s', out.result);
      return logStatusReturn_(out);
    }

    // ── Query 2: the joint cuts, at the MEASURED band ────────────────────
    var lo = spike.suggestedVmRingSec;
    var hi = spike.rightSec;
    var minTalk = trough.suggestedMinTalkSec;
    var cut = obProbeJointCut_(conn, from, to, lo, hi, minTalk);
    out.quadrants = cut.quadrants;
    out.byAttempts = cut.attempts;
    out.band = { vmRingSec: lo, toleranceSec: spike.suggestedToleranceSec, rightSec: hi,
                 minTalkSec: minTalk, minTalkMeasured: trough.suggestedIsMeasured };

    out.suggested = {
      OUTBOUND_VM_RING_SEC: lo,
      OUTBOUND_VM_RING_TOLERANCE_SEC: spike.suggestedToleranceSec,
      OUTBOUND_MIN_TALK_SEC: minTalk,
      OUTBOUND_ANSWER_QUALITY: 'off',
    };
    if (typeof clearToolParamsAfterCleanRun_ === 'function') clearToolParamsAfterCleanRun_(
      ['OUTBOUND_PROBE_FROM', 'OUTBOUND_PROBE_TO'], 'probeOutboundAnswerQuality');
    out.result = 'ok bimodal: ring spike at ' + spike.peakSec + 's '
      + '(band ' + lo + '-' + hi + 's, ' + Math.round(spike.spikeShare * 100) + '% of '
      + spike.sampled + ' single-attempt connects, ' + spike.widthSec + 's wide); '
      + 'repeat-callee modal ring ' + (repeatMode === null ? 'n/a' : repeatMode + 's')
      + (repeatMode === null ? '' : (repeatAgrees ? ' AGREES' : ' DISAGREES')) + '; '
      + 'min-talk ' + minTalk + 's ' + (trough.suggestedIsMeasured ? '(measured trough)' : '(candidate — no trough found)')
      + '. ' + label + ' — these are MEASURED values for Part 2; nothing was set. '
      + 'OUTBOUND_ANSWER_QUALITY stays off until the classifier ships.';
    Logger.log('[outbound-probe] %s', out.result);
    return logStatusReturn_(out);
  } finally {
    if (conn) { try { conn.close(); } catch (ce) { /* already closed */ } }
  }
}

/**
 * PURE. Shares rendered to ONE DECIMAL.
 *
 * The first live run refused at 7.6% against an 8% floor and the sentence
 * read "only 8% of connects (need 8%)" -- which looks like a contradiction
 * and invites someone to re-run rather than believe it. A refusal has to be
 * legible AS a refusal.
 */
function obProbePct1_(x) { return ((Number(x) || 0) * 100).toFixed(1) + '%'; }

/** PURE. The operator-facing sentence for a spike gate that did not pass. */
function obProbeSpikeHint_(s) {
  switch (s && s.reason) {
    case 'too-few-rows':
      return 'only ' + s.sampled + ' single-attempt connected calls, need '
        + OB_PROBE_MIN_CONNECTED_ + ' — widen OUTBOUND_PROBE_FROM/_TO';
    case 'empty-region':
      return 'no connected call rang for ' + OB_PROBE_VM_FLOOR_SEC_ + 's or longer in range — '
        + 'there is no candidate timeout to measure';
    case 'flat':
      return 'no prominent peak (modal bucket only ' + s.ratio + 'x the median bucket, need '
        + OB_PROBE_SPIKE_MIN_RATIO_ + 'x) — the distribution is flat, so no threshold is defensible';
    case 'too-wide':
      return 'the peak is ' + s.widthSec + 's wide at half height (max '
        + OB_PROBE_SPIKE_MAX_WIDTH_SEC_ + 's) — a broad cluster, not a fixed timeout';
    case 'spike-too-small':
      return 'the peak holds only ' + obProbePct1_(s.spikeShare) + ' of connects (need '
        + obProbePct1_(OB_PROBE_SPIKE_MIN_SHARE_) + ') — too little to build a rule on';
    case 'unimodal':
      return 'only ' + obProbePct1_(s.belowShare) + ' of connects ring SHORTER than the peak '
        + '(need ' + obProbePct1_(OB_PROBE_MIN_LOW_SHARE_) + ') — there is no human cluster '
        + 'below it, so the distribution is not bimodal';
    default:
      return 'no voicemail spike found';
  }
}

// ---------------------------------------------------------------------------
// probeOutboundInstantConnects -- (c), the follow-up the first answer-quality
// run made unavoidable. Read-only, admin-gated, editor-run.
//
// THE FINDING IT CHASES. 40.6% of connected single-attempt outbound calls in
// 2026-08-18..09-14 recorded a ring of 0 or 1 second -- 17,197 at EXACTLY
// zero, with not one NULL ring among them. Nobody answers a phone in under a
// second, so for four calls in ten `ring_seconds` is not measuring a ring.
// That caps ANY ring-based voicemail classifier at ~60% of the population
// however the threshold is chosen, which is why Part 2 of
// docs/outbound-callback-dept-plan.md is parked until this has an answer.
//
// WHAT IS ALREADY RULED OUT, so nobody re-derives it: the "we measured the
// agent's leg, not the callee's" hypothesis. In cdr-import/outboundCalls.js
// `first = extLegs[0]` -- the first EXTERNAL Outgoing leg -- so `ring_seconds`
// is start -> connected on the leg to the callee by construction. It is also
// not a multi-attempt artefact: 66,207 of 66,215 connects are single-attempt.
//
// THE DECISIVE MEASUREMENT is a cross-check the stored column cannot argue
// with. The `journey` blob holds every leg with its own `secs` (start->stop),
// `talk` and `hold`, so for the external leg the ring is DERIVABLE as
// secs - talk - hold, independently of the CONNECTED timestamp that
// `ring_seconds` was computed from. Two outcomes, and they point at
// completely different remedies:
//
//   - the derived ring is ALSO ~0  -> the calls genuinely connect instantly
//     (early media / 200-OK-on-dial trunks, or auto-answer devices).
//     `ring_seconds` is telling the truth and simply cannot discriminate
//     these; a voicemail classifier must EXCLUDE them and say so, and the
//     reachable population is ~60%, permanently.
//   - the derived ring is HEALTHY  -> the stored CONNECTED timestamp is
//     wrong for these rows and `ring_seconds` is RECOVERABLE from the
//     journey we already keep. That is a capture fix, and the classifier
//     gets its full population back.
//
// Three supporting cuts, because each kills a different explanation:
// per-agent concentration (a handful of agents = a device or softphone
// setting; uniform = the trunk), per-day rate (a step change on one date = a
// config change, a flat line = how it has always been), and per-bucket talk
// profile (if the instant rows talk like everyone else, they are real calls
// being mis-timed, not junk).
//
// Window: the SAME OUTBOUND_PROBE_FROM / _TO as probeOutboundAnswerQuality,
// deliberately -- the two are companion tools and should be read against one
// window. It does NOT self-clear them; the answer-quality probe owns that.
//
// PHI: aggregates and derived seconds only. The journey blob is already
// PHI-safe at capture (icBuildJourney_ rewrites any phone-shaped name to
// '(external number)'), and nothing from it is echoed -- only counts and
// durations. No hash, number or call id is selected, logged or returned.

var OB_INSTANT_RING_SEC_ = 1;        // "instant" = a stored ring at or under this
var OB_INSTANT_RUNG_SEC_ = 17;       // the comparison group: rings in the spike region
var OB_INSTANT_SAMPLE_ = 300;        // journey rows fetched per group
var OB_INSTANT_MIN_ROWS_ = 200;      // below this the run is INCONCLUSIVE
var OB_INSTANT_REAL_RING_SEC_ = 3;   // a derived ring at or above this is a REAL ring
var OB_INSTANT_TIMESTAMP_SHARE_ = 0.5;   // share of instant rows with a real derived ring
var OB_INSTANT_CARRIER_SHARE_ = 0.2;     // below this, the instant rows really are instant
var OB_INSTANT_AGENT_MIN_CALLS_ = 25;    // an agent needs this many to be rated
var OB_INSTANT_CONCENTRATION_ = 0.75;    // top-5 share of instant rows = concentrated
var OB_INSTANT_LOPSIDED_ = 1.5;          // ...and this much MORE lopsided than an even spread

/**
 * PURE. The external leg's ring, derived from the journey instead of from the
 * stored CONNECTED timestamp.
 *
 * The external leg is the first event the capture rewrote to
 * '(external number)' -- every other event is an internal agent or queue, so
 * the marker identifies it exactly rather than by position (an outbound group
 * can carry the agent's own leg first). Returns null when the blob has no
 * external leg or no duration to work from: absent evidence, never a zero.
 */
function obInstantDerivedRing_(journeyJson) {
  var ev;
  try { ev = JSON.parse(journeyJson || 'null'); } catch (e) { return null; }
  if (!ev || !ev.length) return null;
  for (var i = 0; i < ev.length; i++) {
    if (ev[i] && ev[i].name === '(external number)') {
      if (ev[i].secs == null) return null;
      var secs = Number(ev[i].secs) || 0;
      var talk = Number(ev[i].talk) || 0;
      var hold = Number(ev[i].hold) || 0;
      return Math.max(0, secs - talk - hold);
    }
  }
  return null;
}

/** PURE. Median of a numeric array (null on empty). */
function obInstantMedian_(xs) {
  var a = (xs || []).filter(function (x) { return typeof x === 'number' && isFinite(x); })
    .sort(function (p, q) { return p - q; });
  if (!a.length) return null;
  var m = Math.floor(a.length / 2);
  return (a.length % 2) ? a[m] : Math.round((a[m - 1] + a[m]) / 2 * 10) / 10;
}

/**
 * PURE. Name the hypothesis the numbers support -- or refuse to.
 *
 * The two primary verdicts are mutually exclusive and carry DIFFERENT
 * remedies, so the gap between them is deliberately left as 'mixed' rather
 * than split down the middle: a 40%-real-ring result means some rows are
 * mis-timed and others genuinely instant, and averaging that into one answer
 * would send the fix in one direction for calls that need the other.
 */
function obInstantVerdict_(stats) {
  var inst = (stats && stats.instant) || {};
  var sampled = Number(inst.sampled) || 0;
  if (sampled < 1) {
    return { code: 'INCONCLUSIVE', reason: 'no-journeys',
      text: 'no journey blobs on the instant rows — nothing to cross-check against' };
  }
  var share = Number(inst.realRingShare) || 0;
  if (share >= OB_INSTANT_TIMESTAMP_SHARE_) {
    return { code: 'ok', reason: 'connected-timestamp',
      text: obProbePct1_(share) + ' of instant rows have a REAL ring in the journey (median '
        + inst.medianDerived + 's) — the stored CONNECTED timestamp is wrong for them and '
        + 'ring_seconds is RECOVERABLE from the journey we already keep. This is a capture '
        + 'fix, and the classifier gets its full population back.' };
  }
  if (share <= OB_INSTANT_CARRIER_SHARE_) {
    return { code: 'ok', reason: 'carrier-instant',
      text: 'only ' + obProbePct1_(share) + ' of instant rows show any ring in the journey '
        + '(median ' + inst.medianDerived + 's) — these calls really do connect instantly '
        + '(early media / auto-answer). ring_seconds is telling the truth and simply cannot '
        + 'discriminate them: a voicemail classifier must EXCLUDE them and disclose that its '
        + 'reachable population is the remainder.' };
  }
  return { code: 'INCONCLUSIVE', reason: 'mixed',
    text: obProbePct1_(share) + ' of instant rows have a real ring — BOTH causes are present, '
      + 'and they need opposite fixes. Split the population further (by agent or by trunk) '
      + 'before choosing one.' };
}

/** PURE. Is the instant population concentrated in a few agents? */
function obInstantConcentration_(agents) {
  var rows = (agents || []).filter(function (a) {
    return (Number(a.n) || 0) >= OB_INSTANT_AGENT_MIN_CALLS_;
  });
  var totalInstant = rows.reduce(function (s, a) { return s + (Number(a.instant) || 0); }, 0);
  if (!totalInstant || rows.length < 3) return { concentrated: null, agents: rows.length };
  // TWO different orderings, because they answer two different questions and
  // conflating them misleads in the direction of the busiest agent.
  //   - CONCENTRATION is a share of VOLUME: do a handful of agents account
  //     for most of the instant rows? That is what "a device setting rather
  //     than the trunk" means.
  //   - The ACTIONABLE list is by RATE: an agent doing 2,000 calls with 300
  //     instant has a normal rate and a big volume, and would head a
  //     volume-sorted list while being the wrong phone to go and look at.
  var byVolume = rows.slice().sort(function (p, q) {
    return (Number(q.instant) || 0) - (Number(p.instant) || 0);
  }).slice(0, 5);
  var topInstant = byVolume.reduce(function (s, a) { return s + (Number(a.instant) || 0); }, 0);
  var topShare = topInstant / totalInstant;
  var rateOf = function (a) {
    return (Number(a.instant) || 0) / (Number(a.n) || 1);
  };
  var byRate = rows.slice().sort(function (p, q) { return rateOf(q) - rateOf(p); }).slice(0, 5);
  // A top-5 share means nothing on its own when there are barely more than
  // five agents: an EVEN spread over six already puts 83% in the top five.
  // So it is measured against what uniform would give (5/N) -- "concentrated"
  // has to mean meaningfully more lopsided than uniform, at any roster size.
  var evenBaseline = Math.min(1, 5 / rows.length);
  return {
    concentrated: topShare >= OB_INSTANT_CONCENTRATION_
      && topShare >= evenBaseline * OB_INSTANT_LOPSIDED_,
    topShare: Math.round(topShare * 1000) / 1000,
    evenBaseline: Math.round(evenBaseline * 1000) / 1000,
    agents: rows.length,
    // Names ride along because per-agent figures are ordinary dashboard data,
    // and "which agents" IS the remedy when the answer is a device setting.
    top: byRate.map(function (a) {
      return { agent: a.agent, calls: Number(a.n) || 0, instant: Number(a.instant) || 0,
               rate: Math.round(rateOf(a) * 1000) / 1000 };
    }),
  };
}

function probeOutboundInstantConnects() {
  assertAdmin_();
  var props = PropertiesService.getScriptProperties();
  var win = obProbeWindow_(props);
  var from = win.from, to = win.to;
  var label = from + '..' + to + ' (all departments)';
  var conn = null;
  try {
    conn = (typeof getDashboardNeonConn_ === 'function') ? getDashboardNeonConn_() : null;
    if (!conn) return logStatusReturn_({ result: 'FAILED (Neon unreachable) ' + label });

    var base = 'FROM outbound_calls WHERE call_date BETWEEN ?::date AND ?::date '
      + 'AND connected AND COALESCE(attempts,1) = 1 AND ring_seconds IS NOT NULL ';

    // ── Query 1: the shape of the population ─────────────────────────────
    var sql1 =
      'SELECT json_build_object('
      + "'buckets', (SELECT COALESCE(json_agg(json_build_object("
      +     "'ring', b, 'n', n, 'talkMedian', tm, 'talkAvg', ta) ORDER BY b), '[]') FROM ("
      +   'SELECT CASE WHEN ring_seconds <= ' + OB_INSTANT_RING_SEC_ + ' THEN 0 '
      +          'WHEN ring_seconds < ' + OB_INSTANT_RUNG_SEC_ + ' THEN 2 '
      +          'WHEN ring_seconds <= 32 THEN 17 ELSE 33 END AS b, count(*) AS n, '
      +     'percentile_cont(0.5) WITHIN GROUP (ORDER BY talk_seconds) AS tm, '
      +     'round(avg(talk_seconds)) AS ta '
      +   base + 'GROUP BY 1) q), '
      + "'agents', (SELECT COALESCE(json_agg(json_build_object("
      +     "'agent', a, 'n', n, 'instant', z) ORDER BY z DESC), '[]') FROM ("
      +   "SELECT COALESCE(agent_name, '(unattributed)') AS a, count(*) AS n, "
      +     'count(*) FILTER (WHERE ring_seconds <= ' + OB_INSTANT_RING_SEC_ + ') AS z '
      +   base + 'GROUP BY 1) g), '
      + "'days', (SELECT COALESCE(json_agg(json_build_object("
      +     "'d', d, 'n', n, 'instant', z) ORDER BY d), '[]') FROM ("
      +   'SELECT call_date::text AS d, count(*) AS n, '
      +     'count(*) FILTER (WHERE ring_seconds <= ' + OB_INSTANT_RING_SEC_ + ') AS z '
      +   base + 'GROUP BY 1) dd)'
      + ')::text AS j';
    var ps1 = conn.prepareStatement(sql1);
    var n1 = (sql1.match(/\?::date/g) || []).length;
    for (var pi = 1; pi + 1 <= n1; pi += 2) { ps1.setString(pi, from); ps1.setString(pi + 1, to); }
    var rs1 = ps1.executeQuery();
    var j1 = rs1.next() ? rs1.getString('j') : '{}';
    if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(j1 ? j1.length : 0, 'outbound-instant');
    rs1.close(); ps1.close();
    var d1 = JSON.parse(j1 || '{}');

    var buckets = d1.buckets || [];
    var totalRows = buckets.reduce(function (s, b) { return s + (Number(b.n) || 0); }, 0);
    var instantRows = buckets.reduce(function (s, b) {
      return s + (Number(b.ring) === 0 ? (Number(b.n) || 0) : 0);
    }, 0);
    var out = {
      window: { from: from, to: to },
      totalConnected: totalRows,
      instantCount: instantRows,
      instantShare: totalRows ? Math.round(instantRows / totalRows * 1000) / 1000 : 0,
      buckets: buckets,
      byDay: d1.days || [],
      concentration: obInstantConcentration_(d1.agents),
    };
    if (totalRows < OB_INSTANT_MIN_ROWS_) {
      out.result = 'INCONCLUSIVE (only ' + totalRows + ' connected single-attempt calls with a '
        + 'ring, need ' + OB_INSTANT_MIN_ROWS_ + ' — widen OUTBOUND_PROBE_FROM/_TO) ' + label;
      Logger.log('[outbound-instant] %s', out.result);
      return logStatusReturn_(out);
    }

    // ── Query 2: the journey cross-check ─────────────────────────────────
    // Two matched samples, newest first: the instant rows and a control group
    // from the spike region. The control is what makes the instant number
    // mean anything -- a derived ring is only "healthy" or "absent" relative
    // to what this same derivation produces on calls that provably rang.
    var sql2 =
      "SELECT COALESCE(json_agg(t), '[]')::text AS j FROM ("
      + "(SELECT 'instant' AS grp, journey " + base
      +   'AND ring_seconds <= ' + OB_INSTANT_RING_SEC_ + ' AND journey IS NOT NULL '
      +   'ORDER BY call_date DESC, call_start DESC NULLS LAST LIMIT ' + OB_INSTANT_SAMPLE_ + ') '
      + 'UNION ALL '
      + "(SELECT 'rung' AS grp, journey " + base
      +   'AND ring_seconds >= ' + OB_INSTANT_RUNG_SEC_ + ' AND journey IS NOT NULL '
      +   'ORDER BY call_date DESC, call_start DESC NULLS LAST LIMIT ' + OB_INSTANT_SAMPLE_ + ')'
      + ') t';
    var ps2 = conn.prepareStatement(sql2);
    var n2 = (sql2.match(/\?::date/g) || []).length;
    for (var pj = 1; pj + 1 <= n2; pj += 2) { ps2.setString(pj, from); ps2.setString(pj + 1, to); }
    var rs2 = ps2.executeQuery();
    var j2 = rs2.next() ? rs2.getString('j') : '[]';
    if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(j2 ? j2.length : 0, 'outbound-instant');
    rs2.close(); ps2.close();

    var groups = { instant: [], rung: [] };
    var noExternalLeg = { instant: 0, rung: 0 };
    JSON.parse(j2 || '[]').forEach(function (r) {
      var g = (r && r.grp === 'rung') ? 'rung' : 'instant';
      var derived = obInstantDerivedRing_(r && r.journey);
      if (derived === null) { noExternalLeg[g]++; return; }
      groups[g].push(derived);
    });
    var summarize = function (xs, missing) {
      var real = xs.filter(function (x) { return x >= OB_INSTANT_REAL_RING_SEC_; }).length;
      return {
        sampled: xs.length,
        noExternalLeg: missing,
        medianDerived: obInstantMedian_(xs),
        realRing: real,
        realRingShare: xs.length ? Math.round(real / xs.length * 1000) / 1000 : 0,
      };
    };
    out.instant = summarize(groups.instant, noExternalLeg.instant);
    out.rung = summarize(groups.rung, noExternalLeg.rung);

    var v = obInstantVerdict_(out);
    out.verdict = v.reason;
    out.result = v.code + ' (' + v.reason + ') ' + label + ' — '
      + obProbePct1_(out.instantShare) + ' of connected single-attempt calls ring <= '
      + OB_INSTANT_RING_SEC_ + 's. ' + v.text
      + ' CONTROL: calls that provably rang (>= ' + OB_INSTANT_RUNG_SEC_ + 's) derive a median '
      + out.rung.medianDerived + 's from the same journey field, '
      + obProbePct1_(out.rung.realRingShare) + ' of them a real ring.'
      + (out.concentration.concentrated === true
          ? ' NB the instant rows are CONCENTRATED in a few agents ('
            + obProbePct1_(out.concentration.topShare) + ' in the top 5) — look at their devices.'
          : '');
    Logger.log('[outbound-instant] %s', out.result);
    return logStatusReturn_(out);
  } finally {
    if (conn) { try { conn.close(); } catch (ce) { /* already closed */ } }
  }
}

// ---------------------------------------------------------------------------
// NEON-DOWN SHEET FALLBACK (the DC-1 / heatmap-fallback pattern, applied to
// the last big Neon-only report).
//
// `outbound_calls` had no sheet primary, so a Neon outage took this report,
// the call-path drill's OUTBOUND arm and Caller Lookup's outbound section
// fully dark. cdr-report/outboundCallsExport.js now mirrors the table into an
// "Outbound Calls" tab; this reads it (plus the existing "Inbound Calls" tab
// for the abandon denominator) and feeds the SAME pure `outboundShapeReport_`
// the Neon path uses -- so the two sources cannot disagree on roster
// attribution, KPI derivation or the callback rule (source parity is pinned
// by tests/unit/outbound-fallback.test.js).
//
// What the fallback CANNOT reproduce, and therefore discloses:
//   - rows outside the tabs' retention windows (the copy's `through` date is
//     reported as meta.fallbackThrough; the client captions it),
//   - `medianCallbackSec`, which the SQL derives with percentile_cont over
//     the full population -- the sheet path computes a true median over the
//     matched delays it can see, which is the same statistic on a possibly
//     smaller set, so it is reported rather than suppressed.
// Uncached (the R8-C1/B-3 outage-cache discipline: an outage payload must
// never pin under the live key for the TTL).
// ---------------------------------------------------------------------------

var OUTBOUND_FALLBACK_SHEET_ = 'Outbound Calls';
// Column count the fallback reader requires of the Outbound Calls tab (the
// export's full width -- see cdr-report/outboundCallsExport.js's header
// contract; a narrower/older tab reads as unavailable rather than misparsed).
var OUTBOUND_EXPORT_FALLBACK_COLS_ = 12;
var OUTBOUND_FALLBACK_TAIL_ROWS_ = 4000;   // widening tail scan (the F9 class)

/** Widening tail read of a date-sorted export tab. {grid, through} or null. */
function obSheetTailGrid_(sheetName, width, fromIso) {
  var ss = openSpreadsheet_();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return null;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  if (sheet.getMaxColumns() < width || sheet.getLastColumn() < width) return null;
  var win = OUTBOUND_FALLBACK_TAIL_ROWS_;
  var startRow, dates;
  for (;;) {
    startRow = Math.max(2, lastRow - win + 1);
    dates = sheet.getRange(startRow, 1, lastRow - startRow + 1, 1).getDisplayValues();
    var oldest = ncCellDateIso_(dates[0][0]);
    if (startRow === 2 || (oldest && oldest < fromIso)) break;
    win *= 4;
  }
  var through = null;
  for (var i = 0; i < dates.length; i++) {
    var d = ncCellDateIso_(dates[i][0]);
    if (d && (through === null || d > through)) through = d;
  }
  return {
    grid: sheet.getRange(startRow, 1, lastRow - startRow + 1, width).getDisplayValues(),
    through: through,
  };
}

/** ISO date + 'HH:MM:SS' -> comparable seconds-since-epoch-ish ordinal. */
function obOrdinal_(iso, hms) {
  var base = Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 1000;
  var p = String(hms || '').split(':');
  var secs = (/^\d{1,2}:\d{2}:\d{2}$/.test(String(hms || '')))
    ? ((+p[0]) * 3600 + (+p[1]) * 60 + (+p[2])) : 0;   // NULL start -> midnight (SQL parity)
  return base + secs;
}

function obDaysAfterIso_(iso, n) {
  var d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * PURE: builds the exact blob shape `outboundShapeReport_` consumes from the
 * two export grids. Separated for testability -- every rule below mirrors a
 * clause of the Neon SQL, and the parity test drives both from one fixture.
 *
 * obGrid rows: [date, callId, calleeHash, agent, ext, dept, connected,
 *               talkSec, ringSec, attempts, callStart, journey]
 * ibGrid rows: the Inbound Calls tab's cols 1..17 (ihRowInDept_'s shape).
 */
function obBuildBlobFromGrids_(scope, obGrid, ibGrid, pw, deptQueues) {
  var agentsFor = function (fromIso, toIso) {
    var byAgent = {};
    for (var i = 0; i < obGrid.length; i++) {
      var row = obGrid[i];
      var iso = ncCellDateIso_(row[0]);
      if (!iso || iso < fromIso || iso > toIso) continue;
      var agent = String(row[3] == null ? '' : row[3]).trim();
      var a = byAgent[agent] || (byAgent[agent] = {
        agent: agent, ob_total: 0, ob_connected: 0, ob_talk_sec: 0, attempts: 0,
        ob_unconn_brief: 0, ob_unconn_real: 0,
      });
      a.ob_total++;
      var connected = String(row[6] == null ? '' : row[6]).trim().toUpperCase() === 'TRUE';
      if (connected) a.ob_connected++;
      else {
        // (4) SQL parity via the shared classifier -- see its docstring for
        // why the boundary is strict.
        var cls = outboundClassifyRing_(row[8]);
        if (cls === 'brief') a.ob_unconn_brief++;
        else if (cls === 'real') a.ob_unconn_real++;
      }
      a.ob_talk_sec += Number(row[7]) || 0;
      a.attempts += Number(row[9]) || 0;
    }
    // Same ORDER BY as agentsSel: ob_total DESC, then agent.
    return Object.keys(byAgent).map(function (k) { return byAgent[k]; })
      .sort(function (x, y) {
        return (y.ob_total - x.ob_total) || (x.agent < y.agent ? -1 : x.agent > y.agent ? 1 : 0);
      });
  };

  // Callback index: hash -> ordinal-sorted outbound calls (the cbLateral
  // "earliest qualifying outbound" rule, evaluated in JS).
  var byHash = {};
  for (var o = 0; o < obGrid.length; o++) {
    var orow = obGrid[o];
    var oiso = ncCellDateIso_(orow[0]);
    var h = String(orow[2] == null ? '' : orow[2]).trim();
    if (!oiso || !h) continue;   // NULL hash never matches (SQL parity)
    (byHash[h] || (byHash[h] = [])).push({
      iso: oiso,
      ord: obOrdinal_(oiso, orow[10]),
      connected: String(orow[6] == null ? '' : orow[6]).trim().toUpperCase() === 'TRUE',
    });
  }
  Object.keys(byHash).forEach(function (k) {
    byHash[k].sort(function (a, b) { return a.ord - b.ord; });
  });

  var deptFilter = !!scope.dept;
  var qSet = {};
  (deptQueues || []).forEach(function (q) { qSet[String(q).trim().toLowerCase()] = true; });
  var labels = deptFilter
    ? ((typeof getFinalDeptLabels_ === 'function') ? getFinalDeptLabels_(scope.dept)
                                                  : [String(scope.dept).trim().toLowerCase()])
      .map(function (l) { return String(l).trim().toLowerCase(); })
    : [];
  var allLabels = ((typeof getAllFinalDeptLabels_ === 'function') ? getAllFinalDeptLabels_() : [])
    .map(function (l) { return String(l).trim().toLowerCase(); });

  var todayIso = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var winStart = INBOUND_WORK_WINDOW_PST.start, winEnd = INBOUND_WORK_WINDOW_PST.end;

  // One pass over the inbound abandons for a window -> the callback block
  // (+ the per-day series when asked). Mirrors callbackSel/callbackDaily.
  var callbackFor = function (fromIso, toIso, withDetail) {
    var agg = { abandonedTotal: 0, abandonedAnonymous: 0, calledBack: 0, calledBackConnected: 0 };
    var delays = [];
    var pendingTail = 0;
    var daily = {};
    var byHour = {};   // (6)
    for (var i = 0; i < ibGrid.length; i++) {
      var row = ibGrid[i];
      var iso = ncCellDateIso_(row[0]);
      if (!iso || iso < fromIso || iso > toIso) continue;
      if (String(row[5] == null ? '' : row[5]).trim().toLowerCase() !== 'abandoned') continue;
      if (String(row[16] == null ? '' : row[16]).trim().toUpperCase() === 'TRUE') continue;  // is_internal
      var cs = String(row[15] == null ? '' : row[15]).trim();
      // inboundWindowClause_(true): NULL/absent start counts as IN window.
      if (cs && !(cs >= winStart && cs < winEnd)) continue;
      if (deptFilter && !ihRowInDept_(row, qSet, labels, allLabels)) continue;

      agg.abandonedTotal++;
      var d = daily[iso] || (daily[iso] = { d: iso, tracked: 0, called_back: 0 });
      var hash = String(row[3] == null ? '' : row[3]).trim();
      if (!hash) { agg.abandonedAnonymous++; continue; }   // anonymous: never "not called back"
      d.tracked++;
      // (6) the hour cut. `cs` is raw-PST 'HH:MM:SS' text, the same value the
      // SQL's EXTRACT(HOUR ...) reads -- a row with no call_start cannot be
      // placed on an hour axis and is skipped here exactly as the SQL's
      // `call_start IS NOT NULL` skips it.
      var hourKey = cs ? parseInt(cs.slice(0, 2), 10) : NaN;
      var hb = null;
      if (isFinite(hourKey)) {
        hb = byHour[hourKey] || (byHour[hourKey] = { h: hourKey, tracked: 0, called_back: 0 });
        hb.tracked++;
      }
      var abOrd = obOrdinal_(iso, cs);
      var limitIso = obDaysAfterIso_(iso, OUTBOUND_CALLBACK_WINDOW_DAYS);
      var list = byHash[hash] || [];
      var match = null;
      for (var m = 0; m < list.length; m++) {
        var cand = list[m];
        if (cand.iso < iso || cand.iso > limitIso) continue;
        if (cand.ord < abOrd) continue;
        match = cand; break;                                // list is ord-sorted -> earliest
      }
      if (match) {
        agg.calledBack++;
        d.called_back++;
        if (hb) hb.called_back++;
        if (match.connected) agg.calledBackConnected++;
        delays.push(match.ord - abOrd);
      } else if (iso > obDaysAfterIso_(todayIso, -OUTBOUND_CALLBACK_WINDOW_DAYS)) {
        pendingTail++;                                      // still inside the window today
      }
    }
    if (withDetail) {
      agg.pendingTail = pendingTail;
      agg.delayBuckets = outboundBucketDelays_(delays);   // (3) same ladder as the SQL
      var nonNeg = delays.filter(function (x) { return x >= 0; }).sort(function (a, b) { return a - b; });
      agg.medianCallbackSec = nonNeg.length
        ? (nonNeg.length % 2
            ? nonNeg[(nonNeg.length - 1) / 2]
            : (nonNeg[nonNeg.length / 2 - 1] + nonNeg[nonNeg.length / 2]) / 2)
        : null;
    }
    var series = Object.keys(daily).sort().map(function (k) { return daily[k]; });
    var hours = Object.keys(byHour)
      .map(function (k) { return byHour[k]; })
      .sort(function (a, b) { return a.h - b.h; });
    return { agg: agg, daily: series, hours: hours };
  };

  var cur = callbackFor(scope.from, scope.to, true);
  var coverageStart = null;
  for (var c = 0; c < obGrid.length; c++) {
    var ci = ncCellDateIso_(obGrid[c][0]);
    if (ci && (coverageStart === null || ci < coverageStart)) coverageStart = ci;
  }
  var blob = {
    agents: agentsFor(scope.from, scope.to),
    callback: cur.agg,
    callbackDaily: cur.daily,
    callbackByHour: cur.hours,      // (6)
    coverageStart: coverageStart,
  };
  if (pw) {
    blob.agentsPrior = agentsFor(pw.from, pw.to);
    blob.callbackPrior = callbackFor(pw.from, pw.to, false).agg;
  }
  return blob;
}

/**
 * Sheet-sourced twin of computeOutboundReport_. Returns a shaped payload with
 * meta.fallbackSource='sheet' (+ fallbackThrough), or an unavailable payload
 * when the export tabs aren't there. Never throws to the caller.
 */
function outboundSheetFallback_(scope) {
  var out = emptyOutboundReport_(scope);
  try {
    var deptQueues = scope.companyView ? [] : inboundQueuesForDept_(scope.dept);
    var pw = (typeof computePriorWindow_ === 'function') ? computePriorWindow_(scope.from, scope.to) : null;
    var readFrom = pw ? pw.from : scope.from;
    // Read outbound THROUGH the callback window past `to` -- a last-day
    // abandon's callback can land after the report window (the SQL match is
    // likewise uncapped by `to`).
    var ob = obSheetTailGrid_(OUTBOUND_FALLBACK_SHEET_, OUTBOUND_EXPORT_FALLBACK_COLS_, readFrom);
    var ib = obSheetTailGrid_('Inbound Calls', 17, readFrom);
    if (!ob || !ib) { out.meta.available = false; return out; }

    var blob = obBuildBlobFromGrids_(scope, ob.grid, ib.grid, pw, deptQueues);
    var shaped = outboundShapeReport_(scope, blob, buildDeptsByAgent_());
    shaped.meta.fallbackSource = 'sheet';
    // The OLDER of the two copies bounds what this payload can know.
    shaped.meta.fallbackThrough =
      (ob.through && ib.through) ? (ob.through < ib.through ? ob.through : ib.through)
                                 : (ob.through || ib.through || null);
    return shaped;
  } catch (e) {
    Logger.log('outboundSheetFallback_ failed (best-effort): ' + (e && e.message ? e.message : e));
    out.meta.available = false;
    return out;
  }
}

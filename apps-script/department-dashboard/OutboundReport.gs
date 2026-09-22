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
// ── sampleOutboundCallsForReview -- STEP 1b of the answer-quality work ─────
// (docs/outbound-callback-dept-plan.md "Step 1b"). Read-only, admin-gated,
// editor-run. It SAMPLES; it labels nothing and decides nothing.
//
// WHY IT EXISTS. Everything probeOutboundAnswerQuality and
// probeOutboundInstantConnects establish is UNLABELLED inference from timing:
// rings cluster at 21 / 26-27 / 30-31 s and we INTERPRET the clusters as
// carrier voicemail timeouts. Nobody has confirmed that one 31 s-ring connect
// went to voicemail. Two facts make a labelled check worth more than another
// histogram: the only independent signal in the probe DISAGREED (the
// repeat-callee modal ring is 0 s, not 31 s), and the band's measured purity
// caps precision near 69%, which is a judgement about how the number will be
// read rather than something the distribution can settle. The owner can hear
// the automated greeting and the agent's message in the recording, so the
// label is directly observable -- which makes this the cheapest decisive
// evidence available.
//
// ⚠ VOICEMAIL CANNOT BE A SAMPLING FILTER. It is the thing being inferred, so
// selecting on it would assume the conclusion. Of the classes worth labelling
// only two are stored facts (connected, never-connected); the rest are
// hypotheses about ring position. So the sample is drawn by RING STRATUM and
// the LISTENER assigns the label. `OB_REVIEW_STRATA_` mirrors the table in
// Step 1b and must be revisited if the measured band moves.
//
// ⚠ THE WORKSHEET IS BLINDED, AND THAT IS NOT DECORATION. If a row says
// "31 s ring", the label is contaminated by the hypothesis and the exercise
// confirms itself. So `worksheet` carries ONLY what is needed to FIND the
// recording -- token, date, time, agent -- and deliberately NOT ring or talk
// seconds, which would name the stratum outright. `key` maps token -> stratum
// afterwards. Tokens are assigned AFTER the shuffle, so their order leaks
// nothing either.
//
// PHI: none, and this is worth stating because the design question was open.
// A recording is locatable by AGENT + TIME, so no callee identity is needed:
// no phone number, no callee_hash and no call_id is selected, logged or
// returned. The probe convention holds here unchanged. What does leave is
// internal-staff and duration data (agent name, department, ring/talk).
//
// Window: the SAME OUTBOUND_PROBE_FROM / _TO as the two probes, on purpose --
// the sample must come from the distribution that was measured, or it
// validates a different population. It does NOT self-clear (#64 owns that).
// Size: OUTBOUND_REVIEW_N per stratum, default OB_REVIEW_DEFAULT_N_.

var OB_REVIEW_MAX_N_ = 40;       // per stratum: a listening exercise, not an export

// Mirrors Step 1b's table. `sql` is a fragment appended to the window
// predicate; it must reference only outbound_calls columns and carry no
// user input (these are literals, never operator-supplied).
//
// ⚠ `want` IS DELIBERATELY UNEVEN. C and B2 decide things -- the band's
// interior and its LEFT EDGE -- while the rest are controls, where a handful
// confirms the data is what we think. Spending the same effort on each would
// buy precision where it changes nothing: at n=12 a share carries roughly a
// +/-13 pt Wilson interval, at n=20 about +/-10, and the call is "mostly
// machines vs a coin flip".
//
// ⚠ THE RING BANDS MUST TILE 0..INFINITY WITH NO GAP, and that is not
// theoretical: the first version ran B as 2-11 and C as 20-32, leaving
// 12-19 s in NO stratum -- and the FIRST two labelled voicemails the owner
// produced rang at 18 s and 22 s, so one of them sat in the hole and could
// never have been drawn. Worse, the hole was exactly where the band's left
// edge is in question. `ring` is the declarative range, pinned against the
// SQL and checked for gaps by outbound-report.test.js.
//
// B dropped its old `talk_seconds >= 20` condition with that fix. It made the
// bands non-contiguous (a 2-11 s ring with a short talk was also homeless),
// and a control PRE-FILTERED to the outcome it is meant to confirm is a
// weaker control: what a short ring actually is, is the thing being checked.
var OB_REVIEW_STRATA_ = [
  { id: 'A-instant',     want: 8,  ring: [0, 1],
    sql: 'connected AND ring_seconds <= 1',
    asks: "whether #65's carrier-instant verdict holds by ear" },
  { id: 'B-human',       want: 5,  ring: [2, 11],
    sql: 'connected AND ring_seconds BETWEEN 2 AND 11',
    asks: 'the control -- these should be people' },
  { id: 'B2-shoulder',   want: 12, ring: [12, 19],
    sql: 'connected AND ring_seconds BETWEEN 12 AND 19',
    asks: "THE BAND'S LEFT EDGE -- a known voicemail rang 18 s here" },
  { id: 'C-inband',      want: 20, ring: [20, 32],
    sql: 'connected AND ring_seconds BETWEEN 20 AND 32',
    asks: 'THE QUESTION -- what fraction are machines' },
  { id: 'D-above',       want: 5,  ring: [33, null],
    sql: 'connected AND ring_seconds >= 33',
    asks: "whether the band's right edge is placed right" },
  { id: 'E-unconnected', want: 4,  ring: null,
    sql: 'NOT connected',
    asks: 'that the unconnected side is what we think' },
];

// The standing review workbook -- a SEPARATE spreadsheet, following the
// `HR_BACKUP_SS_ID` precedent (Operator State #59): review artifacts do not
// belong in the production workbook, whose ALLOCATED grid counts against the
// 10M-cell cap (Operator State #62) and whose tabs the pipeline reads.
var OB_REVIEW_SS_PROP_ = 'OB_REVIEW_SS_ID';
var OB_REVIEW_SS_NAME_ = 'Outbound Answer-Quality Review';
var OB_REVIEW_TAB_PREFIX_ = 'Review ';
var OB_REVIEW_KEY_PREFIX_ = 'Key ';
var OB_REVIEW_KEEP_ = 6;         // newest runs kept; a run is ~50 rows

// The labels a listener may assign. `voicemail` and `human` are the two that
// decide anything; the rest exist so an honest "I could not tell" does not
// get forced into one of them, which would bias the very share being measured.
var OB_REVIEW_LABELS_ = ['human', 'voicemail', 'ivr', 'no-answer', 'unclear'];

/**
 * PURE. Shuffles in place with Fisher-Yates and assigns R01.. tokens in the
 * SHUFFLED order, so a token carries no information about its stratum.
 *
 * `rand` is injectable so a test can pin the blinding property against a
 * deterministic sequence rather than hoping a random run exhibits it.
 */
function obReviewShuffleAndToken_(rows, rand) {
  var r = rand || Math.random;
  var i, j, t;
  for (i = rows.length - 1; i > 0; i--) {
    j = Math.floor(r() * (i + 1));
    t = rows[i]; rows[i] = rows[j]; rows[j] = t;
  }
  var pad = String(rows.length).length;
  for (i = 0; i < rows.length; i++) {
    var n = String(i + 1);
    while (n.length < Math.max(2, pad)) n = '0' + n;
    rows[i].token = 'R' + n;
  }
  return rows;
}

/**
 * PURE. Splits one `call_start` into the date and clock time an operator
 * types into the recording search. Returns the raw string as `time` when it
 * does not parse -- a locator is better than a blank, and the date column
 * still carries call_date.
 */
function obReviewStartParts_(callStart) {
  var s = String(callStart == null ? '' : callStart).trim();
  var m = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return { time: s };
  var hh = m[1].length < 2 ? '0' + m[1] : m[1];
  return { time: hh + ':' + m[2] + ':' + (m[3] || '00') };
}

/**
 * PURE. The per-row recording link, from the operator's own URL TEMPLATE.
 *
 * WHY A TEMPLATE AND NOT A BUILT-IN URL. A recording is addressed by the
 * phone system's OWN id (`https://admin.8x8.com/recordings/details/<uuid>`),
 * and we do not store that id -- `outbound_calls.call_id` is the CDR's Call
 * ID, which in this feed is a NUMERIC epoch-millis-shaped value (the same id
 * space as the DQE AD/AE columns, which is exactly why those coerce through
 * the thousands-separator bug). It is not the recording UUID, so no deep link
 * is derivable from captured data. What IS derivable is a pre-filtered SEARCH
 * url, whose parameter scheme only the operator knows -- so they paste it
 * once into `OB_REVIEW_RECORDING_URL` and every row becomes a link.
 *
 * Placeholders: `{date}` `{time}` `{agent}` `{ext}`, each URI-encoded.
 * **`{callid}` is deliberately NOT offered:** supporting it would mean
 * selecting `call_id`, giving up this tool's no-call-id property (pinned) to
 * buy a link that cannot resolve anyway, since the id spaces differ.
 *
 * Returns '' with no template, so the column simply stays empty.
 *
 * ⚠ It must render a BARE URL, never a `=HYPERLINK(...)` formula: the cell
 * goes through `sheetSafeCell_`, which would prefix a leading `=` with an
 * apostrophe and turn the formula into visible text. Sheets auto-links a
 * bare https:// value anyway.
 */
function obReviewRecordingUrl_(template, row) {
  var t = String(template == null ? '' : template).trim();
  if (!t || !/^https?:\/\//i.test(t)) return '';
  var enc = function (v) { return encodeURIComponent(String(v == null ? '' : v)); };
  return t
    .replace(/\{date\}/g, enc(row && row.callDate))
    .replace(/\{time\}/g, enc(row && row.time))
    .replace(/\{agent\}/g, enc(row && row.agent))
    .replace(/\{ext\}/g, enc(row && row.ext));
}

// The worksheet's column order, in ONE place. Both the sheet write and the
// TSV fallback render from `obReviewWorksheetGrid_`, so a new column is added
// once and cannot appear in one and not the other -- the deptTableGrid_ rule
// ("one grid, two serialisations"), which exists because the CSV and the
// clipboard drifted apart when each built its own row.
var OB_REVIEW_WS_HEADER_ = ['Token', 'Date', 'Time', 'Agent', 'Ext', 'Department',
  'Recording', 'Label (' + OB_REVIEW_LABELS_.join(' / ') + ')', 'Notes'];
var OB_REVIEW_LABEL_COL_ = 8;    // 1-based: the Label column in the header above
var OB_REVIEW_KEY_HEADER_ = ['Token', 'Stratum', 'Ring (s)', 'Talk (s)', 'Attempts', 'Connected'];

/**
 * PURE. The BLINDED worksheet as a 2-D grid: token, date, time, agent, dept,
 * plus the two empty columns the listener fills.
 *
 * Ring, talk and stratum are ABSENT by design -- see the header. Agent and
 * department come from the external CDR feed and land in a spreadsheet cell
 * either way (written, or pasted from the TSV), so both go through
 * `sheetSafeCell_` HERE, once, rather than in each serialisation: the
 * injection rule's "CSV or not" clause.
 */
function obReviewWorksheetGrid_(rows, recordingTemplate) {
  var grid = [OB_REVIEW_WS_HEADER_.slice()];
  (rows || []).forEach(function (r) {
    grid.push([
      r.token, r.callDate, r.time,
      sheetSafeCell_(String(r.agent == null ? '' : r.agent)),
      sheetSafeCell_(String(r.ext == null ? '' : r.ext)),
      sheetSafeCell_(String(r.dept == null ? '' : r.dept)),
      obReviewRecordingUrl_(recordingTemplate, r),
      '', '',
    ]);
  });
  return grid;
}

/** PURE. The answer key as a grid, withheld until labelling is done. */
function obReviewKeyGrid_(rows) {
  var grid = [OB_REVIEW_KEY_HEADER_.slice()];
  (rows || []).slice().sort(function (a, b) {
    return a.token < b.token ? -1 : (a.token > b.token ? 1 : 0);
  }).forEach(function (r) {
    grid.push([r.token, r.stratum, (r.ring == null ? '' : r.ring),
               (r.talk == null ? '' : r.talk), (r.attempts == null ? '' : r.attempts),
               (r.connected ? 'yes' : 'no')]);
  });
  return grid;
}

/**
 * PURE. A grid as TSV, for the log fallback when the sheet write fails.
 *
 * TAB-separated because the paste target is a spreadsheet, which splits on
 * tabs. Cells are ALREADY `sheetSafeCell_`-neutralised by the grid builder;
 * what this adds is FLATTENING any tab or newline inside a value, since a
 * paste has no quoting convention to escape into and one stray tab shifts
 * every column after it silently. A written sheet cell holds them harmlessly,
 * which is why the flattening lives here and not in the grid.
 */
function obReviewGridToTsv_(grid) {
  return (grid || []).map(function (row) {
    return row.map(function (v) {
      return String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' ');
    }).join('\t');
  }).join('\n');
}

/**
 * Opens (creating once) the standing review workbook. Same self-populating
 * shape as `HR_BACKUP_SS_ID`: the id lives in a Script Property, so the
 * operator never has to create or wire anything.
 */
function obReviewWorkbook_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(OB_REVIEW_SS_PROP_);
  var ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create(OB_REVIEW_SS_NAME_);
    props.setProperty(OB_REVIEW_SS_PROP_, ss.getId());
    Logger.log('[outbound-review] created the review workbook %s and stored its id in %s.',
      ss.getUrl(), OB_REVIEW_SS_PROP_);
  }
  return ss;
}

/**
 * Writes one run: a Review tab the listener fills in, and a HIDDEN Key tab.
 *
 * ⚠ THE KEY TAB IS FOR THE SCORER, NOT FOR THE LISTENER. Hiding a tab in
 * Sheets is a speed bump, not a control -- what makes the blinding hold is
 * that `scoreOutboundReviewSample` reads the key programmatically, so there
 * is no step in the workflow that requires a human to look at it. The tab is
 * named with that instruction so an operator who finds it knows why not to.
 *
 * Data validation on the Label column keeps a listener from inventing a
 * sixth label that the scorer would then have to guess at, and gives them a
 * dropdown instead of typing.
 */
function obReviewWriteTabs_(rows, meta) {
  var recordingTemplate = PropertiesService.getScriptProperties()
    .getProperty('OB_REVIEW_RECORDING_URL');
  var ss = obReviewWorkbook_();
  var stamp = Utilities.formatDate(new Date(), TZ, 'yyyyMMdd-HHmm');
  var wsName = OB_REVIEW_TAB_PREFIX_ + stamp;
  var keyName = OB_REVIEW_KEY_PREFIX_ + stamp;
  for (var k = 2; k < 50 && ss.getSheetByName(wsName); k++) {   // same-minute re-run
    wsName = OB_REVIEW_TAB_PREFIX_ + stamp + '-' + k;
    keyName = OB_REVIEW_KEY_PREFIX_ + stamp + '-' + k;
  }

  var wsGrid = obReviewWorksheetGrid_(rows, recordingTemplate);
  var ws = ss.insertSheet(wsName, 0);
  ws.getRange(1, 1, wsGrid.length, wsGrid[0].length).setValues(wsGrid);
  ws.getRange(1, 1, 1, wsGrid[0].length).setFontWeight('bold');
  ws.setFrozenRows(1);
  if (wsGrid.length > 1) {
    // A dropdown, not free text: the scorer has to bucket these, and an
    // invented label would land in its "unrecognised" pile instead of the
    // tally it was meant for.
    var rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(OB_REVIEW_LABELS_, true).setAllowInvalid(false).build();
    ws.getRange(2, OB_REVIEW_LABEL_COL_, wsGrid.length - 1, 1).setDataValidation(rule);
  }
  // The listener's instructions live ON the sheet, because a runbook in a doc
  // is not where someone labelling row 34 is looking.
  var noteCol = wsGrid[0].length + 2;
  ws.getRange(1, noteCol).setValue('How to label');
  ws.getRange(2, noteCol).setValue(
    (recordingTemplate
      ? 'Open each row\'s Recording link, listen, and pick a Label. '
      : 'Find each call in the phone system by AGENT + DATE + TIME, listen, and pick a Label. '
        + 'Tip: set the OB_REVIEW_RECORDING_URL Script Property to a search-url template '
        + '(placeholders {date} {time} {agent} {ext}) and every row becomes a link. ')
    + 'Ring length is deliberately NOT shown -- it is the hypothesis under test. '
    + 'When every row is labelled, run scoreOutboundReviewSample() in the Apps Script editor. '
    + 'Partial is fine: it reports how many are still blank. '
    + 'Window sampled: ' + (meta && meta.from) + '..' + (meta && meta.to) + '.');
  ws.getRange(1, noteCol, 2, 1).setWrap(true);
  ws.setColumnWidth(noteCol, 420);

  var keyGrid = obReviewKeyGrid_(rows);
  var key = ss.insertSheet(keyName);
  key.getRange(1, 1, keyGrid.length, keyGrid[0].length).setValues(keyGrid);
  key.getRange(1, 1, 1, keyGrid[0].length).setFontWeight('bold');
  key.hideSheet();

  // Prune oldest runs. The stamp leads the name, so lexical order is
  // chronological (the HR_BACKUP_KEEP_ reasoning).
  [OB_REVIEW_TAB_PREFIX_, OB_REVIEW_KEY_PREFIX_].forEach(function (prefix) {
    var mine = ss.getSheets()
      .filter(function (t) { return t.getName().indexOf(prefix) === 0; })
      .sort(function (a, b) { return a.getName() < b.getName() ? -1 : (a.getName() > b.getName() ? 1 : 0); });
    while (mine.length > OB_REVIEW_KEEP_) ss.deleteSheet(mine.shift());
  });

  return { url: ss.getUrl(), worksheetTab: wsName, keyTab: keyName, rows: rows.length };
}

/**
 * PURE. Wilson score interval for a binomial share.
 *
 * Wilson, not the normal approximation, and the difference is the whole
 * reason this function exists: at n=20 with 18 voicemails the normal
 * interval runs past 100% and at 0 successes it collapses to zero width,
 * both of which would misreport exactly the small-sample cases this audit
 * produces. Returns null below one observation.
 */
function obWilsonInterval_(successes, n, z) {
  var k = Number(successes), N = Number(n);
  if (!isFinite(k) || !isFinite(N) || N < 1 || k < 0 || k > N) return null;
  var Z = (z === undefined || z === null) ? 1.96 : Number(z);
  var p = k / N;
  var z2 = Z * Z;
  var denom = 1 + z2 / N;
  var centre = (p + z2 / (2 * N)) / denom;
  var half = (Z * Math.sqrt((p * (1 - p) / N) + (z2 / (4 * N * N)))) / denom;
  var lo = Math.max(0, centre - half), hi = Math.min(1, centre + half);
  return {
    share: Math.round(p * 1000) / 1000,
    lo: Math.round(lo * 1000) / 1000,
    hi: Math.round(hi * 1000) / 1000,
    halfWidthPts: Math.round(((hi - lo) / 2) * 1000) / 10,
    n: N, successes: k,
  };
}

/**
 * PURE. Joins labels to strata and tallies. `wsGrid` / `keyGrid` are the two
 * tabs read verbatim, header row included.
 *
 * Deliberately does NOT force an unrecognised or blank label into a bucket:
 * `unlabelled` and `unrecognised` are reported separately, because folding a
 * blank into "not voicemail" would bias the one share the audit exists to
 * measure, in the direction of refusing the band.
 */
function obReviewTally_(wsGrid, keyGrid) {
  var out = { byStratum: {}, unlabelled: 0, unrecognised: [], totalRows: 0, labelled: 0,
              tokensMissingKey: [] };
  var stratumOf = {}, i, row;
  for (i = 1; i < (keyGrid || []).length; i++) {
    row = keyGrid[i];
    if (row && row[0]) stratumOf[String(row[0]).trim()] = String(row[1] == null ? '' : row[1]).trim();
  }
  var labelSet = {};
  OB_REVIEW_LABELS_.forEach(function (l) { labelSet[l] = true; });

  for (i = 1; i < (wsGrid || []).length; i++) {
    row = wsGrid[i];
    if (!row || !row[0]) continue;
    var token = String(row[0]).trim();
    out.totalRows++;
    var st = stratumOf[token];
    if (!st) { out.tokensMissingKey.push(token); continue; }
    if (!out.byStratum[st]) out.byStratum[st] = { n: 0, labels: {}, unlabelled: 0 };
    var bucket = out.byStratum[st];
    bucket.n++;
    var raw = String(row[OB_REVIEW_LABEL_COL_ - 1] == null ? '' : row[OB_REVIEW_LABEL_COL_ - 1])
      .trim().toLowerCase();
    if (!raw) { bucket.unlabelled++; out.unlabelled++; continue; }
    if (!labelSet[raw]) { out.unrecognised.push(token + '=' + raw); continue; }
    bucket.labels[raw] = (bucket.labels[raw] || 0) + 1;
    out.labelled++;
  }
  return out;
}

function sampleOutboundCallsForReview() {
  assertAdmin_();
  var props = PropertiesService.getScriptProperties();
  var win = obProbeWindow_(props);
  var from = win.from, to = win.to, anchor = null;
  // OUTBOUND_REVIEW_N, when set, OVERRIDES every stratum with one uniform
  // count -- an escape hatch for a deliberately bigger or smaller run. Unset
  // (the normal case) each stratum takes its own `want`, which is uneven on
  // purpose; see OB_REVIEW_STRATA_.
  var uniform = Math.round(Number(props.getProperty('OUTBOUND_REVIEW_N')) || 0);
  if (!isFinite(uniform) || uniform < 1) uniform = 0;
  if (uniform > OB_REVIEW_MAX_N_) uniform = OB_REVIEW_MAX_N_;
  var wantFor = function (st) {
    var w = uniform || Number(st.want) || 1;
    return Math.min(OB_REVIEW_MAX_N_, Math.max(1, Math.round(w)));
  };
  var label = from + '..' + to + ' (all departments)';

  var conn = null;
  try {
    conn = (typeof getDashboardNeonConn_ === 'function') ? getDashboardNeonConn_() : null;
    if (!conn) return logStatusReturn_({ result: 'FAILED (Neon unreachable) ' + label });
    // Re-resolve the window now that a connection exists, so an UNSET window
    // ends at the latest date the data holds rather than at yesterday. The
    // pre-connection call above still validates an explicitly pinned window
    // (and throws on a bad one) before any connection is opened.
    anchor = obProbeAnchorDate_(conn);
    win = obProbeWindow_(props, null, anchor);
    from = win.from; to = win.to;
    label = from + '..' + to + ' (all departments)'
      + (win.anchoredTo ? ' [anchored to the latest data]' : '');

    // One round trip, one getString (the JDBC discipline). Each stratum is
    // sampled independently with ORDER BY random(), so a quiet stratum does
    // not starve a busy one -- which a single global sample would do, and the
    // in-band stratum is the smallest of the five.
    // The stratum travels as its INDEX, not its name: an integer needs no
    // quoting helper, so nothing operator- or name-derived is ever
    // concatenated into this statement. `sx` is mapped back in JS below.
    var parts = OB_REVIEW_STRATA_.map(function (st, sx) {
      return '(SELECT ' + sx + ' AS sx, call_date::text AS d, '
        + 'call_start AS st, agent_name AS ag, agent_ext AS ax, department AS dp, '
        + 'ring_seconds AS rs, talk_seconds AS ts, attempts AS at, connected AS cn '
        + 'FROM outbound_calls WHERE call_date BETWEEN ?::date AND ?::date AND '
        + st.sql + ' ORDER BY random() LIMIT ' + wantFor(st) + ')';
    });
    var sql = "SELECT COALESCE(json_agg(json_build_object("
      + "'sx', sx, 'd', d, 'st', st, 'ag', ag, 'ax', ax, 'dp', dp, "
      + "'rs', rs, 'ts', ts, 'at', at, 'cn', cn)), '[]')::text AS j FROM ("
      + parts.join(' UNION ALL ') + ') s';
    var ps = conn.prepareStatement(sql);
    var nParams = (sql.match(/\?::date/g) || []).length;
    for (var pi = 1; pi + 1 <= nParams; pi += 2) {
      ps.setString(pi, from); ps.setString(pi + 1, to);
    }
    var rs = ps.executeQuery();
    var json = rs.next() ? rs.getString('j') : '[]';
    if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(json ? json.length : 0, 'outbound-review');
    rs.close(); ps.close();

    var raw = JSON.parse(json || '[]');
    var rows = (raw || []).map(function (r) {
      return {
        stratum: (OB_REVIEW_STRATA_[Number(r.sx)] || {}).id || '?',
        callDate: String(r.d || ''),
        time: obReviewStartParts_(r.st).time,
        agent: String(r.ag == null ? '' : r.ag), ext: String(r.ax == null ? '' : r.ax),
        dept: String(r.dp == null ? '' : r.dp),
        ring: r.rs == null ? null : Number(r.rs), talk: r.ts == null ? null : Number(r.ts),
        attempts: r.at == null ? null : Number(r.at), connected: !!r.cn,
      };
    });

    var perStratum = {};
    OB_REVIEW_STRATA_.forEach(function (st) { perStratum[st.id] = 0; });
    rows.forEach(function (r) {
      if (perStratum[r.stratum] !== undefined) perStratum[r.stratum]++;
    });
    // THIN = fewer rows than asked for, judged per stratum against its own
    // request rather than one global floor: 4 of 4 in a control is complete,
    // 4 of 20 in stratum C is not a decision.
    var thin = OB_REVIEW_STRATA_.filter(function (st) {
      return perStratum[st.id] < Math.min(wantFor(st), Math.max(3, Math.ceil(wantFor(st) * 0.6)));
    }).map(function (st) { return st.id + ' (' + perStratum[st.id] + ' of ' + wantFor(st) + ')'; });

    obReviewShuffleAndToken_(rows, null);

    var out = {
      // `anchoredTo` / `anchorDate` so a SILENT anchor failure is visible: a
      // fallback to the calendar produces the same dates as an anchor that
      // happens to land on yesterday, and the whole point of the anchor is
      // to avoid measuring days with no data. Without this the two are
      // indistinguishable in the log.
      window: { from: from, to: to, anchoredToData: !!win.anchoredTo, anchorDate: anchor },
      perStratumRequested: OB_REVIEW_STRATA_.reduce(function (a, st) {
        a[st.id] = wantFor(st); return a;
      }, {}),
      perStratumSampled: perStratum,
      strata: OB_REVIEW_STRATA_.map(function (st) {
        return { id: st.id, asks: st.asks, selector: st.sql };
      }),
    };

    // Written straight into the standing review workbook, so there is no
    // copy-paste-out-of-a-log step. Best-effort: if the write fails the run
    // is not wasted -- the TSV goes to the log as it did before, and the
    // operator can paste it.
    try {
      out.sheet = obReviewWriteTabs_(rows, { from: from, to: to });
    } catch (we) {
      out.sheetError = String(we);
      out.worksheet = obReviewGridToTsv_(obReviewWorksheetGrid_(rows,
        PropertiesService.getScriptProperties().getProperty('OB_REVIEW_RECORDING_URL')));
      out.key = obReviewGridToTsv_(obReviewKeyGrid_(rows));
      Logger.log('[outbound-review] sheet write FAILED (%s) — falling back to the TSV below.', we);
      Logger.log('[outbound-review] worksheet (paste into a sheet):\n%s', out.worksheet);
    }
    out.howToUse = out.sheet
      ? ('Open ' + out.sheet.url + ' → tab "' + out.sheet.worksheetTab + '". Find each call in '
         + 'the phone system by AGENT + DATE + TIME, listen, and pick a Label from the dropdown. '
         + 'Ring length is deliberately not shown — it is the hypothesis under test, and the '
         + 'hidden Key tab exists for the scorer, not for you. When the rows are labelled (partial '
         + 'is fine) run scoreOutboundReviewSample() — it joins the key, tallies per stratum and '
         + 'returns the verdict, so there is no manual join or pivot to do.')
      : ('Sheet write failed — paste `worksheet` into a spreadsheet, label every row, and do NOT '
         + 'open `key` until they are all labelled.');
    out.result = 'ok sampled ' + rows.length + ' calls for review across '
      + OB_REVIEW_STRATA_.length + ' strata ' + label
      + (out.sheet ? ' → ' + out.sheet.url + ' tab "' + out.sheet.worksheetTab + '"' : '')
      + (thin.length ? ' — ⚠ THIN: ' + thin.join(', ') + '; widen OUTBOUND_PROBE_FROM/_TO '
          + 'before drawing conclusions from those strata' : '')
      + ' — labels are assigned by the LISTENER; this tool infers nothing.';
    Logger.log('[outbound-review] %s', out.result);
    return logStatusReturn_(out);
  } finally {
    if (conn) { try { conn.close(); } catch (ce) { /* already closed */ } }
  }
}

/**
 * PURE. The verdict, from the tally. Separated from the sheet read so the
 * DECISION RULE is testable without a spreadsheet -- it is the part that has
 * to be right, and the part an operator should not be re-deriving by eye.
 *
 * Stratum C decides. `validated` needs its voicemail share's Wilson LOWER
 * bound above `OB_REVIEW_C_VALIDATE_LO_`: the point estimate alone would
 * call 14/20 a validation when the interval still reaches down to 48%, which
 * is the coin flip the audit exists to rule out. `refuted` is the mirror --
 * the UPPER bound below `OB_REVIEW_C_REFUTE_HI_`. Anything spanning both is
 * `inconclusive`, which is a result: it means listen to more of stratum C,
 * not pick whichever end you prefer.
 */
var OB_REVIEW_C_MIN_N_ = 8;          // below this an interval is too wide to conclude from
var OB_REVIEW_C_VALIDATE_LO_ = 0.6;  // Wilson lower bound to call the band validated
var OB_REVIEW_C_REFUTE_HI_ = 0.5;    // Wilson upper bound to call it refuted
var OB_REVIEW_LOW_MIN_N_ = 6;        // labelled 0-11s rows needed to speak about recall
var OB_REVIEW_LOW_VM_SHARE_ = 0.15;  // voicemail share in 0-11s that flags a recall ceiling
var OB_REVIEW_SHOULDER_VM_SHARE_ = 0.4;  // voicemail share in 12-19s that says the band starts too high

function obReviewVerdict_(tally) {
  var out = { verdict: 'inconclusive', reason: '', c: null, controls: {}, byBand: {},
              recallCeiling: null, shoulder: null, notes: [] };
  var byStratum = (tally && tally.byStratum) || {};
  var labelledIn = function (b) {
    var t = 0;
    Object.keys((b && b.labels) || {}).forEach(function (k) { t += b.labels[k]; });
    return t;
  };

  // ── FINDINGS FIRST ─────────────────────────────────────────────────────
  // Everything below depends only on its OWN stratum, so it must be computed
  // BEFORE the stratum-C guards return. It used to sit after them, which
  // meant labelling the fast bands and not C produced NOTHING -- the recall
  // finding, arguably the most important output here, was silently withheld
  // and the listening effort wasted. Partial progress must yield partial
  // findings.

  // ⚠ A AND B ARE NOT HUMAN CONTROLS, and treating them as such was wrong.
  // A confirmed voicemail rang 8 s (call 1783984138413: agent left a message,
  // then sat on a silent line for ~2 min). So a fast ring does NOT imply a
  // person answered, and #65 never said it did -- it established that the
  // stored ring is TRUTHFUL, not who picked up. There are TWO kinds of
  // voicemail: a phone that rings out and forwards after a carrier timeout
  // (18-31 s, ring-detectable), and a phone that is off / on DND /
  // unconditionally forwarded, reached in call-setup time and
  // INDISTINGUISHABLE BY RING from a human answer.
  //
  // So voicemail in a low band is a FINDING about recall, not a broken
  // stratum. `E-unconnected` is the only genuine data-integrity control left.
  var check = function (id, expect, why) {
    var b = byStratum[id];
    if (!b) return;
    var tot = labelledIn(b);
    if (!tot) return;
    var hit = (b.labels[expect] || 0) / tot;
    out.controls[id] = { n: tot, expected: expect, share: Math.round(hit * 1000) / 1000 };
    if (hit < 0.5) {
      out.notes.push('⚠ CONTROL ' + id + ' came back ' + Math.round(hit * 100) + '% ' + expect
        + ', expected a majority — ' + why);
    }
  };
  check('E-unconnected', 'no-answer', 'a NOT-connected row that carries a real conversation '
    + 'means the stored `connected` flag is wrong, which would invalidate every figure here '
    + '(note: an unconnected call may have no recording to listen to at all)');

  // The RECALL ceiling: voicemail the ring can never catch.
  var lowVm = 0, lowN = 0;
  ['A-instant', 'B-human'].forEach(function (id) {
    var b = byStratum[id];
    if (!b) return;
    var tot = labelledIn(b);
    if (!tot) return;
    lowVm += (b.labels.voicemail || 0);
    lowN += tot;
    out.byBand[id] = { n: tot, voicemail: b.labels.voicemail || 0,
                       voicemailShare: Math.round(((b.labels.voicemail || 0) / tot) * 1000) / 1000 };
  });
  if (lowN >= OB_REVIEW_LOW_MIN_N_) {
    var lowShare = lowVm / lowN;
    out.recallCeiling = { n: lowN, voicemail: lowVm,
                          share: Math.round(lowShare * 1000) / 1000,
                          interval: obWilsonInterval_(lowVm, lowN) };
    if (lowShare >= OB_REVIEW_LOW_VM_SHARE_) {
      out.notes.push('⚠ IMMEDIATE VOICEMAIL EXISTS: ' + Math.round(lowShare * 100) + '% of the '
        + '0-11 s rings are voicemail too (n=' + lowN + '). Those are phones off / on DND / '
        + 'forwarded, reached in call-setup time, and NO ring threshold can see them. The band '
        + 'may still be precise, but `reached` stays OVER-COUNTED by this population -- which is '
        + 'the number managers act on. Do not enable `strict` on this evidence; `disclose` must '
        + 'say the reached figure is an upper bound.');
    }
  }

  // B2 is a second QUESTION, not a control: a voicemail-heavy shoulder means
  // the measured band starts too high, not that anything is broken.
  var b2 = byStratum['B2-shoulder'];
  if (b2 && labelledIn(b2)) {
    var b2tot = labelledIn(b2);
    var b2vm = (b2.labels.voicemail || 0) / b2tot;
    out.shoulder = { n: b2tot, voicemailShare: Math.round(b2vm * 1000) / 1000,
                     interval: obWilsonInterval_(b2.labels.voicemail || 0, b2tot) };
    if (b2vm >= OB_REVIEW_SHOULDER_VM_SHARE_) {
      out.notes.push('⚠ THE BAND STARTS TOO HIGH: ' + Math.round(b2vm * 100) + '% of the '
        + '12-19 s shoulder is voicemail too, so a 20 s left edge is MISSING those calls. '
        + 'Widen the band down before setting a threshold (a known voicemail rang 18 s).');
    }
  }

  // ── THE VERDICT: stratum C only ────────────────────────────────────────
  // The guards below decide the VERDICT and nothing else -- every finding
  // above is already on `out`, so an early return still reports them.
  var c = byStratum['C-inband'];
  if (!c || !c.n) { out.reason = 'no stratum-C rows found'; return out; }
  var labelled = labelledIn(c);
  var vm = (c.labels && c.labels.voicemail) || 0;
  out.c = { n: c.n, labelled: labelled, unlabelled: c.unlabelled || 0,
            voicemail: vm, interval: obWilsonInterval_(vm, labelled) };
  if (labelled < OB_REVIEW_C_MIN_N_) {
    out.reason = 'only ' + labelled + ' stratum-C rows labelled, need '
      + OB_REVIEW_C_MIN_N_ + ' before any interval is narrow enough to read'
      + (out.notes.length ? ' (the findings below stand on their own strata)' : '');
    return out;
  }
  var ci = out.c.interval;
  if (ci.lo >= OB_REVIEW_C_VALIDATE_LO_) {
    out.verdict = 'validated';
    out.reason = 'the in-band voicemail share is ' + Math.round(ci.share * 100) + '% ('
      + Math.round(ci.lo * 100) + '-' + Math.round(ci.hi * 100) + '% at 95%), so the band '
      + 'identifies voicemail well enough to threshold on -- DISCLOSE the measured precision '
      + 'and remember the classifier must still EXCLUDE the instant population (#65)';
  } else if (ci.hi < OB_REVIEW_C_REFUTE_HI_) {
    out.verdict = 'refuted';
    out.reason = 'the in-band voicemail share is only ' + Math.round(ci.share * 100) + '% ('
      + Math.round(ci.lo * 100) + '-' + Math.round(ci.hi * 100) + '% at 95%), so ring_seconds '
      + 'cannot carry this classifier here -- RELABEL `connected` in the callback table rather '
      + 'than reclassifying it, and do not set OUTBOUND_VM_RING_SEC';
  } else {
    out.reason = 'the in-band voicemail share is ' + Math.round(ci.share * 100) + '% but its 95% '
      + 'interval spans ' + Math.round(ci.lo * 100) + '-' + Math.round(ci.hi * 100) + '%, which '
      + 'covers both "mostly machines" and "a coin flip" -- label more stratum-C rows (re-run the '
      + 'sampler with OUTBOUND_REVIEW_N raised) rather than choosing an end';
  }

  // Only a CONTROL failure downgrades. The recall and shoulder findings are
  // about what the method can SEE and where its edge belongs -- not evidence
  // that stratum C is uninterpretable -- so they never touch the verdict.
  var controlFailed = Object.keys(out.controls).some(function (id) {
    return out.controls[id].share < 0.5;
  });
  if (controlFailed && out.verdict === 'validated') {
    out.verdict = 'inconclusive';
    out.reason = 'stratum C looked validated, but a CONTROL failed, so the strata themselves are '
      + 'in question: ' + out.notes.join(' ');
  }
  return out;
}

/**
 * Reads back a labelled review run and returns the tally + verdict.
 *
 * Read-only, admin-gated, editor-run. It does the join and the pivot the
 * operator would otherwise do by hand, and applies the decision rule from
 * `obReviewVerdict_` rather than leaving a share to be eyeballed. Pass a tab
 * name to score an older run; the default is the newest.
 */
function scoreOutboundReviewSample(worksheetTab) {
  assertAdmin_();
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(OB_REVIEW_SS_PROP_);
  if (!id) {
    return logStatusReturn_({ result: 'FAILED (no review workbook yet — run '
      + 'sampleOutboundCallsForReview() first)' });
  }
  var ss;
  try { ss = SpreadsheetApp.openById(id); } catch (e) {
    return logStatusReturn_({ result: 'FAILED (cannot open the review workbook ' + id
      + '; clear ' + OB_REVIEW_SS_PROP_ + ' to start a new one): ' + e });
  }
  var wsName = String(worksheetTab || '').trim();
  if (!wsName) {
    // Newest run: the stamp leads the tab name, so lexical order is
    // chronological (the same property the prune relies on).
    var tabs = ss.getSheets()
      .map(function (t) { return t.getName(); })
      .filter(function (nm) { return nm.indexOf(OB_REVIEW_TAB_PREFIX_) === 0; })
      .sort();
    if (!tabs.length) {
      return logStatusReturn_({ result: 'FAILED (no "' + OB_REVIEW_TAB_PREFIX_
        + '*" tab in ' + ss.getUrl() + ')' });
    }
    wsName = tabs[tabs.length - 1];
  }
  var ws = ss.getSheetByName(wsName);
  if (!ws) return logStatusReturn_({ result: 'FAILED (no tab named "' + wsName + '")' });
  var keyName = OB_REVIEW_KEY_PREFIX_ + wsName.slice(OB_REVIEW_TAB_PREFIX_.length);
  var key = ss.getSheetByName(keyName);
  if (!key) {
    return logStatusReturn_({ result: 'FAILED (no key tab "' + keyName + '" for "' + wsName
      + '" — a run whose key was deleted cannot be scored; re-sample)' });
  }

  var wsGrid = ws.getDataRange().getDisplayValues();
  var keyGrid = key.getDataRange().getDisplayValues();
  var tally = obReviewTally_(wsGrid, keyGrid);
  var verdict = obReviewVerdict_(tally);

  var out = {
    workbook: ss.getUrl(), worksheetTab: wsName,
    rows: tally.totalRows, labelled: tally.labelled, unlabelled: tally.unlabelled,
    byStratum: tally.byStratum, verdict: verdict.verdict, why: verdict.reason,
    stratumC: verdict.c, controls: verdict.controls, controlWarnings: verdict.notes,
  };
  if (tally.unrecognised.length) out.unrecognisedLabels = tally.unrecognised;
  if (tally.tokensMissingKey.length) out.tokensMissingKey = tally.tokensMissingKey;
  out.result = (verdict.verdict === 'validated' ? 'ok VALIDATED'
      : (verdict.verdict === 'refuted' ? 'ok REFUTED' : 'INCONCLUSIVE'))
    + ' — ' + verdict.reason + '. ' + tally.labelled + ' of ' + tally.totalRows
    + ' rows labelled in "' + wsName + '"'
    + (tally.unlabelled ? ' (' + tally.unlabelled + ' still blank)' : '')
    + (verdict.notes.length ? ' ' + verdict.notes.join(' ') : '')
    + '. Nothing was set — a threshold is still an owner decision.';
  Logger.log('[outbound-review] %s', out.result);
  return logStatusReturn_(out);
}

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

// Band tunables (the multi-modal fallback below). The single-peak gates above
// test for ONE carrier timeout; these test for SEVERAL, which is what the
// 2026-09-18 live run actually found (bumps at 21 / 26-27 / 30-31 s).
var OB_PROBE_BAND_WIDTH_SEC_ = 16;        // scan window: standard no-answer timeouts span ~20-35s
var OB_PROBE_BAND_EDGE_RATIO_ = 1.5;      // an edge bucket must be this far above baseline to stay in
var OB_PROBE_BAND_MIN_SHARE_ = 0.12;      // a band this wide must hold more than a 2s peak did (0.08)
var OB_PROBE_BAND_MIN_EXCESS_SHARE_ = 0.06;  // mass ABOVE baseline, as a share of connects
var OB_PROBE_BAND_MIN_PURITY_ = 0.55;     // excess / band mass -- the precision ceiling; see obProbeRingBand_
var OB_PROBE_BAND_SEP_LOOKBACK_ = 3;      // buckets below the left edge used as the shoulder
var OB_PROBE_BAND_MAX_SHOULDER_ = 0.6;    // shoulder must be under this fraction of the band's mean

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
 * PURE. Band detection over the same 1s ring histogram -- the MULTI-MODAL
 * fallback for `obProbeRingSpike_`.
 *
 * WHY A SECOND DETECTOR RATHER THAN LOOSER GATES. The spike detector encodes
 * "one carrier, one no-answer timeout, therefore one tight peak". The first
 * live run (2026-09-18) measured something else: distinct bumps at 21 s
 * (2,077), 26-27 s (927 / 1,010) and 30-31 s (1,784 / 3,022) -- several
 * carriers with different pickup delays. A test that measures ONE 2 s-wide
 * peak cannot capture mass split three ways, so it refused at 7.7% against
 * the 8% floor. Widening `OB_PROBE_SPIKE_MAX_WIDTH_SEC_` would have "fixed"
 * that by letting a single FWHM swallow the dips, which is not the same claim
 * and would also swallow the human tail on any other distribution. So the
 * spike detector is left exactly as it was, and this runs only when the spike
 * refused for a multi-modal reason.
 *
 * WHAT IT ADDS, AND IT IS THE POINT: a PURITY gate. Summing a 13-16 s band
 * counts the baseline traffic inside it as if it were voicemail. On the live
 * numbers the 20-32 s band holds 13,798 calls, of which 13 x 330 = 4,290 are
 * baseline -- so roughly 31% of anything the band flags would be a human who
 * simply took a while to pick up. That is the classifier's precision ceiling,
 * it is measurable here, and no gate above looked at it. A band that is
 * mostly baseline is refused as `band-impure` rather than handed over as a
 * threshold, which is this probe's whole contract.
 *
 * WHAT KEEPS IT OFF THE HUMAN CLUSTER, precisely -- because the obvious
 * answer is wrong. The scan maximises enclosed mass over a FIXED-width
 * window, and at fixed width `mass - W*baseline` is maximal at exactly the
 * same window as `mass`, since the subtracted term is a constant. So the
 * objective provides NO protection against drifting onto people answering,
 * and it would be false to claim it does. Two other things provide it: the
 * left edge may not fall below `OB_PROBE_VM_FLOOR_SEC_`, and the SHOULDER
 * gate refuses a window whose immediately-preceding seconds are nearly as
 * busy -- which is what the upper tail of a human cluster looks like. The
 * excess is computed for the purity gate and the report, not to steer the
 * scan. The window is then TRIMMED to its own elevated edges, so the emitted
 * threshold is data-determined and not an artifact of the scan width.
 *
 * `rows` is sparse ([{sec, n}]), densified here so a test can hand it a
 * literal. Same return shape whether or not a band was found, with `reason`
 * naming the FIRST gate that failed.
 */
function obProbeRingBand_(rows, total) {
  var max = OB_PROBE_RING_MAX_SEC_;
  var counts = [], i;
  for (i = 0; i <= max; i++) counts.push(0);
  (rows || []).forEach(function (r) {
    var sec = Math.round(Number(r && r.sec));
    var n = Number(r && r.n) || 0;
    if (!isFinite(sec) || sec < 0 || sec > max) return;
    counts[sec] += n;
  });
  var tot = Number(total) || 0;
  var out = {
    band: false, reason: '', sampled: tot, leftSec: null, rightSec: null,
    widthSec: null, baseline: null, bandCount: 0, bandShare: 0,
    baselineCount: 0, excessCount: 0, excessShare: 0, purity: null,
    shoulder: null, shoulderRatio: null, belowShare: 0, peaks: [],
    suggestedVmRingSec: null, suggestedToleranceSec: null,
  };
  if (tot < OB_PROBE_MIN_CONNECTED_) { out.reason = 'too-few-rows'; return out; }

  // Same robust baseline as the spike detector: the median bucket cannot be
  // moved by a band occupying a sixth of the domain, while a mean would be.
  var sorted = counts.slice().sort(function (a, b) { return a - b; });
  var mid = Math.floor(sorted.length / 2);
  var baseline = (sorted.length % 2) ? sorted[mid] : ((sorted[mid - 1] + sorted[mid]) / 2);
  out.baseline = baseline;

  // Scan for the window of width W, left edge at or above the timeout floor,
  // carrying the most mass. Expressed as excess over baseline because that is
  // the quantity the purity gate needs anyway; at FIXED width the two rank
  // windows identically (see the docblock -- the floor and the shoulder gate,
  // not this objective, are what keep it off the human cluster).
  var w = OB_PROBE_BAND_WIDTH_SEC_;
  var bestLeft = null, bestExcess = -Infinity;
  for (i = OB_PROBE_VM_FLOOR_SEC_; i + w - 1 <= max; i++) {
    var mass = 0;
    for (var j = i; j <= i + w - 1; j++) mass += counts[j];
    var excess = mass - (w * baseline);
    if (excess > bestExcess) { bestExcess = excess; bestLeft = i; }
  }
  if (bestLeft === null) { out.reason = 'empty-region'; return out; }

  // Trim to the band's own elevated edges so the threshold is data-determined.
  var edge = baseline * OB_PROBE_BAND_EDGE_RATIO_;
  var left = bestLeft, right = bestLeft + w - 1;
  while (left <= right && counts[left] < edge) left++;
  while (right >= left && counts[right] < edge) right--;
  if (left > right) { out.reason = 'empty-region'; return out; }
  out.leftSec = left; out.rightSec = right; out.widthSec = right - left + 1;

  var bandCount = 0;
  for (i = left; i <= right; i++) bandCount += counts[i];
  var baselineCount = out.widthSec * baseline;
  var excessCount = Math.max(0, bandCount - baselineCount);
  out.bandCount = bandCount;
  out.baselineCount = Math.round(baselineCount);
  out.excessCount = Math.round(excessCount);
  out.bandShare = Math.round((bandCount / tot) * 1000) / 1000;
  out.excessShare = Math.round((excessCount / tot) * 1000) / 1000;
  out.purity = bandCount > 0 ? Math.round((excessCount / bandCount) * 1000) / 1000 : null;

  var below = 0;
  for (i = 0; i < left; i++) below += counts[i];
  out.belowShare = Math.round((below / tot) * 1000) / 1000;

  // The local maxima inside the band, reported so the operator can see WHY
  // the single-peak detector could not hold this shape.
  for (i = left; i <= right; i++) {
    var hiL = (i === left) || counts[i] >= counts[i - 1];
    var hiR = (i === right) || counts[i] >= counts[i + 1];
    if (hiL && hiR && counts[i] >= edge) out.peaks.push({ sec: i, n: counts[i] });
  }

  // Separation from the human cluster. A band is only a band if the seconds
  // immediately below it are materially quieter -- otherwise it is the upper
  // tail of people answering, and every gate above would still pass.
  var lookFrom = Math.max(0, left - OB_PROBE_BAND_SEP_LOOKBACK_);
  var shoulderN = 0, shoulderBuckets = 0;
  for (i = lookFrom; i < left; i++) { shoulderN += counts[i]; shoulderBuckets++; }
  var shoulderMean = shoulderBuckets ? (shoulderN / shoulderBuckets) : 0;
  var bandMean = bandCount / out.widthSec;
  out.shoulder = Math.round(shoulderMean);
  out.shoulderRatio = bandMean > 0 ? Math.round((shoulderMean / bandMean) * 1000) / 1000 : null;

  if (out.bandShare < OB_PROBE_BAND_MIN_SHARE_) { out.reason = 'band-too-small'; return out; }
  if (out.excessShare < OB_PROBE_BAND_MIN_EXCESS_SHARE_) { out.reason = 'band-is-baseline'; return out; }
  if (out.purity < OB_PROBE_BAND_MIN_PURITY_) { out.reason = 'band-impure'; return out; }
  if (shoulderBuckets && out.shoulderRatio > OB_PROBE_BAND_MAX_SHOULDER_) { out.reason = 'no-trough'; return out; }
  if (out.belowShare < OB_PROBE_MIN_LOW_SHARE_) { out.reason = 'unimodal'; return out; }

  out.band = true;
  out.reason = 'ok';
  // Same output contract as the spike path: threshold at the left edge,
  // tolerance the half-width. A band's tolerance is necessarily wider, which
  // is exactly why `purity` travels with it.
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


/**
 * PURE. The probe's window defaults + validation (shared with the tests).
 *
 * `anchorIso` (optional) is the latest date the DATA actually holds, from
 * `obProbeAnchorDate_`. When the operator has not pinned the window, the
 * default ends at that date instead of at yesterday, so a window never
 * carries a silent tail of days with no rows -- which is what "the 28 days
 * ending yesterday" produced whenever an import had not run yet, quietly
 * measuring 27 days of data plus an empty one.
 *
 * ⚠ THE ANCHOR IS CAPPED AT YESTERDAY, and the cap is the P16 rule, not
 * caution. `max(call_date)` can BE today the moment a mid-day import lands
 * a partial day, and P16 is exactly that bug: a tool that decisions hang on
 * measuring an incomplete day. So the anchor may only ever pull the window
 * EARLIER than yesterday, never later. An explicit `OUTBOUND_PROBE_TO` is
 * untouched -- a date the operator typed is a decision, not a default.
 */
function obProbeWindow_(props, nowMs, anchorIso) {
  var msDay = 24 * 3600 * 1000;
  var iso = function (d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); };
  var yesterdayIso = iso(new Date((nowMs || Date.now()) - msDay));
  var defaultTo = yesterdayIso;
  if (isIsoDate_(anchorIso) && anchorIso < yesterdayIso) defaultTo = anchorIso;
  var to = String(props.getProperty('OUTBOUND_PROBE_TO') || defaultTo).trim();
  var from = String(props.getProperty('OUTBOUND_PROBE_FROM')
    || iso(new Date(new Date(to + 'T12:00:00Z').getTime() - 27 * msDay))).trim();
  if (!isIsoDate_(from) || !isIsoDate_(to) || from > to) {
    throw new Error('OUTBOUND_PROBE_FROM/_TO must be YYYY-MM-DD with from <= to (got '
      + from + ' .. ' + to + ').');
  }
  return { from: from, to: to, anchoredTo: (to === defaultTo && defaultTo === anchorIso) || false };
}

/**
 * The latest `call_date` the outbound capture holds, or null.
 *
 * NEVER THROWS and never widens a window: a failure here just leaves the
 * calendar default in place, because an anchor is a convenience and the four
 * tools must still run when it cannot be read. Its own tiny round trip, since
 * the window is a BOUND PARAMETER of each tool's main query and so has to be
 * settled before that query is prepared.
 */
function obProbeAnchorDate_(conn) {
  if (!conn) return null;
  var st = null, rs = null;
  try {
    st = conn.createStatement();
    rs = st.executeQuery('SELECT max(call_date)::text AS d FROM outbound_calls');
    var d = rs.next() ? rs.getString('d') : null;
    return isIsoDate_(d) ? d : null;
  } catch (e) {
    Logger.log('[outbound-probe] anchor date unavailable (%s); using the calendar default.', e);
    return null;
  } finally {
    if (rs) { try { rs.close(); } catch (e1) { /* closed */ } }
    if (st) { try { st.close(); } catch (e2) { /* closed */ } }
  }
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
  var from = win.from, to = win.to, anchor = null;
  var label = from + '..' + to + ' (all departments)';
  var conn = null;
  try {
    conn = (typeof getDashboardNeonConn_ === 'function') ? getDashboardNeonConn_() : null;
    if (!conn) return logStatusReturn_({ result: 'FAILED (Neon unreachable) ' + label });
    // Re-resolve the window now that a connection exists, so an UNSET window
    // ends at the latest date the data holds rather than at yesterday. The
    // pre-connection call above still validates an explicitly pinned window
    // (and throws on a bad one) before any connection is opened.
    anchor = obProbeAnchorDate_(conn);
    win = obProbeWindow_(props, null, anchor);
    from = win.from; to = win.to;
    label = from + '..' + to + ' (all departments)'
      + (win.anchoredTo ? ' [anchored to the latest data]' : '');

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
      +   'GROUP BY 1) rr), '
      // The SAME repeat check with the INSTANT population excluded. This is
      // the one signal here that can VALIDATE a threshold rather than assume
      // one -- the same callee answering at the same ring repeatedly is
      // voicemail with high confidence -- and on the 09-18 run it DISAGREED,
      // peaking at 0 s instead of near the spike. That is very likely an
      // artifact rather than a refutation: #65 established that 40.6% of
      // connects ring <= 1 s, and a population that large sitting in one
      // bucket regardless of destination swamps the modal ring of every
      // repeat group. Excluding it lets a real per-destination timeout show.
      // Reported BESIDE the unfiltered figure, never instead of it, so the
      // 0 s peak stays visible as the thing being explained.
      + "'repeatRingHistNoInstant', (SELECT COALESCE(json_agg(json_build_object('sec', sec, 'n', n) ORDER BY sec), '[]') "
      +   'FROM (SELECT ring_seconds::int AS sec, count(*) AS n FROM ('
      +     'SELECT callee_hash, ring_seconds ' + base
      // `OB_INSTANT_RING_SEC_` on purpose, not a local copy: "instant" must
      // mean here exactly what #65 measured it to mean, or the two tools
      // disagree about which rows they are talking about.
      +     'AND callee_hash IS NOT NULL AND ring_seconds IS NOT NULL AND ring_seconds > '
      +     OB_INSTANT_RING_SEC_ + ' AND ring_seconds <= '
      +     OB_PROBE_RING_MAX_SEC_ + ' GROUP BY 1,2 HAVING count(*) >= 2) gg2 '
      +   'GROUP BY 1) rr2)'
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

    // The MULTI-MODAL fallback. Only consulted when the single-peak detector
    // refused for a reason a band could legitimately explain -- a peak that
    // is too small or too wide is what mass split across several carrier
    // timeouts looks like through a one-peak test. Every other refusal
    // (too-few-rows, empty-region, flat, unimodal) is a property of the
    // whole distribution that a band cannot rescue, and running it there
    // would only offer a second chance at the same wrong answer.
    var BAND_ELIGIBLE_ = { 'spike-too-small': 1, 'too-wide': 1 };
    var band = (!spike.spike && BAND_ELIGIBLE_[spike.reason])
      ? obProbeRingBand_(d.ringHist, Number(d.conn1) || 0)
      : null;

    // The repeat check's own modal ring -- an INDEPENDENT estimate. It is
    // only meaningful as agreement or disagreement, so it is reported either
    // way and never averaged into the suggestion.
    var modeOf = function (hist) {
      var sec = null, n = 0;
      (hist || []).forEach(function (r) {
        if ((Number(r.n) || 0) > n) { n = Number(r.n) || 0; sec = Number(r.sec); }
      });
      return { sec: sec, n: n };
    };
    var rpt = modeOf(d.repeatRingHist);
    var rptNI = modeOf(d.repeatRingHistNoInstant);
    var repeatMode = rpt.sec, repeatModeN = rpt.n;
    // Which detector, if either, produced a defensible parameter set. The
    // peak is preferred whenever it passes: a 2s band implies a far higher
    // precision than a 13s one, so a passing spike is strictly the better
    // answer and this keeps the pre-band behaviour byte-identical.
    var basis = null;
    if (spike.spike) {
      basis = { kind: 'peak', lo: spike.suggestedVmRingSec, hi: spike.rightSec,
                tol: spike.suggestedToleranceSec, share: spike.spikeShare, purity: null };
    } else if (band && band.band) {
      basis = { kind: 'band', lo: band.suggestedVmRingSec, hi: band.rightSec,
                tol: band.suggestedToleranceSec, share: band.bandShare, purity: band.purity };
    }

    // Agreement is judged against the band that was actually ADOPTED, not
    // always the spike's: on a band basis the independent estimate has to be
    // tested against the range the parameters came from, or it would report
    // disagreement with a peak nothing is being set from.
    var repeatAgrees = (!!basis && repeatMode !== null
      && repeatMode >= basis.lo && repeatMode <= basis.hi);

    var out = {
      // `anchoredTo` / `anchorDate` so a SILENT anchor failure is visible: a
      // fallback to the calendar produces the same dates as an anchor that
      // happens to land on yesterday, and the whole point of the anchor is
      // to avoid measuring days with no data. Without this the two are
      // indistinguishable in the log.
      window: { from: from, to: to, anchoredToData: !!win.anchoredTo, anchorDate: anchor },
      connected: { total: Number(d.connTotal) || 0, singleAttempt: Number(d.conn1) || 0,
                   singleAttemptRingNull: Number(d.conn1RingNull) || 0,
                   singleAttemptRingOver60: Number(d.conn1RingOver) || 0 },
      ringHist: d.ringHist || [],
      ringHistAllAttempts: d.ringHistAll || [],
      talk: { measured: Number(d.talkTotal) || 0, over300: Number(d.talkOver) || 0 },
      talkHist: d.talkHist || [],
      spike: spike,
      bandScan: band,
      trough: trough,
      repeat: { groups: Number(d.repeatGroups) || 0, modalRingSec: repeatMode,
                modalRingGroups: repeatModeN, agreesWithSpike: repeatAgrees,
                hist: d.repeatRingHist || [],
                // The instant-excluded variant, and whether IT agrees. A
                // disagreement that survives the exclusion is a real
                // disagreement; one that does not was the instant population
                // all along.
                modalRingSecNoInstant: rptNI.sec,
                modalRingGroupsNoInstant: rptNI.n,
                agreesWithSpikeNoInstant: (!!basis && rptNI.sec !== null
                  && rptNI.sec >= basis.lo && rptNI.sec <= basis.hi),
                histNoInstant: d.repeatRingHistNoInstant || [] },
    };

    if (!basis) {
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
      out.result = 'INCONCLUSIVE (' + obProbeSpikeHint_(spike)
        + (band ? '; multi-modal band fallback also refused: ' + obProbeBandHint_(band) : '')
        + ') ' + label
        + ' — do NOT set OUTBOUND_VM_RING_SEC or enable OUTBOUND_ANSWER_QUALITY from this run.'
        + (out.exploratory ? ' An EXPLORATORY ring×talk cut at the observed peak is included'
            + ' for diagnosis only — it is not a measurement.' : '');
      Logger.log('[outbound-probe] %s', out.result);
      return logStatusReturn_(out);
    }

    // ── Query 2: the joint cuts, at the MEASURED band ────────────────────
    var lo = basis.lo;
    var hi = basis.hi;
    var minTalk = trough.suggestedMinTalkSec;
    var cut = obProbeJointCut_(conn, from, to, lo, hi, minTalk);
    out.quadrants = cut.quadrants;
    out.byAttempts = cut.attempts;
    out.band = { vmRingSec: lo, toleranceSec: basis.tol, rightSec: hi,
                 minTalkSec: minTalk, minTalkMeasured: trough.suggestedIsMeasured,
                 basis: basis.kind, purity: basis.purity };

    out.suggested = {
      OUTBOUND_VM_RING_SEC: lo,
      OUTBOUND_VM_RING_TOLERANCE_SEC: basis.tol,
      OUTBOUND_MIN_TALK_SEC: minTalk,
      OUTBOUND_ANSWER_QUALITY: 'off',
    };
    // Deliberately NOT inside `suggested`: that block is what an operator
    // copies key-for-key into Script Properties, and a `basis` key sitting in
    // it invites setting a property by that name (pinned by the deep-equal in
    // outbound-report.test.js). The ceiling still has to travel with the
    // parameters -- a band-derived threshold flags the baseline traffic inside
    // its own width as voicemail, and that is not recoverable from the three
    // numbers above -- so it sits beside them.
    out.suggestedBasis = {
      basis: basis.kind,
      expectedPrecisionCeiling: basis.purity,
      note: basis.kind === 'band'
        ? 'Derived from a MULTI-MODAL band, not a single timeout. About '
          + obProbePct1_(1 - (basis.purity || 0)) + ' of what this threshold flags will be a '
          + 'human who answered slowly. Validate against listened calls before enabling.'
        : 'Derived from a single tight timeout peak.',
    };
    if (typeof clearToolParamsAfterCleanRun_ === 'function') clearToolParamsAfterCleanRun_(
      ['OUTBOUND_PROBE_FROM', 'OUTBOUND_PROBE_TO'], 'probeOutboundAnswerQuality');
    out.result = 'ok '
      + (basis.kind === 'peak'
          ? ('bimodal: ring spike at ' + spike.peakSec + 's (band ' + lo + '-' + hi + 's, '
             + Math.round(spike.spikeShare * 100) + '% of ' + spike.sampled
             + ' single-attempt connects, ' + spike.widthSec + 's wide)')
          : ('MULTI-MODAL: no single timeout, but an elevated band at ' + lo + '-' + hi + 's '
             + 'holding ' + obProbePct1_(band.bandShare) + ' of ' + band.sampled
             + ' single-attempt connects across ' + band.peaks.length + ' peaks ('
             + band.peaks.map(function (pk) { return pk.sec + 's'; }).join(', ') + '). '
             + '⚠ PRECISION CEILING ' + obProbePct1_(band.purity) + ': only '
             + band.excessCount + ' of the band\'s ' + band.bandCount
             + ' calls sit above baseline, so roughly ' + obProbePct1_(1 - (band.purity || 0))
             + ' of what a threshold here flags would be a human who took a while to '
             + 'answer. Decide whether that is good enough BEFORE setting anything'))
      + '; repeat-callee modal ring (instant excluded) '
      + (rptNI.sec === null ? 'n/a' : rptNI.sec + 's')
      + (rptNI.sec === null ? '' : (out.repeat && out.repeat.agreesWithSpikeNoInstant
          ? ' AGREES' : ' DISAGREES'))
      + '; unfiltered ' + (repeatMode === null ? 'n/a' : repeatMode + 's')
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
function obProbeBandHint_(b) {
  switch (b && b.reason) {
    case 'too-few-rows':
      return 'only ' + b.sampled + ' single-attempt connected calls, need '
        + OB_PROBE_MIN_CONNECTED_ + ' — widen OUTBOUND_PROBE_FROM/_TO';
    case 'empty-region':
      return 'no band of elevated ring seconds at or above ' + OB_PROBE_VM_FLOOR_SEC_ + 's';
    case 'band-too-small':
      return 'the widest elevated band (' + b.leftSec + '-' + b.rightSec + 's) holds only '
        + obProbePct1_(b.bandShare) + ' of connects (need ' + obProbePct1_(OB_PROBE_BAND_MIN_SHARE_)
        + ') — too little to build a rule on';
    case 'band-is-baseline':
      return 'the ' + b.leftSec + '-' + b.rightSec + 's band is barely above background ('
        + obProbePct1_(b.excessShare) + ' of connects above baseline, need '
        + obProbePct1_(OB_PROBE_BAND_MIN_EXCESS_SHARE_) + ') — nothing is concentrated there';
    case 'band-impure':
      return 'the ' + b.leftSec + '-' + b.rightSec + 's band is only '
        + obProbePct1_(b.purity) + ' above-baseline mass (need '
        + obProbePct1_(OB_PROBE_BAND_MIN_PURITY_) + ') — roughly '
        + obProbePct1_(1 - (b.purity || 0)) + ' of anything it flagged would be a human who '
        + 'took a while to answer, which is too low a precision ceiling to set a threshold on';
    case 'no-trough':
      return 'the ' + b.leftSec + '-' + b.rightSec + 's band does not separate from the seconds '
        + 'below it (shoulder is ' + obProbePct1_(b.shoulderRatio) + ' of the band mean, max '
        + obProbePct1_(OB_PROBE_BAND_MAX_SHOULDER_) + ') — it is the upper tail of people '
        + 'answering, not a distinct population';
    case 'unimodal':
      return 'only ' + obProbePct1_(b.belowShare) + ' of connects ring SHORTER than the band '
        + '(need ' + obProbePct1_(OB_PROBE_MIN_LOW_SHARE_) + ') — no human cluster below it';
    default:
      return 'no voicemail band found';
  }
}

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
// PHI: aggregates and derived seconds only. Nothing from the journey blob is
// echoed -- only counts and durations -- so its own masking is a second line
// rather than the guarantee. (Do not read that masking as the external-leg
// marker: `icBuildJourney_` labels from CALLEE_NAME, which an outbound dial
// leaves blank, so the phone-shaped rewrite never fires here. See
// `obInstantDerivedRing_`.) No hash, number or call id is selected, logged or
// returned.

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
 * TWO markers, in order of authority:
 *
 * 1. An event named exactly '(external number)'. This is what the function
 *    originally looked for, ALONE -- and `probeOutboundJourneyShape` measured
 *    it at ZERO events across 600 sampled rows, which is not bad luck but
 *    structural: `icBuildJourney_` names an event from CALLEE_NAME, and an
 *    outbound dial carries the number in CALLEE with CALLEE_NAME blank, so
 *    the phone-shaped branch never fires and the leg falls through to
 *    '(unknown)'. The marker is kept FIRST so that a capture-side fix which
 *    starts labelling the leg takes precedence here with no reader change.
 *
 * 2. The first 'unknown'-class event -- the measured fallback. On the answer
 *    key (rows that provably rang >= OB_INSTANT_RUNG_SEC_) it covered 100% of
 *    rows and derived a median 27s with every value a real ring, while the
 *    same marker read a median 1s on the instant group: it tracks the stored
 *    ring across both populations, which an internal hop would not. NOTE the
 *    class, not the position -- `obJourneyNameClass_` scores a queue event as
 *    'queue' whatever its name, so a call that passed through a queue first
 *    skips the queue rather than measuring it (ev[0] would not).
 *
 * Returns null when neither marker resolves to an event with a duration:
 * absent evidence, never a zero. Callers count those separately.
 */
function obInstantDerivedRing_(journeyJson) {
  var ev;
  try { ev = JSON.parse(journeyJson || 'null'); } catch (e) { return null; }
  if (!ev || !ev.length) return null;
  var i, c;
  // 1. A phone-SHAPED callee name. Never seen on outbound (0 of 1200 sampled
  //    events across two runs), kept first so a capture fix that starts
  //    emitting it wins here with no reader change.
  for (i = 0; i < ev.length; i++) {
    if (ev[i] && ev[i].name === '(external number)') return obJourneyEventRing_(ev[i]);
  }
  // 2. The P-11 MASKED external party -- initials, or '(external caller)' when
  //    the mask declined. This is the external leg BY CONSTRUCTION: P-11's
  //    branch fires only for a leg whose CALLEE is an external number.
  for (i = 0; i < ev.length; i++) {
    c = obJourneyNameClass_(ev[i]);
    if (c === 'initials' || c === 'extCaller') return obJourneyEventRing_(ev[i]);
  }
  // 3. PRE-P-11 rows only. Before 2026-09-17 that branch did not exist, so a
  //    CNAM-carrying external leg fell through to '(unknown)' and the first
  //    unknown event WAS the external leg. It no longer is: on post-P-11 rows
  //    the external leg is masked (step 2) and the remaining '(unknown)' is
  //    the other leg, whose secs-talk-hold is a residual, not a ring.
  for (i = 0; i < ev.length; i++) {
    if (obJourneyNameClass_(ev[i]) === 'unknown') return obJourneyEventRing_(ev[i]);
  }
  return null;
}

/**
 * PURE. PHI-SAFE class of a journey event's name -- a CLASS, never the name.
 *
 * `icBuildJourney_` (cdr-import/inboundCalls.js) masks a callee name through
 * one of several branches, and the resulting string is the ONLY thing in the
 * blob that can identify the external leg (the event carries no direction and
 * no callee number). The classes below are every shape that masker can emit:
 *
 *   extNumber  '(external number)'   the name was phone-SHAPED
 *   extCaller  '(external caller)'   P-11 fallback when initials came back null
 *   initials   'A.P.'                P-11 masked CNAM (cdrMaskExternalName_)
 *   unknown    '(unknown)'           empty / 'N/A' callee name
 *   queue                            event kind is 'queue'
 *   other                            an internal agent's CNAM -- counted only
 *
 * Nothing but the class name is ever returned, so an 'other' CNAM cannot leak.
 */
function obJourneyNameClass_(ev) {
  if (!ev) return 'other';
  if (ev.kind === 'queue') return 'queue';
  var n = String(ev.name == null ? '' : ev.name);
  if (n === '(external number)') return 'extNumber';
  if (n === '(external caller)') return 'extCaller';
  if (n === '(unknown)') return 'unknown';
  if (/^(?:[A-Za-z0-9]\.)+$/.test(n)) return 'initials';
  return 'other';
}

/** PURE. The derived ring for ONE event, or null when it carries no duration. */
function obJourneyEventRing_(ev) {
  if (!ev || ev.secs == null) return null;
  return Math.max(0, (Number(ev.secs) || 0) - (Number(ev.talk) || 0) - (Number(ev.hold) || 0));
}

/**
 * PURE. Score every CANDIDATE external-leg marker over one sampled group.
 *
 * Why a table instead of a shape dump: `obInstantDerivedRing_` matches exactly
 * one marker ('(external number)') and the live run found it on ZERO of 600
 * rows, but its null is overloaded -- "no event matched" and "matched, no
 * `secs`" are indistinguishable in the output, and they need different fixes.
 * So this splits that, and then asks the only question that decides the fix:
 * for each candidate marker, how many rows WOULD yield a derived ring, and
 * what is its median?
 *
 * The rung group is the answer key. Its rows provably rang >= 17 s, so the
 * right marker is the one whose derived median lands near that on the rung
 * group -- a candidate that yields a plausible number there is measuring the
 * external leg; one that yields ~0 s is measuring an internal hop. A marker is
 * NOT chosen by coverage alone: a 100%-coverage candidate that reads 0 s on
 * calls known to have rung is wrong, just confidently.
 *
 * `journeys` is an array of parsed event arrays. Returns counts + medians only.
 */
function obJourneyMarkerScores_(journeys) {
  var CLASSES = ['extNumber', 'extCaller', 'initials', 'unknown', 'queue', 'other'];
  var out = {
    rows: journeys.length,
    eventCountHist: {},
    classEvents: {},        // total events per class
    classWithSecs: {},      // ...of which carry `secs`
    rowsWithClass: {},      // rows holding at least one event of the class
    current: { derived: 0, nullNoMatch: 0, nullMatchNoSecs: 0 },
    candidates: {},
  };
  CLASSES.forEach(function (c) {
    out.classEvents[c] = 0; out.classWithSecs[c] = 0; out.rowsWithClass[c] = 0;
    out.candidates[c] = { rows: 0, rings: [] };
  });
  ['firstEvent', 'lastEvent', 'lastAnswer', 'maxSecs'].forEach(function (k) {
    out.candidates[k] = { rows: 0, rings: [] };
  });

  journeys.forEach(function (ev) {
    var n = ev.length;
    out.eventCountHist[n] = (out.eventCountHist[n] || 0) + 1;
    var seen = {}, best = null, lastAnswer = null;
    for (var i = 0; i < n; i++) {
      var c = obJourneyNameClass_(ev[i]);
      out.classEvents[c]++;
      if (ev[i] && ev[i].secs != null) out.classWithSecs[c]++;
      if (!seen[c]) { seen[c] = true; out.rowsWithClass[c]++; }
      if (ev[i] && ev[i].kind === 'answer') lastAnswer = ev[i];
      if (ev[i] && ev[i].secs != null && (best === null || Number(ev[i].secs) > Number(best.secs))) best = ev[i];
    }
    // Per-row candidate resolution: FIRST event of the class, as the helper does.
    CLASSES.forEach(function (c) {
      for (var i = 0; i < n; i++) {
        if (obJourneyNameClass_(ev[i]) !== c) continue;
        var r = obJourneyEventRing_(ev[i]);
        if (r !== null) { out.candidates[c].rows++; out.candidates[c].rings.push(r); }
        return;   // first of the class only, match or not
      }
    });
    var positional = { firstEvent: ev[0], lastEvent: ev[n - 1], lastAnswer: lastAnswer, maxSecs: best };
    Object.keys(positional).forEach(function (k) {
      var r = obJourneyEventRing_(positional[k]);
      if (r !== null) { out.candidates[k].rows++; out.candidates[k].rings.push(r); }
    });
    // Reproduce the CURRENT helper, splitting its overloaded null.
    var matched = null;
    for (var j = 0; j < n; j++) {
      if (ev[j] && ev[j].name === '(external number)') { matched = ev[j]; break; }
    }
    if (!matched) out.current.nullNoMatch++;
    else if (matched.secs == null) out.current.nullMatchNoSecs++;
    else out.current.derived++;
  });

  Object.keys(out.candidates).forEach(function (k) {
    var c = out.candidates[k];
    c.coverage = out.rows ? Math.round(c.rows / out.rows * 1000) / 1000 : 0;
    c.medianDerived = obInstantMedian_(c.rings);
    c.realRingShare = c.rings.length
      ? Math.round(c.rings.filter(function (x) { return x >= OB_INSTANT_REAL_RING_SEC_; }).length
          / c.rings.length * 1000) / 1000 : 0;
    delete c.rings;   // counts + medians only; never the per-call values
  });
  return out;
}

/**
 * DIAGNOSTIC (read-only, admin-gated, editor-run). Why
 * `probeOutboundInstantConnects` returns `no-journeys`, and which marker fixes
 * it. Operator State #65; write-up in docs/outbound-callback-dept-plan.md.
 *
 * Sets nothing and returns no per-call value: event-name CLASSES, counts,
 * coverage and medians only, so an internal CNAM cannot leak. Reuses
 * `OUTBOUND_PROBE_FROM`/`_TO` and the `outbound-instant` egress label.
 *
 * READ THE RUNG GROUP FIRST. It is the answer key -- those rows provably rang
 * >= 17 s, so a candidate marker is only correct if its derived median lands
 * near that there. Coverage alone proves nothing.
 */
function probeOutboundJourneyShape() {
  assertAdmin_();
  var props = PropertiesService.getScriptProperties();
  var win = obProbeWindow_(props);
  var from = win.from, to = win.to, anchor = null;
  var label = from + '..' + to + ' (all departments)';
  var conn = null;
  try {
    conn = (typeof getDashboardNeonConn_ === 'function') ? getDashboardNeonConn_() : null;
    if (!conn) return logStatusReturn_({ result: 'FAILED (Neon unreachable) ' + label });
    // Re-resolve the window now that a connection exists, so an UNSET window
    // ends at the latest date the data holds rather than at yesterday. The
    // pre-connection call above still validates an explicitly pinned window
    // (and throws on a bad one) before any connection is opened.
    anchor = obProbeAnchorDate_(conn);
    win = obProbeWindow_(props, null, anchor);
    from = win.from; to = win.to;
    label = from + '..' + to + ' (all departments)'
      + (win.anchoredTo ? ' [anchored to the latest data]' : '');

    var base = 'FROM outbound_calls WHERE call_date BETWEEN ?::date AND ?::date '
      + 'AND connected AND COALESCE(attempts,1) = 1 AND ring_seconds IS NOT NULL ';
    var sql =
      "SELECT COALESCE(json_agg(t), '[]')::text AS j FROM ("
      + "(SELECT 'instant' AS grp, journey " + base
      +   'AND ring_seconds <= ' + OB_INSTANT_RING_SEC_ + ' AND journey IS NOT NULL '
      +   'ORDER BY call_date DESC, call_start DESC NULLS LAST LIMIT ' + OB_INSTANT_SAMPLE_ + ') '
      + 'UNION ALL '
      + "(SELECT 'rung' AS grp, journey " + base
      +   'AND ring_seconds >= ' + OB_INSTANT_RUNG_SEC_ + ' AND journey IS NOT NULL '
      +   'ORDER BY call_date DESC, call_start DESC NULLS LAST LIMIT ' + OB_INSTANT_SAMPLE_ + ')'
      + ') t';
    var ps = conn.prepareStatement(sql);
    var np = (sql.match(/\?::date/g) || []).length;
    for (var pi = 1; pi + 1 <= np; pi += 2) { ps.setString(pi, from); ps.setString(pi + 1, to); }
    var rs = ps.executeQuery();
    var j = rs.next() ? rs.getString('j') : '[]';
    if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(j ? j.length : 0, 'outbound-instant');
    rs.close(); ps.close();

    var groups = { instant: [], rung: [] };
    var unparseable = { instant: 0, rung: 0 }, empty = { instant: 0, rung: 0 };
    JSON.parse(j || '[]').forEach(function (r) {
      var g = (r && r.grp === 'rung') ? 'rung' : 'instant';
      var ev;
      try { ev = JSON.parse(r && r.journey || 'null'); } catch (e) { unparseable[g]++; return; }
      if (!ev || !ev.length) { empty[g]++; return; }
      groups[g].push(ev);
    });

    var out = {
      // `anchoredTo` / `anchorDate` so a SILENT anchor failure is visible: a
      // fallback to the calendar produces the same dates as an anchor that
      // happens to land on yesterday, and the whole point of the anchor is
      // to avoid measuring days with no data. Without this the two are
      // indistinguishable in the log.
      window: { from: from, to: to, anchoredToData: !!win.anchoredTo, anchorDate: anchor },
      note: 'DIAGNOSTIC for Operator State #65. Sets nothing. Read the RUNG group '
          + 'first -- it is the answer key (those rows rang >= '
          + OB_INSTANT_RUNG_SEC_ + 's, so the right marker derives near that there).',
      instant: obJourneyMarkerScores_(groups.instant),
      rung: obJourneyMarkerScores_(groups.rung),
      unparseableJourney: unparseable,
      emptyJourney: empty,
    };
    out.instant.unparseable = unparseable.instant; out.instant.empty = empty.instant;
    out.rung.unparseable = unparseable.rung; out.rung.empty = empty.rung;

    var cur = out.rung.current;
    out.result = 'diagnostic ' + label
      + ' — sampled instant=' + out.instant.rows + ' rung=' + out.rung.rows
      + '; the CURRENT marker resolved ' + cur.derived + '/' + out.rung.rows
      + ' rung rows (' + cur.nullNoMatch + ' no-match, ' + cur.nullMatchNoSecs
      + ' matched-but-no-secs). Compare candidates[*].medianDerived on the RUNG '
      + 'group against its >= ' + OB_INSTANT_RUNG_SEC_ + 's stored ring to pick the marker.';
    Logger.log('[outbound-jshape] %s', out.result);
    return logStatusReturn_(out);
  } finally {
    if (conn) { try { conn.close(); } catch (ce) { /* already closed */ } }
  }
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
  var from = win.from, to = win.to, anchor = null;
  var label = from + '..' + to + ' (all departments)';
  var conn = null;
  try {
    conn = (typeof getDashboardNeonConn_ === 'function') ? getDashboardNeonConn_() : null;
    if (!conn) return logStatusReturn_({ result: 'FAILED (Neon unreachable) ' + label });
    // Re-resolve the window now that a connection exists, so an UNSET window
    // ends at the latest date the data holds rather than at yesterday. The
    // pre-connection call above still validates an explicitly pinned window
    // (and throws on a bad one) before any connection is opened.
    anchor = obProbeAnchorDate_(conn);
    win = obProbeWindow_(props, null, anchor);
    from = win.from; to = win.to;
    label = from + '..' + to + ' (all departments)'
      + (win.anchoredTo ? ' [anchored to the latest data]' : '');

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
      // `anchoredTo` / `anchorDate` so a SILENT anchor failure is visible: a
      // fallback to the calendar produces the same dates as an anchor that
      // happens to land on yesterday, and the whole point of the anchor is
      // to avoid measuring days with no data. Without this the two are
      // indistinguishable in the log.
      window: { from: from, to: to, anchoredToData: !!win.anchoredTo, anchorDate: anchor },
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
    // `noExternalLeg` = NEITHER marker in `obInstantDerivedRing_` resolved to
    // an event carrying a duration. Before the measured fallback landed this
    // was every row (300/300 on both groups), which is what made the first
    // live run verdict `no-journeys`.
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

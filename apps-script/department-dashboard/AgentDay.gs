/**
 * Agent-day interaction view (6d) -- "what did agent X actually do on day Y?"
 *
 * The manager-facing question this answers is not "how many calls" (My
 * Department and the Individual Report already answer that) but "walk me
 * through the day": which calls this agent touched, in order, with the role
 * they played on each and how it ended. The day HEADER carries the familiar
 * aggregate so the page reconciles with the rest of the app at a glance; the
 * per-call list underneath is the detail nothing else surfaces.
 *
 * Public entry (callable via google.script.run):
 *   getAgentDay({ agentName, date })
 *     -> { meta: {...}, day: {...}, inbound: [...], outbound: [...], missedRings: [...] }
 *
 * ── THE HORIZON, AND WHY IT IS THREE TIERS (owner decision 2026-09-14) ──────
 *
 * The 14-day `Call_Legs_*` prune is the REBUILD horizon (Operator State #43),
 * NOT the read horizon -- a natural assumption that would have shaped this
 * surface wrongly. The per-call tables are fed daily out of Raw Data and are
 * pruned on their OWN schedule (NeonRetention.gs):
 *
 *   tier      age            source                        fidelity
 *   full      0..journeyDays inbound_calls.journey +        every agent who
 *                            outbound_calls                 touched the call
 *   degraded  ..callDays     same rows, journey PRUNED      first_agent only
 *                            (outbound stays exact --       on the inbound
 *                            agent_name is a real column)   side
 *   dqe-only  beyond that    DQE K-AC / AF slot timestamps  MISSED rings only
 *
 * The accepted cost: past the journey horizon the inbound side can only show
 * calls this agent RANG FIRST, and that window can never be recovered later --
 * the per-leg agent set exists nowhere else once `journey` is NULLed. The
 * owner took that trade rather than add a capture column, so the honest
 * response is to SAY SO on the page rather than quietly show less; `meta.tier`
 * + `meta.degradedReason` drive that disclosure.
 *
 * The tier is decided by WHAT CAME BACK, not by the calendar alone
 * (`agentDayTier_`): the retention prune is flag-gated and its horizons are
 * Script-Property tunable, so a calendar-only guess would mislabel a day in
 * both directions -- claiming full fidelity on a pruned day, or apologising
 * for a degrade that never happened. The calendar horizons are carried in
 * meta purely so the client can EXPLAIN a degrade it is already showing.
 *
 * ── AUTHORIZATION (server-derived, never the client's word) ─────────────────
 *
 * The client sends an agent NAME. The dept is re-derived here from the
 * ROSTER (`buildDeptsByAgent_`, INV-04 exact match) and run through the
 * shared `assertDeptAccess_` gate, so this surface inherits every fix that
 * gate has had (the R-3 allDepts widenings, the Tier C multi-dept list, the
 * Phase A agent-role allowlist). Three rules worth knowing:
 *   - NEVER `outbound_calls.department`: that is the raw CDR org label and
 *     matches no dashboard header in this install.
 *   - A CROSSOVER agent has several roster homes; a manager is entitled if
 *     ANY of them is theirs, so the homes are tried in turn and the first
 *     one that passes wins (assertDeptAccess_ takes a single dept).
 *   - An UNROSTERED name (ex-employee, orphan spelling) resolves to no home
 *     at all and is therefore ADMIN-ONLY -- falling back to "let anyone see
 *     it" would make the gate bypassable by misspelling an agent.
 * This surface exposes ANSWERED calls, which `callIdInDeptMissedReport_`
 * (the missed-report entitlement) does not cover -- hence its own gate
 * rather than reusing that one.
 *
 * ── PHI ─────────────────────────────────────────────────────────────────────
 * No raw phone number is read, stored, logged or returned: this reads the
 * capture tables by (call_date, agent) and never touches a hash or a number.
 * `(external number)` / `(external caller)` placeholders are already applied
 * at capture. Responses are NOT cached -- the Caller Lookup model; a day view
 * is cheap and an agent-keyed payload has no business in the shared script
 * cache. Usage is logged (`logReportUsage_`, the INV-01 append-only carve-out)
 * and the Neon read is labelled for the Health page's egress ranking.
 */

var AGENT_DAY_MAX_CALLS_ = 300;

// Owner (2026-10, Batch A): the outbound capture's first date (Operator State
// #57: "capture start 2026-07-10"). Before it the outbound_calls table holds
// nothing for ANY agent, so an empty outbound list on an earlier day means
// "not captured", never "placed no calls" -- even on a full-tier inbound day,
// because inbound capture began earlier.
var AGENT_DAY_OUTBOUND_CAPTURE_START_ = '2026-07-10';

/**
 * PURE. The agent's ROSTER homes, alphabetical. Empty for an unrostered name.
 * Split out so the auth test can drive it without a spreadsheet.
 */
function agentDayRosterHomes_(agentName) {
  var byAgent = (typeof buildDeptsByAgent_ === 'function') ? buildDeptsByAgent_() : {};
  var homes = byAgent[agentName];
  return (homes && homes.length) ? homes.slice() : [];
}

/**
 * Resolve + authorize. Returns { user, agentName, date, dept, homes,
 * unrostered }. Throws with the same message shapes the other report
 * resolvers use.
 */
function agentDayResolve_(req) {
  var agentName = String((req && req.agentName) || '').trim();
  var date = String((req && req.date) || '').trim();
  if (!agentName) throw new Error('agentName is required.');
  if (!isIsoDate_(date)) throw new Error('date must be YYYY-MM-DD.');
  var scope = agentDayAuthorize_(agentName);
  scope.date = date;
  return scope;
}

/**
 * The entitlement half of agentDayResolve_, shared with getAgentDayStrip
 * (Batch B) so the day view and the strip that leads to it can never disagree
 * about who may see an agent. Returns { user, agentName, dept, homes,
 * unrostered }; the caller has already validated its own inputs.
 */
function agentDayAuthorize_(agentName) {
  var user = resolveUser_(Session.getActiveUser().getEmail());
  var homes = agentDayRosterHomes_(agentName);
  if (!homes.length) {
    // Unrostered: admin-only. assertAdmin_ rather than a role compare, so an
    // unrecognized role is refused by the same allowlist everything else uses.
    assertAdmin_();
    return { user: user, agentName: agentName, dept: null,
             homes: [], unrostered: true };
  }
  // Entitled if ANY roster home passes the shared gate. The LAST failure is
  // re-thrown so the caller sees a real reason ("Not authorized for this
  // department.") rather than a message this file invented.
  var lastErr = null;
  for (var i = 0; i < homes.length; i++) {
    try {
      assertDeptAccess_(user, homes[i]);
      return { user: user, agentName: agentName, dept: homes[i],
               homes: homes, unrostered: false };
    } catch (e) { lastErr = e; }
  }
  throw (lastErr || new Error('Not authorized for this agent.'));
}

/**
 * PURE. Which fidelity tier this day's data actually reached.
 *
 * Decided by the DATA, not the calendar -- see the header. `anyJourney` is
 * true when at least one inbound row came back with a parsed journey;
 * `inboundRows` counts the rows the capture holds for the day at all.
 *
 *   'full'      journeys present -> every agent who touched a call is known
 *   'degraded'  capture rows but no journey -> first_agent only
 *   'dqe-only'  no capture rows at all -> the DQE slot timestamps are the
 *               whole story, which is MISSED rings and nothing else
 */
function agentDayTier_(inboundRows, anyJourney, outboundRows) {
  if (anyJourney) return 'full';
  if (inboundRows > 0 || outboundRows > 0) return 'degraded';
  return 'dqe-only';
}

/**
 * PURE. Age of an ISO date in whole days relative to `todayIso`. Negative for
 * a future date. UTC arithmetic so a DST boundary cannot shift it (the
 * ovIsoMinusDays_ discipline).
 */
function agentDayAgeDays_(dateIso, todayIso) {
  var a = String(dateIso).split('-'), b = String(todayIso).split('-');
  if (a.length !== 3 || b.length !== 3) return 0;
  var d1 = Date.UTC(+a[0], +a[1] - 1, +a[2]);
  var d2 = Date.UTC(+b[0], +b[1] - 1, +b[2]);
  return Math.round((d2 - d1) / 86400000);
}

/**
 * PURE. This agent's ROLE on one inbound call, read off the journey.
 *
 * Returns { role, ringSec, talkSec, order } or null when the agent does not
 * appear in the journey at all -- the caller DROPS those rows, which is what
 * keeps a `journey LIKE '%name%'` substring false positive (one agent's name
 * inside another's, or inside a queue name) out of the list. INV-04 exact
 * match on `ev.name`, the ahWaitJoin_ rule.
 *
 * Roles, strongest first -- an agent can appear on several legs of one call
 * (rang, missed, rang again, answered) and the STRONGEST wins, because
 * "answered" is the fact a manager is looking for:
 *   answered > missed > rang
 */
function agentDayInboundRole_(journey, agentName) {
  if (!journey || !journey.length) return null;
  var best = null, rank = { rang: 1, missed: 2, answered: 3 };
  for (var i = 0; i < journey.length; i++) {
    var ev = journey[i];
    if (!ev || ev.name !== agentName) continue;
    // PC-3 (broad-scan 2026-10-01): `transfer:true` events are CROSS-REFERENCED
    // provenance (inboundCalls.js: the R11-N append and the internal record's
    // synthetic origin head -- "not an in-call leg"). The origin head names the
    // agent who ANSWERED the customer and transferred, so without this skip that
    // agent's day listed the customer call AND the internal transfer record as
    // answered, and talkSec counted the same conversation twice.
    if (ev.transfer) continue;
    var role = (ev.kind === 'answer' || (typeof ev.talk === 'number' && ev.talk > 0))
      ? 'answered' : (ev.missed ? 'missed' : 'rang');
    var cand = {
      role: role,
      ringSec: (typeof ev.secs === 'number') ? ev.secs : null,
      talkSec: (typeof ev.talk === 'number') ? ev.talk : null,
      order: i,
      // Owner (2026-10, Batch A): the hold on THIS agent's own leg (the
      // capture's per-leg `hold`), not the call's total hold.
      holdSec: (typeof ev.hold === 'number') ? ev.hold : 0,
      t: ev.t || null,
    };
    if (!best || rank[role] > rank[best.role]) best = cand;
  }
  if (best && best.role === 'answered') best.transferredOn = agentDayTransferredOn_(journey, agentName, best);
  return best;
}

/**
 * PURE. Did a call this agent ANSWERED move on to someone else afterwards?
 *
 * True when the journey holds a later leg -- starting more than a second after
 * the agent's answered leg -- that is not the agent's own. A queue rings its
 * agents in the same second, so the 1 s margin keeps those simultaneous rings
 * from reading as a transfer (the transfer probe's "after someone answered"
 * rule, cdr-import/transferFilter.js). Cross-referenced `transfer:true`
 * events count: the R11-N append records the queue the caller was sent to.
 * Times are the journey's HH:MM:SS; a leg without one is never counted.
 */
function agentDayTransferredOn_(journey, agentName, answered) {
  var t0 = agentDayClockSec_(answered && answered.t);
  if (t0 == null) return false;
  for (var i = 0; i < journey.length; i++) {
    var ev = journey[i];
    if (!ev || i === answered.order || ev.name === agentName) continue;
    var t = agentDayClockSec_(ev.t);
    if (t != null && t > t0 + 1) return true;
  }
  return false;
}

/** PURE. "HH:MM:SS" -> seconds of the day, or null. */
function agentDayClockSec_(t) {
  var m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(t == null ? '' : t).trim());
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : null;
}

/**
 * PURE. Shape one inbound capture row into an agent-day entry, given the
 * agent's role on it. Deliberately a SUBSET of callerLookupShapeCall_'s
 * fields: this view answers "what did the agent do", so the caller-identity
 * fields that shaper carries for a caller-targeted lookup are not carried
 * here at all.
 */
function agentDayShapeInbound_(r, roleInfo) {
  return {
    callId:       r.call_id || null,
    callStart:    r.call_start || null,     // raw PST; the client shifts to CST
    role:         roleInfo ? roleInfo.role : 'rang',
    ringSec:      roleInfo ? roleInfo.ringSec : null,
    talkSec:      roleInfo ? roleInfo.talkSec : null,
    entryQueue:   r.entry_queue || null,
    finalQueue:   r.final_queue || null,
    disposition:  r.disposition || null,
    abandonStage: r.abandon_stage || null,
    waitSeconds:  r.wait_seconds == null ? null : (Number(r.wait_seconds) || 0),
    holdSeconds:  Number(r.hold_seconds) || 0,
    isInternal:   !!r.is_internal,
    numTransfers: Number(r.num_transfers) || 0,
    // Owner (2026-10, Batch A): this agent's own hold and whether the call
    // moved on after they answered. Journey-derived, so absent (0 / false)
    // on a degraded day -- the client shows those tiles on a full day only.
    agentHoldSec:  roleInfo ? (Number(roleInfo.holdSec) || 0) : 0,
    transferredOn: !!(roleInfo && roleInfo.transferredOn),
  };
}

/**
 * PURE. Does this row belong on THIS agent's page, and in what role?
 *
 * The SQL pre-filter is `journey LIKE '%name%' OR first_agent = ?`, and the
 * LIKE half is a SUPERSET on purpose (it is cheap and index-free). Two arms
 * decide what survives it:
 *   - the journey names this agent EXACTLY (INV-04) -> keep, with that role;
 *   - no exact appearance, but they RANG IT FIRST -> keep as 'rang'. This is
 *     the whole degraded tier: once `journey` is pruned there is nothing to
 *     match on, and dropping these would make every day past the journey
 *     horizon render EMPTY rather than as a disclosed subset.
 * Anything else is a LIKE false positive -- one agent's name inside another's,
 * or inside a queue name -- and keeping it would put someone else's call on
 * this agent's page.
 *
 * Returns the roleInfo to render with, or null to drop the row.
 */
function agentDayKeepRow_(roleInfo, firstAgent, agentName) {
  if (roleInfo) return roleInfo;
  if (firstAgent === agentName) {
    return { role: 'rang', ringSec: null, talkSec: null, order: 0 };
  }
  return null;
}

/** PURE. One outbound capture row -> an agent-day entry. */
function agentDayShapeOutbound_(r) {
  return {
    callId:     r.call_id || null,
    callStart:  r.call_start || null,
    connected:  !!r.connected,
    talkSec:    Number(r.talk_seconds) || 0,
    ringSec:    r.ring_seconds == null ? null : (Number(r.ring_seconds) || 0),
    attempts:   Number(r.attempts) || 1,
  };
}

/**
 * PURE. Fold the day's entries into the counts the header strip shows.
 * Kept separate from the DQE aggregate on purpose -- see `agentDayReconcile_`.
 */
function agentDayCounts_(inbound, outbound) {
  var c = { inboundTotal: 0, answered: 0, missed: 0, rang: 0,
            outboundTotal: 0, outboundConnected: 0, talkSec: 0,
            // Owner (2026-10, Batch A): the two directions kept apart for the
            // tile rows. `talkSec` stays their sum for existing readers.
            inboundTalkSec: 0, outboundTalkSec: 0,
            agentHoldSec: 0, holdCalls: 0, transferredOn: 0,
            outboundAttempts: 0, outboundUnconnectedBrief: 0,
            outboundUnconnectedReal: 0, outboundUnconnectedUnknown: 0 };
  (inbound || []).forEach(function (e) {
    c.inboundTotal++;
    if (e.role === 'answered') {
      c.answered++;
      var t = Number(e.talkSec) || 0;
      c.talkSec += t; c.inboundTalkSec += t;
      var hold = Number(e.agentHoldSec) || 0;
      if (hold > 0) { c.agentHoldSec += hold; c.holdCalls++; }
      if (e.transferredOn) c.transferredOn++;
    }
    else if (e.role === 'missed') c.missed++;
    else c.rang++;
  });
  (outbound || []).forEach(function (e) {
    c.outboundTotal++;
    c.outboundAttempts += Number(e.attempts) || 1;
    var t = Number(e.talkSec) || 0;
    c.talkSec += t; c.outboundTalkSec += t;
    if (e.connected) { c.outboundConnected++; return; }
    // The Outbound report's ring split (OUTBOUND_BRIEF_RING_SEC_), so an
    // agent's day and the report bucket an unconnected call the same way.
    var cls = (typeof outboundClassifyRing_ === 'function')
      ? outboundClassifyRing_(e.ringSec) : 'unknown';
    if (cls === 'brief') c.outboundUnconnectedBrief++;
    else if (cls === 'real') c.outboundUnconnectedReal++;
    else c.outboundUnconnectedUnknown++;
  });
  return c;
}

/**
 * PURE. Can this day's outbound list be read as the agent's whole outbound
 * day? No when Neon was unreachable, when no capture rows came back at all
 * (the 'dqe-only' tier), or when the date is before outbound capture began --
 * in all three an empty list means "not captured", not "placed no calls".
 */
function agentDayOutboundCaptured_(meta, dateIso) {
  if (!meta || !meta.neonAvailable || meta.tier === 'dqe-only') return false;
  return String(dateIso || '') >= AGENT_DAY_OUTBOUND_CAPTURE_START_;
}

/**
 * PURE. Compare the per-call list against the DQE agent-day aggregate and say
 * whether they agree, WITHOUT ever "fixing" either.
 *
 * They legitimately disagree on a degraded day (the list is a subset) and on
 * any day where a call the capture holds falls outside the DQE work window.
 * The point is to make the gap VISIBLE rather than let a manager silently
 * read a short list as the whole day -- the same discipline as the combined
 * view's crossover caption. `exact` is only claimed on a FULL-tier day whose
 * numbers actually line up.
 */
function agentDayReconcile_(counts, day, tier) {
  if (!day || day.answered == null) return { checked: false, exact: false, note: null };
  var listAnswered = Number(counts.answered) || 0;
  var dqeAnswered = Number(day.answered) || 0;
  if (tier !== 'full') {
    return { checked: true, exact: false,
             note: 'The call list is a SUBSET of this day: ' + dqeAnswered
               + ' answered in the daily totals, ' + listAnswered + ' recoverable per-call.' };
  }
  if (listAnswered === dqeAnswered) return { checked: true, exact: true, note: null };
  return { checked: true, exact: false,
           note: 'Per-call list shows ' + listAnswered + ' answered; the daily total says '
             + dqeAnswered + '. Calls outside the work window are counted by one and not the other.' };
}

/** Empty payload skeleton -- one shape whatever happened, so the client never branches on undefined. */
function emptyAgentDay_(scope, horizons) {
  return {
    meta: {
      agentName: scope.agentName, date: scope.date, department: scope.dept || '',
      unrostered: !!scope.unrostered, rosterHomes: scope.homes || [],
      available: true, tier: 'dqe-only', degradedReason: null,
      journeyHorizonDays: horizons.journeyDays, captureHorizonDays: horizons.callDays,
      ageDays: null, truncated: false, neonAvailable: false, outboundCaptured: false,
      outboundCaptureStart: AGENT_DAY_OUTBOUND_CAPTURE_START_,
      tzLabel: 'CST', computeMs: 0,
    },
    day: null,
    counts: agentDayCounts_([], []),
    reconcile: { checked: false, exact: false, note: null },
    inbound: [],
    outbound: [],
    missedRings: [],
  };
}

/**
 * Read the day's capture rows for one agent over ONE connection.
 *
 * Two queries, both bounded by the (call_date, ...) PK prefix:
 *   inbound  -- `journey LIKE '%name%'` as a cheap PRE-FILTER (the ahWaitJoin_
 *               technique), plus `first_agent = ?` so a degraded day whose
 *               journey is NULL still returns the calls this agent rang first.
 *               The LIKE is a superset: `agentDayInboundRole_` does the exact
 *               INV-04 match and the caller drops every row it rejects.
 *   outbound -- `agent_name = ?`, exact and unaffected by the journey prune.
 *
 * Best-effort: a Neon failure returns `{ available: false }` and the caller
 * still serves the DQE half, which is the tier-3 behavior anyway.
 */
/**
 * PCR-5 (broad-scan 2026-09-23): the journey pre-filter pattern. The SQL LIMIT
 * applies BEFORE the exact-name check drops LIKE false positives, so a bare
 * '%Ann%' let "Anna" / "Annette" rows fill the LIMIT and push real rows out
 * with no truncation flag. Journey names are JSON string values, so matching
 * the name QUOTED ('"Ann"') is still a superset of the exact match (the JS
 * check stays) but no longer matches a name that merely contains it. LIKE's
 * own wildcards (% _ and the backslash escape) are escaped.
 */
function agentDayLikePattern_(agentName) {
  return '%' + JSON.stringify(String(agentName == null ? '' : agentName)).replace(/[\\%_]/g, '\\$&') + '%';
}

function agentDayFetchCapture_(agentName, dateIso) {
  var out = { available: false, inbound: [], outbound: [], anyJourney: false };
  if (typeof getDashboardNeonConn_ !== 'function') return out;
  var conn = null;
  try {
    conn = getDashboardNeonConn_();
    if (!conn) return out;
    var bytes = 0;

    var st = conn.prepareStatement(
      "SELECT COALESCE(json_agg(t), '[]')::text AS j FROM ("
      + 'SELECT call_id, call_start, entry_queue, final_queue, disposition, '
      +        'abandon_stage, wait_seconds, hold_seconds, is_internal, '
      +        'num_transfers, first_agent, journey '
      + 'FROM inbound_calls WHERE call_date = ?::date '
      + 'AND (journey LIKE ? OR first_agent = ?) '
      + 'ORDER BY call_start LIMIT ' + (AGENT_DAY_MAX_CALLS_ + 1) + ') t');
    st.setString(1, dateIso);
    st.setString(2, agentDayLikePattern_(agentName));   // PCR-5
    st.setString(3, agentName);
    var rs = st.executeQuery();
    var ij = rs.next() ? rs.getString('j') : '[]';
    bytes += ij ? ij.length : 0;
    rs.close(); st.close();

    var st2 = conn.prepareStatement(
      "SELECT COALESCE(json_agg(t), '[]')::text AS j FROM ("
      + 'SELECT call_id, call_start, connected, talk_seconds, ring_seconds, attempts '
      + 'FROM outbound_calls WHERE call_date = ?::date AND agent_name = ? '
      + 'ORDER BY call_start LIMIT ' + (AGENT_DAY_MAX_CALLS_ + 1) + ') t');
    st2.setString(1, dateIso);
    st2.setString(2, agentName);
    var rs2 = st2.executeQuery();
    var oj = rs2.next() ? rs2.getString('j') : '[]';
    bytes += oj ? oj.length : 0;
    rs2.close(); st2.close();

    // P30: journey-bearing reads are the big egress spenders; label it so the
    // Health page's ranking can see this surface at all.
    if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(bytes, 'agentDay');

    out.inbound = JSON.parse(ij || '[]');
    out.outbound = JSON.parse(oj || '[]');
    out.available = true;
  } catch (e) {
    Logger.log('agentDayFetchCapture_ best-effort miss: ' + (e && e.message ? e.message : e));
  } finally {
    if (conn) { try { conn.close(); } catch (e2) {} }
  }
  return out;
}

/**
 * Public: one agent's day.
 *
 * NOT cached (see the PHI note in the header). The two Neon queries are
 * PK-adjacent single-date reads and the DQE half rides the existing DAL.
 */
function getAgentDay(req) {
  var t0 = new Date().getTime();
  var scope = agentDayResolve_(req);
  // Horizons come from the retention engine's own settings, so a tuned
  // NEON_RETENTION_* property moves the DISCLOSURE with the prune instead of
  // leaving the page explaining a boundary that no longer exists.
  var horizons = { journeyDays: 90, callDays: 400 };
  try {
    if (typeof neonRetentionSettings_ === 'function') {
      horizons = neonRetentionSettings_(PropertiesService.getScriptProperties());
    }
  } catch (e0) { /* defaults stand */ }
  var out = emptyAgentDay_(scope, horizons);

  // The DAY HEADER comes from the DQE agent-day row, not from counting the
  // per-call list. That is the roadmap's rule ("an aggregate that does not
  // degrade") and it buys a second property: this number is the SAME one My
  // Department and the Individual Report show for that agent and day, so the
  // page reconciles with the rest of the app by construction. The per-call
  // list is then free to be a subset without the header lying.
  try {
    var rows = (typeof agentDayFetchDalRows_ === 'function')
      ? agentDayFetchDalRows_(scope.date, scope.date)
      : [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].agent !== scope.agentName) continue;   // INV-04 exact
      out.day = {
        rung: Number(rows[i].totalRung) || 0,
        missed: Number(rows[i].totalMissed) || 0,
        answered: Number(rows[i].totalAnswered) || 0,
        tttSec: Number(rows[i].tttSec) || 0,
        attSec: Number(rows[i].attSec) || 0,
        source: 'dqe',
      };
      // Tier 3's whole content: the missed-ring timestamps the DQE slots
      // carry long after the per-call rows are gone.
      out.missedRings = (typeof ahSlotTimes_ === 'function')
        ? ahSlotTimes_(rows[i].slots) : [];
      break;
    }
  } catch (e) {
    Logger.log('getAgentDay DQE half failed: ' + (e && e.message ? e.message : e));
  }

  var cap = agentDayFetchCapture_(scope.agentName, scope.date);
  out.meta.neonAvailable = cap.available;

  var inbound = [];
  var anyJourney = false;
  cap.inbound.forEach(function (r) {
    var journey = null;
    if (r.journey) {
      try {
        var arr = JSON.parse(r.journey);
        if (Array.isArray(arr) && arr.length) journey = arr;
      } catch (e2) { /* treat as pruned */ }
    }
    if (journey) anyJourney = true;
    var roleInfo = agentDayKeepRow_(
      agentDayInboundRole_(journey, scope.agentName), r.first_agent, scope.agentName);
    if (!roleInfo) return;   // a LIKE false positive -- not this agent's call
    inbound.push(agentDayShapeInbound_(r, roleInfo));
  });

  var outbound = cap.outbound.map(agentDayShapeOutbound_);
  // PCR-5: the SQL hitting its LIMIT means rows past it were never read --
  // true even when the exact-name filter above left fewer than the cap.
  if (cap.inbound.length > AGENT_DAY_MAX_CALLS_) out.meta.truncated = true;
  if (inbound.length > AGENT_DAY_MAX_CALLS_) {
    inbound = inbound.slice(0, AGENT_DAY_MAX_CALLS_);
    out.meta.truncated = true;
  }
  if (outbound.length > AGENT_DAY_MAX_CALLS_) {
    outbound = outbound.slice(0, AGENT_DAY_MAX_CALLS_);
    out.meta.truncated = true;
  }

  out.inbound = inbound;
  out.outbound = outbound;
  out.counts = agentDayCounts_(inbound, outbound);
  out.meta.tier = agentDayTier_(cap.inbound.length, anyJourney, cap.outbound.length);
  out.meta.ageDays = agentDayAgeDays_(scope.date,
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'));
  out.meta.degradedReason = agentDayDegradedReason_(out.meta, cap.available);
  out.meta.outboundCaptured = agentDayOutboundCaptured_(out.meta, scope.date);
  out.reconcile = agentDayReconcile_(out.counts, out.day, out.meta.tier);
  out.meta.computeMs = new Date().getTime() - t0;

  try { logReportUsage_('agentDay', scope.dept || '(unrostered)', scope.user, false); } catch (e3) {}
  return out;
}

/**
 * PURE. The sentence the client shows when fidelity is below 'full'. Null on
 * a full-tier day. Distinguishes the three reasons a day can be thin, because
 * they call for different reactions: an outage is temporary, a pruned journey
 * is permanent, and "nothing was captured" may just be a quiet day.
 */
function agentDayDegradedReason_(meta, neonAvailable) {
  if (meta.tier === 'full') return null;
  if (!neonAvailable) return 'neon-down';
  if (meta.ageDays != null && meta.ageDays > meta.captureHorizonDays) return 'before-capture';
  if (meta.ageDays != null && meta.ageDays > meta.journeyHorizonDays) return 'journey-pruned';
  return 'not-captured';
}

/** DAL fetch honoring DQE_READ_SOURCE with the documented fallback (B-2/LM2). */
function agentDayFetchDalRows_(fromIso, toIso) {
  var opts = { includeMissedDetail: true };
  var src = (typeof getDqeReadSource_ === 'function') ? getDqeReadSource_() : 'sheet';
  if (src === 'neon' && typeof neonFetchDqeRows_ === 'function') {
    var rows = neonFetchDqeRows_(fromIso, toIso, opts);
    var usable = (typeof neonDqeRowsUsable_ === 'function')
      ? neonDqeRowsUsable_(rows) : (rows && rows.length > 0);
    if (usable) return rows;
  }
  return sheetFetchDqeRows_(fromIso, toIso, opts);
}

// ── The day strip (Batch B: the inline agent panel on My Department) ────────
//
// Clicking an agent row on My Department opens an inline panel whose first
// row is a strip of the agent's days in the loaded window, newest first; a
// day opens the full getAgentDay view underneath. The strip is the cheap half:
// per-day DQE counts through the DAL (no Neon) plus ONE grouped outbound count
// query, so a manager scanning a month does not pay a journey read per day.
//
// Two owner rules (2026-10):
//   - At most the 31 MOST RECENT days WITH ACTIVITY (a ring or an outbound
//     call). `totalActiveDays` ships beside them so the client can say how many
//     were left out, rather than letting a short strip read as the whole window.
//   - Same entitlement as the day view (agentDayAuthorize_), and the SEC-1
//     window cap, since the client sends the window.
//
// NOT cached and NOT usage-logged: the panel opens on its newest day, which
// calls getAgentDay, and that call already logs the `agentDay` usage row --
// logging here too would count every panel open twice.

var AGENT_DAY_STRIP_MAX_DAYS_ = 31;

/**
 * PURE. Fold the window's DQE rows and the grouped outbound counts into the
 * strip. `outboundRows` is [{ d, n, c }] (date, calls, connected).
 *
 * A day counts as ACTIVE on a ring (rung > 0) or an outbound call -- the same
 * "present that day" rule as Batch A's ans/day, plus outbound, since an agent
 * who only dialled out still had a working day worth opening. Outbound on a
 * day the capture does not cover is NULL, never 0: 0 would claim "placed no
 * calls" on a day nothing was recorded (the agentDayOutboundCaptured_ rule).
 */
function agentDayStripDays_(dqeRows, agentName, outboundRows, opts) {
  opts = opts || {};
  var maxDays = opts.maxDays || AGENT_DAY_STRIP_MAX_DAYS_;
  var captureStart = opts.captureStart || AGENT_DAY_OUTBOUND_CAPTURE_START_;
  var obOk = !!opts.outboundAvailable;
  var byDate = {};
  var get = function (d) {
    if (!byDate[d]) {
      byDate[d] = { date: d, rung: 0, answered: 0, missed: 0,
                    outbound: null, outboundConnected: null,
                    outboundCaptured: obOk && d >= captureStart };
      if (byDate[d].outboundCaptured) { byDate[d].outbound = 0; byDate[d].outboundConnected = 0; }
    }
    return byDate[d];
  };
  (dqeRows || []).forEach(function (r) {
    if (!r || r.agent !== agentName) return;   // INV-04 exact
    var d = String(r.dateIso || '');
    if (!d) return;
    var e = get(d);
    e.rung += Number(r.totalRung) || 0;
    e.answered += Number(r.totalAnswered) || 0;
    e.missed += Number(r.totalMissed) || 0;
  });
  if (obOk) {
    (outboundRows || []).forEach(function (o) {
      var d = String((o && o.d) || '');
      if (!d) return;
      var e = get(d);
      if (!e.outboundCaptured) return;
      e.outbound += Number(o.n) || 0;
      e.outboundConnected += Number(o.c) || 0;
    });
  }
  var active = Object.keys(byDate).map(function (k) { return byDate[k]; })
    .filter(function (e) { return e.rung > 0 || (e.outbound || 0) > 0; })
    .sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
  return { days: active.slice(0, maxDays), totalActiveDays: active.length };
}

/**
 * Per-day outbound counts for one agent over ONE probed connection. The window
 * is clamped to the capture start first, so a window entirely before outbound
 * capture began costs no query at all. Best-effort, like agentDayFetchCapture_.
 */
function agentDayFetchOutboundByDay_(agentName, fromIso, toIso) {
  var out = { available: false, rows: [] };
  var lo = fromIso < AGENT_DAY_OUTBOUND_CAPTURE_START_ ? AGENT_DAY_OUTBOUND_CAPTURE_START_ : fromIso;
  if (lo > toIso) { out.available = true; return out; }   // nothing captured in range
  if (typeof getDashboardNeonConn_ !== 'function') return out;
  var conn = null;
  try {
    conn = getDashboardNeonConn_();
    if (!conn) return out;
    var st = conn.prepareStatement(
      "SELECT COALESCE(json_agg(t), '[]')::text AS j FROM ("
      + "SELECT to_char(call_date, 'YYYY-MM-DD') AS d, count(*) AS n, "
      +        'count(*) FILTER (WHERE connected) AS c '
      + 'FROM outbound_calls WHERE call_date BETWEEN ?::date AND ?::date '
      + 'AND agent_name = ? GROUP BY call_date) t');
    st.setString(1, lo);
    st.setString(2, toIso);
    st.setString(3, agentName);
    var rs = st.executeQuery();
    var j = rs.next() ? rs.getString('j') : '[]';
    rs.close(); st.close();
    if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(j ? j.length : 0, 'agentDay');
    out.rows = JSON.parse(j || '[]');
    out.available = true;
  } catch (e) {
    Logger.log('agentDayFetchOutboundByDay_ best-effort miss: ' + (e && e.message ? e.message : e));
  } finally {
    if (conn) { try { conn.close(); } catch (e2) {} }
  }
  return out;
}

/**
 * Public: the agent's active days in a window, newest first, capped at 31.
 *   getAgentDayStrip({ agentName, from, to })
 *     -> { meta: {...}, days: [{ date, rung, answered, missed, outbound,
 *                                outboundConnected, outboundCaptured }] }
 */
function getAgentDayStrip(req) {
  var t0 = new Date().getTime();
  var agentName = String((req && req.agentName) || '').trim();
  var from = String((req && req.from) || '').trim();
  var to = String((req && req.to) || '').trim();
  if (!agentName) throw new Error('agentName is required.');
  if (!isIsoDate_(from) || !isIsoDate_(to)) throw new Error('from and to must be YYYY-MM-DD.');
  if (from > to) throw new Error('from must be on or before to.');
  assertReportRangeCap_(from, to);   // SEC-1
  var scope = agentDayAuthorize_(agentName);

  var dqe = agentDayFetchDalRows_(from, to);
  var ob = agentDayFetchOutboundByDay_(scope.agentName, from, to);
  var folded = agentDayStripDays_(dqe, scope.agentName, ob.rows, {
    outboundAvailable: ob.available, captureStart: AGENT_DAY_OUTBOUND_CAPTURE_START_,
    maxDays: AGENT_DAY_STRIP_MAX_DAYS_,
  });
  return {
    meta: {
      agentName: scope.agentName, department: scope.dept || '',
      unrostered: !!scope.unrostered, rosterHomes: scope.homes || [],
      from: from, to: to, maxDays: AGENT_DAY_STRIP_MAX_DAYS_,
      totalActiveDays: folded.totalActiveDays, shown: folded.days.length,
      outboundAvailable: ob.available,
      outboundCaptureStart: AGENT_DAY_OUTBOUND_CAPTURE_START_,
      computeMs: new Date().getTime() - t0,
    },
    days: folded.days,
  };
}

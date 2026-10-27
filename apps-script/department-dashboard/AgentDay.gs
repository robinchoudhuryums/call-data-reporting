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
// Step 2 1b: the roster map is read once per EXECUTION -- the entitlement
// check and the staff-name labels both need it (the DEPT_CONFIG_ROWS_MEMO_
// discipline; the harness resets every *MEMO* global between calls, F39).
var AGENT_DAY_ROSTER_MEMO_ = null;
function agentDayRosterMap_() {
  if (!AGENT_DAY_ROSTER_MEMO_) {
    AGENT_DAY_ROSTER_MEMO_ = (typeof buildDeptsByAgent_ === 'function') ? buildDeptsByAgent_() : {};
  }
  return AGENT_DAY_ROSTER_MEMO_;
}

function agentDayRosterHomes_(agentName) {
  var byAgent = agentDayRosterMap_();
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
 * IXT-1's consult and missed attempts do NOT count (the agent still had the
 * caller); its hand-over leg does.
 * Times are the journey's HH:MM:SS; a leg without one is never counted.
 */
function agentDayTransferredOn_(journey, agentName, answered) {
  var t0 = agentDayClockSec_(answered && answered.t);
  if (t0 == null) return false;
  for (var i = 0; i < journey.length; i++) {
    var ev = journey[i];
    if (!ev || i === answered.order || ev.name === agentName) continue;
    // IXT-1: the agent's own consult with a colleague and their unanswered
    // attempts to reach one are things the agent DID while still on the call
    // -- not the caller moving on. Only the colleague's hand-over leg is.
    if (ev.consult || (ev.transfer && ev.missed)) continue;
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
 * Step 2 1b (owner 2026-10-16): who was on the other end of each call --
 * LABELS ONLY. No phone number or outside name exists in the capture, so the
 * label is one of: a STAFF member (named only when the name is EXACTLY on a
 * roster, INV-04 -- the safety net that keeps anything else from printing),
 * the INSURER the number belongs to (published business lines; the caller
 * passes them for admins only while the Inbound report is admin-gated), or
 * "outside" with the company line it came in on (DIAL_IN_LABELS).
 *
 * PURE. `ctx` = { roster: {name: [homes]}, depts: {dept: true},
 * dialLabels: {digits: label}, insurer: {callId: name} }.
 */
function agentDayInboundFrom_(r, ctx) {
  ctx = ctx || {};
  if (r && r.is_internal) {
    var who = String(r.origin_agent || '').trim();
    var od = String(r.origin_dept || '').trim();
    return { kind: 'staff',
             name: (who && ctx.roster && ctx.roster[who]) ? who : null,
             dept: (od && ctx.depts && ctx.depts[od]) ? od : null };
  }
  var digits = String((r && r.dial_in_number) || '').replace(/\D/g, '');
  var labels = ctx.dialLabels || {};
  var line = null;
  if (digits) {
    line = labels[digits]
      || (digits.length === 11 && digits.charAt(0) === '1' ? labels[digits.slice(1)] : null)
      || (digits.length === 10 ? labels['1' + digits] : null)
      || null;
  }
  return { kind: 'outside', insurer: (ctx.insurer && r && ctx.insurer[r.call_id]) || null, line: line };
}

/**
 * PURE. The internal colleague an outbound dial reached: the first non-queue
 * journey event whose name is EXACTLY a roster agent other than the dialler.
 * Masked outside legs ('A.P.', '(external caller)', '(unknown)') never match
 * a roster name, so nothing outside can surface here. Null when none.
 */
function agentDayInternalCallee_(journeyJson, agentName, roster) {
  var ev;
  try { ev = JSON.parse(journeyJson || 'null'); } catch (e) { return null; }
  if (!ev || !ev.length || !roster) return null;
  for (var i = 0; i < ev.length; i++) {
    var e1 = ev[i];
    if (!e1 || e1.kind === 'queue') continue;
    var n = String(e1.name == null ? '' : e1.name).trim();
    if (n && n !== agentName && roster[n]) return n;
  }
  return null;
}

/** PURE. The To label for one outbound row (see agentDayInboundFrom_). */
function agentDayOutboundTo_(r, ctx) {
  ctx = ctx || {};
  if (r && r.no_ext) {
    // No outside number on the row: an internal dial -- named when the path
    // names a colleague, otherwise unknown (a row whose number failed to hash
    // also lands here, and must not be called "internal").
    var name = agentDayInternalCallee_(r.journey, ctx.agentName, ctx.roster);
    if (name) return { kind: 'staff', name: name, dept: ((ctx.roster[name] || [])[0]) || null };
    return { kind: 'unknown' };
  }
  return { kind: 'outside', insurer: (ctx.insurer && r && ctx.insurer[r.call_id]) || null };
}

/**
 * PURE. The callback cue for one outbound call: the LATEST same-day inbound
 * call from the number dialled that came BEFORE the dial, among those the
 * viewer may see -- one on this agent's own list, one that entered the
 * agent's dept queues, or (admins) any. `matches` = [{ ob, ib, ts, d, q }]
 * already narrowed to this outbound call. Returns { time, disposition,
 * inboundCallId } (the id only when the call is on the agent's own list, so
 * the client can point at a row it shows) or null.
 */
function agentDayPickCallback_(obStart, matches, ctx) {
  ctx = ctx || {};
  var obSec = agentDayClockSec_(obStart);
  if (obSec == null) return null;
  var best = null, bestSec = -1;
  (matches || []).forEach(function (m) {
    var sec = agentDayClockSec_(m && m.ts);
    if (sec == null || sec >= obSec) return;
    var mine = !!(ctx.inboundIds && ctx.inboundIds[m.ib]);
    var q = String(m.q || '').trim().toLowerCase();
    var inDept = !!(q && ctx.deptQueues && ctx.deptQueues[q]);
    if (!ctx.isAdmin && !mine && !inDept) return;
    if (sec > bestSec) {
      bestSec = sec;
      best = { time: m.ts, disposition: m.d || null, inboundCallId: mine ? m.ib : null };
    }
  });
  return best;
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

function agentDayFetchCapture_(agentName, dateIso, opts) {
  var out = { available: false, inbound: [], outbound: [], anyJourney: false,
              insurerIn: [], insurerOut: [], callbackMatches: [] };
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
      +        'num_transfers, first_agent, journey, '
      +        'dial_in_number, origin_agent, origin_dept '   // Step 2 1b: the From label
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
      + 'SELECT call_id, call_start, connected, talk_seconds, ring_seconds, attempts, '
      +        '(callee_hash IS NULL) AS no_ext, journey '   // Step 2 1b: the To label
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

    // Step 2 1b (owner 2026-10-16): the extras behind the caller / callee
    // labels and the callback link. Each is its OWN best-effort read, so a
    // missing insurance_numbers table (or any failure here) costs the label,
    // never the day. Hashes are compared IN SQL and never selected: nothing
    // that identifies a number leaves the database.
    var extra = function (sql, binds) {
      try {
        var q = conn.prepareStatement(sql);
        for (var b = 0; b < binds.length; b++) q.setString(b + 1, binds[b]);
        var r = q.executeQuery();
        var txt = r.next() ? r.getString('j') : '[]';
        r.close(); q.close();
        if (typeof neonNoteEgress_ === 'function') neonNoteEgress_(txt ? txt.length : 0, 'agentDay');
        return JSON.parse(txt || '[]');
      } catch (eX) {
        Logger.log('agentDayFetchCapture_ label read skipped: ' + (eX && eX.message ? eX.message : eX));
        return [];
      }
    };
    if (opts && opts.insurer) {
      // Insurer names (published business lines) -- admin-only for now, the
      // Inbound report's temporary gate (see the caller).
      out.insurerIn = extra(
        "SELECT COALESCE(json_agg(t), '[]')::text AS j FROM ("
        + 'SELECT c.call_id AS id, i.insurance_name AS n FROM inbound_calls c '
        + 'JOIN insurance_numbers i ON i.phone_hash = c.caller_hash '
        + 'WHERE c.call_date = ?::date AND (c.journey LIKE ? OR c.first_agent = ?)) t',
        [dateIso, agentDayLikePattern_(agentName), agentName]);
      out.insurerOut = extra(
        "SELECT COALESCE(json_agg(t), '[]')::text AS j FROM ("
        + 'SELECT o.call_id AS id, i.insurance_name AS n FROM outbound_calls o '
        + 'JOIN insurance_numbers i ON i.phone_hash = o.callee_hash '
        + 'WHERE o.call_date = ?::date AND o.agent_name = ?) t',
        [dateIso, agentName]);
    }
    // Every same-day inbound call from the number this agent dialled; the
    // caller keeps the latest one BEFORE the dial that the viewer may see.
    out.callbackMatches = extra(
      "SELECT COALESCE(json_agg(t), '[]')::text AS j FROM ("
      + 'SELECT o.call_id AS ob, c.call_id AS ib, c.call_start AS ts, c.disposition AS d, c.entry_queue AS q '
      + 'FROM outbound_calls o JOIN inbound_calls c '
      + 'ON c.call_date = o.call_date AND c.caller_hash = o.callee_hash '
      + 'WHERE o.call_date = ?::date AND o.agent_name = ? AND o.callee_hash IS NOT NULL '
      + 'AND COALESCE(c.is_internal, FALSE) = FALSE) t',
      [dateIso, agentName]);
  } catch (e) {
    Logger.log('agentDayFetchCapture_ best-effort miss: ' + (e && e.message ? e.message : e));
  } finally {
    if (conn) { try { conn.close(); } catch (e2) {} }
  }
  return out;
}

/**
 * F29 (broad-scan 2026-10-14): narrow the DQE rows to ONE department's queues
 * the way My Department narrows the row the panel hangs from
 * (applyQueueSplitToRows_, a no-op unless QUEUE_SPLIT_SCOPE=dept). Without it
 * the day header and the strip showed whole-day, all-queue figures under a row
 * narrowed to the dept's queues -- the panel contradicting its own row.
 * `reqDept` (the row's group / the page's dept) is honoured only when it is
 * one of the agent's roster homes AND passes the viewer's own dept gate;
 * otherwise the entitled home agentDayAuthorize_ chose. An unrostered agent
 * (admin-only) has no dept to narrow to.
 */
function agentDayNarrow_(rows, scope, reqDept, narrowSlots) {
  if (!rows || !rows.length || !scope || scope.unrostered || !scope.dept) return rows;
  if (typeof applyQueueSplitToRows_ !== 'function') return rows;
  var dept = scope.dept;
  var want = String(reqDept || '').trim();
  if (want && want !== dept && (scope.homes || []).indexOf(want) !== -1) {
    try { assertDeptAccess_(scope.user, want); dept = want; } catch (e) { /* keep the entitled home */ }
  }
  applyQueueSplitToRows_(rows, dept, { narrowSlots: !!narrowSlots });
  return rows;
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
      ? agentDayFetchDalRows_(scope.date, scope.date, { agentName: scope.agentName })
      : [];
    agentDayNarrow_(rows, scope, req && req.department, true);   // F29: + the missed-ring timeline
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

  // Step 2 1b: insurer names ride the Inbound report's TEMPORARY admin-only
  // gate (docs/per-call-capture.md), so only an admin's read asks for them;
  // when that report reaches managers, pass true for them here too.
  var isAdmin = !!(scope.user && scope.user.role === 'admin');
  var cap = agentDayFetchCapture_(scope.agentName, scope.date, { insurer: isAdmin });
  out.meta.neonAvailable = cap.available;
  var labelCtx = agentDayLabelContext_(scope, cap, isAdmin);

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
    var entry = agentDayShapeInbound_(r, roleInfo);
    entry.from = agentDayInboundFrom_(r, labelCtx.inbound);   // Step 2 1b
    inbound.push(entry);
  });

  // Step 2 1b: the To label, and the callback cue against the inbound calls
  // this agent's list now holds (or the dept's queues -- agentDayPickCallback_).
  var inboundIds = {};
  inbound.forEach(function (e) { if (e.callId) inboundIds[e.callId] = true; });
  var cbByOb = {};
  (cap.callbackMatches || []).forEach(function (m) {
    if (m && m.ob) (cbByOb[m.ob] = cbByOb[m.ob] || []).push(m);
  });
  var outbound = cap.outbound.map(function (r) {
    var e = agentDayShapeOutbound_(r);
    e.to = agentDayOutboundTo_(r, labelCtx.outbound);
    e.callback = agentDayPickCallback_(r.call_start, cbByOb[r.call_id] || [],
      { inboundIds: inboundIds, deptQueues: labelCtx.deptQueues, isAdmin: isAdmin });
    return e;
  });
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
 * Step 2 1b: everything the label helpers read, gathered once per request.
 * Best-effort throughout: a missing input just means a plainer label.
 */
function agentDayLabelContext_(scope, cap, isAdmin) {
  var roster = {};
  try { roster = agentDayRosterMap_(); } catch (e) { roster = {}; }
  var depts = {};
  try { (getAllDepartments_() || []).forEach(function (d) { depts[d] = true; }); } catch (e1) {}
  var dialLabels = {};
  try { if (typeof inboundDialInLabels_ === 'function') dialLabels = inboundDialInLabels_(); } catch (e2) {}
  var toMap = function (rows) {
    var m = {};
    (rows || []).forEach(function (x) { if (x && x.id && x.n) m[x.id] = String(x.n); });
    return m;
  };
  var deptQueues = {};
  try {
    if (scope.dept && typeof inboundQueuesForDept_ === 'function') {
      inboundQueuesForDept_(scope.dept).forEach(function (q) { deptQueues[String(q).trim().toLowerCase()] = true; });
    }
  } catch (e3) {}
  return {
    inbound: { roster: roster, depts: depts, dialLabels: dialLabels,
               insurer: isAdmin ? toMap(cap.insurerIn) : {} },
    outbound: { roster: roster, agentName: scope.agentName,
                insurer: isAdmin ? toMap(cap.insurerOut) : {} },
    deptQueues: deptQueues,
  };
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

/**
 * DAL fetch honoring DQE_READ_SOURCE with the documented fallback (B-2/LM2).
 *
 * F33 (broad-scan 2026-10-14): `fopts.agentName` asks the Neon read for that
 * one agent's rows (the IR / Insights `agents` filter) instead of every
 * agent's, and `fopts.missedDetail` is false for the strip, which uses only
 * the totals -- each panel open used to pull every agent's slots + abandoned
 * detail for the whole window. The agent filter is DROPPED while queue-split
 * narrowing is on: applyQueueSplitToRows_ judges a window's fail-open (B-1)
 * from the dept's ROSTER rows, so narrowing one agent's rows alone could fall
 * open where My Department narrows, and the panel would disagree with its row.
 */
function agentDayFetchDalRows_(fromIso, toIso, fopts) {
  fopts = fopts || {};
  var opts = { includeMissedDetail: fopts.missedDetail !== false };
  var narrowing = (typeof getQueueSplitScope_ === 'function') && getQueueSplitScope_() === 'dept';
  if (fopts.agentName && !narrowing) opts.agents = [fopts.agentName];
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
 *   getAgentDayStrip({ agentName, from, to, department? })   (department: F29)
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

  var dqe = agentDayFetchDalRows_(from, to, { agentName: scope.agentName, missedDetail: false });   // F33
  agentDayNarrow_(dqe, scope, req && req.department, false);   // F29
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

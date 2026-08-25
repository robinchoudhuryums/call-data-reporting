// ============================================================================
// inboundCalls.js — per-call inbound capture (cdr-import project)
// ----------------------------------------------------------------------------
// Produces ONE record per distinct inbound call (grouped across all legs by
// root Call ID, stitching CallForking satellites via Parent Call ID), then
// mirrors them to Neon's `inbound_calls` table. Complements the per-AGENT
// outbound phone capture in neonWrite.js (call_history_phones); this is the
// CALL-level inbound view.
//
// Validated against real Raw Data scenarios:
//   - answered (single queue + multi-queue bounce / transfer)
//   - abandoned in IVR (never reached a queue)
//   - abandoned in queue (incl. re-ring same agent N times)
//   - answered-then-abandoned-on-hold (caller hung up while held)
//
// Captures: caller_hash (deterministic HMAC, matches insurance_numbers +
// call_history_phones; null for Anonymous), dial_in_number (DID / marketing
// line), disposition (answered|abandoned|missed) + abandon_stage
// (ivr|queue|direct -- R5: 'direct' = abandoned while ringing a PERSON's
// line, split out of 'ivr'), first_agent (first person the call rang),
// abandoned_on_hold + hold_seconds, wait_seconds (time-to-answer / -abandon),
// the queue journey (entry/final queue, num_queues, num_transfers), the call
// start time (call_start, 'HH:MM:SS' in the CDR's native timezone), and the
// full leg-by-leg JOURNEY (ordered events: IVR/queue/agent legs with
// timestamps, durations, talk/hold seconds, and missed/abandoned flags) --
// the raw legs are pruned at 14 days (DeleteOldSheets), so the journey
// column is the only durable record of the per-call path. Consumed by the
// dashboard's Caller Lookup (CallerLookup.gs).
//
// buildInboundCallRecords_(rawRows) is PURE (no Apps Script globals) so it's
// unit-tested directly. The Neon write reuses getReachableNeonConn_ +
// cdrHashPhone_ from neonWrite.js (same project, flat global scope).
// ============================================================================

// Raw Data column indices (0-based) — same layout the CDR export uses.
var IC_COL = {
  CALL_ID: 0, LEG_ID: 1, START: 2, CONNECTED: 3, STOP: 4, DIRECTION: 5,
  TALK: 6, CALL_TIME: 7, CALLER: 8, CALLER_NAME: 9, CALLEE: 10, CALLEE_NAME: 11,
  PARENT_CALL_ID: 14, DIAL_IN: 16, MISSED: 23, ABANDONED: 24, ANSWERED: 25,
  CALLEE_HOLD_DURATION: 32, CALLEE_DISC_ON_HOLD: 33, CALLER_DISC_ON_HOLD: 34,
  DEPARTMENTS: 36
};

// ---- pure helpers -----------------------------------------------------------

function icDigits_(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }

// An external phone (>= 10 digits) normalized to "+<digits>" so it matches the
// outbound capture + insurance_numbers hashing. Internal exts ("183"),
// "CallQueue (103)", "Anonymous", blanks -> null.
function icExternalNumber_(s) {
  var d = icDigits_(s);
  return d.length >= 10 ? '+' + d : null;
}

function icIsAnonymous_(s) {
  var t = String(s == null ? '' : s).trim();
  return t === '' || /anon|restrict|private|unknown|withheld/i.test(t);
}

function icIsTrue_(s) { return String(s == null ? '' : s).trim().toUpperCase() === 'TRUE'; }

// The employee who PLACED an internal-origin call, from the leg's CALLER
// columns. Mirrors firstAgent's guards: blank/N-A, queue names and
// phone-shaped values are all rejected (a raw number must never be stored).
function icOriginAgentName_(leg) {
  var n = String((leg && leg[IC_COL.CALLER_NAME]) == null ? '' : leg[IC_COL.CALLER_NAME]).trim();
  if (!n || n.toUpperCase() === 'N/A') return null;
  if (icIsQueueName_(n)) return null;
  if (/^\+?[\d\s\-().]{7,}$/.test(n)) return null;
  return n.slice(0, IC_JOURNEY_NAME_MAX);
}

// The raw CDR org-chart label on that same leg ("Field Operations (Market
// Activity)"). Context only -- it is NOT a dashboard dept header (the
// final_dept name-space caveat), so no attribution ever keys on it.
function icOriginDeptLabel_(leg) {
  var d = String((leg && leg[IC_COL.DEPARTMENTS]) == null ? '' : leg[IC_COL.DEPARTMENTS]).trim();
  if (!d || d.toUpperCase() === 'N/A') return null;
  return d.slice(0, IC_JOURNEY_NAME_MAX);
}

// Does this leg belong to the ORIGINATOR of an internal-origin call?
//
// Why this exists: a CDR "root" is a leg TREE, not a call. A warm transfer
// puts two people's legs under one root -- the owner's 2026-08-21 sample has
// Margie's leg into A_Q_FieldOps and Marie's Outgoing leg to the customer
// under root 1783983008517. `answered` for an internal-origin record used to
// be "any talk leg in the tree said Answered", so a SIBLING agent's external
// customer leg could mark a genuinely-abandoned internal assist as answered --
// silently shrinking the one population the path drill serves (measured
// 2026-08-24: 6 of 28 outbound-linked assists sat on a shared tree, and 170 of
// 185 internal records read `answered`).
//
// Two arms, because the delivery leg does not always carry the originator's
// extension in CALLER: the ext arm matches the plain agent-to-agent shape
// (`caller 363 -> callee 279`), the NAME arm rescues the queue-fronted shape
// (`caller "CallQueue (144)"` with CALLER_NAME still the originator). Either
// suffices; an external Outgoing leg is excluded outright, since the party
// answering an internal queue call is always an internal extension.
function icLegFromOriginator_(leg, originExt, originName) {
  if (!leg) return false;
  if (String(leg[IC_COL.DIRECTION] == null ? '' : leg[IC_COL.DIRECTION]).trim() === 'Outgoing'
      && icExternalNumber_(leg[IC_COL.CALLEE])) return false;
  if (originExt && icDigits_(leg[IC_COL.CALLER]) === originExt) return true;
  if (originName) {
    var cn = String(leg[IC_COL.CALLER_NAME] == null ? '' : leg[IC_COL.CALLER_NAME]).trim();
    if (cn && cn === originName) return true;
  }
  return false;
}

// IMP-1: must match every live queue identity, not just the A_Q_* family.
// "Backup CSR" is a first-class queue in this install (the DQE pipeline's
// queue regex is (A_Q_\w+|Backup CSR) -- buildDQEHistoricalData.js). With
// the old /^A_Q_/-only test, a call whose (only) queue leg was Backup CSR
// was captured with abandon_stage='ivr' and entry_queue=NULL -- it vanished
// from CSR's per-dept Inbound report/heatmap, and (Call_Legs prune at ~14
// days) the mis-capture was permanent.
//
// F1: that fix was a HARDCODED literal, so the next non-A_Q_ queue would
// recur the same silent, permanent mis-capture -- and neither diagnostic can
// see it: `scanInboundQueueNames_` (the Dept Config "Discovered inbound
// queues" panel) and the QCD-parity check's unattributed-queue list BOTH
// filter `COALESCE(entry_queue,'') <> ''`, so a queue that was never
// recognized has no row to discover. Recognition is now ALSO fed from the
// admin-authored `Dept Config` sheet (QCD Queues + Inbound Queue Aliases),
// loaded once per run by icLoadConfiguredQueueNames_. Strictly ADDITIVE: the
// regex below still matches on its own, so this can only ever recognize MORE
// names than before, never fewer.
//
// IC_KNOWN_QUEUE_NAMES_ is a module global (not a parameter) so
// buildInboundCallRecords_ stays PURE for the unit harness -- null means
// pattern-only, which is exactly the pre-F1 behavior the existing tests pin.
var IC_KNOWN_QUEUE_NAMES_ = null;    // { lowercased queue name: true } | null

// F1b (measured, not hypothetical): the `^A_Q_` anchor missed every
// BRAND-PREFIXED queue. `UDC_A_Q_Main` (Universal Dialysis Center) and
// `UUC_A_Q_Main` (Universal Urgent Care) are both first-class queues -- the DQE
// pipeline has listed them in DQE_EXCLUDED_AGENTS for some time, and IMP-8's
// comment discusses UDC_A_Q_Main by name -- but the anchor meant inbound
// capture never recognized them: entry_queue=NULL, attributable to no dept,
// invisible in every dept's Inbound report AND in the entry_queue-based
// discovery panel. A journey-leg histogram over abandoned NULL-entry_queue
// calls found UDC_A_Q_Main on 38 abandons in one ~8-week window, still
// accruing. Config alone could not have fixed this: an admin can only add an
// alias for a queue they know is missing, and nothing surfaced it.
//
// So the A_Q_ arm now matches at start OR after an underscore -- `UDC_A_Q_`,
// `UUC_A_Q_`, and any future brand prefix. The 'Backup CSR' arm stays EXACT
// (deliberately NOT the DQE pipeline's boundary pattern, which would make
// "Jane Backup CSR" a queue -- pinned false by the IMP-1 tests).
function icIsQueueName_(name) {
  var t = String(name == null ? '' : name).trim();
  if (/(?:^|_)A_Q_/i.test(t) || /^backup csr$/i.test(t)) return true;
  return !!(t && IC_KNOWN_QUEUE_NAMES_ && IC_KNOWN_QUEUE_NAMES_[t.toLowerCase()]);
}

// "H:MM:SS" -> seconds (0 on blank/N/A).
function icTimeToSec_(s) {
  var str = String(s == null ? '' : s).trim();
  var p = str.split(':');
  if (p.length !== 3) return 0;
  return (parseInt(p[0], 10) || 0) * 3600 + (parseInt(p[1], 10) || 0) * 60 + (parseInt(p[2], 10) || 0);
}

// "MM/DD/YYYY HH:MM:SS" -> epoch ms (NaN on unparseable).
// IMP-10: the CDR's PST wall-clock string is parsed as a UTC instant
// (Date.UTC) rather than a script-TZ-local Date. These ms values are only
// ever DIFFERENCED, ORDERED, or re-FORMATTED (icIsoDate_/icIsoTime_ read
// UTC getters), so treating the wall clock as UTC makes all of that pure
// wall-clock math -- immune to the Chicago DST edges where the old
// local-Date parse skewed overnight calls two nights a year (the
// spring-forward hour doesn't exist locally; the fall-back hour is
// ambiguous). Never mix these ms values with real-clock Date.now().
function icParseTs_(s) {
  var str = String(s == null ? '' : s).trim();
  var m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/.exec(str);
  if (!m) return NaN;
  return Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6]);
}

function icIsoDate_(ms) {
  if (isNaN(ms)) return null;
  var d = new Date(ms);
  var mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  var dd = String(d.getUTCDate()).padStart(2, '0');
  return d.getUTCFullYear() + '-' + mm + '-' + dd;
}

// 'HH:MM:SS' (zero-padded -> lexicographically sortable within a day).
function icIsoTime_(ms) {
  if (isNaN(ms)) return null;
  var d = new Date(ms);
  var p = function (n) { return String(n).padStart(2, '0'); };
  return p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
}

// Journey size caps. 40 events covers every real call shape we've seen
// (a pathological re-ring loop gets truncated, not dropped); 80 chars
// bounds a runaway callee-name cell.
var IC_JOURNEY_MAX_EVENTS = 40;
var IC_JOURNEY_NAME_MAX = 80;

/**
 * PURE. Ordered leg-by-leg journey for one call (legs pre-sorted by
 * start). Each event: { t: 'HH:MM:SS', name, kind: queue|answer|leg,
 * secs?, talk?, hold?, missed?, abandoned? }. 'leg' covers both IVR
 * legs and missed agent rings -- the CDR doesn't distinguish them
 * reliably, and the name makes it obvious to a human reader.
 *
 * PHI guard: a callee NAME that looks like a phone number (external
 * forward) is masked -- `inbound_calls` carries hashes only, never raw
 * numbers. Caller-side fields (number, CNAM name) are never included.
 */
function icBuildJourney_(legs) {
  var events = [];
  for (var i = 0; i < legs.length && events.length < IC_JOURNEY_MAX_EVENTS; i++) {
    var l = legs[i];
    var rawName = String(l[IC_COL.CALLEE_NAME] == null ? '' : l[IC_COL.CALLEE_NAME]).trim();
    var isQueue = icIsQueueName_(rawName);
    var name = rawName;
    if (/^\+?[\d\s\-().]{7,}$/.test(name)) name = '(external number)';
    if (!name || name.toUpperCase() === 'N/A') name = '(unknown)';
    var talk = icTimeToSec_(l[IC_COL.TALK]);
    var hold = icTimeToSec_(l[IC_COL.CALLEE_HOLD_DURATION]);
    var answered = talk > 0
      && String(l[IC_COL.ANSWERED] == null ? '' : l[IC_COL.ANSWERED]).trim() === 'Answered';
    var startMs = icParseTs_(l[IC_COL.START]);
    var stopMs  = icParseTs_(l[IC_COL.STOP]);
    var ev = {
      t: icIsoTime_(startMs),
      name: name.slice(0, IC_JOURNEY_NAME_MAX),
      kind: isQueue ? 'queue' : (answered ? 'answer' : 'leg'),
    };
    if (!isNaN(startMs) && !isNaN(stopMs)) ev.secs = Math.max(0, Math.round((stopMs - startMs) / 1000));
    if (talk > 0) ev.talk = talk;
    if (hold > 0) ev.hold = hold;
    if (String(l[IC_COL.ABANDONED] == null ? '' : l[IC_COL.ABANDONED]).trim() === 'Abandoned') {
      ev.abandoned = true;
    } else if (!answered
        && String(l[IC_COL.MISSED] == null ? '' : l[IC_COL.MISSED]).trim() === 'Missed') {
      ev.missed = true;
    }
    events.push(ev);
  }
  return events;
}

// SQL literal builders for the INLINE inbound insert (mirrors the phone-child
// inline approach: eliminates ~14 JDBC bind-bridge calls per row, the
// dominant per-row Apps Script cost). Free-text fields are single-quote
// escaped; ints/bools/hash are inherently safe.
function icSqlStr_(s) { return (s == null || s === '') ? 'NULL' : "'" + String(s).replace(/'/g, "''") + "'"; }
function icSqlInt_(n) { var v = parseInt(n, 10); return isFinite(v) ? String(v) : 'NULL'; }
function icSqlHash_(h) { return (typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)) ? "'" + h + "'" : 'NULL'; }

/**
 * F2. Authoritative per-date DELETE with no insert -- the zero-record arm of
 * the inbound/outbound writers. Used ONLY when the source had rows but produced
 * no records for `dateIso`, so the date's existing rows are provably stale.
 *
 * Shares the writers' contract: never throws (best-effort, like its callers),
 * and reports `unreachable` so a deferred-mirror date stays queued rather than
 * being marked done with the phantoms still in place. A missing table is a
 * clean no-op (nothing to delete yet).
 */
function icDeleteDateOnly_(table, dateIso, label) {
  var conn = null;
  try {
    conn = getReachableNeonConn_();
    if (!conn) {
      Logger.log('%s: zero records for %s and Neon unreachable — stale rows (if any) '
        + 'left in place; retry will clear them.', label, dateIso);
      return { inserted: 0, skipped: 0, unreachable: true };
    }
    // Inline literal via icSqlStr_, matching the authoritative DELETE in the
    // writers above (this file uses createStatement throughout). dateIso is the
    // caller's own expectedDateIso, and icSqlStr_ escapes it regardless.
    var stmt = conn.createStatement();
    stmt.execute('DELETE FROM ' + table + ' WHERE call_date = ' + icSqlStr_(dateIso) + '::date');
    stmt.close();
    Logger.log('%s: zero records for %s (source had rows) — cleared any stale %s row(s).',
      label, dateIso, table);
    return { inserted: 0, skipped: 0, cleared: true };
  } catch (e) {
    var msg = (e && e.message) ? e.message : String(e);
    // An absent table just means the capture has never written -- nothing stale
    // to clear, so this is a success, not a failure the caller should log.
    if (/does not exist|undefined table|relation .* does not exist/i.test(msg)) {
      return { inserted: 0, skipped: 0, cleared: true };
    }
    Logger.log('%s: zero-record cleanup for %s failed (best-effort): %s', label, dateIso, msg);
    return { inserted: 0, skipped: 0, error: true };
  } finally {
    if (conn) { try { conn.close(); } catch (ce) {} }
  }
}

// Per-statement budget for the VALUES payload. Apps Script's JDBC bridge
// rejects oversized SQL strings with "Argument too large: sql" (observed
// on the 2026-06-08 import); 30K chars leaves generous headroom under
// the cap while keeping round-trips low (~10-150 rows per statement
// depending on journey weight).
var IC_SQL_CHUNK_BUDGET_CHARS = 30000;

/**
 * PURE. Splits SQL VALUES tuples into batches whose joined length stays
 * within `budgetChars`. Size-aware because journey rows vary ~30x in
 * size -- a fixed row count can't be both safe and efficient. A single
 * tuple larger than the budget still gets its own batch (journeys are
 * capped at IC_JOURNEY_MAX_EVENTS, so a lone tuple can't approach the
 * actual JDBC cap).
 */
function icChunkTuplesByChars_(tuples, budgetChars) {
  var batches = [];
  var cur = [], len = 0;
  for (var i = 0; i < tuples.length; i++) {
    var t = String(tuples[i]);
    if (cur.length && len + t.length + 1 > budgetChars) {
      batches.push(cur);
      cur = []; len = 0;
    }
    cur.push(t);
    len += t.length + 1;   // +1 for the joining comma
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/**
 * PURE. rawRows = array of Raw Data leg rows (each an array indexed per
 * IC_COL). Returns one record per distinct INBOUND call.
 */
function buildInboundCallRecords_(rawRows) {
  if (!rawRows || !rawRows.length) return [];

  // 1) Group legs by ROOT call id (Parent if present, else own) -- stitches
  //    CallForking satellites onto the main inbound call.
  var groups = {};
  for (var i = 0; i < rawRows.length; i++) {
    var r = rawRows[i];
    var parent = String(r[IC_COL.PARENT_CALL_ID] == null ? '' : r[IC_COL.PARENT_CALL_ID]).trim();
    var own = String(r[IC_COL.CALL_ID] == null ? '' : r[IC_COL.CALL_ID]).trim();
    if (!own) continue;
    var root = (parent && parent.toUpperCase() !== 'N/A') ? parent : own;
    (groups[root] = groups[root] || []).push(r);
  }

  var records = [];
  var internalPending = [];   // internal-origin queue records, merged after the R11-N pass
  Object.keys(groups).forEach(function (root) {
    var legs = groups[root].slice().sort(function (a, b) {
      var d = (icParseTs_(a[IC_COL.START]) || 0) - (icParseTs_(b[IC_COL.START]) || 0);
      if (d) return d;
      // Same-second legs (a caller/queue leg + the rings it fanned out to)
      // keep their source LEG_ID order, so a termination leg can't
      // interleave the ring events in the journey (owner note). Journeys
      // already stored in Neon keep their old order until re-imported /
      // backfilled.
      return (Number(a[IC_COL.LEG_ID]) || 0) - (Number(b[IC_COL.LEG_ID]) || 0);
    });

    var incoming = legs.filter(function (l) {
      return String(l[IC_COL.DIRECTION] == null ? '' : l[IC_COL.DIRECTION]).trim() === 'Incoming';
    });
    // Round-16 (owner): an INTERNAL-ORIGIN QUEUE call (an employee dials
    // another dept's queue; every leg Direction=Internal) is captured as a
    // FLAGGED record (isInternal) so the Missed report's "path" journey
    // drill can serve it. JOURNEY-ONLY visibility: every dashboard metric
    // query excludes is_internal rows, so no inbound figure moves. Groups
    // with no queue leg (agent-to-agent internal, outbound-internal noise)
    // stay uncaptured; groups the R11-N transfer enrichment uniquely matches
    // are dropped AFTER that pass (they're already represented on the
    // caller's captured journey).
    var isInternalOrigin = false;
    if (!incoming.length) {
      var touchesQueue = legs.some(function (l) { return icIsQueueName_(l[IC_COL.CALLEE_NAME]); });
      if (!touchesQueue) return;   // not an inbound call (outgoing / internal-only)
      isInternalOrigin = true;
    }

    // Caller number: first external number on an incoming leg; else anonymous
    // if the caller is blank/anon; else skip (internal-incoming noise).
    // Internal-origin calls have no external caller by definition (the
    // record writes with a NULL caller_hash, like Anonymous).
    var callerNumber = null;
    if (!isInternalOrigin) {
      for (var k = 0; k < incoming.length; k++) {
        var n = icExternalNumber_(incoming[k][IC_COL.CALLER]);
        if (n) { callerNumber = n; break; }
      }
      var firstCaller = incoming[0][IC_COL.CALLER];
      if (!callerNumber && !icIsAnonymous_(firstCaller)) return;   // not a real external inbound
    }

    // Disposition. Answered = a real talk leg (Talk>0) marked Answered. The
    // zero-talk queue/IVR/recording legs (which also say "Answered") are
    // excluded by the Talk>0 gate.
    //
    // For an INTERNAL-ORIGIN record the talk leg must also be the
    // ORIGINATOR'S (icLegFromOriginator_) -- one root can hold two people's
    // calls, and a sibling's leg is not an answer to this requester's queue
    // call. External-inbound records keep the whole-tree test unchanged: their
    // legs all descend from the one incoming caller.
    //
    // WHO the originator is comes from the earliest QUEUE leg, not legs[0]:
    // on a shared tree legs[0] can be a colleague's leg that merely started
    // first (the 2026-08-21 sample's Outgoing leg predates the queue leg by
    // seconds), which would scope the test to the wrong person and name the
    // wrong requester in the drill. The leg that dialed the queue IS the one
    // that placed this call. Timing fields (callStart/callDate/waitSeconds)
    // deliberately still key on legs[0] -- this changes identity, not the
    // record's clock.
    var originLeg = legs[0];
    if (isInternalOrigin) {
      for (var ol = 0; ol < legs.length; ol++) {
        if (icIsQueueName_(legs[ol][IC_COL.CALLEE_NAME])) { originLeg = legs[ol]; break; }
      }
    }
    var originExtForDisp = isInternalOrigin ? icDigits_(originLeg[IC_COL.CALLER]) : '';
    var originNameForDisp = isInternalOrigin ? icOriginAgentName_(originLeg) : null;
    var answered = legs.some(function (l) {
      if (icTimeToSec_(l[IC_COL.TALK]) <= 0
          || String(l[IC_COL.ANSWERED] == null ? '' : l[IC_COL.ANSWERED]).trim() !== 'Answered') {
        return false;
      }
      return isInternalOrigin
        ? icLegFromOriginator_(l, originExtForDisp, originNameForDisp)
        : true;
    });
    // Same shared-tree hazard on the abandon side: PREFER the originator's own
    // abandoned leg (its ABANDONED/Departments cells are what abandonStage
    // reads), falling back to the unscoped search so a fan-out leg carrying the
    // flag can never cost us an abandon. The fallback is safe because
    // abandonLeg is only consulted when nothing answered.
    var abandonLeg = null, abandonLegAny = null;
    for (var a = 0; a < legs.length; a++) {
      if (String(legs[a][IC_COL.ABANDONED] == null ? '' : legs[a][IC_COL.ABANDONED]).trim() !== 'Abandoned') continue;
      if (!abandonLegAny) abandonLegAny = legs[a];
      if (!isInternalOrigin
          || icLegFromOriginator_(legs[a], originExtForDisp, originNameForDisp)) {
        abandonLeg = legs[a]; break;
      }
    }
    if (!abandonLeg) abandonLeg = abandonLegAny;
    var abandoned = !answered && !!abandonLeg;
    var disposition = answered ? 'answered' : (abandoned ? 'abandoned' : 'missed');
    var abandonStage = null;
    if (abandoned) {
      // R5 (owner): three stages now -- 'queue', 'direct', 'ivr'. The old
      // queue-else-ivr split lumped every abandoned DIRECT call (caller
      // dialed an agent's DID, it rang, they hung up) into 'ivr', inflating
      // the report's "Abandoned in IVR" tile to ~25% of calls. Discriminator:
      // an agent/person leg carries a real Departments value; IVR /
      // auto-attendant legs don't (the same signal finalDept relies on).
      // Old rows heal on a force re-import within the Call_Legs retention.
      var abCallee = String(abandonLeg[IC_COL.CALLEE_NAME] == null ? '' : abandonLeg[IC_COL.CALLEE_NAME]).trim();
      var abDept   = String(abandonLeg[IC_COL.DEPARTMENTS] == null ? '' : abandonLeg[IC_COL.DEPARTMENTS]).trim();
      if (icIsQueueName_(abCallee)) abandonStage = 'queue';
      else if (abDept && abDept.toUpperCase() !== 'N/A') abandonStage = 'direct';
      else abandonStage = 'ivr';
    }

    // Abandoned-on-hold: for inbound the customer is the CALLER, so the
    // signal is Caller Disconnect On Hold = TRUE on an incoming leg. This is
    // independent of `answered` (you can be answered THEN dropped on hold).
    var abandonedOnHold = (isInternalOrigin ? [legs[0]] : incoming).some(function (l) { return icIsTrue_(l[IC_COL.CALLER_DISC_ON_HOLD]); });

    // Hold time the caller was parked (max across legs).
    var holdSeconds = 0;
    legs.forEach(function (l) { holdSeconds = Math.max(holdSeconds, icTimeToSec_(l[IC_COL.CALLEE_HOLD_DURATION])); });

    // Queue journey (ordered distinct A_Q_* legs).
    var queues = [];
    legs.forEach(function (l) {
      var cn = String(l[IC_COL.CALLEE_NAME] == null ? '' : l[IC_COL.CALLEE_NAME]).trim();
      if (icIsQueueName_(cn) && queues.indexOf(cn) === -1) queues.push(cn);
    });

    // Final dept = the answering talk leg's Departments (if answered).
    var finalDept = null;
    if (answered) {
      for (var d = 0; d < legs.length; d++) {
        if (icTimeToSec_(legs[d][IC_COL.TALK]) > 0
            && String(legs[d][IC_COL.ANSWERED]).trim() === 'Answered') {
          var dep = String(legs[d][IC_COL.DEPARTMENTS] == null ? '' : legs[d][IC_COL.DEPARTMENTS]).trim();
          if (dep && dep.toUpperCase() !== 'N/A') { finalDept = dep; break; }
        }
      }
    }

    // Dial-in (DID / marketing line) -- first non-N/A on an incoming leg.
    var dialIn = null;
    for (var q = 0; q < incoming.length; q++) {
      var di = icDigits_(incoming[q][IC_COL.DIAL_IN]);
      if (di) { dialIn = di; break; }
    }

    // R5 (owner): first PERSON the call rang -- the callee of the first
    // non-queue leg that carries a real Departments value (IVR/menu legs
    // don't). Feeds the Inbound report's derived dial-in labeling: a
    // direct-DID line's dominant first_agent names the line's owner.
    // Phone-shaped callee names are skipped (PHI: never store a raw number).
    var firstAgent = null;
    for (var fa = 0; fa < legs.length; fa++) {
      var facn = String(legs[fa][IC_COL.CALLEE_NAME] == null ? '' : legs[fa][IC_COL.CALLEE_NAME]).trim();
      if (!facn || facn.toUpperCase() === 'N/A') continue;
      if (icIsQueueName_(facn)) continue;
      if (/^\+?[\d\s\-().]{7,}$/.test(facn)) continue;
      var fad = String(legs[fa][IC_COL.DEPARTMENTS] == null ? '' : legs[fa][IC_COL.DEPARTMENTS]).trim();
      if (!fad || fad.toUpperCase() === 'N/A') continue;
      firstAgent = facn.slice(0, IC_JOURNEY_NAME_MAX);
      break;
    }

    // Wait seconds: from first incoming Start to the first answer Connected,
    // or to the abandon Stop.
    var firstStart = icParseTs_((isInternalOrigin ? legs[0] : incoming[0])[IC_COL.START]);
    var endMs = NaN;
    if (answered) {
      for (var w = 0; w < legs.length; w++) {
        if (icTimeToSec_(legs[w][IC_COL.TALK]) > 0
            && String(legs[w][IC_COL.ANSWERED]).trim() === 'Answered') {
          endMs = icParseTs_(legs[w][IC_COL.CONNECTED]); break;
        }
      }
    } else if (abandonLeg) {
      endMs = icParseTs_(abandonLeg[IC_COL.STOP]);
    }
    var waitSeconds = (!isNaN(firstStart) && !isNaN(endMs))
      ? Math.max(0, Math.round((endMs - firstStart) / 1000)) : null;

    var callDate = icIsoDate_(firstStart);

    (isInternalOrigin ? internalPending : records).push({
      callId:          root,
      isInternal:      isInternalOrigin,
      // Scratch for the related-call cross-ref (deleted before return):
      _originExt:      isInternalOrigin ? (originExtForDisp || null) : null,
      _startMs:        isInternalOrigin ? firstStart : null,
      callDate:        callDate,
      callStart:       icIsoTime_(firstStart),
      callerNumber:    callerNumber,           // null = anonymous (hashed later)
      dialIn:          dialIn,
      disposition:     disposition,
      abandonStage:    abandonStage,
      abandonedOnHold: abandonedOnHold,
      holdSeconds:     holdSeconds,
      waitSeconds:     waitSeconds,
      entryQueue:      queues.length ? queues[0] : null,
      finalQueue:      queues.length ? queues[queues.length - 1] : null,
      finalDept:       finalDept,
      firstAgent:      firstAgent,
      // ORIGINATOR (internal-origin records only). `firstAgent` derives from
      // the CALLEE name across the group's legs, and an internal-origin group's
      // only callee IS the queue -- which icIsQueueName_ skips -- so these
      // records carried NO indication of who placed the call. The receiving
      // dept's path drill then read "an internal call abandoned in your queue"
      // with no actionable content. The originating agent sits in the CALLER
      // columns of the group's first leg (validated against the owner's
      // 2026-08-21 sample: "Marie (Muskaan) Jindal" / "Field Operations
      // (Market Activity)"). Employee name + the raw CDR org label, same PHI
      // class as firstAgent; a phone-shaped caller name is never stored.
      // NULL on every externally-originated record, so nothing else moves.
      originAgent:     isInternalOrigin ? originNameForDisp : null,
      originDept:      isInternalOrigin ? icOriginDeptLabel_(originLeg) : null,
      numQueues:       queues.length,
      numTransfers:    Math.max(0, queues.length - 1),
      journey:         icBuildJourney_(legs)
    });
  });

  // --- Internal-transfer path enrichment (journey-only, strictly additive) ---
  // When an agent ANSWERS an inbound call and TRANSFERS the caller to a queue,
  // that transfer is a SEPARATE internal-only leg group (no Incoming leg) which
  // the record builder drops. If the caller then ABANDONS in the transferred-to
  // queue, the abandon is invisible on the caller's captured inbound journey --
  // it just ends where the agent transferred out. This pass cross-references
  // each such internal queue-abandon to the answering agent's concurrent
  // captured inbound call and, ONLY on a UNIQUE match (exactly one captured
  // inbound the agent was on, Answered + Talk>0, overlapping the abandon within
  // +/-5s), appends one synthetic transfer-abandon event to THAT call's journey.
  //
  // Contract (deliberately conservative -- the read-only diagnostic
  // `previewInternalTransferPaths` settled these before this shipped):
  //   * JOURNEY-ONLY. disposition / counts / entryQueue / finalQueue /
  //     numQueues / numTransfers are NEVER touched -- no metric impact.
  //   * UNIQUE-MATCH-ONLY. 0 matches (no captured inbound found) or >1 (the
  //     agent was on two concurrent inbound calls) -> left as-is; the path
  //     simply isn't reconstructed. It never guesses.
  //   * PURE + DETERMINISTIC over rawRows, so a re-import reproduces the same
  //     journey (idempotent under the ON CONFLICT upsert).
  var recordByRoot = {};
  var enrichedRoots = {};
  records.forEach(function (rr) { recordByRoot[rr.callId] = rr; });

  // Index: agent extension -> the captured inbound call they were talking on.
  var agentBusy = [];
  Object.keys(groups).forEach(function (root) {
    if (!recordByRoot[root]) return;   // only captured inbound calls carry a record
    groups[root].forEach(function (l) {
      if (String(l[IC_COL.ANSWERED] == null ? '' : l[IC_COL.ANSWERED]).trim() !== 'Answered'
          || icTimeToSec_(l[IC_COL.TALK]) <= 0) return;
      var aext = icDigits_(l[IC_COL.CALLEE]);
      var as = icParseTs_(l[IC_COL.CONNECTED]), ae = icParseTs_(l[IC_COL.STOP]);
      if (!aext || isNaN(as) || isNaN(ae)) return;
      agentBusy.push({ root: root, ext: aext, startMs: as, endMs: ae,
                       name: String(l[IC_COL.CALLEE_NAME] == null ? '' : l[IC_COL.CALLEE_NAME]).trim() });
    });
  });

  // Step 4 (owner ruling 2026-08-24): the SAME index for OUTBOUND calls. An
  // assisting agent's concurrent call is often outbound -- a rep with a patient
  // on the line dials a queue for translation (validated: the 2026-08-21 legs).
  // agentBusy keys on the CALLEE ext, so those agents are invisible to it.
  // Group shape mirrors outboundCalls.js exactly (no Incoming leg + an
  // Answered Outgoing leg to an external number) so the two captures agree on
  // what an outbound call IS.
  var outboundBusy = [];
  Object.keys(groups).forEach(function (root) {
    var g = groups[root];
    var hasIncoming = g.some(function (l) {
      return String(l[IC_COL.DIRECTION] == null ? '' : l[IC_COL.DIRECTION]).trim() === 'Incoming';
    });
    if (hasIncoming) return;
    g.forEach(function (l) {
      if (String(l[IC_COL.DIRECTION] == null ? '' : l[IC_COL.DIRECTION]).trim() !== 'Outgoing') return;
      if (!icExternalNumber_(l[IC_COL.CALLEE])) return;
      if (String(l[IC_COL.ANSWERED] == null ? '' : l[IC_COL.ANSWERED]).trim() !== 'Answered') return;
      if (icTimeToSec_(l[IC_COL.TALK]) <= 0) return;
      var oext = icDigits_(l[IC_COL.CALLER]);
      var os = icParseTs_(l[IC_COL.CONNECTED]), oe = icParseTs_(l[IC_COL.STOP]);
      if (!oext || isNaN(os) || isNaN(oe)) return;
      outboundBusy.push({ root: root, ext: oext, startMs: os, endMs: oe });
    });
  });

  Object.keys(groups).forEach(function (root) {
    if (recordByRoot[root]) return;    // captured inbound -> not a transfer-abandon source
    var g = groups[root];
    var ab = null;
    for (var ci = 0; ci < g.length; ci++) {
      if (String(g[ci][IC_COL.ABANDONED] == null ? '' : g[ci][IC_COL.ABANDONED]).trim() === 'Abandoned'
          && icIsQueueName_(g[ci][IC_COL.CALLEE_NAME])) { ab = g[ci]; break; }
    }
    if (!ab) return;
    var xext = icDigits_(ab[IC_COL.CALLER]);           // the agent who placed the transfer
    if (!xext) return;
    var tMs = icParseTs_(ab[IC_COL.START]);
    if (isNaN(tMs)) return;
    var matches = agentBusy.filter(function (a) {
      return a.ext === xext && a.root !== root && tMs >= a.startMs - 5000 && tMs <= a.endMs + 5000;
    });
    if (matches.length !== 1) return;                  // 0 = no path; >1 = ambiguous -> no guessing
    var rec = recordByRoot[matches[0].root];
    if (!rec || !rec.journey || rec.journey.length >= IC_JOURNEY_MAX_EVENTS) return;
    var qn = String(ab[IC_COL.CALLEE_NAME] == null ? '' : ab[IC_COL.CALLEE_NAME]).trim();
    var stopMs = icParseTs_(ab[IC_COL.STOP]);
    var ev = {
      t: icIsoTime_(tMs),
      name: qn.slice(0, IC_JOURNEY_NAME_MAX),
      kind: 'queue',
      abandoned: true,
      transfer: true                                   // cross-referenced enrichment, not an in-call leg
    };
    if (!isNaN(stopMs)) ev.secs = Math.max(0, Math.round((stopMs - tMs) / 1000));
    rec.journey.push(ev);
    // Round-17: remember WHAT matched, not merely THAT it did -- the standalone
    // internal record below is now written (not dropped) and reconstructs the
    // ORIGIN hop from exactly these fields.
    enrichedRoots[root] = {
      callerRoot:  matches[0].root,
      agentExt:    xext,
      agentName:   matches[0].name || '',
      originQueue: String(rec.entryQueue || '').trim(),
      originStart: rec.callStart || null,
      answerT:     icIsoTime_(matches[0].startMs),
      answerTalk:  Math.max(0, Math.round((matches[0].endMs - matches[0].startMs) / 1000))
    };
  });

  // Round-17 (owner ruling, reverses the Round-16 drop): an internal-origin
  // queue record is ALWAYS written, including when the R11-N pass above
  // matched it to a caller's journey.
  //
  // Round-16 dropped the matched ones as a "double-tell" -- correct about the
  // duplication, wrong about the audience. The two records serve two DIFFERENT
  // depts: the caller's journey belongs to the ORIGIN dept (CSR sees "answered
  // -> transferred out -> abandoned"), while the abandon itself lands in the
  // RECEIVING dept's numbers, whose Missed report renders a "path" button off
  // the DQE queue-only sentinel (any abandon with wait > 60s, no internal/
  // external distinction). Dropping the record made that button resolve to
  // `not-captured` -- so the BETTER the matcher worked, the more reliably the
  // receiving dept's drill failed. Measured 2026-08-21: 10 of 11 candidates
  // uniquely matched, 6 of them past the DQE 60s threshold.
  //
  // Metric-safe by construction: every dashboard metric query excludes
  // is_internal rows, and getCallJourney is the sole consumer that does not.
  internalPending.forEach(function (ir) {
    var xfer = enrichedRoots[ir.callId];
    if (xfer) {
      // The matched case: link the caller's call and PREPEND the reconstructed
      // origin hop (origin queue -> answering agent) so the receiving dept's
      // drill reads as one continuous path instead of starting mid-story.
      // Events carry `transfer:true` + `origin:true` as provenance -- they are
      // cross-referenced, not legs of THIS call group. Same synthesis the
      // R11-N append already does in the other direction.
      ir.relatedCallId = xfer.callerRoot;
      ir.relatedCallKind = 'inbound';
      var head = [];
      if (xfer.originQueue) {
        head.push({ t: xfer.originStart, name: xfer.originQueue.slice(0, IC_JOURNEY_NAME_MAX),
                    kind: 'queue', transfer: true, origin: true });
      }
      head.push({ t: xfer.answerT,
                  name: (xfer.agentName || ('ext ' + xfer.agentExt)).slice(0, IC_JOURNEY_NAME_MAX),
                  kind: 'answer', talk: xfer.answerTalk, transfer: true, origin: true });
      ir.journey = head.concat(ir.journey || []).slice(0, IC_JOURNEY_MAX_EVENTS);
    } else if (ir._originExt && ir._startMs != null && !isNaN(ir._startMs)) {
      // Round-16b (owner): when the ORIGINATING employee placed this internal
      // queue call WHILE answering a captured inbound call (the internal
      // start nested in their answered talk-leg window, same ±5s slack as
      // the R11-N matcher -- the customer parked on hold), link that call so
      // the path drill can present the full context. UNIQUE match only; an
      // ambiguous or absent match leaves the record standalone.
      var ctxMatches = agentBusy.filter(function (a) {
        return a.ext === ir._originExt && a.root !== ir.callId
          && ir._startMs >= a.startMs - 5000 && ir._startMs <= a.endMs + 5000;
      });
      if (ctxMatches.length === 1) {
        ir.relatedCallId = ctxMatches[0].root;
        ir.relatedCallKind = 'inbound';
      } else if (!ctxMatches.length) {
        // Step 4: no concurrent captured INBOUND -> try the requester's
        // concurrent OUTBOUND call (the assist-during-outbound shape). Same
        // unique-match-only discipline: 0 or >1 leaves the record unlinked
        // rather than guessing. An inbound match always WINS -- it is the
        // stronger relationship (the customer was handed over, not merely
        // co-present).
        var obMatches = outboundBusy.filter(function (a) {
          return a.ext === ir._originExt && a.root !== ir.callId
            && ir._startMs >= a.startMs - 5000 && ir._startMs <= a.endMs + 5000;
        });
        if (obMatches.length === 1) {
          ir.relatedCallId = obMatches[0].root;
          ir.relatedCallKind = 'outbound';
        }
      }
    }
    records.push(ir);
  });
  records.forEach(function (rr) { delete rr._originExt; delete rr._startMs; });
  internalPending.forEach(function (rr) { delete rr._originExt; delete rr._startMs; });

  return records;
}

// ---- Neon mirror (best-effort; reuses neonWrite.js helpers) ------------------

/**
 * Builds inbound-call records from the Raw Data values and mirrors them to
 * Neon's `inbound_calls`. Best-effort: never throws into the import caller.
 * Idempotent via ON CONFLICT (call_date, call_id) DO UPDATE, so re-imports
 * refresh. caller_hash uses cdrHashPhone_ (matches insurance_numbers +
 * call_history_phones); null for anonymous callers.
 *
 * L2 / IMP-5: `opts.authoritative` makes the write a per-date REPLACE -- it
 * DELETEs the payload's distinct call_dates (in the SAME transaction) before
 * the upsert, so a shrinking re-import (one that DROPS a call_id) can't leave a
 * phantom row behind. `inbound_calls` has NO sheet primary AND is dashboard-read
 * (Inbound report / heatmap / Caller Lookup), so an upsert-only mirror kept a
 * removed call counting forever (the IMP-5 problem, previously unaddressed for
 * inbound). Pass it ONLY from complete-per-date callers: the daily import
 * (full Raw Data re-export) + the per-date backfill/deferred path (one
 * Call_Legs sheet). A partial-set caller must NOT pass it. (An extreme
 * date-goes-to-ZERO-inbound re-import can't be cleared this way -- an empty
 * payload carries no date to delete; that corner keeps the old upsert
 * behavior.)
 *
 * P-1: `opts.expectedDateIso` ('YYYY-MM-DD') is the F2-class guard for the
 * authoritative DELETE above. Records are dated from their OWN first leg
 * (icIsoDate_), so a stray carry-over leg from D-1 in day-D's source used to
 * put D-1 into the payload's date set -- and the authoritative replace then
 * WIPED all of D-1's inbound_calls rows (no sheet primary; permanent after
 * the ~14-day Call_Legs retention), replacing them with the lone stray
 * fragment. With expectedDateIso set, stray-dated records are DROPPED with a
 * log line (their home date's own import already wrote its complete set --
 * even a plain upsert of a fragment would corrupt that record), so the
 * DELETE can only ever touch the date being imported. Every current caller
 * passes it; omitting it keeps the old trust-the-payload behavior.
 */
// ── R8-N: capture-time queue-name normalization (raw -> QCD-canonical) ──────
//
// The durable fix for the two-queue-name-spaces landmine (known-issues):
// the phone system emits RAW queue names (`A_Q_CSR`) while every dashboard
// map speaks QCD-canonical (`A_Q_CustomerSuccess`). Instead of each consumer
// bridging per-surface, ENTRY_QUEUE/FINAL_QUEUE are translated at capture,
// seeded from the SAME admin-curated Dept Config "Inbound queue aliases"
// column (INV-54 col 10) -- entries may now be either:
//   `A_Q_CSR`                      plain RAW alias (attribution-only, as before)
//   `A_Q_CSR=A_Q_CustomerSuccess`  alias + capture-time translation target
// The `=` right side must be one of the dept's QCD queues (validated at
// save). Only entry_queue/final_queue are translated -- the journey JSON
// keeps the raw phone-system names (faithful leg-by-leg record), and
// num_queues/num_transfers count raw legs as before. Cross-project
// soft-coupling mirrors loadRosterCanonicalNames_ (INV-46): cdr-import
// reads the dashboard-owned sheet best-effort -- any failure yields an
// empty map = capture behaves exactly as pre-normalization. The dashboard's
// union predicates (inboundQueuesForDept_) keep the raw names too, so rows
// captured BEFORE normalization still attribute.
// Shared, per-run read of the dashboard's `Dept Config` sheet (INV-54, the
// INV-46 cross-project soft-coupling pattern). ONE read serves both the
// canonical-name map and the F1 queue-name recognition set; best-effort, so a
// missing/unreadable sheet leaves both empty and the capture behaves exactly
// as it did before either feature. Returns the ACTIVE rows only.
var IC_DEPT_CONFIG_ROWS_MEMO_ = null;

/**
 * Drops every Dept-Config-derived memo so the next call re-reads the sheet.
 * ONE entry point on purpose: the row cache now feeds BOTH the canonical-name
 * map and the F1 queue-name set, so clearing just one of them would serve a
 * stale read from the other. Called at the top of each write run (config can
 * change between runs) and by the unit tests when they swap the fixture.
 */
function icResetConfigMemos_() {
  IC_DEPT_CONFIG_ROWS_MEMO_ = null;
  IC_QUEUE_CANON_MEMO_ = null;
  IC_KNOWN_QUEUE_NAMES_ = null;
}

function icDeptConfigActiveRows_() {
  if (IC_DEPT_CONFIG_ROWS_MEMO_) return IC_DEPT_CONFIG_ROWS_MEMO_;
  var out = [];
  try {
    var ssId = (typeof getTargetSsId_ === 'function') ? getTargetSsId_() : null;
    var ss = ssId ? SpreadsheetApp.openById(ssId) : null;
    var sheet = ss ? ss.getSheetByName('Dept Config') : null;
    if (sheet && sheet.getLastRow() >= 2) {
      sheet.getRange(2, 1, sheet.getLastRow() - 1, 10).getValues().forEach(function (r) {
        // Strict truthy Active (the editor writes TRUE/FALSE) -- an
        // unrecognized marker means the row contributes NOTHING, the safe
        // direction for both consumers.
        if (/^(true|yes|1)$/i.test(String(r[5] == null ? '' : r[5]).trim())) out.push(r);
      });
    }
  } catch (e) {
    Logger.log('icDeptConfigActiveRows_ (best-effort): ' + (e && e.message ? e.message : e));
  }
  IC_DEPT_CONFIG_ROWS_MEMO_ = out;
  return out;
}

/**
 * F1. Populates IC_KNOWN_QUEUE_NAMES_ from the Dept Config sheet so a queue
 * whose raw phone-system name doesn't match the A_Q_* / Backup CSR patterns is
 * still recognized as a queue by the capture. Sources BOTH name spaces:
 *   - "QCD Queues" (col 2)            -- the QCD-canonical names
 *   - "Inbound Queue Aliases" (col 10) -- the RAW inbound names, including the
 *     raw side of a `raw=canonical` pair (that pair's whole reason for
 *     existing is that the raw spelling differs)
 * Called once per write run. Additive only -- see icIsQueueName_.
 */
function icLoadConfiguredQueueNames_() {
  var set = {};
  var add = function (v) {
    var t = String(v == null ? '' : v).trim();
    // A digit-only token is an extension, not a queue name (the Dept Config
    // save path rejects those in the alias column for the same reason).
    if (!t || /^\d+$/.test(t)) return;
    set[t.toLowerCase()] = true;
  };
  try {
    icDeptConfigActiveRows_().forEach(function (r) {
      String(r[1] == null ? '' : r[1]).split(',').forEach(add);
      String(r[9] == null ? '' : r[9]).split(',').forEach(function (tok) {
        var t = String(tok).trim();
        var eq = t.indexOf('=');
        add(eq > 0 ? t.slice(0, eq) : t);   // RAW side of a pair, or a plain alias
      });
    });
  } catch (e) {
    Logger.log('icLoadConfiguredQueueNames_ (best-effort, patterns still apply): '
      + (e && e.message ? e.message : e));
  }
  IC_KNOWN_QUEUE_NAMES_ = set;
  var n = Object.keys(set).length;
  if (n) Logger.log('icLoadConfiguredQueueNames_: %s configured queue name(s) recognized.', n);
  return set;
}

var IC_QUEUE_CANON_MEMO_ = null;
function icQueueCanonicalMap_() {
  if (IC_QUEUE_CANON_MEMO_) return IC_QUEUE_CANON_MEMO_;
  var map = {};
  try {
    icDeptConfigActiveRows_().forEach(function (r) {
      String(r[9] == null ? '' : r[9]).split(',').forEach(function (tok) {
        var t = String(tok).trim();
        var eq = t.indexOf('=');
        if (eq <= 0 || eq === t.length - 1) return;   // plain alias / malformed
        var raw = t.slice(0, eq).trim();
        var canonical = t.slice(eq + 1).trim();
        if (!raw || !canonical) return;
        var key = raw.toLowerCase();
        if (map[key] && map[key] !== canonical) {
          Logger.log('icQueueCanonicalMap_: raw queue "' + raw + '" mapped to both "'
            + map[key] + '" and "' + canonical + '" -- keeping the first (fix Dept Config).');
          return;
        }
        map[key] = canonical;
      });
    });
  } catch (e) {
    Logger.log('icQueueCanonicalMap_ (best-effort, capture stays raw): '
      + (e && e.message ? e.message : e));
  }
  IC_QUEUE_CANON_MEMO_ = map;
  return map;
}

function icNormalizeQueue_(name, map) {
  if (!name) return name;
  return map[String(name).trim().toLowerCase()] || name;
}

function writeInboundCallsToNeon(rawRows, opts) {
  var authoritative = !!(opts && opts.authoritative);
  var expectedDateIso = (opts && opts.expectedDateIso) ? String(opts.expectedDateIso) : '';
  try {
    // Fresh config per run (it can change between runs). The queue-name set
    // MUST load BEFORE the builder -- icIsQueueName_ runs inside it (F1).
    icResetConfigMemos_();
    icLoadConfiguredQueueNames_();
    // C-6: count the records the builder produced with NO parseable date --
    // one unparseable INCOMING first leg nulls the whole call's callDate, so
    // a CDR timestamp-format drift would silently shrink a table with no
    // sheet primary. The count travels on the result so the daily import can
    // surface it (the DQE build's F9 unparsedStartCount discipline).
    var unparsedDropped = 0;
    var records = buildInboundCallRecords_(rawRows).filter(function (r) {
      if (r.callDate) return true;
      unparsedDropped++;
      return false;
    });
    if (unparsedDropped) {
      Logger.log('writeInboundCallsToNeon: dropped %s record(s) with no parseable call date '
        + '(unparseable first-leg timestamp?) -- these calls are NOT captured.', unparsedDropped);
    }
    // R8-N: translate the attribution columns to canonical names when the
    // admin has mapped them; everything else (journey, counts) stays raw.
    var canonMap = icQueueCanonicalMap_();
    records.forEach(function (r) {
      r.entryQueue = icNormalizeQueue_(r.entryQueue, canonMap);
      r.finalQueue = icNormalizeQueue_(r.finalQueue, canonMap);
    });
    if (expectedDateIso) {
      var strayCount = 0;
      records = records.filter(function (r) {
        if (r.callDate === expectedDateIso) return true;
        strayCount++;
        return false;
      });
      if (strayCount) {
        Logger.log('writeInboundCallsToNeon: dropped %s stray record(s) dated outside %s '
          + '(carry-over legs; their home date owns them -- P-1 guard).',
          strayCount, expectedDateIso);
      }
    }
    if (!records.length) {
      // F2 (the P-5 rule, applied to a table with no sheet primary): an
      // authoritative run whose SOURCE HAD LEGS but yielded zero inbound calls
      // is a legitimate "this date has none" -- and the date's existing rows
      // must go, or phantoms from an earlier import survive forever (nothing
      // else corrects `inbound_calls`). Previously this returned early, so a
      // date whose legitimate count is zero could never be cleaned.
      //
      // Gated on rawRows being NON-EMPTY: an empty/unreadable source is the one
      // case where deleting would destroy good data, so it keeps the old
      // early-return. expectedDateIso is required too, so the DELETE can only
      // ever touch the date the caller vouched for (the P-1 guard).
      //
      // C-1: ALSO gated on zero strays. "Source had rows but every record it
      // yielded belonged to ANOTHER date" is not evidence this date has no
      // calls -- it is the signature of a mislabeled/wrong-day grid, and
      // deleting on it would wipe the expected date's rows from a table with
      // no sheet primary (unrecoverable past the Call_Legs retention). Leave
      // any stale rows in place (recoverable, like the unreachable case) and
      // tell the caller why so it can surface a Pipeline Health row.
      if (authoritative && expectedDateIso && rawRows && rawRows.length) {
        if (strayCount) {
          Logger.log('writeInboundCallsToNeon: REFUSING zero-record cleanup for %s -- the source '
            + 'grid yielded %s record(s), ALL dated elsewhere (wrong-day grid?). Stale rows (if '
            + 'any) left in place.', expectedDateIso, strayCount);
          return { inserted: 0, skipped: 0, allStray: true, strayCount: strayCount };
        }
        if (unparsedDropped) {
          // C-6 (the C-1 sibling): "every record the grid yielded had an
          // unparseable date" is a format-drift signature, not a zero-call
          // day -- deleting on it would wipe the date while the capture is
          // blind. Same refusal semantics as allStray.
          Logger.log('writeInboundCallsToNeon: REFUSING zero-record cleanup for %s -- the source '
            + 'grid yielded %s record(s), ALL with unparseable dates (timestamp format drift?). '
            + 'Stale rows (if any) left in place.', expectedDateIso, unparsedDropped);
          return { inserted: 0, skipped: 0, allUnparsed: true, unparsedDropped: unparsedDropped };
        }
        return icDeleteDateOnly_('inbound_calls', expectedDateIso, 'writeInboundCallsToNeon');
      }
      return { inserted: 0, skipped: 0, unparsedDropped: unparsedDropped };
    }

    var secret = PropertiesService.getScriptProperties().getProperty('HMAC_SECRET');
    // C-9: reset the per-run phone-hash memo at this writer's entry too (the
    // A2 discipline writeCDRRowsToNeon follows) -- a warm instance otherwise
    // hashes through whatever cache state the previous execution left, which
    // serves stale hashes after an HMAC_SECRET rotation until a cold start.
    if (typeof CDR_HMAC_CACHE_ !== 'undefined') CDR_HMAC_CACHE_ = {};
    var conn = getReachableNeonConn_();
    if (!conn) {
      Logger.log('writeInboundCallsToNeon: Neon unreachable — skipping %s records.', records.length);
      return { inserted: 0, skipped: records.length };
    }
    conn.setAutoCommit(false);
    try {
      var ddl = conn.createStatement();
      ddl.execute(
        'CREATE TABLE IF NOT EXISTS inbound_calls (' +
        'call_date date NOT NULL, call_id text NOT NULL, caller_hash text, ' +
        'dial_in_number text, disposition text, abandon_stage text, ' +
        'abandoned_on_hold boolean, hold_seconds integer, wait_seconds integer, ' +
        'entry_queue text, final_queue text, final_dept text, ' +
        'num_queues integer, num_transfers integer, ' +
        'call_start text, journey text, ' +
        'updated_at timestamptz NOT NULL DEFAULT now(), ' +
        'PRIMARY KEY (call_date, call_id))');
      // Idempotent column adds for tables created before the journey
      // capture (the CREATE above only fires on a fresh database).
      ddl.execute('ALTER TABLE inbound_calls ADD COLUMN IF NOT EXISTS call_start text');
      ddl.execute('ALTER TABLE inbound_calls ADD COLUMN IF NOT EXISTS journey text');
      // R5: first person the call rang (dial-in labeling); NULL on
      // pre-extension rows until re-imported/backfilled.
      ddl.execute('ALTER TABLE inbound_calls ADD COLUMN IF NOT EXISTS first_agent text');
      // Round-16: internal-origin queue calls (journey-only; every dashboard
      // metric query excludes is_internal=TRUE rows).
      ddl.execute('ALTER TABLE inbound_calls ADD COLUMN IF NOT EXISTS is_internal boolean');
      ddl.execute('ALTER TABLE inbound_calls ADD COLUMN IF NOT EXISTS related_call_id text');
      // Who PLACED an internal-origin call (employee name + raw CDR org label).
      // NULL on every externally-originated row and on pre-extension rows until
      // re-imported / backfilled.
      ddl.execute('ALTER TABLE inbound_calls ADD COLUMN IF NOT EXISTS origin_agent text');
      ddl.execute('ALTER TABLE inbound_calls ADD COLUMN IF NOT EXISTS origin_dept text');
      // Which TABLE related_call_id points at. NULL means 'inbound' -- every
      // row written before Step 4 linked an inbound call, so the read side
      // must COALESCE rather than treat NULL as unknown.
      ddl.execute('ALTER TABLE inbound_calls ADD COLUMN IF NOT EXISTS related_call_kind text');
      ddl.close();

      // L2: authoritative per-date replace. Delete the payload's distinct dates
      // first (same txn -> atomic with the upsert below; a throw rolls back
      // both, so a timeout can't leave a date half-cleared). Date strings are
      // 'YYYY-MM-DD' from buildInboundCallRecords_ and escaped via icSqlStr_
      // (same as the insert's `::date` binds), so this is injection-safe.
      if (authoritative) {
        var dateSet = {};
        records.forEach(function (r) { if (r.callDate) dateSet[r.callDate] = true; });
        var authDates = Object.keys(dateSet);
        if (authDates.length) {
          var delStmt = conn.createStatement();
          delStmt.execute('DELETE FROM inbound_calls WHERE call_date IN ('
            + authDates.map(function (d) { return icSqlStr_(d) + '::date'; }).join(',') + ')');
          delStmt.close();
        }
      }

      var cols = 'call_date, call_id, caller_hash, dial_in_number, disposition, ' +
        'abandon_stage, abandoned_on_hold, hold_seconds, wait_seconds, entry_queue, ' +
        'final_queue, final_dept, num_queues, num_transfers, call_start, journey, first_agent, is_internal, related_call_id, origin_agent, origin_dept, related_call_kind';
      var onConflict = ' ON CONFLICT (call_date, call_id) DO UPDATE SET ' +
        'caller_hash=EXCLUDED.caller_hash, dial_in_number=EXCLUDED.dial_in_number, ' +
        'disposition=EXCLUDED.disposition, abandon_stage=EXCLUDED.abandon_stage, ' +
        'abandoned_on_hold=EXCLUDED.abandoned_on_hold, hold_seconds=EXCLUDED.hold_seconds, ' +
        'wait_seconds=EXCLUDED.wait_seconds, entry_queue=EXCLUDED.entry_queue, ' +
        'final_queue=EXCLUDED.final_queue, final_dept=EXCLUDED.final_dept, ' +
        'num_queues=EXCLUDED.num_queues, num_transfers=EXCLUDED.num_transfers, ' +
        'call_start=EXCLUDED.call_start, journey=EXCLUDED.journey, ' +
        'first_agent=EXCLUDED.first_agent, is_internal=EXCLUDED.is_internal, related_call_id=EXCLUDED.related_call_id, origin_agent=EXCLUDED.origin_agent, origin_dept=EXCLUDED.origin_dept, related_call_kind=EXCLUDED.related_call_kind, updated_at=now()';

      // INLINE multi-row upsert (no bound params) -- removes ~16 JDBC
      // bind-bridge calls PER ROW (the dominant cost; ~40ms each in Apps
      // Script). caller_hash is hex, dates/ints/bools are safe, and the
      // free-text fields (incl. the journey JSON string) are escaped via
      // icSqlStr_, so inlining is injection-safe. Chunking is SIZE-AWARE
      // (icChunkTuplesByChars_): journey rows vary ~0.2-6KB each, so a
      // fixed row count either wastes round-trips or -- as the 2026-06-08
      // import proved when a heavy-journey chunk threw "Argument too
      // large: sql" -- overruns Apps Script's JDBC statement-size cap.
      var tBuild = Date.now();
      var tuples = records.map(function (r) {
        var hash = (secret && r.callerNumber) ? cdrHashPhone_(r.callerNumber, secret) : null;
        return '(' + icSqlStr_(r.callDate) + '::date,' + icSqlStr_(r.callId) + ',' + icSqlHash_(hash)
          + ',' + icSqlStr_(r.dialIn) + ',' + icSqlStr_(r.disposition) + ',' + icSqlStr_(r.abandonStage)
          + ',' + (r.abandonedOnHold ? 'TRUE' : 'FALSE') + ',' + icSqlInt_(r.holdSeconds)
          + ',' + icSqlInt_(r.waitSeconds) + ',' + icSqlStr_(r.entryQueue) + ',' + icSqlStr_(r.finalQueue)
          + ',' + icSqlStr_(r.finalDept) + ',' + icSqlInt_(r.numQueues) + ',' + icSqlInt_(r.numTransfers)
          + ',' + icSqlStr_(r.callStart)
          + ',' + icSqlStr_(r.journey && r.journey.length ? JSON.stringify(r.journey) : null)
          + ',' + icSqlStr_(r.firstAgent) + ',' + (r.isInternal ? 'TRUE' : 'FALSE') + ',' + icSqlStr_(r.relatedCallId)
          + ',' + icSqlStr_(r.originAgent) + ',' + icSqlStr_(r.originDept)
          + ',' + icSqlStr_(r.relatedCallKind) + ')';
      });
      var buildMs = Date.now() - tBuild;

      var tInsert = Date.now();
      var stmt = conn.createStatement();
      var batches = icChunkTuplesByChars_(tuples, IC_SQL_CHUNK_BUDGET_CHARS);
      for (var bi = 0; bi < batches.length; bi++) {
        stmt.execute('INSERT INTO inbound_calls (' + cols + ') VALUES '
          + batches[bi].join(',') + onConflict);
      }
      var chunks = batches.length;
      stmt.close();
      conn.commit();
      var insertMs = Date.now() - tInsert;
      Logger.log('writeInboundCallsToNeon: wrote ' + records.length + ' inbound-call records | '
        + 'build ' + buildMs + 'ms | insert ' + insertMs + 'ms (' + chunks + ' chunks).');
      return { inserted: records.length, skipped: 0, unparsedDropped: unparsedDropped };
    } catch (e) {
      try { conn.rollback(); } catch (re) {}
      throw e;
    } finally {
      try { conn.close(); } catch (ce) {}
    }
  } catch (e) {
    Logger.log('writeInboundCallsToNeon failed (best-effort): ' + (e && e.message ? e.message : e));
    return { inserted: 0, skipped: 0, error: true };
  }
}

// ---- Historical backfill (editor-run) ----------------------------------------

// Per-invocation wall-clock budget before pausing. Dates already mirrored
// are skipped on the next run (date-level skip is safe: each date's write
// is one transaction -- single commit in writeInboundCallsToNeon -- so a
// timeout can't leave a half-written date behind). 15 min mirrors the
// bulk-rebuild budget, leaving margin under the 30-min execution ceiling.
var IC_BACKFILL_TIME_LIMIT_MS = 15 * 60 * 1000;

/**
 * EDITOR-RUN. Backfills Neon's `inbound_calls` from the per-day
 * `Call_Legs_YYYY-MM-DD` sheets still present in THIS (source)
 * spreadsheet. The daily integrated path only captures inbound calls
 * going forward; this fills in history for dates imported before the
 * inbound capture shipped (or after an outage).
 *
 * Behavior:
 *   - No args: processes EVERY Call_Legs_* sheet, oldest first.
 *   - Optional fromIso / toIso ('YYYY-MM-DD') bound the date range.
 *   - Dates already present in `inbound_calls` are SKIPPED (one
 *     json_agg'd SELECT DISTINCT up front -- per-row JDBC iteration is
 *     ~0.5s/row, so the result is fetched as a single string). Pass
 *     force=true to re-process them (idempotent via ON CONFLICT
 *     DO UPDATE, so a force re-run refreshes rather than duplicates).
 *   - Time-budgeted (IC_BACKFILL_TIME_LIMIT_MS): on hitting the budget
 *     it logs progress and returns; just run it again -- completed
 *     dates are skipped, so each run resumes where the last stopped.
 *   - Stops early if Neon reports unreachable for a date (no point
 *     hammering a suspended instance; re-run later).
 *   - Best-effort Pipeline Health summary row (step 'inboundBackfill')
 *     per run via logPipelineHealthWithFallback_ (autoImport.js, same
 *     project), so the run is visible in the dashboard's Alerts modal.
 *
 * Coverage note: this can only backfill dates whose Call_Legs_* sheet
 * still exists -- days pruned by DeleteOldSheets are gone from the
 * sheet side and cannot be reconstructed.
 */
/**
 * Editor-run FORCE variant (the Run picker can't pass arguments). Use for
 * the IMP-1 heal: dates mirrored BEFORE the Backup-CSR queue fix are in
 * `inbound_calls` already, so the plain run skips them as "already
 * mirrored" -- force re-derives every surviving Call_Legs_* date and
 * ON CONFLICT DO UPDATE rewrites the mis-classified rows (abandon_stage
 * 'ivr' -> 'queue', entry/final queue populated). Idempotent; safe to
 * re-run until the log says "complete".
 */
function backfillInboundCallsForce() {
  return backfillInboundCalls(null, null, true);
}

function backfillInboundCalls(fromIso, toIso, force) {
  var startMs = Date.now();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // Enumerate Call_Legs_* sheets in range, oldest first.
  var candidates = [];
  ss.getSheets().forEach(function (s) {
    var m = s.getName().match(/^Call_Legs_(\d{4}-\d{2}-\d{2})$/i);
    if (!m) return;
    var iso = m[1];
    if (fromIso && iso < fromIso) return;
    if (toIso && iso > toIso) return;
    candidates.push({ iso: iso, sheet: s });
  });
  candidates.sort(function (a, b) { return a.iso < b.iso ? -1 : 1; });
  if (!candidates.length) {
    Logger.log('backfillInboundCalls: no Call_Legs_* sheets found'
      + (fromIso || toIso ? ' in range ' + (fromIso || '...') + '..' + (toIso || '...') : '') + '.');
    // F1: return a status object (was a bare `return;` -> undefined) so callers
    // -- notably NeonMirror.js::mirrorInboundForDate_ -- can distinguish
    // "nothing to mirror" from "Neon unreachable" and report a real row count.
    return { inserted: 0, processed: 0, skippedDone: 0, skippedEmpty: 0,
             failures: 0, unreachable: false, stoppedEarly: null,
             sheetsFound: 0 };   // IMP-11: lets the deferred mirror detect a pruned source
  }

  // Dates already mirrored (skipped unless force). Missing table /
  // unreachable Neon -> empty set; the per-date writer creates the
  // table and handles unreachability itself.
  var doneDates = force ? {} : icFetchMirroredDates_();

  var processed = 0, skippedDone = 0, skippedEmpty = 0, totalRecords = 0;
  var failures = [];
  var stoppedEarly = null;
  var unreachable = false;   // F1: set when a per-date write reports Neon unreachable

  for (var i = 0; i < candidates.length; i++) {
    if (Date.now() - startMs > IC_BACKFILL_TIME_LIMIT_MS) {
      stoppedEarly = 'time budget reached at ' + candidates[i].iso
        + ' (' + (candidates.length - i) + ' sheets left) — run again to continue';
      break;
    }
    var c = candidates[i];
    if (doneDates[c.iso]) { skippedDone++; continue; }

    try {
      var legs = c.sheet.getDataRange().getDisplayValues();
      legs.shift();   // header row
      if (!legs.length) { skippedEmpty++; continue; }
      // L2: one Call_Legs_<iso> sheet is the COMPLETE set for that date, so
      // authoritative replace is safe (and matches the daily inline path +
      // the deferred mirror, which drains through here). A force re-run
      // refreshes cleanly; a non-force fill only writes NEW dates (the DELETE
      // is a no-op there).
      // P-1: pin the write to this sheet's own date -- a carry-over leg from
      // the previous day inside Call_Legs_<iso> must not delete that day.
      var res = writeInboundCallsToNeon(legs, { authoritative: true, expectedDateIso: c.iso });
      if (res && res.error) {
        failures.push(c.iso);
      } else if (res && (res.allStray || res.allUnparsed)) {
        // C-1/C-6: the sheet's contents are ALL dated outside its own
        // name-derived date (mislabeled sheet) or ALL unparseable (format
        // drift). The writer refused the cleanup; record it as a failure,
        // not a processed date.
        failures.push(c.iso + (res.allStray
          ? ' (all ' + res.strayCount + ' record(s) dated outside the sheet\'s date)'
          : ' (all ' + res.unparsedDropped + ' record(s) with unparseable dates)'));
      } else if (res && ((res.skipped && !res.inserted) || res.unreachable)) {
        // Neon unreachable for this date -- abort the run; re-run later.
        // `res.unreachable` also covers the F2 zero-record cleanup arm, which
        // carries no `skipped` count but still needs the date retried.
        unreachable = true;   // F1: signal the caller so the date stays queued
        stoppedEarly = 'Neon unreachable at ' + c.iso + ' — re-run once Neon is up';
        break;
      } else {
        processed++;
        totalRecords += (res && res.inserted) || 0;
      }
    } catch (e) {
      failures.push(c.iso + ' (' + ((e && e.message) ? e.message : e) + ')');
    }
  }

  var summary = 'backfillInboundCalls: ' + processed + ' date(s) written ('
    + totalRecords + ' records), ' + skippedDone + ' already mirrored, '
    + skippedEmpty + ' empty'
    + (failures.length ? ', FAILED: ' + failures.join(', ') : '')
    + (stoppedEarly ? ' | STOPPED: ' + stoppedEarly : ' | complete')
    + ' | ' + Math.round((Date.now() - startMs) / 1000) + 's';
  Logger.log(summary);

  // Best-effort run telemetry (Pipeline Health lives in the target SS).
  try {
    if (typeof logPipelineHealthWithFallback_ === 'function') {
      logPipelineHealthWithFallback_(null, {
        step:       'inboundBackfill',
        status:     failures.length ? 'failure' : 'success',
        rows:       totalRecords,
        durationMs: Date.now() - startMs,
        notes:      summary.slice('backfillInboundCalls: '.length, 500),
      });
    }
  } catch (logErr) { /* best-effort */ }

  // F1: structured outcome for programmatic callers (mirrorInboundForDate_).
  // `inserted` = records written this run; `unreachable` = Neon was down for a
  // date (caller should keep it queued); `failures` = count of hard per-date
  // write errors. Editor-run callers ignore the return and read the log.
  return {
    inserted:    totalRecords,
    processed:   processed,
    skippedDone: skippedDone,
    skippedEmpty: skippedEmpty,
    failures:    failures.length,
    unreachable: unreachable,
    stoppedEarly: stoppedEarly,
    sheetsFound: candidates.length,   // IMP-11
  };
}

/**
 * Distinct call_date values already in `inbound_calls`, as { iso: true }.
 * One json_agg'd query + one getString (per-row JDBC is ~0.5s/row).
 * Best-effort: missing table / unreachable Neon / any error -> {} so the
 * backfill simply attempts every date (idempotent either way).
 */
function icFetchMirroredDates_() {
  var out = {};
  var conn = null;
  try {
    conn = getReachableNeonConn_();
    if (!conn) return out;
    var stmt = conn.createStatement();
    var rs = stmt.executeQuery(
      "SELECT COALESCE(json_agg(DISTINCT call_date::text), '[]')::text AS j FROM inbound_calls");
    var json = rs.next() ? rs.getString('j') : '[]';
    rs.close(); stmt.close();
    JSON.parse(json || '[]').forEach(function (d) { out[String(d)] = true; });
  } catch (e) {
    Logger.log('icFetchMirroredDates_: ' + (e && e.message ? e.message : e)
      + ' — treating no dates as mirrored.');
  } finally {
    if (conn) { try { conn.close(); } catch (ce) {} }
  }
  return out;
}

/**
 * READ-ONLY diagnostic -- NOT wired into any pipeline. Replays the (fragile)
 * "cross-reference an internal queue-abandon to the agent's concurrent inbound
 * call" idea against a Call_Legs_<iso> sheet and LOGS what path it WOULD build,
 * plus a unique/ambiguous/miss tally, so the accuracy can be judged before
 * anyone commits the real capture change. Writes nothing; safe to delete.
 *
 * CDR Import editor: previewInternalTransferPaths('2026-07-21')
 * (no arg -> the most recent Call_Legs_* sheet). Only dates whose Call_Legs
 * sheet still exists (~14-day retention) can be analyzed.
 */
function previewInternalTransferPaths(dateIso) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = null, iso = dateIso || '';
  if (dateIso) {
    sheet = ss.getSheetByName('Call_Legs_' + dateIso);
  } else {
    ss.getSheets().forEach(function (s) {
      var m = s.getName().match(/^Call_Legs_(\d{4}-\d{2}-\d{2})$/i);
      if (m && m[1] > iso) { iso = m[1]; sheet = s; }
    });
  }
  if (!sheet) { Logger.log('previewInternalTransferPaths: no Call_Legs sheet for ' + (dateIso || '(latest)') + '.'); return; }

  var legs = sheet.getDataRange().getDisplayValues();
  legs.shift();   // header row

  // Group legs by ROOT (Parent Call ID if present, else own) -- same as buildInboundCallRecords_.
  var groups = {};
  legs.forEach(function (r) {
    var own = String(r[IC_COL.CALL_ID] || '').trim();
    if (!own) return;
    var parent = String(r[IC_COL.PARENT_CALL_ID] || '').trim();
    var root = (parent && parent.toUpperCase() !== 'N/A') ? parent : own;
    (groups[root] = groups[root] || []).push(r);
  });

  var isIncoming = function (l) { return String(l[IC_COL.DIRECTION] || '').trim() === 'Incoming'; };

  // Index answered agent legs on CAPTURED (has-Incoming) inbound calls, for the
  // cross-ref: ext -> when that agent was on a call + which call it was. Two
  // tiers so the deeper diagnostic can tell an ironclad recoverable from a
  // guess: `agentBusy` = the current signal (Answered AND Talk>0);
  // `agentBusyZero` = Answered but Talk=0 (an immediate transfer where the
  // metric never registered talk) -- same ext-identity + overlap signal, only
  // the duration is missing, so a UNIQUE Talk=0 match is still ironclad.
  var agentBusy = [];
  var agentBusyZero = [];
  var extEverAnswered = {};   // ext -> true: answered a captured inbound at all (any talk)
  Object.keys(groups).forEach(function (root) {
    var g = groups[root];
    if (!g.some(isIncoming)) return;                         // not a captured inbound call
    var entry = '', caller = '';
    g.forEach(function (l) {
      if (!entry && icIsQueueName_(l[IC_COL.CALLEE_NAME])) entry = String(l[IC_COL.CALLEE_NAME]).trim();
      if (!caller && icExternalNumber_(l[IC_COL.CALLER])) caller = String(l[IC_COL.CALLER_NAME] || '').trim();
    });
    g.forEach(function (l) {
      if (String(l[IC_COL.ANSWERED] || '').trim() !== 'Answered') return;
      var ext = icDigits_(l[IC_COL.CALLEE]);                 // the agent's extension
      var s = icParseTs_(l[IC_COL.CONNECTED]), e = icParseTs_(l[IC_COL.STOP]);
      if (!ext || isNaN(s) || isNaN(e)) return;
      var rec = { callId: root, ext: ext, startMs: s, endMs: e, entry: entry, caller: caller };
      extEverAnswered[ext] = true;
      if (icTimeToSec_(l[IC_COL.TALK]) > 0) agentBusy.push(rec);
      else agentBusyZero.push(rec);
    });
  });

  var inWindow = function (a, tMs) {
    return !isNaN(tMs) && tMs >= a.startMs - 5000 && tMs <= a.endMs + 5000;
  };
  // Smallest distance (sec) from tMs to the nearest [start,end] window of `ext`
  // in `pool` -- 0 when inside. Quantifies a time-window near-miss.
  var nearestGapSec = function (pool, ext, tMs) {
    if (isNaN(tMs)) return null;
    var best = null;
    pool.forEach(function (a) {
      if (a.ext !== ext) return;
      var gap = (tMs < a.startMs) ? (a.startMs - tMs) : (tMs > a.endMs ? tMs - a.endMs : 0);
      if (best === null || gap < best) best = gap;
    });
    return best === null ? null : Math.round(best / 1000);
  };

  // Candidates: SKIPPED (internal-only) groups holding an abandoned queue leg.
  var nCand = 0, nUnique = 0, nAmbig = 0, nMiss = 0;
  // Deeper breakdown of the unresolved pool:
  var nRecoverZeroTalk = 0;   // would UNIQUELY resolve if Talk=0 answered legs counted (ironclad)
  var nWindowNear = 0;        // ext answered a captured inbound, but the abandon is outside the window (risky to widen)
  var nChainOrUncaptured = 0; // ext never answered a captured inbound (chained transfer / uncaptured source)
  Object.keys(groups).forEach(function (root) {
    var g = groups[root];
    if (g.some(isIncoming)) return;
    var ab = g.filter(function (l) {
      return String(l[IC_COL.ABANDONED] || '').trim() === 'Abandoned' && icIsQueueName_(l[IC_COL.CALLEE_NAME]);
    })[0];
    if (!ab) return;
    nCand++;
    var ext = icDigits_(ab[IC_COL.CALLER]);                  // the agent who placed the transfer
    var queue = String(ab[IC_COL.CALLEE_NAME] || '').trim();
    var tMs = icParseTs_(ab[IC_COL.START]);
    var head = 'ABANDON ' + root + ' | ext ' + ext + ' -> ' + queue
      + ' @ ' + String(ab[IC_COL.START]).trim() + ' (wait ' + String(ab[IC_COL.CALL_TIME] || '').trim() + ')';
    var matches = agentBusy.filter(function (a) {
      return a.ext === ext && a.callId !== root && inWindow(a, tMs);
    });
    if (matches.length === 1) {
      nUnique++;
      var m = matches[0];
      Logger.log(head + '\n   => PATH: ' + (m.entry || '(direct)') + ' -> agent ' + ext
        + ' [inbound call ' + m.callId + ', caller ' + (m.caller || '?') + '] -> transfer ' + queue + ' (ABANDONED)');
    } else if (matches.length > 1) {
      nAmbig++;
      Logger.log(head + '\n   => AMBIGUOUS: ' + matches.length + ' concurrent inbound calls for ext ' + ext
        + ' -> ' + matches.map(function (m) { return m.callId; }).join(', '));
    } else {
      nMiss++;
      // Deepen: WHY did it miss, and would an ironclad relaxation resolve it?
      var zt = agentBusyZero.filter(function (a) {
        return a.ext === ext && a.callId !== root && inWindow(a, tMs);
      });
      if (zt.length === 1) {
        nRecoverZeroTalk++;
        var z = zt[0];
        Logger.log(head + '\n   => UNRESOLVED (RECOVERABLE -- Talk=0 answered leg): would UNIQUELY map to '
          + (z.entry || '(direct)') + ' inbound call ' + z.callId + ', caller ' + (z.caller || '?')
          + ' -- excluded only by the Talk>0 gate.');
      } else if (zt.length > 1) {
        Logger.log(head + '\n   => UNRESOLVED (Talk=0 legs AMBIGUOUS: ' + zt.length
          + ') -- not recoverable without guessing.');
      } else if (extEverAnswered[ext]) {
        nWindowNear++;
        var gapPos = nearestGapSec(agentBusy, ext, tMs);
        var gapAny = nearestGapSec(agentBusy.concat(agentBusyZero), ext, tMs);
        Logger.log(head + '\n   => UNRESOLVED (time-window near-miss): ext answered a captured inbound, but the abandon sits '
          + (gapPos != null ? gapPos + 's' : '?') + ' past the nearest Talk>0 window'
          + (gapAny != null ? ' (' + gapAny + 's from the nearest answered leg of any talk)' : '')
          + '. Widening the window risks ambiguity -- NOT ironclad.');
      } else {
        nChainOrUncaptured++;
        Logger.log(head + '\n   => UNRESOLVED (no captured inbound for ext ' + ext
          + '): the source call likely reached the agent via an internal transfer (chain) or was itself uncaptured. '
          + 'Needs hop-following -- separate effort.');
      }
    }
  });

  Logger.log('previewInternalTransferPaths(' + iso + '): ' + nCand + ' internal queue-abandon candidate(s) -- '
    + nUnique + ' unique-resolved, ' + nAmbig + ' AMBIGUOUS, ' + nMiss + ' unresolved.');
  if (nMiss) {
    Logger.log('  unresolved breakdown: ' + nRecoverZeroTalk + ' IRONCLAD-recoverable (Talk=0 unique-match), '
      + nWindowNear + ' time-window near-miss (risky to widen), '
      + nChainOrUncaptured + ' chained/uncaptured source (needs hop-following).');
    if (nRecoverZeroTalk > 0) {
      Logger.log('  => Admitting Talk=0 ANSWERED legs (still unique-match-only, no window change) would shrink '
        + 'unresolved from ' + nMiss + ' to ' + (nMiss - nRecoverZeroTalk) + ' with ZERO new ambiguity.');
    }
  }
}

/**
 * READ-ONLY deep-dive for the CHAINED/UNCAPTURED bucket of
 * previewInternalTransferPaths -- the internal queue-abandons where the
 * abandoning agent's extension never DIRECTLY answered a captured inbound
 * (so the base ext-match can't reach it: the caller arrived at that agent via
 * ANOTHER agent or a queue transfer). For each such case it dumps, PHI-masked,
 * HOW the call reached the abandoning agent (every leg that rang that ext,
 * nearest-in-time first: who was on the other end, whether that leg's call was
 * a captured inbound, and the disposition/talk/timing) and attempts a bounded
 * trace: 1-HOP (a single upstream agent who rang X uniquely answered a
 * captured inbound overlapping the abandon), then 2-HOP (when X was reached
 * via a QUEUE ring inside an INTERNAL source group, that queue leg is
 * intra-group routing -- the entrant is the group's own originating ext, so
 * the same overlap check runs on the source group's originators; learned from
 * the first pasted-log review). A chain that stays internal at EVERY hop with
 * no concurrent captured inbound anywhere is classified INTERNAL-ORIGIN: no
 * external caller exists on it, so there is no caller journey to enrich and
 * the base build leaving it alone is correct (corroborated when the source
 * call continued well past the abandon -- it was not holding a departing
 * caller). The tally says how many chained cases each unique trace depth
 * would surface, so a follow-up capture change can be judged against the
 * same 0-ambiguity bar as the base build. Writes nothing; safe to delete.
 *
 * PHI: external caller numbers/names are NEVER printed -- only internal
 * extensions, queue tokens, and timings. CDR Import editor:
 *   previewInternalTransferChains('2026-07-20')   // no arg -> latest sheet
 */
function previewInternalTransferChains(dateIso) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = null, iso = dateIso || '';
  if (dateIso) {
    sheet = ss.getSheetByName('Call_Legs_' + dateIso);
  } else {
    ss.getSheets().forEach(function (s) {
      var m = s.getName().match(/^Call_Legs_(\d{4}-\d{2}-\d{2})$/i);
      if (m && m[1] > iso) { iso = m[1]; sheet = s; }
    });
  }
  if (!sheet) { Logger.log('previewInternalTransferChains: no Call_Legs sheet for ' + (dateIso || '(latest)') + '.'); return; }

  var rows = sheet.getDataRange().getDisplayValues();
  rows.shift();

  // Group by root (Parent if present, else own) -- same stitching as capture.
  var groups = {};
  rows.forEach(function (r) {
    var own = String(r[IC_COL.CALL_ID] || '').trim();
    if (!own) return;
    var parent = String(r[IC_COL.PARENT_CALL_ID] || '').trim();
    var root = (parent && parent.toUpperCase() !== 'N/A') ? parent : own;
    (groups[root] = groups[root] || []).push(r);
  });
  var isIncoming = function (l) { return String(l[IC_COL.DIRECTION] || '').trim() === 'Incoming'; };
  var captured = {};
  Object.keys(groups).forEach(function (root) { captured[root] = groups[root].some(isIncoming); });

  // Classify a caller cell without leaking PHI.
  var callerInfo = function (cell) {
    var raw = String(cell == null ? '' : cell).trim();
    if (icExternalNumber_(raw)) return { kind: 'external', ext: '', show: '(external caller)' };
    if (/queue/i.test(raw)) return { kind: 'queue', ext: icDigits_(raw), show: raw.slice(0, 40) };
    var d = icDigits_(raw);
    if (d && /^\d{2,5}$/.test(d)) return { kind: 'ext', ext: d, show: 'ext ' + d };
    return { kind: 'other', ext: '', show: raw ? raw.slice(0, 24) : '(blank)' };
  };

  // Flatten every leg with parsed fields, for the neighborhood scan.
  var allLegs = [];
  Object.keys(groups).forEach(function (root) {
    groups[root].forEach(function (l) {
      var ci = callerInfo(l[IC_COL.CALLER]);
      allLegs.push({
        root: root, captured: captured[root],
        dir: String(l[IC_COL.DIRECTION] || '').trim(),
        caller: ci,
        calleeExt: icDigits_(l[IC_COL.CALLEE]),
        answered: String(l[IC_COL.ANSWERED] || '').trim() === 'Answered',
        missed: String(l[IC_COL.MISSED] || '').trim() === 'Missed',
        abandoned: String(l[IC_COL.ABANDONED] || '').trim() === 'Abandoned',
        talk: icTimeToSec_(l[IC_COL.TALK]),
        startMs: icParseTs_(l[IC_COL.START]),
        connMs: icParseTs_(l[IC_COL.CONNECTED]),
        stopMs: icParseTs_(l[IC_COL.STOP])
      });
    });
  });

  // ext -> answered a captured inbound (Talk>0): the base build's resolvable set.
  var extAnsweredCaptured = {};
  allLegs.forEach(function (a) {
    if (a.captured && a.answered && a.talk > 0 && a.calleeExt) extAnsweredCaptured[a.calleeExt] = true;
  });

  var nCase = 0, nOneHop = 0, nTwoHop = 0, nInternalOrigin = 0, nViaQueue = 0, nNoSource = 0, nSelfOriginated = 0, nAssistOnOutbound = 0;
  Object.keys(groups).forEach(function (root) {
    if (captured[root]) return;
    var g = groups[root];
    var ab = g.filter(function (l) {
      return String(l[IC_COL.ABANDONED] || '').trim() === 'Abandoned' && icIsQueueName_(l[IC_COL.CALLEE_NAME]);
    })[0];
    if (!ab) return;
    var X = icDigits_(ab[IC_COL.CALLER]);
    var T = icParseTs_(ab[IC_COL.START]);
    if (!X || isNaN(T)) return;
    if (extAnsweredCaptured[X]) return;   // handled by the base build / near-miss bucket, not chained
    nCase++;
    var queue = String(ab[IC_COL.CALLEE_NAME] || '').trim();
    Logger.log('CHAIN CASE ' + nCase + ': ext ' + X + ' -> ' + queue + ' ABANDONED @ '
      + String(ab[IC_COL.START]).trim() + ' (internal group ' + root + ')');

    // (a) Every leg that RANG ext X, nearest to the abandon time first.
    var delivered = allLegs.filter(function (a) { return a.calleeExt === X && !isNaN(a.startMs) && a.root !== root; })
      .sort(function (p, q) { return Math.abs(p.startMs - T) - Math.abs(q.startMs - T); })
      .slice(0, 6);
    if (!delivered.length) {
      Logger.log('   (nothing in this sheet rang ext ' + X + ' -- source call is outside the day / uncaptured)');
    }
    // OWNER NOTE 2026-08-24: on TRANSFERS the raw feed often puts the agent who
    // RECEIVES the call in the CALLER column, with Callee=CallRecording (620)
    // and Callee Name=N/A. Both this scan and the real matcher's agentBusy
    // index key on the CALLEE ext, so that leg shape is invisible to them --
    // which would make "nothing handed X a caller" a statement about evidence
    // never examined rather than about the call. List the CALLER-side legs too,
    // OBSERVATION ONLY: no verdict below reads them until the shape is
    // understood from a real sample.
    var xAsCaller = allLegs.filter(function (a) {
      return a.caller.kind === 'ext' && a.caller.ext === X && !isNaN(a.startMs) && a.root !== root;
    }).sort(function (p2, q2) { return Math.abs(p2.startMs - T) - Math.abs(q2.startMs - T); }).slice(0, 6);
    xAsCaller.forEach(function (a) {
      var spansT = (!isNaN(a.connMs) && !isNaN(a.stopMs) && T >= a.connMs - 5000 && T <= a.stopMs + 5000);
      Logger.log('   -- ext ' + X + ' AS CALLER -> ' + (a.calleeExt || '(no ext)')
        + ' | group ' + a.root + (a.captured ? ' [CAPTURED inbound]' : ' [internal]')
        + ' | ' + a.dir
        + ' | ' + (a.answered ? 'Answered talk=' + a.talk + 's' : (a.missed ? 'Missed' : (a.abandoned ? 'Abandoned' : '-')))
        + ' | ' + (isNaN(a.connMs) ? '--:--:--' : icIsoTime_(a.connMs)) + '..' + (isNaN(a.stopMs) ? '--:--:--' : icIsoTime_(a.stopMs))
        + ' | dT ' + Math.round((a.startMs - T) / 1000) + 's'
        + (spansT ? '  <<< SPANS THE ABANDON' : ''));
    });
    delivered.forEach(function (a) {
      Logger.log('   <- rung by ' + a.caller.show + ' | group ' + a.root
        + (a.captured ? ' [CAPTURED inbound]' : ' [internal]') + ' | ' + a.dir
        + ' | ' + (a.answered ? 'Answered talk=' + a.talk + 's' : (a.missed ? 'Missed' : (a.abandoned ? 'Abandoned' : '-')))
        + ' | ' + (isNaN(a.connMs) ? '--:--:--' : icIsoTime_(a.connMs)) + '..' + (isNaN(a.stopMs) ? '--:--:--' : icIsoTime_(a.stopMs))
        + ' | dT ' + Math.round((a.startMs - T) / 1000) + 's');
    });

    // (b) Bounded 1-HOP trace: did a single upstream AGENT (an ext, not a queue)
    //     who rang X also answer a captured inbound overlapping the abandon?
    //
    // TEMPORAL GUARD (2026-08-24): the hand-off to X must PRECEDE the abandon
    // it supposedly caused -- for the chain to be real, X has to be HOLDING the
    // caller at T. The rule below used to accept ANY leg on which Y rang X,
    // with no time constraint, while checking only that Y was on a captured
    // call at T. Measured on the owner's 2026-08-21 run: the lone chained case
    // reported "1-HOP RESOLVABLE (unique)" off a leg where Y rang X 946s AFTER
    // the abandon -- a temporally impossible chain scored as a clean unique
    // match. Same overlap rule the real R11-N matcher applies to the answering
    // agent, now applied to X's own delivered leg.
    var deliveredAtT = delivered.filter(function (a) {
      return a.answered && a.talk > 0 && !isNaN(a.connMs) && !isNaN(a.stopMs)
        && T >= a.connMs - 5000 && T <= a.stopMs + 5000;
    });
    if (delivered.length && !deliveredAtT.length) {
      Logger.log('   (no delivered leg had ext ' + X + ' on a call AT the abandon time -- '
        + 'the nearest is ' + Math.round((delivered[0].startMs - T) / 1000) + 's away)');
    }
    // VALIDATED 2026-08-21 (owner leg sample): the concurrent call an assisting
    // agent is on can be OUTBOUND -- Marie (279) was on an Outgoing leg to a
    // patient and dialed A_Q_Spanish for translation. agentBusy (and this scan)
    // index the CALLEE ext, so an agent on an outbound call is invisible to
    // both, and the case looks like an unexplained chain. It is not a chain at
    // all: nobody handed them a caller, so no inbound journey exists to enrich.
    // Detected here so the tally names the real shape. (CallRecording legs --
    // caller=agent, callee=CallRecording, talk=0 -- are recording artifacts and
    // are excluded by the talk>0 condition, not evidence of anything.)
    var outboundAtT = null;
    allLegs.forEach(function (a) {
      if (outboundAtT) return;
      if (a.caller.kind !== 'ext' || a.caller.ext !== X) return;
      if (a.dir !== 'Outgoing' || !a.answered || !(a.talk > 0)) return;
      if (isNaN(a.connMs) || isNaN(a.stopMs)) return;
      if (T >= a.connMs - 5000 && T <= a.stopMs + 5000) outboundAtT = a;
    });
    var upstreamAgents = {};
    deliveredAtT.forEach(function (a) { if (a.caller.kind === 'ext' && a.caller.ext) upstreamAgents[a.caller.ext] = true; });
    var overlapRootsFor = function (Y) {
      var hr = {};
      allLegs.forEach(function (a) {
        if (a.captured && a.answered && a.talk > 0 && a.calleeExt === Y
            && !isNaN(a.connMs) && !isNaN(a.stopMs) && T >= a.connMs - 5000 && T <= a.stopMs + 5000) {
          hr[a.root] = Y;
        }
      });
      return hr;
    };
    var hopRoots = {};
    Object.keys(upstreamAgents).forEach(function (Y) {
      var hr = overlapRootsFor(Y);
      Object.keys(hr).forEach(function (r) { hopRoots[r] = hr[r]; });
    });
    // Hop 2 (from the first pasted-log review): when X was reached via a QUEUE
    // ring INSIDE an internal source group, that queue leg is intra-group
    // routing -- the entrant is the group's own originating ext (visible in the
    // same group), not an unknown queue membership. So the SAME captured-
    // overlap check runs on each internal source group's originators too.
    var hop2Agents = {};
    deliveredAtT.forEach(function (a) {
      if (a.captured) return;
      (groups[a.root] || []).forEach(function (l) {
        var ci = callerInfo(l[IC_COL.CALLER]);
        if (ci.kind === 'ext' && ci.ext && ci.ext !== X) hop2Agents[ci.ext] = true;
      });
    });
    var hop2Roots = {};
    Object.keys(hop2Agents).forEach(function (Y) {
      var hr = overlapRootsFor(Y);
      Object.keys(hr).forEach(function (r) { hop2Roots[r] = hr[r]; });
    });
    // Corroboration: an internal source call that kept going well PAST the
    // abandon was not holding a caller who left at the abandon -- the strongest
    // internal-origin tell.
    var continuedSec = null;
    delivered.forEach(function (a) {
      if (a.captured || isNaN(a.connMs) || isNaN(a.stopMs)) return;
      if (a.connMs <= T && a.stopMs >= T) {
        var c = Math.round((a.stopMs - T) / 1000);
        if (continuedSec == null || c > continuedSec) continuedSec = c;
      }
    });
    var roots = Object.keys(hopRoots);
    var roots2 = Object.keys(hop2Roots);
    if (roots.length === 1) {
      nOneHop++;
      Logger.log('   => 1-HOP RESOLVABLE (unique): captured inbound ' + roots[0]
        + ' answered by ext ' + hopRoots[roots[0]] + ' -> transferred to ext ' + X
        + ' -> ' + queue + ' (ABANDONED).');
    } else if (roots.length > 1) {
      Logger.log('   => 1-hop AMBIGUOUS: ' + roots.length + ' upstream captured inbounds -- would not auto-resolve.');
    } else if (roots2.length === 1) {
      nTwoHop++;
      Logger.log('   => 2-HOP RESOLVABLE (unique): captured inbound ' + roots2[0]
        + ' answered by ext ' + hop2Roots[roots2[0]] + ' -> (internal group / queue ring) -> ext ' + X
        + ' -> ' + queue + ' (ABANDONED).');
    } else if (roots2.length > 1) {
      Logger.log('   => 2-hop AMBIGUOUS: ' + roots2.length + ' upstream captured inbounds via the source group\'s originators -- would not auto-resolve.');
    } else if (delivered.length && delivered.every(function (a) { return !a.captured || !(a.connMs <= T && a.stopMs >= T); })
               && Object.keys(hop2Agents).length) {
      nInternalOrigin++;
      Logger.log('   => INTERNAL-ORIGIN: the upstream chain is internal at every hop (originator ext '
        + Object.keys(hop2Agents).join(', ') + ') with no concurrent captured inbound anywhere -- '
        + 'no external caller exists on this chain, so there is NO caller journey to enrich; the base build '
        + 'leaving it alone is CORRECT.'
        + (continuedSec != null && continuedSec > 60
            ? (' Corroboration: the source call continued ' + continuedSec + 's PAST the abandon -- it was not holding a departing caller.')
            : ''));
    } else if (outboundAtT) {
      nAssistOnOutbound++;
      Logger.log('   => ASSIST DURING AN OUTBOUND CALL (not a transfer): ext ' + X
        + ' was on an OUTGOING call to ' + (outboundAtT.calleeExt ? '(external number)' : '(unknown)')
        + ' spanning the abandon (' + icIsoTime_(outboundAtT.connMs) + '..' + icIsoTime_(outboundAtT.stopMs)
        + ', talk ' + outboundAtT.talk + 's) and dialed ' + queue + ' for assistance. Nobody handed them '
        + 'a caller, so there is NO inbound caller journey to enrich -- hop-following cannot fix this '
        + 'shape at any depth. The abandon itself is still captured as an internal-origin record, so '
        + 'the receiving queue keeps its own "path" drill.');
    } else if (delivered.length && !deliveredAtT.length) {
      nSelfOriginated++;
      Logger.log('   => NO INBOUND HAND-OFF AT THE ABANDON TIME: no leg RINGING ext ' + X
        + ' had them on a call at T. That points to a self-originated queue call (nothing '
        + 'upstream to enrich, unfixable by hop-following at any depth) -- BUT read the '
        + '"AS CALLER" lines above before concluding it: on transfers the feed can put the '
        + 'receiving agent in the caller column (Callee=CallRecording), and this scan keys on '
        + 'the callee ext, so a hand-off can be real and simply unseen here.');
    } else if (delivered.some(function (a) { return a.caller.kind === 'queue'; })) {
      nViaQueue++;
      Logger.log('   => reached ext ' + X + ' via a QUEUE ring (not an agent transfer) -- upstream is whoever entered that queue; needs queue-membership tracing, not a 1-hop agent trace.');
    } else if (!delivered.length) {
      nNoSource++;
    } else {
      Logger.log('   => no upstream captured inbound within window -- deeper chain (2+ hops) or the source leg was itself uncaptured.');
    }
  });

  Logger.log('previewInternalTransferChains(' + iso + '): ' + nCase + ' chained/uncaptured case(s) -- '
    + nOneHop + ' resolvable via a UNIQUE 1-hop agent trace, ' + nTwoHop + ' via a unique 2-hop trace, '
    + nInternalOrigin + ' INTERNAL-ORIGIN (no external caller; nothing to enrich), '
    + nViaQueue + ' reached via a queue ring, '
    + nAssistOnOutbound + ' ASSIST-DURING-OUTBOUND (agent was on an outgoing call; not a transfer), '
    + nSelfOriginated + ' with NO inbound hand-off at the abandon time (see the AS CALLER lines), '
    + nNoSource + ' with no source leg in the sheet.');
  Logger.log('  (Paste this whole log back: the "<- rung by" lines show the real link structure so the '
    + 'accurate join for these can be designed against the same 0-ambiguity bar.)');
}

// ── Date-selectable wrappers for the transfer-path diagnostics ──────────────
//
// The Apps Script Run picker can't pass arguments, so the two preview
// diagnostics were latest-sheet-only unless invoked from code. These wrappers
// resolve a target date three ways, in order:
//   1. A UI PROMPT (when run from the spreadsheet's CDR Tools menu — the
//      normal path): type a YYYY-MM-DD, or leave blank for the latest sheet.
//   2. The TRANSFER_PREVIEW_DATE Script Property (editor runs, where getUi()
//      has no context — the DQE_PARITY_FROM pattern; clear it to fall back).
//   3. The latest Call_Legs_* sheet (the diagnostics' own default).
// Output still lands in the execution log / Executions panel either way.

function icPreviewDateArg_() {
  var raw = '';
  try {
    var ui = SpreadsheetApp.getUi();
    var resp = ui.prompt('Preview date',
      'Call_Legs date to analyze (YYYY-MM-DD).\nLeave blank for the most recent sheet.',
      ui.ButtonSet.OK_CANCEL);
    if (resp.getSelectedButton() !== ui.Button.OK) return { cancelled: true };
    raw = String(resp.getResponseText() || '').trim();
  } catch (e) {
    // No UI context (editor run) -> Script Property fallback.
    try {
      raw = String(PropertiesService.getScriptProperties()
        .getProperty('TRANSFER_PREVIEW_DATE') || '').trim();
      if (raw) Logger.log('Using TRANSFER_PREVIEW_DATE=' + raw
        + ' (no UI context; clear the Script Property to use the latest sheet).');
    } catch (pe) { raw = ''; }
  }
  if (!raw) return { dateIso: null };   // latest sheet
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    Logger.log('Invalid date "' + raw + '" — expected YYYY-MM-DD. Aborting.');
    return { cancelled: true };
  }
  return { dateIso: raw };
}

/** Menu/editor wrapper: previewInternalTransferChains for a chosen date. */
function previewInternalTransferChainsForDate() {
  var arg = icPreviewDateArg_();
  if (arg.cancelled) return;
  previewInternalTransferChains(arg.dateIso);
}

/** Menu/editor wrapper: previewInternalTransferPaths for a chosen date. */
function previewInternalTransferPathsForDate() {
  var arg = icPreviewDateArg_();
  if (arg.cancelled) return;
  previewInternalTransferPaths(arg.dateIso);
}

/**
 * READ-ONLY diagnostic for the Step 4 outbound assist link -- the validation
 * run R11-N got before IT shipped, and that the outbound match did not.
 *
 * It does NOT re-implement the matching rule. It runs the REAL
 * `buildInboundCallRecords_` over a Call_Legs_<iso> sheet and reports what
 * capture WOULD store, so the preview cannot drift from production the way a
 * parallel implementation would (the lesson from the chain diagnostic, whose
 * hand-written 1-hop rule "resolved" a temporally impossible chain).
 *
 * Writes nothing. Reads only the sheet -- no Neon -- so it runs during an
 * outage. CDR Import editor: previewOutboundAssistLinks('2026-08-21')
 * (no arg -> the most recent Call_Legs_* sheet).
 *
 * What to look for: every OUTBOUND-linked line names the assist and the call
 * it was linked to. Spot-check a few against the raw legs -- the requester
 * must have been ON that outbound call at the assist time. UNLINKED lines are
 * the honest residue (0 or >1 candidates); they are not failures, they are the
 * unique-match rule declining to guess.
 */
function previewOutboundAssistLinks(dateIso) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = null, iso = dateIso || '';
  if (dateIso) {
    sheet = ss.getSheetByName('Call_Legs_' + dateIso);
  } else {
    ss.getSheets().forEach(function (s) {
      var m = s.getName().match(/^Call_Legs_(\d{4}-\d{2}-\d{2})$/i);
      if (m && m[1] > iso) { iso = m[1]; sheet = s; }
    });
  }
  if (!sheet) {
    Logger.log('previewOutboundAssistLinks: no Call_Legs sheet for %s.', dateIso || '(latest)');
    return;
  }

  var rows = sheet.getDataRange().getDisplayValues();
  rows.shift();
  var records = buildInboundCallRecords_(rows) || [];
  var internal = records.filter(function (r) { return r.isInternal; });

  // A CDR root is a leg TREE, not a call: a warm transfer can put an internal
  // assist and a colleague's external leg under ONE root, so that root is
  // written to inbound_calls (is_internal) AND captured by outbound_calls. The
  // link's temporal claim still holds -- outboundBusy keys on the outgoing
  // leg's own caller ext -- but the id no longer names one thing, so COUNT the
  // overlap on every run instead of eyeballing it (measured 6 of 28 on
  // 2026-08-24, all in the answered population, none among the abandons the
  // drill actually serves).
  var internalIds = {};
  internal.forEach(function (r) { internalIds[r.callId] = r; });

  var nOut = 0, nIn = 0, nNone = 0, shared = [];
  internal.forEach(function (r) {
    var kind = r.relatedCallKind || null;
    var who = (r.originAgent || '(unknown requester)')
      + (r.originDept ? ' [' + r.originDept + ']' : '');
    var head = 'ASSIST ' + r.callId + ' @ ' + (r.callStart || '--:--:--')
      + ' -> ' + (r.entryQueue || '(no queue)')
      + ' (' + (r.disposition || '?') + ', wait ' + (r.waitSeconds == null ? '?' : r.waitSeconds) + 's)'
      + ' | by ' + who;
    if (kind === 'outbound') {
      nOut++;
      var alsoAssist = internalIds[r.relatedCallId];
      if (alsoAssist) shared.push(r);
      Logger.log(head + '\n   => LINKED to OUTBOUND call ' + r.relatedCallId
        + ' -- the requester was on that call at the assist time. '
        + 'Spot-check: the outbound group must show them Answered with talk>0 spanning '
        + (r.callStart || 'the assist') + '.'
        + (alsoAssist
            ? '\n   ** SHARED ROOT: ' + r.relatedCallId + ' is ALSO an assist record in this run'
              + ' (@ ' + (alsoAssist.callStart || '--:--:--')
              + ' by ' + (alsoAssist.originAgent || '(unknown)') + ' -> '
              + (alsoAssist.entryQueue || '(no queue)') + ').'
              + ' One leg tree, two calls -- the link is still leg-backed, but that id'
              + ' names a row in BOTH inbound_calls and outbound_calls.'
            : ''));
    } else if (kind === 'inbound') {
      nIn++;
      Logger.log(head + '\n   => linked to INBOUND call ' + r.relatedCallId
        + ' (a handed-over customer -- the stronger relationship, which always wins).');
    } else {
      nNone++;
      Logger.log(head + '\n   => NOT LINKED (0 or >1 concurrent candidates -- the unique-match '
        + 'rule declining to guess; the receiving queue still gets its own path drill).');
    }
  });

  Logger.log('previewOutboundAssistLinks(%s): %s internal assist record(s) -- '
    + '%s linked to an OUTBOUND call, %s to an inbound call, %s unlinked.',
    iso, internal.length, nOut, nIn, nNone);
  var nAband = internal.filter(function (r) { return r.disposition === 'abandoned'; }).length;
  var nAbandLinked = internal.filter(function (r) {
    return r.disposition === 'abandoned' && r.relatedCallKind;
  }).length;
  Logger.log('  Drill population: %s abandoned (%s of them linked to a requester context). '
    + 'The rest are answered/missed assists no surface drills -- the receiving dept\'s '
    + 'path button hangs off a DQE queue-only ABANDON.', nAband, nAbandLinked);
  Logger.log('  Shared-root overlap: %s of %s OUTBOUND links point at a root that is ALSO an '
    + 'assist record here (one leg tree holding two people\'s calls). Above ~0 this is '
    + 'expected on warm transfers; a rise means more trees are merging.', shared.length, nOut);
  Logger.log('  Nothing was written. Every figure above is what the next import '
    + 'WOULD store for this date (it runs the real record builder).');
}

/** Menu/editor wrapper with the shared date prompt. */
function previewOutboundAssistLinksForDate() {
  var arg = icPreviewDateArg_();
  if (arg.cancelled) return;
  previewOutboundAssistLinks(arg.dateIso);
}

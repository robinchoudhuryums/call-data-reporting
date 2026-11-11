/**
 * Direct-extension call metrics (Phase 1 — compute + persist; NO dashboard UI).
 *
 * Computes per-agent per-day metrics for DIRECT / individual-extension calls
 * (inbound + outbound to/from an employee's own extension), as a population
 * DISTINCT from department call-queue calls (which DQE Historical Data / QCD
 * already cover). The defining feature: an inbound direct call missed BECAUSE
 * the agent was already on another call is split into its own `missed_busy`
 * bucket and EXCLUDED from the answer rate (but counted + surfaced), so a ring
 * they couldn't take while busy doesn't count against them.
 *
 * See docs/direct-extension-metrics-design.md for the owner-approved
 * definitions. Highlights:
 *   - Carve-out is INBOUND-only (you can't miss a call you placed).
 *   - "Busy" = any of the agent's OTHER active legs (queue / direct / outbound)
 *     overlapping the missed ring, where each busy window is extended by a
 *     DIRECT_BUSY_WRAPUP_SEC (=5s) post-call tail; ANY overlap excuses the miss.
 *   - Hold time counts toward the busy window (talk_end = start + talk + hold).
 *   - Answer rate counts ONLY business-hours rings (the 6:30 AM-3:00 PM PST
 *     work window, same as DQE / INV-06). Busy detection itself is NOT
 *     windowed (a pre-window call still in progress makes the agent busy).
 *   - Outbound is ACTIVITY only (placed / connected / talk-time); no pass/fail
 *     rate. Outbound legs DO feed the busy intervals.
 *   - Internal vs. external split on every metric.
 *
 * `computeDirectCallMetrics` is a PURE function (no Apps Script globals) so it
 * is unit-tested in tests/unit/direct-call-metrics.test.js. The editor-run
 * orchestrator `runDirectCallBuild` + the sheet/Neon writers below touch Apps
 * Script services, but only inside their bodies (so the module loads cleanly
 * in the test vm). cdr-import-only -- NOT one of the INV-16 byte-identical
 * duplicated files.
 *
 * Phase 1 is editor-run + numbers-only: run `runDirectCallBuild()` from the
 * cdr-import editor to compute the CURRENT Raw Data day and write the
 * `Direct Call History` sheet + Neon `direct_call_history` mirror for
 * spot-checking. Wiring it into the daily `processIntegratedHistory` is a
 * deliberate Phase-1b follow-up (after the numbers are validated).
 */

// 6:30 AM - 3:00 PM PST in seconds-since-midnight. MIRRORS
// buildDQEHistoricalData.js's DQE_WINDOW_START/END (INV-06) -- keep in sync if
// the pipeline window ever changes. Defined locally so the engine stays a pure,
// self-contained, testable unit (doesn't depend on the DQE build being loaded).
const DIRECT_WINDOW_START = (6 * 60 + 30) * 60;   // 23400
const DIRECT_WINDOW_END   = 15 * 60 * 60;          // 54000
const DIRECT_BUSY_WRAPUP_SEC = 5;                  // post-call grace tail (tunable, Phase 3)

const DIRECT_CALL_HISTORY_SHEET = 'Direct Call History';
const DIRECT_CALL_HISTORY_HEADERS = [
  'Month Year', 'Date', 'Department', 'Agent',
  'IB Int Answered', 'IB Int Missed (free)', 'IB Int Missed (busy)', 'IB Int Talk (s)',
  'IB Ext Answered', 'IB Ext Missed (free)', 'IB Ext Missed (busy)', 'IB Ext Talk (s)',
  'OB Int Total', 'OB Int Connected', 'OB Int Talk (s)',
  'OB Ext Total', 'OB Ext Connected', 'OB Ext Talk (s)',
];

// -- Pure parsing helpers (mirror the cdr pipeline's, kept local) -------------

/** "MM/DD/YYYY HH:MM:SS" -> seconds-since-midnight, or null. (== displayToTimeSec) */
function dcStartSec_(str) {
  if (!str) return null;
  const parts = String(str).trim().split(' ');
  if (parts.length < 2) return null;
  const t = parts[1].split(':');
  if (t.length < 2) return null;
  return (parseInt(t[0], 10) || 0) * 3600
       + (parseInt(t[1], 10) || 0) * 60
       + (parseInt(t[2], 10) || 0);
}

/** "MM/DD/YYYY ..." -> "MM/DD/YYYY", or ''. */
function dcDateStr_(str) {
  if (!str) return '';
  return String(str).trim().split(' ')[0] || '';
}

/** "H:MM:SS" / "M:SS" / number(fraction-of-day) -> seconds. (== timeToDec*86400) */
function dcTimeToSec_(v) {
  if (typeof v === 'number') return Math.round(v * 86400);
  const s = String(v || '').trim();
  if (!s) return 0;
  const p = s.split(':');
  if (p.length < 2) {
    const num = Number(s);
    return isNaN(num) ? 0 : Math.round(num * 86400);
  }
  let h = 0, m = 0, x = 0;
  if (p.length === 3) { h = +p[0]; m = +p[1]; x = +p[2]; }
  else                { m = +p[0]; x = +p[1]; }
  return (h * 3600 + m * 60 + x) | 0;
}

/**
 * Logger.log with %s placeholders filled in JS. Apps Script formats a
 * numeric %s argument as a Java double ("150.0 rows", "talk 182.0s"), so the
 * substitution happens here and Logger.log only ever gets one finished string.
 */
function dcLog_(fmt) {
  const a = arguments;
  let i = 1;
  Logger.log(String(fmt).replace(/%s/g, function () { return i < a.length ? String(a[i++]) : '%s'; }));
}

/** Loose phone check (== isValidPhone). */
function dcIsPhone_(v) {
  if (typeof v === 'number') return true;
  if (!v) return false;
  const s = String(v).replace(/[+,\-() ]/g, '').trim();
  return s !== '' && !isNaN(Number(s));
}

function dcClean_(v) { return String(v == null ? '' : v).trim(); }

/** D2: the sum of an object's numeric values (per-leg talk of one call). */
function dcSumValues_(o) {
  let t = 0;
  Object.keys(o || {}).forEach(function (k) { t += Number(o[k]) || 0; });
  return t;
}

/**
 * D2 (owner 2026-10-21): internal vs external for an OUTBOUND direct call.
 * Internal: the CDR logged the leg Internal, the callee is on the roster, or
 * the callee is EXTENSION-length (1-6 digits -- a room phone, an unrostered
 * staff line: still the company's own phone system). External: a phone
 * number (7+ digits) or anything else.
 */
function dcOutboundSide_(dir, callee, extToAgent) {
  if (dir === 'Internal') return 'int';
  if (extToAgent && extToAgent[callee]) return 'int';
  const d = String(callee == null ? '' : callee).replace(/\D/g, '');
  return (d.length > 0 && d.length < 7 && d === String(callee).trim()) ? 'int' : 'ext';
}

/**
 * DC-D2b (owner 2026-10-22): is an INTERNAL-direction leg a coworker DIAL?
 * Only when it reaches an EXTENSION (1-6 digits, the callee cell nothing but
 * digits) and is not a forked ring of another call. The live CDR logs a
 * Call Recording leg (callee "CallRecording" / "CallRecording (595)") for
 * nearly every call, plus Voicemail boxes and CallForking legs, all as
 * Internal -- the first D2 build counted every one as the caller's outbound
 * call (2026-10-20: 3694 legs, 90% of the day's outbound; 92.5% of them
 * recording legs, 1.1% with talk).
 */
function dcIsInternalDial_(callee, ctx) {
  return /^\d{1,6}$/.test(String(callee == null ? '' : callee).trim()) && !/CallForking/i.test(String(ctx || ''));
}

// -- The engine (PURE) --------------------------------------------------------

/**
 * @param rawDisplayData 2D array incl. a header row at index 0 (Raw Data
 *        getDisplayValues, sliced to MAX_COLS).
 * @param maps { extToAgent: { ext -> {name, dept} }, queueExtSet: Set,
 *               exclusions: Set } -- the roster extension map (from
 *        DO NOT EDIT!), the queue-extension set, and the exclusion set.
 * @param opts { windowStartSec, windowEndSec, wrapupSec } (all optional).
 * @returns { rows: [ {agent, dept, ...18 metric fields} ],
 *            meta: { agents, droppedNoStart, missedBusyTotal, missedFreeTotal } }
 */
// ── DCA-1 (owner 2026-10-27): attribution by extension AND name ─────────────
// Former employees stay on DO NOT EDIT! (long-term data) with their old
// extension, and 8x8 reassigns extensions -- so an extension alone credited
// a new hire's direct calls to the person who left. Every leg carries the
// name 8x8 has for each side (CALLER_NAME / CALLEE_NAME); the build now
// credits the roster cell on that extension whose name MATCHES it (through
// the DQE canonicalizer, so nickname variants and alias overrides still
// match), and NO ONE when it names somebody else. A blank or non-person
// name (N/A, a queue, voicemail, a number) is credited by extension only when
// that extension showed its roster person's OWN name on another leg the same
// day (DCA-2, owner 2026-11-04: "should match with name also"); otherwise to
// no one. diagnoseDirectCallAttribution logs both (Operator State #83).
// DCA-3 (owner 2026-11-05): when 8x8 names a roster person the extension's
// cell does not list -- a reassigned extension, or one no cell lists yet --
// the call is THAT person's (kind 'named' / 'namedUnlisted'), and a blank leg
// on an extension that named exactly one person that day follows them.
// DCA-4: every word below is matched WHOLE ("Parker" is a person, not call
// park), and a name the roster knows is a person whatever it contains.
const DC_NON_PERSON_RE_ = /^(n\/?a|none|unknown|anonymous|restricted|private)$|voice ?mail|\brecording\b|\bpark(ed|ing)?\b|call ?park|\battendant\b|\bivr\b|\bmenu\b|\bqueue\b|\bhunt\b|ring ?group|\bconference\b|\bfax\b|\bpaging\b|\bintercom\b|\boperator\b|A_Q_|Backup CSR/i;
// DCA-5 (owner 2026-11-05): a person on BOTH of these rosters is credited to
// the second -- the Spanish agents' direct calls go to their CSR row.
const DC_DEPT_PREFER_ = { 'Spanish': 'CSR' };

// DCA-6 (owner 2026-11-11): a person 8x8 names on a ROSTER extension who is on
// NO roster -- the new hire on a former employee's extension -- is credited to
// no one (DCA-1), and until now that showed only in the execution log. The
// dashboard's orphan check reads DQE Historical Data, which holds QUEUE calls
// only, so someone who takes no queue calls was never listed or nagged about.
// Each Direct build now names them at the END of its Pipeline Health notes:
//   ' | unrostered=[["<name 8x8 shows>","<ext>","<roster name on that ext>",<calls>], ...]'
// DCA-7 (owner 2026-11-11): the same list also carries a person on an
// extension NO roster cell lists (a new hire given a new extension), with an
// EMPTY third element. That set includes every colleague the roster does not
// track, so the dashboard keeps an ignore list for them; here the two kinds
// are capped apart, so untracked staff can never crowd out a former
// employee's extension.
// The dashboard (OrphanFix.gs::orphanDirectFromHealthRows_) parses exactly
// this tail; `orphan-direct-line.test.js` drives the real writer into the real
// reader and keeps the tag equal on both sides. Busiest first, capped, names
// clipped -- a note is one sheet cell.
var DC_UNROSTERED_TAG_ = 'unrostered=';
var DC_UNROSTERED_MAX_ = 20;
var DC_UNLISTED_MAX_ = 100;
var DC_UNLISTED_CUT_MARK_ = '+';   // the dashboard's ORPHAN_DIRECT_CUT_MARK_
/** PURE. The note tail for a build's meta ('' when 8x8 named nobody off-roster). */
function dcUnrosteredNote_(meta) {
  const at = meta && meta.attribution;
  const rows = [];
  const take = function (list, cap, was) {
    let n = 0;
    for (let i = 0; i < (list || []).length && n < cap; i++) {
      const m = list[i];
      if (!m || !m.legName || !m.ext) continue;
      rows.push([String(m.legName).slice(0, 80), String(m.ext), was ? String(m.rosterName || '').slice(0, 80) : '', Number(m.n) || 0]);
      n++;
    }
  };
  take(at && at.mismatches, DC_UNROSTERED_MAX_, true);
  const before = rows.length;
  take(at && at.unlisted, DC_UNLISTED_MAX_, false);
  // A cut is said, never silent: the dashboard shows "N more were left off".
  const usable = ((at && at.unlisted) || []).filter(function (m) { return m && m.legName && m.ext; }).length;
  const cut = usable - (rows.length - before);
  if (cut > 0) rows.push([DC_UNLISTED_CUT_MARK_, '', '', cut]);
  return rows.length ? ' | ' + DC_UNROSTERED_TAG_ + JSON.stringify(rows) : '';
}

/** PURE. The leg's name as a PERSON name, or '' for blank / a label / a number. */
function dcPersonName_(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s || /\d/.test(s) || DC_NON_PERSON_RE_.test(s)) return '';
  return s;
}

/**
 * PURE. name -> every roster cell { name, dept } with that name, in roster
 * order: maps.nameCells when the map builder supplied it, else derived from
 * the extension maps (the unit fixtures). Memoized on the maps object.
 */
function dcNameIndex_(maps) {
  if (!maps) return {};
  if (maps.__dcNameIdx) return maps.__dcNameIdx;
  let idx = maps.nameCells;
  if (!idx) {
    idx = {};
    const add = function (c) {
      if (!c || !c.name) return;
      const l = idx[c.name] || (idx[c.name] = []);
      if (!l.some(function (x) { return x.dept === c.dept; })) l.push({ name: c.name, dept: c.dept });
    };
    const ec = maps.extCands || {};
    Object.keys(ec).forEach(function (e) { ec[e].forEach(add); });
    const ea = maps.extToAgent || {};
    Object.keys(ea).forEach(function (e) { add(ea[e]); });
  }
  try { Object.defineProperty(maps, '__dcNameIdx', { value: idx, enumerable: false, configurable: true }); } catch (e) { /* frozen maps: recompute */ }
  return idx;
}

/** PURE. DCA-5: the cell a person's calls are credited to (DC_DEPT_PREFER_). */
function dcPreferCell_(agent, maps) {
  if (!agent) return agent;
  const want = DC_DEPT_PREFER_[agent.dept];
  if (!want) return agent;
  const cells = dcNameIndex_(maps)[agent.name] || [];
  for (let i = 0; i < cells.length; i++) if (cells[i].dept === want) return cells[i];
  return agent;
}

/** PURE. DCA-5: one roster cell for a name, or null when the roster has none. */
function dcCellForName_(name, maps) {
  const cells = dcNameIndex_(maps)[name];
  return (cells && cells.length) ? dcPreferCell_(cells[0], maps) : null;
}

/**
 * PURE. Who a leg's extension belongs to on THIS leg: { agent, kind, name }.
 *   kind 'none'     -- no roster cell has the extension (and 8x8 names nobody on the roster)
 *   'blank'         -- no person name on the leg: the extension-only agent (DCA-2 confirms it)
 *   'match'         -- the name is the extension's usual agent
 *   'otherCell'     -- the name is ANOTHER roster cell listing the same extension
 *   'named'         -- DCA-3: the name is a roster person whose cell does not list the extension
 *   'namedUnlisted' -- DCA-3: the same, on an extension no roster cell lists
 *   'mismatch'      -- the name is nobody on the roster: agent null (credited to no one)
 * Every agent returned goes through dcPreferCell_ (DCA-5).
 */
function dcResolveAgent_(ext, legName, maps) {
  const extToAgent = (maps && maps.extToAgent) || {};
  const base = extToAgent[ext];
  const canon = (maps && typeof maps.canon === 'function') ? maps.canon : function (n) { return n; };
  const canonOf = function (n) { try { return canon(n) || n; } catch (e) { return n; } };
  const idx = dcNameIndex_(maps);
  const raw = String(legName == null ? '' : legName).trim();
  let nm = dcPersonName_(raw);
  if (!nm && raw && idx[canonOf(raw)]) nm = raw;   // DCA-4: a roster name is a person
  if (!base) {
    // DCA-3: an extension no cell lists, named for a roster person -- only an
    // extension-length number (never an outside number or a queue).
    const d = String(ext == null ? '' : ext);
    if (nm && /^\d{1,6}$/.test(d) && !((maps && maps.queueExtSet) || new Set()).has(d)) {
      const cell = dcCellForName_(canonOf(nm), maps);
      if (cell) return { agent: cell, kind: 'namedUnlisted', name: nm };
      // DCA-7: a PERSON on an extension no roster cell lists, who is on no
      // roster either. Credit is unchanged (no one) -- the name is only
      // carried so the build can tell the dashboard's orphan check about it.
      return { agent: null, kind: 'none', name: '', unlistedName: nm };
    }
    return { agent: null, kind: 'none', name: '' };
  }
  if (!nm) return { agent: dcPreferCell_(base, maps), kind: 'blank', name: '', base: base };
  const c = canonOf(nm);
  if (base.name === c) return { agent: dcPreferCell_(base, maps), kind: 'match', name: nm };
  const cands = (maps && maps.extCands && maps.extCands[ext]) || [];
  for (let i = 0; i < cands.length; i++) {
    if (cands[i].name === c) return { agent: dcPreferCell_(cands[i], maps), kind: 'otherCell', name: nm };
  }
  const cell = dcCellForName_(c, maps);
  if (cell) return { agent: cell, kind: 'named', name: nm, credited: base };
  return { agent: null, kind: 'mismatch', name: nm, credited: base };
}

/**
 * PURE. ADT-2 (owner 2026-11-06): who a call the agent was ON was with, from
 * their side ('caller' | 'callee'): the colleague's roster name, "a queue
 * call", "an outside number" (they dialed out), "an outside caller" (an
 * outside party rang them) or "another call". Never a number.
 */
function dcBusyWithLabel_(mySide, otherAgent, otherRaw, queueCall, exclusions) {
  if (otherAgent && otherAgent.name && !(exclusions && exclusions.has(otherAgent.name))) return otherAgent.name;
  if (queueCall) return 'a queue call';
  const d = String(otherRaw == null ? '' : otherRaw).replace(/\D/g, '');
  if (d.length >= 7) return mySide === 'caller' ? 'an outside number' : 'an outside caller';
  return 'another call';
}

function computeDirectCallMetrics(rawDisplayData, maps, opts) {
  opts = opts || {};
  const W0   = opts.windowStartSec != null ? opts.windowStartSec : DIRECT_WINDOW_START;
  const W1   = opts.windowEndSec   != null ? opts.windowEndSec   : DIRECT_WINDOW_END;
  const TAIL = opts.wrapupSec      != null ? opts.wrapupSec      : DIRECT_BUSY_WRAPUP_SEC;
  const extToAgent = (maps && maps.extToAgent) || {};
  const exclusions = (maps && maps.exclusions) || new Set();
  const queueExtSet = (maps && maps.queueExtSet) || new Set();

  // Column indices (== the autoImport `idx` + DQE_C layout).
  const C = { CALL_ID: 0, PARENT: 14, START: 2, CONNECTED: 3, STOP: 4, DIR: 5, TALK: 6, CALLTIME: 7,
              CALLER: 8, CALLER_NAME: 9, CALLEE: 10, CALLEE_NAME: 11, CTX: 13,
              CALLER_ID: 22, MIS: 23, ANS: 25 };
  const qIdRe = /(A_Q_\w+|Backup CSR)/i;   // DQE queue-name convention (col W / names)

  // A leg "touches a queue" if any of the queue signals fire: the DQE
  // queue-name marker (CALLER_ID col W, or the caller/callee NAME), a
  // CallQueue context, or a queue EXTENSION on either side (e.g. 103). This is
  // broader than the old context-only check, which missed (a) a queue ring leg
  // whose caller is the queue ext (103 -> agent, logged as a fake direct
  // inbound) and (b) the agent's "Outgoing" talk leg of an answered queue call
  // (agent -> external, logged as a fake direct outbound) whose queue identity
  // lives on a SIBLING leg (Leg 1: -> 103 / A_Q_CSR).
  function legTouchesQueue(caller, callee, callerName, calleeName, ctx, callerId) {
    if (qIdRe.test(callerId)) return true;
    if (/CallQueue/i.test(ctx)) return true;
    if (queueExtSet.has(caller) || queueExtSet.has(callee)) return true;
    if (qIdRe.test(callerName) || qIdRe.test(calleeName)) return true;
    return false;
  }
  function realParent(p) { return (p && p.toUpperCase() !== 'N/A') ? p : ''; }

  // PASS A: flag every call (by call id AND parent-call id) that has ANY
  // queue-touching leg, so the WHOLE call is excluded from the direct buckets
  // -- a queue call's legs span both directions and must never count as
  // direct inbound/outbound for the answering agent.
  const queueCallIds = new Set();
  for (let qi = 1; qi < rawDisplayData.length; qi++) {
    const q = rawDisplayData[qi];
    if (!q) continue;
    if (legTouchesQueue(dcClean_(q[C.CALLER]), dcClean_(q[C.CALLEE]),
        dcClean_(q[C.CALLER_NAME]), dcClean_(q[C.CALLEE_NAME]),
        String(q[C.CTX] || ''), String(q[C.CALLER_ID] || ''))) {
      const qcid = dcClean_(q[C.CALL_ID]);
      const qpar = realParent(dcClean_(q[C.PARENT]));
      if (qcid) queueCallIds.add(qcid);
      if (qpar) queueCallIds.add(qpar);
    }
  }
  function isQueueCall(cid, parent) {
    return queueCallIds.has(cid) || (parent && queueCallIds.has(parent));
  }
  // PC-4 (broad-scan 2026-10-01): a call group with ANY Incoming leg is an
  // INBOUND call -- outboundCalls.js's rule ("a leg group is outbound when it
  // has NO Incoming leg"), because an answered inbound call carries the
  // agent's own Outgoing talk leg (S2C-1 measured 3.8% of answered calls with
  // the agent ONLY on that leg). PASS A guarded this for queue calls only, so
  // on a NON-queue direct call that leg became a fake connected outbound and
  // its talk counted twice. Same id discipline as queueCallIds (cid + parent).
  // CAP-1 (broad-scan 2026-11-09): "Incoming" here means a caller CALLING IN
  // -- the captures' NX-2 test (icIsCallerIncoming_), never a bare Direction
  // check. 8x8 marks its CallRecording leg Incoming on OUTBOUND calls too, so
  // the bare test filed such a call as inbound: the agent's Outgoing leg took
  // the "own talk on an inbound call" branch below, no inbound event existed
  // to credit, and the call vanished from Direct altogether (~26 a day,
  // Operator State #87). The typeof guard is for suites that load this file
  // without inboundCalls.js; lint:gas proves the name exists in the project.
  const callerIncoming = (typeof icIsCallerIncoming_ === 'function')
    ? icIsCallerIncoming_
    : function (leg) { return String(leg[C.DIR] || '') === 'Incoming'; };
  const incomingCallIds = new Set();
  for (let ii = 1; ii < rawDisplayData.length; ii++) {
    const q = rawDisplayData[ii];
    if (!q || !callerIncoming(q)) continue;
    const icid = dcClean_(q[C.CALL_ID]);
    const ipar = realParent(dcClean_(q[C.PARENT]));
    if (icid) incomingCallIds.add(icid);
    if (ipar) incomingCallIds.add(ipar);
  }
  function isIncomingCall(cid, parent) {
    return incomingCallIds.has(cid) || (parent && incomingCallIds.has(parent));
  }
  // agent name -> cid -> the talk seconds of their OWN Outgoing leg on an
  // inbound call; credited to that call's inbound event after the scan.
  const ownTalkOnInbound = {};

  // D0 (owner 2026-10-21): opt-in DIAGNOSE mode -- READ-ONLY counters of the
  // shapes the build may be counting wrong, gathered on the SAME pass and the
  // SAME queue / inbound tests as the counts (never a hand-copied rule set).
  // Off unless opts.diagnose; with it off nothing below runs and the rows are
  // byte-identical. maps.allExtToAgent (every roster extension, not only the
  // first) feeds the second-extension counters.
  // Since D2 the counters say what the D2 rules count DIFFERENTLY from the
  // pre-D2 build on this day -- i.e. how much re-importing the date changes.
  const diagOn = !!opts.diagnose;
  const firstExt = (maps && maps.firstExtToAgent) || null;   // the pre-D2 (first-extension) map
  const DG = { internalDial: {}, secondExtIn: {}, secondExtOut: {}, anonymousIn: {}, unrosteredOut: {} };
  function dgAdd(kind, name, cid) {
    const k = DG[kind][name] || (DG[kind][name] = {});
    if (cid) k[cid] = true;
  }
  function dgDigits(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }
  // What EVERY Internal leg from an agent reaches -- the dials the build
  // counts (dcIsInternalDial_) and the legs it does not (recording /
  // voicemail / forking / a named feature) -- so the rule stays checkable.
  const DGI = { seen: {}, legs: 0, dials: 0, rosterAgent: 0, self: 0, unrosteredExt: 0, outsideNumber: 0, other: 0, talked: 0, callee: {}, ctx: {} };
  function dgiAdd(cid, callerAgent, calleeAgent, callee, calleeName, ctx, talk) {
    // One tally per LEG, not per call id: the live CDR writes a call's
    // CallRecording row under the SAME call id as the call it records, so a
    // per-id tally kept whichever row came first and lost the dial behind it
    // (2026-10-20: 60 dials shown here vs 282 counted).
    const key = cid + '|' + String(callee == null ? '' : callee).trim() + '|' + String(ctx || '').trim();
    if (!cid || DGI.seen[key]) return;
    DGI.seen[key] = true;
    DGI.legs++;
    if (dcIsInternalDial_(callee, ctx)) DGI.dials++;
    const d = dgDigits(callee);
    if (calleeAgent && calleeAgent.name === callerAgent.name) DGI.self++;
    else if (calleeAgent) DGI.rosterAgent++;
    else if (d && d === String(callee).trim() && d.length < 7) DGI.unrosteredExt++;
    else if (d.length >= 7) DGI.outsideNumber++;
    else DGI.other++;
    if (talk > 0) DGI.talked++;
    // Rostered callees are named by kind only (agent names stay out of a
    // tally that is about the OTHER callees); numbers are masked (F-26) and
    // an outside number's name is dropped (it can be a customer's).
    const label = calleeAgent ? (calleeAgent.name === callerAgent.name ? '(own extension)' : '(a roster agent)')
      : (dcMaskPhone_(callee) || '(blank)') + (calleeName && d.length < 7 ? ' "' + dcMaskPhonesInText_(calleeName) + '"' : '');
    DGI.callee[label] = (DGI.callee[label] || 0) + 1;
    const c = String(ctx || '').trim() || '(blank)';
    DGI.ctx[c] = (DGI.ctx[c] || 0) + 1;
  }

  // agent -> { dept, occ:[{cid,s,e}], ib:{cid->ev}, ob:{cid->ev} }
  const A = {};
  function ensure(name, dept) {
    if (!A[name]) A[name] = { dept: dept || '', occ: [], ib: {}, ob: {} };
    else if (!A[name].dept && dept) A[name].dept = dept;
    return A[name];
  }

  let droppedNoStart = 0;

  // DCA-1: one tally per leg side (call id + side + extension), never a number.
  const extOnly = !!opts.extOnly;
  const AT = { seen: {}, match: 0, blank: 0, otherCell: 0, mismatch: 0, blankUnconfirmed: 0, mismatches: {}, moved: {}, blankExt: {},
               blankUnconfirmedBy: {}, named: 0, namedUnlisted: 0, blankNamed: 0, reassigned: {}, unlisted: {} };
  // DCA-2 (owner 2026-11-04, "should match with name also"): a BLANK-name
  // leg is credited by extension only when that extension showed its roster
  // person's OWN name on some leg the SAME day -- proof they still use it.
  // A former employee's extension, now someone else's, shows the new name
  // (or none), so its blank legs are credited to no one (kind
  // 'blankUnconfirmed'). One pre-pass over the day's legs, both sides.
  const ownerSeen = {};
  if (!extOnly) {
    for (let oi = 1; oi < rawDisplayData.length; oi++) {
      const q = rawDisplayData[oi];
      if (!q) continue;
      [[q[C.CALLER], q[C.CALLER_NAME]], [q[C.CALLEE], q[C.CALLEE_NAME]]].forEach(function (side) {
        const ext = dcClean_(side[0]);
        if (!ext) return;
        const res = dcResolveAgent_(ext, side[1], maps);
        if (res.agent && res.kind !== 'blank') {
          const o = ownerSeen[ext] || (ownerSeen[ext] = {});
          o[res.agent.name] = res.agent;
        }
      });
    }
  }
  // DCA-3: a blank leg on an extension that named exactly ONE roster person
  // that day -- not its own cell's -- is that person's ('blankNamed').
  function confirmBlank(ext, res) {
    if (!res || res.kind !== 'blank' || !res.agent) return res;
    const seen = ownerSeen[ext] || {};
    if (seen[res.agent.name]) return res;
    const names = Object.keys(seen);
    if (names.length === 1) return { agent: seen[names[0]], kind: 'blankNamed', name: '', credited: res.base || res.agent };
    return { agent: null, kind: 'blankUnconfirmed', name: '', credited: res.base || res.agent };
  }
  function atNote(cid, side, ext, res) {
    if (res && res.kind === 'none' && res.unlistedName) {   // DCA-7: tallied apart, one per leg side like the rest
      if (exclusions.has(res.unlistedName)) return;
      const uk = 'u|' + cid + '|' + side + '|' + ext;
      if (AT.seen[uk]) return;
      AT.seen[uk] = true;
      const ue = AT.unlisted[ext + '|' + res.unlistedName] || (AT.unlisted[ext + '|' + res.unlistedName] = { ext: ext, legName: res.unlistedName, n: 0 });
      ue.n++;
      return;
    }
    if (!res || res.kind === 'none') return;
    const key = cid + '|' + side + '|' + ext;
    if (AT.seen[key]) return;
    AT.seen[key] = true;
    AT[res.kind]++;
    if (res.kind === 'blank') AT.blankExt[ext] = (AT.blankExt[ext] || 0) + 1;
    if (res.kind === 'blankUnconfirmed') {
      const bk = ext + '|' + res.credited.name;
      const be = AT.blankUnconfirmedBy[bk] || (AT.blankUnconfirmedBy[bk] = { ext: ext, rosterName: res.credited.name, n: 0, samples: [] });
      be.n++;
      if (be.samples.length < 5 && be.samples.indexOf(cid) === -1) be.samples.push(cid);
    }
    if (res.kind === 'mismatch' || res.kind === 'otherCell' || res.kind === 'named' || res.kind === 'namedUnlisted' || res.kind === 'blankNamed') {
      const bucket = res.kind === 'mismatch' ? AT.mismatches : (res.kind === 'otherCell' ? AT.moved : AT.reassigned);
      const from = res.credited ? res.credited.name : (res.kind === 'namedUnlisted' ? '' : (extToAgent[ext] ? extToAgent[ext].name : ''));
      const legName = res.kind === 'blankNamed' ? '(no name)' : res.name;
      const k = ext + '|' + from + '|' + legName + '|' + (res.agent ? res.agent.name : '');
      const e = bucket[k] || (bucket[k] = { ext: ext, rosterName: from, legName: legName,
        to: res.agent ? res.agent.name : null, n: 0, samples: [] });
      e.n++;
      if (e.samples.length < 5 && e.samples.indexOf(cid) === -1) e.samples.push(cid);
    }
  }

  for (let i = 1; i < rawDisplayData.length; i++) {
    const r = rawDisplayData[i];
    if (!r) continue;
    const cid     = dcClean_(r[C.CALL_ID]);
    const parent  = realParent(dcClean_(r[C.PARENT]));
    const caller  = dcClean_(r[C.CALLER]);
    const callee  = dcClean_(r[C.CALLEE]);
    const dir     = String(r[C.DIR] || '');
    const talk    = dcTimeToSec_(r[C.TALK]);
    const hold    = Math.max(0, dcTimeToSec_(r[C.CALLTIME]) - talk);
    const startSec = dcStartSec_(r[C.START]);
    const missed   = String(r[C.MIS]) === 'Missed';
    const answered = String(r[C.ANS]) === 'Answered';

    // DCA-1: the extension's roster agent only when the leg's own name for
    // that side agrees (opts.extOnly = the pre-DCA-1 rule, for the diagnostic).
    const callerRes = extOnly ? { agent: extToAgent[caller] || null, kind: 'blank' } : confirmBlank(caller, dcResolveAgent_(caller, r[C.CALLER_NAME], maps));
    const calleeRes = extOnly ? { agent: extToAgent[callee] || null, kind: 'blank' } : confirmBlank(callee, dcResolveAgent_(callee, r[C.CALLEE_NAME], maps));
    if (!extOnly) { atNote(cid, 'caller', caller, callerRes); atNote(cid, 'callee', callee, calleeRes); }
    const callerAgent = callerRes.agent || undefined;
    const calleeAgent = calleeRes.agent || undefined;

    // (1) OCCUPIED intervals -- any leg the agent was ON (talk>0), INCLUDING
    //     queue legs. Not window-filtered: a pre-window call still in progress
    //     makes them busy for an in-window ring. Self-exclusion is by cid.
    //     S2C-5 (owner ruling 2026-09-28): busy runs from ANSWER, not from the
    //     leg's ring start -- the design's `[answer_start, talk_end]`. A leg
    //     that rang 30 s before it was picked up used to make the agent "busy"
    //     for those 30 s, excusing a genuine direct miss as missed_busy. The
    //     window is [CONNECTED, STOP] when both parse (the same Raw Data layout
    //     the inbound capture reads, IC_COL.CONNECTED / STOP); otherwise the
    //     pre-S2C-5 [START, START + talk + hold] stands, so a grid without
    //     those cells behaves exactly as before.
    if (startSec != null && talk > 0) {
      const connSec = dcStartSec_(r[C.CONNECTED]);
      const stopSec = dcStartSec_(r[C.STOP]);
      const busyS = (connSec != null && connSec >= startSec) ? connSec : startSec;
      const busyE = (stopSec != null && stopSec >= busyS) ? stopSec : startSec + talk + hold;
      const occ = { cid: cid, s: busyS, e: busyE, info: dir + ' ' + caller + '->' + callee };
      // ADT-2 (owner 2026-11-06): who this call was WITH, per side, so a
      // direct ring missed during it can say so -- a colleague by roster name,
      // never a number (dcBusyWithLabel_).
      const qc = isQueueCall(cid, parent);
      if (callerAgent && !exclusions.has(callerAgent.name)) {
        ensure(callerAgent.name, callerAgent.dept).occ.push(Object.assign({}, occ,
          { w: dcBusyWithLabel_('caller', calleeAgent, callee, qc, exclusions) }));
      }
      if (calleeAgent && !exclusions.has(calleeAgent.name)) {
        ensure(calleeAgent.name, calleeAgent.dept).occ.push(Object.assign({}, occ,
          { w: dcBusyWithLabel_('callee', callerAgent, caller, qc, exclusions) }));
      }
    }

    // The WHOLE call belongs to the queue (DQE/QCD) path, not "direct" -- skip
    // every leg of it (occupied was already recorded above, so a queue call
    // the agent answered still makes them busy for a direct miss).
    if (isQueueCall(cid, parent)) continue;

    // D0: counted on the same non-queue legs the buckets below see, in the
    // same work window the rows use.
    if (diagOn && inWindow(startSec)) {
      // a coworker dial logged Internal: D2 credits it to the CALLER as an
      // internal outbound call (pre-D2: only the callee's ib_int saw it).
      if (dir === 'Internal' && callerAgent && !exclusions.has(callerAgent.name) && !isIncomingCall(cid, parent)) {
        if (dcIsInternalDial_(callee, r[C.CTX])) dgAdd('internalDial', callerAgent.name, cid);
        dgiAdd(cid, callerAgent, calleeAgent, callee, dcClean_(r[C.CALLEE_NAME]), r[C.CTX], talk);
      }
      // a roster agent's SECOND (or later) extension: counted since D2.
      if (firstExt) {
        if (calleeAgent && !firstExt[callee] && !exclusions.has(calleeAgent.name)
            && (dir === 'Incoming' || dir === 'Internal')) dgAdd('secondExtIn', calleeAgent.name, cid);
        if (callerAgent && !firstExt[caller] && !exclusions.has(callerAgent.name)
            && (dir === 'Outgoing' || dir === 'Internal') && !isIncomingCall(cid, parent)) dgAdd('secondExtOut', callerAgent.name, cid);
      }
      // an inbound direct ring from an anonymous / blank caller: kept since D2.
      if (calleeAgent && !exclusions.has(calleeAgent.name) && dir === 'Incoming' && !dcIsPhone_(caller)) dgAdd('anonymousIn', calleeAgent.name, cid);
      // a dial to a short (extension-length) number NOT on the roster:
      // INTERNAL since D2 (pre-D2: external).
      const cd = dgDigits(callee);
      if (callerAgent && !exclusions.has(callerAgent.name) && dir === 'Outgoing' && !isIncomingCall(cid, parent)
          && !extToAgent[callee] && cd.length > 0 && cd.length < 7) dgAdd('unrosteredOut', callerAgent.name, cid);
    }

    // (2) INBOUND DIRECT events -- agent is the callee; the caller is NOT a
    //     queue distributor; Incoming (external) or Internal (a coworker's
    //     extension). D2 (owner 2026-10-21): ONE event per ROOT call (parent,
    //     else the leg's own id) -- two legs of one call to the agent (a
    //     re-ring, a transfer back) are one call, their talk added per leg;
    //     and an Incoming ring from an ANONYMOUS / blank caller is kept
    //     (external) -- it used to be dropped as "not a phone".
    const root = parent || cid;
    const ibCaller = dir === 'Internal' ? dcIsPhone_(caller)
      : (dir === 'Incoming' && (dcIsPhone_(caller) || !qIdRe.test(caller)));
    if (calleeAgent && !exclusions.has(calleeAgent.name) && ibCaller && !queueExtSet.has(caller)) {
      const b = ensure(calleeAgent.name, calleeAgent.dept);
      let ev = b.ib[root];
      if (!ev) { ev = b.ib[root] = { intExt: dir === 'Internal' ? 'int' : 'ext', start: startSec, ringEnd: null, rings: [], answered: false, talk: 0, legTalk: {}, legs: {}, caller: caller, callee: callee, root: root, firstCid: cid, otherName: dcClean_(r[C.CALLER_NAME]), otherAgent: extOnly ? undefined : (callerRes.agent || null) }; }
      ev.legs[cid] = true;
      if (startSec != null && (ev.start == null || startSec < ev.start)) ev.start = startSec;
      const ringEnd = (startSec != null) ? startSec + Math.max(0, dcTimeToSec_(r[C.CALLTIME])) : null;
      if (ringEnd != null && (ev.ringEnd == null || ringEnd > ev.ringEnd)) ev.ringEnd = ringEnd;
      if (startSec != null) ev.rings.push({ s: startSec, e: ringEnd != null ? ringEnd : startSec });   // CAP-4
      // PC-4: "Answered" needs talk, as in the inbound capture's Talk>0 gate --
      // a zero-talk Answered leg counted as answered and dragged ATT down.
      if (answered && talk > 0) {
        ev.answered = true;
        ev.legTalk[cid] = Math.max(ev.legTalk[cid] || 0, talk);
        ev.talk = dcSumValues_(ev.legTalk);
      }
      // (missed flag is implied when no leg answered; classified in pass 2)
    }

    // PC-4: the agent's own Outgoing leg on an INBOUND call is that call's
    // talk, not an outbound call -- remembered and credited to the inbound
    // event below (the leg may precede the Incoming leg in the grid).
    if (callerAgent && !exclusions.has(callerAgent.name) && dir === 'Outgoing' && isIncomingCall(cid, parent)) {
      if (talk > 0) {
        const own = ownTalkOnInbound[callerAgent.name] || (ownTalkOnInbound[callerAgent.name] = {});
        own[root] = Math.max(own[root] || 0, talk);   // D2: by root, like the events
      }
      continue;
    }

    // (3) OUTBOUND DIRECT events -- agent is the caller. Activity only.
    //     D2 (owner 2026-10-21): an INTERNAL-direction leg (a coworker dial
    //     the CDR logs as Internal) is the caller's outbound call too -- it
    //     used to reach only the callee's inbound; one event per ROOT call
    //     (so an Outgoing + Internal pair for one dial stays one call); and
    //     internal / external comes from dcOutboundSide_ (an extension-length
    //     callee is internal even when no roster names it).
    //     DC-D2b: an Internal leg counts only when it is a DIAL to an
    //     extension (dcIsInternalDial_) -- never a recording / voicemail /
    //     forking leg.
    if (callerAgent && !exclusions.has(callerAgent.name)
        && (dir === 'Outgoing' || (dir === 'Internal' && dcIsInternalDial_(callee, r[C.CTX])))
        && !isIncomingCall(cid, parent)) {
      const b = ensure(callerAgent.name, callerAgent.dept);
      let ev = b.ob[root];
      if (!ev) { ev = b.ob[root] = { intExt: dcOutboundSide_(dir, callee, extToAgent), start: startSec, connected: false, talk: 0, legTalk: {}, legs: {}, caller: caller, callee: callee, root: root, firstCid: cid, otherName: dcClean_(r[C.CALLEE_NAME]), otherAgent: extOnly ? undefined : (calleeRes.agent || null) }; }
      ev.legs[cid] = true;   // the call's side stays its FIRST leg's (a later internal transfer leg does not make an outside call internal)
      if (startSec != null && (ev.start == null || startSec < ev.start)) ev.start = startSec;
      if (talk > 0) { ev.connected = true; ev.legTalk[cid] = Math.max(ev.legTalk[cid] || 0, talk); ev.talk = dcSumValues_(ev.legTalk); }
    }
  }

  // PC-4: an inbound event the agent's own Outgoing talk leg answered (the
  // S2C-1 shape) is ANSWERED with that talk -- pre-fix it read missed_free
  // while the same talk was counted as a fake outbound.
  Object.keys(ownTalkOnInbound).forEach(function (name) {
    const a = A[name];
    if (!a) return;
    Object.keys(ownTalkOnInbound[name]).forEach(function (cid) {
      const ev = a.ib[cid];
      if (!ev) return;
      ev.answered = true;
      ev.talk = Math.max(ev.talk, ownTalkOnInbound[name][cid]);
    });
  });

  function inWindow(s) { return s != null && s >= W0 && s < W1; }
  // Returns the FIRST overlapping busy interval of a DIFFERENT call (the
  // "blocker") or null. Overlap = any (>0) against the busy window + tail.
  function busyBlocker(occList, ring) {
    for (let j = 0; j < occList.length; j++) {
      const o = occList[j];
      if (o.cid === ring.cid) continue;
      if (ring.s < (o.e + TAIL) && o.s < ring.e) return o;
    }
    return null;
  }

  // CAP-4 (broad-scan 2026-11-09): the busy test for a MISSED event, ring by
  // ring. D2 made one event of every leg of a root call, with one span from
  // the first ring's start to the last ring's end -- so a call the agent took
  // in the GAP between two rings of the same root (rang, went elsewhere, came
  // back six minutes later) overlapped that span and turned a miss while free
  // into "missed while busy", naming a call they were on at neither ring. A
  // miss is excused only when EVERY ring found them busy: free at any ring
  // and unanswered is a miss. Returns the first ring's blocker (who they were
  // with) or null. An event with no timed ring keeps the old single-span test.
  function eventBlocker(occList, ev, cid) {
    const rings = (ev.rings && ev.rings.length) ? ev.rings
      : [{ s: ev.start, e: (ev.ringEnd != null ? ev.ringEnd : ev.start) }];
    let first = null;
    for (let j = 0; j < rings.length; j++) {
      const bl = busyBlocker(occList, { cid: cid, s: rings[j].s, e: rings[j].e });
      if (!bl) return null;
      if (!first) first = bl;
    }
    return first;
  }

  // Sample collection (verification aid): a capped few example events per
  // bucket, with the fields needed to find the row in Raw Data by CALL_ID.
  const collect = !!(opts && opts.collectSamples);
  const SAMPLE_CAP = (opts && opts.sampleCap) || 6;
  const samples = { ib_answered: [], ib_missed_free: [], ib_missed_busy: [], ob_connected: [], ob_not_connected: [] };
  function secToHms(s) {
    if (s == null) return '?';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ':' + (x < 10 ? '0' : '') + x;
  }
  function addSample(cat, rec) { if (collect && samples[cat].length < SAMPLE_CAP) samples[cat].push(rec); }

  const rows = [];
  let missedBusyTotal = 0, missedFreeTotal = 0;

  Object.keys(A).forEach(function (name) {
    const a = A[name];
    const m = {
      ib_int_answered: 0, ib_int_missed_free: 0, ib_int_missed_busy: 0, ib_int_talk_sec: 0,
      ib_ext_answered: 0, ib_ext_missed_free: 0, ib_ext_missed_busy: 0, ib_ext_talk_sec: 0,
      ob_int_total: 0, ob_int_connected: 0, ob_int_talk_sec: 0,
      ob_ext_total: 0, ob_ext_connected: 0, ob_ext_talk_sec: 0,
    };

    Object.keys(a.ib).forEach(function (cid) {
      const ev = a.ib[cid];
      if (!inWindow(ev.start)) { if (ev.start == null) droppedNoStart++; return; }
      const k = ev.intExt;   // 'int' | 'ext'
      if (ev.answered) {
        m['ib_' + k + '_answered']++;
        m['ib_' + k + '_talk_sec'] += ev.talk;
        addSample('ib_answered', { callId: cid, agent: name, dept: a.dept, dir: k, time: secToHms(ev.start),
          caller: ev.caller, callee: ev.callee, talkSec: ev.talk });
      } else {
        const ring = { cid: cid, s: ev.start, e: (ev.ringEnd != null ? ev.ringEnd : ev.start) };
        const blocker = eventBlocker(a.occ, ev, cid);   // CAP-4: every ring, not the span
        if (blocker) {
          m['ib_' + k + '_missed_busy']++; missedBusyTotal++;
          addSample('ib_missed_busy', { callId: cid, agent: name, dept: a.dept, dir: k,
            ringStart: secToHms(ring.s), ringEnd: secToHms(ring.e), caller: ev.caller, callee: ev.callee,
            blockedByCallId: blocker.cid, blockerWindow: secToHms(blocker.s) + '-' + secToHms(blocker.e) + ' (+' + TAIL + 's tail)', blockerInfo: blocker.info });
        } else {
          m['ib_' + k + '_missed_free']++; missedFreeTotal++;
          addSample('ib_missed_free', { callId: cid, agent: name, dept: a.dept, dir: k,
            ringStart: secToHms(ring.s), caller: ev.caller, callee: ev.callee });
        }
      }
    });

    Object.keys(a.ob).forEach(function (cid) {
      const ev = a.ob[cid];
      if (!inWindow(ev.start)) { if (ev.start == null) droppedNoStart++; return; }
      const k = ev.intExt;
      m['ob_' + k + '_total']++;
      if (ev.connected) {
        m['ob_' + k + '_connected']++; m['ob_' + k + '_talk_sec'] += ev.talk;
        addSample('ob_connected', { callId: cid, agent: name, dept: a.dept, dir: k, time: secToHms(ev.start), caller: ev.caller, callee: ev.callee, talkSec: ev.talk });
      } else {
        addSample('ob_not_connected', { callId: cid, agent: name, dept: a.dept, dir: k, time: secToHms(ev.start), caller: ev.caller, callee: ev.callee });
      }
    });

    // Skip agents with no IN-WINDOW direct activity (all-zero row) -- keeps the
    // store to active agents, like the legacy CDR build.
    let any = false;
    Object.keys(m).forEach(function (kk) { if (m[kk]) any = true; });
    if (any) rows.push(Object.assign({ agent: name, dept: a.dept }, m));
  });

  rows.sort(function (x, y) {
    return (x.dept || '').localeCompare(y.dept || '') || (x.agent || '').localeCompare(y.agent || '');
  });

  // AC-6 (owner 2026-11-04): opt-in PER-CALL records -- one per direct call
  // per agent, the SAME events the counts above came from (every rule above
  // applies: queue calls out, DCA-1/2 credit, one event per root call), all
  // hours with an in-window flag. The other party: a roster colleague by
  // name, an internal extension nobody rosters by its 8x8 name, an outside
  // party ONLY as its number (hashed by the writer, never stored). call_start
  // is raw PST, the inbound_calls / outbound_calls convention.
  let events = null;
  if (opts.events) {
    events = [];
    const other = function (ev, ext, side) {
      // DCA-3: the colleague the leg was credited to, never the former
      // employee an extension is still listed under (extOnly: the old map).
      const ra = ev.otherAgent !== undefined ? ev.otherAgent : extToAgent[ext];
      if (side === 'int') {
        if (ra) return { name: ra.name, ext: ext, number: null };
        return { name: dcPersonName_(ev.otherName) || null, ext: ext || null, number: null };
      }
      const d = String(ext == null ? '' : ext).replace(/\D/g, '');
      return { name: null, ext: null, number: d.length >= 10 ? '+' + d : null };
    };
    Object.keys(A).forEach(function (name) {
      const a = A[name];
      Object.keys(a.ib).forEach(function (cid) {
        const ev = a.ib[cid];
        let outcome = 'answered';
        if (!ev.answered) {
          outcome = (ev.start != null && eventBlocker(a.occ, ev, cid)) ? 'missed_busy' : 'missed_free';   // CAP-4
        }
        const o = other(ev, ev.caller, ev.intExt);
        // ADT-2: who the call that kept them busy was with.
        let busyWith = null;
        if (outcome === 'missed_busy') {
          const bl = eventBlocker(a.occ, ev, cid);   // CAP-4
          busyWith = bl ? (bl.w || 'another call') : null;
        }
        events.push({ agent: name, dept: a.dept, direction: 'in', side: ev.intExt, callId: cid, callStart: ev.start == null ? null : secToHms(ev.start),
          ringSec: (ev.start != null && ev.ringEnd != null) ? Math.max(0, ev.ringEnd - ev.start) : null,
          talkSec: ev.answered ? ev.talk : 0, outcome: outcome, inWindow: inWindow(ev.start),
          otherName: o.name, otherExt: o.ext, otherNumber: o.number, busyWith: busyWith });
      });
      Object.keys(a.ob).forEach(function (cid) {
        const ev = a.ob[cid];
        const o = other(ev, ev.callee, ev.intExt);
        events.push({ agent: name, dept: a.dept, direction: 'out', side: ev.intExt, callId: cid, callStart: ev.start == null ? null : secToHms(ev.start),
          ringSec: null, talkSec: ev.connected ? ev.talk : 0, outcome: ev.connected ? 'connected' : 'not_connected',
          inWindow: inWindow(ev.start), otherName: o.name, otherExt: o.ext, otherNumber: o.number });
      });
    });
    events.sort(function (x, y) { return (x.callStart || '') < (y.callStart || '') ? -1 : ((x.callStart || '') > (y.callStart || '') ? 1 : 0); });
  }

  const meta = { agents: rows.length, droppedNoStart: droppedNoStart, missedBusyTotal: missedBusyTotal, missedFreeTotal: missedFreeTotal };
  if (!extOnly) {
    const list = function (o) { return Object.keys(o).map(function (k) { return o[k]; }).sort(function (x, y) { return y.n - x.n || (x.ext < y.ext ? -1 : 1); }); };
    meta.attribution = { match: AT.match, blank: AT.blank, otherCell: AT.otherCell, mismatch: AT.mismatch,
      blankUnconfirmed: AT.blankUnconfirmed, blankUnconfirmedBy: list(AT.blankUnconfirmedBy),
      named: AT.named, namedUnlisted: AT.namedUnlisted, blankNamed: AT.blankNamed, reassigned: list(AT.reassigned),
      mismatches: list(AT.mismatches), moved: list(AT.moved), blankExt: AT.blankExt,
      unlisted: list(AT.unlisted) };   // DCA-7
  }
  if (collect) meta.samples = samples;
  if (diagOn) {
    meta.diag = dcDiagSummary_(DG, A, inWindow);
    const top = function (o) {
      return Object.keys(o).map(function (k) { return { v: k, n: o[k] }; })
        .sort(function (x, y) { return y.n - x.n || (x.v < y.v ? -1 : 1); }).slice(0, 8);
    };
    meta.diag.internalDialShape = { legs: DGI.legs, dials: DGI.dials, rosterAgent: DGI.rosterAgent, self: DGI.self, unrosteredExt: DGI.unrosteredExt,
      outsideNumber: DGI.outsideNumber, other: DGI.other, talked: DGI.talked,
      topCallees: top(DGI.callee), topContexts: top(DGI.ctx) };
  }
  const out = events ? { rows: rows, meta: meta, events: events } : { rows: rows, meta: meta };
  // CAP-6 (broad-scan 2026-11-09): the build's OWN per-leg credit rule
  // (DCA-1..5 with the DCA-2/3 blank-name confirmation, which needs this
  // pass's ownerSeen) for dcDialInAnnotate_. Non-enumerable: callers that
  // serialize or compare the result see exactly the shape they always did.
  try {
    Object.defineProperty(out, 'resolveLeg', { enumerable: false, value: function (ext, legName) {
      return extOnly ? { agent: extToAgent[ext] || null, kind: 'blank' }
        : confirmBlank(ext, dcResolveAgent_(ext, legName, maps));
    } });
  } catch (eRes) { /* a frozen result: the annotator falls back to the raw rule */ }
  return out;
}

/**
 * D0, PURE: totals + per-agent counts + up to 5 sample call ids for each
 * counter, plus the same-ROOT repeats -- events the build counts separately
 * (one per leg call id) that share a parent call, i.e. one call to the agent
 * counted twice. Scale: the in-window inbound / outbound event totals.
 */
function dcDiagSummary_(DG, A, inWindow) {
  const SAMPLES = 5;
  const out = { scale: { ibEvents: 0, obEvents: 0 } };
  const pack = function (byAgent) {
    const agents = Object.keys(byAgent).map(function (n) {
      const ids = Object.keys(byAgent[n]);
      return { agent: n, n: ids.length, samples: ids.slice(0, SAMPLES) };
    }).filter(function (a) { return a.n > 0; }).sort(function (x, y) { return y.n - x.n || x.agent.localeCompare(y.agent); });
    return { total: agents.reduce(function (t, a) { return t + a.n; }, 0), agents: agents };
  };
  Object.keys(DG).forEach(function (k) { out[k] = pack(DG[k]); });
  const rootIn = {}, rootOut = {};
  Object.keys(A).forEach(function (name) {
    const a = A[name];
    // Since D2 an event IS one root call; its extra legs (each its own call
    // id) are the calls a pre-D2 build counted again.
    const scan = function (evs, sink, scaleKey) {
      Object.keys(evs).forEach(function (rootId) {
        const ev = evs[rootId];
        if (!inWindow(ev.start)) return;
        out.scale[scaleKey]++;
        const extra = Object.keys(ev.legs || {}).filter(function (c) { return c !== ev.firstCid; });
        if (extra.length) {
          const s = sink[name] || (sink[name] = {});
          extra.forEach(function (c) { s[c] = true; });
        }
      });
    };
    scan(a.ib, rootIn, 'ibEvents');
    scan(a.ob, rootOut, 'obEvents');
  });
  out.sameRootIn = pack(rootIn);
  out.sameRootOut = pack(rootOut);
  return out;
}

// -- Config-map builder (mirrors calculateMetricsInMemory's parse) ------------
// Standalone (not a refactor of the legacy function) so this feature can't
// regress the existing CDR Historical build. Reads the DO NOT EDIT! sheet:
// dept headers in row 1 cols F.., roster cells "Name, ext, ext2" below.
function dcBuildExtMaps_(configSheet) {
  const extToAgent = {};
  const firstExtToAgent = {};
  const laterExtToAgent = {};
  const queueExtSet = new Set();
  const exclusions = new Set();
  const lastRow = configSheet.getLastRow();
  // DCA-1: EVERY roster cell listing an extension (a former employee's cell
  // keeps an extension 8x8 has since given to someone else).
  const extCands = {};
  function addCand(ext, name, dept) {
    const l = extCands[ext] || (extCands[ext] = []);
    if (!l.some(function (c) { return c.name === name && c.dept === dept; })) l.push({ name: name, dept: dept });
  }
  // DCA-3: EVERY roster cell by name (a cell with no extension too), so a
  // call 8x8 names for a roster person reaches them on any extension.
  const nameCells = {};
  function addName(name, dept) {
    if (!name) return;
    const l = nameCells[name] || (nameCells[name] = []);
    if (!l.some(function (c) { return c.dept === dept; })) l.push({ name: name, dept: dept });
  }
  const canon = dcRosterCanonicalizer_(configSheet);
  if (lastRow < 2) return { extToAgent: extToAgent, queueExtSet: queueExtSet, exclusions: exclusions, firstExtToAgent: firstExtToAgent, allExtToAgent: extToAgent, extCands: extCands, nameCells: nameCells, canon: canon };

  // Queue map (cols A/B): dept/queue-group | queue ext(s). Col B may be a
  // COMMA-JOINED list of extensions (e.g. "103,108" -- the combined CSR queues
  // A_Q_CSR + A_Q_Intake grouped under "A_Q_CustomerSuccess", which itself has
  // no ext). Split so each ext is matched individually by queueExtSet.has(ext);
  // adding the raw cell too is harmless.
  const queueMap = configSheet.getRange(2, 1, lastRow - 1, 2).getValues();
  queueMap.forEach(function (r) {
    if (r[0]) exclusions.add(String(r[0]).trim());
    if (r[1]) {
      const raw = String(r[1]).trim();
      exclusions.add(raw);
      raw.split(',').forEach(function (tok) {
        const ext = tok.trim();
        if (ext) { exclusions.add(ext); queueExtSet.add(ext); }
      });
    }
  });

  // Roster block (cols F.. = col 6..): header row 1 = dept names; cells below
  // are "Name, ext1, ext2, ...".
  // F-19: the dept block was hard-capped at 14 columns (cols F..S) --
  // exactly the install's CURRENT width, so a 15th department's agents
  // would silently vanish from these metrics with no error (DQE kept
  // working: loadRosterCanonicalNames_ already scans to lastColumn --
  // a hard-to-diagnose divergence). Read to the last column and stop at
  // the FIRST BLANK header: the documented dept-block boundary
  // (conventions.md), which also keeps the unrelated reference block
  // (insurance numbers, cols X-AG) out of the roster parse.
  const rosterWidth = Math.max(1, configSheet.getLastColumn() - 5);
  const headerRow = configSheet.getRange(1, 6, 1, rosterWidth).getValues()[0];
  let deptCount = 0;
  while (deptCount < headerRow.length
         && String(headerRow[deptCount] || '').trim() !== '') deptCount++;
  const deptHeaders = headerRow.slice(0, Math.max(1, deptCount));
  const configRange = configSheet.getRange(2, 6, lastRow - 1, deptHeaders.length).getValues();
  configRange.forEach(function (row) {
    row.forEach(function (cell, cIdx) {
      const s = String(cell);
      if (s.indexOf(',') === -1) { if (s.trim()) addName(s.trim(), deptHeaders[cIdx] || 'Unassigned'); return; }
      const p = s.split(',');
      if (p.length < 2) return;
      const name = p[0].trim();
      const ext = p[1].trim();
      const dept = deptHeaders[cIdx] || 'Unassigned';
      addName(name, dept);
      if (ext) { firstExtToAgent[ext] = { name: name, dept: dept }; addCand(ext, name, dept); }
      // D2 (owner 2026-10-21): EVERY digit-only extension token (INV-03)
      // maps to the agent -- calls on a second extension used to be
      // invisible. First-seen wins among the later extensions.
      p.slice(2).forEach(function (t) {
        const e = t.trim();
        if (/^\d+$/.test(e) && !laterExtToAgent[e]) laterExtToAgent[e] = { name: name, dept: dept };
        if (/^\d+$/.test(e)) addCand(e, name, dept);
      });
    });
  });
  // A FIRST extension always beats a later one (and keeps its own rule:
  // the last dept column wins), so no agent's main line can be taken over by
  // someone else's spare extension.
  Object.keys(laterExtToAgent).forEach(function (e) { if (!firstExtToAgent[e]) extToAgent[e] = laterExtToAgent[e]; });
  Object.keys(firstExtToAgent).forEach(function (e) { extToAgent[e] = firstExtToAgent[e]; });
  // firstExtToAgent = the pre-D2 map, kept for the diagnose mode (what a
  // re-import changes); allExtToAgent = extToAgent (the D0 name).
  return { extToAgent: extToAgent, queueExtSet: queueExtSet, exclusions: exclusions,
           firstExtToAgent: firstExtToAgent, allExtToAgent: extToAgent, extCands: extCands, nameCells: nameCells, canon: canon };
}

/**
 * DCA-1: the DQE build's roster canonicalizer (INV-24: alias overrides, exact
 * roster name, then a UNIQUE strip / flatten match) over the same workbook as
 * the roster sheet -- one rule, not a new mirror. Identity when the build
 * file or the roster is unavailable (a name then has to match exactly).
 */
function dcRosterCanonicalizer_(configSheet) {
  try {
    if (typeof canonicalizeAgentNameWith_ === 'function' && typeof loadRosterCanonicalNames_ === 'function'
        && configSheet && typeof configSheet.getParent === 'function') {
      const rc = loadRosterCanonicalNames_(configSheet);
      if (rc && (Object.keys(rc.canonicalSet || {}).length || Object.keys(rc.aliasMap || {}).length)) {
        return function (n) { return n ? canonicalizeAgentNameWith_(rc, n) : n; };
      }
    }
  } catch (e) {
    dcLog_('dcRosterCanonicalizer_: roster names unavailable, names must match exactly: ' + (e && e.message ? e.message : e));
  }
  return function (n) { return n; };
}

// -- Persistence: sheet -------------------------------------------------------
function dcEnsureSheet_(ss) {
  let sh = ss.getSheetByName(DIRECT_CALL_HISTORY_SHEET);
  if (!sh) {
    sh = ss.insertSheet(DIRECT_CALL_HISTORY_SHEET);
    sh.getRange(1, 1, 1, DIRECT_CALL_HISTORY_HEADERS.length).setValues([DIRECT_CALL_HISTORY_HEADERS]);
    sh.setFrozenRows(1);
  }
  return sh;
}

/**
 * Normalize a Date-column cell (display string) OR the build's dateStr to
 * ISO for comparison. Col B is written as an "M/D/YYYY" STRING, but Sheets
 * auto-coerces date-shaped strings into Date values, so a raw getValues()
 * read returns Date objects whose String() form never equals dateStr -- the
 * bug that made the refresh-in-window delete a silent no-op (duplicate row
 * sets accumulated on every force re-import / bulk pass). Compare DISPLAY
 * values normalized to ISO instead (the INV-02-safe pattern buildDQE's
 * dup-guard uses). parseDateForNeon (neonWrite.js, same project) handles
 * both "M/D/YYYY" and any other date-ish display shape.
 */
function dcDateIso_(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (typeof parseDateForNeon === 'function') return parseDateForNeon(s) || '';
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return '';
  return m[3] + '-' + String(parseInt(m[1], 10)).padStart(2, '0')
             + '-' + String(parseInt(m[2], 10)).padStart(2, '0');
}

/**
 * Refresh-in-window write: drop the date's existing rows, append the new ones.
 * Returns {written, deleted} -- `deleted` is how many existing rows the date
 * refresh removed, so callers can spot the C-5 loss signature (deleted > 0
 * with written === 0: a rebuild that erased the date and replaced it with
 * nothing). A legitimate zero-activity date has deleted === 0 too, so the
 * pair distinguishes "no-op" from "erased".
 */
function dcWriteSheet_(ss, rows, monthYear, dateStr) {
  const sh = dcEnsureSheet_(ss);
  const last = sh.getLastRow();
  const targetIso = dcDateIso_(dateStr);
  let deleted = 0;
  if (last > 1 && targetIso) {
    // getDisplayValues, not getValues (see dcDateIso_ above).
    const dateCol = sh.getRange(2, 2, last - 1, 1).getDisplayValues();  // col B = Date
    // R39 (the R38-B rule): delete the date's rows as contiguous BLOCKS,
    // bottom-up, instead of one deleteRow call per row -- each call is a
    // synchronous reflow of a years-deep sheet, and ~80 of them was the
    // larger half of the Direct step's ~4 min on a Manual Export. Same
    // match (ISO-normalized DISPLAY values, F-3), same `deleted` count.
    const blocks = [];   // [startRow, count], ascending
    let start = -1, prev = -1;
    for (let i = 0; i < dateCol.length; i++) {
      if (dcDateIso_(dateCol[i][0]) !== targetIso) continue;
      const row = i + 2;
      if (start < 0) { start = prev = row; }
      else if (row === prev + 1) { prev = row; }
      else { blocks.push([start, prev - start + 1]); start = prev = row; }
      deleted++;
    }
    if (start >= 0) blocks.push([start, prev - start + 1]);
    for (let b = blocks.length - 1; b >= 0; b--) sh.deleteRows(blocks[b][0], blocks[b][1]);
  }
  if (!rows.length) return { written: 0, deleted: deleted };
  const out = rows.map(function (r) {
    return [
      monthYear, dateStr, r.dept, r.agent,
      r.ib_int_answered, r.ib_int_missed_free, r.ib_int_missed_busy, r.ib_int_talk_sec,
      r.ib_ext_answered, r.ib_ext_missed_free, r.ib_ext_missed_busy, r.ib_ext_talk_sec,
      r.ob_int_total, r.ob_int_connected, r.ob_int_talk_sec,
      r.ob_ext_total, r.ob_ext_connected, r.ob_ext_talk_sec,
    ];
  });
  sh.getRange(sh.getLastRow() + 1, 1, out.length, DIRECT_CALL_HISTORY_HEADERS.length).setValues(out);
  return { written: out.length, deleted: deleted };
}

// -- Persistence: Neon mirror (reuses getReachableNeonConn_; no INV-16 edit) --
function dcEnsureNeonTable_(conn) {
  const ddl = conn.createStatement();
  ddl.execute(
    'CREATE TABLE IF NOT EXISTS direct_call_history (' +
    'month_year text, call_date date NOT NULL, department text NOT NULL, agent_name text NOT NULL, ' +
    'ib_int_answered int, ib_int_missed_free int, ib_int_missed_busy int, ib_int_talk_sec int, ' +
    'ib_ext_answered int, ib_ext_missed_free int, ib_ext_missed_busy int, ib_ext_talk_sec int, ' +
    'ob_int_total int, ob_int_connected int, ob_int_talk_sec int, ' +
    'ob_ext_total int, ob_ext_connected int, ob_ext_talk_sec int, ' +
    'updated_at timestamptz DEFAULT now(), ' +
    'PRIMARY KEY (call_date, department, agent_name))');
  ddl.close();
}

// Column lists for the upsert -- shared by the single-date writer + the
// multi-date backfill so the SQL lives in ONE place (no in-file drift). The
// 3-col PK (call_date, department, agent_name) is NOT in the UPDATE set.
const DIRECT_CALL_INSERT_COLS = 'month_year, call_date, department, agent_name, ' +
  'ib_int_answered, ib_int_missed_free, ib_int_missed_busy, ib_int_talk_sec, ' +
  'ib_ext_answered, ib_ext_missed_free, ib_ext_missed_busy, ib_ext_talk_sec, ' +
  'ob_int_total, ob_int_connected, ob_int_talk_sec, ' +
  'ob_ext_total, ob_ext_connected, ob_ext_talk_sec';
const DIRECT_CALL_UPDATE_COLS = ['month_year',
  'ib_int_answered', 'ib_int_missed_free', 'ib_int_missed_busy', 'ib_int_talk_sec',
  'ib_ext_answered', 'ib_ext_missed_free', 'ib_ext_missed_busy', 'ib_ext_talk_sec',
  'ob_int_total', 'ob_int_connected', 'ob_int_talk_sec',
  'ob_ext_total', 'ob_ext_connected', 'ob_ext_talk_sec'];

/**
 * One batched INSERT ... ON CONFLICT DO UPDATE for direct_call_history. Each
 * row object carries its OWN monthYear + isoDate (so the multi-date backfill
 * works) + dept/agent + the 14 metric fields. The CALLER owns the connection
 * + transaction (setAutoCommit / commit / rollback) so a single connection can
 * serve a whole daily write OR a whole multi-date backfill. Returns the count.
 */
function dcUpsertRows_(conn, rows) {
  if (!rows || !rows.length) return 0;
  // IMP-6: the PK is (call_date, department, agent_name), and Postgres
  // rejects a multi-row upsert whose VALUES repeat a key ("cannot affect
  // row a second time"). The sheet-derived backfill (backfillDirectCallToNeon)
  // can carry duplicated rows (known-issues: pre-F-3 re-import duplicates are
  // NOT auto-removed) -- one such batch previously threw and re-threw at the
  // same DIRECT_UPSERT_RESUME index forever. Last-write-wins dedupe (the
  // later sheet row is the fresher rebuild).
  const seen = {};
  const order = [];
  rows.forEach(function (r) {
    const k = r.isoDate + '\u0001' + r.dept + '\u0001' + r.agent;
    if (!(k in seen)) order.push(k);
    seen[k] = r;
  });
  if (order.length !== rows.length) {
    dcLog_('dcUpsertRows_: dropped %s duplicate-key row(s) (last-write-wins).',
      rows.length - order.length);
    rows = order.map(function (k) { return seen[k]; });
  }
  // R39 (the R38 rule, applied here): INLINE LITERALS, zero binds, packed
  // by size under the JDBC SQL cap via neonWrite.js's neonInsertInline_
  // (same project -- no INV-16 edit). 18 binds x ~80 agent-days was ~70 s
  // of bridge calls per daily write. The original bound statement survives
  // as dcBoundUpsert_, the per-row fallback for a tuple that alone exceeds
  // the cap; direct-call-backfill.test.js pins inline == bound value-for-
  // value. The CALLER still owns the transaction (no commit here).
  const res = neonInsertInline_(conn, DIRECT_CALL_UPSERT_HEAD_, DIRECT_CALL_UPSERT_TAIL_,
    rows, dcInlineTuple_, dcBoundUpsert_);
  dcLog_('dcUpsertRows_: wrote %s rows%s.', rows.length, neonInlineNote_(res));
  return rows.length;
}

// R39: the upsert SQL split into head/tail around the VALUES list (byte-
// identical to the former single string) + the ORIGINAL bound-param
// statement, kept as neonInsertInline_'s oversize fallback, + the inline
// tuple renderer (same values, same order, same `v | 0` coercion as the
// setInt loop -- NOT neonSqlInt_'s parseInt, so the two paths stay equal).
const DIRECT_CALL_UPSERT_HEAD_ = 'INSERT INTO direct_call_history (' + DIRECT_CALL_INSERT_COLS + ') VALUES ';
const DIRECT_CALL_UPSERT_TAIL_ = ' ON CONFLICT (call_date, department, agent_name) DO UPDATE SET ' +
  DIRECT_CALL_UPDATE_COLS.map(function (c) { return c + ' = EXCLUDED.' + c; }).join(', ') +
  ', updated_at = now()';

function dcMetricValues_(r) {
  return [r.ib_int_answered, r.ib_int_missed_free, r.ib_int_missed_busy, r.ib_int_talk_sec,
          r.ib_ext_answered, r.ib_ext_missed_free, r.ib_ext_missed_busy, r.ib_ext_talk_sec,
          r.ob_int_total, r.ob_int_connected, r.ob_int_talk_sec,
          r.ob_ext_total, r.ob_ext_connected, r.ob_ext_talk_sec];
}

function dcBoundUpsert_(conn, rows) {
  const ph = '(' + new Array(18).fill('?').join(',') + ')';
  const sql = DIRECT_CALL_UPSERT_HEAD_ + rows.map(function () { return ph; }).join(',') + DIRECT_CALL_UPSERT_TAIL_;
  const stmt = conn.prepareStatement(sql);
  let p = 0;
  rows.forEach(function (r) {
    stmt.setString(++p, r.monthYear);
    stmt.setString(++p, r.isoDate);
    stmt.setString(++p, r.dept);
    stmt.setString(++p, r.agent);
    dcMetricValues_(r).forEach(function (v) { stmt.setInt(++p, v | 0); });
  });
  stmt.execute();
  stmt.close();
}

function dcInlineTuple_(r) {
  return '(' + [neonSqlLit_(r.monthYear), neonSqlLit_(r.isoDate), neonSqlLit_(r.dept), neonSqlLit_(r.agent)]
    .concat(dcMetricValues_(r).map(function (v) { return String(v | 0); }))
    .join(',') + ')';
}

// AC-6 (owner 2026-11-04): one row per direct call per agent -- the per-call
// list behind the agent panel's Direct tab. Replaced WHOLE per date in the
// same transaction as direct_call_history, so the list and the day's counts
// can never disagree. Employee names and extensions only; an outside party is
// its HMAC hash (the inbound_calls caller_hash rule, so Caller Lookup joins),
// never a number or a CNAM name. Not retroactive: dates before the capture
// fill only by a rebuild (rebuildDirectCallHeldDates, ~14 days held).
function dcEnsureEventsTable_(conn) {
  const ddl = conn.createStatement();
  ddl.execute(
    'CREATE TABLE IF NOT EXISTS direct_calls (' +
    'call_date date NOT NULL, call_id text NOT NULL, agent_name text NOT NULL, department text, ' +
    'direction text NOT NULL, side text, call_start text, ring_sec int, talk_sec int, outcome text, ' +
    'in_window boolean, other_name text, other_ext text, other_hash text, updated_at timestamptz DEFAULT now(), ' +
    'PRIMARY KEY (call_date, call_id, agent_name, direction))');
  ddl.execute('CREATE INDEX IF NOT EXISTS idx_direct_calls_agent ON direct_calls (agent_name, call_date)');
  // DID-1: how an outside call reached the agent + the COMPANY number it was
  // dialed on (never the caller's). Idempotent ADD COLUMN; older rows stay NULL.
  ddl.execute('ALTER TABLE direct_calls ADD COLUMN IF NOT EXISTS via text');
  ddl.execute('ALTER TABLE direct_calls ADD COLUMN IF NOT EXISTS dial_in text');
  // ADT-2: a ring missed while on another call names who that call was with.
  ddl.execute('ALTER TABLE direct_calls ADD COLUMN IF NOT EXISTS busy_with text');
  ddl.close();
}
const DIRECT_EVENTS_HEAD_ = 'INSERT INTO direct_calls (call_date, call_id, agent_name, department, direction, side, '
  + 'call_start, ring_sec, talk_sec, outcome, in_window, other_name, other_ext, other_hash, via, dial_in, busy_with) VALUES ';
const DIRECT_EVENTS_TAIL_ = ' ON CONFLICT (call_date, call_id, agent_name, direction) DO NOTHING';
/** PURE. One events tuple; `hash` is the outside party's HMAC (or null). */
function dcEventTuple_(isoDate, e, hash) {
  const int = function (v) { return (v == null || !isFinite(Number(v))) ? 'NULL' : String(Math.round(Number(v))); };
  return '(' + [neonSqlLit_(isoDate) + '::date', neonSqlLit_(e.callId), neonSqlLit_(e.agent), neonSqlLit_(e.dept || null),
    neonSqlLit_(e.direction), neonSqlLit_(e.side || null), neonSqlLit_(e.callStart || null), int(e.ringSec), int(e.talkSec),
    neonSqlLit_(e.outcome || null), e.inWindow ? 'TRUE' : 'FALSE', neonSqlLit_(e.otherName || null),
    neonSqlLit_(e.otherExt || null), neonSqlLit_(hash || null),
    neonSqlLit_(e.via || null), neonSqlLit_(e.dialIn || null), neonSqlLit_(e.busyWith || null)].join(',') + ')';
}
/**
 * Writes one date's events on the caller's connection + transaction. Returns
 * the count. The table's DDL (dcEnsureEventsTable_) is the CALLER's job, in
 * autocommit BEFORE the transaction (P-9: ADD COLUMN IF NOT EXISTS takes an
 * ACCESS EXCLUSIVE lock even when the column exists, held to commit).
 */
function dcWriteEvents_(conn, isoDate, events) {
  const del = conn.prepareStatement('DELETE FROM direct_calls WHERE call_date = ?::date');
  del.setString(1, isoDate);
  del.execute();
  del.close();
  if (!events || !events.length) return 0;
  let secret = null;
  try { secret = PropertiesService.getScriptProperties().getProperty('HMAC_SECRET'); } catch (e) { secret = null; }
  const seen = {};
  const list = events.filter(function (e) {
    const k = e.callId + '|' + e.agent + '|' + e.direction;
    if (seen[k]) return false;
    seen[k] = true;
    return true;
  });
  const tuple = function (e) {
    const h = (secret && e.otherNumber && typeof cdrHashPhone_ === 'function') ? cdrHashPhone_(e.otherNumber, secret) : null;
    return dcEventTuple_(isoDate, e, h);
  };
  const res = neonInsertInline_(conn, DIRECT_EVENTS_HEAD_, DIRECT_EVENTS_TAIL_, list, tuple, function () {
    throw new Error('direct_calls: one event tuple exceeded the statement cap (cannot happen for these short rows).');
  });
  dcLog_('dcWriteEvents_: wrote %s direct call(s) for %s%s.', list.length, isoDate, neonInlineNote_(res));
  return list.length;
}

/** Upsert per-agent-day rows for one date. Best-effort; returns a status object. */
function writeDirectCallRowsToNeon_(rows, monthYear, isoDate, events) {
  // P-5: an EMPTY row set still runs the authoritative date-DELETE below --
  // dcWriteSheet_ clears the sheet's rows for the date even when zero new
  // rows are produced, so early-returning here left the full stale row set
  // in direct_call_history forever (silent sheet/Neon divergence on a force
  // re-import of a date whose direct activity legitimately dropped to zero).
  // Only skip entirely when there's no date to clear.
  if ((!rows || !rows.length) && !isoDate) return { inserted: 0, skipped: 0 };
  const conn = getReachableNeonConn_();
  if (!conn) { dcLog_('writeDirectCallRowsToNeon_: Neon unreachable -- skipping %s rows.', rows.length); return { inserted: 0, unreachable: true }; }
  // P-9 (ADT-3, owner 2026-11-06): DDL in AUTOCOMMIT, before the transaction
  // opens -- ADD COLUMN IF NOT EXISTS takes ACCESS EXCLUSIVE even when the
  // column exists, and inside the transaction it held that lock on
  // direct_calls for the whole write (the Direct tab's reads waited).
  try {
    dcEnsureNeonTable_(conn);
    if (events !== undefined) dcEnsureEventsTable_(conn);
  } catch (eDdl) {
    try { conn.close(); } catch (ce0) {}
    dcLog_('writeDirectCallRowsToNeon_ DDL failed: ' + (eDdl && eDdl.message ? eDdl.message : eDdl));
    return { inserted: 0, error: String(eDdl && eDdl.message ? eDdl.message : eDdl) };
  }
  conn.setAutoCommit(false);
  try {
    // IMP-5: this daily writer's rows are the COMPLETE per-agent set for
    // isoDate (the sheet side is refresh-in-window for the same date), so
    // replace the date authoritatively -- an agent who drops out of a
    // force-rebuilt day no longer lingers as a phantom Neon row. Same
    // transaction: a failed insert rolls the delete back too. The
    // multi-date backfill (dcUpsertRows_ direct, partial 50-row batches)
    // deliberately does NOT get this.
    const del = conn.prepareStatement('DELETE FROM direct_call_history WHERE call_date = ?::date');
    del.setString(1, isoDate);
    del.execute();
    del.close();
    const upsertRows = (rows || []).map(function (r) {
      return Object.assign({ monthYear: monthYear, isoDate: isoDate }, r);
    });
    const n = dcUpsertRows_(conn, upsertRows);
    // AC-6: the per-call list, same transaction (undefined = an older caller: left alone).
    const ne = (events !== undefined) ? dcWriteEvents_(conn, isoDate, events) : null;
    conn.commit();
    return ne === null ? { inserted: n } : { inserted: n, events: ne };
  } catch (e) {
    try { conn.rollback(); } catch (rb) {}
    dcLog_('writeDirectCallRowsToNeon_ failed: ' + (e && e.message ? e.message : e));
    return { inserted: 0, error: String(e && e.message ? e.message : e) };
  } finally {
    try { conn.close(); } catch (ce) {}
  }
}

// -- Deferred Neon mirror backfill (Phase 3) ----------------------------------
// IG-2 (broad-scan 2026-10-01): DIRECT_UPSERT_RESUME was the last BARE
// positional index (cdr-report's four *_RESUME pointers got fingerprints in
// T-8). dcWriteSheet_ deletes a rebuilt date's rows and appends them at the
// END, so a force re-import between two runs slid every later row up under the
// pointer and the resumed run skipped those rows for good -- the backfill does
// no per-date replace, so the gap was permanent. Same fix as T-8, kept local
// (different project): the pointer carries the grid's row count and the key of
// the row it resumes AT; any mismatch -- or a legacy bare integer -- restarts
// from 0, which is always safe because the upsert is ON CONFLICT idempotent.
var DC_RESUME_KEY_COLS_ = [1, 2, 3];   // Direct Call History: B date, C dept, D agent

function dcResumeKey_(row) {
  return DC_RESUME_KEY_COLS_.map(function (c) {
    return String(row && row[c] != null ? row[c] : '').trim();
  }).join('\u0001');
}

function dcResumeRead_(props, data) {
  const raw = props.getProperty('DIRECT_UPSERT_RESUME');
  if (!raw) return 0;
  let st = null;
  try { st = JSON.parse(raw); } catch (e) { st = null; }
  if (!st || typeof st !== 'object') {
    dcLog_('DIRECT_UPSERT_RESUME = "%s" is a legacy positional pointer with no row fingerprint '
      + '-- restarting from 0 so no row can be skipped (IG-2).', raw);
    return 0;
  }
  let idx = parseInt(st.index, 10);
  if (isNaN(idx) || idx < 0) idx = 0;
  let why = null;
  if (st.rowCount !== data.length) why = 'row count changed (' + st.rowCount + ' -> ' + data.length + ')';
  else if (idx < data.length && dcResumeKey_(data[idx]) !== st.key) why = 'the row at index ' + idx + ' changed';
  if (why) {
    dcLog_('DIRECT_UPSERT_RESUME: the sheet changed since the last run -- %s. Restarting from 0 '
      + 'so no row is skipped (IG-2).', why);
    return 0;
  }
  return idx;
}

function dcResumeWrite_(props, idx, data) {
  props.setProperty('DIRECT_UPSERT_RESUME', JSON.stringify({
    index: idx,
    rowCount: data.length,
    key: idx < data.length ? dcResumeKey_(data[idx]) : '',
    writtenAt: new Date().toISOString(),
  }));
}

/**
 * Editor-run: mirror the WHOLE `Direct Call History` sheet to Neon
 * `direct_call_history` with ON CONFLICT DO UPDATE. The companion to the
 * bulk-backfill path, which builds the SHEET per date with skipNeon (the
 * per-date JDBC latency dominates a long multi-date run) and defers the mirror
 * to this single end-pass -- exactly the DQE skipNeon + backfillDQEHistoryUpsert
 * pattern, but cdr-import-local (the Direct writer + table DDL live here, so no
 * cross-project move).
 *
 * One connection for the whole pass (the slow handshake is paid once).
 * Resumable via the `DIRECT_UPSERT_RESUME` Script Property (clear to re-run
 * from the top); optional `DIRECT_UPSERT_SINCE` (YYYY-MM-DD) date floor so you
 * can mirror only recently-rebuilt dates. Commits per 50-row batch + saves the
 * resume index so a timeout (or a batch error) loses no committed progress;
 * the upsert is idempotent so a re-run is always safe.
 */
function backfillDirectCallToNeon() {
  const ss = SpreadsheetApp.openById(getTargetSsId_());
  const sheet = ss.getSheetByName(DIRECT_CALL_HISTORY_SHEET);
  if (!sheet) { dcLog_('Direct upsert: "%s" sheet not found.', DIRECT_CALL_HISTORY_SHEET); return { upserted: 0 }; }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) { dcLog_('Direct upsert: sheet is empty.'); return { upserted: 0 }; }

  const data = sheet.getRange(2, 1, lastRow - 1, DIRECT_CALL_HISTORY_HEADERS.length).getDisplayValues();
  const props = PropertiesService.getScriptProperties();
  let startIndex = dcResumeRead_(props, data);   // IG-2
  let sinceFloor = props.getProperty('DIRECT_UPSERT_SINCE');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(sinceFloor || ''))) sinceFloor = null;
  dcLog_('Direct upsert: starting at index %s of %s%s', startIndex, data.length,
    sinceFloor ? ' (date floor >= ' + sinceFloor + ')' : '');
  if (startIndex >= data.length) { dcLog_('Direct upsert complete. Clear DIRECT_UPSERT_RESUME to re-run.'); return { upserted: 0 }; }

  const conn = getReachableNeonConn_();
  if (!conn) { dcLog_('Direct upsert: Neon unreachable (NEON_* Script Properties set?).'); return { upserted: 0, unreachable: true }; }
  // P-9 (ADT-3): the table's DDL in autocommit, before the transaction.
  try { dcEnsureNeonTable_(conn); }
  catch (eDdl) {
    try { conn.close(); } catch (ce0) {}
    dcLog_('Direct upsert: DDL failed: ' + (eDdl && eDdl.message ? eDdl.message : eDdl));
    return { upserted: 0, error: String(eDdl && eDdl.message ? eDdl.message : eDdl) };
  }
  conn.setAutoCommit(false);

  const BATCH_SIZE = 50;
  const TIME_LIMIT_MS = 240000;
  const startTime = Date.now();
  let totalUpserted = 0;
  let i = startIndex;
  try {
    while (i < data.length) {
      if (Date.now() - startTime > TIME_LIMIT_MS) {
        dcResumeWrite_(props, i, data);
        dcLog_('Direct upsert: time limit reached; resume at index %s. Upserted %s. Run again to continue.', i, totalUpserted);
        return { upserted: totalUpserted, resumeAt: i };   // finally closes conn
      }
      const batchStartIdx = i;
      const batch = [];
      const batchEnd = Math.min(i + BATCH_SIZE, data.length);
      while (i < batchEnd) {
        const r = data[i];
        i++;
        const dept = String(r[2] || '').trim();
        const agent = String(r[3] || '').trim();
        const cd = (typeof parseDateForNeon === 'function') ? parseDateForNeon(r[1]) : null;
        if (!cd || !dept || !agent) continue;             // skip blank/malformed rows
        if (sinceFloor && cd < sinceFloor) continue;      // date floor
        batch.push({
          monthYear: r[0] || null, isoDate: cd, dept: dept, agent: agent,
          ib_int_answered: parseInt(r[4], 10) || 0, ib_int_missed_free: parseInt(r[5], 10) || 0,
          ib_int_missed_busy: parseInt(r[6], 10) || 0, ib_int_talk_sec: parseInt(r[7], 10) || 0,
          ib_ext_answered: parseInt(r[8], 10) || 0, ib_ext_missed_free: parseInt(r[9], 10) || 0,
          ib_ext_missed_busy: parseInt(r[10], 10) || 0, ib_ext_talk_sec: parseInt(r[11], 10) || 0,
          ob_int_total: parseInt(r[12], 10) || 0, ob_int_connected: parseInt(r[13], 10) || 0, ob_int_talk_sec: parseInt(r[14], 10) || 0,
          ob_ext_total: parseInt(r[15], 10) || 0, ob_ext_connected: parseInt(r[16], 10) || 0, ob_ext_talk_sec: parseInt(r[17], 10) || 0,
        });
      }
      if (!batch.length) continue;
      try {
        dcUpsertRows_(conn, batch);
        conn.commit();
        totalUpserted += batch.length;
      } catch (e) {
        try { conn.rollback(); } catch (re) {}
        dcResumeWrite_(props, batchStartIdx, data);
        dcLog_('Direct upsert batch failed, rolled back. Resume at %s. Error: %s', batchStartIdx, (e && e.message ? e.message : e));
        throw e;
      }
    }
    props.deleteProperty('DIRECT_UPSERT_RESUME');
    dcLog_('Direct upsert complete. Total upserted into Neon: %s', totalUpserted);
    return { upserted: totalUpserted };
  } finally {
    try { conn.close(); } catch (ce) {}
  }
}

// -- Shared build core (Phase 1b) ---------------------------------------------
/**
 * Compute direct-call metrics from a Raw Data display grid + the DO NOT EDIT!
 * config sheet, write the `Direct Call History` sheet (refresh-in-window:
 * the date's rows are replaced, so it's idempotent), and mirror to Neon.
 * Shared by the editor-run runDirectCallBuild AND the daily
 * processIntegratedHistory block (Phase 1b). Best-effort Neon (never throws
 * out of the mirror; returns a status). The date is the first row ON
 * `opts.expectedDate` when given (else the grid's first dated row), and legs
 * dated on any other day are dropped before the engine runs (ING-1 / S2C-3).
 * @returns {{wrote, dateStr, isoDate, monthYear, meta, neon}}
 */
function buildDirectCallFromRaw_(ss, rawDisp, configSheet, opts) {
  opts = opts || {};
  const toIso = function (ds) { return (typeof parseDateForNeon === 'function') ? parseDateForNeon(ds) : null; };
  const expIso = (opts.expectedDate instanceof Date && !isNaN(opts.expectedDate.getTime()))
    ? opts.expectedDate.getFullYear() + '-'
      + ('0' + (opts.expectedDate.getMonth() + 1)).slice(-2) + '-'
      + ('0' + opts.expectedDate.getDate()).slice(-2)
    : null;
  // ING-1 (broad-scan 2026-09-23; P-7's sibling): a D-1 carry-over leg sorts
  // FIRST in Raw Data, and this used to take the whole day's date from the
  // first row -- so the P-4 guard below refused a 99%-correct grid on every
  // re-run and the date never got Direct history. With `expectedDate` the
  // date is the first row ON that day (the DQE build's P-7 rule); a grid with
  // NO row on the expected day still falls through to the refusal.
  let dateStr = '', firstSeen = '';
  for (let i = 1; i < rawDisp.length && !dateStr; i++) {
    const ds = dcDateStr_(rawDisp[i][2]);
    if (!ds) continue;
    if (!firstSeen) firstSeen = ds;
    if (!expIso || toIso(ds) === expIso) dateStr = ds;
  }
  if (!dateStr) dateStr = firstSeen;
  const isoDate = toIso(dateStr);
  const monthYear = dcMonthYearFromDate_(dateStr);

  // P-4 (the F2 class, mirrored from buildDQEHistoricalData's expectedDate
  // guard): the build stamps the WHOLE day with the grid's first-row date, and
  // dcWriteSheet_ + the Neon writer then DELETE that derived date's rows
  // before rewriting. A stray carry-over first row dated D-1 would therefore
  // wipe D-1's correct rows (sheet AND direct_call_history) and replace them
  // with day-D metrics mislabeled D-1 -- while day D itself is never written.
  // When the caller supplies its own date, refuse the write on a mismatch;
  // the throw lands in the caller's existing catch (Pipeline Health failure
  // row), so the corruption is surfaced instead of silently written.
  if (expIso) {
    if (isoDate !== expIso) {
      throw new Error('buildDirectCallFromRaw_: Raw Data derives date ' + (isoDate || dateStr || '(none)')
        + ' but the caller expected ' + expIso
        + ' -- refusing to write (stray first row? fix Raw Data and re-run).');
    }
  }

  const maps = dcBuildExtMaps_(configSheet);
  // C-5 (the P-3 discipline: validate the source before you delete).
  // dcBuildExtMaps_ silently returns EMPTY maps when the roster read comes
  // back blank (lastRow < 2, a transient sheet glitch, a renamed tab passed
  // in by mistake) -- and with no agent extensions, computeDirectCallMetrics
  // is structurally incapable of producing rows, so the delete-then-rewrite
  // below would erase the date from the sheet AND (P-5) direct_call_history
  // under a success rows:0 row. A healthy install always has extensions, so
  // refuse loudly instead; the throw lands in every caller's existing
  // Pipeline-Health-logging catch.
  if (!Object.keys(maps.extToAgent || {}).length) {
    throw new Error('buildDirectCallFromRaw_: the DO NOT EDIT! roster read yielded ZERO agent '
      + 'extensions -- refusing to rebuild (an empty-map rebuild would erase the date\'s '
      + 'Direct Call History and its Neon mirror). Check the roster sheet, then re-run.');
  }
  // S2C-3 (broad-scan 2026-09-23): the engine keys every leg by its time of
  // day only (dcStartSec_), so a leg from ANOTHER date anywhere in the grid
  // counted toward this day -- inflating activity and, as a busy interval,
  // excusing a genuine missed ring as missed_busy. Keep only the build date's
  // legs (rows with no parseable start stay: the engine counts them as
  // droppedNoStart). Mirrors the DQE build's P-7 stray-leg drop.
  let dayRows = rawDisp;
  let strayLegs = 0;
  if (isoDate) {
    const isoMemo = {};
    dayRows = [rawDisp[0]];
    for (let i = 1; i < rawDisp.length; i++) {
      const ds = dcDateStr_(rawDisp[i] && rawDisp[i][2]);
      if (!ds) { dayRows.push(rawDisp[i]); continue; }
      if (!(ds in isoMemo)) isoMemo[ds] = toIso(ds);
      if (isoMemo[ds] === isoDate) dayRows.push(rawDisp[i]);
      else strayLegs++;
    }
    if (strayLegs) {
      dcLog_('buildDirectCallFromRaw_: dropped %s leg(s) dated off %s (carry-over / stray rows).',
        strayLegs, isoDate);
    }
  }
  const result = computeDirectCallMetrics(dayRows, maps, Object.assign({}, opts, { events: true }));   // AC-6
  // DID-1 (owner 2026-11-06): each outside inbound direct call carries how it
  // reached the agent (straight / menu / colleague) and the company number it
  // was dialed on, so the dashboard can tell "their direct line" from "a main
  // line, by extension". A defect here never costs the day's write: the calls
  // just stay unsplit (via NULL).
  try {
    const ann = dcDialInAnnotate_(dayRows, result.events || [], maps, result.resolveLeg);   // CAP-6
    (result.events || []).forEach(function (ev) {
      const a = ann[ev.callId + '|' + ev.agent];
      if (a) { ev.via = a.via; ev.dialIn = a.dialIn || null; }
    });
  } catch (eVia) {
    dcLog_('buildDirectCallFromRaw_: DID-1 dial-in reading skipped: ' + (eVia && eVia.message ? eVia.message : eVia));
  }
  const at = result.meta && result.meta.attribution;
  if (at && (at.mismatch || at.otherCell || at.named || at.namedUnlisted || at.blankNamed)) {
    dcLog_('buildDirectCallFromRaw_: DCA-1/3 -- %s leg(s) credited to NO ONE (8x8 names nobody on the roster), '
      + '%s moved to another roster cell on the same extension, %s credited to the roster person 8x8 names (DCA-3: %s reassigned, '
      + '%s unlisted extension, %s unnamed on an extension that named them); diagnoseDirectCallAttribution() lists them.',
      String(at.mismatch), String(at.otherCell), String((at.named || 0) + (at.namedUnlisted || 0) + (at.blankNamed || 0)),
      String(at.named || 0), String(at.namedUnlisted || 0), String(at.blankNamed || 0));
  }

  const sheetRes = dcWriteSheet_(ss, result.rows, monthYear, dateStr);
  if (sheetRes.written === 0 && sheetRes.deleted > 0) {
    // C-5 residual (the guardForceRebuildLoss_ shape, log-only): the rebuild
    // legitimately CAN drop a date to zero (P-5 exists for exactly that), but
    // replacing N existing rows with nothing must never pass silently --
    // callers surface this via `deletedExisting` (failure row on the import
    // paths); this line covers the editor-run caller's log.
    dcLog_('buildDirectCallFromRaw_: rebuild of %s wrote 0 rows but DELETED %s existing '
      + 'row(s) -- if this date was not expected to drop to zero direct activity, '
      + 'restore via force re-import after fixing the source.', dateStr, sheetRes.deleted);
  }
  let neon = { inserted: 0 };
  if (!opts.skipNeon) {
    try { neon = writeDirectCallRowsToNeon_(result.rows, monthYear, isoDate, result.events || []); }
    catch (e) {
      dcLog_('buildDirectCallFromRaw_: Neon mirror failed (non-blocking): ' + (e && e.message ? e.message : e));
      neon = { inserted: 0, error: String(e && e.message ? e.message : e) };
    }
  }
  return { wrote: sheetRes.written, deletedExisting: sheetRes.deleted, strayLegsDropped: strayLegs,
           dateStr: dateStr, isoDate: isoDate, monthYear: monthYear, meta: result.meta, neon: neon };
}

/**
 * RB-2 (broad-scan 2026-11-09): the day a Raw Data grid is FOR, when no caller
 * knows it -- the day MOST of its dated rows are on (rawGridDay_, the shared
 * ST2 rule the CSR repair got in ING-7). The editor-run tools below used to
 * take the grid's FIRST dated row, and a D-1 carry-over leg sorts first: the
 * build then deleted D-1's correct Direct rows (sheet AND Neon, authoritative)
 * and replaced them with that one leg, dropped all of day D as "strays", never
 * wrote day D, and logged success. Returns { iso, date (local noon), strays,
 * strayByDay } or null when the grid has no dated row. (rawGridDay_ lives in
 * autoImport.js -- same project, one global scope.)
 */
function dcGridMajorityDay_(rawDisp) {
  const g = rawGridDay_(rawDisp);
  if (!g || !g.dateIso) return null;
  const p = String(g.dateIso).split('-');
  return { iso: g.dateIso, date: new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12, 0, 0),
           strays: g.strays || 0, strayByDay: g.strayByDay || {} };
}

// -- Editor-run orchestrator (Phase 1a: manual, numbers-only validation) ------
/**
 * Computes direct-call metrics for the CURRENT `Raw Data` day and writes the
 * `Direct Call History` sheet + Neon mirror. Run from the cdr-import editor.
 * Best-effort + self-contained: does NOT touch the daily import. (Phase 1b
 * wires the SAME core, buildDirectCallFromRaw_, into processIntegratedHistory.)
 * RB-2: "the current day" is the day most of the grid's rows are on
 * (dcGridMajorityDay_), handed to the core as its expectedDate so the ING-1
 * day pick and the P-4 refusal apply here as they do on the import paths.
 */
function runDirectCallBuild() {
  const t0 = Date.now();
  const ss = SpreadsheetApp.openById(getTargetSsId_());
  const rawSheet = ss.getSheetByName('Raw Data');
  const configSheet = ss.getSheetByName('DO NOT EDIT!');
  if (!rawSheet || !configSheet) throw new Error('Raw Data or DO NOT EDIT! sheet missing.');

  const raw = rawSheet.getDataRange().getDisplayValues();
  if (raw.length < 2) { dcLog_('runDirectCallBuild: Raw Data empty.'); return { rows: 0 }; }

  const day = dcGridMajorityDay_(raw);
  if (!day) {
    // No dated row at all: nothing names the day, so nothing may be deleted.
    dcLog_('runDirectCallBuild: Raw Data has no dated row -- nothing built.');
    return { rows: 0 };
  }
  if (day.strays) {
    dcLog_('runDirectCallBuild: building %s (the day most rows are on); %s leg(s) dated on other day(s) are left out: %s',
      day.iso, String(day.strays), JSON.stringify(day.strayByDay));
  }
  const r = buildDirectCallFromRaw_(ss, raw, configSheet, { collectSamples: true, expectedDate: day.date });
  dcLogSamples_(r.meta.samples);

  const ms = Date.now() - t0;
  const neonStr = r.neon.unreachable ? 'unreachable' : (r.neon.error ? 'error' : 'ok');
  dcLogPipelineHealth_(ss, 'success', r.wrote, ms,
    'directBuild date=' + r.dateStr + ' agents=' + r.meta.agents +
    ' missedBusy=' + r.meta.missedBusyTotal + ' neon=' + neonStr
    + (day.strays ? ' strayLegs=' + day.strays : ''));
  dcLog_('runDirectCallBuild: %s rows for %s (missedBusy=%s, missedFree=%s, neon=%s) in %sms',
    r.wrote, r.dateStr, r.meta.missedBusyTotal, r.meta.missedFreeTotal, neonStr, ms);
  return { rows: r.wrote, date: r.dateStr, meta: r.meta, neon: r.neon };
}

/**
 * D0 (owner 2026-10-21; Operator State #80): READ-ONLY. Since D2 it says, on
 * the day currently in Raw Data, how much the D2 rules count DIFFERENTLY from
 * the pre-D2 build -- i.e. how much re-importing a date built before D2
 * would change it (D2 applies only to dates built after its deploy):
 *   internalDial     coworker dials logged Internal: now the caller's outbound
 *   secondExtIn/Out  calls on an agent's second extension: now counted
 *   anonymousIn      inbound direct rings from an anonymous caller: now kept
 *   sameRootIn/Out   extra legs of one call: now one call, not several
 *   unrosteredOut    dials to an unrostered extension: now internal
 * Same engine, same day filter, same window as the build; writes nothing.
 * Logs one line per counter (total, % of the day's events, the top agents and
 * sample call ids to look up in Raw Data) and returns the summary.
 */
function diagnoseDirectCallCounting() {
  const ss = SpreadsheetApp.openById(getTargetSsId_());
  const rawSheet = ss.getSheetByName('Raw Data');
  const configSheet = ss.getSheetByName('DO NOT EDIT!');
  if (!rawSheet || !configSheet) throw new Error('Raw Data or DO NOT EDIT! sheet missing.');
  const raw = rawSheet.getDataRange().getDisplayValues();
  if (raw.length < 2) { dcLog_('diagnoseDirectCallCounting: Raw Data empty.'); return { result: 'INCONCLUSIVE (Raw Data empty)' }; }
  // The build's own day rule (RB-2): the day most rows are on, legs from other
  // dates dropped (S2C-3). (It used to be the first dated row's date, which a
  // carry-over leg from the day before turned into a one-leg "day".)
  const toIso = function (ds) { return (typeof parseDateForNeon === 'function') ? parseDateForNeon(ds) : ds; };
  let dateStr = '';
  for (let i = 1; i < raw.length && !dateStr; i++) dateStr = dcDateStr_(raw[i][2]);
  const majority = dcGridMajorityDay_(raw);
  const isoDate = majority ? majority.iso : toIso(dateStr);
  const dayRows = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    const ds = dcDateStr_(raw[i] && raw[i][2]);
    if (!ds || toIso(ds) === isoDate) dayRows.push(raw[i]);
  }
  const maps = dcBuildExtMaps_(configSheet);
  const res = computeDirectCallMetrics(dayRows, maps, { diagnose: true });
  const d = res.meta.diag;
  const ib = d.scale.ibEvents, ob = d.scale.obEvents;
  const pct = function (n, of) { return of ? Math.round(n / of * 1000) / 10 + '%' : 'n/a'; };
  const line = function (key, what, of, ofLabel) {
    const c = d[key];
    dcLog_('[direct-diag] %s: %s (%s of %s) -- %s', key, String(c.total), pct(c.total, of), ofLabel, what);
    c.agents.slice(0, 5).forEach(function (a) {
      dcLog_('[direct-diag]   %s: %s  e.g. %s', a.agent, String(a.n), a.samples.join(', '));
    });
  };
  dcLog_('[direct-diag] %s: %s in-window inbound direct events, %s outbound (the build counts these).', isoDate || dateStr, String(ib), String(ob));
  line('internalDial', 'coworker dials logged Internal (to an extension) -- since D2 the caller\'s internal outbound call', ob, 'outbound');
  const sh = d.internalDialShape;
  if (sh && sh.legs) {
    const n = sh.legs;
    dcLog_('[direct-diag]   Internal legs from agents: %s, of which dials to an extension %s (counted above) and %s not dials (recording / voicemail / forking / a named feature -- never counted)',
      String(n), String(sh.dials), String(n - sh.dials));
    dcLog_('[direct-diag]   Internal legs reach: a roster agent %s (%s), the caller\'s own extension %s (%s), an unrostered extension %s (%s), '
      + 'an outside number %s (%s), blank / a name %s (%s); talked (talk > 0) %s (%s)',
      String(sh.rosterAgent), pct(sh.rosterAgent, n), String(sh.self), pct(sh.self, n), String(sh.unrosteredExt), pct(sh.unrosteredExt, n),
      String(sh.outsideNumber), pct(sh.outsideNumber, n), String(sh.other), pct(sh.other, n), String(sh.talked), pct(sh.talked, n));
    dcLog_('[direct-diag]   Internal legs top callees: %s', sh.topCallees.map(function (t) { return t.v + ' x' + t.n; }).join('; '));
    dcLog_('[direct-diag]   Internal legs top contexts: %s', sh.topContexts.map(function (t) { return t.v + ' x' + t.n; }).join('; '));
  }
  line('secondExtIn', 'inbound rings on an agent\'s second extension -- counted since D2', ib, 'inbound');
  line('secondExtOut', 'dials from an agent\'s second extension -- counted since D2', ob, 'outbound');
  line('anonymousIn', 'inbound direct rings from an anonymous caller -- kept since D2 (external)', ib, 'inbound');
  line('sameRootIn', 'extra legs of one inbound call -- one call since D2 (a pre-D2 build counted each)', ib, 'inbound');
  line('sameRootOut', 'extra legs of one outbound call -- one call since D2', ob, 'outbound');
  line('unrosteredOut', 'dials to an extension no roster names -- internal since D2 (pre-D2: external)', ob, 'outbound');
  const total = ['internalDial', 'secondExtIn', 'secondExtOut', 'anonymousIn', 'sameRootIn', 'sameRootOut', 'unrosteredOut']
    .reduce(function (t, k) { return t + d[k].total; }, 0);
  const out = { result: (ib + ob ? 'OK' : 'INCONCLUSIVE (no in-window direct events)') + ' ' + (isoDate || dateStr)
    + ': ' + total + ' events counted differently since D2, vs ' + (ib + ob) + ' counted -- the size of a re-import of a pre-D2 date like this one', date: isoDate || dateStr, diag: d };
  dcLog_('[direct-diag] %s', out.result);
  return out;
}

/**
 * DCA-1 step 0 (owner 2026-10-27; Operator State #83): READ-ONLY. For every
 * leg the Direct build credits to a roster agent by EXTENSION, does the name
 * 8x8 put on that side of the leg (CALLEE_NAME when the agent is called,
 * CALLER_NAME when they call) agree? Run over the held Call_Legs_* tabs:
 * `dateIso` = one date, 'all' = every held date, blank = the latest.
 * Logs, per date and in total: legs whose name matches / is blank / is another
 * roster cell on the same extension / is somebody else (credited to NO ONE
 * since DCA-1); each mismatch with its extension, the roster name it used to
 * go to, the 8x8 name, a count and sample call ids; every extension listed in
 * more than one roster cell; the blank-name legs on extensions that also
 * showed another person's name (the case the owner decides from this); and
 * the Direct report rows that change (pre-DCA-1 rule vs now). Employee names
 * and call ids only -- never a phone number. Writes nothing.
 */
/** Editor-run: every held date (the Run picker can't pass 'all'). */
function diagnoseDirectCallAttributionAllDates() { return diagnoseDirectCallAttribution('all'); }

/**
 * AC-6 + DCA-2 (owner 2026-11-04): editor-run. Rebuilds Direct Call History
 * (sheet + Neon direct_call_history) AND the per-call direct_calls list for
 * every held Call_Legs_* date from `fromIso` on (default: all held), with
 * today's rules -- so DCA-1/DCA-2 attribution and the Direct tab reach the
 * ~14 days the workbook still holds. Older dates need their source
 * re-imported (Operator State #56). Stops at a 4.5-minute budget and logs the
 * date to resume from. Writes only what the daily import writes.
 */
function rebuildDirectCallHeldDates(fromIso) {
  const target = SpreadsheetApp.openById(getTargetSsId_());
  const configSheet = target.getSheetByName('DO NOT EDIT!');
  if (!configSheet) { dcLog_('[direct-rebuild] "DO NOT EDIT!" not found in the CDR Report spreadsheet.'); return null; }
  const tabs = [];
  SpreadsheetApp.getActiveSpreadsheet().getSheets().forEach(function (sh) {
    const m = sh.getName().match(/^Call_Legs_(\d{4}-\d{2}-\d{2})$/i);
    if (m && (!fromIso || m[1] >= fromIso)) tabs.push({ iso: m[1], sheet: sh });
  });
  tabs.sort(function (a, b) { return a.iso < b.iso ? -1 : 1; });
  const t0 = Date.now(), done = [];
  for (let i = 0; i < tabs.length; i++) {
    if (Date.now() - t0 > 4.5 * 60 * 1000) {
      dcLog_('[direct-rebuild] stopped at the time budget -- run rebuildDirectCallHeldDates("%s") to continue.', tabs[i].iso);
      break;
    }
    const p = tabs[i].iso.split('-');
    const dateObj = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12, 0, 0);
    try {
      const grid = tabs[i].sheet.getDataRange().getDisplayValues();
      if (grid.length < 2) continue;
      const r = buildDirectCallFromRaw_(target, grid, configSheet, { expectedDate: dateObj });
      const neon = r.neon || {};
      dcLog_('[direct-rebuild] %s: %s agent row(s), %s direct call(s) listed, neon=%s',
        tabs[i].iso, String(r.wrote), String(neon.events != null ? neon.events : 0),
        neon.unreachable ? 'unreachable' : (neon.error ? 'error: ' + neon.error : 'ok'));
      done.push(tabs[i].iso);
    } catch (e) {
      dcLog_('[direct-rebuild] %s failed: %s', tabs[i].iso, e && e.message ? e.message : e);
    }
  }
  dcLog_('[direct-rebuild] rebuilt %s of %s held date(s).', String(done.length), String(tabs.length));
  return { rebuilt: done, held: tabs.length };
}

function diagnoseDirectCallAttribution(dateIso) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheets = [];
  ss.getSheets().forEach(function (sh) {
    const m = sh.getName().match(/^Call_Legs_(\d{4}-\d{2}-\d{2})$/i);
    if (m) sheets.push({ iso: m[1], sheet: sh });
  });
  sheets.sort(function (a, b) { return a.iso < b.iso ? -1 : 1; });
  if (dateIso && dateIso !== 'all') sheets = sheets.filter(function (x) { return x.iso === dateIso; });
  else if (!dateIso) sheets = sheets.slice(-1);
  if (!sheets.length) { dcLog_('[direct-attr] no Call_Legs sheet for %s.', dateIso || '(latest)'); return { result: 'INCONCLUSIVE (no Call_Legs sheet)' }; }
  const cfg = SpreadsheetApp.openById(getTargetSsId_()).getSheetByName('DO NOT EDIT!');
  if (!cfg) throw new Error('DO NOT EDIT! sheet missing.');
  const maps = dcBuildExtMaps_(cfg);
  const res = dcAttributionAcrossDays_(sheets.map(function (x) {
    return { iso: x.iso, grid: x.sheet.getDataRange().getDisplayValues() };
  }), maps);
  dcLogAttribution_(res);
  return res;
}

/** PURE. Runs the build twice per day (now / pre-DCA-1) and folds the results. */
function dcAttributionAcrossDays_(days, maps) {
  const toIso = function (ds) {
    if (typeof parseDateForNeon === 'function') return parseDateForNeon(ds);
    const m = String(ds || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    return m ? m[3] + '-' + ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2) : ds;
  };
  const tot = { days: [], match: 0, blank: 0, otherCell: 0, mismatch: 0, blankUnconfirmed: 0, mismatches: {}, moved: {}, blankExt: {},
                blankUnconfirmedBy: {}, change: {}, named: 0, namedUnlisted: 0, blankNamed: 0, reassigned: {} };
  const events = function (r) {
    return r.ib_int_answered + r.ib_int_missed_free + r.ib_int_missed_busy + r.ib_ext_answered + r.ib_ext_missed_free
      + r.ib_ext_missed_busy + r.ob_int_total + r.ob_ext_total;
  };
  const fold = function (into, list) {
    list.forEach(function (e) {
      const k = e.ext + '|' + e.rosterName + '|' + e.legName + '|' + (e.to || '');
      const t = into[k] || (into[k] = { ext: e.ext, rosterName: e.rosterName, legName: e.legName, to: e.to, n: 0, samples: [] });
      t.n += e.n;
      e.samples.forEach(function (c) { if (t.samples.length < 5 && t.samples.indexOf(c) === -1) t.samples.push(c); });
    });
  };
  days.forEach(function (d) {
    const grid = d.grid || [];
    // The build's day rule: only legs dated on the tab's date (S2C-3).
    const rows = [grid[0] || []];
    for (let i = 1; i < grid.length; i++) {
      const ds = dcDateStr_(grid[i] && grid[i][2]);
      if (!ds || toIso(ds) === d.iso) rows.push(grid[i]);
    }
    const now = computeDirectCallMetrics(rows, maps, {});
    const was = computeDirectCallMetrics(rows, maps, { extOnly: true });
    const at = now.meta.attribution;
    tot.days.push({ iso: d.iso, match: at.match, blank: at.blank, otherCell: at.otherCell, mismatch: at.mismatch,
                    blankUnconfirmed: at.blankUnconfirmed || 0,
                    named: (at.named || 0) + (at.namedUnlisted || 0) + (at.blankNamed || 0) });
    ['match', 'blank', 'otherCell', 'mismatch', 'blankUnconfirmed', 'named', 'namedUnlisted', 'blankNamed'].forEach(function (k) { tot[k] += at[k] || 0; });
    (at.blankUnconfirmedBy || []).forEach(function (e) {   // DCA-2
      const k = e.ext + '|' + e.rosterName;
      const t = tot.blankUnconfirmedBy[k] || (tot.blankUnconfirmedBy[k] = { ext: e.ext, rosterName: e.rosterName, n: 0, samples: [] });
      t.n += e.n;
      e.samples.forEach(function (c) { if (t.samples.length < 5 && t.samples.indexOf(c) === -1) t.samples.push(c); });
    });
    fold(tot.mismatches, at.mismatches);
    fold(tot.moved, at.moved);
    fold(tot.reassigned, at.reassigned || []);
    Object.keys(at.blankExt).forEach(function (e) { tot.blankExt[e] = (tot.blankExt[e] || 0) + at.blankExt[e]; });
    const key = function (r) { return r.agent + ' (' + (r.dept || '?') + ')'; };
    was.rows.forEach(function (r) { const c = tot.change[key(r)] || (tot.change[key(r)] = { was: 0, now: 0 }); c.was += events(r); });
    now.rows.forEach(function (r) { const c = tot.change[key(r)] || (tot.change[key(r)] = { was: 0, now: 0 }); c.now += events(r); });
  });
  const list = function (o) { return Object.keys(o).map(function (k) { return o[k]; }).sort(function (x, y) { return y.n - x.n || (x.ext < y.ext ? -1 : 1); }); };
  tot.mismatches = list(tot.mismatches);
  tot.moved = list(tot.moved);
  tot.reassigned = list(tot.reassigned);
  tot.blankUnconfirmedBy = list(tot.blankUnconfirmedBy);
  tot.changes = Object.keys(tot.change).filter(function (k) { return tot.change[k].was !== tot.change[k].now; })
    .map(function (k) { return { agent: k, was: tot.change[k].was, now: tot.change[k].now }; })
    .sort(function (x, y) { return Math.abs(y.was - y.now) - Math.abs(x.was - x.now) || (x.agent < y.agent ? -1 : 1); });
  delete tot.change;
  // Extensions listed in more than one roster cell (distinct names).
  tot.shared = Object.keys((maps && maps.extCands) || {}).map(function (e) {
    const names = maps.extCands[e].map(function (c) { return c.name + ' (' + c.dept + ')'; });
    const distinct = {}; maps.extCands[e].forEach(function (c) { distinct[c.name] = true; });
    return { ext: e, names: names, people: Object.keys(distinct).length };
  }).filter(function (x) { return x.people > 1; }).sort(function (x, y) { return x.ext < y.ext ? -1 : 1; });
  // The blank-name legs the owner's fallback decision affects: on an
  // extension that ALSO showed another person's name.
  const contested = {};
  tot.mismatches.forEach(function (m) { contested[m.ext] = true; });
  tot.blankOnContested = Object.keys(contested).filter(function (e) { return tot.blankExt[e]; })
    .map(function (e) { return { ext: e, n: tot.blankExt[e] }; }).sort(function (x, y) { return y.n - x.n; });
  return tot;
}

function dcLogAttribution_(t) {
  const n = function (v) { return String(Math.round(Number(v) || 0)); };
  const byName = (t.named || 0) + (t.namedUnlisted || 0) + (t.blankNamed || 0);   // DCA-3
  const all = t.match + t.blank + t.otherCell + t.mismatch + (t.blankUnconfirmed || 0) + byName;
  const pct = function (v) { return all ? (Math.round(v / all * 1000) / 10) + '%' : '0%'; };
  const nm = function (v) { return dcMaskPhonesInText_(v); };
  t.days.forEach(function (d) {
    dcLog_('[direct-attr] %s: name matches %s, no name %s, no name and the extension never named its roster person that day (credited to no one, DCA-2) %s, another roster cell %s, the roster person 8x8 names (DCA-3) %s, somebody not on the roster (credited to no one) %s',
      d.iso, n(d.match), n(d.blank), n(d.blankUnconfirmed), n(d.otherCell), n(d.named), n(d.mismatch));
  });
  dcLog_('[direct-attr] TOTAL over %s date(s): %s agent-side legs -- name matches %s (%s), no name %s (%s), '
    + 'no name and unconfirmed that day %s (%s), another roster cell on the same extension %s (%s), '
    + 'credited to the roster person 8x8 names %s (%s; reassigned extension %s, extension no cell lists %s, unnamed on an extension that named them %s), '
    + 'somebody not on the roster %s (%s).',
    n(t.days.length), n(all), n(t.match), pct(t.match), n(t.blank), pct(t.blank), n(t.blankUnconfirmed || 0), pct(t.blankUnconfirmed || 0),
    n(t.otherCell), pct(t.otherCell), n(byName), pct(byName), n(t.named || 0), n(t.namedUnlisted || 0), n(t.blankNamed || 0),
    n(t.mismatch), pct(t.mismatch));
  dcLog_('[direct-attr] extensions listed in more than one roster cell: %s', t.shared.length
    ? t.shared.map(function (x) { return x.ext + ': ' + x.names.map(nm).join(' / '); }).join('; ') : 'none');
  dcLog_('[direct-attr] NO NAME, extension never named its roster person that day (DCA-2: credited to no one; before, to the roster name): %s', n(t.blankUnconfirmed || 0));
  (t.blankUnconfirmedBy || []).slice(0, 25).forEach(function (m) {
    dcLog_('[direct-attr]   ext %s -- roster %s: %s leg(s), e.g. %s', m.ext, nm(m.rosterName), n(m.n), m.samples.join(', '));
  });
  if ((t.reassigned || []).length) {
    dcLog_('[direct-attr] REASSIGNED: 8x8 names a roster person the extension\'s cell does not list (DCA-3: credited to that person): %s', n(byName));
    t.reassigned.slice(0, 25).forEach(function (m) {
      dcLog_('[direct-attr]   ext %s -- listed under %s, 8x8 says %s, credited to %s: %s leg(s) e.g. %s', m.ext, nm(m.rosterName || '(no cell)'),
        nm(m.legName), nm(m.to), n(m.n), m.samples.join(', '));
    });
  }
  dcLog_('[direct-attr] SOMEBODY ELSE, not on the roster (credited to no one; before DCA-1, to the roster name): %s', n(t.mismatch));
  t.mismatches.slice(0, 25).forEach(function (m) {
    dcLog_('[direct-attr]   ext %s -- roster %s, 8x8 says %s: %s leg(s) e.g. %s', m.ext, nm(m.rosterName), nm(m.legName), n(m.n), m.samples.join(', '));
  });
  if (t.moved.length) {
    dcLog_('[direct-attr] ANOTHER ROSTER CELL on the same extension (since DCA-1 credited to that person): %s', n(t.otherCell));
    t.moved.slice(0, 15).forEach(function (m) {
      dcLog_('[direct-attr]   ext %s -- was %s, now %s: %s leg(s) e.g. %s', m.ext, nm(m.rosterName), nm(m.to), n(m.n), m.samples.join(', '));
    });
  }
  dcLog_('[direct-attr] NO NAME on extensions that also showed somebody else (still credited by extension -- the case to decide): %s',
    t.blankOnContested.length ? t.blankOnContested.map(function (x) { return 'ext ' + x.ext + ' x' + n(x.n); }).join(', ') : 'none');
  dcLog_('[direct-attr] Direct report rows that change (calls in the work window, before -> since DCA-1): %s',
    t.changes.length ? n(t.changes.length) + ' row(s)' : 'none');
  t.changes.slice(0, 25).forEach(function (c) {
    dcLog_('[direct-attr]   %s: %s -> %s', nm(c.agent), n(c.was), n(c.now));
  });
}

/**
 * Logs a few example events per designation so the operator can look each one
 * up in Raw Data by CALL_ID and confirm the classification (esp. missed_busy,
 * which also names the blocking call + its busy window). Verification aid only.
 */
/** F-26: last-4 mask for phone-like values in LOG output. Raw external
 * numbers must not land in Stackdriver (the one PII surface the
 * HMAC-before-Neon / journey-masking discipline skipped). Extensions
 * (short digit strings) pass through -- they're needed for verification.
 * The variant with a regex masks numbers EMBEDDED in a free-text string
 * (the busy-blocker "caller->callee" info). */
function dcMaskPhone_(v) {
  var s = String(v == null ? '' : v);
  var digits = s.replace(/\D/g, '');
  if (digits.length < 7) return s;   // ext / short token -- not a phone
  return '\u2026' + digits.slice(-4);
}
function dcMaskPhonesInText_(v) {
  return String(v == null ? '' : v).replace(/\+?\d[\d\-() ]{5,}\d/g, function (m) {
    return dcMaskPhone_(m);
  });
}

function dcLogSamples_(samples) {
  if (!samples) return;
  const order = ['ib_answered', 'ib_missed_free', 'ib_missed_busy', 'ob_connected', 'ob_not_connected'];
  const label = {
    ib_answered: 'INBOUND ANSWERED', ib_missed_free: 'INBOUND MISSED (free -- counts against agent)',
    ib_missed_busy: 'INBOUND MISSED (busy -- EXCLUDED, was on another call)',
    ob_connected: 'OUTBOUND CONNECTED', ob_not_connected: 'OUTBOUND NOT CONNECTED (callee no-answer)',
  };
  dcLog_('--- Direct-call samples (look up CALL_ID in Raw Data to verify) ---');
  order.forEach(function (cat) {
    const list = samples[cat] || [];
    dcLog_('[' + label[cat] + '] ' + list.length + ' example(s):');
    list.forEach(function (s) {
      // F-26: mask phone-like values (callers, outbound callees, and any
      // number embedded in the blocker info) -- call id + ext + last-4 is
      // enough to look the event up in Raw Data and verify.
      if (cat === 'ib_missed_busy') {
        dcLog_('   call %s | %s (%s) | rang %s-%s from %s -> ext %s | BLOCKED BY call %s [%s] %s',
          s.callId, s.agent, s.dir, s.ringStart, s.ringEnd, dcMaskPhone_(s.caller), s.callee, s.blockedByCallId, s.blockerWindow, dcMaskPhonesInText_(s.blockerInfo));
      } else if (cat === 'ib_missed_free') {
        dcLog_('   call %s | %s (%s) | rang %s from %s -> ext %s', s.callId, s.agent, s.dir, s.ringStart, dcMaskPhone_(s.caller), s.callee);
      } else if (cat === 'ib_answered') {
        dcLog_('   call %s | %s (%s) | %s from %s -> ext %s | talk %ss', s.callId, s.agent, s.dir, s.time, dcMaskPhone_(s.caller), s.callee, s.talkSec);
      } else if (cat === 'ob_connected') {
        dcLog_('   call %s | %s (%s) | %s ext %s -> %s | talk %ss', s.callId, s.agent, s.dir, s.time, dcMaskPhone_(s.caller), dcMaskPhone_(s.callee), s.talkSec);
      } else {
        dcLog_('   call %s | %s (%s) | %s ext %s -> %s', s.callId, s.agent, s.dir, s.time, dcMaskPhone_(s.caller), dcMaskPhone_(s.callee));
      }
    });
  });
}

function dcMonthYearFromDate_(dateStr) {
  const p = String(dateStr || '').split('/');
  if (p.length < 3) return '';
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
  const mi = (parseInt(p[0], 10) || 1) - 1;
  return (months[mi] || '') + ' ' + p[2];
}

/** Best-effort Pipeline Health row (reuses the existing writer if present). */
function dcLogPipelineHealth_(ss, status, rows, ms, notes) {
  try {
    // F-50: logPipelineHealth_ (buildDQEHistoricalData.js) takes (ss, EVENT
    // OBJECT) -- the old positional call passed 'directBuild' as the event,
    // so every field read as undefined and the row wrote with empty
    // Step/Status/Rows/Notes (a timestamp-only row; the INV-44 `directBuild`
    // step never actually appeared).
    if (typeof logPipelineHealth_ === 'function') {
      logPipelineHealth_(ss, { step: 'directBuild', status: status, rows: rows, durationMs: ms, notes: notes });
      return;
    }
    const sh = ss.getSheetByName('Pipeline Health');
    if (!sh) return;
    sh.appendRow([new Date(), 'directBuild', status, rows, ms, notes]);
  } catch (e) { /* best-effort */ }
}

// ── DID-0 (owner 2026-11-06): did the outside caller dial the agent's OWN
// number, or a main line routed to their extension? ─────────────────────────
// Read-only. For every outside call the Direct report counts as a person's
// direct inbound call (the SAME events, DCA-1..5 credit), the call's legs
// say how it got there:
//   straight  -- the first leg rang THIS agent (no menu, no colleague first):
//                the caller dialed a number that reaches them directly;
//   menu      -- a phone-menu / auto-attendant node rang first (a leg with no
//                Departments value, not a queue, not a person, not a
//                recording) -- a main line, then the menu sent it on;
//   colleague -- another PERSON's leg rang first (a transfer or forward);
// plus the call's dial-in number (col Q, the company number dialed). Per
// dial-in number: how its calls arrived and who they rang, with a verdict --
// "main line" when menu calls are at least half, "<agent>'s direct line" when
// at least DC_DID_MIN_CALLS_ calls arrived straight and DC_DID_OWNER_SHARE_ of
// them rang one agent, else "unclear". Per agent: their outside direct calls
// via their own direct line / another number dialed straight / a menu / a
// colleague / no dial-in. Dial-in numbers are COMPANY numbers (they are stored
// plain in inbound_calls); the caller's number is never read or logged.
var DC_DIAL_COL_ = { DIAL_IN: 16, DEPARTMENTS: 36 };
var DC_DID_MIN_CALLS_ = 3;
var DC_DID_OWNER_SHARE_ = 0.8;

/**
 * PURE. DID-1: how each OUTSIDE inbound direct call reached its agent, from
 * the day's legs -- { '<callId>|<agent>': { dialIn, via } } where via is
 * 'straight' (no menu step before the agent's first leg), 'menu' (a main line's
 * phone menu: the caller typed the extension -- owner 2026-11-06, no menu
 * option routes to one person) or 'colleague'. The grid must reach the
 * Departments column (36): without it every pre-agent leg would read as a menu
 * step, so a narrower grid yields {} (unknown) rather than a guess.
 */
function dcDialInAnnotate_(rows, events, maps, resolveLeg) {
  const out = {};
  if (!rows || rows.length < 2) return out;
  // CAP-6: who a leg is credited to is the BUILD's answer (resolveLeg, from
  // computeDirectCallMetrics). The raw extension rule below it credited a
  // blank-named leg on a reassigned extension to the FORMER employee, so the
  // agent's own leg read as "a colleague rang first" and a call that reached
  // them straight was stored via='colleague'.
  const resolve = (typeof resolveLeg === 'function') ? resolveLeg
    : function (ext, legName) { return dcResolveAgent_(ext, legName, maps); };
  let width = 0;
  for (let i = 0; i < Math.min(rows.length, 50); i++) width = Math.max(width, (rows[i] || []).length);
  if (width <= DC_DIAL_COL_.DEPARTMENTS) return out;
  const C = { CALL_ID: 0, START: 2, CALLEE: 10, CALLEE_NAME: 11, CTX: 13, PARENT: 14 };
  const realParent = function (p) { p = dcClean_(p); return (p && p.toUpperCase() !== 'N/A') ? p : ''; };
  const byRoot = {};
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const cid = dcClean_(r[C.CALL_ID]);
    if (!cid) continue;
    const root = realParent(r[C.PARENT]) || cid;
    (byRoot[root] = byRoot[root] || []).push(r);
  }
  (events || []).forEach(function (ev) {
    if (ev.direction !== 'in' || ev.side !== 'ext') return;
    const legs = (byRoot[ev.callId] || []).slice().sort(function (a, b) {
      return (dcStartSec_(a[C.START]) || 0) - (dcStartSec_(b[C.START]) || 0);
    });
    let dialIn = '';
    for (let j = 0; j < legs.length && !dialIn; j++) dialIn = String(legs[j][DC_DIAL_COL_.DIAL_IN] == null ? '' : legs[j][DC_DIAL_COL_.DIAL_IN]).replace(/\D/g, '');
    // The agent's first leg: its callee resolves to them (the build's own rule).
    let mine = -1;
    for (let j = 0; j < legs.length; j++) {
      const callee = dcClean_(legs[j][C.CALLEE]);
      const res2 = resolve(callee, legs[j][C.CALLEE_NAME]);
      if (res2.agent && res2.agent.name === ev.agent) { mine = j; break; }
    }
    let how = 'straight';
    for (let j = 0; j < (mine < 0 ? legs.length : mine); j++) {
      const l = legs[j];
      const callee = dcClean_(l[C.CALLEE]), name = dcClean_(l[C.CALLEE_NAME]);
      const digits = callee.replace(/\D/g, '');
      if (digits.length >= 10) continue;                                   // the caller's own side
      if (/A_Q_|queue|backup csr/i.test(name) || /queue/i.test(String(l[C.CTX] || ''))) continue;
      if (/record|voice ?mail/i.test(name)) continue;
      const dept = dcClean_(l[DC_DIAL_COL_.DEPARTMENTS]);
      const r3 = resolve(callee, name);
      if (r3.agent && r3.agent.name !== ev.agent) { how = 'colleague'; break; }
      if (!dept || dept.toUpperCase() === 'N/A') { how = 'menu'; break; }
    }
    out[ev.callId + '|' + ev.agent] = { dialIn: dialIn, via: how };
  });
  return out;
}

/** PURE. One day's straight / menu / colleague reading of every outside direct call (DID-0). */
function dcDialInForDay_(rows, maps) {
  const res = computeDirectCallMetrics(rows, maps, { events: true });
  const ann = dcDialInAnnotate_(rows, res.events || [], maps, res.resolveLeg);   // CAP-6
  const out = [];
  (res.events || []).forEach(function (ev) {
    if (ev.direction !== 'in' || ev.side !== 'ext') return;
    const a = ann[ev.callId + '|' + ev.agent] || { dialIn: '', via: 'straight' };
    out.push({ callId: ev.callId, agent: ev.agent, dept: ev.dept, dialIn: a.dialIn, how: a.via, inWindow: ev.inWindow, outcome: ev.outcome });
  });
  return out;
}

/** PURE. Folds the days into per-number and per-agent tallies with verdicts and samples. */
function dcDialInAcrossDays_(days, maps) {
  const toIso = function (ds) {
    if (typeof parseDateForNeon === 'function') return parseDateForNeon(ds);
    const m = String(ds || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    return m ? m[3] + '-' + ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2) : ds;
  };
  const calls = [];
  const perDay = [];
  days.forEach(function (d) {
    const grid = d.grid || [];
    const rows = [grid[0] || []];
    for (let i = 1; i < grid.length; i++) {
      const ds = dcDateStr_(grid[i] && grid[i][2]);
      if (!ds || toIso(ds) === d.iso) rows.push(grid[i]);
    }
    const day = dcDialInForDay_(rows, maps);
    // Without the Departments column every non-person leg would read as a menu.
    const c = { iso: d.iso, total: day.length, straight: 0, menu: 0, colleague: 0, noDialIn: 0,
                noDeptColumn: !((grid[0] || []).length > DC_DIAL_COL_.DEPARTMENTS) };
    day.forEach(function (x) { c[x.how]++; if (!x.dialIn) c.noDialIn++; calls.push(x); });
    perDay.push(c);
  });
  const sample = function (arr, id) { if (arr.length < 5 && arr.indexOf(id) === -1) arr.push(id); };
  // Per dial-in number.
  const nums = {};
  calls.forEach(function (x) {
    if (!x.dialIn) return;
    const n = nums[x.dialIn] || (nums[x.dialIn] = { number: x.dialIn, calls: 0, straight: 0, menu: 0, colleague: 0, agents: {}, samples: [] });
    n.calls++; n[x.how]++;
    if (x.how === 'straight') n.agents[x.agent] = (n.agents[x.agent] || 0) + 1;
    sample(n.samples, x.callId);
  });
  const numbers = Object.keys(nums).map(function (k) {
    const n = nums[k];
    const top = Object.keys(n.agents).sort(function (a, b) { return n.agents[b] - n.agents[a] || (a < b ? -1 : 1); })[0] || null;
    const topN = top ? n.agents[top] : 0;
    let verdict = 'unclear', owner = null;
    if (n.menu * 2 >= n.calls) verdict = 'main line';
    else if (n.straight >= DC_DID_MIN_CALLS_ && topN >= DC_DID_OWNER_SHARE_ * n.straight) { verdict = 'direct line'; owner = top; }
    return { number: n.number, calls: n.calls, straight: n.straight, menu: n.menu, colleague: n.colleague,
             agents: Object.keys(n.agents).length, top: top, topCalls: topN, verdict: verdict, owner: owner, samples: n.samples };
  }).sort(function (a, b) { return b.calls - a.calls || (a.number < b.number ? -1 : 1); });
  const owners = {};
  numbers.forEach(function (n) { if (n.owner) (owners[n.owner] = owners[n.owner] || []).push(n.number); });
  const verdictOf = {};
  numbers.forEach(function (n) { verdictOf[n.number] = n; });
  // Per agent.
  const ag = {};
  calls.forEach(function (x) {
    const a = ag[x.agent] || (ag[x.agent] = { agent: x.agent, dept: x.dept, calls: 0, ownLine: 0, otherStraight: 0, menu: 0, colleague: 0, noDialIn: 0,
      samples: { ownLine: [], otherStraight: [], menu: [], colleague: [], noDialIn: [] } });
    a.calls++;
    let k;
    if (x.how === 'menu') k = 'menu';
    else if (x.how === 'colleague') k = 'colleague';
    else if (!x.dialIn) k = 'noDialIn';
    else k = (verdictOf[x.dialIn] && verdictOf[x.dialIn].owner === x.agent) ? 'ownLine' : 'otherStraight';
    a[k]++;
    sample(a.samples[k], x.callId);
  });
  const agents = Object.keys(ag).map(function (k) { const a = ag[k]; a.lines = owners[a.agent] || []; return a; })
    .sort(function (a, b) { return b.calls - a.calls || (a.agent < b.agent ? -1 : 1); });
  const tot = { calls: calls.length, straight: 0, menu: 0, colleague: 0, noDialIn: 0 };
  calls.forEach(function (x) { tot[x.how]++; if (!x.dialIn) tot.noDialIn++; });
  return { days: perDay, total: tot, numbers: numbers, agents: agents };
}

function dcLogDialIn_(t) {
  const n = function (v) { return String(Math.round(Number(v) || 0)); };
  const pct = function (v, d) { return d ? Math.round(v / d * 100) + '%' : '0%'; };
  t.days.forEach(function (d) {
    dcLog_('[direct-dialin] %s: %s outside direct call(s) -- straight to the agent %s, through a phone menu %s, through a colleague %s, no dial-in number %s%s',
      d.iso, n(d.total), n(d.straight), n(d.menu), n(d.colleague), n(d.noDialIn),
      d.noDeptColumn ? ' -- WARNING: this tab has no Departments column, so "menu" cannot be told from a person here' : '');
  });
  const T = t.total;
  dcLog_('[direct-dialin] TOTAL over %s date(s): %s outside calls the Direct report credits to a person -- straight to them %s (%s), through a phone menu %s (%s), through a colleague %s (%s); no dial-in number on %s.',
    n(t.days.length), n(T.calls), n(T.straight), pct(T.straight, T.calls), n(T.menu), pct(T.menu, T.calls), n(T.colleague), pct(T.colleague, T.calls), n(T.noDialIn));
  dcLog_('[direct-dialin] BY NUMBER DIALED (company numbers; "direct line" = %s+ calls arrived straight and %s%% of them rang one person; "main line" = at least half came through a menu):',
    n(DC_DID_MIN_CALLS_), n(DC_DID_OWNER_SHARE_ * 100));
  t.numbers.slice(0, 60).forEach(function (x) {
    dcLog_('[direct-dialin]   %s: %s call(s) -- straight %s, menu %s, colleague %s; rang %s person(s) straight%s -> %s; e.g. %s',
      x.number, n(x.calls), n(x.straight), n(x.menu), n(x.colleague), n(x.agents),
      x.top ? ' (most: ' + x.top + ' ' + n(x.topCalls) + ')' : '', x.verdict + (x.owner ? ' of ' + x.owner : ''), x.samples.join(', '));
  });
  dcLog_('[direct-dialin] BY AGENT (their outside direct calls): via their own direct line / another number dialed straight / a phone menu / a colleague / no dial-in:');
  t.agents.slice(0, 80).forEach(function (a) {
    const s = a.samples;
    const eg = ['ownLine', 'otherStraight', 'menu', 'colleague', 'noDialIn'].filter(function (k) { return s[k].length; })
      .map(function (k) { return k + ': ' + s[k].slice(0, 2).join(' '); }).join(' | ');
    dcLog_('[direct-dialin]   %s (%s): %s -- own line %s, other number %s, menu %s, colleague %s, none %s%s%s',
      a.agent, a.dept, n(a.calls), n(a.ownLine), n(a.otherStraight), n(a.menu), n(a.colleague), n(a.noDialIn),
      a.lines.length ? '; their line(s): ' + a.lines.join(', ') : '; no direct line found', eg ? '; e.g. ' + eg : '');
  });
}

/**
 * DID-0 (owner 2026-11-06): editor-run, read-only. `dateIso` 'YYYY-MM-DD',
 * 'all' (every held Call_Legs_* tab), or blank = the latest. Logs how the
 * outside calls the Direct report credits to each person reached them -- their
 * own direct number, a main line through a phone menu, or a colleague -- per
 * number dialed and per agent, with sample call ids to check in Raw Data.
 * Operator State #91.
 */
function diagnoseDirectDialIn(dateIso) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheets = [];
  ss.getSheets().forEach(function (sh) {
    const m = sh.getName().match(/^Call_Legs_(\d{4}-\d{2}-\d{2})$/i);
    if (m) sheets.push({ iso: m[1], sheet: sh });
  });
  sheets.sort(function (a, b) { return a.iso < b.iso ? -1 : 1; });
  if (dateIso && dateIso !== 'all') sheets = sheets.filter(function (x) { return x.iso === dateIso; });
  else if (!dateIso) sheets = sheets.slice(-1);
  if (!sheets.length) { dcLog_('[direct-dialin] no Call_Legs sheet for %s.', dateIso || '(latest)'); return { result: 'INCONCLUSIVE (no Call_Legs sheet)' }; }
  const cfg = SpreadsheetApp.openById(getTargetSsId_()).getSheetByName('DO NOT EDIT!');
  if (!cfg) throw new Error('DO NOT EDIT! sheet missing.');
  const res = dcDialInAcrossDays_(sheets.map(function (x) {
    return { iso: x.iso, grid: x.sheet.getDataRange().getDisplayValues() };
  }), dcBuildExtMaps_(cfg));
  dcLogDialIn_(res);
  return res;
}
function diagnoseDirectDialInAllDates() { return diagnoseDirectDialIn('all'); }

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

/** Loose phone check (== isValidPhone). */
function dcIsPhone_(v) {
  if (typeof v === 'number') return true;
  if (!v) return false;
  const s = String(v).replace(/[+,\-() ]/g, '').trim();
  return s !== '' && !isNaN(Number(s));
}

function dcClean_(v) { return String(v == null ? '' : v).trim(); }

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
function computeDirectCallMetrics(rawDisplayData, maps, opts) {
  opts = opts || {};
  const W0   = opts.windowStartSec != null ? opts.windowStartSec : DIRECT_WINDOW_START;
  const W1   = opts.windowEndSec   != null ? opts.windowEndSec   : DIRECT_WINDOW_END;
  const TAIL = opts.wrapupSec      != null ? opts.wrapupSec      : DIRECT_BUSY_WRAPUP_SEC;
  const extToAgent = (maps && maps.extToAgent) || {};
  const exclusions = (maps && maps.exclusions) || new Set();
  const queueExtSet = (maps && maps.queueExtSet) || new Set();

  // Column indices (== the autoImport `idx` + DQE_C layout).
  const C = { CALL_ID: 0, PARENT: 14, START: 2, DIR: 5, TALK: 6, CALLTIME: 7,
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

  // agent -> { dept, occ:[{cid,s,e}], ib:{cid->ev}, ob:{cid->ev} }
  const A = {};
  function ensure(name, dept) {
    if (!A[name]) A[name] = { dept: dept || '', occ: [], ib: {}, ob: {} };
    else if (!A[name].dept && dept) A[name].dept = dept;
    return A[name];
  }

  let droppedNoStart = 0;

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

    const callerAgent = extToAgent[caller];
    const calleeAgent = extToAgent[callee];

    // (1) OCCUPIED intervals -- any leg the agent was ON (talk>0), INCLUDING
    //     queue legs. Not window-filtered: a pre-window call still in progress
    //     makes them busy for an in-window ring. Self-exclusion is by cid.
    if (startSec != null && talk > 0) {
      const occ = { cid: cid, s: startSec, e: startSec + talk + hold, info: dir + ' ' + caller + '->' + callee };
      if (callerAgent && !exclusions.has(callerAgent.name)) ensure(callerAgent.name, callerAgent.dept).occ.push(occ);
      if (calleeAgent && !exclusions.has(calleeAgent.name)) ensure(calleeAgent.name, calleeAgent.dept).occ.push(occ);
    }

    // The WHOLE call belongs to the queue (DQE/QCD) path, not "direct" -- skip
    // every leg of it (occupied was already recorded above, so a queue call
    // the agent answered still makes them busy for a direct miss).
    if (isQueueCall(cid, parent)) continue;

    // (2) INBOUND DIRECT events -- agent is the callee; caller is a real
    //     number/ext that is NOT a queue distributor extension; Incoming
    //     (external) or Internal. One event per cid.
    if (calleeAgent && !exclusions.has(calleeAgent.name) && dcIsPhone_(caller) &&
        !queueExtSet.has(caller) && (dir === 'Incoming' || dir === 'Internal')) {
      const b = ensure(calleeAgent.name, calleeAgent.dept);
      let ev = b.ib[cid];
      if (!ev) { ev = b.ib[cid] = { intExt: dir === 'Internal' ? 'int' : 'ext', start: startSec, ringEnd: null, answered: false, talk: 0, caller: caller, callee: callee }; }
      if (startSec != null && (ev.start == null || startSec < ev.start)) ev.start = startSec;
      const ringEnd = (startSec != null) ? startSec + Math.max(0, dcTimeToSec_(r[C.CALLTIME])) : null;
      if (ringEnd != null && (ev.ringEnd == null || ringEnd > ev.ringEnd)) ev.ringEnd = ringEnd;
      if (answered) { ev.answered = true; ev.talk = Math.max(ev.talk, talk); }
      // (missed flag is implied when no leg answered; classified in pass 2)
    }

    // (3) OUTBOUND DIRECT events -- agent is the caller; Outgoing. Activity only.
    if (callerAgent && !exclusions.has(callerAgent.name) && dir === 'Outgoing') {
      const b = ensure(callerAgent.name, callerAgent.dept);
      let ev = b.ob[cid];
      if (!ev) { ev = b.ob[cid] = { intExt: extToAgent[callee] ? 'int' : 'ext', start: startSec, connected: false, talk: 0, callee: callee }; }
      if (startSec != null && (ev.start == null || startSec < ev.start)) ev.start = startSec;
      if (talk > 0) { ev.connected = true; ev.talk = Math.max(ev.talk, talk); }
    }
  }

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
        const blocker = busyBlocker(a.occ, ring);
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
        addSample('ob_connected', { callId: cid, agent: name, dept: a.dept, dir: k, time: secToHms(ev.start), callee: ev.callee, talkSec: ev.talk });
      } else {
        addSample('ob_not_connected', { callId: cid, agent: name, dept: a.dept, dir: k, time: secToHms(ev.start), callee: ev.callee });
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

  const meta = { agents: rows.length, droppedNoStart: droppedNoStart, missedBusyTotal: missedBusyTotal, missedFreeTotal: missedFreeTotal };
  if (collect) meta.samples = samples;
  return { rows: rows, meta: meta };
}

// -- Config-map builder (mirrors calculateMetricsInMemory's parse) ------------
// Standalone (not a refactor of the legacy function) so this feature can't
// regress the existing CDR Historical build. Reads the DO NOT EDIT! sheet:
// dept headers in row 1 cols F.., roster cells "Name, ext, ext2" below.
function dcBuildExtMaps_(configSheet) {
  const extToAgent = {};
  const queueExtSet = new Set();
  const exclusions = new Set();
  const lastRow = configSheet.getLastRow();
  if (lastRow < 2) return { extToAgent: extToAgent, queueExtSet: queueExtSet, exclusions: exclusions };

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
  const deptHeaders = configSheet.getRange(1, 6, 1, 14).getValues()[0];
  const configRange = configSheet.getRange(2, 6, lastRow - 1, 14).getValues();
  configRange.forEach(function (row) {
    row.forEach(function (cell, cIdx) {
      const s = String(cell);
      if (s.indexOf(',') === -1) return;
      const p = s.split(',');
      if (p.length < 2) return;
      const name = p[0].trim();
      const ext = p[1].trim();
      const dept = deptHeaders[cIdx] || 'Unassigned';
      if (ext) extToAgent[ext] = { name: name, dept: dept };
    });
  });
  return { extToAgent: extToAgent, queueExtSet: queueExtSet, exclusions: exclusions };
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

/** Refresh-in-window write: drop the date's existing rows, append the new ones. */
function dcWriteSheet_(ss, rows, monthYear, dateStr) {
  const sh = dcEnsureSheet_(ss);
  const last = sh.getLastRow();
  const targetIso = dcDateIso_(dateStr);
  if (last > 1 && targetIso) {
    // getDisplayValues, not getValues (see dcDateIso_ above).
    const dateCol = sh.getRange(2, 2, last - 1, 1).getDisplayValues();  // col B = Date
    for (let i = dateCol.length - 1; i >= 0; i--) {
      if (dcDateIso_(dateCol[i][0]) === targetIso) sh.deleteRow(i + 2);
    }
  }
  if (!rows.length) return 0;
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
  return out.length;
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
  const ph = '(' + new Array(18).fill('?').join(',') + ')';
  const sql = 'INSERT INTO direct_call_history (' + DIRECT_CALL_INSERT_COLS + ') VALUES ' +
    rows.map(function () { return ph; }).join(',') +
    ' ON CONFLICT (call_date, department, agent_name) DO UPDATE SET ' +
    DIRECT_CALL_UPDATE_COLS.map(function (c) { return c + ' = EXCLUDED.' + c; }).join(', ') +
    ', updated_at = now()';
  const stmt = conn.prepareStatement(sql);
  let p = 0;
  rows.forEach(function (r) {
    stmt.setString(++p, r.monthYear);
    stmt.setString(++p, r.isoDate);
    stmt.setString(++p, r.dept);
    stmt.setString(++p, r.agent);
    [r.ib_int_answered, r.ib_int_missed_free, r.ib_int_missed_busy, r.ib_int_talk_sec,
     r.ib_ext_answered, r.ib_ext_missed_free, r.ib_ext_missed_busy, r.ib_ext_talk_sec,
     r.ob_int_total, r.ob_int_connected, r.ob_int_talk_sec,
     r.ob_ext_total, r.ob_ext_connected, r.ob_ext_talk_sec].forEach(function (v) { stmt.setInt(++p, v | 0); });
  });
  stmt.execute();
  stmt.close();
  return rows.length;
}

/** Upsert per-agent-day rows for one date. Best-effort; returns a status object. */
function writeDirectCallRowsToNeon_(rows, monthYear, isoDate) {
  if (!rows || !rows.length) return { inserted: 0, skipped: 0 };
  const conn = getReachableNeonConn_();
  if (!conn) { Logger.log('writeDirectCallRowsToNeon_: Neon unreachable -- skipping %s rows.', rows.length); return { inserted: 0, unreachable: true }; }
  conn.setAutoCommit(false);
  try {
    dcEnsureNeonTable_(conn);
    const upsertRows = rows.map(function (r) {
      return Object.assign({ monthYear: monthYear, isoDate: isoDate }, r);
    });
    const n = dcUpsertRows_(conn, upsertRows);
    conn.commit();
    return { inserted: n };
  } catch (e) {
    try { conn.rollback(); } catch (rb) {}
    Logger.log('writeDirectCallRowsToNeon_ failed: ' + (e && e.message ? e.message : e));
    return { inserted: 0, error: String(e && e.message ? e.message : e) };
  } finally {
    try { conn.close(); } catch (ce) {}
  }
}

// -- Deferred Neon mirror backfill (Phase 3) ----------------------------------
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
  if (!sheet) { Logger.log('Direct upsert: "%s" sheet not found.', DIRECT_CALL_HISTORY_SHEET); return { upserted: 0 }; }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('Direct upsert: sheet is empty.'); return { upserted: 0 }; }

  const data = sheet.getRange(2, 1, lastRow - 1, DIRECT_CALL_HISTORY_HEADERS.length).getDisplayValues();
  const props = PropertiesService.getScriptProperties();
  let startIndex = parseInt(props.getProperty('DIRECT_UPSERT_RESUME') || '0', 10) || 0;
  let sinceFloor = props.getProperty('DIRECT_UPSERT_SINCE');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(sinceFloor || ''))) sinceFloor = null;
  Logger.log('Direct upsert: starting at index %s of %s%s', startIndex, data.length,
    sinceFloor ? ' (date floor >= ' + sinceFloor + ')' : '');
  if (startIndex >= data.length) { Logger.log('Direct upsert complete. Clear DIRECT_UPSERT_RESUME to re-run.'); return { upserted: 0 }; }

  const conn = getReachableNeonConn_();
  if (!conn) { Logger.log('Direct upsert: Neon unreachable (NEON_* Script Properties set?).'); return { upserted: 0, unreachable: true }; }
  conn.setAutoCommit(false);

  const BATCH_SIZE = 50;
  const TIME_LIMIT_MS = 240000;
  const startTime = Date.now();
  let totalUpserted = 0;
  let i = startIndex;
  try {
    dcEnsureNeonTable_(conn);
    while (i < data.length) {
      if (Date.now() - startTime > TIME_LIMIT_MS) {
        props.setProperty('DIRECT_UPSERT_RESUME', String(i));
        Logger.log('Direct upsert: time limit reached; resume at index %s. Upserted %s. Run again to continue.', i, totalUpserted);
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
        props.setProperty('DIRECT_UPSERT_RESUME', String(batchStartIdx));
        Logger.log('Direct upsert batch failed, rolled back. Resume at %s. Error: %s', batchStartIdx, (e && e.message ? e.message : e));
        throw e;
      }
    }
    props.deleteProperty('DIRECT_UPSERT_RESUME');
    Logger.log('Direct upsert complete. Total upserted into Neon: %s', totalUpserted);
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
 * out of the mirror; returns a status). The date is derived from the grid's
 * first data row (same as Phase 1a), since Raw Data holds one day.
 * @returns {{wrote, dateStr, isoDate, monthYear, meta, neon}}
 */
function buildDirectCallFromRaw_(ss, rawDisp, configSheet, opts) {
  opts = opts || {};
  let dateStr = '';
  for (let i = 1; i < rawDisp.length && !dateStr; i++) dateStr = dcDateStr_(rawDisp[i][2]);
  const isoDate = (typeof parseDateForNeon === 'function') ? parseDateForNeon(dateStr) : null;
  const monthYear = dcMonthYearFromDate_(dateStr);

  const maps = dcBuildExtMaps_(configSheet);
  const result = computeDirectCallMetrics(rawDisp, maps, opts);

  const wrote = dcWriteSheet_(ss, result.rows, monthYear, dateStr);
  let neon = { inserted: 0 };
  if (!opts.skipNeon) {
    try { neon = writeDirectCallRowsToNeon_(result.rows, monthYear, isoDate); }
    catch (e) {
      Logger.log('buildDirectCallFromRaw_: Neon mirror failed (non-blocking): ' + (e && e.message ? e.message : e));
      neon = { inserted: 0, error: String(e && e.message ? e.message : e) };
    }
  }
  return { wrote: wrote, dateStr: dateStr, isoDate: isoDate, monthYear: monthYear, meta: result.meta, neon: neon };
}

// -- Editor-run orchestrator (Phase 1a: manual, numbers-only validation) ------
/**
 * Computes direct-call metrics for the CURRENT `Raw Data` day and writes the
 * `Direct Call History` sheet + Neon mirror. Run from the cdr-import editor.
 * Best-effort + self-contained: does NOT touch the daily import. (Phase 1b
 * wires the SAME core, buildDirectCallFromRaw_, into processIntegratedHistory.)
 */
function runDirectCallBuild() {
  const t0 = Date.now();
  const ss = SpreadsheetApp.openById(getTargetSsId_());
  const rawSheet = ss.getSheetByName('Raw Data');
  const configSheet = ss.getSheetByName('DO NOT EDIT!');
  if (!rawSheet || !configSheet) throw new Error('Raw Data or DO NOT EDIT! sheet missing.');

  const raw = rawSheet.getDataRange().getDisplayValues();
  if (raw.length < 2) { Logger.log('runDirectCallBuild: Raw Data empty.'); return { rows: 0 }; }

  const r = buildDirectCallFromRaw_(ss, raw, configSheet, { collectSamples: true });
  dcLogSamples_(r.meta.samples);

  const ms = Date.now() - t0;
  const neonStr = r.neon.unreachable ? 'unreachable' : (r.neon.error ? 'error' : 'ok');
  dcLogPipelineHealth_(ss, 'success', r.wrote, ms,
    'directBuild date=' + r.dateStr + ' agents=' + r.meta.agents +
    ' missedBusy=' + r.meta.missedBusyTotal + ' neon=' + neonStr);
  Logger.log('runDirectCallBuild: %s rows for %s (missedBusy=%s, missedFree=%s, neon=%s) in %sms',
    r.wrote, r.dateStr, r.meta.missedBusyTotal, r.meta.missedFreeTotal, neonStr, ms);
  return { rows: r.wrote, date: r.dateStr, meta: r.meta, neon: r.neon };
}

/**
 * Logs a few example events per designation so the operator can look each one
 * up in Raw Data by CALL_ID and confirm the classification (esp. missed_busy,
 * which also names the blocking call + its busy window). Verification aid only.
 */
function dcLogSamples_(samples) {
  if (!samples) return;
  const order = ['ib_answered', 'ib_missed_free', 'ib_missed_busy', 'ob_connected', 'ob_not_connected'];
  const label = {
    ib_answered: 'INBOUND ANSWERED', ib_missed_free: 'INBOUND MISSED (free -- counts against agent)',
    ib_missed_busy: 'INBOUND MISSED (busy -- EXCLUDED, was on another call)',
    ob_connected: 'OUTBOUND CONNECTED', ob_not_connected: 'OUTBOUND NOT CONNECTED (callee no-answer)',
  };
  Logger.log('--- Direct-call samples (look up CALL_ID in Raw Data to verify) ---');
  order.forEach(function (cat) {
    const list = samples[cat] || [];
    Logger.log('[' + label[cat] + '] ' + list.length + ' example(s):');
    list.forEach(function (s) {
      if (cat === 'ib_missed_busy') {
        Logger.log('   call %s | %s (%s) | rang %s-%s from %s -> ext %s | BLOCKED BY call %s [%s] %s',
          s.callId, s.agent, s.dir, s.ringStart, s.ringEnd, s.caller, s.callee, s.blockedByCallId, s.blockerWindow, s.blockerInfo);
      } else if (cat === 'ib_missed_free') {
        Logger.log('   call %s | %s (%s) | rang %s from %s -> ext %s', s.callId, s.agent, s.dir, s.ringStart, s.caller, s.callee);
      } else if (cat === 'ib_answered') {
        Logger.log('   call %s | %s (%s) | %s from %s -> ext %s | talk %ss', s.callId, s.agent, s.dir, s.time, s.caller, s.callee, s.talkSec);
      } else if (cat === 'ob_connected') {
        Logger.log('   call %s | %s (%s) | %s ext %s -> %s | talk %ss', s.callId, s.agent, s.dir, s.time, s.agent, s.callee, s.talkSec);
      } else {
        Logger.log('   call %s | %s (%s) | %s ext %s -> %s', s.callId, s.agent, s.dir, s.time, s.agent, s.callee);
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

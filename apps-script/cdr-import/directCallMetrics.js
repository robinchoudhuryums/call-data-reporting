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
  const qRegex = /CallQueue/i;

  // Column indices (== the autoImport `idx` + DQE_C layout).
  const C = { CALL_ID: 0, START: 2, DIR: 5, TALK: 6, CALLTIME: 7, CALLER: 8, CALLEE: 10, CTX: 13, MIS: 23, ANS: 25 };

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
    const caller  = dcClean_(r[C.CALLER]);
    const callee  = dcClean_(r[C.CALLEE]);
    const dir     = String(r[C.DIR] || '');
    const ctx     = String(r[C.CTX] || '');
    const isQueue = qRegex.test(ctx);
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
      const occ = { cid: cid, s: startSec, e: startSec + talk + hold };
      if (callerAgent && !exclusions.has(callerAgent.name)) ensure(callerAgent.name, callerAgent.dept).occ.push(occ);
      if (calleeAgent && !exclusions.has(calleeAgent.name)) ensure(calleeAgent.name, calleeAgent.dept).occ.push(occ);
    }

    if (isQueue) continue;   // queue calls belong to the DQE/QCD path, not "direct"

    // (2) INBOUND DIRECT events -- agent is the callee; caller is a real
    //     number/ext; Incoming (external) or Internal. One event per cid.
    if (calleeAgent && !exclusions.has(calleeAgent.name) && dcIsPhone_(caller) &&
        (dir === 'Incoming' || dir === 'Internal')) {
      const b = ensure(calleeAgent.name, calleeAgent.dept);
      let ev = b.ib[cid];
      if (!ev) { ev = b.ib[cid] = { intExt: dir === 'Internal' ? 'int' : 'ext', start: startSec, ringEnd: null, answered: false, talk: 0 }; }
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
      if (!ev) { ev = b.ob[cid] = { intExt: extToAgent[callee] ? 'int' : 'ext', start: startSec, connected: false, talk: 0 }; }
      if (startSec != null && (ev.start == null || startSec < ev.start)) ev.start = startSec;
      if (talk > 0) { ev.connected = true; ev.talk = Math.max(ev.talk, talk); }
    }
  }

  function inWindow(s) { return s != null && s >= W0 && s < W1; }
  function isBusy(occList, ring) {
    // any overlap (>0) with a DIFFERENT call's busy window (+ tail).
    for (let j = 0; j < occList.length; j++) {
      const o = occList[j];
      if (o.cid === ring.cid) continue;
      if (ring.s < (o.e + TAIL) && o.s < ring.e) return true;
    }
    return false;
  }

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
      } else {
        const ring = { cid: cid, s: ev.start, e: (ev.ringEnd != null ? ev.ringEnd : ev.start) };
        if (isBusy(a.occ, ring)) { m['ib_' + k + '_missed_busy']++; missedBusyTotal++; }
        else                     { m['ib_' + k + '_missed_free']++; missedFreeTotal++; }
      }
    });

    Object.keys(a.ob).forEach(function (cid) {
      const ev = a.ob[cid];
      if (!inWindow(ev.start)) { if (ev.start == null) droppedNoStart++; return; }
      const k = ev.intExt;
      m['ob_' + k + '_total']++;
      if (ev.connected) { m['ob_' + k + '_connected']++; m['ob_' + k + '_talk_sec'] += ev.talk; }
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

  return { rows: rows, meta: { agents: rows.length, droppedNoStart: droppedNoStart, missedBusyTotal: missedBusyTotal, missedFreeTotal: missedFreeTotal } };
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

  // Queue map (cols A/B): dept | queue ext.
  const queueMap = configSheet.getRange(2, 1, lastRow - 1, 2).getValues();
  queueMap.forEach(function (r) {
    if (r[0]) exclusions.add(String(r[0]).trim());
    if (r[1]) { const ext = String(r[1]).trim(); exclusions.add(ext); queueExtSet.add(ext); }
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

/** Refresh-in-window write: drop the date's existing rows, append the new ones. */
function dcWriteSheet_(ss, rows, monthYear, dateStr) {
  const sh = dcEnsureSheet_(ss);
  const last = sh.getLastRow();
  if (last > 1) {
    const dateCol = sh.getRange(2, 2, last - 1, 1).getValues();   // col B = Date
    for (let i = dateCol.length - 1; i >= 0; i--) {
      if (String(dateCol[i][0]).trim() === dateStr) sh.deleteRow(i + 2);
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

/** Upsert per-agent-day rows for one date. Best-effort; returns a status object. */
function writeDirectCallRowsToNeon_(rows, monthYear, isoDate) {
  if (!rows || !rows.length) return { inserted: 0, skipped: 0 };
  const conn = getReachableNeonConn_();
  if (!conn) { Logger.log('writeDirectCallRowsToNeon_: Neon unreachable -- skipping %s rows.', rows.length); return { inserted: 0, unreachable: true }; }
  conn.setAutoCommit(false);
  try {
    dcEnsureNeonTable_(conn);
    const cols = 'month_year, call_date, department, agent_name, ' +
      'ib_int_answered, ib_int_missed_free, ib_int_missed_busy, ib_int_talk_sec, ' +
      'ib_ext_answered, ib_ext_missed_free, ib_ext_missed_busy, ib_ext_talk_sec, ' +
      'ob_int_total, ob_int_connected, ob_int_talk_sec, ' +
      'ob_ext_total, ob_ext_connected, ob_ext_talk_sec';
    const ph = '(' + new Array(18).fill('?').join(',') + ')';
    const sql = 'INSERT INTO direct_call_history (' + cols + ') VALUES ' +
      rows.map(function () { return ph; }).join(',') +
      ' ON CONFLICT (call_date, department, agent_name) DO UPDATE SET ' +
      ['month_year', 'ib_int_answered', 'ib_int_missed_free', 'ib_int_missed_busy', 'ib_int_talk_sec',
       'ib_ext_answered', 'ib_ext_missed_free', 'ib_ext_missed_busy', 'ib_ext_talk_sec',
       'ob_int_total', 'ob_int_connected', 'ob_int_talk_sec',
       'ob_ext_total', 'ob_ext_connected', 'ob_ext_talk_sec']
        .map(function (c) { return c + ' = EXCLUDED.' + c; }).join(', ') +
      ', updated_at = now()';
    const stmt = conn.prepareStatement(sql);
    let p = 0;
    rows.forEach(function (r) {
      stmt.setString(++p, monthYear);
      stmt.setString(++p, isoDate);
      stmt.setString(++p, r.dept);
      stmt.setString(++p, r.agent);
      [r.ib_int_answered, r.ib_int_missed_free, r.ib_int_missed_busy, r.ib_int_talk_sec,
       r.ib_ext_answered, r.ib_ext_missed_free, r.ib_ext_missed_busy, r.ib_ext_talk_sec,
       r.ob_int_total, r.ob_int_connected, r.ob_int_talk_sec,
       r.ob_ext_total, r.ob_ext_connected, r.ob_ext_talk_sec].forEach(function (v) { stmt.setInt(++p, v | 0); });
    });
    stmt.execute();
    stmt.close();
    conn.commit();
    return { inserted: rows.length };
  } catch (e) {
    try { conn.rollback(); } catch (rb) {}
    Logger.log('writeDirectCallRowsToNeon_ failed: ' + (e && e.message ? e.message : e));
    return { inserted: 0, error: String(e && e.message ? e.message : e) };
  } finally {
    try { conn.close(); } catch (ce) {}
  }
}

// -- Editor-run orchestrator (Phase 1: manual, numbers-only validation) -------
/**
 * Computes direct-call metrics for the CURRENT `Raw Data` day and writes the
 * `Direct Call History` sheet + Neon mirror. Run from the cdr-import editor.
 * Best-effort + self-contained: does NOT touch the daily import. (Phase 1b
 * will wire an equivalent block into processIntegratedHistory once validated.)
 */
function runDirectCallBuild() {
  const t0 = Date.now();
  const ss = SpreadsheetApp.openById(getTargetSsId_());
  const rawSheet = ss.getSheetByName('Raw Data');
  const configSheet = ss.getSheetByName('DO NOT EDIT!');
  if (!rawSheet || !configSheet) throw new Error('Raw Data or DO NOT EDIT! sheet missing.');

  const raw = rawSheet.getDataRange().getDisplayValues();
  if (raw.length < 2) { Logger.log('runDirectCallBuild: Raw Data empty.'); return { rows: 0 }; }

  // Derive the date from the first data row's START_TIME.
  let dateStr = '';
  for (let i = 1; i < raw.length && !dateStr; i++) dateStr = dcDateStr_(raw[i][2]);
  const isoDate = (typeof parseDateForNeon === 'function') ? parseDateForNeon(dateStr) : null;
  const monthYear = dcMonthYearFromDate_(dateStr);

  const maps = dcBuildExtMaps_(configSheet);
  const result = computeDirectCallMetrics(raw, maps, {});

  const wrote = dcWriteSheet_(ss, result.rows, monthYear, dateStr);
  let neon = { inserted: 0 };
  try { neon = writeDirectCallRowsToNeon_(result.rows, monthYear, isoDate); }
  catch (e) { Logger.log('runDirectCallBuild: Neon mirror failed (non-blocking): ' + (e && e.message ? e.message : e)); }

  const ms = Date.now() - t0;
  dcLogPipelineHealth_(ss, 'success', wrote, ms,
    'directBuild date=' + dateStr + ' agents=' + result.meta.agents +
    ' missedBusy=' + result.meta.missedBusyTotal + ' neon=' + (neon.unreachable ? 'unreachable' : (neon.error ? 'error' : 'ok')));
  Logger.log('runDirectCallBuild: %s rows for %s (missedBusy=%s, missedFree=%s, neon=%s) in %sms',
    wrote, dateStr, result.meta.missedBusyTotal, result.meta.missedFreeTotal,
    neon.unreachable ? 'unreachable' : (neon.error ? 'error' : 'ok'), ms);
  return { rows: wrote, date: dateStr, meta: result.meta, neon: neon };
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
    if (typeof logPipelineHealth_ === 'function') { logPipelineHealth_(ss, 'directBuild', status, rows, ms, notes); return; }
    const sh = ss.getSheetByName('Pipeline Health');
    if (!sh) return;
    sh.appendRow([new Date(), 'directBuild', status, rows, ms, notes]);
  } catch (e) { /* best-effort */ }
}

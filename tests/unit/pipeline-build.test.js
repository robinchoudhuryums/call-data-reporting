'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deepEqual } = require('node:assert'); // legacy: prototype-agnostic for cross-realm vm values
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { rosterGrid } = require('../harness/fixtures');

// End-to-end coverage of the buildDQEHistoricalData monolith (INV-07
// window legs, INV-08 per-agent TTT attribution, INV-20 PST->CST
// slots, INV-21 parentMap). Same byte-identical file in cdr-import.
const h = loadGas({ project: 'cdr-report', files: ['buildDQEHistoricalData.js'] });
// Neon mirror + failure-notify live in neonWrite.js (not loaded); stub
// them so the build's mirror block is a no-op.
h.ctx.writeDQERowsToNeon = function () { return { skipped: 0 }; };
h.ctx.notifyNeonWriteFailure = function () {};

// Raw Data row builder (26 cols, 0-based per DQE_C in the source).
function rawRow(o) {
  const r = new Array(26).fill('');
  r[0]  = o.callId || '';                          // CALL_ID
  r[1]  = o.legId != null ? String(o.legId) : '';  // LEG_ID
  r[2]  = o.start || '';                            // START_TIME "MM/DD/YYYY H:MM:SS"
  r[6]  = o.talk || '';                             // TALK_TIME (timeVals col 7)
  r[7]  = o.callTime || '';                         // CALL_TIME (timeVals col 8)
  r[8]  = o.caller || '';                           // CALLER e.g. "CallQueue(103)"
  r[11] = o.calleeName || '';                       // CALLEE_NAME (agent)
  r[14] = o.parentCall || '';                       // PARENT_CALL ('N/A' on parent legs)
  r[22] = o.callerId || '';                         // CALLER_ID (queue match)
  r[23] = o.missed ? 'Missed' : '';
  r[24] = o.abandoned ? 'Abandoned' : '';
  r[25] = o.answered ? 'Answered' : '';
  return r;
}

const IN  = '03/09/2026 7:00:00';   // 25200s PST -> inside [6:30, 15:00)
const OUT = '03/09/2026 5:00:00';   // 18000s PST -> before the window

// One agent (Anna). Parent legs carry talk time; queue legs carry the
// ring/answer/miss events. P1 also has a Bob leg with a much larger
// talk time to prove INV-08 attributes Anna's OWN leg, not the max.
function build() {
  const rawGrid = [new Array(26).fill('')].concat([
    // Parent legs (PARENT_CALL='N/A', no queue CALLER_ID -> not queue legs).
    rawRow({ callId: 'P1', legId: 0, start: IN, talk: '0:03:00', calleeName: 'Anna', parentCall: 'N/A' }), // 180s
    rawRow({ callId: 'P1', legId: 1, start: IN, talk: '0:16:39', calleeName: 'Bob',  parentCall: 'N/A' }), // 999s decoy
    rawRow({ callId: 'P2', legId: 0, start: IN, talk: '0:05:00', calleeName: 'Anna', parentCall: 'N/A' }), // 300s
    // Queue legs (CALLER_ID matches a queue; CALLER carries the ext).
    rawRow({ callId: 'Q1', legId: 0, start: IN,  caller: 'CallQueue(103)', calleeName: 'Anna', parentCall: 'P1', callerId: 'A_Q_CSR', answered: true }),
    rawRow({ callId: 'Q2', legId: 0, start: IN,  caller: 'CallQueue(103)', calleeName: 'Anna', parentCall: 'P2', callerId: 'A_Q_CSR', answered: true }),
    rawRow({ callId: 'Q3', legId: 0, start: IN,  caller: 'CallQueue(103)', calleeName: 'Anna', parentCall: 'P3', callerId: 'A_Q_CSR', missed: true }),
    // Out-of-window answered leg -> excluded from windowLegs (INV-07).
    rawRow({ callId: 'Q4', legId: 0, start: OUT, caller: 'CallQueue(103)', calleeName: 'Anna', parentCall: 'P4', callerId: 'A_Q_CSR', answered: true }),
  ]);
  const ss = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: {
      'Raw Data': rawGrid,
      'DQE Historical Data': [new Array(34).fill('')],   // header only
      'DO NOT EDIT!': rosterGrid({ CSR: ['Anna, 103'] }),
    },
  });
  h.fn('buildDQEHistoricalData')(ss._sheet('Raw Data'), ss._sheet('DQE Historical Data'));
  // Output rows start at row 2 (index 1).
  return ss._sheet('DQE Historical Data')._data.slice(1).filter(function (r) { return r[2] === 'Anna'; })[0];
}

test('INV-07: only in-window legs count toward rung/missed/answered/unique', function () {
  const row = build();
  // Q1,Q2,Q3 are in-window; Q4 (5 AM) is excluded.
  assert.equal(row[5], 3);   // F Total Rung (NOT 4)
  assert.equal(row[6], 1);   // G Total Missed
  assert.equal(row[7], 2);   // H Total Answered (Q1, Q2 -- Q4 excluded)
  assert.equal(row[4], 3);   // E Total Unique parents in window {P1,P2,P3}
});

test('INV-08/INV-21: TTT sums the agent\'s OWN parent-leg talk (not the max across legs)', function () {
  const row = build();
  // Anna's talk: P1=180 (NOT Bob's 999 on the same parent), P2=300.
  // TTT = 180 + 300 = 480 = 0:08:00. The buggy max-across-legs path
  // would have used 999 for P1 -> 0:21:39.
  assert.equal(row[8], '0:08:00');   // I TTT
  // ATT = simple mean of per-parent talk = (180+300)/2 = 240 = 0:04:00.
  assert.equal(row[9], '0:04:00');   // J ATT
});

test('INV-20: missed-call time slots are stored as CST (PST + 2h), bucketed 30-min', function () {
  const row = build();
  // The missed leg Q3 is at 7:00 PST -> 9:00 CST. Slot columns are
  // output[10..28]; 7:00 falls in slot index 2 (06:00 + 2*30min).
  assert.equal(row[10 + 2], '9:00:00');
  // Every other slot is empty (answered legs aren't bucketed here).
  for (let i = 0; i < 19; i++) {
    if (i !== 2) assert.equal(row[10 + i], '', 'slot ' + i + ' should be empty');
  }
});

test('INV-21: queue-extension + date/agent columns are populated from the legs', function () {
  const row = build();
  assert.equal(row[0], 'March 2026');     // A Month Year
  assert.equal(row[1], '03/09/2026');     // B Date
  assert.equal(row[2], 'Anna');           // C Agent
  assert.equal(row[3], '103');            // D Queue Extensions (from CallQueue(103))
});

test('F-2: AD/AE/AF are positionally paired (AF[i] time <-> AD[i] parent id)', function () {
  // The dashboard's Missed Calls report pairs AF[i] -> AD[i] to attach a
  // parent call id to each 🚨 timestamp (the "↳ path" journey drill), so
  // the build must emit all three columns from the SAME ordered missed-leg
  // list: one entry per missed leg on an abandoned parent, chronological.
  // Abandoned parents with no pairable missed leg (e.g. the agent's leg
  // was answered) are APPENDED to AD after the paired section, keeping the
  // dept-wide unique-abandoned id set unchanged.
  const rawGrid = [new Array(26).fill('')].concat([
    // Abandoned parent PA (waitSec 120 > 60). Anna is re-rung TWICE, both
    // missed, listed OUT of chronological order to prove the sort.
    rawRow({ callId: 'PA', legId: 0, start: IN, callTime: '0:02:00', parentCall: 'N/A', abandoned: true }),
    rawRow({ callId: 'QA1', legId: 0, start: '03/09/2026 7:10:00', caller: 'CallQueue(103)', calleeName: 'Anna', parentCall: 'PA', callerId: 'A_Q_CSR', missed: true }),
    rawRow({ callId: 'QA2', legId: 0, start: '03/09/2026 7:05:00', caller: 'CallQueue(103)', calleeName: 'Anna', parentCall: 'PA', callerId: 'A_Q_CSR', missed: true }),
    // Abandoned parent PB where Anna's queue leg was ANSWERED -> no missed
    // leg to pair, so PB must appear in AD (appended) with no AF partner.
    rawRow({ callId: 'PB', legId: 0, start: IN, callTime: '0:02:00', parentCall: 'N/A', abandoned: true }),
    rawRow({ callId: 'QB1', legId: 0, start: IN, caller: 'CallQueue(103)', calleeName: 'Anna', parentCall: 'PB', callerId: 'A_Q_CSR', answered: true }),
  ]);
  const ss = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: {
      'Raw Data': rawGrid,
      'DQE Historical Data': [new Array(34).fill('')],
      'DO NOT EDIT!': rosterGrid({ CSR: ['Anna, 103'] }),
    },
  });
  h.fn('buildDQEHistoricalData')(ss._sheet('Raw Data'), ss._sheet('DQE Historical Data'));
  const row = ss._sheet('DQE Historical Data')._data.slice(1)
    .filter(function (r) { return r[2] === 'Anna'; })[0];
  // AF (idx 31): chronological CST times of the two missed rings.
  assert.equal(row[31], '9:05:00,9:10:00');
  // AE (idx 30): the missed-leg call ids, in the SAME order as AF.
  assert.equal(row[30], 'QA2,QA1');
  // AD (idx 29): the paired parent per missed leg (PA twice -- once per
  // ring), then the unpaired abandoned parent PB appended at the end.
  assert.equal(row[29], 'PA,PA,PB');
});

test('INV-23 producer (Pass 4): a no-ring abandoned queue call emits ONE queue-sentinel row', function () {
  // PX is abandoned (waitSec 120 > 60) and its parent leg HIT A_Q_CSR
  // (calleeName carries the queue identifier) but NO agent was rung for
  // it -> invisible to the per-agent path, so Pass 4 must emit a sentinel
  // row keyed on the queue name. PY is also abandoned on the same queue
  // but Anna WAS rung (missed) -> covered by her agent row, so PY must
  // NOT appear in the sentinel (no double count).
  const rawGrid = [new Array(26).fill('')].concat([
    // Anna's normal activity: establishes the A_Q_CSR -> ext 103 mapping
    // via an observed queue leg AND produces her agent row.
    rawRow({ callId: 'P1', legId: 0, start: IN, talk: '0:03:00', calleeName: 'Anna', parentCall: 'N/A' }),
    rawRow({ callId: 'Q1', legId: 0, start: IN, caller: 'CallQueue(103)', calleeName: 'Anna', parentCall: 'P1', callerId: 'A_Q_CSR', answered: true }),
    // PX: abandoned, hit the queue at 7:10 PST, rang nobody.
    rawRow({ callId: 'PX', legId: 0, start: '03/09/2026 7:10:00', callTime: '0:02:00', calleeName: 'A_Q_CSR', parentCall: 'N/A', abandoned: true }),
    // PY: abandoned but Anna was rung (missed) -> per-agent path owns it.
    rawRow({ callId: 'PY', legId: 0, start: IN, callTime: '0:02:00', calleeName: 'A_Q_CSR', parentCall: 'N/A', abandoned: true }),
    rawRow({ callId: 'QY', legId: 0, start: IN, caller: 'CallQueue(103)', calleeName: 'Anna', parentCall: 'PY', callerId: 'A_Q_CSR', missed: true }),
  ]);
  const ss = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: {
      'Raw Data': rawGrid,
      'DQE Historical Data': [new Array(34).fill('')],
      'DO NOT EDIT!': rosterGrid({ CSR: ['Anna, 103'] }),
    },
  });
  h.fn('buildDQEHistoricalData')(ss._sheet('Raw Data'), ss._sheet('DQE Historical Data'));
  const rows = ss._sheet('DQE Historical Data')._data.slice(1);

  const sentinels = rows.filter(function (r) { return r[2] === 'A_Q_CSR'; });
  assert.equal(sentinels.length, 1, 'exactly one sentinel row per queue per day');
  const s = sentinels[0];
  // Col D carries the queue's extensions so dept-by-extension filtering works.
  assert.equal(s[3], '103');
  // Cols E-J are zero / "0:00:00" -- queue-level, not agent-level (INV-23).
  assert.equal(s[4], 0); assert.equal(s[5], 0); assert.equal(s[6], 0); assert.equal(s[7], 0);
  assert.equal(s[8], '0:00:00'); assert.equal(s[9], '0:00:00');
  // The no-ring event is bucketed at the QUEUE-hit leg's time: 7:10 PST
  // -> 9:10 CST, slot index 2 (7:00-7:30 PST). Same CST shape as agent
  // rows so the Missed Calls Report reads it with the same code path.
  assert.equal(s[10 + 2], '9:10:00');
  // AD = the no-ring parent only (PY was rung -> excluded); AE empty
  // (no missed agent leg exists by definition); AF mirrors the slots.
  assert.equal(s[29], 'PX');
  assert.equal(s[30], '');
  assert.equal(s[31], '9:10:00');
  assert.equal(s[32], '0:00:00'); assert.equal(s[33], '0:00:00');
  // Anna's agent row coexists -- the sentinel doesn't displace it, and
  // her AD carries the rung-abandoned parent PY (per-agent path).
  const anna = rows.filter(function (r) { return r[2] === 'Anna'; })[0];
  assert.ok(anna, 'agent row still emitted');
  assert.ok(String(anna[29]).indexOf('PY') !== -1, "PY belongs to Anna's row");
});

test('duplicate guard: a second build for the same date is a no-op', function () {
  // Build once, then build again into the SAME dqe sheet -> the date
  // already exists in col B, so the second run must add no rows.
  const rawGrid = [new Array(26).fill('')].concat([
    rawRow({ callId: 'P1', legId: 0, start: IN, talk: '0:03:00', calleeName: 'Anna', parentCall: 'N/A' }),
    rawRow({ callId: 'Q1', legId: 0, start: IN, caller: 'CallQueue(103)', calleeName: 'Anna', parentCall: 'P1', callerId: 'A_Q_CSR', answered: true }),
  ]);
  const ss = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: {
      'Raw Data': rawGrid,
      'DQE Historical Data': [new Array(34).fill('')],
      'DO NOT EDIT!': rosterGrid({ CSR: ['Anna, 103'] }),
    },
  });
  const raw = ss._sheet('Raw Data');
  const dqe = ss._sheet('DQE Historical Data');
  h.fn('buildDQEHistoricalData')(raw, dqe);
  const afterFirst = dqe.getLastRow();
  h.fn('buildDQEHistoricalData')(raw, dqe);
  assert.equal(dqe.getLastRow(), afterFirst, 'second build must not append rows for an existing date');
});

test('IMP-7 (F2 guard): an expectedDate mismatch THROWS and writes nothing', function () {
  // On the force re-import path the caller has already deleted the expected
  // date's DQE rows before the build runs; a silent refusal (the old
  // `return`) left that date's data gone under a success-rows:0 telemetry
  // row with no email. The guard now throws so the daily caller's catch
  // fires its `:DQE` failure row + notifyDqeBuildFailure_, and the bulk
  // caller's per-date catch logs and continues.
  const rawGrid = [new Array(26).fill('')].concat([
    rawRow({ callId: 'P1', legId: 0, start: IN, talk: '0:03:00', calleeName: 'Anna', parentCall: 'N/A' }),
    rawRow({ callId: 'Q1', legId: 0, start: IN, caller: 'CallQueue(103)', calleeName: 'Anna', parentCall: 'P1', callerId: 'A_Q_CSR', answered: true }),
  ]);
  const ss = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: {
      'Raw Data': rawGrid,
      'DQE Historical Data': [new Array(34).fill('')],
      'DO NOT EDIT!': rosterGrid({ CSR: ['Anna, 103'] }),
    },
  });
  // Raw Data resolves to 2026-03-09; the caller expected 2026-03-10.
  assert.throws(function () {
    h.fn('buildDQEHistoricalData')(ss._sheet('Raw Data'), ss._sheet('DQE Historical Data'),
      { expectedDate: new Date(2026, 2, 10) });
  }, /DQE build refused/);
  const written = ss._sheet('DQE Historical Data')._data.slice(1)
    .filter(function (r) { return String(r[2] || '') !== ''; });
  assert.equal(written.length, 0, 'no rows written on refusal');
  // Matching expectedDate still builds normally.
  h.fn('buildDQEHistoricalData')(ss._sheet('Raw Data'), ss._sheet('DQE Historical Data'),
    { expectedDate: new Date(2026, 2, 9) });
  const anna = ss._sheet('DQE Historical Data')._data.slice(1)
    .filter(function (r) { return r[2] === 'Anna'; });
  assert.equal(anna.length, 1, 'matching expectedDate writes the row');
});

test('M2: a FORCE build (expectedDate) that produces no rows THROWS, not silent-return', function () {
  // IMP-7 closed the date-MISMATCH door; M2 closes the SIBLING early-returns
  // (empty Raw Data / no parseable dates / zero output rows). On the force
  // re-import path the caller already deleted the date's DQE rows, so a silent
  // return there left the date GONE under a success-rows:0 telemetry row with
  // no email. With expectedDate present those doors now throw; WITHOUT it
  // (the self-deriving standalone trigger) the silent return is unchanged.
  const ss = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: {
      'Raw Data': [new Array(26).fill('')],            // header only -> no data rows
      'DQE Historical Data': [new Array(34).fill('')],
      'DO NOT EDIT!': rosterGrid({ CSR: ['Anna, 103'] }),
    },
  });
  // Force path (expectedDate + force): refuses loudly (rows were pre-deleted).
  assert.throws(function () {
    h.fn('buildDQEHistoricalData')(ss._sheet('Raw Data'), ss._sheet('DQE Historical Data'),
      { expectedDate: new Date(2026, 2, 9), force: true });
  }, /DQE build refused/, 'force build over empty Raw Data throws');
  // Non-force build WITH expectedDate (the daily path): the F5 rows:0 case --
  // a legitimate empty day, nothing pre-deleted -- keeps the silent return.
  assert.doesNotThrow(function () {
    h.fn('buildDQEHistoricalData')(ss._sheet('Raw Data'), ss._sheet('DQE Historical Data'),
      { expectedDate: new Date(2026, 2, 9) });
  }, 'non-force build over empty Raw Data returns silently (F5)');
  // No opts at all (standalone trigger): also silent.
  assert.doesNotThrow(function () {
    h.fn('buildDQEHistoricalData')(ss._sheet('Raw Data'), ss._sheet('DQE Historical Data'));
  }, 'no-opts build over empty Raw Data returns silently');
  const written = ss._sheet('DQE Historical Data')._data.slice(1)
    .filter(function (r) { return String(r[2] || '') !== ''; });
  assert.equal(written.length, 0, 'no rows written either way');
});

test('REP-3: a NO-RING abandon on a CSR queue counts toward CSR Avg Abd Wait (AH)', function () {
  // P9 is abandoned (120s > 60), hit A_Q_CSR (parent-leg calleeName), and
  // rang NOBODY -- before REP-3 only rung-leg abandons entered csrAbanIds,
  // so AH read 0:00:00 while the dept-wide AG already included P9.
  const rawGrid = [new Array(26).fill('')].concat([
    rawRow({ callId: 'P1', legId: 0, start: IN, talk: '0:03:00', calleeName: 'Anna', parentCall: 'N/A' }),
    rawRow({ callId: 'Q1', legId: 0, start: IN, caller: 'CallQueue(103)', calleeName: 'Anna', parentCall: 'P1', callerId: 'A_Q_CSR', answered: true }),
    rawRow({ callId: 'P9', legId: 0, start: IN, callTime: '0:02:00', calleeName: 'A_Q_CSR', parentCall: 'N/A', abandoned: true }),
  ]);
  const ss = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: {
      'Raw Data': rawGrid,
      'DQE Historical Data': [new Array(34).fill('')],
      'DO NOT EDIT!': rosterGrid({ CSR: ['Anna, 103'] }),
    },
  });
  h.fn('buildDQEHistoricalData')(ss._sheet('Raw Data'), ss._sheet('DQE Historical Data'));
  const anna = ss._sheet('DQE Historical Data')._data.slice(1)
    .filter(function (r) { return r[2] === 'Anna'; })[0];
  assert.equal(anna[32], '0:02:00');   // AG (already included the no-ring abandon)
  assert.equal(anna[33], '0:02:00');   // AH now includes it too (was '0:00:00')
});

test('IMP-8: queue regex keeps &-names whole and ignores embedded A_Q_ tokens', function () {
  const rawGrid = [new Array(26).fill('')].concat([
    // Embedded token: UDC_A_Q_Main must NOT substring-match as a phantom
    // A_Q_Main queue leg -- Anna gets no agent row from it.
    rawRow({ callId: 'QX', legId: 0, start: IN, caller: 'CallQueue(103)', calleeName: 'Anna', parentCall: 'PX', callerId: 'UDC_A_Q_Main', answered: true }),
    // &-bearing queue: the Pass-4 sentinel must carry the FULL name, not
    // the pre-fix truncation 'A_Q_Elig_MM'.
    rawRow({ callId: 'PZ', legId: 0, start: IN, callTime: '0:02:00', calleeName: 'A_Q_Elig_MM&R', parentCall: 'N/A', abandoned: true }),
  ]);
  const ss = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: {
      'Raw Data': rawGrid,
      'DQE Historical Data': [new Array(34).fill('')],
      'DO NOT EDIT!': rosterGrid({ CSR: ['Anna, 103'] }),
    },
  });
  h.fn('buildDQEHistoricalData')(ss._sheet('Raw Data'), ss._sheet('DQE Historical Data'));
  const names = ss._sheet('DQE Historical Data')._data.slice(1)
    .map(function (r) { return String(r[2] || ''); }).filter(Boolean);
  assert.ok(names.indexOf('Anna') === -1, 'embedded UDC_A_Q_Main token is not a queue leg');
  assert.ok(names.indexOf('A_Q_Main') === -1, 'no phantom A_Q_Main');
  assert.ok(names.indexOf('A_Q_Elig_MM&R') !== -1, 'full &-name sentinel emitted');
  assert.ok(names.indexOf('A_Q_Elig_MM') === -1, 'no truncated sentinel');
});

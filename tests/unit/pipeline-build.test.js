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

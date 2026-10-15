'use strict';

// ST5 (broad-scan 259, E4): ONE Raw Data day shared by every tool that
// mirrors the DQE build -- the DQE Drill-Down (DQEdrilldown.js), the
// queue-overlap audit (queueOverlapAudit.js), the per-queue split sample
// (queueSplitSample.js) -- and by the build itself. Each tool's suite used to
// carry its own private fixture, so a shape one fixture covered (abandoned
// pairing, a sentinel, a stray) could drift unseen in a tool whose fixture
// lacked it. tests/unit/parity-day.test.js drives all four with this day;
// the per-tool suites import `rawRow` from here instead of keeping copies.
//
// The day is shaped so no metric is interchangeable with another:
//   - P5 rings Anna TWICE (missed, then answered): rung != unique != answered;
//   - Bob's 999 s leg on P1 is the INV-08 decoy for Anna's TTT;
//   - Q4 sits before the work window (excluded from every windowed metric);
//   - P6 / P7 are ABANDONED: P6 pairs a missed leg into AD/AE/AF, P7 adds an
//     unpaired AD id;
//   - P10 is abandoned in the queue with NO agent leg: the INV-23 sentinel;
//   - P12 rings Anna in TWO queues (Spanish, then CSR): the overlap audit's
//     cross-queue call, and two keys in Anna's col-AI split;
//   - Bob answers on Sales (a second agent, a second queue);
//   - S1 is a carry-over leg from the day BEFORE, sorted FIRST when
//     `strayFirst` is set (the ING-7 shape every reader must date past).

const DATE = '03/09/2026';
const DATE_ISO = '2026-03-09';
const STRAY_ISO = '2026-03-08';
const IN = DATE + ' 7:00:00';
const IN2 = DATE + ' 9:00:00';
const OUT = DATE + ' 5:00:00';
const STRAY = '03/08/2026 23:58:10';

/** One Raw Data display row (26 cols) -- the columns every mirror reads. */
function rawRow(o) {
  const r = new Array(26).fill('');
  r[0]  = o.callId || '';
  r[1]  = o.legId != null ? String(o.legId) : '';
  r[2]  = o.start || '';
  r[6]  = o.talk || '';
  r[7]  = o.callTime || '';
  r[8]  = o.caller || '';
  r[10] = o.callee || '';
  r[11] = o.calleeName || '';
  r[14] = o.parentCall || '';
  r[22] = o.callerId || '';
  r[23] = o.missed ? 'Missed' : '';
  r[24] = o.abandoned ? 'Abandoned' : '';
  r[25] = o.answered ? 'Answered' : '';
  return r;
}

const ANNA = 'Anna Smith';
const BOB = 'Bob Jones';

/** The day's rows (no header). `opts.strayFirst` puts the carry-over leg first. */
function dayRows(opts) {
  opts = opts || {};
  const csr = function (o) { return Object.assign({ caller: 'CallQueue(103)', callerId: 'A_Q_CSR', calleeName: ANNA, start: IN }, o); };
  const rows = [
    // Parent legs carry talk time.
    rawRow({ callId: 'P1', legId: 0, start: IN, talk: '0:03:00', calleeName: ANNA, parentCall: 'N/A' }),   // 180
    rawRow({ callId: 'P1', legId: 1, start: IN, talk: '0:16:39', calleeName: BOB, parentCall: 'N/A' }),    // 999 decoy
    rawRow({ callId: 'P2', legId: 0, start: IN, talk: '0:05:00', calleeName: ANNA, parentCall: 'N/A' }),   // 300
    rawRow({ callId: 'P5', legId: 0, start: IN, talk: '0:02:00', calleeName: ANNA, parentCall: 'N/A' }),   // 120
    rawRow({ callId: 'P11', legId: 0, start: IN2, talk: '0:04:00', calleeName: BOB, parentCall: 'N/A' }),  // Bob's own
    rawRow({ callId: 'P12', legId: 0, start: IN2, talk: '0:01:00', calleeName: ANNA, parentCall: 'N/A' }),
    // Anna's queue legs.
    rawRow(csr({ callId: 'Q1', legId: 0, parentCall: 'P1', answered: true })),
    rawRow(csr({ callId: 'Q2', legId: 0, parentCall: 'P2', answered: true })),
    rawRow(csr({ callId: 'Q3', legId: 0, parentCall: 'P3', missed: true })),
    rawRow(csr({ callId: 'Q5a', legId: 0, parentCall: 'P5', missed: true })),
    rawRow(csr({ callId: 'Q5b', legId: 1, parentCall: 'P5', answered: true })),
    rawRow(csr({ callId: 'Q4', legId: 0, start: OUT, parentCall: 'P4', answered: true })),   // out of window
    // Abandoned parents (callee = the queue) and their legs.
    rawRow({ callId: 'P6', legId: 0, start: IN, callTime: '0:02:00', calleeName: 'A_Q_CSR', parentCall: 'N/A', abandoned: true }),
    rawRow(csr({ callId: 'Q6a', legId: 0, parentCall: 'P6', missed: true })),
    rawRow(csr({ callId: 'Q6b', legId: 1, parentCall: 'P6', answered: true })),
    rawRow({ callId: 'P7', legId: 0, start: IN, callTime: '0:03:00', calleeName: 'A_Q_CSR', parentCall: 'N/A', abandoned: true }),
    rawRow(csr({ callId: 'Q7', legId: 0, parentCall: 'P7', answered: true })),
    // Queue-only abandon: no agent was rung (the INV-23 sentinel).
    rawRow({ callId: 'P10', legId: 0, start: IN2, callTime: '0:01:30', calleeName: 'A_Q_CSR', callerId: 'A_Q_CSR', parentCall: 'N/A', abandoned: true }),
    // One call, two queues: Spanish missed, then CSR answered.
    rawRow({ callId: 'Q12a', legId: 0, start: IN2, caller: 'CallQueue(138)', callerId: 'A_Q_Spanish', calleeName: ANNA, parentCall: 'P12', missed: true }),
    rawRow(csr({ callId: 'Q12b', legId: 1, start: IN2, parentCall: 'P12', answered: true })),
    // Bob on Sales.
    rawRow({ callId: 'Q11', legId: 0, start: IN2, caller: 'CallQueue(105)', callerId: 'A_Q_Sales', calleeName: BOB, parentCall: 'P11', answered: true }),
  ];
  const stray = rawRow(csr({ callId: 'S1', legId: 0, start: STRAY, parentCall: 'PS', missed: true }));
  return opts.strayFirst ? [stray].concat(rows) : rows.concat([stray]);
}

/** The day as a Raw Data sheet grid (blank header + rows). */
function dayGrid(opts) { return [new Array(26).fill('')].concat(dayRows(opts)); }

/** Roster cells (INV-03 "Name, ext"). */
const ROSTER = { CSR: [ANNA + ', 103'], Sales: [BOB + ', 105'] };

module.exports = { DATE, DATE_ISO, STRAY_ISO, ANNA, BOB, ROSTER, rawRow, dayRows, dayGrid };

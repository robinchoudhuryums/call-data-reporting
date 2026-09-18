'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { rosterGrid } = require('../harness/fixtures');

// queueSplitSample.js -- the SIXTH hand-mirror of the build's queueLegs gate
// (P-5, 2026-09-17). cross-file-pins pins its SOURCE (the per-queue floor
// helper + the R18e ext fallback), but a source pin on copied text cannot see
// a rule the build GAINS: this suite drives ONE Raw Data fixture through the
// REAL build (col AI) and then the REAL sample tool, and reads the tool's own
// self-check verdicts. Every agent must read OK, and the three shapes that
// drifted before must be present in the fixture so a regression is visible:
//   - a CSR-family leg in the early half hour (R49: counts for A_Q_CSR),
//   - the same early minute on a non-early queue (does NOT count),
//   - a leg whose col W lost its queue token but whose CALLER reads
//     "CallQueue (ext)" (R18e: recovered through queueNameByExt).
// The last test proves the self-check BITES: with the tool's floor forced flat
// after the build ran, the CSR-family agent reads MISMATCH.

const h = loadGas({ project: 'cdr-import', files: ['buildDQEHistoricalData.js', 'queueSplitSample.js'] });
h.ctx.writeDQERowsToNeon = function () { return { skipped: 0 }; };
h.ctx.notifyNeonWriteFailure = function () {};
h.ctx.getTargetSsId_ = function () { return 'fake'; };

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

const EARLY = '03/09/2026 6:10:00';   // 6:10 PST: inside the CSR family's floor, outside INV-06's
const IN    = '03/09/2026 7:00:00';
const IN2   = '03/09/2026 9:00:00';

function grid() {
  return [new Array(26).fill('')].concat([
    rawRow({ callId: 'P1', legId: 0, start: IN,  talk: '0:03:00', calleeName: 'Anna', parentCall: 'N/A' }),
    rawRow({ callId: 'P2', legId: 0, start: IN,  talk: '0:03:00', calleeName: 'Bob',  parentCall: 'N/A' }),
    rawRow({ callId: 'P3', legId: 0, start: IN2, talk: '0:03:00', calleeName: 'Carl', parentCall: 'N/A' }),
    // Anna (CSR): the early-family leg COUNTS, plus a mid-morning miss.
    rawRow({ callId: 'Q1', legId: 0, start: EARLY, caller: 'CallQueue(103)', calleeName: 'Anna', parentCall: 'P1', callerId: 'A_Q_CSR', answered: true }),
    rawRow({ callId: 'Q2', legId: 0, start: IN,    caller: 'CallQueue(103)', calleeName: 'Anna', parentCall: 'P9', callerId: 'A_Q_CSR', missed: true }),
    // Bob (Sales): the SAME early minute on a non-early queue does NOT count.
    rawRow({ callId: 'Q3', legId: 0, start: EARLY, caller: 'CallQueue(105)', calleeName: 'Bob', parentCall: 'P2', callerId: 'A_Q_Sales', answered: true }),
    rawRow({ callId: 'Q4', legId: 0, start: IN,    caller: 'CallQueue(105)', calleeName: 'Bob', parentCall: 'P8', callerId: 'A_Q_Sales', answered: true }),
    // Carl (Power): the R18e shape -- col W carries only the extension, but
    // another leg that day names queue 344 (a queue-callee leg), and CALLER
    // still reads "CallQueue (344)".
    rawRow({ callId: 'N1', legId: 0, start: IN2, callee: '344', calleeName: 'A_Q_FieldOps_Power', parentCall: 'P3' }),
    rawRow({ callId: 'Q5', legId: 0, start: IN2, caller: 'CallQueue (344)', calleeName: 'Carl', parentCall: 'P3', callerId: '344', answered: true }),
  ]);
}

function installAndBuild() {
  h.state.props = {};
  h.state.spreadsheet = makeFakeSpreadsheet({
    sheets: {
      'Raw Data': grid(),
      'DQE Historical Data': [new Array(34).fill('')],
      'DO NOT EDIT!': rosterGrid({ CSR: ['Anna, 103'], Sales: ['Bob, 105'], Power: ['Carl, 344'] }),
    },
  });
  const ss = h.state.spreadsheet;
  h.fn('buildDQEHistoricalData')(ss._sheet('Raw Data'), ss._sheet('DQE Historical Data'));
  return ss;
}

// Logger capture with %s formatting (the shim's Logger discards output).
function runSample() {
  const lines = [];
  const realLogger = h.ctx.Logger;
  h.ctx.Logger = { log: function () {
    const args = Array.prototype.slice.call(arguments);
    let s = String(args.shift());
    args.forEach(function (a) { s = s.replace('%s', String(a)); });
    lines.push(s);
  } };
  try { h.fn('sampleQueueSplitCallIds')(); } finally { h.ctx.Logger = realLogger; }
  return lines;
}

function verdictOf(lines, agent) {
  const m = lines.map(function (l) { return /^--- (\S+)\s+\[(.*)\]$/.exec(l); }).filter(function (x) { return x && x[1] === agent; })[0];
  return m ? m[2] : null;
}

test('P-5: the sample tool reads OK against the REAL build for every agent on the fixture', function () {
  const ss = installAndBuild();
  const dqe = ss._sheet('DQE Historical Data')._data.slice(1);
  assert.equal(dqe.filter(function (r) { return r[2] === 'Anna'; })[0][5], 2, 'precondition: the build rang Anna twice (the early leg counts)');
  assert.equal(dqe.filter(function (r) { return r[2] === 'Bob'; })[0][5], 1, 'precondition: the build rang Bob once (the early Sales leg does not count)');
  assert.equal(dqe.filter(function (r) { return r[2] === 'Carl'; })[0][5], 1, 'precondition: the build recovered Carl\'s leg via the ext fallback');

  const lines = runSample();
  ['Anna', 'Bob', 'Carl'].forEach(function (a) {
    assert.equal(verdictOf(lines, a), 'OK (matches col AI)', a + ': ' + JSON.stringify(lines.filter(function (l) { return l.indexOf(a) !== -1; })));
  });
  assert.ok(lines.some(function (l) { return /A_Q_CSR\s+rung=2 missed=1 answered=1/.test(l); }), 'Anna\'s CSR split counts the early leg');
  assert.ok(lines.some(function (l) { return /A_Q_Sales\s+rung=1 missed=0 answered=1/.test(l); }), 'Bob\'s Sales split excludes the early leg');
  assert.ok(lines.some(function (l) { return /out-of-window: 1 leg\(s\)/.test(l); }), 'and lists it as out-of-window');
  assert.ok(lines.some(function (l) { return /A_Q_FieldOps_Power\s+rung=1/.test(l); }), 'Carl\'s leg is attributed to the ext-recovered queue');
  assert.ok(lines.some(function (l) { return /recovered via the R18e CallQueue-ext fallback 1\)/.test(l); }), 'the recovery is counted in the summary line');
  assert.ok(lines.some(function (l) { return /Work window: legs from 6:30 \(6:00 for the/.test(l); }), 'the work-window line names both floors');
});

test('P-5: the self-check BITES -- a flat floor in the tool reads MISMATCH for the early-family agent', function () {
  installAndBuild();
  const real = h.ctx.dqeWindowStartForQueue_;
  // INV-06's 6:30 floor as a literal: the build's DQE_WINDOW_START is a
  // top-level const, so it is not reachable as a ctx property.
  h.ctx.dqeWindowStartForQueue_ = function () { return (6 * 60 + 30) * 60; };
  let lines;
  try { lines = runSample(); } finally { h.ctx.dqeWindowStartForQueue_ = real; }
  assert.match(String(verdictOf(lines, 'Anna')), /^MISMATCH -- A_Q_CSR sample\(r1\/m1\/a0\) vs sheet\(r2\/m1\/a1\)/,
    'the drift P-5 fixed is exactly what the verdict reports');
  assert.equal(verdictOf(lines, 'Bob'), 'OK (matches col AI)', 'a non-early queue is unaffected by the floor');
});

test('P-5: the sample tool writes nothing', function () {
  const ss = installAndBuild();
  const before = JSON.stringify(ss._sheet('DQE Historical Data')._data) + JSON.stringify(ss._sheet('Raw Data')._data);
  runSample();
  const after = JSON.stringify(ss._sheet('DQE Historical Data')._data) + JSON.stringify(ss._sheet('Raw Data')._data);
  assert.equal(after, before);
});

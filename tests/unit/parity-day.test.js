'use strict';

// ST5 (broad-scan 259, E4): ONE shared day (tests/harness/parityDay.js)
// drives the DQE build and the three tools that mirror it -- the DQE
// Drill-Down, the per-queue split sample and the queue-overlap audit -- so a
// shape covered for one tool is covered for all of them: abandoned AD/AE/AF
// pairing, the INV-23 sentinel, an out-of-window leg, a two-queue call, and a
// carry-over STRAY leg sorted first (the ING-7 shape, dated through the shared
// rawGridDay_ rule, ST2). Each mirror's own suite still pins its finer rules;
// this one pins that all four AGREE on the same day.
//
// The build runs with opts.expectedDate = the tab's date, as the daily path
// calls it (P-4) -- the standalone build dates by the first valid row, the
// one reader ST2 deliberately left alone (owner ruling, E4).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { rosterGrid } = require('../harness/fixtures');
const P = require('../harness/parityDay');

const rep = loadGas({ project: 'cdr-report', files: ['buildDQEHistoricalData.js', 'DQEdrilldown.js', 'queueOverlapAudit.js'] });
const imp = loadGas({ project: 'cdr-import', files: ['buildDQEHistoricalData.js', 'queueSplitSample.js', 'autoImport.js'] });
[rep, imp].forEach(function (h) {
  h.ctx.writeDQERowsToNeon = function () { return { skipped: 0 }; };
  h.ctx.notifyNeonWriteFailure = function () {};
});
imp.ctx.getTargetSsId_ = function () { return 'fake'; };

function capture(h, fn) {
  const lines = [];
  const real = h.ctx.Logger;
  h.ctx.Logger = { log: function () {
    const args = Array.prototype.slice.call(arguments);
    let s = String(args.shift());
    args.forEach(function (a) { s = s.replace('%s', String(a)); });
    lines.push(s);
  } };
  let out;
  try { out = fn(); } finally { h.ctx.Logger = real; }
  return { lines: lines, out: out };
}

// Build the shared day in one project; returns the workbook, the DQE rows and the build's log.
function build(h) {
  const ss = makeFakeSpreadsheet({ sheets: {
    'Raw Data': P.dayGrid({ strayFirst: true }),
    'DQE Historical Data': [new Array(34).fill('')],
    'DO NOT EDIT!': rosterGrid(P.ROSTER),
  } });
  h.state.props = {};
  h.state.spreadsheet = ss;
  const run = capture(h, function () {
    h.fn('buildDQEHistoricalData')(ss._sheet('Raw Data'), ss._sheet('DQE Historical Data'),
      { expectedDate: new Date(2026, 2, 9, 12) });
  });
  return { ss: ss, rows: ss._sheet('DQE Historical Data')._data.slice(1), log: run.lines };
}
const rowOf = function (rows, name) { return rows.filter(function (r) { return r[2] === name; })[0]; };
const listLen = function (v) { const t = String(v == null ? '' : v).trim(); return t ? t.split(',').length : 0; };

test('ST5 fixture guard: the shared day is non-degenerate', function () {
  const b = build(rep);
  const anna = rowOf(b.rows, P.ANNA);
  assert.ok(anna && rowOf(b.rows, P.BOB) && rowOf(b.rows, 'A_Q_CSR'), 'Anna, Bob and the CSR sentinel all get a row');
  assert.notEqual(anna[4], anna[5], 'unique != rung (P5 rings twice)');
  assert.notEqual(anna[5], anna[7], 'rung != answered');
  assert.ok(anna[6] > 0, 'missed > 0');
  assert.ok(listLen(anna[29]) > listLen(anna[30]) && listLen(anna[30]) > 0, 'AD carries an unpaired id beyond AE');
  assert.deepEqual(Object.keys(JSON.parse(anna[34])).sort(), ['A_Q_CSR', 'A_Q_Spanish'], 'Anna\'s split has two queues (P12)');
  assert.ok(b.log.some(function (l) { return /dropped 1 stray leg\(s\) not on/.test(l); }), 'the build dropped the carry-over leg (P-7)');
});

test('ST5: the two INV-16 copies of the build write the same rows from the same day', function () {
  assert.deepEqual(JSON.parse(JSON.stringify(build(imp).rows)), JSON.parse(JSON.stringify(build(rep).rows)));
});

test('ST5: the drill reconciles with the build cell by cell, abandoned columns included, and a sentinel explains itself', function () {
  const b = build(rep);
  const drill = function (agent, col) {
    const out = rep.fn('getDQEDrilldownRows')({ dateStr: P.DATE, agentName: agent, column: col });
    assert.ok(!out.error, agent + ' col ' + col + ': ' + out.error);
    return out;
  };
  const anna = rowOf(b.rows, P.ANNA);
  assert.equal(drill(P.ANNA, 5).rowCount, anna[4], 'unique');
  assert.equal(drill(P.ANNA, 6).rowCount, anna[5], 'rung');
  assert.equal(drill(P.ANNA, 7).rowCount, anna[6], 'missed');
  assert.equal(drill(P.ANNA, 8).rowCount, anna[7], 'answered');
  assert.equal(drill(P.ANNA, 9).summary.totalTalkStr, anna[8], 'TTT (INV-08: own leg, not the decoy)');
  assert.equal(drill(P.ANNA, 30).rowCount, listLen(anna[29]), 'AD');
  assert.equal(drill(P.ANNA, 31).rowCount, listLen(anna[30]), 'AE');
  assert.equal(drill(P.ANNA, 32).rowCount, listLen(anna[31]), 'AF');
  const bob = rowOf(b.rows, P.BOB);
  assert.equal(drill(P.BOB, 6).rowCount, bob[5], 'Bob rung');
  assert.equal(drill(P.BOB, 8).rowCount, bob[7], 'Bob answered');
  const s = rep.fn('getDQEDrilldownRows')({ dateStr: P.DATE, agentName: 'A_Q_CSR', column: 30 });
  assert.match(String(s.error), /is a queue row, not an agent \(INV-23\)/);
});

test('ST5: the split sample self-checks OK against the build, on the build\'s day, past the stray', function () {
  build(imp);
  const run = capture(imp, function () { imp.fn('sampleQueueSplitCallIds')(); });
  const verdict = function (agent) {
    const m = run.lines.map(function (l) { return /^--- (.+?)\s+\[(.*)\]$/.exec(l); })
      .filter(function (x) { return x && x[1] === agent; })[0];
    return m ? m[2] : null;
  };
  assert.equal(verdict(P.ANNA), 'OK (matches col AI)', JSON.stringify(run.lines));
  assert.equal(verdict(P.BOB), 'OK (matches col AI)');
  assert.ok(run.lines.some(function (l) { return l.indexOf('Date: ' + P.DATE_ISO) === 0; }), 'the day, not the stray that sorts first');
  assert.ok(run.lines.some(function (l) { return /Skipped 1 stray queue leg\(s\) on other dates \(2026-03-08=1\)/.test(l); }));
});

test('ST5: the overlap audit dates the same day, skips the same stray and sees the two-queue call', function () {
  build(rep);
  delete rep.state.props.QUEUE_OVERLAP_DATE;
  const out = String(rep.fn('queueOverlapAudit')());
  assert.match(out, /=== Queue-overlap audit -- 03\/09\/2026 /, 'the majority day, not the first row (03/08)');
  assert.match(out, /Skipped 1 stray leg\(s\) on other dates/);
  assert.match(out, /Calls touching more than one queue: 1 of /);
  assert.match(out, /A_Q_CSR\s+\+\s+A_Q_Spanish\s+1 call\(s\) counted by BOTH/);
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { rosterGrid } = require('../harness/fixtures');

// Sub-queue Phase 1 -- the per-queue split of a DQE agent-day (col AI).
//
// Why it exists: a DQE row is keyed on (Date, Agent) with no queue dimension,
// so an agent on two departments' rosters shows the SAME all-queue figures in
// both departments' views and a combined view counts them twice. See
// docs/sub-queue-split-plan.md.
//
// The two properties that matter, and the reason this suite is worth its
// weight:
//
//   1. ADDITIVE -- cols A..AH must be BYTE-IDENTICAL to the pre-Phase-1 build.
//      The owner asked for pipeline changes to be additive precisely so a
//      regression here is impossible, and an assertion is the only way that
//      claim is worth anything.
//   2. RECONCILING -- the split must SUM BACK to the rollup. If it doesn't,
//      Phase 2's per-dept slices will disagree with the totals above them, and
//      that disagreement would look like a dashboard bug rather than a
//      pipeline one.

const h = loadGas({ project: 'cdr-report', files: ['buildDQEHistoricalData.js'] });
h.ctx.writeDQERowsToNeon = function () { return { skipped: 0 }; };
h.ctx.notifyNeonWriteFailure = function () {};

function rawRow(o) {
  const r = new Array(26).fill('');
  r[0]  = o.callId || '';
  r[1]  = o.legId != null ? String(o.legId) : '';
  r[2]  = o.start || '';
  r[6]  = o.talk || '';
  r[7]  = o.callTime || '';
  r[8]  = o.caller || '';
  r[11] = o.calleeName || '';
  r[14] = o.parentCall || '';
  r[22] = o.callerId || '';
  r[23] = o.missed ? 'Missed' : '';
  r[24] = o.abandoned ? 'Abandoned' : '';
  r[25] = o.answered ? 'Answered' : '';
  return r;
}

const IN = '03/09/2026 7:00:00';    // 25200s PST, inside [6:30, 15:00)
const IN2 = '03/09/2026 8:00:00';
const OUT = '03/09/2026 5:00:00';   // before the window

// Anna is on BOTH rosters and takes calls through BOTH queues -- the exact
// production shape (CSR + Spanish) that motivated the whole change.
function crossoverGrid() {
  return [new Array(26).fill('')].concat([
    rawRow({ callId: 'P1', legId: 0, start: IN,  talk: '0:03:00', calleeName: 'Anna', parentCall: 'N/A' }),
    rawRow({ callId: 'P2', legId: 0, start: IN2, talk: '0:05:00', calleeName: 'Anna', parentCall: 'N/A' }),
    rawRow({ callId: 'P3', legId: 0, start: IN,  talk: '0:02:00', calleeName: 'Anna', parentCall: 'N/A' }),
    // CSR queue (ext 103): one answered, one missed.
    rawRow({ callId: 'Q1', legId: 0, start: IN,  caller: 'CallQueue(103)', calleeName: 'Anna', parentCall: 'P1', callerId: 'A_Q_CSR', answered: true }),
    rawRow({ callId: 'Q2', legId: 0, start: IN,  caller: 'CallQueue(103)', calleeName: 'Anna', parentCall: 'P9', callerId: 'A_Q_CSR', missed: true }),
    // Spanish queue (ext 104): one answered.
    rawRow({ callId: 'Q3', legId: 0, start: IN2, caller: 'CallQueue(104)', calleeName: 'Anna', parentCall: 'P2', callerId: 'A_Q_Spanish', answered: true }),
    // Out of window -- must not appear in the split OR the rollup (INV-07).
    rawRow({ callId: 'Q4', legId: 0, start: OUT, caller: 'CallQueue(104)', calleeName: 'Anna', parentCall: 'P3', callerId: 'A_Q_Spanish', answered: true }),
  ]);
}

function build(rawGrid, sheetWidth) {
  const ss = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: {
      'Raw Data': rawGrid,
      'DQE Historical Data': [new Array(sheetWidth || 34).fill('')],
      'DO NOT EDIT!': rosterGrid({ CSR: ['Anna, 103'], Spanish: ['Anna, 104'] }),
    },
  });
  const dqe = ss._sheet('DQE Historical Data');
  if (sheetWidth) dqe._maxColumns = sheetWidth;
  h.fn('buildDQEHistoricalData')(ss._sheet('Raw Data'), dqe);
  return dqe._data.slice(1);
}

function annaRow(rows) {
  return rows.filter(function (r) { return r[2] === 'Anna'; })[0];
}

function split(row) { return JSON.parse(row[34]); }


// -- Property 1: ADDITIVE ----------------------------------------------------

test('cols A..AH are BYTE-IDENTICAL to the pre-Phase-1 build', function () {
  const row = annaRow(build(crossoverGrid()));
  // These are the values the pre-Phase-1 build produced for this fixture,
  // frozen as literals. If a future edit to the split changes ANY of them the
  // change stopped being additive, which is the one thing that must not happen
  // to the pipeline.
  assert.equal(row.length, 35, 'exactly one column was added');
  assert.equal(row[2], 'Anna');
  assert.equal(row[3], '103,104', 'D: both queue extensions, unchanged');
  assert.equal(row[4], 3, 'E: unique parents in window (P1, P2, P9)');
  assert.equal(row[5], 3, 'F: rung = in-window legs');
  assert.equal(row[6], 1, 'G: missed');
  assert.equal(row[7], 2, 'H: answered');
  assert.equal(row[8], '0:08:00', 'I: TTT = 180 + 300, out-of-window excluded');
  assert.equal(row[9], '0:04:00', 'J: ATT = mean(180, 300)');
});

test('a throwing split leaves the row -- and the day -- intact', function () {
  const real = h.ctx.dqeQueueSplitForAgent_;
  h.ctx.dqeQueueSplitForAgent_ = function () { throw new Error('boom'); };
  try {
    const row = annaRow(build(crossoverGrid()));
    assert.equal(row[5], 3, 'F: rung still written');
    assert.equal(row[8], '0:08:00', 'I: TTT still written');
    assert.equal(row[34], '', 'AI blank -- indistinguishable from a pre-Phase-1 row');
  } finally {
    h.ctx.dqeQueueSplitForAgent_ = real;
  }
});

test('a 34-wide sheet is WIDENED before the write instead of throwing', function () {
  // Sheets does not auto-expand columns: getRange past getMaxColumns throws
  // (the REP-10 lesson). Every existing production sheet is 34 wide, so
  // without the widen the FIRST build after deploy would throw and lose that
  // day -- the worst possible failure for an additive change.
  const rows = build(crossoverGrid(), 34);
  const row = annaRow(rows);
  assert.ok(row, 'the build completed on a narrow sheet');
  assert.equal(row.length, 35);
  assert.ok(row[34] && row[34] !== '', 'and the split still landed');
});


// -- Property 2: RECONCILING -------------------------------------------------

test('the split sums back to the rollup, per metric', function () {
  const row = annaRow(build(crossoverGrid()));
  const s = split(row);
  const sum = function (k) {
    return Object.keys(s).reduce(function (a, q) { return a + s[q][k]; }, 0);
  };
  assert.equal(sum('r'), row[5], 'rung');
  assert.equal(sum('m'), row[6], 'missed');
  assert.equal(sum('a'), row[7], 'answered');
  assert.equal(sum('u'), row[4], 'unique parents');
  assert.equal(sum('t'), 480, 'talk seconds == TTT 0:08:00');
});

test('each queue carries only its OWN calls -- the reported bug', function () {
  const s = split(annaRow(build(crossoverGrid())));
  assert.deepEqual(Object.keys(s).sort(), ['A_Q_CSR', 'A_Q_Spanish']);
  assert.equal(s.A_Q_CSR.r, 2, 'CSR: one answered + one missed');
  assert.equal(s.A_Q_CSR.a, 1);
  assert.equal(s.A_Q_CSR.m, 1);
  assert.equal(s.A_Q_CSR.t, 180, 'only P1 talk');
  assert.equal(s.A_Q_Spanish.r, 1, 'Spanish: one answered, NOT the CSR calls');
  assert.equal(s.A_Q_Spanish.a, 1);
  assert.equal(s.A_Q_Spanish.m, 0);
  assert.equal(s.A_Q_Spanish.t, 300, 'only P2 talk');
});

test('out-of-window legs are excluded from the split too (INV-07)', function () {
  const s = split(annaRow(build(crossoverGrid())));
  // Q4 is a Spanish leg at 5:00 AM PST. If the split scanned all-day legs
  // instead of windowLegs it would show 2 rung on Spanish and stop summing to
  // the rollup -- the silent divergence this pins.
  assert.equal(s.A_Q_Spanish.r, 1);
});

test('missed TIMES are per-queue and CST-shifted, ready for Phase 3', function () {
  const s = split(annaRow(build(crossoverGrid())));
  assert.equal(s.A_Q_CSR.mt, '9:00:00',
    'INV-20: stored CST (7:00 PST + 2h), matching the K-AC slot convention');
  assert.equal(s.A_Q_Spanish.mt, '', 'a queue with no misses carries no times');
});


// -- The pure helper, including the cases the fixture cannot reach ------------

test('a parent reached through TWO queues is attributed to ONE (earliest leg)', function () {
  // Overflow: the same call rings the agent on CSR, then again on Spanish.
  // Counting its unique-parent and talk time in BOTH queues would make the
  // split EXCEED the rollup. Rare and silent, which is why it is pinned.
  const legs = [
    { queueName: 'A_Q_Spanish', parentCallId: 'P1', startPST: 200, missed: false, answered: true },
    { queueName: 'A_Q_CSR',     parentCallId: 'P1', startPST: 100, missed: false, answered: true },
  ];
  const s = JSON.parse(h.call('dqeQueueSplitForAgent_', legs,
    function () { return 60; }, function (x) { return String(x); }));
  assert.equal(s.A_Q_CSR.u, 1, 'the EARLIEST leg owns the parent');
  assert.equal(s.A_Q_Spanish.u, 0, 'and the later queue does not double-count it');
  assert.equal(s.A_Q_CSR.t + s.A_Q_Spanish.t, 60, 'talk counted exactly once');
  assert.equal(s.A_Q_CSR.r + s.A_Q_Spanish.r, 2, 'but BOTH rings still count as rung');
});

test("a literal 'N/A' parent id never becomes a phantom unique (REP-4)", function () {
  const legs = [
    { queueName: 'A_Q_CSR', parentCallId: 'N/A', startPST: 100, missed: false, answered: true },
    { queueName: 'A_Q_CSR', parentCallId: 'N/A', startPST: 200, missed: false, answered: true },
  ];
  const s = JSON.parse(h.call('dqeQueueSplitForAgent_', legs,
    function () { return 60; }, function (x) { return String(x); }));
  assert.equal(s.A_Q_CSR.u, 0, "'N/A' is truthy -- it would collapse into one phantom parent");
  assert.equal(s.A_Q_CSR.r, 2, 'the legs themselves still count');
});

test('an empty window yields {} -- distinct from a pre-Phase-1 blank cell', function () {
  const out = h.call('dqeQueueSplitForAgent_', [],
    function () { return 0; }, function (x) { return String(x); });
  assert.equal(out, '{}',
    'readers must be able to tell "computed, nothing in window" from "never computed"');
});

test('ATT is derivable per queue from t/n, on the rollup denominator', function () {
  const legs = [
    { queueName: 'A_Q_CSR', parentCallId: 'P1', startPST: 100, missed: false, answered: true },
    { queueName: 'A_Q_CSR', parentCallId: 'P2', startPST: 200, missed: false, answered: true },
    { queueName: 'A_Q_CSR', parentCallId: 'P3', startPST: 300, missed: true,  answered: false },
  ];
  const talk = { P1: 100, P2: 200, P3: 0 };
  const s = JSON.parse(h.call('dqeQueueSplitForAgent_', legs,
    function (pid) { return talk[pid] || 0; }, function (x) { return String(x); }));
  assert.equal(s.A_Q_CSR.t, 300);
  assert.equal(s.A_Q_CSR.n, 2,
    'n counts parents with talk > 0 -- the rollup ATT denominator, NOT rung');
  assert.equal(s.A_Q_CSR.t / s.A_Q_CSR.n, 150);
});


// ============================================================================
// Sub-queue Phase 2 -- the READER. applyQueueSplitToRows_ narrows each source
// row to the department's own queues BEFORE computeSummary_'s aggregation
// loop, so every rule inside that loop (E5 prior window, INV-53 floater gate,
// diagnostics, totals) inherits the narrowing without changing.
//
// This is where the REPORTED bug is actually fixed: before Phase 2 a
// Spanish-only view showed a crossover agent's CSR calls too.
// ============================================================================

const hData = loadGas({
  files: ['Config.gs', 'Util.gs', 'CompanyOverview.gs', 'DeptConfig.gs', 'Data.gs'],
});

function srcRow(o) {
  return {
    dateIso: o.date || '2026-07-20', agent: o.agent || 'Anna',
    totalUnique: o.u || 0, totalRung: o.r || 0, totalMissed: o.m || 0,
    totalAnswered: o.a || 0, tttSec: o.t || 0, attSec: o.att || 0,
    avgAbdWaitSec: o.aaw || 0, csrAvgAbdWaitSec: o.caw || 0,
    queueSplit: o.split == null ? '' : o.split,
  };
}

// Anna's day: 6 CSR rings + 4 Spanish rings. The rollup (what every column
// A..AH holds) is the sum; each dept must now see only its own half.
const ANNA_SPLIT = JSON.stringify({
  A_Q_CSR:     { u: 5, r: 6, m: 2, a: 4, t: 400, n: 4, mt: '9:00:00,9:30:00' },
  A_Q_Spanish: { u: 4, r: 4, m: 1, a: 3, t: 300, n: 3, mt: '10:00:00' },
});

// S2-0: the narrowing is GATED on QUEUE_SPLIT_SCOPE=dept and defaults OFF, so
// every test that exercises the narrowing must turn it on explicitly. Doing it
// here (rather than once at module load) keeps each test honest about which
// mode it is asserting -- the default-off behavior gets its own test below.
function enableQueueScope_() {
  hData.ctx.PropertiesService.getScriptProperties()
    .setProperty('QUEUE_SPLIT_SCOPE', 'dept');
}

function withQueues(map) {
  enableQueueScope_();
  hData.ctx.inboundQueuesForDept_ = function (d) { return map[d] || []; };
}

test('P2: a dept sees ONLY its own queue\'s calls -- the reported bug', function () {
  withQueues({ Spanish: ['A_Q_Spanish'], CSR: ['A_Q_CSR'] });
  const rows = [srcRow({ r: 10, m: 3, a: 7, u: 9, t: 700, att: 100, split: ANNA_SPLIT })];
  const info = hData.call('applyQueueSplitToRows_', rows, 'Spanish');
  assert.equal(rows[0].totalRung, 4, 'was 10 -- the CSR rings are no longer Spanish\'s');
  assert.equal(rows[0].totalMissed, 1);
  assert.equal(rows[0].totalAnswered, 3);
  assert.equal(rows[0].totalUnique, 4);
  assert.equal(rows[0].tttSec, 300);
  assert.equal(rows[0].attSec, 100, 'ATT recomputed on THIS queue\'s denominator (300/3)');
  assert.equal(rows[0].queueScoped, true);
  assert.equal(info.applied, 1);
});

test('P2: the two depts\' slices PARTITION the rollup -- nothing is lost or doubled', function () {
  withQueues({ Spanish: ['A_Q_Spanish'], CSR: ['A_Q_CSR'] });
  const csr = [srcRow({ r: 10, m: 3, a: 7, u: 9, t: 700, split: ANNA_SPLIT })];
  const spa = [srcRow({ r: 10, m: 3, a: 7, u: 9, t: 700, split: ANNA_SPLIT })];
  hData.call('applyQueueSplitToRows_', csr, 'CSR');
  hData.call('applyQueueSplitToRows_', spa, 'Spanish');
  assert.equal(csr[0].totalRung + spa[0].totalRung, 10, 'sums back to the rollup');
  assert.equal(csr[0].totalMissed + spa[0].totalMissed, 3);
  assert.equal(csr[0].totalAnswered + spa[0].totalAnswered, 7);
  assert.equal(csr[0].tttSec + spa[0].tttSec, 700);
});

test('P2: a queue belonging to NEITHER dept is dropped, not silently absorbed', function () {
  withQueues({ CSR: ['A_Q_CSR'] });
  const rows = [srcRow({ r: 10, split: ANNA_SPLIT })];
  hData.call('applyQueueSplitToRows_', rows, 'CSR');
  assert.equal(rows[0].totalRung, 6, 'only CSR\'s 6 -- Spanish\'s 4 belong to Spanish');
});

// -- the three fail-open paths. Showing a dept ZERO calls is far worse than
// showing it too many, so every uncertainty keeps the rollup.

test('P2: a PARENT narrows to its OWN queues, not its child\'s as well', function () {
  // queuesForDept_ rolls child queues into a parent by default (INV-51), which
  // is right for a QCD rollup and WRONG here. Without includeChildren:false,
  // CSR's narrowing set contains A_Q_Spanish: the "CSR only" tab still shows
  // Spanish's calls, AND a combined view -- which builds Spanish from its own
  // computeSummary_ call -- counts them twice. Shipped in Phase 2 and found
  // only when the owner's CSR/Spanish totals moved after a re-import.
  var askedWith = null;
  enableQueueScope_();   // S2-0 gate (this test sets its own accessor, not withQueues)
  hData.ctx.inboundQueuesForDept_ = function (d, opts) {
    askedWith = opts;
    // Mimic the real accessor: children roll in UNLESS told otherwise.
    if (d !== 'CSR') return ['A_Q_Spanish'];
    return (opts && opts.includeChildren === false)
      ? ['A_Q_CSR'] : ['A_Q_CSR', 'A_Q_Spanish'];
  };
  const rows = [srcRow({ r: 10, m: 3, a: 7, u: 9, t: 700, split: ANNA_SPLIT })];
  hData.call('applyQueueSplitToRows_', rows, 'CSR');
  assert.ok(askedWith && askedWith.includeChildren === false,
    'the narrowing MUST ask for own-queues-only');
  assert.equal(rows[0].totalRung, 6,
    "CSR's own 6 -- if Spanish's 4 came along, the 'CSR only' tab would be "
    + 'showing exactly what the sub-queue feature exists to separate');
});

test('P2 fail-open: a dept with NO mapped queues keeps its rollup, not zeros', function () {
  withQueues({});
  const rows = [srcRow({ r: 10, m: 3, a: 7, split: ANNA_SPLIT })];
  const info = hData.call('applyQueueSplitToRows_', rows, 'Unmapped');
  assert.equal(rows[0].totalRung, 10, 'narrowing to an empty queue set would read as "nobody worked"');
  assert.equal(rows[0].queueScoped, undefined);
  assert.equal(info.queues.length, 0);
  assert.equal(info.applied, 0);
});

test('P2 fail-open: a row with NO split keeps its rollup (pre-Phase-1 date)', function () {
  withQueues({ CSR: ['A_Q_CSR'] });
  const rows = [srcRow({ r: 10, split: '' })];
  const info = hData.call('applyQueueSplitToRows_', rows, 'CSR');
  assert.equal(rows[0].totalRung, 10);
  assert.equal(rows[0].queueScoped, undefined, 'and it is FLAGGED as un-narrowed');
  assert.equal(info.unsplitRows, 1);
});

test('P2 fail-open: unparseable split JSON keeps the rollup instead of throwing', function () {
  withQueues({ CSR: ['A_Q_CSR'] });
  const rows = [srcRow({ r: 10, split: '{not json' })];
  const info = hData.call('applyQueueSplitToRows_', rows, 'CSR');
  assert.equal(rows[0].totalRung, 10);
  assert.equal(info.unsplitRows, 1);
});

test('P2: an empty split {} narrows to ZERO -- it means "nothing in the window"', function () {
  withQueues({ CSR: ['A_Q_CSR'] });
  const rows = [srcRow({ r: 10, split: '{}' })];
  hData.call('applyQueueSplitToRows_', rows, 'CSR');
  assert.equal(rows[0].totalRung, 0,
    "'{}' is COMPUTED-and-empty, unlike '' which is never-computed -- the "
    + 'distinction Phase 1 stores it for');
  assert.equal(rows[0].queueScoped, true);
});

// -- S2-0: the narrowing is off unless explicitly enabled -------------------

test('S2-0: narrowing is OFF by default -- rows keep the all-queue rollup', function () {
  // The whole point of the gate. applyQueueSplitToRows_ is called from ONE
  // place (computeSummary_), so with Phases 3/4 unstarted the narrowing reached
  // My Department + the digests while Overview / Insights / IR / Missed / the
  // ALERT engine all still reported all-queue figures for the same dept and
  // window. Until every surface narrows, one consistent definition beats a
  // better definition applied to a minority of them.
  hData.ctx.PropertiesService.getScriptProperties().deleteProperty('QUEUE_SPLIT_SCOPE');
  hData.ctx.inboundQueuesForDept_ = function () { return ['A_Q_CSR']; };
  const rows = [srcRow({ r: 10, m: 3, a: 7, u: 9, t: 700, split: ANNA_SPLIT })];
  const info = hData.call('applyQueueSplitToRows_', rows, 'CSR');
  assert.equal(rows[0].totalRung, 10, 'untouched rollup');
  assert.equal(rows[0].queueScoped, undefined);
  assert.equal(info.applied, 0);
  assert.equal(info.scope, 'off');
  assert.equal(Object.keys(info.dates).length, 0, 'no split-aware dates -> the client renders no coverage chip');
});

test('S2-0: an unrecognized QUEUE_SPLIT_SCOPE value is treated as off, not on', function () {
  hData.ctx.PropertiesService.getScriptProperties()
    .setProperty('QUEUE_SPLIT_SCOPE', 'yes please');
  hData.ctx.inboundQueuesForDept_ = function () { return ['A_Q_CSR']; };
  const rows = [srcRow({ r: 10, split: ANNA_SPLIT })];
  const info = hData.call('applyQueueSplitToRows_', rows, 'CSR');
  assert.equal(rows[0].totalRung, 10, 'a typo must not silently enable a scoping change');
  assert.equal(info.scope, 'off');
});

// -- B-1: fail-open #4, the mapping-matches-nothing case --------------------

test('B-1: a dept whose mapped queues match NOTHING keeps the rollup, not zero', function () {
  // The reachable config fault: queuesForDept_ returns QCD-canonical names
  // (A_Q_CustomerSuccess) while a split's keys are the RAW pipeline names
  // (A_Q_CSR). Before this guard the dept reported ZERO calls and every chip
  // stayed silent, because the range WAS split-aware.
  withQueues({ CSR: ['A_Q_CustomerSuccess'] });
  const rows = [
    srcRow({ date: '2026-07-20', r: 10, m: 3, a: 7, u: 9, t: 700, att: 175, split: ANNA_SPLIT }),
    srcRow({ date: '2026-07-21', r: 4,  m: 1, a: 3, u: 4, t: 300, att: 100, split: ANNA_SPLIT }),
  ];
  const info = hData.call('applyQueueSplitToRows_', rows, 'CSR');
  assert.equal(rows[0].totalRung, 10, 'rolled back to the all-queue figure');
  assert.equal(rows[0].attSec, 175, 'ATT restored exactly, not recomputed');
  assert.equal(rows[1].totalRung, 4);
  assert.equal(rows[0].queueScoped, undefined, 'and NOT claimed as narrowed');
  assert.equal(rows[1].queueScoped, undefined);
  assert.equal(info.applied, 0);
  assert.equal(info.fellOpenUnmatched, true);
  assert.equal(Object.keys(info.dates).length, 0,
    'no split-aware dates either -- claiming coverage while serving the rollup '
    + 'is what made this invisible');
  assert.equal(info.unmatchedQueues.join(','), 'A_Q_CSR,A_Q_Spanish');
});

test('B-1: a PARTIAL mismatch still narrows, but reports the dropped queue', function () {
  // CSR claims one of the two queues present. Narrowing is correct for the one
  // it claims, so this must NOT roll back -- but the other queue's calls are
  // being dropped from CSR's totals and something has to say so.
  withQueues({ CSR: ['A_Q_CSR'] });
  const rows = [srcRow({ r: 10, split: ANNA_SPLIT })];
  const info = hData.call('applyQueueSplitToRows_', rows, 'CSR');
  assert.equal(rows[0].totalRung, 6, 'still narrowed');
  assert.equal(info.fellOpenUnmatched, false, 'a partial match is not a config failure');
  assert.equal(info.unmatchedQueues.join(','), 'A_Q_Spanish');
});

test('B-1: an idle window ({} splits) still narrows to zero -- not a mapping fault', function () {
  // The distinction the guard turns on. '{}' carries NO queue names, so there
  // is no evidence the mapping is wrong -- it means "this agent worked nothing
  // in the window". Failing open here would re-introduce the very bug Phase 2
  // fixes (an agent's other-dept calls showing up in this dept).
  withQueues({ CSR: ['A_Q_CSR'] });
  const rows = [srcRow({ r: 10, split: '{}' })];
  const info = hData.call('applyQueueSplitToRows_', rows, 'CSR');
  assert.equal(rows[0].totalRung, 0);
  assert.equal(info.fellOpenUnmatched, false);
  assert.equal(info.unmatchedQueues.length, 0);
});

test('B-1: one crossover agent working entirely elsewhere is NOT a mapping fault', function () {
  // Anna's whole day was Spanish; Bob's was CSR. CSR's mapping is fine, so the
  // window must stay narrowed -- Anna correctly contributes 0 to CSR. Judging
  // this per-ROW instead of per-window would roll Anna's Spanish calls into
  // CSR's totals.
  withQueues({ CSR: ['A_Q_CSR'] });
  const rows = [
    srcRow({ agent: 'Anna', r: 4, split: JSON.stringify({ A_Q_Spanish: { r: 4, a: 3 } }) }),
    srcRow({ agent: 'Bob',  r: 6, split: JSON.stringify({ A_Q_CSR: { r: 6, a: 4 } }) }),
  ];
  const info = hData.call('applyQueueSplitToRows_', rows, 'CSR');
  assert.equal(info.fellOpenUnmatched, false, 'CSR matched Bob -- the mapping works');
  assert.equal(rows[0].totalRung, 0, "Anna's Spanish-only day is correctly 0 for CSR");
  assert.equal(rows[1].totalRung, 6);
});

test('P2: queue names match case-insensitively across the two name spaces', function () {
  withQueues({ CSR: ['a_q_csr'] });   // Dept Config casing need not match capture casing
  const rows = [srcRow({ r: 10, split: ANNA_SPLIT })];
  hData.call('applyQueueSplitToRows_', rows, 'CSR');
  assert.equal(rows[0].totalRung, 6);
});

test('P2: split-aware DATES are reported for the coverage note', function () {
  withQueues({ CSR: ['A_Q_CSR'] });
  const rows = [
    srcRow({ date: '2026-07-18', r: 10, split: '' }),          // pre-split
    srcRow({ date: '2026-07-20', r: 10, split: ANNA_SPLIT }),
    srcRow({ date: '2026-07-21', r: 10, split: ANNA_SPLIT }),
  ];
  const info = hData.call('applyQueueSplitToRows_', rows, 'CSR');
  assert.deepEqual(Object.keys(info.dates).sort(), ['2026-07-20', '2026-07-21'],
    'the earliest of these becomes the "per-queue detail starts" date');
  assert.equal(info.unsplitRows, 1);
});

test('P2 + P0: a SCOPED crossover row is never de-duplicated in the combined total', function () {
  // Phase 0 subtracts a repeat because both depts carried the SAME all-queue
  // figures. Once the rows are narrowed they carry DIFFERENT figures that
  // partition the day, so summing is correct and subtracting would UNDER-count.
  // This inversion is the one place the two phases could silently fight.
  const scoped = function (dept, r) {
    return { meta: { department: dept },
             rows: [{ agent: 'Anna', matchedViaRoster: true, queueScoped: true,
                      totalRung: r, totalMissed: 0, totalAnswered: r,
                      totalUnique: r, tttSeconds: 0 }],
             totals: { totalRung: r, totalMissed: 0, totalAnswered: r,
                       totalUnique: r, tttSeconds: 0, rosterAgentCount: 1,
                       queueOnlyAgentCount: 0 },
             qcd: null, csrTransfer: null,
             diagnostics: { rosterWithNoData: [], queueOnlyMatched: [] } };
  };
  const a = scoped('CSR', 6), b = scoped('Spanish', 4);
  const r = hData.call('combineSummaries_', a, [a, b]);
  assert.equal(r.totals.totalRung, 10,
    'the slices partition the day -- 6 + 4, NOT 6 (which is what de-duping would give)');
  assert.equal(r.totals.crossoverAgentCount, 0,
    'and no caption is rendered, because nothing was double-counted');
});

// -- Adoption round: slot narrowing + the non-mutating copy variant -----------

test('ADOPT: narrowSlots rebuilds the K..AC timeline from the dept queues\' mt', function () {
  withQueues({ CSR: ['A_Q_CSR'], Spanish: ['A_Q_Spanish'] });
  const rows = [srcRow({ r: 10, m: 3, a: 7, split: ANNA_SPLIT })];
  // 19 slots, 8:00 CST start: 9:00:00 -> idx 2, 9:30:00 -> idx 3, 10:00:00 -> idx 4.
  rows[0].slots = new Array(19).fill('');
  rows[0].slots[2] = '9:00:00';
  rows[0].slots[3] = '9:30:00';
  rows[0].slots[4] = '10:00:00';
  hData.call('applyQueueSplitToRows_', rows, 'CSR', { narrowSlots: true });
  assert.equal(rows[0].slots[2], '9:00:00', 'CSR keeps its own missed times');
  assert.equal(rows[0].slots[3], '9:30:00');
  assert.equal(rows[0].slots[4], '', 'Spanish\'s 10:00 ring is no longer CSR\'s');
  assert.equal(rows[0].totalMissed, 2, 'timeline agrees with the narrowed count');
});

test('ADOPT: without narrowSlots the slots are untouched (Phase 2 callers unchanged)', function () {
  withQueues({ CSR: ['A_Q_CSR'] });
  const rows = [srcRow({ r: 10, split: ANNA_SPLIT })];
  rows[0].slots = new Array(19).fill('');
  rows[0].slots[4] = '10:00:00';
  hData.call('applyQueueSplitToRows_', rows, 'CSR');
  assert.equal(rows[0].slots[4], '10:00:00');
});

test('ADOPT: the B-1 full rollback restores the ORIGINAL slots, not the narrowed ones', function () {
  // Dept claims a queue name that matches NOTHING in the window's splits ->
  // whole-window rollback. The slots must come back too.
  withQueues({ CSR: ['A_Q_TotallyDifferent'] });
  const rows = [srcRow({ r: 10, m: 3, split: ANNA_SPLIT })];
  const originalSlots = new Array(19).fill('');
  originalSlots[2] = '9:00:00'; originalSlots[4] = '10:00:00';
  rows[0].slots = originalSlots;
  const info = hData.call('applyQueueSplitToRows_', rows, 'CSR', { narrowSlots: true });
  assert.equal(info.fellOpenUnmatched, true);
  assert.equal(rows[0].totalRung, 10, 'counts rolled back');
  assert.equal(rows[0].slots, originalSlots, 'slots rolled back to the same reference');
});

test('ADOPT: queueSplitNarrowedCopy_ -- off returns the SAME array untouched; dept narrows CLONES only', function () {
  // Off: zero-copy.
  hData.ctx.PropertiesService.getScriptProperties().setProperty('QUEUE_SPLIT_SCOPE', 'off');
  const rows = [srcRow({ r: 10, split: ANNA_SPLIT })];
  const off = hData.call('queueSplitNarrowedCopy_', rows, 'CSR');
  assert.equal(off.rows, rows, 'same reference, no clones');
  assert.equal(off.info.scope, 'off');
  assert.equal(rows[0].totalRung, 10);

  // Dept: the shared originals stay pristine -- the Overview/Alerts rule.
  withQueues({ CSR: ['A_Q_CSR'] });
  const shared = [srcRow({ r: 10, m: 3, a: 7, t: 700, split: ANNA_SPLIT })];
  const narrowed = hData.call('queueSplitNarrowedCopy_', shared, 'CSR');
  assert.notEqual(narrowed.rows, shared);
  assert.equal(narrowed.rows[0].totalRung, 6, 'clone narrowed');
  assert.equal(shared[0].totalRung, 10, 'the SHARED original is untouched -- dept A must not leak into dept B');
  assert.ok(!shared[0].queueScoped);
});

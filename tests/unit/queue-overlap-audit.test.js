'use strict';

// queueOverlapAudit() -- the read-only diagnostic behind "does one CALL get
// counted by two queues?"
//
// Context: the Daily Call Queue Report sums a parent dept's queues with its
// sub-queue's (CSR + Spanish). Those counters key on different raw queue
// names, so no LEG is counted twice -- but they are per-leg, and a call that
// overflows from one queue to another has a leg in each, so the SUM
// over-counts it. The DQE split avoids this by assigning parent-level figures
// to the parent's EARLIEST leg; calcQcdReport has no such rule. This
// diagnostic measures the gap instead of leaving it to argument.
//
// The load-bearing property is PARITY: the diagnostic derives a leg's queue
// with the same rules as the real build (IMP-8 boundary regex, the R18e
// CallQueue-ext fallback, the CallForking skip). A third opinion would make
// its numbers un-reconcilable with auditQueueSplitAttribution(), which is the
// whole reason to trust it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

const h = loadGas({
  project: 'cdr-report',
  files: ['buildDQEHistoricalData.js', 'queueOverlapAudit.js'],
});
h.ctx.writeDQERowsToNeon = function () { return { skipped: 0 }; };
h.ctx.notifyNeonWriteFailure = function () {};

const DATE = '03/09/2026';
function raw(o) {
  const r = new Array(26).fill('');
  r[0]  = o.callId || '';
  r[1]  = o.legId != null ? String(o.legId) : '';
  r[2]  = o.start || (DATE + ' 7:00:00');
  r[8]  = o.caller || '';
  r[10] = o.callee || '';
  r[11] = o.calleeName || '';
  r[14] = o.parentCall || '';
  r[22] = o.callerId || '';
  r[23] = o.missed ? 'Missed' : '';
  r[25] = o.answered ? 'Answered' : '';
  return r;
}

// Roster columns start at F (INV-11); "Name, ext" cells (INV-03).
function rosterGridWith(deptToNames) {
  const depts = Object.keys(deptToNames);
  const width = 5 + depts.length;
  const maxLen = Math.max.apply(null, depts.map(function (d) { return deptToNames[d].length; }));
  const rows = [];
  for (let r = 0; r <= maxLen; r++) rows.push(new Array(width).fill(''));
  depts.forEach(function (d, i) {
    rows[0][5 + i] = d;
    deptToNames[d].forEach(function (n, j) { rows[j + 1][5 + i] = n; });
  });
  return rows;
}

function run(rawRows, rosters) {
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: {
      'Raw Data': [new Array(26).fill('')].concat(rawRows),
      'DO NOT EDIT!': rosterGridWith(rosters || { CSR: ['Ana, 101'] }),
    },
  });
  delete h.state.props.QUEUE_OVERLAP_DATE;
  return h.fn('queueOverlapAudit')();
}

// ── The headline measurement ──────────────────────────────────────────────

test('a call that rings TWO queues is reported as counted by both', function () {
  // P1 enters Spanish, overflows to CSR: one call, a leg in each queue.
  // This is exactly the shape that makes CSR+Spanish sum to more than the
  // number of distinct calls.
  const out = run([
    raw({ callId: 'Q1', legId: 0, parentCall: 'P1', callerId: 'A_Q_Spanish', calleeName: 'Ana', missed: true }),
    raw({ callId: 'Q2', legId: 1, parentCall: 'P1', callerId: 'A_Q_CSR',     calleeName: 'Ana', answered: true }),
    raw({ callId: 'Q3', legId: 0, parentCall: 'P2', callerId: 'A_Q_CSR',     calleeName: 'Ana', answered: true }),
  ]);
  assert.match(out, /Calls touching more than one queue: 1 of 2/);
  assert.match(out, /A_Q_CSR {2}\+ {2}A_Q_Spanish\s+1 call\(s\) counted by BOTH/);
});

test('when every call stays in ONE queue it says so explicitly', function () {
  // The answer "your queue sum is sound" has to be as legible as the alarm,
  // or a clean day reads as an inconclusive run.
  const out = run([
    raw({ callId: 'Q1', legId: 0, parentCall: 'P1', callerId: 'A_Q_CSR',     calleeName: 'Ana', answered: true }),
    raw({ callId: 'Q2', legId: 0, parentCall: 'P2', callerId: 'A_Q_Spanish', calleeName: 'Ana', answered: true }),
  ]);
  assert.match(out, /Calls touching more than one queue: 0 of 2/);
  assert.match(out, /NONE -- every call stayed within a single queue/);
});

test('two legs on the SAME queue are one call, not an overlap', function () {
  // A re-ring within one queue must not read as cross-queue exposure.
  const out = run([
    raw({ callId: 'Q1', legId: 0, parentCall: 'P1', callerId: 'A_Q_CSR', calleeName: 'Ana', missed: true }),
    raw({ callId: 'Q2', legId: 1, parentCall: 'P1', callerId: 'A_Q_CSR', calleeName: 'Ana', answered: true }),
  ]);
  assert.match(out, /Calls touching more than one queue: 0 of 1/);
});

test("REP-4: an 'N/A' parent does not collapse every such leg into one call", function () {
  // A literal 'N/A' is truthy; keying on it would fuse unrelated legs into a
  // single phantom call spanning many queues -- a fabricated overlap.
  const out = run([
    raw({ callId: 'C1', legId: 0, parentCall: 'N/A', callerId: 'A_Q_CSR',     calleeName: 'Ana', answered: true }),
    raw({ callId: 'C2', legId: 0, parentCall: 'N/A', callerId: 'A_Q_Spanish', calleeName: 'Ana', answered: true }),
  ]);
  assert.match(out, /Calls touching more than one queue: 0 of 2/,
    'two independent parentless legs are two calls, not one two-queue call');
});

// ── Queue-derivation parity with the real build ───────────────────────────

test('PARITY: the diagnostic derives a leg\'s queue exactly as the build does', function () {
  // Drive BOTH the real build and the diagnostic from one grid. Every queue
  // the build attributes calls to must appear in the diagnostic, or the two
  // reports cannot be reconciled -- which is the only reason to trust this one.
  const rows = [
    // Parent legs (talk) + queue legs across three queues, incl. the two
    // derivation edge cases the build handles.
    raw({ callId: 'P1', legId: 0, calleeName: 'Ana', parentCall: 'N/A' }),
    raw({ callId: 'Q1', legId: 0, parentCall: 'P1', callerId: 'A_Q_CSR', calleeName: 'Ana', answered: true }),
    // IMP-8: `&` must survive whole (A_Q_Eligibility_MM&R, not ..._MM).
    raw({ callId: 'Q2', legId: 0, parentCall: 'P2', callerId: 'A_Q_Eligibility_MM&R', calleeName: 'Ana', answered: true }),
    // R18e: col W carries no queue token; the CallQueue ext resolves it.
    raw({ callId: 'X',  legId: 0, callee: '344', calleeName: 'A_Q_Spanish' }),   // the ext->name row
    raw({ callId: 'Q3', legId: 0, parentCall: 'P3', caller: 'CallQueue (344)', calleeName: 'Ana', answered: true }),
  ];
  const ss = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: {
      'Raw Data': [new Array(26).fill('')].concat(rows),
      'DO NOT EDIT!': rosterGridWith({ CSR: ['Ana, 101'] }),
      'DQE Historical Data': [new Array(34).fill('')],
    },
  });
  h.state.spreadsheet = ss;
  h.fn('buildDQEHistoricalData')(ss._sheet('Raw Data'), ss._sheet('DQE Historical Data'));
  const built = ss._sheet('DQE Historical Data')._data.slice(1)
    .filter(function (r) { return r[2] === 'Ana'; })[0];
  const split = JSON.parse(built[34] || '{}');   // col AI
  const buildQueues = Object.keys(split).sort();
  assert.ok(buildQueues.length >= 3, 'fixture should exercise 3 queues, got ' + buildQueues.join(','));

  delete h.state.props.QUEUE_OVERLAP_DATE;
  const out = h.fn('queueOverlapAudit')();
  buildQueues.forEach(function (q) {
    assert.ok(out.indexOf(q) !== -1,
      'the build attributed calls to ' + q + ' but the diagnostic never names it '
      + '-- the two derivations have diverged and their numbers no longer reconcile');
  });
});

test('a CallForking callee is skipped, matching the build', function () {
  const out = run([
    raw({ callId: 'Q1', legId: 0, parentCall: 'P1', callerId: 'A_Q_CSR',
          callee: 'CallForking123', calleeName: 'Ana', answered: true }),
  ]);
  assert.match(out, /Queue legs: 0/);
});

test('a prefixed token does NOT match as a phantom queue (IMP-8 boundary)', function () {
  const out = run([
    raw({ callId: 'Q1', legId: 0, parentCall: 'P1', callerId: 'UDC_A_Q_Main', calleeName: 'Ana', answered: true }),
  ]);
  assert.match(out, /Queue legs: 0/, 'UDC_A_Q_Main must not read as A_Q_Main');
});

// ── Roster sections ───────────────────────────────────────────────────────

test('section 3 reports which queues a dept\'s rostered agents actually worked', function () {
  // The question "what queue does CSR Backup use?" for a dept with no mapping.
  const out = run([
    raw({ callId: 'Q1', legId: 0, parentCall: 'P1', callerId: 'A_Q_CSR', calleeName: 'Bea', answered: true }),
    raw({ callId: 'Q2', legId: 0, parentCall: 'P2', callerId: 'A_Q_CSR', calleeName: 'Bea', answered: true }),
  ], { CSR: ['Ana, 101'], 'CSR Backup': ['Bea, 102'] });
  assert.match(out, /CSR Backup\s+A_Q_CSR=2/,
    "a dept with no queue mapping should still show where its agents' legs landed");
});

test('section 4 names crossover agents and splits their legs by queue', function () {
  const out = run([
    raw({ callId: 'Q1', legId: 0, parentCall: 'P1', callerId: 'A_Q_CSR',     calleeName: 'Maria', answered: true }),
    raw({ callId: 'Q2', legId: 0, parentCall: 'P2', callerId: 'A_Q_CSR',     calleeName: 'Maria', answered: true }),
    raw({ callId: 'Q3', legId: 0, parentCall: 'P3', callerId: 'A_Q_Spanish', calleeName: 'Maria', answered: true }),
  ], { CSR: ['Maria, 102'], Spanish: ['Maria, 102'] });
  assert.match(out, /1 crossover agent\(s\)/);
  assert.match(out, /maria\s+rosters=\[CSR, Spanish\]/);
  assert.match(out, /A_Q_CSR=2/);
  assert.match(out, /A_Q_Spanish=1/);
});

test('no crossover agents is stated plainly, not left blank', function () {
  const out = run([
    raw({ callId: 'Q1', legId: 0, parentCall: 'P1', callerId: 'A_Q_CSR', calleeName: 'Ana', answered: true }),
  ], { CSR: ['Ana, 101'], Sales: ['Bob, 201'] });
  assert.match(out, /NONE -- no agent is on two rosters/);
});

test('a queue-sentinel row still counts as a queue LEG', function () {
  // INV-23 rows carry a queue id where an agent name goes. The leg is real
  // and belongs in the overlap maths, so it must be counted -- only its
  // "agent" identity is meaningless.
  //
  // NB the source also filters sentinels out of the agent map. That filter is
  // deliberately NOT asserted here: `agentQueue` is read only through roster
  // names (sections 3 and 4), and a sentinel is never a roster name, so
  // removing the filter changes no output. Verified by mutation. It stays as
  // belt-and-braces for a future consumer that iterates the map directly; a
  // test claiming to pin it would pass with it deleted, which is worse than
  // no test.
  const out = run([
    raw({ callId: 'Q1', legId: 0, parentCall: 'P1', callerId: 'A_Q_CSR', calleeName: 'A_Q_CSR', answered: true }),
  ], { CSR: ['Ana, 101'] });
  assert.match(out, /Queue legs: 1/);
  assert.match(out, /NONE -- no agent is on two rosters/);
});

// ── Date selection ────────────────────────────────────────────────────────

test('BUILD PARITY: unpinned, it analyses EVERY row and dates from the FIRST', function () {
  // The build does not date-filter -- 'Raw Data' holds one day, so it takes
  // the date from the first valid START_TIME and processes every row
  // (buildDQEHistoricalData's "Detect call date"). This must match, or the
  // two reports cannot be reconciled.
  const rows = [
    raw({ callId: 'Q1', legId: 0, start: '03/09/2026 7:00:00', parentCall: 'P1', callerId: 'A_Q_CSR', calleeName: 'Ana', answered: true }),
    raw({ callId: 'Q2', legId: 0, start: '03/09/2026 7:30:00', parentCall: 'P2', callerId: 'A_Q_CSR', calleeName: 'Ana', answered: true }),
    raw({ callId: 'Q3', legId: 0, start: '03/10/2026 0:05:00', parentCall: 'P3', callerId: 'A_Q_CSR', calleeName: 'Ana', answered: true }),
  ];
  const out = run(rows);
  assert.match(out, /=== Queue-overlap audit -- 03\/09\/2026 {2}\(all of Raw Data -- build parity\)/,
    'the label comes from the FIRST valid START_TIME, not the maximum');
  assert.match(out, /Queue legs: 3/, 'every row is analysed, carry-over included');
});

test('REGRESSION: a carry-over straggler must not become the analysed date', function () {
  // The bug this replaced. The first version picked the MAXIMUM date and
  // analysed only rows matching it. On a real day that selected the handful
  // of legs that crossed midnight -- 19 of ~1000 -- and then reported a
  // confident "no queue overlap" from 2% of the data. The build's own F2
  // comment names stray carry-over legs as exactly this hazard.
  const rows = [];
  for (let i = 0; i < 40; i++) {
    rows.push(raw({ callId: 'Q' + i, legId: 0, start: '03/09/2026 8:00:00',
                    parentCall: 'P' + i, callerId: 'A_Q_CSR', calleeName: 'Ana', answered: true }));
  }
  // Two stragglers on the NEXT day, one of which spans two queues.
  rows.push(raw({ callId: 'S1', legId: 0, start: '03/10/2026 0:02:00', parentCall: 'PS', callerId: 'A_Q_Spanish', calleeName: 'Ana', missed: true }));
  rows.push(raw({ callId: 'S2', legId: 1, start: '03/10/2026 0:03:00', parentCall: 'PS', callerId: 'A_Q_CSR',     calleeName: 'Ana', answered: true }));

  const out = run(rows);
  assert.match(out, /Queue legs: 42/,
    'all 42 legs must be analysed -- selecting only the 2 stragglers is the bug');
  assert.match(out, /Calls touching more than one queue: 1 of 41/);
});

test('the date DISTRIBUTION is printed, so a mixed sheet is visible', function () {
  // The silent failure mode was invisible because nothing showed how much of
  // the sheet was being read.
  const out = run([
    raw({ callId: 'Q1', legId: 0, start: '03/09/2026 8:00:00', parentCall: 'P1', callerId: 'A_Q_CSR', calleeName: 'Ana', answered: true }),
    raw({ callId: 'Q2', legId: 0, start: '03/10/2026 0:02:00', parentCall: 'P2', callerId: 'A_Q_CSR', calleeName: 'Ana', answered: true }),
  ]);
  assert.match(out, /Raw Data rows by date/);
  assert.match(out, /03\/09\/2026\s+1 row\(s\).*<- the build dates this sheet here/);
  assert.match(out, /03\/10\/2026\s+1 row\(s\)/);
});

test('QUEUE_OVERLAP_DATE pins one date and says it is NOT build parity', function () {
  const rows = [
    raw({ callId: 'Q1', legId: 0, start: '03/09/2026 7:00:00', parentCall: 'P1', callerId: 'A_Q_CSR', calleeName: 'Ana', answered: true }),
    raw({ callId: 'Q2', legId: 0, start: '03/10/2026 0:05:00', parentCall: 'P2', callerId: 'A_Q_CSR', calleeName: 'Ana', answered: true }),
  ];
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: {
      'Raw Data': [new Array(26).fill('')].concat(rows),
      'DO NOT EDIT!': rosterGridWith({ CSR: ['Ana, 101'] }),
    },
  });
  h.state.props.QUEUE_OVERLAP_DATE = '03/10/2026';
  const out = h.fn('queueOverlapAudit')();
  assert.match(out, /\(PINNED to one date\)/);
  assert.match(out, /Queue legs: 1/);
  assert.match(out, /NOT build parity/);
  delete h.state.props.QUEUE_OVERLAP_DATE;
});

test('a pin covering a tiny slice of the sheet WARNS that it is probably wrong', function () {
  // Precisely the 19-of-1000 shape: if someone pins the carry-over date, the
  // output must say so rather than answering confidently from 2% of the day.
  const rows = [];
  for (let i = 0; i < 30; i++) {
    rows.push(raw({ callId: 'Q' + i, legId: 0, start: '03/09/2026 8:00:00',
                    parentCall: 'P' + i, callerId: 'A_Q_CSR', calleeName: 'Ana', answered: true }));
  }
  rows.push(raw({ callId: 'S1', legId: 0, start: '03/10/2026 0:02:00', parentCall: 'PS', callerId: 'A_Q_CSR', calleeName: 'Ana', answered: true }));
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: {
      'Raw Data': [new Array(26).fill('')].concat(rows),
      'DO NOT EDIT!': rosterGridWith({ CSR: ['Ana, 101'] }),
    },
  });
  h.state.props.QUEUE_OVERLAP_DATE = '03/10/2026';
  const out = h.fn('queueOverlapAudit')();
  assert.match(out, /under a fifth of the sheet/);
  delete h.state.props.QUEUE_OVERLAP_DATE;
});

test('section 2 reads the real parent map and quantifies the summation overlap', function () {
  // Dept Config lives in this same workbook, so the diagnostic can name the
  // actual parent/child pairs instead of giving up.
  const rows = [
    raw({ callId: 'Q1', legId: 0, parentCall: 'P1', callerId: 'A_Q_Spanish', calleeName: 'Ana', missed: true }),
    raw({ callId: 'Q2', legId: 1, parentCall: 'P1', callerId: 'A_Q_CSR',     calleeName: 'Ana', answered: true }),
    raw({ callId: 'Q3', legId: 0, parentCall: 'P2', callerId: 'A_Q_CSR',     calleeName: 'Ana', answered: true }),
  ];
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: {
      'Raw Data': [new Array(26).fill('')].concat(rows),
      'DO NOT EDIT!': rosterGridWith({ CSR: ['Ana, 101'] }),
      // Department | QCD Queues | Overview Parent | ... | Active(5) | ... | aliases(9)
      'Dept Config': [
        ['Department', 'QCD Queues', 'Overview Parent', 'Team Avg', 'Ext', 'Active', 'By', 'At', 'Notes', 'Inbound queue aliases'],
        ['CSR',     'A_Q_CSR',     '',    '', '', 'TRUE', '', '', '', ''],
        ['Spanish', 'A_Q_Spanish', 'CSR', '', '', 'TRUE', '', '', '', ''],
      ],
    },
  });
  delete h.state.props.QUEUE_OVERLAP_DATE;
  const out = h.fn('queueOverlapAudit')();
  assert.match(out, /CSR \[A_Q_CSR\]/);
  assert.match(out, /\+ Spanish \[A_Q_Spanish\]/);
  assert.match(out, /1 call\(s\) touch BOTH sides, so a queue-sum over-counts by 1/);
});

test('section 2 reports an EXACT sum when nothing touches both sides', function () {
  const rows = [
    raw({ callId: 'Q1', legId: 0, parentCall: 'P1', callerId: 'A_Q_CSR',     calleeName: 'Ana', answered: true }),
    raw({ callId: 'Q2', legId: 0, parentCall: 'P2', callerId: 'A_Q_Spanish', calleeName: 'Ana', answered: true }),
  ];
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: {
      'Raw Data': [new Array(26).fill('')].concat(rows),
      'DO NOT EDIT!': rosterGridWith({ CSR: ['Ana, 101'] }),
      'Dept Config': [
        ['Department', 'QCD Queues', 'Overview Parent', 'Team Avg', 'Ext', 'Active', 'By', 'At', 'Notes', 'Inbound queue aliases'],
        ['CSR',     'A_Q_CSR',     '',    '', '', 'TRUE', '', '', '', ''],
        ['Spanish', 'A_Q_Spanish', 'CSR', '', '', 'TRUE', '', '', '', ''],
      ],
    },
  });
  delete h.state.props.QUEUE_OVERLAP_DATE;
  assert.match(h.fn('queueOverlapAudit')(), /0 calls touch both sides. Summing the two is EXACT/);
});

test('it writes nothing and survives a missing Raw Data sheet', function () {
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: { 'DO NOT EDIT!': rosterGridWith({ CSR: ['Ana, 101'] }) } });
  assert.doesNotThrow(function () { h.fn('queueOverlapAudit')(); });
});

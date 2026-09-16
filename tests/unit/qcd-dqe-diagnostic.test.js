'use strict';

// The QCD-vs-DQE reconciliation diagnostic (cdr-import/qcdDqeDiagnostic.js).
//
// The tool exists to explain why a dept's QCD "Queue Calls" answered (QCDR
// Output rows 34-37) and the dashboard's per-agent answered sum disagree. To do
// that it must hold BOTH rule sets, which makes it a FIFTH hand-mirror of
// calcQcdReport -- the repo's recurring defect class (dataFilters.js and
// DQEdrilldown.js are the third and fourth, and every drift so far has been the
// verification tool contradicting the build during the investigation it exists
// to serve).
//
// So the tool never asks to be trusted: at run time it reconciles itself
// against calcQcdReport AND the stored DQE rows, and REFUSES when either check
// fails. This suite pins the same property statically:
//   1. BEHAVIORAL parity -- one shared fixture drives the real calcQcdReport
//      and the mirror; rows 35/36/37 col D must agree, with no hardcoded
//      expected numbers, so a rule edit in either place fails here.
//   2. SOURCE pins on the two pieces copied out of buildDQEHistoricalData
//      (they are nested inside that function, so they cannot be called).
//   3. The gate attribution -- the reason a leg the CSR block counted is
//      absent from DQE must name the gate that actually fired first.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadGas } = require('../harness/loadGas');

// The loaded files run in a vm realm, so plain objects they return do not share
// the host's Object.prototype and deepStrictEqual rejects them on identity.
// Re-key into a host object before comparing shapes.
const plain = (o) => Object.assign({}, o);

const IMPORT_DIR = path.resolve(__dirname, '../../apps-script/cdr-import');
const DIAG_SRC = fs.readFileSync(path.join(IMPORT_DIR, 'qcdDqeDiagnostic.js'), 'utf8');
const BUILD_SRC = fs.readFileSync(path.join(IMPORT_DIR, 'buildDQEHistoricalData.js'), 'utf8');

const h = loadGas({
  project: 'cdr-import',
  files: ['autoImport.js', 'buildDQEHistoricalData.js', 'qcdDqeDiagnostic.js'],
});

// ── Shared fixture ──────────────────────────────────────────────────────────
// Column map, 0-based, as BOTH rule sets read it:
//   QCD  1=status 2=start 4=end 5=type 6=talk(colG) 7=wait 9=callerName("team")
//        11=calleeName("queueName") 16=dnis 24=abandoned 26=transfer
//   DQE  2=START_TIME 8=CALLER 10=CALLEE 11=CALLEE_NAME 22=CALLER_ID 25=ANSWERED
const MAX_COLS = 44;
const CSR_AGENT = 'Casey Csr';
const EXCLUDED  = 'Rajesh Patel';        // on DQE_EXCLUDED_AGENTS
const EXC_AGENT = 'Exc Agent';           // on the csr_exceptions named range

let rawSeq_ = 1;
function raw(o) {
  const r = new Array(MAX_COLS).fill('');
  r[1]  = o.status || '';
  r[2]  = o.start || '09/14/2026 10:00:00';
  r[4]  = o.end   || '09/14/2026 10:05:00';
  r[5]  = o.type  || '';
  r[6]  = o.talk  || '';
  r[7]  = o.wait  || '0:00:00';
  r[9]  = o.callerName || 'Dana Sales';
  r[11] = o.callee || CSR_AGENT;
  r[16] = '5551234';
  r[8]  = o.caller === undefined ? 'CallQueue (304)' : o.caller;
  r[10] = o.calleeExt || '201';
  r[22] = o.callerId === undefined ? 'A_Q_CSR,304' : o.callerId;
  r[0]  = o.callId || ('call' + (rawSeq_++));
  r[14] = o.parent === undefined ? 'N/A' : o.parent;
  r[25] = o.answered === false ? '' : 'Answered';
  return r;
}

const HEADER = new Array(MAX_COLS).fill('h');
const ROWS = [
  // 1. Call Menu (r35) AND a DQE answered leg -- the reconciling case.
  raw({ status: '4', type: 'incoming' }),
  // 2. Misc (r36): talked, status != 4, and NO queue token anywhere.
  raw({ status: '2', type: 'incoming', talk: '0:01:00', callerId: '5551234', caller: '5551234' }),
  // 3. Internal (r37): talked, callee on csr_team, caller NOT on it, no token.
  raw({ type: 'internal', status: '1', talk: '0:02:00',
        callerId: 'Dana Sales,410', caller: '410' }),
  // 4. Call Menu at 6:15 -- inside QCD's 6:00 floor, outside DQE's 6:30 one.
  raw({ status: '4', type: 'incoming',
        start: '09/14/2026 06:15:00', end: '09/14/2026 06:20:00' }),
  // 5. Call Menu for a DQE-excluded pseudo-agent that sits on csr_team.
  raw({ status: '4', type: 'incoming', callee: EXCLUDED }),
  // 6. Misc shape, queue-delivered, but not flagged Answered by the feed.
  raw({ status: '2', type: 'incoming', talk: '0:01:00', answered: false }),
  // 7. DQE-only: a csr_team agent's answered queue leg in NO CSR block row
  //    (status 1 incoming with zero talk fails r36's colG gate).
  raw({ status: '1', type: 'incoming', callerId: 'A_Q_Billing,320',
        caller: 'CallQueue (320)' }),
  // 8. Internal leg between TWO csr_team members -- row 37 requires the caller
  //    to be off the team, so the CSR block must NOT count it. DQE does.
  raw({ type: 'internal', status: '1', talk: '0:02:00', callerName: EXCLUDED }),
  // 9. Window EDGE: a Misc-shaped call ending at 3:10 PM. Row 36 has no
  //    start<3PM clause and allows end<3:30PM, so the CSR block counts it;
  //    DQE's window is on the START, so it counts it too. 24-hour clock on
  //    purpose -- the build's displayToTimeSec has no AM/PM branch, while
  //    QCD's simulateSplitCol2 does, so a 12-hour feed would diverge here.
  raw({ status: '2', type: 'incoming', talk: '0:01:00',
        start: '09/14/2026 14:50:00', end: '09/14/2026 15:10:00' }),
  // 10. Row 35's SECOND arm: status 5 on a csr_exceptions callee. Dropping it
  //     would under-report Call Menu for every exception queue.
  raw({ status: '5', type: 'incoming', callee: EXC_AGENT, calleeExt: '777' }),
  // 11. The window BOUNDARY: a leg starting exactly at 3:00:00 PM. DQE's
  //     window is half-open, so it is out; row 36 (end<3:30PM) counts it.
  raw({ status: '2', type: 'incoming', talk: '0:01:00',
        start: '09/14/2026 15:00:00', end: '09/14/2026 15:10:00' }),
  // 12. Row 36's exceptions arm: status neither 4 nor 5 on a csr_exceptions
  //     callee. Both sides count it.
  raw({ status: '2', type: 'incoming', talk: '0:01:00',
        callee: EXC_AGENT, calleeExt: '777' }),
  // 13. Before calcQcdReport's 6:00 AM global guard -- neither side counts it.
  raw({ status: '4', type: 'incoming',
        start: '09/14/2026 05:30:00', end: '09/14/2026 05:40:00' }),
  // 14. A CallForking callee: the CSR block reads col 11 and counts it, the
  //     DQE build skips the leg on col 10 before it ever looks at the name.
  raw({ status: '4', type: 'incoming', calleeExt: 'CallForking999' }),
  // 15. An unparseable END time. calcQcdReport's global guard drops the leg
  //     before any row counter; without that guard row 36's `end < 3:30 PM`
  //     reads the -1 sentinel as "early" and counts it.
  raw({ status: '2', type: 'incoming', talk: '0:01:00', end: 'n/a' }),
];
const GRID = [HEADER].concat(ROWS);

const CSR_TEAM = new Set([CSR_AGENT.toLowerCase(), EXCLUDED.toLowerCase()]);
const CSR_EXC  = new Set([EXC_AGENT.toLowerCase()]);

function ctx_(over) {
  return Object.assign({
    canonicalize: function (n) { return n; },
    csrTeamSet: CSR_TEAM,
    csrExceptionsSet: CSR_EXC,
    deptOfAgent: { 'Casey Csr': ['CSR'] },
    excludedAgents: h.consts.DQE_EXCLUDED_AGENTS_ || [EXCLUDED],
  }, over || {});
}

// The real pipeline, driven on the SAME grid.
function targetSS_() {
  return {
    getSheetByName: function (name) {
      if (name === 'QCDR Output') {
        return { getRange: function (a1) {
          assert.equal(a1, 'A2:B49');
          const g = []; for (let r = 2; r <= 49; r++) g.push(['', '']);
          return { getValues: function () { return g; } };
        } };
      }
      return null;
    },
    getRangeByName: function (name) {
      if (name === 'csr_team') return { getValues: function () { return [[CSR_AGENT + ', 201'], [EXCLUDED + ', 205']]; } };
      if (name === 'csr_exceptions') return { getValues: function () { return [[EXC_AGENT + ', 777']]; } };
      return null;
    },
  };
}

// ── 1. Behavioral parity with the authority it checks against ───────────────

test('mirror reproduces calcQcdReport rows 35/36/37 col D on a shared fixture', () => {
  const real = h.fn('calcQcdReport')(GRID, targetSS_());
  const mine = h.fn('qddAnalyzeDay_')(GRID, ctx_());
  [35, 36, 37].forEach((r) => {
    assert.equal(mine.qcdD[r], Number(real.output[r - 2][1]) || 0,
      'row ' + r + ' col D: mirror ' + mine.qcdD[r] + ' vs calcQcdReport ' + (real.output[r - 2][1]));
  });
  // Guard against a vacuous pass: the fixture must actually exercise all three.
  assert.ok(mine.qcdD[35] > 0 && mine.qcdD[36] > 0 && mine.qcdD[37] > 0,
    'fixture must produce a non-zero count in every CSR-block row');
});

// ── 2. Source pins on the pieces copied out of buildDQEHistoricalData ───────

test('qddDisplayToTimeSec_ is byte-identical to the build nested displayToTimeSec', () => {
  const body = function (src, name) {
    const i = src.indexOf('function ' + name + '(str) {');
    assert.ok(i !== -1, 'could not find ' + name);
    const j = src.indexOf('\n  }', i);
    const k = src.indexOf('\n}', i);
    const end = j !== -1 && (k === -1 || j < k) ? j : k;
    return src.slice(src.indexOf('{', i) + 1, end)
              .replace(/\s+/g, ' ').trim();
  };
  assert.equal(body(DIAG_SRC, 'qddDisplayToTimeSec_'), body(BUILD_SRC, 'displayToTimeSec'),
    'the diagnostic copy has drifted from the build; a wrong window makes every '
    + '"outside-dqe-window" verdict wrong in the same direction');
});

test('the DQE queue-token regex matches the build byte-for-byte', () => {
  const RE = /\/\(\?:\^\|\[\^\\w&\]\)\(A_Q_\[\\w&\]\+\|Backup CSR\)\//;
  assert.ok(RE.test(BUILD_SRC), 'the build regex changed -- re-derive this pin');
  assert.ok(RE.test(DIAG_SRC), 'the diagnostic queue-token regex has drifted from the build');
  // And the R18e CallQueue-extension fallback travels with it.
  assert.ok(/\^CallQueue\\s\*\\\(\(\\d\+\)\\\)\$/.test(DIAG_SRC),
    'the diagnostic must carry the R18e CallQueue(ext) fallback or it over-reports '
    + 'no-queue-token on exactly the queues that lost their col-W name');
});

// ── 3. Gate attribution ─────────────────────────────────────────────────────

test('each CSR-block leg DQE misses names the gate that fired first', () => {
  const out = h.fn('qddAnalyzeDay_')(GRID, ctx_());
  assert.equal(out.reasons['no-queue-token'], 2,       // the Misc + Internal rows
    'expected the two token-less legs: ' + JSON.stringify(out.reasons));
  assert.equal(out.reasons['outside-dqe-window'], 2);   // the 6:15 leg and the 3:00 PM boundary
  assert.equal(out.reasons['excluded-agent'], 1);
  assert.equal(out.reasons['not-flagged-answered'], 1);
  assert.equal(out.reasons['callforking-callee'], 1);
  // Every CSR-block leg is accounted for exactly once: either DQE counts it
  // too, or exactly one gate is named. An unattributed leg would be a silent
  // hole in the very tally the report is read for.
  const total = Object.keys(out.reasons).reduce((a, k) => a + out.reasons[k], 0);
  assert.equal(total + out.qcdAlsoDqe, out.qcdD[35] + out.qcdD[36] + out.qcdD[37]);
  assert.ok(out.qcdAlsoDqe > 0 && total > 0, 'fixture must exercise both outcomes');
});

test('the queue gate is reported ahead of the window gate', () => {
  // A leg failing BOTH must name the gate the build short-circuits on first --
  // "outside-dqe-window" here would send an operator to the work window when
  // the leg was never in the build universe at all.
  const grid = [HEADER, raw({ status: '4', type: 'incoming', callerId: '5551234',
    caller: '5551234', start: '09/14/2026 06:15:00', end: '09/14/2026 06:20:00' })];
  const out = h.fn('qddAnalyzeDay_')(grid, ctx_());
  assert.deepEqual(plain(out.reasons), { 'no-queue-token': 1 });
  assert.equal(out.detail[0].reason, 'no-queue-token');
});

test('detail rows carry the fields that decide the verdict', () => {
  const out = h.fn('qddAnalyzeDay_')(GRID, ctx_());
  const internal = out.detail.filter((d) => d.qcdRow === 37);
  assert.equal(internal.length, 1);
  const d = internal[0];
  assert.equal(d.agent, CSR_AGENT);
  assert.equal(d.direction, 'internal');
  assert.equal(d.callerName, 'Dana Sales');
  assert.equal(d.callerId, 'Dana Sales,410');
  assert.equal(d.answeredFlag, 'Answered');
  assert.equal(d.sheetRow, 4, 'row number must point at the Call_Legs sheet row');
});

// ── 4. The other direction, and the per-agent cross-tab ─────────────────────

test('DQE-counted legs outside the CSR block are bucketed by queue', () => {
  const out = h.fn('qddAnalyzeDay_')(GRID, ctx_());
  assert.deepEqual(plain(out.dqeOnlyByQueue), { 'A_Q_Billing': 1, 'A_Q_CSR': 2 },
    'this is the term that pushes the dept table ABOVE the queue block');
});

test('per-agent cross-tab separates the three CSR rows from DQE answered', () => {
  const out = h.fn('qddAnalyzeDay_')(GRID, ctx_());
  const casey = out.byAgent[CSR_AGENT];
  assert.equal(casey.q35, 3);           // rows 1, 4 and 14
  assert.equal(casey.q36, 4);           // rows 2, 6, 9 and 11
  assert.equal(casey.q37, 1);           // row 3
  assert.equal(casey.qTotal, 8);
  assert.equal(casey.dqeAnswered, 5);   // rows 1, 7, 8, 9 and 15
  assert.deepEqual(casey.depts, ['CSR']);
  assert.equal(out.byAgent[EXCLUDED].dqeAnswered, 0);
  assert.equal(out.byAgent[EXC_AGENT].q35, 1, 'the csr_exceptions status-5 arm of row 35');
  assert.equal(out.byAgent[EXC_AGENT].q36, 1, 'the csr_exceptions arm of row 36');
  assert.equal(out.byAgent[EXC_AGENT].dqeAnswered, 2);
});

test('the R18e fallback recovers a leg whose col W lost its queue name', () => {
  // The Field Ops Power shape: col W carries only the extension, but CALLER
  // still reads "CallQueue (344)" and another leg that day named queue 344.
  const namer = new Array(MAX_COLS).fill('');
  namer[10] = '344'; namer[11] = 'A_Q_FieldOps_Power';
  namer[2] = '09/14/2026 09:00:00'; namer[4] = '09/14/2026 09:01:00';
  const grid = [HEADER, namer, raw({ status: '2', type: 'incoming', talk: '0:01:00',
    callerId: '354', caller: 'CallQueue (344)' })];
  const out = h.fn('qddAnalyzeDay_')(grid, ctx_());
  assert.equal(out.qcdD[36], 1, 'the QCD side still counts it');
  assert.deepEqual(plain(out.reasons), {}, 'and DQE counts it too, via the ext fallback');
  assert.equal(out.byAgent[CSR_AGENT].dqeAnswered, 1);
});

// ── 5. Date normalization for the stored-DQE reconciliation ────────────────

test('stored-row date matching tolerates both sheet renderings', () => {
  const n = h.fn('qddNormalizeDateStr_');
  assert.equal(n('2026-09-14'), '2026-09-14');
  assert.equal(n('9/14/2026'), '2026-09-14');
  assert.equal(n('09/14/2026'), '2026-09-14');
  assert.equal(n('9/14/2026 0:00:00'), '2026-09-14');
  assert.equal(n(''), '');
});

// ── 6. The refusal is wired, not decorative ────────────────────────────────

test('a failed reconciliation yields INCONCLUSIVE, not a gap analysis', () => {
  assert.ok(/verdict\s*=\s*\(!qcdOk \|\| !dqeOk\)/.test(DIAG_SRC),
    'the verdict must be driven by BOTH reconciliations');
  assert.ok(/INCONCLUSIVE/.test(DIAG_SRC));
  assert.ok(/qcdOk = QDD_CSR_ROWS_\.every/.test(DIAG_SRC),
    'the QCD check must compare every CSR-block row, not just one');
});

test('the tool writes no data sheet', () => {
  // Only its own tab may be written. Any other setValues/appendRow would make
  // a "read-only diagnostic" a lie on a spreadsheet the owner calls sensitive.
  const writes = DIAG_SRC.match(/\.(setValues|setValue|appendRow|deleteRow|clear)\(/g) || [];
  const inTabWriter = DIAG_SRC.slice(DIAG_SRC.indexOf('function qddWriteReportTab_'));
  const outsideTabWriter = (DIAG_SRC.slice(0, DIAG_SRC.indexOf('function qddWriteReportTab_'))
    .match(/\.(setValues|setValue|appendRow|deleteRow|clear)\(/g) || []);
  assert.deepEqual(outsideTabWriter, [],
    'every write must live in qddWriteReportTab_, which touches only its own tab');
  assert.ok(writes.length > 0 && inTabWriter.indexOf('insertSheet') !== -1);
  assert.ok(!/PropertiesService[\s\S]*setProperty/.test(DIAG_SRC),
    'the diagnostic must set no Script Properties');
});

// ── 6b. The parent join: same call, or a different one? ────────────────────

test('a CSR-block leg on a call the agent was already credited for reads sameAgent', () => {
  const grid = [HEADER,
    // The queue-delivered leg DQE counts (status 1 + no talk, so the CSR block
    // does not also claim it -- keeps this test about the JOIN, not the rows)...
    raw({ status: '1', type: 'incoming', callId: 'legA', parent: 'P1' }),
    // ...and a second leg of the SAME call that only the CSR block counts.
    raw({ status: '2', type: 'incoming', talk: '0:01:00', callId: 'legB', parent: 'P1',
          callerId: '5551234', caller: '5551234' }),
  ];
  const out = h.fn('qddAnalyzeDay_')(grid, ctx_());
  assert.equal(out.qcdD[36], 1);
  assert.equal(out.parentJoin.sameAgent, 1);
  assert.equal(out.parentJoin.none, 0);
  assert.equal(out.detail[0].sibling, 'sameAgent');
});

test('a CSR-block leg on a call NO ONE was credited for reads none', () => {
  const grid = [HEADER,
    raw({ status: '2', type: 'incoming', talk: '0:01:00', callId: 'legC', parent: 'P9',
          callerId: '5551234', caller: '5551234' }),
  ];
  const out = h.fn('qddAnalyzeDay_')(grid, ctx_());
  assert.equal(out.parentJoin.none, 1);
  assert.equal(out.parentJoin.sameAgent, 0);
  assert.equal(out.detail[0].sibling, 'none');
  assert.deepEqual(plain(out.orphanSample[0]), { agent: CSR_AGENT, parentKey: 'P9' });
});

test('a call credited to a DIFFERENT agent is not counted as this one\'s', () => {
  // The dept has the call; this agent does not. Collapsing the two would hide a
  // real per-agent attribution question behind a dept-level "all accounted for".
  const grid = [HEADER,
    raw({ status: '4', type: 'incoming', callee: EXC_AGENT, calleeExt: '777',
          callId: 'legD', parent: 'P2' }),
    raw({ status: '2', type: 'incoming', talk: '0:01:00', callId: 'legE', parent: 'P2',
          callerId: '5551234', caller: '5551234' }),
  ];
  const out = h.fn('qddAnalyzeDay_')(grid, ctx_());
  assert.equal(out.parentJoin.otherAgent, 1);
  assert.equal(out.parentJoin.sameAgent, 0);
  assert.equal(out.parentJoin.none, 0);
});

test('a leg that IS the parent joins on its own call id', () => {
  // parent 'N/A' means the leg is the root; keying it as blank would make every
  // such leg an orphan and manufacture an under-crediting finding.
  const grid = [HEADER,
    raw({ status: '1', type: 'incoming', callId: 'P3', parent: 'N/A' }),
    raw({ status: '2', type: 'incoming', talk: '0:01:00', callId: 'legF', parent: 'P3',
          callerId: '5551234', caller: '5551234' }),
  ];
  const out = h.fn('qddAnalyzeDay_')(grid, ctx_());
  assert.equal(out.parentJoin.sameAgent, 1);
});

test('the reading names under-crediting only when a call has no DQE leg', () => {
  const reading = h.fn('qddParentJoinReading_');
  assert.match(reading({ sameAgent: 5, otherAgent: 1, none: 0 }), /two VIEWS of the same calls/);
  assert.match(reading({ sameAgent: 5, otherAgent: 1, none: 0 }), /No agent is under-credited/);
  assert.match(reading({ sameAgent: 0, otherAgent: 0, none: 7 }), /genuinely separate/);
  assert.match(reading({ sameAgent: 3, otherAgent: 0, none: 2 }), /^2 of 5 /);
  assert.match(reading({ sameAgent: 0, otherAgent: 0, none: 0 }), /no CSR-block legs/);
});

// ── 7. Locating the day's legs ──────────────────────────────────────────────

function fakeBook_(id, sheets) {
  return {
    getId: () => id,
    getSheets: () => Object.keys(sheets).map((n) => sheets[n]),
    getSheetByName: (n) => sheets[n] || null,
  };
}
function fakeTab_(name, opts) {
  opts = opts || {};
  return {
    getName: () => name,
    getLastRow: () => (opts.lastRow === undefined ? 10 : opts.lastRow),
    // Raw Data's date must be read from the leg START column (row 2, col C).
    // A fake that answers any cell would let a wrong-column read pass.
    getRange: (r, c) => ({
      getDisplayValue: () => (r === 2 && c === 3 ? (opts.firstStart || '') : ''),
    }),
  };
}

test('a dated Call_Legs tab is preferred, in either workbook', () => {
  const resolve = h.fn('qddResolveLegsSheet_');
  const tab = fakeTab_('Call_Legs_2026-09-14');
  const src = fakeBook_('A', {});
  const tgt = fakeBook_('B', { 'Call_Legs_2026-09-14': tab, 'Raw Data': fakeTab_('Raw Data') });
  const got = resolve(src, tgt, '2026-09-14');
  assert.equal(got.source, 'Call_Legs_2026-09-14');
  assert.equal(got.dateIso, '2026-09-14');
});

test('Raw Data is the fallback, but only for the date it actually holds', () => {
  const resolve = h.fn('qddResolveLegsSheet_');
  const raw = fakeTab_('Raw Data', { firstStart: '09/14/2026 08:01:00' });
  const src = fakeBook_('A', {});
  const tgt = fakeBook_('B', { 'Raw Data': raw });

  const got = resolve(src, tgt, '2026-09-14');
  assert.equal(got.source, 'Raw Data');
  assert.equal(got.dateIso, '2026-09-14');

  // The wrong date must REFUSE. Silently analysing whichever day happens to be
  // loaded would answer a question nobody asked, with numbers that look real.
  assert.throws(() => resolve(src, tgt, '2026-09-10'), /Raw Data" currently holds 2026-09-14/);
});

test('with no date given, the newest Call_Legs tab wins over Raw Data', () => {
  const resolve = h.fn('qddResolveLegsSheet_');
  const src = fakeBook_('A', {
    'Call_Legs_2026-09-11': fakeTab_('Call_Legs_2026-09-11'),
    'Call_Legs_2026-09-14': fakeTab_('Call_Legs_2026-09-14'),
    'Call_Legs_2026-09-02': fakeTab_('Call_Legs_2026-09-02'),
  });
  const tgt = fakeBook_('B', { 'Raw Data': fakeTab_('Raw Data', { firstStart: '09/15/2026 08:00:00' }) });
  assert.equal(resolve(src, tgt, '').dateIso, '2026-09-14');
});

test('an empty Raw Data and no tabs is an explicit refusal, not a crash', () => {
  const resolve = h.fn('qddResolveLegsSheet_');
  const src = fakeBook_('A', {});
  const tgt = fakeBook_('B', { 'Raw Data': fakeTab_('Raw Data', { lastRow: 1 }) });
  assert.throws(() => resolve(src, tgt, '2026-09-14'), /neither a Call_Legs tab/);
});

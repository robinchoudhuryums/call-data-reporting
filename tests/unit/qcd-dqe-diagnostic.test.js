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
// Same realm problem for arrays: copy into a host array before comparing.
const arr = (a) => Array.from(a || []);

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
  // Col 0 is the CALL id and every leg of one call SHARES it, so it is not a
  // per-leg identity. Modelling that faithfully is load-bearing: a fixture that
  // gave each leg its own col-0 hid a real sibling-matching bug (2026-09-14:
  // legsOnCall read 3..10 while siblings read 0). NB col 1 is `status` to
  // calcQcdReport and `LEG_ID` to the DQE build -- one column, two names -- so
  // the fixtures set it as status and nothing here may overwrite it.
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
  // 4. Call Menu at 6:15 on a NON-family queue -- inside QCD's 6:00 floor
  //    (the block is roster-based: any queue, a csr_team callee), outside
  //    DQE's, because A_Q_Sales keeps INV-06's 6:30 floor. Before R49 this
  //    leg sat on A_Q_CSR and was outside for everyone; the CSR family now
  //    floors at 6:00, so it moved queues to stay the window-difference case.
  raw({ status: '4', type: 'incoming', callerId: 'A_Q_Sales,410', caller: 'CallQueue (410)',
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
  // 16. R49: Call Menu at 6:15 on A_Q_CSR. Inside QCD's 6:00 floor AND, since
  //     the CSR family floors at 6:00, inside DQE's -- both sides count it.
  raw({ status: '4', type: 'incoming',
        start: '09/14/2026 06:15:00', end: '09/14/2026 06:20:00' }),
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
  assert.equal(out.reasons['outside-dqe-window'], 2);   // the 6:15 Sales leg (row 4) and the 3:00 PM boundary
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
  assert.equal(casey.q35, 4);           // rows 1, 4, 14 and 16
  assert.equal(casey.q36, 4);           // rows 2, 6, 9 and 11
  assert.equal(casey.q37, 1);           // row 3
  assert.equal(casey.qTotal, 9);
  assert.equal(casey.dqeAnswered, 6);   // rows 1, 7, 8, 9, 15 and 16 (R49: the early CSR leg)
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
  const o = plain(out.orphanSample[0]);
  assert.equal(o.agent, CSR_AGENT);
  assert.equal(o.parentKey, 'P9');
  assert.equal(o.parentRaw, 'P9');
  assert.equal(o.callId, 'legC');
  assert.equal(o.sheetRow, 2);
  assert.equal(o.qcdRow, 36);
  // The call it names is nowhere in this day's sheet -- a dangling reference,
  // which is a different finding from "the call is here but DQE skipped its
  // other legs". The report must not blur the two.
  assert.equal(o.callIdSeenToday, false);
  assert.equal(o.legsOnThisCall, 1);
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

test('an orphan whose call IS present today is distinguished from a dangling one', () => {
  const grid = [HEADER,
    // The call root exists and has other legs -- DQE just counted none of them
    // (this leg is not flagged Answered), so the call is present but uncredited.
    raw({ status: '1', type: 'incoming', callId: 'P7', parent: 'N/A', answered: false }),
    raw({ status: '2', type: 'incoming', talk: '0:01:00', callId: 'legG', parent: 'P7',
          callerId: '5551234', caller: '5551234' }),
  ];
  const out = h.fn('qddAnalyzeDay_')(grid, ctx_());
  assert.equal(out.parentJoin.none, 1);
  const o = plain(out.orphanSample[0]);
  assert.equal(o.callIdSeenToday, true, 'P7 is a real call id in this grid');
  assert.equal(o.legsOnThisCall, 2, 'the root plus this leg');
});

test('the id range separates the day\'s own calls from carried-over ones', () => {
  const grid = [HEADER,
    raw({ status: '1', type: 'incoming', callId: 'legH', parent: '900' }),
    raw({ status: '2', type: 'incoming', talk: '0:01:00', callId: 'legI', parent: '100',
          callerId: '5551234', caller: '5551234' }),
    raw({ status: '2', type: 'incoming', talk: '0:01:00', callId: 'legJ', parent: '300',
          callerId: '5551234', caller: '5551234' }),
  ];
  const out = h.fn('qddAnalyzeDay_')(grid, ctx_());
  assert.equal(out.idRange.dqeMin, '900');
  assert.equal(out.idRange.dqeMax, '900');
  // Both ends, or a swapped min/max reads as a single-point range and the
  // "far from the day's own ids" judgement silently loses its width.
  assert.equal(out.idRange.orphanMin, '100');
  assert.equal(out.idRange.orphanMax, '300');
});

// ── 6c. Cross-referencing an orphan against Raw Data ───────────────────────

test('an orphan carries the Raw Data identity fields for cross-referencing', () => {
  const grid = [HEADER,
    raw({ status: '2', type: 'incoming', talk: '0:01:30', wait: '0:00:12',
          callId: 'legK', parent: 'P8', callerId: 'Call Menu', caller: '18005551212',
          callerName: 'ACME Supply' }),
  ];
  const out = h.fn('qddAnalyzeDay_')(grid, ctx_());
  const o = plain(out.orphanSample[0]);
  assert.equal(o.caller, '18005551212');
  assert.equal(o.callerName, 'ACME Supply');
  assert.equal(o.callerId, 'Call Menu');
  assert.equal(o.calleeName, CSR_AGENT);
  assert.equal(o.talk, '0:01:30');
  assert.equal(o.wait, '0:00:12');
  assert.equal(o.answeredFlag, 'Answered');
});

test('an orphan lists the OTHER legs of its call, and says so when there are none', () => {
  const grid = [HEADER,
    // Orphan 1: a ROOT leg plus a child of the same call. Production shape --
    // both legs carry the SAME col-0 call id and differ only by leg id, so a
    // sibling match keyed on the call id finds nothing and the call reads as
    // dangling when its ring tree is right there.
    raw({ status: '1', type: 'incoming', callId: 'P10', parent: 'N/A',
          answered: false, callee: 'A_Q_CSR', calleeExt: '304' }),
    raw({ status: '2', type: 'incoming', talk: '0:01:00', callId: 'P10',
          parent: 'P10', callerId: '5551234', caller: '5551234' }),
    // Orphan 2: its parent id appears nowhere else.
    raw({ status: '2', type: 'incoming', talk: '0:01:00', callId: 'legM',
          parent: 'GHOST', callerId: '5551234', caller: '5551234' }),
  ];
  const out = h.fn('qddAnalyzeDay_')(grid, ctx_());
  assert.equal(out.parentJoin.none, 2);
  const byKey = {};
  out.orphanSample.forEach((o) => { byKey[o.parentKey] = o; });

  const withTree = byKey['P10'];
  assert.equal(withTree.siblings.length, 1, 'the root leg is listed');
  assert.equal(withTree.siblings[0].callee, 'A_Q_CSR');
  assert.equal(withTree.siblings[0].sheetRow, 2);
  assert.equal(withTree.siblings[0].answeredFlag, '');
  assert.equal(withTree.legsOnThisCall, 2,
    'and the count agrees with the list -- a count of N with 0 siblings is the bug');

  const dangling = byKey['GHOST'];
  assert.equal(dangling.siblings.length, 0,
    'nothing else sits on this call -- the report must be able to say so');
  assert.equal(dangling.callIdSeenToday, false);
});

test('the orphan leg never lists ITSELF as a sibling', () => {
  // A root leg keys on its own call id, so a naive second pass matches it and
  // reports a dangling call as having one leg -- the opposite conclusion. The
  // exclusion is by ROW, the only always-unique per-leg identity here.
  const grid = [HEADER,
    raw({ status: '2', type: 'incoming', talk: '0:01:00', callId: 'SELF',
          parent: 'N/A', callerId: '5551234', caller: '5551234' }),
  ];
  const out = h.fn('qddAnalyzeDay_')(grid, ctx_());
  assert.equal(out.orphanSample[0].parentKey, 'SELF');
  assert.equal(out.orphanSample[0].siblings.length, 0);
  assert.equal(out.orphanSample[0].legsOnThisCall, 1, 'the count still sees the one leg');
});

test('log-shaping hides a phone number but leaves a queue token readable', () => {
  // The detail tab sits in the workbook that already holds Raw Data, so it
  // carries the real values; the execution log gets copied elsewhere.
  const safe = h.fn('qddLogSafe_');
  assert.equal(safe('18005551212'), '(11-digit number)');
  assert.equal(safe('+1 (800) 555-1212'), '(11-digit number)');
  assert.equal(safe('A_Q_CSR,304'), 'A_Q_CSR,304');
  assert.equal(safe('CallQueue (304)'), 'CallQueue (304)');
  assert.equal(safe('Call Menu'), 'Call Menu');
  assert.equal(safe(''), '');
});

test('each no-DQE-leg call is given a cause, window first', () => {
  const grid = [HEADER,
    // 6:15 AM -- inside QCD's 6:00 floor, outside DQE's 6:30 one. A window
    // difference by design (INV-06), NOT a lost call.
    raw({ status: '4', type: 'incoming', callId: 'E1', parent: 'N/A',
          callerId: '5551234', caller: '5551234',
          start: '09/14/2026 06:15:00', end: '09/14/2026 06:20:00' }),
    // Mid-window, but internal: another extension rang the agent directly, so
    // no queue ever delivered it.
    raw({ status: '1', type: 'internal', talk: '0:00:30', callId: 'E2', parent: 'N/A',
          callerId: 'Megan Kapoor,347', caller: '347' }),
    // Mid-window, external, and still no queue leg.
    raw({ status: '2', type: 'incoming', talk: '0:01:00', callId: 'E3', parent: 'N/A',
          callerId: '5551234', caller: '5551234' }),
  ];
  const out = h.fn('qddAnalyzeDay_')(grid, ctx_());
  assert.equal(out.parentJoin.none, 3);
  assert.deepEqual(plain(out.orphanCauses), {
    'starts-before-dqe-window': 1,
    'internal-direct-to-agent': 1,
    'in-window-non-queue': 1,
  });
  const byKey = {};
  out.orphanSample.forEach((o) => { byKey[o.callId] = o.cause; });
  assert.equal(byKey['E1'], 'starts-before-dqe-window');
  assert.equal(byKey['E2'], 'internal-direct-to-agent');
  assert.equal(byKey['E3'], 'in-window-non-queue');
});

test('an internal leg outside the window is reported as a window difference', () => {
  // Window before direction: an early internal call is out of window for the
  // same reason every early call is, and calling it "internal" would hide that.
  const grid = [HEADER,
    raw({ status: '1', type: 'internal', talk: '0:00:30', callId: 'E4', parent: 'N/A',
          callerId: 'Megan Kapoor,347', caller: '347',
          start: '09/14/2026 06:15:00', end: '09/14/2026 06:20:00' }),
  ];
  const out = h.fn('qddAnalyzeDay_')(grid, ctx_());
  assert.deepEqual(plain(out.orphanCauses), { 'starts-before-dqe-window': 1 });
});

test('a lost queue is reported BY EXTENSION, with who took the calls', () => {
  // The first live run found 138 lost legs and could not say whose queue they
  // were -- the caller-ID it sampled was a phone number. The ext inside
  // "CallQueue (ext)" is the only handle left, and the agent names say whose
  // numbers are short.
  const grid = [HEADER,
    censusRaw_({ status: '4', type: 'incoming', callerId: '18005551212',
                 caller: 'CallQueue (911)', callee: 'Casey Csr',
                 start: '09/14/2026 10:00:00' }),
    censusRaw_({ status: '4', type: 'incoming', callerId: '18005551212',
                 caller: 'CallQueue (911)', callee: 'Una Gurung', missed: true,
                 answered: false, start: '09/14/2026 06:10:00' }),
    censusRaw_({ status: '4', type: 'incoming', callerId: '18005551212',
                 caller: 'CallQueue (912)', callee: 'Casey Csr',
                 start: '09/14/2026 10:05:00' }),
  ];
  const out = h.fn('qddCensusScanGrid_')(grid, CENSUS_CTX);
  const e911 = plain(out.lostByExt['911']);
  assert.equal(e911.legs, 2);
  assert.equal(e911.answered, 1);
  assert.equal(e911.missed, 1);
  assert.deepEqual(plain(e911.buckets), { window: 1, early: 1 },
    'the bucket split says whether a window change would even touch them');
  assert.deepEqual(arr(e911.agents), ['Casey Csr', 'Una Gurung']);
  assert.equal(out.lostByExt['912'].legs, 1, 'two lost queues stay separate');
});

test('an expected non-queue leg contributes no extension', () => {
  // Only the finding shapes name an extension; a person-to-person call has no
  // queue to name, and listing its caller as a "lost queue" would send an
  // operator looking up an extension that is simply someone is desk phone.
  const grid = [HEADER,
    censusRaw_({ status: '4', type: 'internal', callerId: 'Megan Kapoor,347',
                 caller: '347', start: '09/14/2026 10:00:00' }),
  ];
  const out = h.fn('qddCensusScanGrid_')(grid, CENSUS_CTX);
  assert.deepEqual(plain(out.lostByExt), {});
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

// ── 8. The work-window edge census ─────────────────────────────────────────
//
// The census exists to de-risk the CSR-family window change, and its whole
// value is catching a queue whose raw name is on no list. So the pins are
// mostly about what it must NOT quietly drop.

const CENSUS_CTX = {
  canonicalize: (n) => n,
  excludedAgents: ['Rajesh Patel'],
};

function censusRaw_(o) {
  const r = raw(o);
  r[23] = o.missed ? 'Missed' : '';
  if (o.answered === false) r[25] = '';
  return r;
}

test('edge buckets split on the real window boundaries, half-open', () => {
  const b = h.fn('qddCensusBucket_');
  assert.equal(b(6 * 3600 - 1), 'pre-6am');
  assert.equal(b(6 * 3600), 'early');
  assert.equal(b(6 * 3600 + 29 * 60 + 59), 'early');
  assert.equal(b(6 * 3600 + 30 * 60), 'window', '6:30 belongs to the window, not the early edge');
  assert.equal(b(15 * 3600 - 1), 'window');
  assert.equal(b(15 * 3600), 'late', '3:00 PM starts the AJ/AK half hour');
  assert.equal(b(15 * 3600 + 30 * 60 - 1), 'late');
  assert.equal(b(15 * 3600 + 30 * 60), 'after');
  assert.equal(b(null), '');
});

test('the census counts rung / missed / answered per queue per bucket', () => {
  const grid = [HEADER,
    censusRaw_({ status: '4', type: 'incoming', callerId: 'A_Q_CSR,304',
                 start: '09/14/2026 06:10:00', end: '09/14/2026 06:15:00' }),
    censusRaw_({ status: '4', type: 'incoming', callerId: 'A_Q_CSR,304', missed: true,
                 answered: false, start: '09/14/2026 06:20:00', end: '09/14/2026 06:21:00' }),
    censusRaw_({ status: '4', type: 'incoming', callerId: 'A_Q_CSR,304', talk: '0:02:00',
                 start: '09/14/2026 10:00:00', end: '09/14/2026 10:05:00' }),
    censusRaw_({ status: '4', type: 'incoming', callerId: 'A_Q_Spanish,310',
                 start: '09/14/2026 15:10:00', end: '09/14/2026 15:12:00' }),
  ];
  const out = h.fn('qddCensusScanGrid_')(grid, CENSUS_CTX);
  assert.equal(out.byQueue['A_Q_CSR'].early.rung, 2);
  assert.equal(out.byQueue['A_Q_CSR'].early.answered, 1);
  assert.equal(out.byQueue['A_Q_CSR'].early.missed, 1);
  assert.equal(out.byQueue['A_Q_CSR'].window.rung, 1);
  assert.equal(out.byQueue['A_Q_CSR'].window.talkSec, 120);
  assert.equal(out.byQueue['A_Q_Spanish'].late.rung, 1);
  assert.equal(out.byQueue['A_Q_Spanish'].early.rung, 0);
});

test('a leg with no queue name is split by whether it is a FINDING', () => {
  // Measured 2026-09-16: 85% of a day's legs have no queue name simply because
  // they are not queue deliveries. Reporting that as one "unrecognized" number
  // produced an alarming 96,683 and buried the signal. Only a leg that reached
  // an agent THROUGH a queue whose name is unresolvable is a finding.
  const namer = new Array(MAX_COLS).fill('');
  namer[10] = '344'; namer[11] = 'A_Q_FieldOps_Power';
  namer[2] = '09/14/2026 09:00:00'; namer[4] = '09/14/2026 09:01:00';
  const grid = [HEADER, namer,
    // R18e exactly: the queue names itself in CALLER, but ext 999 named no queue.
    censusRaw_({ status: '4', type: 'incoming', callerId: '354',
                 caller: 'CallQueue (999)', start: '09/14/2026 06:10:00' }),
    censusRaw_({ status: '4', type: 'incoming', callerId: '354',
                 caller: 'CallQueue (999)', start: '09/14/2026 06:12:00' }),
    // The variant the build's fallback does not cover: a BARE ext that is a
    // known queue today, so the leg is a queue delivery the build still drops.
    censusRaw_({ status: '4', type: 'incoming', callerId: '354', caller: '344',
                 start: '09/14/2026 06:13:00' }),
    // An ordinary internal call. Expected, and no window change can touch it.
    censusRaw_({ status: '4', type: 'internal', callerId: 'Megan Kapoor,347',
                 caller: '347', start: '09/14/2026 06:14:00' }),
  ];
  const out = h.fn('qddCensusScanGrid_')(grid, CENSUS_CTX);
  assert.equal(out.unrecognized['early|queue-caller-ext-unresolved'].legs, 2);
  assert.equal(out.unrecognized['early|queue-ext-bare-caller'].legs, 1);
  assert.equal(out.unrecognized['early|not-a-queue-leg'].legs, 1);
  assert.deepEqual(arr(out.unrecognized['early|queue-caller-ext-unresolved'].samples), ['354'],
    'duplicate caller-IDs collapse to one sample -- eight copies of one value teaches nothing');
  assert.deepEqual(arr(out.unrecognized['early|not-a-queue-leg'].samples), [],
    'a sample of "not a queue leg" is a random person name -- it earns no slot');
  // The namer row only populates the ext->name map; it carries no queue token
  // itself, so it lands in the window bucket as not-a-queue-leg and NO leg here
  // resolves to a queue.
  assert.equal(Object.keys(plain(out.byQueue)).length, 0);
  assert.equal(out.unrecognized['window|not-a-queue-leg'].legs, 1);
});

test('the R18e fallback still recovers a queue whose col W lost its name', () => {
  const namer = new Array(MAX_COLS).fill('');
  namer[10] = '344'; namer[11] = 'A_Q_FieldOps_Power';
  namer[2] = '09/14/2026 09:00:00'; namer[4] = '09/14/2026 09:01:00';
  const grid = [HEADER, namer,
    censusRaw_({ status: '4', type: 'incoming', callerId: '354', caller: 'CallQueue (344)',
                 start: '09/14/2026 06:10:00', end: '09/14/2026 06:15:00' }),
  ];
  const out = h.fn('qddCensusScanGrid_')(grid, CENSUS_CTX);
  assert.equal(out.byQueue['A_Q_FieldOps_Power'].early.rung, 1);
  assert.equal(out.unrecognized['early|queue-caller-ext-unresolved'], undefined);
});

test('gate drops are tallied separately, not folded into a queue', () => {
  const grid = [HEADER,
    censusRaw_({ status: '4', type: 'incoming', callerId: 'A_Q_CSR,304',
                 callee: 'Rajesh Patel', start: '09/14/2026 06:10:00' }),
    censusRaw_({ status: '4', type: 'incoming', callerId: 'A_Q_CSR,304',
                 calleeExt: 'CallForking9', start: '09/14/2026 06:11:00' }),
    censusRaw_({ status: '4', type: 'incoming', callerId: 'A_Q_CSR,304',
                 callee: 'N/A', start: '09/14/2026 06:12:00' }),
    censusRaw_({ status: '4', type: 'incoming', callerId: 'A_Q_CSR,304', start: 'n/a' }),
  ];
  const out = h.fn('qddCensusScanGrid_')(grid, CENSUS_CTX);
  assert.equal(out.droppedExcluded, 1);
  assert.equal(out.droppedForking, 1);
  assert.equal(out.droppedAgent, 1);
  assert.equal(out.unparsedStart, 1);
  assert.equal(plain(out.byQueue)['A_Q_CSR'], undefined, 'none of them reached a queue cell');
});

test('the answer rate is answered/(answered+missed), and null when nothing rang', () => {
  const rate = h.fn('qddCensusRate_');
  assert.equal(rate([{ answered: 9, missed: 1 }]), 90);
  assert.equal(rate([{ answered: 9, missed: 1 }, { answered: 1, missed: 9 }]), 50);
  assert.equal(rate([{ answered: 0, missed: 0 }]), null,
    'an empty bucket must read as "no calls", never as 0%');
});

test('merging days sums the cells and keeps sample variety', () => {
  const merge = h.fn('qddCensusMerge_');
  const day = (q, rung, sample) => ({
    rows: 1, droppedAgent: 0, droppedExcluded: 0, droppedForking: 0, unparsedStart: 0,
    byQueue: { [q]: { 'pre-6am': {rung:0,missed:0,answered:0,talkSec:0},
                      early: {rung: rung, missed: 0, answered: rung, talkSec: 5},
                      window: {rung:0,missed:0,answered:0,talkSec:0},
                      late: {rung:0,missed:0,answered:0,talkSec:0},
                      after: {rung:0,missed:0,answered:0,talkSec:0} } },
    unrecognized: { 'early|queue-caller-ext-unresolved':
      { legs: 1, samples: [sample], bucket: 'early', shape: 'queue-caller-ext-unresolved' } },
    lostByExt: { '344': { legs: 2, answered: 1, missed: 1, agents: [q], buckets: { early: 2 } } },
  });
  const acc = { rows: 0, byQueue: {}, unrecognized: {}, lostByExt: {}, droppedAgent: 0,
                droppedExcluded: 0, droppedForking: 0, unparsedStart: 0 };
  merge(acc, day('A_Q_CSR', 2, '354'));
  merge(acc, day('A_Q_CSR', 3, '377'));
  // A third day repeating a shape already seen must not re-add it -- the sample
  // slots are few, and eight copies of one value crowds out the one that differs.
  merge(acc, day('A_Q_CSR', 1, '354'));
  assert.equal(acc.byQueue['A_Q_CSR'].early.rung, 6);
  assert.equal(acc.byQueue['A_Q_CSR'].early.talkSec, 15);
  assert.equal(acc.unrecognized['early|queue-caller-ext-unresolved'].legs, 3);
  assert.deepEqual(arr(acc.unrecognized['early|queue-caller-ext-unresolved'].samples), ['354', '377'],
    'a second day must be able to contribute a NEW caller-ID shape');
  assert.equal(acc.rows, 3);
  // The per-extension roll-up must survive the fold too -- it is what names the
  // queue, and a day-boundary is exactly where a naive merge would drop it.
  assert.equal(acc.lostByExt['344'].legs, 6);
  assert.equal(acc.lostByExt['344'].answered, 3);
  assert.equal(acc.lostByExt['344'].missed, 3, 'missed folds too -- a lost queue that only '
    + 'MISSES is still a dept short of calls, and a merge that drops it hides that');
  assert.deepEqual(plain(acc.lostByExt['344'].buckets), { early: 6 });
});

test('talk parses H:MM:SS and refuses anything else rather than guessing', () => {
  const sec = h.fn('qddHmsToSec_');
  assert.equal(sec('0:02:00'), 120);
  assert.equal(sec('1:00:01'), 3601);
  assert.equal(sec('12:07:00'), 43620);
  assert.equal(sec(''), 0);
  assert.equal(sec('120'), 0, 'a bare number is not a duration here');
  assert.equal(sec(null), 0);
});

// ── 8b. A lost queue name is only a LOSS if the leg would have counted ──────
//
// The first live run reported 146 lost legs on one extension and blocked the
// window change on them. Every one went to a pseudo-agent on
// DQE_EXCLUDED_AGENTS -- the build drops those at the NEXT gate regardless, so
// the lost queue name cost nobody any credit. The census now says so itself;
// treating "lost" as "lost credit" is what made it mislead.

test('a lost leg whose callee is EXCLUDED would not have counted', () => {
  const grid = [HEADER,
    censusRaw_({ status: '4', type: 'incoming', callerId: '18005551212',
                 caller: 'CallQueue (782)', callee: 'Rajesh Patel',
                 start: '09/14/2026 10:00:00' }),
  ];
  const out = h.fn('qddCensusScanGrid_')(grid, CENSUS_CTX);
  assert.equal(out.lostByExt['782'].legs, 1, 'still reported -- the name IS lost');
  assert.equal(out.lostByExt['782'].counted, 0, 'but it would never have counted');
  assert.equal(out.lostCounted, 0, 'so it does not block a window change');
});

test('a lost leg whose callee is a REAL agent is a genuine loss', () => {
  const grid = [HEADER,
    censusRaw_({ status: '4', type: 'incoming', callerId: '18005551212',
                 caller: 'CallQueue (782)', callee: 'Casey Csr',
                 start: '09/14/2026 10:00:00' }),
  ];
  const out = h.fn('qddCensusScanGrid_')(grid, CENSUS_CTX);
  assert.equal(out.lostByExt['782'].counted, 1);
  assert.equal(out.lostCounted, 1, 'this one DOES block');
});

test('a lost CallForking leg would not have counted either', () => {
  const grid = [HEADER,
    // NB CallForking is matched on CALLEE (the ext column), not CALLEE_NAME --
    // `calleeExt` here, and getting that wrong is how this pin first passed
    // against the wrong column.
    censusRaw_({ status: '4', type: 'incoming', callerId: '18005551212',
                 caller: 'CallQueue (782)', calleeExt: 'CallForking-9',
                 callee: 'Casey Csr', start: '09/14/2026 10:00:00' }),
  ];
  const out = h.fn('qddCensusScanGrid_')(grid, CENSUS_CTX);
  assert.equal(out.lostCounted, 0);
});

test('counted and legs are BOTH folded across days', () => {
  const merge = h.fn('qddCensusMerge_');
  const acc = { rows: 0, byQueue: {}, unrecognized: {}, lostByExt: {}, lostCounted: 0,
                droppedAgent: 0, droppedExcluded: 0, droppedForking: 0, unparsedStart: 0 };
  const one = {
    rows: 1, byQueue: {}, unrecognized: {}, droppedAgent: 0, droppedExcluded: 0,
    droppedForking: 0, unparsedStart: 0, lostCounted: 1,
    lostByExt: { '782': { legs: 3, counted: 1, answered: 2, missed: 1,
                          agents: ['Casey Csr'], buckets: { early: 3 } } },
  };
  merge(acc, one);
  merge(acc, one);
  assert.equal(acc.lostByExt['782'].legs, 6);
  assert.equal(acc.lostByExt['782'].counted, 2, 'the blocking half folds too');
  assert.equal(acc.lostCounted, 2);
});

// ── 9. R49: the mirror floors per QUEUE, like the build it certifies ────────
//
// This mirror shipped with a flat 6:30 the day R49 moved the CSR family to
// 6:00, and its first live run afterwards read INCONCLUSIVE against the stored
// rows it exists to check -- five agents exactly +2, the ten early calls it
// was flooring out (2026-09-17). The fifth hand-mirror of the build, drifting
// the way the other four have. Section 2's SOURCE pins could not see it: they
// pin copied text, and a rule the build GAINED has no copy to compare. So the
// last test here drives the REAL build and the mirror over one grid.

test('R49: an early leg on a CSR-family queue is IN the mirror\'s window and reads sameAgent', () => {
  const grid = [HEADER,
    // 6:10 on A_Q_CSR: the CSR block claims it (status 4, csr_team callee) AND,
    // since R49, so does DQE -- one leg, both sides, no orphan.
    raw({ status: '4', type: 'incoming', callId: 'E5', parent: 'N/A',
          start: '09/14/2026 06:10:00', end: '09/14/2026 06:14:00' }),
  ];
  const out = h.fn('qddAnalyzeDay_')(grid, ctx_());
  assert.equal(out.dqeAnsweredAllAgents, 1, 'the mirror counts the early CSR-family leg');
  assert.equal(out.byAgent[CSR_AGENT].dqeAnswered, 1);
  assert.equal(out.qcdAlsoDqe, 1, 'and it is the SAME leg the CSR block counted');
  assert.equal(out.parentJoin.none, 0, 'so nothing reads as under-credited');
  assert.equal(out.reasons['outside-dqe-window'] || 0, 0);
});

test('R49: the same early leg on a NON-family queue stays outside, and the cause says why', () => {
  const grid = [HEADER,
    // 6:10 on A_Q_Sales, taken by a CSR: the block still claims it (roster-
    // based), but Sales keeps INV-06's 6:30 floor, so DQE does not.
    raw({ status: '4', type: 'incoming', callId: 'E6', parent: 'N/A',
          callerId: 'A_Q_Sales,410', caller: 'CallQueue (410)',
          start: '09/14/2026 06:10:00', end: '09/14/2026 06:14:00' }),
  ];
  const out = h.fn('qddAnalyzeDay_')(grid, ctx_());
  assert.equal(out.dqeAnsweredAllAgents, 0, 'a non-family queue keeps the 6:30 floor');
  assert.equal(out.reasons['outside-dqe-window'], 1);
  assert.equal(out.parentJoin.none, 1);
  assert.deepEqual(plain(out.orphanCauses), { 'starts-before-dqe-window': 1 },
    'and the orphan cause floors per queue too -- a window difference, not a lost call');
});

test('R49 PARITY: the mirror\'s per-agent answered equals what the REAL build stores', () => {
  // The pin that would have caught the live INCONCLUSIVE: one grid, the real
  // buildDQEHistoricalData on one side, qddAnalyzeDay_ on the other. If the
  // build gains a per-agent rule the mirror lacks, these two numbers part.
  const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
  const { rosterGrid } = require('../harness/fixtures');
  h.ctx.writeDQERowsToNeon = function () { return { skipped: 0 }; };
  h.ctx.notifyNeonWriteFailure = function () {};

  const grid = [HEADER,
    raw({ status: '4', type: 'incoming', callId: 'P1', parent: 'N/A' }),                 // in window
    raw({ status: '4', type: 'incoming', callId: 'P2', parent: 'N/A',                    // early, CSR family -> counted
          start: '09/14/2026 06:10:00', end: '09/14/2026 06:14:00' }),
    raw({ status: '4', type: 'incoming', callId: 'P3', parent: 'N/A',                    // early, Sales -> not counted
          callerId: 'A_Q_Sales,410', caller: 'CallQueue (410)',
          start: '09/14/2026 06:12:00', end: '09/14/2026 06:16:00' }),
    raw({ status: '4', type: 'incoming', callId: 'P4', parent: 'N/A',                    // before 6:00 -> nobody
          start: '09/14/2026 05:50:00', end: '09/14/2026 05:55:00' }),
  ];
  const ss = makeFakeSpreadsheet({ sheets: {
    'Raw Data': grid,
    'DQE Historical Data': [new Array(34).fill('')],
    'DO NOT EDIT!': rosterGrid({ CSR: [CSR_AGENT + ', 201'] }),
  } });
  h.state.spreadsheet = ss;
  h.fn('buildDQEHistoricalData')(ss._sheet('Raw Data'), ss._sheet('DQE Historical Data'));
  const stored = ss._sheet('DQE Historical Data')._data.slice(1)
    .filter((r) => r[2] === CSR_AGENT)[0];
  assert.ok(stored, 'the real build wrote a row for ' + CSR_AGENT);

  const out = h.fn('qddAnalyzeDay_')(grid, ctx_());
  assert.equal(out.byAgent[CSR_AGENT].dqeAnswered, stored[7],
    'mirror answered != stored col H -- the mirror has drifted from the build '
    + '(this is the shape of the 2026-09-17 INCONCLUSIVE: mirror ' + out.byAgent[CSR_AGENT].dqeAnswered
    + ' vs stored ' + stored[7] + ')');
  assert.equal(stored[7], 2, 'fixture guard: exactly the in-window + early-CSR legs count');
});

test('R49: an early CSR-family leg DQE skipped for ANOTHER reason is not called a window difference', () => {
  // 6:10 on A_Q_CSR, talked, but the feed never flagged it Answered: the CSR
  // block (row 36) counts it, DQE does not -- and the reason is the flag, not
  // the clock. A cause that floors at a flat 6:30 files this under
  // 'starts-before-dqe-window', the "deliberate design decision" pile, and a
  // genuinely unexplained miss disappears into it. Since R49 the CSR family's
  // floor is 6:00, so 6:10 is IN window and the cause must say so.
  const grid = [HEADER,
    raw({ status: '2', type: 'incoming', talk: '0:01:00', answered: false,
          callId: 'E7', parent: 'N/A',
          start: '09/14/2026 06:10:00', end: '09/14/2026 06:14:00' }),
  ];
  const out = h.fn('qddAnalyzeDay_')(grid, ctx_());
  assert.equal(out.qcdD[36], 1, 'fixture guard: the CSR block claims it');
  assert.equal(out.reasons['not-flagged-answered'], 1, 'fixture guard: DQE skips it for the FLAG');
  assert.equal(out.parentJoin.none, 1);
  assert.equal(out.orphanCauses['starts-before-dqe-window'] || 0, 0,
    'the cause must floor per queue: at 6:10 a CSR-family leg is inside DQE\'s window');
  assert.equal(out.orphanCauses['in-window-non-queue'], 1,
    'it lands in the in-window bucket (the vocabulary\'s fallback for a non-window miss)');
});

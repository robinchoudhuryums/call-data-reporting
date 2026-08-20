'use strict';

// C1 (broad-scan F7/F1): BEHAVIORAL parity between the two hand-mirrored QCD
// rule sets -- cdr-import/autoImport.js::calcQcdReport (the pipeline: writes
// the QCDR Output grid) and cdr-report/dataFilters.js::getExtractionDataJSON
// (the Extraction Sidebar: "which raw CDR rows produced this cell?").
//
// The R20 row-40 drift proved these can silently diverge: the threshold change
// landed in the pipeline only, and the sidebar listed rows the pipeline no
// longer counts -- misleading exactly the reconciliation workflow it exists to
// serve. check-duplicated-files.sh now guards the two shared time-decode
// helpers, and cross-file-pins pins the row-40 threshold TOKENS -- but the ~50
// row RULES are structurally different code in the two files and cannot be
// diffed. This suite is the guard that generalizes: ONE shared synthetic Raw
// Data fixture drives BOTH implementations end to end, and for every drillable
// count cell the sidebar's extracted-row COUNT must equal the pipeline's cell
// VALUE. No expected numbers are hardcoded, so a rule edit in either file that
// isn't mirrored in the other fails here regardless of which rule it was.
//
// SCOPE, stated honestly:
//   - Rows asserted are the ones the pipeline writes DIRECTLY: 3 (primary),
//     4/43 (DNIS), 5 (stat3-non-DNIS), 6 (child 20s), 13 (stat3), 35/36/37
//     (global exception), 39/40 (the R20 pair, incl. the row-39 netting), over
//     count cols C/D/E. Col G (avg wait) is a MEAN, not a count, and col F
//     (max) is not drillable -- neither can equal a row count.
//   - Row 34 is EXCLUDED: the pipeline's r34_abnd1m/2m counters are written
//     NOWHERE (totalRowMap overwrites row 34 as the SUM of rows 35-37) while
//     the sidebar has its own row-34 predicate, so parity does not hold there
//     by construction. RULED 2026-08-20 (owner): row 34 IS the total row —
//     sum semantics. Follow-on code fix (sidebar refuses 34 as a total row +
//     dead counters deleted) is recorded in docs/known-issues.md "QCDR Output
//     row 34"; once it lands, this exclusion becomes "34 is a total row like
//     2/7/10" rather than a discrepancy.
//   - Most fixture rows sit mid-window (10:00 AM). The Batch-E round fixed
//     the one confirmed window-EDGE divergence (row 35's dp2/dp3 lacked the
//     pipeline's start<3PM clause) and Family E's 3:10 PM row now pins it;
//     rows 36/37 were verified clause-for-clause against the pipeline at the
//     same time. Other edge shapes remain unexercised -- extend Family E
//     before assuming one.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// Two SEPARATE harnesses so each implementation runs its OWN copy of
// simulateSplitCol2 / parseDurationDecimal, exactly as in production.
const hPipe = loadGas({ project: 'cdr-import', files: ['autoImport.js'] });
const hSide = loadGas({ project: 'cdr-report', files: ['dataFilters.js'] });

// ── The shared fixture ──────────────────────────────────────────────────────

// Raw Data display-row indices both implementations read:
// 1=status 2=start 4=end 5=type 6=talk(colG) 7=wait 9=team 11=queue
// 16=dnis 24=abandoned 26=transfer
function raw(o) {
  const r = new Array(28).fill('');
  r[1] = o.status; r[2] = o.start || '12/30/2024 10:00:00 AM';
  r[4] = o.end || '12/30/2024 10:05:00 AM';
  r[5] = o.type || ''; r[6] = o.talk || '';
  r[7] = o.wait || '0:00:00'; r[9] = o.team || 'ned other';
  r[11] = o.queue; r[16] = o.dnis || '5551234';
  r[24] = o.abandoned ? 'abandoned' : ''; r[26] = o.transfer ? 'transfer' : '';
  return r;
}
const W2M = '0:02:00';    // > 1 min
const W30 = '0:00:30';    // > 20 s, <= 1 min (the R20 boundary class)
const CSR = 'casey csr';  // on the csr_team named range below

const HEADER = new Array(28).fill('h');
const ROWS = [
  // Family A -- queue a_q_alpha (rows 3/6 primary/child, 13 stat3, 4/5, 43).
  raw({ queue: 'a_q_alpha', status: '1', type: 'internal', team: CSR, transfer: true }),
  raw({ queue: 'a_q_alpha', status: '1', type: 'internal', team: CSR, abandoned: true, wait: W2M }),
  raw({ queue: 'a_q_alpha', status: '1', type: 'internal', team: CSR, abandoned: true, wait: W30 }),
  raw({ queue: 'a_q_alpha', status: '1', type: 'internal', transfer: true }),
  raw({ queue: 'a_q_alpha', status: '1', type: 'internal', abandoned: true, wait: W30 }),
  raw({ queue: 'a_q_alpha', status: '1', type: 'internal', abandoned: true, wait: W2M }),
  raw({ queue: 'a_q_alpha', status: '3', type: 'incoming', transfer: true }),
  raw({ queue: 'a_q_alpha', status: '3', type: 'incoming', abandoned: true, wait: W2M }),
  raw({ queue: 'a_q_alpha', status: '3', type: 'incoming', dnis: '18883645897' }),
  raw({ queue: 'a_q_alpha', status: '3', type: 'incoming', dnis: '18883645897', abandoned: true, wait: W30 }),
  raw({ queue: 'a_q_alpha', status: '6', type: 'incoming', dnis: '18667759594' }),
  raw({ queue: 'a_q_alpha', status: '6', type: 'incoming', dnis: '18667759594', abandoned: true, wait: W30 }),
  // Family B -- a_q_csr (isAQ), feeding the global rows 35/36/37.
  raw({ queue: 'a_q_csr', status: '1', type: 'internal', abandoned: true, wait: W2M }),
  raw({ queue: 'a_q_csr', status: '3', type: 'incoming', abandoned: true, wait: W2M }),
  raw({ queue: 'a_q_csr', status: '2', type: 'incoming', abandoned: true, wait: W2M }),
  // Family S -- a_q_spanish (rows 39/40, the R20 pair + the row-39 netting).
  raw({ queue: 'a_q_spanish', status: '1', type: 'internal', transfer: true }),
  raw({ queue: 'a_q_spanish', status: '1', type: 'internal', abandoned: true, wait: W2M }),
  // The R20 drift row: 30s abandon. The OLD >0s rule counted it in row 40's
  // totals; the R20 rule does not. If EITHER file reverts alone, the row-40
  // parity below breaks -- this is the behavioral form of the F1 bug.
  raw({ queue: 'a_q_spanish', status: '1', type: 'internal', abandoned: true, wait: W30 }),
  raw({ queue: 'a_q_spanish', status: '2', type: 'incoming', transfer: true }),
  raw({ queue: 'a_q_spanish', status: '2', type: 'incoming', abandoned: true, wait: W2M }),
  // CSR-team row on the row-39/40 queue: counted by row 39 AND row 40's gross
  // counters; the pipeline nets row 39 out of row 40 and the sidebar excludes
  // isRow39Match rows -- parity holds only if BOTH do their half.
  raw({ queue: 'a_q_spanish', status: '1', type: 'internal', team: CSR, transfer: true }),
  // Family E -- a queue whose NAME is on the csr_team range (isCsrQ), feeding
  // row 35's p2/dp2. The second row is the WINDOW-EDGE case: it STARTS after
  // 3PM, so the pipeline counts it in neither 35C nor 35D -- but before the
  // Batch-E dp2 fix the sidebar extracted it for 35D (dp2 lacked start<3PM).
  raw({ queue: 'a_q_weird', status: '4', type: 'incoming' }),
  raw({ queue: 'a_q_weird', status: '4', type: 'incoming',
        start: '12/30/2024 3:10:00 PM', end: '12/30/2024 3:20:00 PM' }),
];
const CLEAN_DATA = [HEADER].concat(ROWS);

// QCDR Output col-A labels (1-indexed by row). Row 39 and row 40 share the
// queue on purpose -- that is the production layout the netting exists for.
const LABELS = {};
LABELS[3] = 'A_Q_Alpha'; LABELS[13] = 'A_Q_Alpha'; LABELS[43] = 'A_Q_Alpha';
LABELS[39] = 'A_Q_Spanish'; LABELS[40] = 'A_Q_Spanish';

// ── Drive the PIPELINE ──────────────────────────────────────────────────────

function labelGridA2B49_() {
  const grid = [];
  for (let r = 2; r <= 49; r++) grid.push([LABELS[r] || '', '']);
  return grid;
}

function pipelineTargetSS_() {
  return {
    getSheetByName: function (name) {
      if (name === 'QCDR Output') {
        return { getRange: function (a1) {
          assert.equal(a1, 'A2:B49', 'calcQcdReport reads labels via A2:B49 -- update this fake');
          return { getValues: function () { return labelGridA2B49_(); } };
        } };
      }
      return null;   // Steering Number absent -> empty steering set (both sides)
    },
    getRangeByName: function (name) {
      if (name === 'csr_team') return { getValues: function () { return [['Casey Csr, 201'], ['A_Q_Weird, 999']]; } };
      return null;   // csr_exceptions absent -> empty set (both sides)
    },
  };
}

const pipeOut = hPipe.fn('calcQcdReport')(CLEAN_DATA, pipelineTargetSS_());
// pipeOut.output[r-2][c-3] is the value written to QCDR Output cell (r, c).
function cellValue_(r, c) { return Number(pipeOut.output[r - 2][c - 3]) || 0; }

// ── Drive the SIDEBAR against the pipeline's own output grid ────────────────

// The sidebar reads the LIVE QCDR Output sheet: labels in col A, the
// pipeline's numbers in C..G (that is the production relationship -- the
// sheet holds what calcQcdReport wrote). One fake grid serves both.
function sidebarCellJSON_(row, col) {
  const gridValue = function (r, c) {
    if (c === 1) return LABELS[r] || '';
    if (c === 2) return '';
    if (c >= 3 && c <= 7) return pipeOut.output[r - 2][c - 3];
    return '';
  };
  const activeSheet = {
    getName: function () { return 'QCDR Output'; },
    getActiveCell: function () {
      return { getRow: function () { return row; },
               getColumn: function () { return col; },
               getValue: function () { return gridValue(row, col); } };
    },
    getRange: function (r, c, nr, nc) {
      return {
        getValue: function () { return gridValue(r, c); },
        getValues: function () {
          const out = [];
          for (let i = 0; i < (nr || 1); i++) {
            const line = [];
            for (let j = 0; j < (nc || 1); j++) line.push(gridValue(r + i, c + j));
            out.push(line);
          }
          return out;
        },
      };
    },
  };
  hSide.state.spreadsheet = {
    getActiveSheet: function () { return activeSheet; },
    getSheetByName: function (name) {
      if (name === 'Raw Data') {
        return { getDataRange: function () {
          return { getDisplayValues: function () {
            return CLEAN_DATA.map(function (r) { return r.slice(); });
          } };
        } };
      }
      return null;
    },
    getRangeByName: function (name) {
      if (name === 'csr_team') return { getValues: function () { return [['Casey Csr, 201'], ['A_Q_Weird, 999']]; } };
      return null;
    },
  };
  return JSON.parse(hSide.call('getExtractionDataJSON'));
}

// ── The parity property ─────────────────────────────────────────────────────

// Every directly-written, drillable count cell. See the scope note up top for
// why row 34 and cols F/G are absent.
const PARITY_ROWS = [3, 4, 5, 6, 13, 35, 36, 37, 39, 40, 43];
const COUNT_COLS = [3, 4, 5];

test('C1: the fixture actually exercises the rules (sanity, not parity)', function () {
  // If a refactor of either file made everything zero, 33 vacuous 0===0
  // parities would still "pass" -- require real signal in every family.
  assert.ok(cellValue_(3, 3) > 0, 'primary-row family is dark');
  assert.ok(cellValue_(6, 3) > 0, 'child-row family is dark');
  assert.ok(cellValue_(13, 3) > 0, 'stat3 family is dark');
  assert.ok(cellValue_(4, 3) > 0 && cellValue_(43, 3) > 0, 'DNIS families are dark');
  assert.ok(cellValue_(35, 3) > 0 && cellValue_(36, 3) > 0 && cellValue_(37, 3) > 0,
    'global-exception families are dark');
  assert.ok(cellValue_(35, 4) > 0,
    'row 35 col D (the window-edge dp2 family) is dark -- the edge fixture rows are inert');
  assert.ok(cellValue_(39, 3) > 0, 'row-39 netting side is dark');
  assert.ok(cellValue_(40, 3) > 0, 'row-40 family is dark');
});

test('C1: every drillable count cell -- sidebar row count === pipeline cell value', function () {
  const mismatches = [];
  PARITY_ROWS.forEach(function (r) {
    COUNT_COLS.forEach(function (c) {
      const want = cellValue_(r, c);
      const res = sidebarCellJSON_(r, c);
      if (want === 0) {
        // A zero cell must REFUSE with the zero message -- extracting rows for
        // a zero cell is itself a parity failure (the F1 shape exactly).
        if (!(res.error && /value of 0/.test(res.error))) {
          mismatches.push('(' + r + ',' + c + '): pipeline wrote 0 but the sidebar '
            + (res.rows ? 'extracted ' + res.rows.length + ' row(s)' : 'said: ' + res.error));
        }
        return;
      }
      const got = res.rows ? res.rows.length : ('ERROR: ' + res.error);
      if (got !== want) {
        mismatches.push('(' + r + ',' + c + '): pipeline wrote ' + want
          + ' but the sidebar extracted ' + got);
      }
    });
  });
  assert.deepEqual(mismatches, [],
    'The Extraction Sidebar and the pipeline disagree on which raw rows produced '
    + 'these QCDR Output cells. A rule changed in ONE of dataFilters.js / '
    + 'autoImport.js without its mirror (the F1/R20 drift class) -- diff the two '
    + 'files\' predicates for the failing (row, col) before touching this test.');
});

test('C1: the R20 row-40 boundary row is counted by NEITHER side', function () {
  // The 30s Spanish abandon: under the pre-R20 >0s rule it inflated row 40's
  // C/E. Assert the exact production numbers once, so this suite also fails
  // if BOTH files regress together (parity alone would stay green).
  assert.equal(cellValue_(40, 3), 4, 'row 40 Total: t1+t2+t3+t4 minus the row-39 net');
  assert.equal(cellValue_(40, 5), 2, 'row 40 Abandoned: the 30s row is NOT in it (R20)');
  const res = sidebarCellJSON_(40, 5);
  assert.equal(res.rows.length, 2);
  res.rows.forEach(function (r) {
    assert.notEqual(r[7], '0:00:30',
      'the 30s abandon must not be listed -- that is the original F1 bug verbatim');
  });
});

test('C1: the row-39 netting -- a CSR-team row moves between rows, never doubles', function () {
  // The CSR transfer on the shared Spanish queue appears in row 39 (primary)
  // and is netted OUT of row 40 by the pipeline / excluded by the sidebar.
  assert.equal(cellValue_(39, 4), 1, 'row 39 owns the CSR transfer');
  const r39 = sidebarCellJSON_(39, 4);
  assert.equal(r39.rows.length, 1);
  assert.equal(String(r39.rows[0][9]).toLowerCase(), 'casey csr');
  const r40 = sidebarCellJSON_(40, 4);
  r40.rows.forEach(function (r) {
    assert.notEqual(String(r[9]).toLowerCase(), 'casey csr',
      'a row-39-owned row leaked into row 40\'s extraction (double count)');
  });
});

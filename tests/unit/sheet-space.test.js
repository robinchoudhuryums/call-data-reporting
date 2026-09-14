'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// R47: workbook cell-space tooling (cdr-report/sheetSpace.js). Google counts
// the ALLOCATED grid against the 10M cap, not the cells holding data, and the
// workbook hit 9,983,599/10,000,000 with no prior signal -- the daily Direct
// write failed outright. Pinned here (the two PURE helpers; the deleteRows /
// deleteColumns call itself is a thin wrapper the fake sheet does not model):
//   (1) the planner REFUSES rather than truncating a named range, and refuses
//       on data too -- a silent truncation changes what every reader sees;
//   (2) the vetted per-tab bounds clear each tab's WIDEST WRITER reach, which
//       is NOT derivable from the grid (QCDR Output uses 49 rows but its
//       writer clears 101) -- the trap that would turn a space outage into a
//       daily-import outage;
//   (3) the Health verdict's 80% threshold, its percentage, and the
//       most-reclaimable callout that names the lever.

const h = loadGas({ project: 'cdr-report', files: ['sheetSpace.js'] });

function entry(over) {
  return Object.assign({
    name: 'T', maxRows: 1000, maxCols: 26, lastRow: 10, lastCol: 5,
    namedMaxRow: 0, namedMaxCol: 0, namedBy: '',
  }, over || {});
}

test('R47: the planner frees the empty grid and reports the exact cell delta', function () {
  // The real QCDR Output shape: a 49x24 report inside a 12,607x291 grid.
  const p = h.call('sheetSpacePlanOne_',
    entry({ name: 'QCDR Output', maxRows: 12607, maxCols: 291, lastRow: 49, lastCol: 24 }), 200, 30);
  assert.equal(p.refused, false);
  assert.equal(p.before, 12607 * 291);
  assert.equal(p.after, 200 * 30);
  assert.equal(p.frees, 12607 * 291 - 6000);
  assert.equal(p.needRows, 49);
  assert.equal(p.needCols, 24);
});

test('R47: a NAMED RANGE past the bounds REFUSES -- truncating one is silent', function () {
  // The real `DO NOT EDIT!` shape: 47 used rows, roster named ranges to 1000.
  const e = entry({ name: 'DO NOT EDIT!', maxRows: 1000, maxCols: 34, lastRow: 47, lastCol: 33,
                    namedMaxRow: 1000, namedMaxCol: 19, namedBy: 'csr_team' });
  const p = h.call('sheetSpacePlanOne_', e, 200, 30);
  assert.equal(p.refused, true);
  assert.match(p.reason, /named range csr_team reaches 1000x33/);
  assert.equal(p.frees, 0, 'a refused plan frees nothing');
  // Bounds that clear the named range are allowed through.
  assert.equal(h.call('sheetSpacePlanOne_', e, 1000, 34).refused, false);
});

test('R47: DATA past the bounds refuses too, and the reason says which', function () {
  const p = h.call('sheetSpacePlanOne_', entry({ lastRow: 500, lastCol: 5 }), 200, 30);
  assert.equal(p.refused, true);
  assert.match(p.reason, /^existing data reaches 500x5/);
  const c = h.call('sheetSpacePlanOne_', entry({ lastRow: 10, lastCol: 40, maxCols: 60 }), 200, 30);
  assert.equal(c.refused, true);
  assert.match(c.reason, /existing data reaches 10x40/);
  // Degenerate bounds are refused, never applied.
  assert.equal(h.call('sheetSpacePlanOne_', entry(), 0, 30).refused, true);
});

test('R47: the vetted bounds clear each tab WRITER reach, not just its used range', function () {
  const t = h.ctx.SHEET_SPACE_TARGETS_;
  // QCDR Output: updateQcdrOutputSheet clears getRange(2, 10, max(agents+20,
  // 100), 15) -> row 101, col 24, however few agents exist. Trimming to the
  // 49 used rows would break the daily import, so the bound must clear 101.
  assert.ok(t['QCDR Output'].rows >= 101, 'QCDR rows must clear the 101-row clear block');
  assert.ok(t['QCDR Output'].cols >= 24, 'QCDR cols must clear N:X (col 24)');
  // Daily Queue Report: PDF export ranges B4:I70 and A83:O105 -> row 105, col 15.
  assert.ok(t['Daily Queue Report'].rows >= 105, 'DQR rows must clear the A83:O105 export');
  assert.ok(t['Daily Queue Report'].cols >= 15, 'DQR cols must clear col O');
});

test('R47: the Health verdict totals the ALLOCATED grid, warns at 80%, names the lever', function () {
  const cap = 10000000;
  const near = h.call('sheetSpaceVerdict_', [
    { name: 'QCDR Output', maxRows: 12607, maxCols: 291, lastRow: 49, lastCol: 24 },
    { name: 'DQE Historical Data', maxRows: 32696, maxCols: 40, lastRow: 32135, lastCol: 37 },
  ], cap, 80);
  assert.equal(near.total, 12607 * 291 + 32696 * 40);
  assert.equal(near.worst.name, 'QCDR Output', 'the biggest EMPTY grid is the lever, not the biggest tab');
  assert.match(near.value, /most reclaimable: QCDR Output/);

  // Threshold: 80% exactly warns, just under is ok. One tab, tidy arithmetic.
  const at80 = h.call('sheetSpaceVerdict_', [{ name: 'A', maxRows: 8000000, maxCols: 1, lastRow: 1, lastCol: 1 }], cap, 80);
  assert.equal(at80.pct, 80);
  assert.equal(at80.status, 'warn');
  const under = h.call('sheetSpaceVerdict_', [{ name: 'A', maxRows: 7000000, maxCols: 1, lastRow: 1, lastCol: 1 }], cap, 80);
  assert.equal(under.status, 'ok');
  assert.equal(under.pct, 70);
  // The observed pre-incident reading classifies as warn.
  assert.equal(h.call('sheetSpaceVerdict_',
    [{ name: 'A', maxRows: 9983599, maxCols: 1, lastRow: 1, lastCol: 1 }], cap, 80).status, 'warn');
});

test('R47: the dashboard Health row and this engine share one cap and threshold', function () {
  // Two projects, no shared module. A drift would have the operator warned at
  // one number in the menu tool and another on the page they actually watch.
  const fs = require('node:fs');
  const path = require('node:path');
  const dash = fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script',
    'department-dashboard', 'SystemHealth.gs'), 'utf8');
  assert.equal(h.ctx.WORKBOOK_CELL_CAP_, 10000000);
  assert.equal(h.ctx.WORKBOOK_CELL_WARN_PCT_, 80);
  assert.match(dash, /var WORKBOOK_CELL_CAP_ = 10000000;/);
  assert.match(dash, /var WORKBOOK_CELL_WARN_PCT_ = 80;/);
});

test('R47: a PREVIEW returns what WOULD be freed, so the rollup line is not a false zero', function () {
  // trimVettedGrids_ sums trimGrid's return into one "N cell(s) would be
  // freed" line. Returning 0 on the preview path made that line read 0 under
  // per-tab lines showing 3,662,637 and 641,844 -- seen live 2026-09-14, and
  // exactly the number an operator uses to decide whether to run the apply.
  const src = require('node:fs').readFileSync(require('node:path').join(
    __dirname, '..', '..', 'apps-script', 'cdr-report', 'sheetSpace.js'), 'utf8');
  assert.match(src, /if \(!apply\) \{[^}]*return plan\.frees; \}/,
    'the preview branch must return plan.frees, never a literal 0');
  assert.ok(!/if \(!apply\) \{[^}]*return 0; \}/.test(src),
    'a literal 0 on the preview path makes the rollup line lie');
});

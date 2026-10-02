'use strict';

// QO-2 (owner ruling 2026-10-02): a QCD violation is an abandoned rate of
// 4.00% OR MORE. The dashboard tints and the queue-report email already used
// `>= 4`; the pipeline wrote col L with `> 0.04`, so an exactly-4.00% day read
// red beside a Viol count of 0. Pins the writers' rule (integer math, both
// writers) and the date-gated history repair in cdr-report.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

const imp = loadGas({ project: 'cdr-import', files: ['autoImport.js'] });
const rep = loadGas({ project: 'cdr-report', files: ['neonWrite.js', 'buildDQEHistoricalData.js', 'sheetRepairs.js'] });

test('QO-2: qcdViolationFlag_ is 4.00% OR MORE, decided in integers', function () {
  const f = function (t, a) { return imp.call('qcdViolationFlag_', t, a); };
  assert.equal(f(25, 1), 1, 'exactly 4.00% is a violation');
  assert.equal(f(100, 4), 1);
  assert.equal(f(300, 12), 1);
  assert.equal(f(101, 4), 0, '3.96% is not');
  assert.equal(f(100, 3), 0);
  assert.equal(f(24, 1), 1, '4.17%');
  assert.equal(f(0, 0), 0, 'no calls, no violation');
  assert.equal(f('', ''), 0);
});

test('QO-2: both QCD writers (daily + bulk) use the one flag helper; no `>` gate remains', function () {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script', 'cdr-import', 'autoImport.js'), 'utf8');
  assert.equal((src.match(/const viol\s+= qcdViolationFlag_\(total, abnd\);/g) || []).length, 2);
  assert.doesNotMatch(src, />\s*QCD_VIOLATION_ABANDON_RATE/);
  assert.match(src, /const QCD_VIOLATION_ABANDON_RATE = 0\.04;/, 'the R22 cross-file pin still reads it');
});

// ---- the history repair -----------------------------------------------------
const HEAD = ['Month', 'Week', 'Date', 'Queue', 'Source', 'Total', 'Answered', 'Abandoned',
  'Longest', 'Avg Ans', 'Abd %', 'Violations'];
function qrow(date, queue, total, abnd, flag) {
  return ['Aug 2026', 'W1', date, queue, 'Total Calls', total, total - abnd, abnd,
    '0:02:00', '0:00:20', (abnd / total * 100).toFixed(2) + '%', flag];
}
function install(rows) {
  rep.state.props = {};
  rep.state.createdSpreadsheets.length = 0;
  rep.state.spreadsheet = makeFakeSpreadsheet({ sheets: { 'QCD Historical Data': [HEAD].concat(rows) } });
  const mirrored = [];
  rep.ctx.writeQCDRowsToNeon = function (rs) { rs.forEach(function (r) { mirrored.push(r); }); return { inserted: rs.length }; };
  return { sheet: rep.state.spreadsheet.getSheetByName('QCD Historical Data'), mirrored: mirrored };
}
const ROWS = function () {
  return [
    qrow('8/12/2026', 'A_Q_Sales', 50, 2, 0),    // exactly 4.00%, in scope, stored 0 -> FLAG
    qrow('7/30/2026', 'A_Q_Sales', 25, 1, 0),    // exactly 4.00% but the 5% era -> untouched
    qrow('9/03/2026', 'A_Q_CSR', 24, 1, 1),      // 4.17% -> not a boundary row
    qrow('9/04/2026', 'A_Q_CSR', 100, 4, 1),     // exactly 4.00%, already 1 -> mirrored, not rewritten
    qrow('9/05/2026', 'A_Q_CSR', 101, 4, 0),     // 3.96% -> untouched
  ];
};

test('QO-2 repair: the preview reports the in-scope exactly-4.00% rows and writes nothing', function () {
  const env = install(ROWS());
  const res = rep.call('previewQcdViolationFlags');
  assert.equal(res.boundaryRows, 2);
  assert.equal(res.toFlag, 1);
  assert.equal(res.alreadyFlagged, 1);
  assert.equal(env.sheet.getRange(2, 12).getValue(), 0, 'nothing written');
  assert.equal(env.mirrored.length, 0, 'no Neon write from a preview');
});

test('QO-2 repair: the apply flags ONLY in-scope exactly-4.00% rows; the 5% era and other rates keep their flag', function () {
  const env = install(ROWS());
  const res = rep.call('repairQcdViolationFlags');
  assert.equal(res.written, 1);
  const flags = env.sheet.getRange(2, 12, 5, 1).getValues().map(function (r) { return r[0]; });
  assert.deepEqual(Array.from(flags), [1, 0, 1, 1, 0]);
  assert.equal(res.backup, null, 'one cell is below the snapshot threshold');
  // Neon: every in-scope boundary row is upserted with violations=1, the
  // already-flagged one included, so a re-run heals a failed mirror.
  assert.deepEqual(env.mirrored.map(function (r) { return r.callDate + ' ' + r.violations; }).sort(),
    ['2026-08-12 1', '2026-09-04 1']);
  assert.equal(env.mirrored[0].totalCalls, 50);
  assert.equal(res.neon, 'ok');

  // Idempotent: a second run writes nothing to the sheet and re-mirrors.
  env.mirrored.length = 0;
  const again = rep.call('repairQcdViolationFlags');
  assert.equal(again.written, 0);
  assert.equal(env.mirrored.length, 2);
});

test('QO-2 repair: an unreachable Neon leaves the sheet repaired and says to re-run', function () {
  const env = install(ROWS());
  rep.ctx.writeQCDRowsToNeon = function (rs) { return { inserted: 0, skipped: rs.length }; };
  const res = rep.call('repairQcdViolationFlags');
  assert.equal(res.written, 1);
  assert.match(res.neon, /unreachable -- re-run/);
  assert.equal(env.sheet.getRange(2, 12).getValue(), 1);
});

'use strict';

// ST2 (broad-scan 259, E4): ONE rule for "which day is this Raw Data /
// Call_Legs grid, and which legs are strays" -- rawGridDay_ (cdr-import
// autoImport.js; byte-identical copy in cdr-report queueOverlapAudit.js,
// guarded by scripts/check-duplicated-files.sh). The grid's day is the
// MAJORITY date, never the first row's: a carry-over leg from the day before
// can sort first (the ING-7 shape), and the readers that took the first valid
// row (queueSplitSample F59, the overlap audit F13) then dated a whole run by
// the stray. Scope, owner ruling 2026-10-15: no stored figure changes -- CDR /
// QCD / Q Path keep counting carry-over legs, and the DQE / Direct / per-call
// builders keep their own per-record checks.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadGas } = require('../harness/loadGas');

const ROOT = path.join(__dirname, '..', '..');
const imp = loadGas({ project: 'cdr-import', files: ['autoImport.js'] });
const J = function (x) { return JSON.parse(JSON.stringify(x)); };
const grid = function (starts) {
  return [['h0', 'h1', 'START']].concat(starts.map(function (s, i) { return ['id' + i, '', s]; }));
};

test('ST2: the day is the MAJORITY date even when a carry-over leg sorts first (ING-7)', function () {
  const d = J(imp.call('rawGridDay_', grid(['03/08/2026 23:58:10', '03/09/2026 7:00:00', '03/09/2026 8:00:00', '03/09/2026 9:00:00'])));
  assert.equal(d.dateIso, '2026-03-09');
  assert.equal(d.strays, 1);
  assert.deepEqual(d.strayByDay, { '2026-03-08': 1 });
  assert.equal(d.rows.length, 4, 'header + the three day legs');
  assert.equal(d.rows[0][2], 'START', 'the header is always kept');
  assert.equal(d.total, 4);
});

test('ST2: undated rows are kept (never strays); ISO and two-digit years parse; ties go to the later day', function () {
  const d = J(imp.call('rawGridDay_', grid(['', 'garbage', '2026-03-09 07:00', '3/9/26 8:00:00', '03/10/2026 0:01:00', '03/10/2026 0:02:00'])));
  assert.equal(d.dateIso, '2026-03-10', 'a 2-2 tie goes to the later date');
  assert.equal(d.strays, 2, 'the two 03-09 legs (ISO + two-digit year) are the strays');
  assert.equal(d.rows.length, 1 + 2 + 2, 'header + two undated + the two day legs');
  assert.equal(imp.call('rawGridDayIso_', '3/9/26 8:00'), '2026-03-09');
  assert.equal(imp.call('rawGridDayIso_', '2026-03-09'), '2026-03-09');
  assert.equal(imp.call('rawGridDayIso_', ''), null);
  assert.equal(imp.call('rawGridDayIso_', '45726'), null, 'a bare serial is not a date');
  const empty = J(imp.call('rawGridDay_', [['h']]));
  assert.equal(empty.dateIso, null);
  assert.equal(empty.rows.length, 1);
});

test('ST2: PIPE-3 and the CSR split are views over the one rule', function () {
  const g = grid(['03/08/2026 23:58:10', '03/09/2026 7:00:00', '03/09/2026 8:00:00']);
  const c = J(imp.call('sourceCallDateCounts_', g));
  assert.deepEqual(c.days, ['2026-03-09', '2026-03-08']);
  assert.equal(c.total, 3);
  const s = J(imp.call('csrRepairDayRows_', g));
  assert.deepEqual(Object.keys(s).sort(), ['dateIso', 'rows', 'strays']);
  assert.equal(s.dateIso, '2026-03-09');
  assert.equal(s.strays, 1);
});

test('ST2 sweep: every stray-aware reader dates its grid through rawGridDay_, never the first valid row', function () {
  const read = function (rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); };
  const body = function (src, name) {
    const start = src.indexOf('function ' + name + '(');
    assert.notEqual(start, -1, name + ' is missing');
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    return '';
  };
  const READERS = [
    ['apps-script/cdr-import/autoImport.js', 'sourceCallDateCounts_'],
    ['apps-script/cdr-import/autoImport.js', 'csrRepairDayRows_'],
    ['apps-script/cdr-import/queueSplitSample.js', 'sampleQueueSplitCallIds'],
    ['apps-script/cdr-report/queueOverlapAudit.js', 'queueOverlapAudit'],
  ];
  READERS.forEach(function (r) {
    assert.match(body(read(r[0]), r[1]), /\brawGridDay_\(/, r[0] + '::' + r[1] + ' must date its grid through rawGridDay_');
  });
  assert.match(read('apps-script/cdr-import/qcdDqeDiagnostic.js'), /const day = rawGridDay_\(/, 'diagnoseQcdVsDqe dates Raw Data through rawGridDay_');
  // The first-valid-row loops that rawGridDay_ replaced must not come back.
  assert.doesNotMatch(read('apps-script/cdr-import/queueSplitSample.js'), /for \(var bd = 0; bd < body\.length && !buildDate/);
  assert.doesNotMatch(read('apps-script/cdr-report/queueOverlapAudit.js'), /for \(var d1 = 0; d1 < data\.length && !buildDate/);
  // The cdr-report copy is the guard's job; make sure the guard names it.
  const guard = read('scripts/check-duplicated-files.sh');
  assert.match(guard, /check_fn_pair apps-script\/cdr-report\/queueOverlapAudit\.js apps-script\/cdr-import\/autoImport\.js rawGridDay_\n/);
  assert.match(guard, /check_fn_pair apps-script\/cdr-report\/queueOverlapAudit\.js apps-script\/cdr-import\/autoImport\.js rawGridDayIso_\n/);
});

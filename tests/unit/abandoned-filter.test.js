'use strict';

// AF-1: the "Filter abandoned calls…" dialog (cdr-import/AbandonedFilter.js +
// AbandonedFilterDialog.html) that replaces the fourteen per-queue menu items.
//
// The parity tests run the OLD engine (applyAbandonedFilter, unchanged) against
// a recording fake filter, interpret the criteria it set, and compare the rows
// it leaves visible with the new path's -- so a preset that stops matching its
// old item fails here, not on the owner's side-by-side check (S55). What no
// test can do is evaluate the generated FORMULA in Sheets; S55 is that check.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadGas } = require('../harness/loadGas');

const DIR = path.join(__dirname, '..', '..', 'apps-script', 'cdr-import');
const h = loadGas({ project: 'cdr-import', files: ['buildDQEHistoricalData.js', 'inboundCalls.js', 'AbandonedFilter.js'] });
const realApply = h.ctx.applyAbandonedFilter;
const PRESETS = h.ctx.AF_PRESETS_;

// ---- fixture ------------------------------------------------------------------
// One leg per row: start (PST wall clock), call time (s), queue, abandoned.
const D = '06/04/2026 ';
const LEGS = [
  ['10:00:00', 60, 'A_Q_CSR', 'Abandoned'],
  ['10:01:00', 59, 'A_Q_CSR', 'Abandoned'],        // at the 59 s threshold: hidden
  ['10:02:00', 300, 'A_Q_CSR', '-'],               // not abandoned
  ['10:03:00', 61, 'a_q_intake', 'Abandoned'],     // case variant: the old engine keeps it
  ['10:04:00', 90, 'Backup CSR', 'Abandoned'],     // only with the backup option
  ['06:10:00', 120, 'A_Q_CSR', 'Abandoned'],       // inside the CSR family's 6:00 floor
  ['06:10:00', 120, 'A_Q_Sales', 'Abandoned'],     // before every other queue's 6:30 floor
  ['15:00:00', 120, 'A_Q_CSR', 'Abandoned'],       // the window ends at 3:00 PM
  ['11:00:00', 20, 'A_Q_Sales', 'Abandoned'],      // Sales: more than 19 s
  ['11:01:00', 19, 'A_Q_Sales', 'Abandoned'],
  ['11:02:00', 20, 'A_Q_PAP', 'Abandoned'],
  ['11:03:00', 45, 'A_Q_FieldOps', 'Abandoned'],
  ['11:04:00', 75, 'A_Q_FieldOps', 'Abandoned'],
  ['11:05:00', 75, 'A_Q_BackUp_FieldOps', 'Abandoned'],
  ['11:06:00', 75, 'A_Q_FieldOps_Power', 'Abandoned'],
  ['11:07:00', 80, 'A_Q_Eligibility_MM&R', 'Abandoned'],
  ['11:08:00', 80, 'Introduction - New', 'Abandoned'],   // an IVR node, not a queue
  ['11:09:00', 80, '', 'Abandoned'],
];
['A_Q_PowerChairs', 'A_Q_Manual_Mobility', 'A_Q_Resupply', 'A_Q_Billing', 'A_Q_Service',
 'A_Q_Denials', 'A_Q_Spanish', 'A_Q_PAK'].forEach(function (q, i) {
  LEGS.push(['12:0' + i + ':00', 100, q, 'Abandoned'], ['12:1' + i + ':00', 30, q, 'Abandoned']);
});

function hms(sec) {
  const p = n => String(n).padStart(2, '0');
  return Math.floor(sec / 3600) + ':' + p(Math.floor(sec % 3600 / 60)) + ':' + p(sec % 60);
}
function displayRow(l) {               // what getDisplayValues returns
  const r = new Array(25).fill('');
  r[2] = D + l[0]; r[7] = hms(l[1]); r[11] = l[2]; r[24] = l[3];
  return r;
}
function valueRow(l) {                 // what getValues returns (H is a time serial)
  const r = displayRow(l);
  r[7] = l[1] / 86400;
  return r;
}
const DISPLAY = LEGS.map(displayRow);
const VALUES = LEGS.map(valueRow);

// ---- a recording fake of the filter API (test-local; the shared harness is not loosened)
function install(values, display) {
  const st = { filter: null, removed: 0, criteria: {} };
  const builder = function () {
    const c = {};
    const b = {
      whenTextEqualTo: function (t) { c.textEqualTo = t; return b; },
      setHiddenValues: function (v) { c.hidden = v.slice(); return b; },
      whenNumberGreaterThan: function (n) { c.numberGreaterThan = n; return b; },
      whenFormulaSatisfied: function (f) { c.formula = f; return b; },
      build: function () { return c; },
    };
    return b;
  };
  const sheet = {
    getName: () => 'Call_Legs_2026-06-04',
    getLastRow: () => values.length + 1,
    getLastColumn: () => 25,
    getFilter: () => st.filter,
    getDataRange: () => ({ createFilter: function () {
      st.filter = { setColumnFilterCriteria: function (col, c) { st.criteria[col] = c; },
                    remove: function () { st.removed++; st.filter = null; } };
      st.criteria = {};
      return st.filter;
    } }),
    getRange: function (r, c, n, w) {
      return {
        getValues: () => values.slice(r - 2, r - 2 + n).map(row => (w ? row.slice(c - 1, c - 1 + w) : [row[c - 1]])),
        getDisplayValues: () => display.slice(r - 2, r - 2 + n).map(row => row.slice(c - 1, c - 1 + (w || 1))),
      };
    },
  };
  h.ctx.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({ getActiveSheet: () => sheet }),
    newFilterCriteria: builder,
  };
  return st;
}

// Sheets' own reading of the OLD engine's three criteria (Text is exactly is
// case-insensitive; hidden values are exact cell values; Greater than needs a
// number).
function oldVisible(st, values) {
  return values.map(function (row, i) {
    return Object.keys(st.criteria).every(function (col) {
      const c = st.criteria[col], v = row[col - 1];
      if (c.textEqualTo != null && String(v).toLowerCase() !== String(c.textEqualTo).toLowerCase()) return false;
      if (c.hidden && c.hidden.indexOf(v) !== -1) return false;
      if (c.numberGreaterThan != null && !(typeof v === 'number' && v > c.numberGreaterThan)) return false;
      return true;
    }) ? i : -1;
  }).filter(i => i >= 0);
}
function newVisible(spec) {
  return DISPLAY.map((r, i) => (h.call('afRowVisible_', r, spec) ? i : -1)).filter(i => i >= 0);
}
function presetSpec(p, withBackup) {
  const t = h.call('afThresholdSec_', p.threshold);
  return { queues: p.queues.concat(withBackup ? (p.backup || []) : []).map(q => ({ name: q, thresholdSec: t })) };
}

// ---- tests --------------------------------------------------------------------

test('AF-1: every preset carries its old menu item verbatim, and every old item has a preset', function () {
  const src = fs.readFileSync(path.join(DIR, 'AbandonedFilter.js'), 'utf8');
  const wrappers = Array.from(src.matchAll(/^function (filter\w+Abandoned)\(\)/gm)).map(m => m[1]);
  assert.equal(wrappers.length, 14);
  assert.deepEqual(Array.from(PRESETS, p => p.fn).sort(), wrappers.slice().sort());
  const seen = [];
  h.ctx.applyAbandonedFilter = function (queues, threshold) { seen.push({ queues: queues.slice(), threshold }); };
  try {
    PRESETS.forEach(function (p) {
      seen.length = 0;
      h.call(p.fn);
      assert.equal(seen.length, 1, p.fn);
      assert.deepEqual(Array.from(seen[0].queues), Array.from(p.queues), p.fn + ' queues');
      assert.equal(seen[0].threshold, p.threshold, p.fn + ' threshold');
    });
  } finally { h.ctx.applyAbandonedFilter = realApply; }
  const menu = fs.readFileSync(path.join(DIR, 'CDR Tools.js'), 'utf8');
  PRESETS.forEach(p => assert.ok(menu.indexOf("'" + p.fn + "'") !== -1, p.fn + ' stays on the menu until S55'));
  assert.ok(menu.indexOf("'showAbandonedFilterDialog'") !== -1);
});

// The ONE deliberate difference: the old engine builds its hidden-values list
// from NON-BLANK queue cells, so an abandoned leg with a BLANK queue name is
// never hidden and every old item shows it. Those legs are no department's
// calls, so the dialog leaves them out -- S55 tells the owner to expect it.
test('AF-1 parity: each preset leaves exactly the rows its old item leaves, minus blank-queue legs', function () {
  const blank = LEGS.map((l, i) => (l[2] === '' ? i : -1)).filter(i => i >= 0);
  assert.ok(blank.length > 0, 'the fixture carries the blank-queue shape');
  PRESETS.forEach(function (p) {
    const st = install(VALUES, DISPLAY);
    realApply(Array.from(p.queues), p.threshold);
    const old = oldVisible(st, VALUES);
    const oldQueued = old.filter(i => blank.indexOf(i) === -1);
    assert.ok(oldQueued.length > 0, p.fn + ': the fixture exercises this preset');
    assert.deepEqual(newVisible(presetSpec(p, false)), oldQueued, p.fn);
    assert.deepEqual(old.filter(i => blank.indexOf(i) !== -1), blank, p.fn + ': the old item shows blank-queue legs');
  });
});

test('AF-1: the backup option adds Backup CSR / A_Q_BackUp_FieldOps at the department threshold', function () {
  const csr = PRESETS.filter(p => p.id === 'csr')[0];
  const fo = PRESETS.filter(p => p.id === 'fieldops')[0];
  const backupCsrRow = LEGS.findIndex(l => l[2] === 'Backup CSR');
  const backupFoRow = LEGS.findIndex(l => l[2] === 'A_Q_BackUp_FieldOps');
  assert.ok(newVisible(presetSpec(csr, false)).indexOf(backupCsrRow) === -1, 'off by default');
  assert.ok(newVisible(presetSpec(csr, true)).indexOf(backupCsrRow) !== -1);
  assert.ok(newVisible(presetSpec(fo, true)).indexOf(backupFoRow) !== -1);
  const d = h.call('afDefaultThresholds_');
  assert.equal(d['backup csr'], 59);
  assert.equal(d['a_q_backup_fieldops'], 59);
  assert.equal(d['a_q_sales'], 19);
  assert.equal(d['a_q_pap'], 19);
});

test('AF-1: per-queue thresholds in one selection, and a custom threshold overriding them', function () {
  const mixed = { queues: [{ name: 'A_Q_CSR', thresholdSec: 59 }, { name: 'A_Q_Sales', thresholdSec: 19 }] };
  const rows = newVisible(mixed).map(i => LEGS[i][2] + '@' + LEGS[i][1]);
  assert.ok(rows.indexOf('A_Q_Sales@20') !== -1 && rows.indexOf('A_Q_Sales@19') === -1);
  assert.ok(rows.indexOf('A_Q_CSR@60') !== -1 && rows.indexOf('A_Q_CSR@59') === -1);
  const custom = { queues: [{ name: 'A_Q_CSR', thresholdSec: 100 }, { name: 'A_Q_Sales', thresholdSec: 100 }] };
  const c = newVisible(custom).map(i => LEGS[i][1]);
  assert.ok(c.every(sec => sec > 100) && c.length > 0);
});

test('AF-1: the work window uses the pipeline floor per queue (R49) and the 3:00 PM end', function () {
  const spec = { queues: [{ name: 'A_Q_CSR', thresholdSec: 59 }, { name: 'A_Q_Sales', thresholdSec: 19 }], workWindow: true };
  const rows = newVisible(spec).map(i => LEGS[i][2] + '@' + LEGS[i][0]);
  assert.ok(rows.indexOf('A_Q_CSR@06:10:00') !== -1, 'CSR family starts at 6:00');
  assert.ok(rows.indexOf('A_Q_Sales@06:10:00') === -1, 'Sales starts at 6:30');
  assert.ok(rows.indexOf('A_Q_CSR@15:00:00') === -1, 'the window ends at 3:00 PM');
  const allDay = newVisible({ queues: spec.queues }).map(i => LEGS[i][2] + '@' + LEGS[i][0]);
  assert.ok(allDay.indexOf('A_Q_CSR@15:00:00') !== -1, 'whole day by default');
});

test('AF-1: the generated formula -- one criterion, per-queue arms, quotes escaped, window in whole seconds', function () {
  const f = h.call('afBuildFormula_', { queues: [{ name: 'A_Q_CSR', thresholdSec: 59 },
    { name: 'A_Q_Sales', thresholdSec: 19 }, { name: 'Odd "Q"', thresholdSec: 5 }], workWindow: true });
  assert.match(f, /^=AND\(LOWER\(\$Y2\)="abandoned",ISNUMBER\(\$H2\),OR\(/);
  assert.match(f, /AND\(LOWER\(\$L2\)="a_q_csr",\$H2>59\/86400,/);
  assert.match(f, /AND\(LOWER\(\$L2\)="a_q_sales",\$H2>19\/86400,/);
  assert.ok(f.indexOf('"odd ""q"""') !== -1, 'a double quote in a name is doubled');
  assert.ok(f.indexOf('>=21600') !== -1 && f.indexOf('>=23400') !== -1 && f.indexOf('<54000') !== -1);
  assert.ok(f.indexOf('ROUND(IFERROR(IF(ISNUMBER($C2)') !== -1);
  const plain = h.call('afBuildFormula_', { queues: [{ name: 'A_Q_CSR', thresholdSec: 59 }] });
  assert.equal(plain, '=AND(LOWER($Y2)="abandoned",ISNUMBER($H2),OR(AND(LOWER($L2)="a_q_csr",$H2>59/86400)))');
});

test('AF-1: requests are validated before they reach a formula', function () {
  const bad = [{}, { queues: [] }, { queues: [null] }, { queues: [{ name: '', thresholdSec: 5 }] },
    { queues: [{ name: 'A_Q_CSR', thresholdSec: -1 }] }, { queues: [{ name: 'A_Q_CSR', thresholdSec: 1.5 }] },
    { queues: [{ name: 'A_Q_CSR', thresholdSec: 'x' }] },
    { queues: Array.from({ length: 61 }, (_, i) => ({ name: 'Q' + i, thresholdSec: 1 })) }];
  bad.forEach(s => assert.throws(() => h.call('afNormalizeSpec_', s), undefined, JSON.stringify(s).slice(0, 60)));
  const n = h.call('afNormalizeSpec_', { queues: [{ name: ' A_Q_CSR ', thresholdSec: 59 }, { name: 'a_q_csr', thresholdSec: 10 }] });
  assert.equal(n.queues.length, 1, 'de-duplicated case-insensitively, first wins');
  assert.equal(n.queues[0].name, 'A_Q_CSR');
  assert.equal(n.workWindow, false);
});

test('AF-1: apply replaces any filter with ONE formula criterion and reports the expected count', function () {
  const st = install(VALUES, DISPLAY);
  realApply(['A_Q_Sales'], '0:00:19');               // an old filter is on the tab
  const spec = { queues: [{ name: 'A_Q_CSR', thresholdSec: 59 }, { name: 'A_Q_Intake', thresholdSec: 59 }] };
  const res = h.call('afApplyFromDialog', spec);
  assert.equal(st.removed, 1, 'the old filter was removed first');
  assert.deepEqual(Object.keys(st.criteria), ['1']);
  assert.equal(st.criteria[1].formula, h.call('afBuildFormula_', spec));
  assert.equal(res.expected, newVisible(spec).length);
  assert.equal(res.total, LEGS.length);
});

test('AF-1: the dialog lists only queue names on the tab, with abandoned counts', function () {
  install(VALUES, DISPLAY);
  const state = h.call('afGetDialogState');
  const names = Array.from(state.tabQueues).map(q => q.name);
  assert.ok(names.indexOf('Backup CSR') !== -1 && names.indexOf('A_Q_CSR') !== -1);
  assert.ok(names.indexOf('Introduction - New') === -1 && names.indexOf('') === -1, 'IVR nodes and blanks are not queues');
  const csr = Array.from(state.tabQueues).filter(q => q.name === 'A_Q_CSR')[0];
  assert.equal(csr.legs, 5);
  assert.equal(csr.abandoned, 4);
  assert.equal(state.isCallLegs, true);
  assert.equal(state.presets.length, 14);
});

test('AF-1: the dialog page calls only defined public functions and never writes sheet text as HTML', function () {
  const html = fs.readFileSync(path.join(DIR, 'AbandonedFilterDialog.html'), 'utf8');
  const calls = Array.from(html.matchAll(/\.(af\w+)\(/g)).map(m => m[1]);
  assert.deepEqual(Array.from(new Set(calls)).sort(), ['afApplyFromDialog', 'afClearFromDialog', 'afGetDialogState']);
  calls.forEach(fn => { assert.equal(typeof h.ctx[fn], 'function', fn); assert.ok(!/_$/.test(fn)); });
  const js = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotThrow(() => new vm.Script(js), 'the inline script parses');
});

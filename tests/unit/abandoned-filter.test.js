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
  ['14:59:59', 120, 'A_Q_CSR', 'Abandoned'],       // the last second inside it
  ['06:00:00', 120, 'A_Q_CSR', 'Abandoned'],       // exactly the CSR floor: inside
  ['06:30:00', 120, 'A_Q_Sales', 'Abandoned'],     // exactly the standard floor: inside
  ['06:29:59', 120, 'A_Q_Sales', 'Abandoned'],     // one second early: outside
  ['11:00:00', 20, 'A_Q_Sales', 'Abandoned'],      // Sales: more than 19 s
  ['11:01:00', 19, 'A_Q_Sales', 'Abandoned'],
  ['11:02:00', 20, 'A_Q_PAP', 'Abandoned'],
  ['11:03:00', 45, 'A_Q_FieldOps', 'Abandoned'],
  ['11:04:00', 75, 'A_Q_FieldOps', 'Abandoned'],
  ['11:05:00', 75, 'A_Q_BackUp_FieldOps', 'Abandoned'],
  ['11:06:00', 75, 'A_Q_FieldOps_Power', 'Abandoned'],
  ['11:07:00', 80, 'A_Q_Eligibility_MM&R', 'Abandoned'],
  ['11:08:00', 80, 'Introduction - New', 'Abandoned'],   // an IVR node, not a queue
  ['11:09:00', 80, '', 'Abandoned'],              // no queue name: the old items show it
  ['11:10:00', 10, '', 'Abandoned'],              // no queue name, under every threshold
  ['11:11:00', 80, '', '-'],                      // no queue name, not abandoned
  ['11:12:00', null, 'A_Q_CSR', 'Abandoned'],     // no call time: never a match
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
  r[2] = D + l[0]; r[7] = l[1] == null ? '' : hms(l[1]); r[11] = l[2]; r[24] = l[3];
  return r;
}
function valueRow(l) {                 // what getValues returns (H is a time serial)
  const r = displayRow(l);
  r[7] = l[1] == null ? '' : l[1] / 86400;
  return r;
}
const DISPLAY = LEGS.map(displayRow);
const VALUES = LEGS.map(valueRow);

// ---- an independent evaluator for the generated formula ---------------------
// Recursive descent over exactly the grammar afBuildFormula_ emits, with
// Sheets' rules where they matter here: text compares case-insensitively and
// sorts ABOVE numbers, an empty cell is "" next to text and 0 next to a number,
// AND/OR evaluate every argument, and an error anywhere hides the row.
const ERR = { err: true };
function evalFormula(f, cells) {
  let i = 0;
  const src = f.replace(/^=/, '');
  const peek = re => { re.lastIndex = i; const m = re.exec(src); return m && m.index === i ? m : null; };
  const eat = re => { const m = peek(re); if (!m) throw new Error('parse error at ' + i + ': ' + src.slice(i, i + 20)); i += m[0].length; return m; };
  const isErr = v => v === ERR;
  const rank = v => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2);
  function cmp(a, b, op) {
    if (isErr(a) || isErr(b)) return ERR;
    if (a === '' && typeof b === 'number') a = 0;
    if (b === '' && typeof a === 'number') b = 0;
    let c;
    if (rank(a) !== rank(b)) c = rank(a) - rank(b);
    else if (typeof a === 'string') { const x = a.toLowerCase(), y = b.toLowerCase(); c = x < y ? -1 : x > y ? 1 : 0; }
    else c = a < b ? -1 : a > b ? 1 : 0;
    return { '=': c === 0, '<>': c !== 0, '<': c < 0, '>': c > 0, '<=': c <= 0, '>=': c >= 0 }[op];
  }
  const num = v => (isErr(v) ? ERR : v === '' ? 0 : typeof v === 'number' ? v : ERR);
  const F = {
    AND: a => (a.some(isErr) ? ERR : a.every(v => v === true)),
    OR: a => (a.some(isErr) ? ERR : a.some(v => v === true)),
    LOWER: a => (isErr(a[0]) ? ERR : String(a[0]).toLowerCase()),
    ISNUMBER: a => typeof a[0] === 'number',
    ROUND: a => (isErr(num(a[0])) ? ERR : Math.round(num(a[0]))),
    IFERROR: a => (isErr(a[0]) ? a[1] : a[0]),
    IF: a => (isErr(a[0]) ? ERR : a[0] ? a[1] : a[2]),
    MOD: a => { const x = num(a[0]), y = num(a[1]); return isErr(x) || isErr(y) ? ERR : x - y * Math.floor(x / y); },
    TIMEVALUE: a => { const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(a[0]).trim()); return m ? ((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])) / 86400 : ERR; },
    MID: a => (a.some(isErr) ? ERR : String(a[0]).substr(a[1] - 1, a[2])),
    FIND: a => { const k = String(a[1]).indexOf(String(a[0])); return k < 0 ? ERR : k + 1; },
  };
  function primary() {
    let m;
    if ((m = peek(/"((?:[^"]|"")*)"/y))) { i += m[0].length; return m[1].replace(/""/g, '"'); }
    if ((m = peek(/\d+(?:\.\d+)?/y))) { i += m[0].length; return Number(m[0]); }
    if ((m = peek(/\$([A-Z]+)2/y))) {
      i += m[0].length;
      const col = m[1].split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
      const v = cells[col - 1];
      return v == null ? '' : v;
    }
    if ((m = peek(/([A-Z]+)\(/y))) {
      i += m[0].length;
      const args = [];
      if (!peek(/\)/y)) { args.push(expr()); while (peek(/,/y)) { eat(/,/y); args.push(expr()); } }
      eat(/\)/y);
      if (!F[m[1]]) throw new Error('unknown function ' + m[1]);
      return F[m[1]](args);
    }
    if (peek(/\(/y)) { eat(/\(/y); const v = expr(); eat(/\)/y); return v; }
    throw new Error('parse error at ' + i + ': ' + src.slice(i, i + 20));
  }
  function unary() { if (peek(/-/y)) { eat(/-/y); const v = num(unary()); return isErr(v) ? ERR : -v; } return primary(); }
  function term() {
    let v = unary(), m;
    while ((m = peek(/[*\/]/y))) { i++; const r = num(unary()), l = num(v); v = isErr(l) || isErr(r) ? ERR : m[0] === '*' ? l * r : l / r; }
    return v;
  }
  function additive() {
    let v = term(), m;
    while ((m = peek(/[+-]/y))) { i++; const r = num(term()), l = num(v); v = isErr(l) || isErr(r) ? ERR : m[0] === '+' ? l + r : l - r; }
    return v;
  }
  function expr() {
    const l = additive();
    const m = peek(/>=|<=|<>|=|<|>/y);
    if (!m) return l;
    i += m[0].length;
    return cmp(l, additive(), m[0]);
  }
  const v = expr();
  if (i !== src.length) throw new Error('trailing input at ' + i);
  return v === true;
}

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
    // What Sheets would hide: the formula criterion through the evaluator, the
    // old engine's three criteria through oldRowVisible.
    isRowHiddenByFilter: function (rowPos) {
      if (!st.filter) return false;
      const cells = values[rowPos - 2];
      return !Object.keys(st.criteria).every(col => criterionPasses(st.criteria[col], col, cells));
    },
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
    flush: function () {},
  };
  st.sheet = sheet;
  return st;
}
function criterionPasses(c, col, row) {
  if (c.formula != null) return evalFormula(c.formula, row);
  const v = row[col - 1];
  if (c.textEqualTo != null && String(v).toLowerCase() !== String(c.textEqualTo).toLowerCase()) return false;
  if (c.hidden && c.hidden.indexOf(v) !== -1) return false;
  if (c.numberGreaterThan != null && !(typeof v === 'number' && v > c.numberGreaterThan)) return false;
  return true;
}

// Sheets' own reading of the OLD engine's three criteria (Text is exactly is
// case-insensitive; hidden values are exact cell values; Greater than needs a
// number).
function oldVisible(st, values) {
  return values.map((row, i) => (Object.keys(st.criteria).every(col => criterionPasses(st.criteria[col], col, row)) ? i : -1))
    .filter(i => i >= 0);
}
function formulaVisible(spec) {
  const f = h.call('afBuildFormula_', spec);
  return VALUES.map((row, i) => (evalFormula(f, row) ? i : -1)).filter(i => i >= 0);
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
  assert.ok(menu.indexOf("'runAbandonedFilterCheck'") !== -1);
});

// No exclusion the old items lacked (owner, 2026-10-05): the old engine never
// hides an EMPTY queue cell (its hidden-values list skips blanks), so a row
// with no queue name passes its queue step -- the dialog keeps those rows by
// default, and the comparison below is EXACT.
test('AF-1 parity: each preset leaves EXACTLY the rows its old item leaves (no-queue-name rows included)', function () {
  const blank = LEGS.map((l, i) => (l[2] === '' && l[3] === 'Abandoned' && l[1] > 59 ? i : -1)).filter(i => i >= 0);
  assert.ok(blank.length > 0, 'the fixture carries the no-queue-name shape');
  PRESETS.forEach(function (p) {
    const st = install(VALUES, DISPLAY);
    realApply(Array.from(p.queues), p.threshold);
    const old = oldVisible(st, VALUES);
    assert.ok(old.length > blank.length, p.fn + ': the fixture exercises this preset');
    assert.deepEqual(newVisible(presetSpec(p, false)), old, p.fn + ' (tested rule)');
    assert.deepEqual(formulaVisible(presetSpec(p, false)), old, p.fn + ' (the generated formula itself)');
    blank.forEach(i => assert.ok(old.indexOf(i) !== -1, p.fn + ': the old item shows no-queue-name row ' + i));
  });
});

test('AF-1: the no-queue-name option -- on by default, lowest ticked threshold, off removes only those rows', function () {
  const blankIdx = LEGS.map((l, i) => (l[2] === '' ? i : -1)).filter(i => i >= 0);
  const mixed = { queues: [{ name: 'A_Q_CSR', thresholdSec: 59 }, { name: 'A_Q_Sales', thresholdSec: 19 }] };
  const on = newVisible(mixed), off = newVisible(Object.assign({ includeBlankQueue: false }, mixed));
  assert.deepEqual(on.filter(i => blankIdx.indexOf(i) !== -1), [LEGS.findIndex(l => l[2] === '' && l[1] === 80 && l[3] === 'Abandoned')],
    'the 80 s abandoned leg; not the 10 s one (under 19 s), not the unabandoned one');
  assert.deepEqual(off, on.filter(i => blankIdx.indexOf(i) === -1));
  const lowT = { queues: [{ name: 'A_Q_CSR', thresholdSec: 5 }] };
  assert.ok(newVisible(lowT).indexOf(LEGS.findIndex(l => l[2] === '' && l[1] === 10)) !== -1, 'a 10 s one passes a 5 s threshold');
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
  assert.ok(rows.indexOf('A_Q_CSR@14:59:59') !== -1 && rows.indexOf('A_Q_CSR@06:00:00') !== -1);
  assert.ok(rows.indexOf('A_Q_Sales@06:30:00') !== -1 && rows.indexOf('A_Q_Sales@06:29:59') === -1, 'the floor is inclusive, to the second');
  assert.deepEqual(formulaVisible(spec), newVisible(spec), 'the formula agrees at every edge');
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
  assert.equal(plain, '=AND(LOWER($Y2)="abandoned",ISNUMBER($H2),OR(AND(LOWER($L2)="a_q_csr",$H2>59/86400),AND($L2="",$H2>59/86400)))');
  const noBlank = h.call('afBuildFormula_', { queues: [{ name: 'A_Q_CSR', thresholdSec: 59 }], includeBlankQueue: false });
  assert.equal(noBlank, '=AND(LOWER($Y2)="abandoned",ISNUMBER($H2),OR(AND(LOWER($L2)="a_q_csr",$H2>59/86400)))');
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

test('AF-1: the generated formula, evaluated, agrees with the tested rule on every dialog shape', function () {
  const q = (n, t) => ({ name: n, thresholdSec: t });
  const specs = [
    { queues: [q('A_Q_CSR', 59), q('A_Q_Intake', 59)] },
    { queues: [q('A_Q_CSR', 59), q('A_Q_Sales', 19)] },
    { queues: [q('A_Q_CSR', 59), q('A_Q_Sales', 19)], workWindow: true },
    { queues: [q('A_Q_CSR', 59), q('Backup CSR', 59)], includeBlankQueue: false },
    { queues: [q('A_Q_CSR', 100), q('a_q_intake', 100)] },
    { queues: [q('A_Q_FieldOps', 59), q('A_Q_BackUp_FieldOps', 59)], workWindow: true, includeBlankQueue: false },
    { queues: [q('A_Q_Eligibility_MM&R', 59)] },
  ];
  specs.forEach(function (sp) {
    const a = formulaVisible(sp), b = newVisible(sp);
    assert.ok(b.length > 0, JSON.stringify(sp));
    assert.deepEqual(a, b, JSON.stringify(sp));
  });
  // The evaluator is not a rubber stamp: a broken formula disagrees with it.
  const f = h.call('afBuildFormula_', specs[1]).replace('$H2>19/86400', '$H2>59/86400');
  const broken = VALUES.map((row, i) => (evalFormula(f, row) ? i : -1)).filter(i => i >= 0);
  assert.notDeepEqual(broken, newVisible(specs[1]));
});

test('AF-1 check: on a tab where everything agrees, the menu check reads CLEAN and leaves the tab unfiltered', function () {
  const st = install(VALUES, DISPLAY);
  const res = h.call('afRunCheck_', st.sheet, { sample: 5 });
  assert.equal(st.filter, null, 'the filter is removed at the end');
  const results = Array.from(res.results);
  assert.equal(results.length, 14 + 5, 'every preset vs its old item, plus the five dialog-only checks');
  results.forEach(r => {
    assert.ok(!r.skipped, r.label);
    assert.ok(r.vsMirror.ok, r.label + ' vs the tested rule');
    if (r.old) assert.ok(r.vsOld.ok, r.label + ' vs the old item');
  });
  assert.ok(results.filter(r => r.old).length === 14);
  const lines = Array.from(h.call('afCheckReportLines_', res));
  assert.match(lines[lines.length - 1], /^VERDICT: CLEAN/);
  assert.match(lines.join('\n'), /with no queue name/, 'the report says how many no-queue-name rows each filter shows');
});

test('AF-1 check: a disagreement names the rows on each side, and an out-of-time run is INCONCLUSIVE', function () {
  const st = install(VALUES, DISPLAY);
  const real = st.sheet.isRowHiddenByFilter;
  // Simulate Sheets hiding one extra row under the DIALOG's formula filters only.
  const extra = LEGS.findIndex(l => l[2] === 'A_Q_CSR' && l[1] === 60);
  st.sheet.isRowHiddenByFilter = function (pos) {
    const usesFormula = Object.keys(st.criteria).some(c => st.criteria[c].formula != null);
    return (usesFormula && pos === extra + 2) || real.call(st.sheet, pos);
  };
  const lines = Array.from(h.call('afCheckReportLines_', h.call('afRunCheck_', st.sheet, { sample: 5 })));
  const text = lines.join('\n');
  assert.match(text, /MISMATCH CSR vs "filterCSRAbandoned"/);
  assert.match(text, new RegExp('only the OLD item shows: row ' + (extra + 2) + ' \\[A_Q_CSR, call time 0:01:00'));
  assert.match(text, /the tested rule shows, Sheets does not: row/);
  assert.match(lines[lines.length - 1], /^VERDICT: MISMATCH/);
  const st2 = install(VALUES, DISPLAY);
  const late = Array.from(h.call('afCheckReportLines_', h.call('afRunCheck_', st2.sheet, { sample: 5, budgetMs: -1 })));
  assert.match(late[late.length - 1], /^VERDICT: INCONCLUSIVE/);
});

test('AF-1 check: it reads every abandoned leg and an even sample of the rest', function () {
  const rows = DISPLAY;
  const ids = Array.from(h.call('afCheckRows_', rows, 3));
  const abandoned = rows.map((r, i) => (r[24] === 'Abandoned' ? i : -1)).filter(i => i >= 0);
  abandoned.forEach(i => assert.ok(ids.indexOf(i) !== -1));
  const rest = rows.length - abandoned.length;
  assert.ok(rest >= 2);
  assert.equal(ids.length, abandoned.length + Math.min(3, rest));
  assert.equal(Array.from(h.call('afCheckRows_', rows, 0)).length, abandoned.length);
});

test('AF-1: the dialog lists only queue names on the tab, with abandoned counts', function () {
  install(VALUES, DISPLAY);
  const state = h.call('afGetDialogState');
  const names = Array.from(state.tabQueues).map(q => q.name);
  assert.ok(names.indexOf('Backup CSR') !== -1 && names.indexOf('A_Q_CSR') !== -1);
  assert.ok(names.indexOf('Introduction - New') === -1 && names.indexOf('') === -1, 'IVR nodes and blanks are not queues');
  const csr = Array.from(state.tabQueues).filter(q => q.name === 'A_Q_CSR')[0];
  assert.equal(csr.legs, 8);
  assert.equal(csr.abandoned, 7);
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

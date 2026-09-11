'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { formatDate } = require('../harness/formatDate');

// Phase 2 / roadmap Batch 4: the nightly check-and-sort over the five
// historical sheets (sheetRepairs.js). Load-bearing properties:
//   - the check is "single-typed AND ordered AND no TZ split", never just
//     ordered -- a MIXED / TZ-SPLIT column is REFUSED (a sort would order it
//     wrongly and then look sorted), with a failure row that names why;
//   - a single-typed, out-of-order sheet is sorted, RE-CHECKED, and reported
//     ("sorted -- N inversion(s)"), and no other sheet is touched;
//   - the flag gates the handler; the preview writes nothing; a backfill
//     resume pointer defers the whole run without reading a sheet;
//   - one Pipeline Health row per sheet per run under historicalSort:<label>.
// sheetRepairs.js needs parseDateForNeon (neonWrite.js) and, for the fixtures,
// dateAtSheetMidnight_ (buildDQEHistoricalData.js).
const h = loadGas({ project: 'cdr-report', files: ['neonWrite.js', 'buildDQEHistoricalData.js', 'sheetRepairs.js'] });

const SS_TZ = makeFakeSpreadsheet({ sheets: {} }).getSpreadsheetTimeZone();
const SCRIPT_TZ = 'America/Chicago';
function sheetMidnight(y, m, d) { return h.call('dateAtSheetMidnight_', SS_TZ, y, m, d); }
function inTz(v, tz) { return formatDate(v, tz, 'yyyy-MM-dd HH:mm'); }
function dateCell(y, m, d) { return { v: sheetMidnight(y, m, d), disp: m + '/' + d + '/' + y, fmt: 'M/d/yyyy' }; }
function textCell(str)     { return { v: str, disp: str, fmt: '@' }; }
// R46 shape: a Date at SCRIPT-TZ midnight of a SUMMER date (Mexico City renders 23:00 the day before).
function scriptMidnightCell(y, m, d) {
  const want = Date.UTC(y, m - 1, d);
  let t = want;
  for (let k = 0; k < 3; k++) {
    const seen = Date.parse(inTz(new Date(t), SCRIPT_TZ).replace(' ', 'T') + ':00Z');
    if (seen === want) break;
    t += want - seen;
  }
  const v = new Date(t);
  return { v: v, disp: formatDate(v, SS_TZ, 'M/d/yyyy H:mm') + ':00', fmt: '' };
}
function buildSheet(cells, dateIdx) {
  const values = [], displays = [], formats = [];
  const header = ['Month', 'Date', 'Agent', 'x'];
  values.push(header.slice()); displays.push(header.slice()); formats.push(['General', 'General', 'General', 'General']);
  cells.forEach(function (c, i) {
    const v = ['Jun, 26', 'W1', 'row' + i, 'x'];
    const d = v.slice();
    const f = ['General', 'General', 'General', 'General'];
    v[dateIdx] = c.v; d[dateIdx] = c.disp; f[dateIdx] = c.fmt;
    values.push(v); displays.push(d); formats.push(f);
  });
  return { values: values, displays: displays, formats: formats };
}
function dqeSheet(cells)  { return buildSheet(cells, 1); }
function colCSheet(cells) { return buildSheet(cells, 2); }

const NAMES = ['DQE Historical Data', 'QCD Historical Data', 'CDR Historical Data',
               'CSR Transfer Historical Data', 'Q Path Historical Data'];
const LABELS = { 'DQE Historical Data': 'DQE', 'QCD Historical Data': 'QCD', 'CDR Historical Data': 'CDR',
                 'CSR Transfer Historical Data': 'CSR', 'Q Path Historical Data': 'QPath' };
const CLEAN = [dateCell(2026, 6, 1), dateCell(2026, 6, 2), dateCell(2026, 6, 3)];

function fiveSheets(overrides) {
  const out = {};
  NAMES.forEach(function (n) { out[n] = n === NAMES[0] ? dqeSheet(CLEAN) : colCSheet(CLEAN); });
  Object.keys(overrides || {}).forEach(function (n) { out[n] = overrides[n]; });
  return out;
}
function install(sheets, props) {
  h.state.props = Object.assign({ SPREADSHEET_ID: 'fake' }, props || {});
  const all = Object.assign({ 'Pipeline Health': [['Timestamp', 'Step', 'Status', 'Rows', 'Duration (ms)', 'Notes']] }, sheets);
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: all });
  return h.state.spreadsheet;
}
function phRows(ss) {
  return ss.getSheetByName('Pipeline Health')._data.slice(1).map(function (r) {
    return { step: r[1], status: r[2], rows: r[3], notes: r[5] };
  });
}
function sortCalls(ss, name) { return (ss.getSheetByName(name)._sortCalls || []).length; }
function colC(ss, name) { return ss.getSheetByName(name)._data.slice(1).map(function (r) { return r[2]; }); }

test('Phase 2: the handler is a no-op unless HISTORICAL_SORT_ENABLED is exactly true', function () {
  let ss = install(fiveSheets({ 'QCD Historical Data': colCSheet([dateCell(2026, 6, 3), dateCell(2026, 6, 1)]) }));
  let res = h.call('runHistoricalSortCheck_');
  assert.equal(res.skipped, 'disabled');
  assert.equal(phRows(ss).length, 0, 'no Pipeline Health rows');
  assert.equal(sortCalls(ss, 'QCD Historical Data'), 0, 'nothing sorted');
  ss = install(fiveSheets(), { HISTORICAL_SORT_ENABLED: 'false' });
  assert.equal(h.call('runHistoricalSortCheck_').skipped, 'disabled');
  ss = install(fiveSheets(), { HISTORICAL_SORT_ENABLED: ' TRUE ' });
  assert.equal(h.call('runHistoricalSortCheck_').skipped, undefined, 'tolerant of case/whitespace');
  assert.equal(phRows(ss).length, 5);
});

test('Phase 2: five clean sheets -> one success row per sheet under historicalSort:<label>, nothing sorted', function () {
  const ss = install(fiveSheets(), { HISTORICAL_SORT_ENABLED: 'true' });
  const res = h.call('runHistoricalSortCheck_');
  assert.equal(res.sheets.length, 5);
  const rows = phRows(ss);
  assert.deepEqual(rows.map(function (r) { return r.step; }).sort(),
    NAMES.map(function (n) { return 'historicalSort:' + LABELS[n]; }).sort());
  rows.forEach(function (r) {
    assert.equal(r.status, 'success', r.step);
    assert.match(String(r.notes), /^clean -- 3 rows/, r.step);
    assert.equal(r.rows, 3);
  });
  NAMES.forEach(function (n) { assert.equal(sortCalls(ss, n), 0, n + ' untouched'); });
});

test('Phase 2: a single-typed OUT-OF-ORDER sheet is sorted on its date column, re-checked, and reported; the others are untouched', function () {
  const ss = install(fiveSheets({
    'QCD Historical Data': colCSheet([dateCell(2026, 6, 3), dateCell(2026, 6, 1), dateCell(2026, 6, 2)]),
  }), { HISTORICAL_SORT_ENABLED: 'true' });
  const res = h.call('runHistoricalSortCheck_');
  const qcd = res.sheets.filter(function (e) { return e.label === 'QCD'; })[0];
  assert.equal(qcd.action, 'sorted');
  assert.equal(qcd.status, 'success');
  assert.match(qcd.notes, /^sorted -- 1 inversion\(s\) \(first at row 3: 2026-06-03 then 2026-06-01\); re-check CLEAN/);
  const calls = ss.getSheetByName('QCD Historical Data')._sortCalls;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].column, 3, 'QCD keeps its date in col C');
  assert.equal(calls[0].startRow, 2, 'header row excluded');
  assert.deepEqual(colC(ss, 'QCD Historical Data').map(function (d) { return formatDate(d, SS_TZ, 'yyyy-MM-dd'); }),
    ['2026-06-01', '2026-06-02', '2026-06-03'], 'the sheet is now in date order');
  const row = phRows(ss).filter(function (r) { return r.step === 'historicalSort:QCD'; })[0];
  assert.equal(row.status, 'success');
  assert.match(String(row.notes), /^sorted -- 1 inversion/);
  NAMES.filter(function (n) { return n !== 'QCD Historical Data'; })
       .forEach(function (n) { assert.equal(sortCalls(ss, n), 0, n + ' untouched'); });
});

test('Phase 2: DQE sorts on col B (its own date column)', function () {
  const ss = install(fiveSheets({
    'DQE Historical Data': dqeSheet([dateCell(2026, 6, 2), dateCell(2026, 6, 1)]),
  }), { HISTORICAL_SORT_ENABLED: 'true' });
  h.call('runHistoricalSortCheck_');
  const calls = ss.getSheetByName('DQE Historical Data')._sortCalls;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].column, 2);
});

test('Phase 2: a MIXED-TYPE column is REFUSED -- no sort, a failure row that says a sort cannot fix it', function () {
  const ss = install(fiveSheets({
    'DQE Historical Data': dqeSheet([dateCell(2026, 6, 1), textCell('6/2/2026'), dateCell(2026, 6, 3)]),
  }), { HISTORICAL_SORT_ENABLED: 'true' });
  const res = h.call('runHistoricalSortCheck_');
  const dqe = res.sheets.filter(function (e) { return e.label === 'DQE'; })[0];
  assert.equal(dqe.action, 'refused');
  assert.equal(dqe.status, 'failure');
  assert.match(dqe.notes, /^MIXED-TYPE -- a sort cannot fix/);
  assert.equal(sortCalls(ss, 'DQE Historical Data'), 0, 'NEVER sorted');
  const row = phRows(ss).filter(function (r) { return r.step === 'historicalSort:DQE'; })[0];
  assert.equal(row.status, 'failure');
  assert.match(String(row.notes), /MIXED-TYPE/);
  // the other four still ran and are clean
  assert.equal(phRows(ss).filter(function (r) { return r.status === 'success'; }).length, 4);
});

test('Phase 2: a MIXED-TYPE column that is ALSO out of order is still refused (the order-only trap)', function () {
  const ss = install(fiveSheets({
    'CDR Historical Data': colCSheet([dateCell(2026, 6, 3), textCell('6/1/2026'), dateCell(2026, 6, 2)]),
  }), { HISTORICAL_SORT_ENABLED: 'true' });
  const res = h.call('runHistoricalSortCheck_');
  const cdr = res.sheets.filter(function (e) { return e.label === 'CDR'; })[0];
  assert.equal(cdr.action, 'refused');
  assert.match(cdr.notes, /^MIXED-TYPE\+UNSORTED/);
  assert.equal(sortCalls(ss, 'CDR Historical Data'), 0);
});

test('Phase 2 / R46: a TZ-SPLIT column is refused, never sorted -- even when it is ALSO out of order', function () {
  // Out of order on purpose: an "ordered-or-split" check that only refused
  // the ordered case would happily sort this one (and a sort cannot fix a
  // cell that reads a different day in the two zones).
  const ss = install(fiveSheets({
    'CSR Transfer Historical Data': colCSheet([dateCell(2026, 7, 3), scriptMidnightCell(2026, 7, 2), dateCell(2026, 7, 1)]),
  }), { HISTORICAL_SORT_ENABLED: 'true' });
  const res = h.call('runHistoricalSortCheck_');
  const csr = res.sheets.filter(function (e) { return e.label === 'CSR'; })[0];
  assert.equal(csr.action, 'refused');
  assert.equal(csr.status, 'failure');
  assert.match(csr.notes, /^UNSORTED\+TZ-SPLIT -- a sort cannot fix/);
  assert.equal(sortCalls(ss, 'CSR Transfer Historical Data'), 0);
});

test('Phase 2: a sort whose RE-CHECK still fails is a failure row, not a claimed success', function () {
  const ss = install(fiveSheets({
    'QCD Historical Data': colCSheet([dateCell(2026, 6, 3), dateCell(2026, 6, 1)]),
  }), { HISTORICAL_SORT_ENABLED: 'true' });
  // The sheet changes under the job (a concurrent append) -- model it by
  // making the SECOND scan of QCD report disorder again.
  const real = h.ctx.hdScanOneSheet_;
  let qcdScans = 0;
  h.ctx.hdScanOneSheet_ = function (s, spec, opts) {
    const r = real(s, spec, opts);
    if (spec.sheet === 'QCD Historical Data' && ++qcdScans === 2) {
      r.ordered = false; r.inversions = 1; r.verdict = 'UNSORTED';
    }
    return r;
  };
  try {
    const res = h.call('runHistoricalSortCheck_');
    const qcd = res.sheets.filter(function (e) { return e.label === 'QCD'; })[0];
    assert.equal(qcdScans, 2, 'scan, sort, re-scan');
    assert.equal(qcd.action, 'sorted');
    assert.equal(qcd.status, 'failure');
    assert.match(qcd.notes, /^sorted, but the re-check still reads UNSORTED \(1 inversion/);
    assert.equal(phRows(ss).filter(function (r) { return r.step === 'historicalSort:QCD'; })[0].status, 'failure');
  } finally {
    h.ctx.hdScanOneSheet_ = real;
  }
});

test('Phase 2: a backfill resume pointer DEFERS the whole run -- no sheet is read, every row says skipped and names the pointer', function () {
  const ss = install(fiveSheets({
    'QCD Historical Data': colCSheet([dateCell(2026, 6, 3), dateCell(2026, 6, 1)]),
  }), { HISTORICAL_SORT_ENABLED: 'true', DQE_UPSERT_RESUME: '12|abc' });
  // Prove "not read": a sheet whose getRange throws would fail the run.
  ss.getSheetByName('QCD Historical Data').getRange = function () { throw new Error('must not read'); };
  const res = h.call('runHistoricalSortCheck_');
  assert.equal(Array.from(res.resumePending).join(','), 'DQE_UPSERT_RESUME');   // vm-realm array
  const rows = phRows(ss);
  assert.equal(rows.length, 5);
  rows.forEach(function (r) {
    assert.equal(r.status, 'success', r.step);
    assert.match(String(r.notes), /^skipped -- backfill resume pointer\(s\) set: DQE_UPSERT_RESUME/, r.step);
  });
  NAMES.forEach(function (n) { assert.equal(sortCalls(ss, n), 0); });
});

test('Phase 2: the preview reports would-sort and writes NOTHING (no sort, no Pipeline Health row)', function () {
  const ss = install(fiveSheets({
    'QCD Historical Data': colCSheet([dateCell(2026, 6, 3), dateCell(2026, 6, 1)]),
  }), { HISTORICAL_SORT_ENABLED: 'true' });
  const res = h.call('previewHistoricalSortCheck');
  const qcd = res.sheets.filter(function (e) { return e.label === 'QCD'; })[0];
  assert.equal(qcd.action, 'would-sort');
  assert.match(qcd.notes, /^UNSORTED -- 1 inversion/);
  assert.equal(phRows(ss).length, 0);
  assert.equal(sortCalls(ss, 'QCD Historical Data'), 0);
  assert.deepEqual(colC(ss, 'QCD Historical Data').map(function (d) { return formatDate(d, SS_TZ, 'yyyy-MM-dd'); }),
    ['2026-06-03', '2026-06-01'], 'the sheet is unchanged');
});

test('Phase 2: a check that throws on one sheet costs THAT sheet a failure row and nothing else', function () {
  const ss = install(fiveSheets(), { HISTORICAL_SORT_ENABLED: 'true' });
  ss.getSheetByName('Q Path Historical Data').getRange = function () { throw new Error('quota'); };
  const res = h.call('runHistoricalSortCheck_');
  const qp = res.sheets.filter(function (e) { return e.label === 'QPath'; })[0];
  assert.equal(qp.status, 'failure');
  assert.equal(qp.action, 'error');
  assert.match(qp.notes, /^check threw: quota/);
  const rows = phRows(ss);
  assert.equal(rows.length, 5, 'every sheet still logged');
  assert.equal(rows.filter(function (r) { return r.status === 'success'; }).length, 4);
});

test('Phase 2: a sort that THROWS is a failure row, and the sheet is left as it was', function () {
  const ss = install(fiveSheets({
    'QCD Historical Data': colCSheet([dateCell(2026, 6, 3), dateCell(2026, 6, 1)]),
  }), { HISTORICAL_SORT_ENABLED: 'true' });
  ss.getSheetByName('QCD Historical Data')._sortError = new Error('range busy');
  const res = h.call('runHistoricalSortCheck_');
  const qcd = res.sheets.filter(function (e) { return e.label === 'QCD'; })[0];
  assert.equal(qcd.status, 'failure');
  assert.match(qcd.notes, /^check threw: range busy/);
  assert.equal(phRows(ss).filter(function (r) { return r.step === 'historicalSort:QCD'; })[0].status, 'failure');
});

test('Phase 2: a MISSING sheet is a success row saying so, never a throw', function () {
  const sheets = fiveSheets();
  delete sheets['Q Path Historical Data'];
  const ss = install(sheets, { HISTORICAL_SORT_ENABLED: 'true' });
  h.call('runHistoricalSortCheck_');
  const row = phRows(ss).filter(function (r) { return r.step === 'historicalSort:QPath'; })[0];
  assert.equal(row.status, 'success');
  assert.match(String(row.notes), /^missing -- nothing to check/);
});

test('Phase 2: install creates the daily ~3 AM trigger AND arms the flag; uninstall removes both', function () {
  install(fiveSheets());
  const created = [], deleted = [];
  let existing = [];
  const realScriptApp = h.ctx.ScriptApp;
  h.ctx.ScriptApp = {
    newTrigger: function (fn) {
      const b = { fn: fn, timeBased: function () { return b; }, everyDays: function (n) { b.days = n; return b; },
                  atHour: function (hr) { b.hour = hr; return b; }, create: function () { created.push(b); return {}; } };
      return b;
    },
    getProjectTriggers: function () { return existing; },
    deleteTrigger: function (t) { deleted.push(t); },
  };
  try {
    h.call('installHistoricalSortTrigger');
    assert.equal(created.length, 1);
    assert.equal(created[0].fn, 'runHistoricalSortCheck_');
    assert.equal(created[0].days, 1);
    assert.equal(created[0].hour, 3);
    assert.equal(h.state.props.HISTORICAL_SORT_ENABLED, 'true', 'install arms the flag');
    existing = [{ getHandlerFunction: function () { return 'runHistoricalSortCheck_'; } },
                { getHandlerFunction: function () { return 'runDailyDQEBuild_'; } }];
    h.call('uninstallHistoricalSortTrigger');
    assert.equal(deleted.length, 1, 'only its own trigger');
    assert.equal(h.state.props.HISTORICAL_SORT_ENABLED, undefined, 'uninstall clears the flag');
  } finally {
    h.ctx.ScriptApp = realScriptApp;
  }
});

test('Phase 2 (source pins): the CDR Tools menu wires all four entry points, and the bulk path logs its sort failure under the same step family', function () {
  const root = path.join(__dirname, '..', '..', 'apps-script');
  const menu = fs.readFileSync(path.join(root, 'cdr-report', 'CDR Tools menu.js'), 'utf8');
  ['installHistoricalSortTrigger', 'uninstallHistoricalSortTrigger', 'previewHistoricalSortCheck', 'runHistoricalSortCheckNow']
    .forEach(function (fn) {
      assert.ok(menu.indexOf("'" + fn + "'") !== -1, 'menu item for ' + fn);
      assert.equal(typeof h.ctx[fn], 'function', fn + ' is defined (menu items must resolve)');
    });
  const auto = fs.readFileSync(path.join(root, 'cdr-import', 'autoImport.js'), 'utf8');
  const block = auto.slice(auto.indexOf('const sheetsToSort = ['), auto.indexOf('const sheetsToSort = [') + 1600);
  assert.ok(/logPipelineHealthWithFallback_\(targetSS, \{\s*step:\s*'historicalSort:' \+ label,\s*status:\s*'failure'/.test(block),
    'the bulk-path sort catch logs a historicalSort:<label> FAILURE row');
  assert.ok(!/console\.warn\(`Sort failed/.test(auto),
    'the swallowed console.warn is gone (Cloud Logging is nowhere an operator looks)');
  // The bulk labels are a subset of the nightly check's, so its next clean
  // run supersedes the failure row under the SAME step name.
  const labels = [];
  block.replace(/label:\s*"([A-Za-z]+)"/g, function (_, l) { labels.push(l); return _; });
  assert.deepEqual(labels.sort(), ['CDR', 'CSR', 'QCD', 'QPath']);
  const repairs = fs.readFileSync(path.join(root, 'cdr-report', 'sheetRepairs.js'), 'utf8');
  labels.forEach(function (l) {
    assert.ok(new RegExp("'" + l + "',?\\s*\\n").test(repairs.slice(repairs.indexOf('var HISTORICAL_SORT_LABELS_'))),
      'nightly label ' + l);
  });
  assert.ok(/HISTORICAL_SORT_STEP_PREFIX_ = 'historicalSort:'/.test(repairs));
  const health = fs.readFileSync(path.join(root, 'department-dashboard', 'SystemHealth.gs'), 'utf8');
  assert.ok(/var hsPrefix = 'historicalSort:'/.test(health), 'the Health page reads the same prefix');
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

// F-7: Setup.gs had ZERO test coverage while INV-12 asserts it is idempotent,
// admin-gated, creates the twelve dashboard-managed sheets, and never overwrites
// existing rows. These pins make the claim enforced rather than asserted.

const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'DeptConfig.gs', 'Setup.gs'],
  capture: ['SHEETS', 'ACCESS_CONTROL_HEADERS', 'COMPANY_HOLIDAYS_HEADERS', 'DASHBOARD_STANDARDS_HEADERS'],
});

function install() {
  h.state.userEmail = 'admin@x.com';
  h.state.props = { SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' };
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {} });
}

// The twelve managed sheet names, from the captured constants (not re-typed --
// the pin must follow the code's own list). H1 added Company Holidays, H2
// Dashboard Standards.
const TEN = [
  'ACCESS_CONTROL', 'ALERT_CONFIG', 'ALERT_LOG', 'PIPELINE_HEALTH',
  'DIGEST_CONFIG', 'AGENT_ALIAS_OVERRIDES', 'ORPHAN_FIX_LOG', 'DEPT_CONFIG',
  'REPORT_USAGE', 'QUEUE_REPORT_SUBSCRIBERS', 'COMPANY_HOLIDAYS', 'DASHBOARD_STANDARDS',
].map(function (k) { return h.consts.SHEETS[k]; });
assert.equal(TEN.length, 12, 'INV-12 says twelve');

test('INV-12: setup() is admin-gated', function () {
  install();
  h.state.userEmail = 'stranger@x.com';
  assert.throws(function () { h.call('setup'); }, /admin/i);
});

test('INV-12: setup() creates all twelve managed sheets with header rows', function () {
  install();
  h.call('setup');
  TEN.forEach(function (name) {
    assert.ok(name, 'sheet-name constant resolves');
    const sh = h.state.spreadsheet.getSheetByName(name);
    assert.ok(sh, 'created: ' + name);
    assert.ok(sh.getLastRow() >= 1, name + ' has a header row');
    assert.ok(String(sh._data[0][0] || '').length, name + ' header row is non-empty');
  });
});

test('INV-12: setup() is idempotent -- re-run never overwrites existing rows', function () {
  install();
  h.call('setup');
  // Simulate live data + a hand-edited header cell on one managed sheet.
  const ac = h.state.spreadsheet.getSheetByName(h.consts.SHEETS.ACCESS_CONTROL);
  ac.appendRow(['manager@x.com', 'CSR', 'note']);
  ac._data[0][2] = 'Custom Notes Label';
  h.call('setup');
  assert.equal(ac.getLastRow(), 2, 're-run did not add or remove rows');
  assert.equal(ac._data[1][0], 'manager@x.com', 'data row untouched');
  assert.equal(ac._data[0][2], 'Custom Notes Label', 'existing header untouched (no overwrite)');
});

test('setup(): a failing sheet does not abort the rest (partial-run recovery)', function () {
  install();
  // First insertSheet throws once (the operator's transient "Service
  // Spreadsheets timed out"); the loop must continue and a re-run must heal.
  const ss = h.state.spreadsheet;
  const realInsert = ss.insertSheet;
  let threw = false;
  ss.insertSheet = function (name) {
    if (!threw) { threw = true; throw new Error('Service Spreadsheets timed out'); }
    return realInsert.call(ss, name);
  };
  h.call('setup');
  const missing = TEN.filter(function (n) { return !ss.getSheetByName(n); });
  assert.equal(missing.length, 1, 'exactly the one failed sheet is missing');
  h.call('setup');   // re-run heals
  assert.equal(TEN.filter(function (n) { return !ss.getSheetByName(n); }).length, 0);
});

test('H1: setup() plain-text pins the Company Holidays Dates column at creation, and only that column', function () {
  install();
  h.call('setup');
  const sh = h.state.spreadsheet.getSheetByName(h.consts.SHEETS.COMPANY_HOLIDAYS);
  assert.deepEqual(Array.from(sh._data[0].slice(0, 4)), Array.from(h.consts.COMPANY_HOLIDAYS_HEADERS), 'header row from the constant');
  const fmts = (sh._numberFormats || []).filter(function (f) { return f.format === '@'; });
  assert.ok(fmts.length >= 1, 'a setNumberFormat("@") was recorded (F-6 harness rule)');
  assert.ok(fmts.every(function (f) { return f.startCol === 1 && f.startRow === 2; }),
    'the pin covers the Dates column below the header, nothing else');
  // No other managed sheet gained a text pin (the spec is per-sheet).
  const ac = h.state.spreadsheet.getSheetByName(h.consts.SHEETS.ACCESS_CONTROL);
  assert.equal((ac._numberFormats || []).length, 0);
});

test('H2: setup() publishes the Dashboard Standards sheet (text-pinned excludes column) from the live resolution', function () {
  install();
  // A roster with two dept columns (INV-11: headers from col F) and a Dept
  // Config row overriding CSR's excludes -- the three inputs the publish folds.
  const rosterHeader = ['', '', '', '', '', 'CSR', 'Sales'];
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {
    'DO NOT EDIT!': [rosterHeader, ['', '', '', '', '', 'Robin Choudhury, 139', 'Sam Seller, 201']],
    'Dept Config': [['Department', 'QCD Queues', 'Overview Parent', 'Team Avg Excludes', 'Queue Ext Overrides', 'Active', 'Updated By', 'Updated At', 'Notes', 'Inbound Queue Aliases', 'Final Dept Labels'],
                    ['CSR', '', '', 'Robin Choudhury, Pat Lead', '', 'TRUE', '', '', '', '', '']],
  } });
  h.state.props.DEPT_ANSWER_TARGETS = 'Sales=88/4';
  h.ctx.ANSWER_TARGETS_MEMO_ = null; h.ctx.DEPT_ANSWER_TARGETS_MEMO_ = null; h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  h.call('setup');
  const sh = h.state.spreadsheet.getSheetByName(h.consts.SHEETS.DASHBOARD_STANDARDS);
  assert.ok(sh, 'created');
  assert.deepEqual(Array.from(sh._data[0]), Array.from(h.consts.DASHBOARD_STANDARDS_HEADERS));
  const rows = sh._data.slice(1).map(function (r) { return r.slice(0, 4).join('|'); });
  assert.deepEqual(rows, [
    'CSR|92|2|Robin Choudhury, Pat Lead',   // CSR seed 92/2 + the Dept Config excludes override
    'Sales|88|4|',                          // the DEPT_ANSWER_TARGETS property override
    '*|80|10|',                             // the global standard (seeds)
  ]);
  assert.ok(String(sh._data[1][4]).length && String(sh._data[1][5]).length, 'Published At / By stamped');
  const pins = (sh._numberFormats || []).filter(function (f) { return f.format === '@'; });
  assert.ok(pins.some(function (f) { return f.startCol === 4; }), 'the excludes column is plain-text pinned');
  // Re-running setup() republishes in place: same rows, no duplicates.
  h.call('setup');
  assert.equal(sh._data.length, 4, 'header + 3 rows, rewritten not appended');
  delete h.state.props.DEPT_ANSWER_TARGETS;
  h.ctx.ANSWER_TARGETS_MEMO_ = null; h.ctx.DEPT_ANSWER_TARGETS_MEMO_ = null; h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
});


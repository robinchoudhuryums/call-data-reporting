'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

// F-7: Setup.gs had ZERO test coverage while INV-12 asserts it is idempotent,
// admin-gated, creates the ten dashboard-managed sheets, and never overwrites
// existing rows. These pins make the claim enforced rather than asserted.

const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'Setup.gs'],
  capture: ['SHEETS', 'ACCESS_CONTROL_HEADERS'],
});

function install() {
  h.state.userEmail = 'admin@x.com';
  h.state.props = { SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' };
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {} });
}

// The ten managed sheet names, from the captured constants (not re-typed --
// the pin must follow the code's own list).
const TEN = [
  'ACCESS_CONTROL', 'ALERT_CONFIG', 'ALERT_LOG', 'PIPELINE_HEALTH',
  'DIGEST_CONFIG', 'AGENT_ALIAS_OVERRIDES', 'ORPHAN_FIX_LOG', 'DEPT_CONFIG',
  'REPORT_USAGE', 'QUEUE_REPORT_SUBSCRIBERS',
].map(function (k) { return h.consts.SHEETS[k]; });

test('INV-12: setup() is admin-gated', function () {
  install();
  h.state.userEmail = 'stranger@x.com';
  assert.throws(function () { h.call('setup'); }, /admin/i);
});

test('INV-12: setup() creates all ten managed sheets with header rows', function () {
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

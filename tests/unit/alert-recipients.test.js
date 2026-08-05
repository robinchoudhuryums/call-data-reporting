'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

// B-5: low-answer-rate alert recipient resolution (Alerts.gs::
// lookupDeptManagers_). The exact-match dept comparison silently excluded
// ALL/'*'-sentinel managers (the all-departments role) from EVERY dept's
// alert; this suite is the function's first coverage.

const h = loadGas({ files: ['Config.gs', 'Util.gs', 'Auth.gs', 'DeptConfig.gs', 'Alerts.gs'] });

function install(rows) {
  h.state.props = { SPREADSHEET_ID: 'fake' };
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {
    'Access Control': [['Email', 'Department', 'Notes']].concat(rows),
  } });
}

test('B-5: dept managers + ALL/'+ '*-sentinel managers both resolve as recipients', function () {
  install([
    ['csr.mgr@x.com',   'CSR',   ''],
    ['sales.mgr@x.com', 'Sales', ''],
    ['ops.lead@x.com',  'ALL',   'all-departments manager'],
    ['star.lead@x.com', '*',     'sentinel variant'],
    ['blank@x.com',     '',      'no dept -> ignored'],
  ]);
  const csr = h.call('lookupDeptManagers_', 'CSR');
  assert.deepEqual(JSON.parse(JSON.stringify(csr)),
    ['csr.mgr@x.com', 'ops.lead@x.com', 'star.lead@x.com'],
    'own-dept row + both sentinel spellings; never the other dept\'s manager');
  const sales = h.call('lookupDeptManagers_', 'Sales');
  assert.ok(sales.indexOf('sales.mgr@x.com') !== -1);
  assert.ok(sales.indexOf('ops.lead@x.com') !== -1, 'ALL manager receives every dept\'s alert');
  assert.ok(sales.indexOf('csr.mgr@x.com') === -1, 'single-dept manager stays scoped');
});

test('B-5: missing Access Control sheet -> empty recipient list (no throw)', function () {
  h.state.props = { SPREADSHEET_ID: 'fake' };
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {} });
  assert.deepEqual(JSON.parse(JSON.stringify(h.call('lookupDeptManagers_', 'CSR'))), []);
});

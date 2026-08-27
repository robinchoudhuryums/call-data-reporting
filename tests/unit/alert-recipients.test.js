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

// P1 (broad-scan 2026-08-27): the recipient lookup used to read only cols 1-2,
// so a Role=agent row (which shares the Department column since Phase A) became
// a To: recipient of manager alerts whose body names each under-threshold
// teammate with per-agent numbers -- the teammate-identity disclosure the agent
// role's privacy contract forbids. Recipients are MANAGER rows only: blank Role
// = legacy manager (Auth.gs's own default), unknown roles fail closed.
test('P1: agent-role rows are NEVER alert recipients; blank role = manager; unknown role fails closed', function () {
  h.state.props = { SPREADSHEET_ID: 'fake' };
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {
    'Access Control': [
      ['Email', 'Department', 'Notes', 'Role', 'Agent Name'],
      ['csr.mgr@x.com',    'CSR', '', 'manager', ''],
      ['legacy.mgr@x.com', 'CSR', '', '',        ''],          // blank role -> manager
      ['csr.agent@x.com',  'CSR', '', 'agent',   'Jane Doe'],  // MUST be excluded
      ['weird.row@x.com',  'CSR', '', 'auditor', ''],          // unknown role -> fail closed
      ['all.agent@x.com',  'ALL', '', 'agent',   'Roy Kent'],  // agent + ALL sentinel -> still excluded
      ['ops.lead@x.com',   'ALL', '', 'Manager', 'case-insensitive role'],
    ],
  } });
  const csr = JSON.parse(JSON.stringify(h.call('lookupDeptManagers_', 'CSR')));
  assert.deepEqual(csr, ['csr.mgr@x.com', 'legacy.mgr@x.com', 'ops.lead@x.com'],
    'manager + blank-role + ALL-sentinel manager only; agent and unknown roles excluded');
});

// The pre-agent 3-column sheet must still read cleanly (the fake sheet enforces
// getMaxColumns, F-5 -- an unbounded 4-col read would THROW here, the REP-10 class).
test('P1: a legacy 3-column Access Control sheet still resolves managers (width-bounded read)', function () {
  install([['old.mgr@x.com', 'CSR', 'pre-agent-role install']]);
  assert.deepEqual(JSON.parse(JSON.stringify(h.call('lookupDeptManagers_', 'CSR'))),
    ['old.mgr@x.com']);
});

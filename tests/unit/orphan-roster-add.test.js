'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { rosterGrid } = require('../harness/fixtures');

// addOrphanToRoster: the "orphan is actually a NEW EMPLOYEE" flow.
// The write must stay structurally confined to the chosen dept's
// column (first-blank-terminated header scan) and is INV-01-gated:
// admin + validation + lock + audit row.
const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'Data.gs', 'OrphanFix.gs'],
});

const LOG_HEADER = ['Timestamp', 'Admin', 'Action', 'From Name', 'To Name', 'Affected Rows', 'Notes'];

function install(opts) {
  opts = opts || {};
  h.state.userEmail = opts.email || 'admin@x.com';
  h.state.props.ADMIN_EMAILS = 'admin@x.com';
  h.state.props.SPREADSHEET_ID = 'fake';
  const sheets = {
    'DO NOT EDIT!': rosterGrid({
      Alpha: ['Anna, 201', 'Ben, 202'],
      Beta:  ['Cara, 301'],
    }),
    'Orphan Fix Log': [LOG_HEADER],
  };
  if (opts.noLog) delete sheets['Orphan Fix Log'];
  h.state.spreadsheet = makeFakeSpreadsheet({ timeZone: 'America/Chicago', sheets: sheets });
  h.state.cache.clear();
}

function add(req) { return h.call('addOrphanToRoster', req); }

test('roster-add: happy path appends "Name, exts" below the dept column', function () {
  install();
  const res = add({ name: 'Dana New', department: 'Beta', extensions: '305, 306' });
  assert.equal(res.added, 1);
  assert.equal(res.cell, 'G3');   // Beta = col G; below Cara (row 2)

  const grid = h.state.spreadsheet._sheet('DO NOT EDIT!')._data;
  assert.equal(grid[2][6], 'Dana New, 305, 306');
  // Alpha's column untouched.
  assert.equal(grid[1][5], 'Anna, 201');
  assert.equal((grid[2] || [])[5] || '', 'Ben, 202');

  // Audit row landed (action roster-add, dept in the To column).
  const log = h.state.spreadsheet._sheet('Orphan Fix Log')._data;
  assert.equal(log.length, 2);
  assert.equal(log[1][2], 'roster-add');
  assert.equal(log[1][3], 'Dana New');
  assert.equal(log[1][4], 'Beta');
  assert.ok(String(log[1][6]).indexOf('305, 306') !== -1, 'exts recorded in notes');

  // The new name is now on the roster -- a second add is rejected.
  assert.throws(function () {
    add({ name: 'Dana New', department: 'Alpha', extensions: '999' });
  }, /already on a roster/);
});

test('roster-add: longest column wins the row scan (per-column append)', function () {
  install();
  // Alpha has 2 entries, Beta has 1 -- adding to Alpha lands in row 4.
  const res = add({ name: 'Eve Q', department: 'Alpha', extensions: ['410'] });
  assert.equal(res.cell, 'F4');
  const grid = h.state.spreadsheet._sheet('DO NOT EDIT!')._data;
  assert.equal(grid[3][5], 'Eve Q, 410');
});

test('roster-add: validation rejects bad input before any write', function () {
  install();
  assert.throws(function () { add({ name: 'X Y', department: 'Alpha', extensions: '' }); },
    /extension is required/);
  assert.throws(function () { add({ name: 'X Y', department: 'Alpha', extensions: '20a' }); },
    /digits only/);
  assert.throws(function () { add({ name: 'X Y', department: 'Gamma', extensions: '200' }); },
    /Unknown department/);
  assert.throws(function () { add({ name: 'Anna', department: 'Alpha', extensions: '200' }); },
    /already on a roster/);
  assert.throws(function () { add({ name: 'A_Q_Ghost', department: 'Alpha', extensions: '200' }); },
    /Queue-sentinel/);
  assert.throws(function () { add({ name: 'Comma, Name', department: 'Alpha', extensions: '200' }); },
    /comma/);
  // Nothing was written by any rejected call.
  const grid = h.state.spreadsheet._sheet('DO NOT EDIT!')._data;
  assert.equal(grid.length, 3);
  assert.equal(h.state.spreadsheet._sheet('Orphan Fix Log')._data.length, 1);
});

test('roster-add: admin-only; audit sheet is a precondition', function () {
  install({ email: 'manager@x.com' });
  assert.throws(function () {
    add({ name: 'X Y', department: 'Alpha', extensions: '200' });
  }, /admin-only/);

  install({ noLog: true });
  assert.throws(function () {
    add({ name: 'X Y', department: 'Alpha', extensions: '200' });
  }, /Orphan Fix Log sheet missing/);
});

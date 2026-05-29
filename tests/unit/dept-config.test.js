'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deepEqual } = require('node:assert'); // legacy: prototype-agnostic for cross-realm vm values
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

// OVERVIEW_PARENT_OF lives in CompanyOverview.gs; getOverviewParentMap_
// merges it. Load all three so the accessors resolve their constants.
const h = loadGas({
  files: ['Config.gs', 'CompanyOverview.gs', 'DeptConfig.gs'],
  capture: ['DEPT_CONFIG_HEADERS', 'DEPT_QCD_QUEUES', 'TEAM_AVG_EXCLUDES',
            'OVERVIEW_PARENT_OF', 'DEPT_QUEUE_EXT_OVERRIDES'],
});
const HEADERS = h.consts.DEPT_CONFIG_HEADERS;

// Install a Dept Config sheet fixture (rows are the data rows; the
// header row is prepended) and clear the per-execution memo so the
// next accessor call re-reads. Pass `null` for "no Dept Config sheet".
function setConfig(rows) {
  h.state.props.SPREADSHEET_ID = 'fake';
  const sheets = {};
  if (rows !== null) sheets['Dept Config'] = [HEADERS].concat(rows);
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: sheets });
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
}

// Build a Dept Config row in column order:
// Dept | QCD | Parent | TeamExcl | QueueExt | Active | By | At | Notes
function row(opts) {
  return [
    opts.dept,
    opts.qcd || '',
    opts.parent || '',
    opts.excl || '',
    opts.qext || '',
    opts.active === false ? 'FALSE' : 'TRUE',
    opts.by || 'admin@x.com',
    opts.at || '',
    opts.notes || '',
  ];
}

// -- pure helpers ---------------------------------------------------

test('dcParseList_ splits, trims, de-dupes, drops empties', function () {
  deepEqual(h.call('dcParseList_', 'a, b ,c'), ['a', 'b', 'c']);
  deepEqual(h.call('dcParseList_', 'a, a, b'), ['a', 'b']);   // dedupe
  deepEqual(h.call('dcParseList_', ' , ,'), []);
  deepEqual(h.call('dcParseList_', ''), []);
  deepEqual(h.call('dcParseList_', null), []);
});

test('dcIsActive_ treats explicit falsey markers as inactive', function () {
  assert.equal(h.call('dcIsActive_', 'TRUE'), true);
  assert.equal(h.call('dcIsActive_', true), true);
  assert.equal(h.call('dcIsActive_', ''), true);     // blank defaults active
  assert.equal(h.call('dcIsActive_', 'FALSE'), false);
  assert.equal(h.call('dcIsActive_', false), false);
  assert.equal(h.call('dcIsActive_', 0), false);
  assert.equal(h.call('dcIsActive_', 'No'), false);
});

test('dcNormalizeList_ accepts arrays + strings, de-dupes, caps length', function () {
  deepEqual(h.call('dcNormalizeList_', ['a', 'a', 'b'], 'X'), ['a', 'b']);
  deepEqual(h.call('dcNormalizeList_', 'a, b, b', 'X'), ['a', 'b']);
  deepEqual(h.call('dcNormalizeList_', undefined, 'X'), []);
  const huge = [];
  for (let i = 0; i < 300; i++) huge.push('queuename' + i);   // joined > 1000 chars
  assert.throws(function () { h.call('dcNormalizeList_', huge, 'QCD Queues'); }, /too long/);
});

// -- override semantics (INV-54) ------------------------------------

test('getDeptQcdQueues_: no sheet -> falls through to the constant', function () {
  setConfig(null);
  deepEqual(h.call('getDeptQcdQueues_', 'CSR'), h.consts.DEPT_QCD_QUEUES['CSR']);
});

test('getDeptQcdQueues_: active row with a non-empty field overrides', function () {
  setConfig([row({ dept: 'CSR', qcd: 'A_Q_Foo, A_Q_Bar' })]);
  deepEqual(h.call('getDeptQcdQueues_', 'CSR'), ['A_Q_Foo', 'A_Q_Bar']);
});

test('getDeptQcdQueues_: empty field on an active row falls back to the constant', function () {
  // Row sets only the parent; QCD field blank -> constant wins.
  setConfig([row({ dept: 'CSR', parent: '', qcd: '' })]);
  deepEqual(h.call('getDeptQcdQueues_', 'CSR'), h.consts.DEPT_QCD_QUEUES['CSR']);
});

test('getDeptQcdQueues_: inactive row is ignored (reverts to constant)', function () {
  setConfig([row({ dept: 'CSR', qcd: 'A_Q_Foo', active: false })]);
  deepEqual(h.call('getDeptQcdQueues_', 'CSR'), h.consts.DEPT_QCD_QUEUES['CSR']);
});

test('getDeptQcdQueues_: brand-new dept (no constant) defined entirely by the sheet', function () {
  setConfig([row({ dept: 'NewTeam', qcd: 'A_Q_NewTeam' })]);
  deepEqual(h.call('getDeptQcdQueues_', 'NewTeam'), ['A_Q_NewTeam']);
});

test('getTeamAvgExcludes_: override and fallback', function () {
  setConfig([row({ dept: 'Sales', excl: 'Jane Doe, John Roe' })]);
  deepEqual(h.call('getTeamAvgExcludes_', 'Sales'), ['Jane Doe', 'John Roe']);
  // CSR has no row here -> constant seed.
  deepEqual(h.call('getTeamAvgExcludes_', 'CSR'), h.consts.TEAM_AVG_EXCLUDES['CSR']);
});

test('getDeptQueueExtsOverride_: override and fallback to constant', function () {
  setConfig([row({ dept: 'Sales', qext: '201, 202' })]);
  deepEqual(h.call('getDeptQueueExtsOverride_', 'Sales'), ['201', '202']);
  // CSR constant: 103/108/1003.
  setConfig(null);
  deepEqual(h.call('getDeptQueueExtsOverride_', 'CSR').sort(),
    h.consts.DEPT_QUEUE_EXT_OVERRIDES['CSR'].slice().sort());
});

test('getOverviewParentMap_: seeds from constant, sheet overrides per dept', function () {
  setConfig(null);
  const base = h.call('getOverviewParentMap_');
  assert.equal(base['PAP'], 'Sales');   // from OVERVIEW_PARENT_OF constant

  setConfig([row({ dept: 'NewSub', parent: 'CSR' })]);
  const merged = h.call('getOverviewParentMap_');
  assert.equal(merged['NewSub'], 'CSR');   // sheet adds a new child
  assert.equal(merged['PAP'], 'Sales');    // constant still present
});

test('dcWouldCreateParentCycle_ detects a 2-cycle, allows acyclic', function () {
  // Y -> X already in the sheet; making X -> Y closes the loop.
  setConfig([row({ dept: 'Y', parent: 'X' })]);
  assert.equal(h.call('dcWouldCreateParentCycle_', 'X', 'Y'), true);
  // Z has no parent anywhere -> X -> Z is acyclic.
  assert.equal(h.call('dcWouldCreateParentCycle_', 'X', 'Z'), false);
});

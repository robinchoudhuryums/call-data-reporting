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
// Dept | QCD | Parent | TeamExcl | QueueExt | Active | By | At | Notes | InboundAliases
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
    opts.inboundAliases || '',
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

test('getInboundQueueAliases_: sheet-only, empty when absent or inactive', function () {
  // No sheet / no row -> [] (no seed constant for inbound aliases).
  setConfig(null);
  deepEqual(h.call('getInboundQueueAliases_', 'CSR'), []);

  // Active row with aliases -> parsed list.
  setConfig([row({ dept: 'CSR', inboundAliases: 'A_Q_CSR, Backup CSR' })]);
  deepEqual(h.call('getInboundQueueAliases_', 'CSR'), ['A_Q_CSR', 'Backup CSR']);

  // A row that sets other fields but leaves aliases blank -> [].
  setConfig([row({ dept: 'CSR', qcd: 'A_Q_CustomerSuccess' })]);
  deepEqual(h.call('getInboundQueueAliases_', 'CSR'), []);

  // Inactive row is ignored.
  setConfig([row({ dept: 'CSR', inboundAliases: 'A_Q_CSR', active: false })]);
  deepEqual(h.call('getInboundQueueAliases_', 'CSR'), []);
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

// -- S1(c): inbound queue-name discovery ------------------------------------

test('S1(c): classifyInboundQueues_ attributes via the map, unattributed-first then busiest', function () {
  const scanned = [
    { queue: 'A_Q_CSR',    calls: 500, last_seen: '2026-07-08' },
    { queue: 'Backup CSR', calls: 40,  last_seen: '2026-07-01' },
    { queue: 'A_Q_Ghost',  calls: 90,  last_seen: '2026-07-07' },  // no dept claims it
    { queue: 'A_Q_Wisp',   calls: 3,   last_seen: '2026-06-20' },  // ditto, quieter
    { queue: '  ',         calls: 9,   last_seen: '2026-07-01' },  // blank -> dropped
  ];
  const out = h.call('classifyInboundQueues_', scanned,
    { 'A_Q_CSR': 'CSR', 'Backup CSR': 'CSR' });
  deepEqual(out.map(function (r) { return r.queue; }),
    ['A_Q_Ghost', 'A_Q_Wisp', 'A_Q_CSR', 'Backup CSR']);
  assert.equal(out[0].mappedTo, null);
  assert.equal(out[2].mappedTo, 'CSR');
  assert.equal(out[2].calls, 500);
  assert.equal(out[2].lastSeen, '2026-07-08');
});

test('S1(c): discoverInboundQueues_ -> available:false when the Neon scan is unavailable', function () {
  // No scanInboundQueueNames_ in this harness (InboundReport.gs not loaded)
  // -> the typeof guard treats it as Neon-unavailable.
  const out = h.call('discoverInboundQueues_', ['CSR']);
  assert.equal(out.available, false);
  deepEqual(out.queues, []);
});

test('S1(c): discoverInboundQueues_ attributes via the EFFECTIVE inbound set per dept', function () {
  h.ctx.scanInboundQueueNames_ = function (days) {
    assert.equal(days, 180);   // the shared Dept Config lookback
    return [{ queue: 'RAW_ALIAS', calls: 10, last_seen: '2026-07-08' },
            { queue: 'A_Q_Other', calls: 20, last_seen: '2026-07-08' }];
  };
  h.ctx.inboundQueuesForDept_ = function (dept) {
    return dept === 'CSR' ? ['A_Q_CSR', 'RAW_ALIAS'] : [];
  };
  try {
    const out = h.call('discoverInboundQueues_', ['CSR', 'Sales']);
    assert.equal(out.available, true);
    const byName = {};
    out.queues.forEach(function (q) { byName[q.queue] = q; });
    assert.equal(byName['RAW_ALIAS'].mappedTo, 'CSR');
    assert.equal(byName['A_Q_Other'].mappedTo, null);
    assert.equal(out.queues[0].queue, 'A_Q_Other', 'unattributed sorts first');
  } finally {
    delete h.ctx.scanInboundQueueNames_;
    delete h.ctx.inboundQueuesForDept_;
  }
});

// ── A-3: duplicate dept rows are FIRST-active-row-wins ───────────────────────
test('A-3: getActiveDeptConfigMap_ uses the FIRST active row on a duplicate dept', function () {
  // The sheet editor upserts the FIRST matching row; the effective map used
  // to give the LAST active row precedence, so a modal save against a
  // hand-edited duplicate reported success while the stale later row stayed
  // in force.
  setConfig([
    row({ dept: 'CSR', qcd: 'A_Q_First' }),
    row({ dept: 'CSR', qcd: 'A_Q_StaleDuplicate' }),
  ]);
  assert.deepEqual(Array.from(h.call('getDeptQcdQueues_', 'CSR')), ['A_Q_First'],
    'the row the editor edits is the row that takes effect');
});

test('A-3: an INACTIVE first copy does not shadow an active later copy', function () {
  setConfig([
    row({ dept: 'CSR', qcd: 'A_Q_Old', active: false }),
    row({ dept: 'CSR', qcd: 'A_Q_Live' }),
  ]);
  assert.deepEqual(Array.from(h.call('getDeptQcdQueues_', 'CSR')), ['A_Q_Live'],
    'inactive rows never block an active one (deactivate-all still reverts to constants)');
});

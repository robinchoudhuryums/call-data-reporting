'use strict';

// DL-7 (broad-scan 2026-10-01): per-EXECUTION memos for the workbook open and
// the DO NOT EDIT! roster block. Before them an admin's cache HIT paid three-plus
// openById calls and a roster read per dept touched (the dept set, the access
// gate, the roster hash), and an Overview compute one of each PER DEPT. Pinned:
//   - one entry point opens the workbook once and reads the roster range once,
//     however many dept lookups it makes;
//   - the readers hand out FRESH objects (a caller's mutation never reaches the
//     memo);
//   - a roster WRITE in the same execution is seen by the next read
//     (appendRosterEntry_ busts it);
//   - the next entry point is a new execution (the harness boundary), so a
//     fixture swapped between calls is served, as the platform resets globals.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { rosterGrid } = require('../harness/fixtures');
const vm = require('node:vm');

const h = loadGas({ files: ['Config.gs', 'Util.gs', 'Data.gs', 'Auth.gs', 'OrphanFix.gs'] });

function install(map) {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: { 'DO NOT EDIT!': rosterGrid(map) } });
  const sheet = h.state.spreadsheet.getSheetByName('DO NOT EDIT!');
  const counts = { opens: 0, rosterReads: 0 };
  const realGetRange = sheet.getRange;
  sheet.getRange = function () { counts.rosterReads++; return realGetRange.apply(this, arguments); };
  const realOpen = h.ctx.SpreadsheetApp.openById;
  h.ctx.SpreadsheetApp.openById = function (id) { counts.opens++; return realOpen.call(this, id); };
  counts.restore = function () { h.ctx.SpreadsheetApp.openById = realOpen; };
  return counts;
}

// Entry points defined INSIDE the loaded context (they call its globals). Each
// h.call of one of them is one "execution".
vm.runInContext([
  'function lookupsInOneExecution() {',
  '  return { depts: getAllDepartments_(), sales: getRosterForDepartment_("Sales"),',
  '           pap: getRosterForDepartment_("PAP"), again: getAllDepartments_(), hash: rosterAllDeptsHash_() };',
  '}',
  'function mutateThenRead() {',
  '  var d = getAllDepartments_(); d.push("Bogus");',
  '  var r = getRosterForDepartment_("Sales"); r.names.push("Ghost"); r.byAgent.Ann.push("999");',
  '  return { depts: getAllDepartments_(), roster: getRosterForDepartment_("Sales") };',
  '}',
  'function writeThenRead() {',
  '  var before = getRosterForDepartment_("Sales").names.length;',
  '  appendRosterEntry_("Sales", "Newbie", ["105"]);',
  '  return { before: before, after: getRosterForDepartment_("Sales").names };',
  '}',
].join('\n'), h.ctx);

test('DL-7: one execution opens the workbook ONCE and reads the roster range ONCE', function () {
  const c = install({ Sales: ['Ann, 101', 'Bob, 102'], PAP: ['Cat, 201'] });
  try {
    const out = h.call('lookupsInOneExecution');
    assert.deepEqual(Array.from(out.depts), ['Sales', 'PAP']);
    assert.deepEqual(Array.from(out.sales.names), ['Ann', 'Bob']);
    assert.deepEqual(Array.from(out.pap.names), ['Cat']);
    assert.equal(c.opens, 1, 'one openById for the whole execution');
    assert.equal(c.rosterReads, 1, 'one roster range read for five lookups');
  } finally { c.restore(); }
});

test('DL-7: the readers return fresh objects -- mutating one never reaches the memo', function () {
  install({ Sales: ['Ann, 101'] });
  const out = h.call('mutateThenRead');
  assert.deepEqual(Array.from(out.depts), ['Sales']);
  assert.deepEqual(Array.from(out.roster.names), ['Ann']);
  assert.deepEqual(Array.from(out.roster.byAgent.Ann), ['101']);
});

test('DL-7: a roster write in the same execution is seen by the next read', function () {
  install({ Sales: ['Ann, 101'] });
  const out = h.call('writeThenRead');
  assert.equal(out.before, 1);
  assert.deepEqual(Array.from(out.after), ['Ann', 'Newbie'], 'appendRosterEntry_ busts the memo');
});

test('DL-7: each entry point is a fresh execution -- a fixture swapped between calls is served', function () {
  install({ Sales: ['Ann, 101'] });
  assert.deepEqual(Array.from(h.call('getRosterForDepartment_', 'Sales').names), ['Ann']);
  install({ Sales: ['Ann, 101', 'Bob, 102'] });
  assert.deepEqual(Array.from(h.call('getRosterForDepartment_', 'Sales').names), ['Ann', 'Bob']);
  // A missing sheet / unknown dept still degrade to the empty shapes.
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {} });
  assert.deepEqual(Array.from(h.call('getAllDepartments_')), []);
  assert.deepEqual(Array.from(h.call('getRosterForDepartment_', 'Sales').names), []);
  assert.equal(h.call('rosterAllDeptsHash_'), 'na');
});

// F39 (broad-scan 2026-10-14): the execution boundary resets EVERY memo, found
// by name -- not just the two workbook memos (the R40 hole: four DQE memos had
// to be reset by hand in every suite that swapped fixtures, and a fifth would
// have needed a fifth reset).
test('F39: every h.call starts a fresh execution for EVERY *MEMO* global; h.inExecution shares one', function () {
  const hm = loadGas({ files: ['Config.gs', 'Util.gs', 'Data.gs', 'NeonRead.gs', 'Alerts.gs', 'DeptConfig.gs'] });
  ['DQE_SHEET_ROWS_MEMO_', 'DQE_DATE_COL_MEMO_', 'COMPANY_HOLIDAYS_MEMO_', 'ALERT_DATE_ROWS_MEMO_',
   'DEPT_CONFIG_ROWS_MEMO_', 'NEON_CONN_DOWN_MEMO_', 'ROW_DATE_ISO_MEMO_'].forEach(function (k) {
    assert.ok(hm.memoNames.indexOf(k) !== -1, k + ' is reset at the boundary (ALERT_DATE_ROWS_MEMO_ needs `var`, not `let`)');
  });
  assert.ok(hm.memoNames.indexOf('DQE_SHEET_ROWS_MEMO_MAX_') === -1 && hm.memoNames.indexOf('ROW_DATE_ISO_MEMO_CAP_') === -1,
    'tuning constants are not memos');
  hm.ctx.getProbe_ = function () { return { holidays: hm.ctx.COMPANY_HOLIDAYS_MEMO_, rowIso: hm.ctx.ROW_DATE_ISO_MEMO_ }; };
  hm.ctx.COMPANY_HOLIDAYS_MEMO_ = ['stale'];
  hm.ctx.ROW_DATE_ISO_MEMO_ = { k: 'stale' };
  let p = hm.call('getProbe_');
  assert.equal(p.holidays, null, 'a new execution starts with the load-time value');
  assert.deepEqual(JSON.parse(JSON.stringify(p.rowIso)), {}, 'an object memo restarts EMPTY');
  hm.ctx.ROW_DATE_ISO_MEMO_.mutated = 1;
  assert.deepEqual(JSON.parse(JSON.stringify(hm.call('getProbe_').rowIso)), {}, 'and is never the same object twice');
  hm.inExecution(function () {
    hm.ctx.COMPANY_HOLIDAYS_MEMO_ = ['seeded'];
    assert.deepEqual(Array.from(hm.call('getProbe_').holidays), ['seeded'], 'calls inside one execution share the memo');
    assert.deepEqual(Array.from(hm.call('getProbe_').holidays), ['seeded']);
  });
  assert.equal(hm.call('getProbe_').holidays, null, 'the next execution is fresh again');
});

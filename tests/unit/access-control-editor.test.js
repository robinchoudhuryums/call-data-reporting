'use strict';

// C1 Access Control admin editor: the sheet-backed manager-access RPCs
// (getAccessControlInit / saveAccessControlRow / removeAccessControlRow).
// These write the Access Control SHEET (auth's always-available store, NOT
// Neon). assertAdmin_-gated; save upserts by email; remove deletes all rows
// for an email; both bust the per-email auth cache.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deepEqual } = require('node:assert');   // prototype-agnostic for cross-realm vm arrays
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

const h = loadGas({ files: ['Config.gs', 'Util.gs', 'Auth.gs'] });

const ROSTER_HEADERS = (function () {
  // DO NOT EDIT!: dept headers start at ROSTER.DEPT_FIRST_COL (col 6 = idx 5).
  const row = new Array(5).fill('');
  return row.concat(['CSR', 'Sales', 'Power']);   // 3 depts in the right block
})();

function install(acRows) {
  h.state.userEmail = 'admin@x.com';
  h.state.props.ADMIN_EMAILS = 'admin@x.com';
  h.state.props.SPREADSHEET_ID = 'fake';
  const acGrid = [['Email', 'Department', 'Notes']].concat(acRows || []);
  h.state.spreadsheet = makeFakeSpreadsheet({
    sheets: { 'DO NOT EDIT!': [ROSTER_HEADERS], 'Access Control': acGrid },
  });
  if (h.state.cache && h.state.cache.clear) h.state.cache.clear();
}

function acSheetRows() {
  // Read the Access Control sheet back as [email, dept, notes] data rows.
  return h.state.spreadsheet.getSheetByName('Access Control')._data.slice(1);
}

test('acIsValidEmail_ accepts normal addresses, rejects junk', function () {
  install([]);
  assert.equal(h.call('acIsValidEmail_', 'a@b.com'), true);
  assert.equal(h.call('acIsValidEmail_', 'name@universalmedsupply.com'), true);
  assert.equal(h.call('acIsValidEmail_', 'nope'), false);
  assert.equal(h.call('acIsValidEmail_', 'a@b'), false);
  assert.equal(h.call('acIsValidEmail_', ''), false);
});

test('getAccessControlInit returns rows + departments (admin-only)', function () {
  install([['m@x.com', 'CSR', 'note']]);
  const init = h.call('getAccessControlInit');
  assert.equal(init.rows.length, 1);
  assert.equal(init.rows[0].email, 'm@x.com');
  assert.equal(init.rows[0].department, 'CSR');
  deepEqual(JSON.parse(JSON.stringify(init.departments)), ['CSR', 'Sales', 'Power']);
});

test('saveAccessControlRow appends a new manager', function () {
  install([]);
  h.call('saveAccessControlRow', { email: 'New@X.com', department: 'Sales', notes: 'hi' });
  const rows = acSheetRows();
  assert.equal(rows.length, 1);
  deepEqual(JSON.parse(JSON.stringify(rows[0])), ['New@X.com', 'Sales', 'hi']);
});

test('saveAccessControlRow upserts by email (case-insensitive), no duplicate row', function () {
  install([['m@x.com', 'CSR', 'old']]);
  h.call('saveAccessControlRow', { email: 'M@X.com', department: 'Power', notes: 'new' });
  const rows = acSheetRows();
  assert.equal(rows.length, 1, 'same email updates in place, not appended');
  assert.equal(rows[0][1], 'Power');
  assert.equal(rows[0][2], 'new');
});

test('saveAccessControlRow rejects a bad email or unknown dept', function () {
  install([]);
  assert.throws(function () { h.call('saveAccessControlRow', { email: 'nope', department: 'CSR' }); }, /valid email/);
  assert.throws(function () { h.call('saveAccessControlRow', { email: 'a@b.com', department: 'Nope' }); }, /not a department/);
  assert.equal(acSheetRows().length, 0, 'nothing written on a validation failure');
});

test('removeAccessControlRow deletes all rows for an email', function () {
  install([['m@x.com', 'CSR', ''], ['other@x.com', 'Sales', ''], ['m@x.com', 'Power', '']]);
  const res = h.call('removeAccessControlRow', { email: 'M@X.com' });
  assert.equal(res.removed, 2);
  const rows = acSheetRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0][0], 'other@x.com');
});

test('editor RPCs are admin-gated', function () {
  install([]);
  h.state.userEmail = 'manager@x.com';   // not in ADMIN_EMAILS
  assert.throws(function () { h.call('getAccessControlInit'); });
  assert.throws(function () { h.call('saveAccessControlRow', { email: 'a@b.com', department: 'CSR' }); });
  assert.throws(function () { h.call('removeAccessControlRow', { email: 'a@b.com' }); });
});

// -- #1: all-departments manager role (Access Control dept = "ALL") ----------

test('isAllDeptsSentinel_: ALL / all / * are sentinels; a real dept is not', function () {
  install([]);
  assert.equal(h.call('isAllDeptsSentinel_', 'ALL'), true);
  assert.equal(h.call('isAllDeptsSentinel_', 'all'), true);
  assert.equal(h.call('isAllDeptsSentinel_', ' * '), true);
  assert.equal(h.call('isAllDeptsSentinel_', 'CSR'), false);
  assert.equal(h.call('isAllDeptsSentinel_', ''), false);
});

test('resolveUser_: dept "ALL" -> all-departments manager (allDepts, every dept)', function () {
  install([['boss@x.com', 'ALL', 'regional']]);
  const u = h.call('resolveUser_', 'BOSS@x.com');   // case-insensitive email
  assert.equal(u.role, 'manager', 'role is manager (NOT admin -- no admin surfaces)');
  assert.equal(u.allDepts, true);
  assert.equal(u.department, null);
  deepEqual(JSON.parse(JSON.stringify(u.departments)), ['CSR', 'Sales', 'Power']);
});

test('resolveUser_: a normal manager stays single-dept (allDepts false)', function () {
  install([['m@x.com', 'CSR', '']]);
  const u = h.call('resolveUser_', 'm@x.com');
  assert.equal(u.role, 'manager');
  assert.equal(u.allDepts, false);
  assert.equal(u.department, 'CSR');
  deepEqual(JSON.parse(JSON.stringify(u.departments)), ['CSR']);
});

test('assertDeptAccess_: all-dept manager reaches any dept; single-dept pinned', function () {
  install([]);
  const allMgr = { role: 'manager', department: null, allDepts: true, departments: ['CSR', 'Sales', 'Power'] };
  h.call('assertDeptAccess_', allMgr, 'Sales');   // no throw
  h.call('assertDeptAccess_', allMgr, 'Power');    // no throw
  assert.throws(function () { h.call('assertDeptAccess_', allMgr, 'Nope'); }, /Unknown department/);
  const oneMgr = { role: 'manager', department: 'CSR', allDepts: false, departments: ['CSR'] };
  h.call('assertDeptAccess_', oneMgr, 'CSR');       // no throw
  assert.throws(function () { h.call('assertDeptAccess_', oneMgr, 'Sales'); }, /Not authorized for this department/);
  assert.throws(function () { h.call('assertDeptAccess_', { role: 'none' }, 'CSR'); }, /Not authorized/);
});

test('saveAccessControlRow accepts the ALL sentinel, stored canonically as ALL', function () {
  install([]);
  h.call('saveAccessControlRow', { email: 'boss@x.com', department: 'all', notes: '' });
  assert.equal(acSheetRows()[0][1], 'ALL', 'lowercase all normalized to ALL');
  h.call('saveAccessControlRow', { email: 'boss2@x.com', department: '*', notes: '' });
  assert.equal(acSheetRows()[1][1], 'ALL', '* normalized to ALL');
});

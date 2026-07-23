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

// -- Tier C: multi-department managers + alias emails ------------------------

test('resolveUser_: multiple rows -> multi-dept manager (departments unioned)', function () {
  install([['m@x.com', 'CSR', 'note'], ['m@x.com', 'Sales', ''], ['other@x.com', 'Power', '']]);
  const u = h.call('resolveUser_', 'M@x.com');
  assert.equal(u.role, 'manager');
  assert.equal(u.allDepts, false);
  assert.equal(u.department, 'CSR', 'first assigned dept is the default');
  deepEqual(JSON.parse(JSON.stringify(u.departments)), ['CSR', 'Sales']);
});

test('resolveUser_: duplicate rows for one dept collapse to a single entry', function () {
  install([['m@x.com', 'CSR', ''], ['m@x.com', 'CSR', '']]);
  const u = h.call('resolveUser_', 'm@x.com');
  deepEqual(JSON.parse(JSON.stringify(u.departments)), ['CSR']);
});

test('assertDeptAccess_: multi-dept manager reaches any assigned dept, not others', function () {
  install([]);
  const multi = { role: 'manager', department: 'CSR', allDepts: false, departments: ['CSR', 'Sales'] };
  h.call('assertDeptAccess_', multi, 'CSR');    // no throw
  h.call('assertDeptAccess_', multi, 'Sales');  // no throw
  assert.throws(function () { h.call('assertDeptAccess_', multi, 'Power'); }, /Not authorized for this department/);
});

test('resolveUser_: alias email resolves to the canonical user access', function () {
  install([['john@x.com', 'CSR', '']]);
  h.state.props.EMAIL_ALIASES = 'john.doe@x.com = john@x.com';
  const u = h.call('resolveUser_', 'John.Doe@x.com');   // signed in via the alias
  assert.equal(u.role, 'manager');
  assert.equal(u.email, 'john@x.com', 'returns the canonical identity');
  deepEqual(JSON.parse(JSON.stringify(u.departments)), ['CSR']);
});

test('resolveUser_: alias maps to an ADMIN canonical -> admin', function () {
  install([]);
  h.state.props.ADMIN_EMAILS = 'admin@x.com';
  h.state.props.EMAIL_ALIASES = 'a.dmin@x.com=admin@x.com';
  const u = h.call('resolveUser_', 'a.dmin@x.com');
  assert.equal(u.role, 'admin');
  assert.equal(u.email, 'admin@x.com');
});

test('parseEmailAliases_: malformed tokens dropped, self-maps ignored', function () {
  install([]);
  h.state.props.EMAIL_ALIASES = 'no-equals-here, x@y.com = x@y.com, good@x.com = canon@x.com, junk = also-junk';
  const m = h.call('parseEmailAliases_');
  assert.equal(m['good@x.com'], 'canon@x.com');
  assert.equal(Object.keys(m).length, 1, 'only the one valid, non-self pair survives');
});

test('saveAccessControlRow: departments[] writes one row per dept (replace-all)', function () {
  install([['m@x.com', 'CSR', 'old']]);
  h.call('saveAccessControlRow', { email: 'M@x.com', departments: ['CSR', 'Sales'], notes: 'both' });
  const rows = acSheetRows().filter(function (r) { return String(r[0]).toLowerCase() === 'm@x.com'; });
  assert.equal(rows.length, 2, 'one row per dept');
  deepEqual(rows.map(function (r) { return r[1]; }).sort(), ['CSR', 'Sales']);
  assert.equal(rows[0][2], 'both', 'notes on each row');
});

test('saveAccessControlRow: re-save with fewer depts removes the dropped ones', function () {
  install([['m@x.com', 'CSR', ''], ['m@x.com', 'Sales', '']]);
  h.call('saveAccessControlRow', { email: 'm@x.com', departments: ['Sales'], notes: '' });
  const rows = acSheetRows().filter(function (r) { return String(r[0]).toLowerCase() === 'm@x.com'; });
  assert.equal(rows.length, 1);
  assert.equal(rows[0][1], 'Sales');
});

test('saveAccessControlRow: ALL sentinel is exclusive (mixing collapses to ALL)', function () {
  install([]);
  h.call('saveAccessControlRow', { email: 'boss@x.com', departments: ['CSR', 'ALL'], notes: '' });
  const rows = acSheetRows().filter(function (r) { return String(r[0]).toLowerCase() === 'boss@x.com'; });
  assert.equal(rows.length, 1);
  assert.equal(rows[0][1], 'ALL');
});

test('saveAccessControlRow: rejects an unknown dept in the list, writes nothing', function () {
  install([]);
  assert.throws(function () {
    h.call('saveAccessControlRow', { email: 'a@b.com', departments: ['CSR', 'Nope'] });
  }, /not a department/);
  assert.equal(acSheetRows().length, 0);
});

test('getAccessControlInit: groups rows into managers with a departments list', function () {
  install([['m@x.com', 'CSR', 'n'], ['m@x.com', 'Sales', ''], ['solo@x.com', 'Power', 'p']]);
  const init = h.call('getAccessControlInit');
  const mgr = init.managers.find(function (x) { return x.email.toLowerCase() === 'm@x.com'; });
  deepEqual(JSON.parse(JSON.stringify(mgr.departments)), ['CSR', 'Sales']);
  assert.equal(mgr.notes, 'n');
  const solo = init.managers.find(function (x) { return x.email.toLowerCase() === 'solo@x.com'; });
  deepEqual(JSON.parse(JSON.stringify(solo.departments)), ['Power']);
});

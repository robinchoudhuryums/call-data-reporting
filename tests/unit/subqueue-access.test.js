'use strict';

// Phase 0 of the sub-queue view work: a manager assigned to a PARENT department
// can now reach its sub-queues. This is the first time the Overview parent map
// affects AUTHORIZATION rather than tile layout (it was Overview-only -- INV-38),
// so the guards matter more than the happy path:
//
//   - ONE LEVEL only. A transitive walk would let one bad config cell cascade.
//   - FAIL CLOSED. A malformed edge (self-parent, unknown dept, cycle) confers
//     nothing, and an unreadable parent map leaves the assigned list unchanged.
//   - Admins / all-dept managers are untouched (they already get every dept).
//
// Read-side validation is deliberately NOT redundant with saveDeptConfig's:
// the Dept Config sheet can be hand-edited, the Neon table can be written by
// the backfill, and OVERVIEW_PARENT_OF is a code constant -- none of those go
// through the modal's checks.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deepEqual } = require('node:assert');   // prototype-agnostic across the vm realm
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

// CompanyOverview.gs holds OVERVIEW_PARENT_OF; DeptConfig.gs holds the map
// accessor + the two new helpers; Auth.gs consumes them.
const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'CompanyOverview.gs', 'DeptConfig.gs', 'Auth.gs'],
  capture: ['DEPT_CONFIG_HEADERS'],
});
const DC_HEADERS = h.consts.DEPT_CONFIG_HEADERS;

// NOTE: getOverviewParentMap_ MERGES the OVERVIEW_PARENT_OF constant over the
// sheet, and that constant ships real edges (PAP->Sales, Spanish->CSR,
// PAK->Power). These fixture depts deliberately avoid those names so each test
// controls exactly the edges under test; the constant's own edges are covered
// by the dedicated seeded-constant test at the bottom, and are filtered out
// here anyway because PAP/Spanish/PAK are not departments in this roster.
const DEPTS = ['Parent', 'Child', 'Child2', 'Grandchild', 'Other', 'Solo'];
const ROSTER_HEADERS = new Array(5).fill('').concat(DEPTS);

// `parents` is a child -> parent map written as Dept Config rows (the sheet
// override path, which is what an admin actually edits).
const REAL_PARENT_MAP = h.ctx.getOverviewParentMap_;

function install(acRows, parents) {
  h.ctx.getOverviewParentMap_ = REAL_PARENT_MAP;   // undo any per-test stub
  h.state.userEmail = 'someone@x.com';
  h.state.props.ADMIN_EMAILS = 'admin@x.com';
  h.state.props.SPREADSHEET_ID = 'fake';
  const dcRows = Object.keys(parents || {}).map(function (child) {
    const r = new Array(DC_HEADERS.length).fill('');
    r[0] = child;
    r[2] = parents[child];        // Overview Parent
    r[5] = 'TRUE';                // Active
    return r;
  });
  h.state.spreadsheet = makeFakeSpreadsheet({
    sheets: {
      'DO NOT EDIT!': [ROSTER_HEADERS],
      'Access Control': [['Email', 'Department', 'Notes']].concat(acRows || []),
      'Dept Config': [DC_HEADERS].concat(dcRows),
    },
  });
  if (h.state.cache && h.state.cache.clear) h.state.cache.clear();
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
}

// -- the happy path ----------------------------------------------------------

test('a parent manager gets the sub-queue in departments, assignment preserved', function () {
  install([['m@x.com', 'Parent', '']], { Child: 'Parent' });
  const u = h.call('resolveUser_', 'm@x.com');
  deepEqual(u.departments, ['Parent', 'Child'],
    'assigned dept first, then its children');
  deepEqual(u.assignedDepartments, ['Parent'],
    'the raw Access Control assignment stays available un-widened');
  assert.equal(u.department, 'Parent',
    'the LANDING dept is still the assigned one -- the manager opens where they always did');
  assert.equal(u.allDepts, false);
});

test('assertDeptAccess_ admits the sub-queue and still rejects an unrelated dept', function () {
  install([['m@x.com', 'Parent', '']], { Child: 'Parent' });
  const u = h.call('resolveUser_', 'm@x.com');
  h.call('assertDeptAccess_', u, 'Child');   // must not throw
  assert.throws(function () { h.call('assertDeptAccess_', u, 'Other'); },
    /Not authorized for this department/,
    'widening is limited to the manager\'s OWN sub-queues');
});

test('a dept with no children is completely unaffected', function () {
  install([['m@x.com', 'Solo', '']], { Child: 'Parent' });
  const u = h.call('resolveUser_', 'm@x.com');
  deepEqual(u.departments, ['Solo'],
    '11 of 14 depts have no children -- they must see zero behavior change');
});

test('multiple children of one parent all resolve', function () {
  install([['m@x.com', 'Parent', '']], { Child: 'Parent', Child2: 'Parent' });
  const u = h.call('resolveUser_', 'm@x.com');
  assert.equal(u.departments.length, 3);
  assert.ok(u.departments.indexOf('Child') !== -1);
  assert.ok(u.departments.indexOf('Child2') !== -1);
});

// -- the guards --------------------------------------------------------------

test('ONE LEVEL only: a grandchild is not conferred', function () {
  // Grandchild -> Child -> Parent. A Parent manager gets Child, NOT Grandchild.
  install([['m@x.com', 'Parent', '']], { Child: 'Parent', Grandchild: 'Child' });
  const u = h.call('resolveUser_', 'm@x.com');
  deepEqual(u.departments, ['Parent', 'Child'],
    'a transitive walk would let one mis-configured cell cascade into broad access');
  assert.throws(function () { h.call('assertDeptAccess_', u, 'Grandchild'); },
    /Not authorized/);
});

test('a CYCLE confers nothing', function () {
  install([['m@x.com', 'Parent', '']], { Parent: 'Child', Child: 'Parent' });
  const u = h.call('resolveUser_', 'm@x.com');
  deepEqual(u.departments, ['Parent'],
    'a 2-cycle would otherwise grant each dept\'s manager the other one');
});

test('a self-parent confers nothing', function () {
  install([['m@x.com', 'Parent', '']], { Parent: 'Parent' });
  const u = h.call('resolveUser_', 'm@x.com');
  deepEqual(u.departments, ['Parent']);
});

test('an edge naming a non-existent dept confers nothing', function () {
  // "Slaes" is a typo -- neither side may confer access.
  install([['m@x.com', 'Parent', '']], { Ghost: 'Parent', Child: 'Praent' });
  const u = h.call('resolveUser_', 'm@x.com');
  deepEqual(u.departments, ['Parent'],
    'a phantom child must not appear in the selector, and a typo\'d parent grants nothing');
});

test('an INACTIVE Dept Config row confers nothing', function () {
  install([['m@x.com', 'Parent', '']], {});
  const sheet = h.state.spreadsheet.getSheetByName('Dept Config');
  const r = new Array(DC_HEADERS.length).fill('');
  r[0] = 'Child'; r[2] = 'Parent'; r[5] = 'FALSE';
  sheet._data.push(r);
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  const u = h.call('resolveUser_', 'm@x.com');
  deepEqual(u.departments, ['Parent'],
    'pausing a row must drop its access edge, like every other Dept Config field');
});

test('FAIL CLOSED: an unreadable parent map leaves the assignment unchanged', function () {
  install([['m@x.com', 'Parent', '']], { Child: 'Parent' });
  h.ctx.getOverviewParentMap_ = function () { throw new Error('boom'); };
  const u = h.call('resolveUser_', 'm@x.com');
  deepEqual(u.departments, ['Parent'],
    'auth must never widen -- or break -- because a config read failed');
});

// -- roles that must not change ---------------------------------------------

test('admins are untouched by the expansion', function () {
  install([], { Child: 'Parent' });
  h.state.props.ADMIN_EMAILS = 'admin@x.com';
  const u = h.call('resolveUser_', 'admin@x.com');
  assert.equal(u.role, 'admin');
  deepEqual(u.departments, DEPTS, 'admins already hold every dept');
});

test('all-departments managers are untouched by the expansion', function () {
  install([['boss@x.com', 'ALL', '']], { Child: 'Parent' });
  const u = h.call('resolveUser_', 'boss@x.com');
  assert.equal(u.allDepts, true);
  deepEqual(u.departments, DEPTS);
});

test('a non-manager still resolves to role none with empty lists', function () {
  install([], { Child: 'Parent' });
  const u = h.call('resolveUser_', 'nobody@x.com');
  assert.equal(u.role, 'none');
  deepEqual(u.departments, []);
  deepEqual(u.assignedDepartments, []);
});

// -- the map builder in isolation -------------------------------------------

test('subQueueChildMap_ inverts parent->child and drops every unsafe edge', function () {
  install([], { Child: 'Parent', Child2: 'Other', Solo: 'Solo', Ghost: 'Parent' });
  const m = h.call('subQueueChildMap_');
  deepEqual(m.Parent, ['Child'], 'the phantom child "Ghost" is dropped');
  deepEqual(m.Other, ['Child2']);
  assert.equal(m.Solo, undefined, 'self-parent produces no edge');
});

test('the OVERVIEW_PARENT_OF constant seeds real edges with no sheet row', function () {
  // The map accessor merges the code constant UNDER the sheet, so an install
  // that has never opened the Dept Config modal still nests PAP under Sales --
  // which means this change confers access on day one, before any admin edit.
  h.ctx.getOverviewParentMap_ = REAL_PARENT_MAP;
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.props.ADMIN_EMAILS = 'admin@x.com';
  h.state.spreadsheet = makeFakeSpreadsheet({
    sheets: {
      'DO NOT EDIT!': [new Array(5).fill('').concat(['CSR', 'Sales', 'Power', 'PAP'])],
      'Access Control': [['Email', 'Department', 'Notes'], ['m@x.com', 'Sales', '']],
    },
  });
  if (h.state.cache && h.state.cache.clear) h.state.cache.clear();
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  const u = h.call('resolveUser_', 'm@x.com');
  deepEqual(u.departments, ['Sales', 'PAP'],
    'PAP -> Sales comes from the constant, not the sheet');
});

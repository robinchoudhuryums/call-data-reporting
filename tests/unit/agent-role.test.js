'use strict';

// Phase A of the agent role (docs/agent-role-plan.md): identity + deny wall.
// Pins: resolveUser_ agent resolution behind AGENT_ROLE_ENABLED (unset =
// denied, exactly pre-agent behavior); the fail-closed agent user shape
// (department null, departments [] -- identity only in agentDept/agentName);
// the assertDeptAccess_ / assertManagerOrAdmin_ allowlists (the finding that
// shaped Phase A: the old role-none denylist let an unrecognized role fall
// through the manager-pinning branch UNPINNED); manager-rows-win precedence;
// unknown-role rows granting nothing; the editor's agent-row validation; and
// the login-notify outcome key.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

const h = loadGas({ files: ['Config.gs', 'Util.gs', 'Auth.gs'] });

const ROSTER_GRID = (function () {
  // DO NOT EDIT!: dept headers at ROSTER.DEPT_FIRST_COL (col 6 = idx 5),
  // roster names beneath (INV-03 "Name, ext" cells).
  const head = new Array(5).fill('').concat(['CSR', 'Sales']);
  const r1 = new Array(5).fill('').concat(['Maria Lopez, 301', 'Sam Reed, 401']);
  const r2 = new Array(5).fill('').concat(['Devon Park, 302', '']);
  return [head, r1, r2];
})();

function install(acRows, props) {
  h.state.userEmail = 'admin@x.com';
  h.state.props = { ADMIN_EMAILS: 'admin@x.com', SPREADSHEET_ID: 'fake' };
  Object.keys(props || {}).forEach(function (k) { h.state.props[k] = props[k]; });
  const acGrid = [['Email', 'Department', 'Notes', 'Role', 'Agent Name']].concat(acRows || []);
  h.state.spreadsheet = makeFakeSpreadsheet({
    sheets: { 'DO NOT EDIT!': ROSTER_GRID, 'Access Control': acGrid },
  });
  if (h.state.cache && h.state.cache.clear) h.state.cache.clear();
}

const AGENT_ROW = ['agent1@x.com', 'CSR', '', 'agent', 'Maria Lopez'];

// -- resolveUser_ -------------------------------------------------------------

test('flag unset: an agent row resolves to none (Phase A ships dark)', function () {
  install([AGENT_ROW]);
  const u = h.call('resolveUser_', 'agent1@x.com');
  assert.equal(u.role, 'none');
});

test('flag on: agent resolves with the fail-closed shape (identity only in agentDept/agentName)', function () {
  install([AGENT_ROW], { AGENT_ROLE_ENABLED: 'true' });
  const u = h.call('resolveUser_', 'Agent1@X.com');
  assert.equal(u.role, 'agent');
  assert.equal(u.email, 'agent1@x.com');
  assert.equal(u.department, null, 'no pre-agent gate reads a dept off this user');
  assert.equal(u.departments.length, 0);
  assert.equal(u.allDepts, false);
  assert.equal(u.agentDept, 'CSR');
  assert.equal(u.agentName, 'Maria Lopez');
});

test('manager rows win: an email holding both manager and agent rows is a manager', function () {
  install([['both@x.com', 'Sales', '', 'manager', ''],
           ['both@x.com', 'CSR', '', 'agent', 'Maria Lopez']],
          { AGENT_ROLE_ENABLED: 'true' });
  const u = h.call('resolveUser_', 'both@x.com');
  assert.equal(u.role, 'manager');
  assert.equal(u.department, 'Sales');
});

test('blank Role reads as manager (pre-agent 3-col rows keep meaning what they meant)', function () {
  install([['m@x.com', 'CSR', 'note', '', '']], { AGENT_ROLE_ENABLED: 'true' });
  const u = h.call('resolveUser_', 'm@x.com');
  assert.equal(u.role, 'manager');
  assert.equal(u.department, 'CSR');
});

test('unknown Role value grants NOTHING (fail closed), and an agent row without a name grants nothing', function () {
  install([['weird@x.com', 'CSR', '', 'supervisor', ''],
           ['noname@x.com', 'CSR', '', 'agent', '']],
          { AGENT_ROLE_ENABLED: 'true' });
  assert.equal(h.call('resolveUser_', 'weird@x.com').role, 'none');
  assert.equal(h.call('resolveUser_', 'noname@x.com').role, 'none');
});

test('admin email with an agent row stays admin (admin check runs first)', function () {
  install([['admin@x.com', 'CSR', '', 'agent', 'Maria Lopez']], { AGENT_ROLE_ENABLED: 'true' });
  assert.equal(h.call('resolveUser_', 'admin@x.com').role, 'admin');
});

// -- the deny wall ------------------------------------------------------------

test('assertDeptAccess_ refuses the agent role -- even a crafted agent user WITH departments set', function () {
  install([]);
  const agent = { role: 'agent', department: null, departments: [], allDepts: false, agentDept: 'CSR' };
  assert.throws(function () { h.call('assertDeptAccess_', agent, 'CSR'); }, /Not authorized/);
  // The crafted shape a compromised client might send: dept fields populated.
  const crafted = { role: 'agent', department: 'CSR', departments: ['CSR'], allDepts: false };
  assert.throws(function () { h.call('assertDeptAccess_', crafted, 'CSR'); }, /Not authorized/);
  // Future-proofing: ANY unrecognized role is refused, not just 'agent'.
  assert.throws(function () { h.call('assertDeptAccess_', { role: 'viewer', departments: ['CSR'] }, 'CSR'); }, /Not authorized/);
});

test('assertDeptAccess_ still passes admins and managers exactly as before', function () {
  install([]);
  h.call('assertDeptAccess_', { role: 'manager', department: 'CSR', departments: ['CSR'], allDepts: false }, 'CSR');
  assert.throws(function () {
    h.call('assertDeptAccess_', { role: 'manager', department: 'CSR', departments: ['CSR'], allDepts: false }, 'Sales');
  }, /Not authorized for this department/);
});

test('assertManagerOrAdmin_ allowlist: admin/manager pass, agent/none/missing refused', function () {
  install([]);
  h.call('assertManagerOrAdmin_', { role: 'admin' });
  h.call('assertManagerOrAdmin_', { role: 'manager' });
  assert.throws(function () { h.call('assertManagerOrAdmin_', { role: 'agent', agentDept: 'CSR' }); }, /Not authorized/);
  assert.throws(function () { h.call('assertManagerOrAdmin_', { role: 'none' }); }, /Not authorized/);
  assert.throws(function () { h.call('assertManagerOrAdmin_', null); }, /Not authorized/);
});

// -- editor validation --------------------------------------------------------

test('saveAccessControlRow role=agent: validates single real dept + exact roster name; stores the 5-col row', function () {
  install([]);
  assert.throws(function () {
    h.call('saveAccessControlRow', { email: 'a@x.com', department: 'ALL', role: 'agent', agentName: 'Maria Lopez' });
  }, /specific department/);
  assert.throws(function () {
    h.call('saveAccessControlRow', { email: 'a@x.com', departments: ['CSR', 'Sales'], role: 'agent', agentName: 'Maria Lopez' });
  }, /exactly one department/);
  assert.throws(function () {
    h.call('saveAccessControlRow', { email: 'a@x.com', department: 'CSR', role: 'agent' });
  }, /Agent Name/);
  assert.throws(function () {
    h.call('saveAccessControlRow', { email: 'a@x.com', department: 'CSR', role: 'agent', agentName: 'maria lopez' });
  }, /not on the CSR roster/);   // INV-04: exact match, no case folding
  assert.throws(function () {
    h.call('saveAccessControlRow', { email: 'a@x.com', department: 'CSR', role: 'agent', agentName: 'Sam Reed' });
  }, /not on the CSR roster/);   // right name, wrong dept

  const res = h.call('saveAccessControlRow', { email: 'a@x.com', department: 'CSR', role: 'agent', agentName: 'Maria Lopez' });
  assert.equal(res.role, 'agent');
  const rows = h.state.spreadsheet.getSheetByName('Access Control')._data.slice(1);
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(rows[0])), ['a@x.com', 'CSR', '', 'agent', 'Maria Lopez']);
});

test('saveAccessControlRow rejects an unknown role outright', function () {
  install([]);
  assert.throws(function () {
    h.call('saveAccessControlRow', { email: 'a@x.com', department: 'CSR', role: 'supervisor' });
  }, /Role must be/);
});

test('getAccessControlInit lists agent rows separately from the grouped managers', function () {
  install([['m@x.com', 'Sales', '', 'manager', ''], AGENT_ROW], { AGENT_ROLE_ENABLED: 'true' });
  const init = h.call('getAccessControlInit');
  assert.equal(init.managers.length, 1);
  assert.equal(init.managers[0].email, 'm@x.com');
  assert.equal(init.agents.length, 1);
  assert.equal(init.agents[0].email, 'agent1@x.com');
  assert.equal(init.agents[0].agentName, 'Maria Lopez');
  assert.equal(init.agentRoleEnabled, true);
});

test('acEnsureSchema_ heals a pre-agent 3-column header row on the next editor save', function () {
  h.state.userEmail = 'admin@x.com';
  h.state.props = { ADMIN_EMAILS: 'admin@x.com', SPREADSHEET_ID: 'fake' };
  h.state.spreadsheet = makeFakeSpreadsheet({
    sheets: { 'DO NOT EDIT!': ROSTER_GRID,
              'Access Control': [['Email', 'Department', 'Notes'], ['m@x.com', 'CSR', '']] },
  });
  if (h.state.cache && h.state.cache.clear) h.state.cache.clear();
  h.call('saveAccessControlRow', { email: 'new@x.com', department: 'Sales' });
  const head = h.state.spreadsheet.getSheetByName('Access Control')._data[0];
  assert.deepEqual(JSON.parse(JSON.stringify(head.slice(0, 5))),
    ['Email', 'Department', 'Notes', 'Role', 'Agent Name']);
});

// -- login notify -------------------------------------------------------------

test('loginNotifyOutcomeKey_: agent key carries the dept, so an agent dept move notifies', function () {
  install([]);
  assert.equal(h.call('loginNotifyOutcomeKey_', { role: 'agent', agentDept: 'CSR' }), 'agent:CSR');
  assert.equal(h.call('loginNotifyOutcomeKey_', { role: 'agent' }), 'agent:?');
});

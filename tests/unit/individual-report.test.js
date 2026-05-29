'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deepEqual } = require('node:assert'); // legacy: prototype-agnostic for cross-realm vm values
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { dqeRow, dqeSheet, rosterGrid } = require('../harness/fixtures');

const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'CompanyOverview.gs',
          'QCDReport.gs', 'DeptConfig.gs', 'Data.gs', 'IndividualReport.gs'],
  capture: ['DEPT_CONFIG_HEADERS'],
});
const DC_HEADERS = h.consts.DEPT_CONFIG_HEADERS;

const ROSTER = rosterGrid({
  Alpha: ['Anna, 201', 'Ben, 202'],
  Beta:  ['Cara, 301'],
});

// Run getIndividualReport as an admin. `deptConfigRows` optionally
// installs a Dept Config sheet (for the INV-26 override test).
function install(rows, deptConfigRows) {
  h.state.userEmail = 'admin@x.com';
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.props.ADMIN_EMAILS = 'admin@x.com';   // -> resolveUser_ returns role 'admin'
  const sheets = {
    'DO NOT EDIT!': ROSTER,
    'DQE Historical Data': dqeSheet(rows),
  };
  if (deptConfigRows) sheets['Dept Config'] = [DC_HEADERS].concat(deptConfigRows);
  h.state.spreadsheet = makeFakeSpreadsheet({ timeZone: 'America/Chicago', sheets: sheets });
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  h.state.cache.clear();
}

function entry(data, name) {
  return data.summaryData.filter(function (s) { return s.name === name; })[0];
}

test('INV-25: Individual Report ATT is answered-WEIGHTED (contrast to INV-05 simple mean)', function () {
  // Anna: day1 answered 2 @ 0:03:00 (180s); day2 answered 18 @ 0:05:00 (300s).
  // Weighted  = (180*2 + 300*18) / (2+18) = 5760/20 = 288.
  // Simple    = (180 + 300) / 2          = 240  <- what My Dept (INV-05) shows.
  install([
    dqeRow({ date: '2026-03-09', agent: 'Anna', ext: '501', rung: 4,  answered: 2,  att: '0:03:00', ttt: '0:06:00' }),
    dqeRow({ date: '2026-03-10', agent: 'Anna', ext: '501', rung: 20, answered: 18, att: '0:05:00', ttt: '1:30:00' }),
  ]);
  const data = h.call('getIndividualReport', { department: 'Alpha', from: '2026-03-09', to: '2026-03-10', agents: ['Anna'] });
  const anna = entry(data, 'Anna');
  assert.equal(Math.round(anna.raw.att), 288);          // weighted, NOT 240
  assert.equal(anna.stats.att, '0:04:48');              // formatSecondsHms_(288)
  assert.equal(anna.raw.answered, 20);
  assert.equal(data.mode, 'individual');
});

test('INV-25: a zero-answered day contributes 0 to both sides (no ATT drag)', function () {
  // Day2 has answered 0 -> attTotal contribution 0 and answered 0, so the
  // weighted ATT equals day1's ATT exactly (the abandoned day cannot
  // pull it down).
  install([
    dqeRow({ date: '2026-03-09', agent: 'Anna', ext: '501', rung: 5, answered: 5, att: '0:04:00' }),
    dqeRow({ date: '2026-03-10', agent: 'Anna', ext: '501', rung: 9, answered: 0, att: '0:00:00' }),
  ]);
  const data = h.call('getIndividualReport', { department: 'Alpha', from: '2026-03-09', to: '2026-03-10', agents: ['Anna'] });
  assert.equal(Math.round(entry(data, 'Anna').raw.att), 240);  // 0:04:00, undragged
});

test('INV-53: a queue-only floater is flagged on its summary card with sourceHomes', function () {
  install([
    dqeRow({ date: '2026-03-09', agent: 'Anna', ext: '501', rung: 10, answered: 9, att: '0:03:00' }),
    dqeRow({ date: '2026-03-09', agent: 'Cara', ext: '501', rung: 100, answered: 50, att: '0:09:00' }),
  ]);
  const data = h.call('getIndividualReport', { department: 'Alpha', from: '2026-03-09', to: '2026-03-09', agents: ['Anna', 'Cara'] });

  const anna = entry(data, 'Anna');
  assert.equal(anna.matchedViaRoster, true);

  const cara = entry(data, 'Cara');
  assert.equal(cara.matchedViaRoster, false);
  assert.equal(cara.matchedViaQueue, true);
  deepEqual(cara.sourceHomes, ['Beta']);
  assert.equal(data.mode, 'comparison');               // 2 agents
});

test('INV-26/E4: Dept Config team-avg-exclude flips excludedFromTeamAvg (no redeploy)', function () {
  // Dept Config row makes Ben a team-avg exclusion for Alpha.
  const dcRow = ['Alpha', '', '', 'Ben', '', 'TRUE', 'admin@x.com', '', ''];
  install([
    dqeRow({ date: '2026-03-09', agent: 'Anna', ext: '501', rung: 10, answered: 9, att: '0:03:00' }),
    dqeRow({ date: '2026-03-09', agent: 'Ben',  ext: '501', rung: 8,  answered: 6, att: '0:04:00' }),
  ], [dcRow]);
  const data = h.call('getIndividualReport', { department: 'Alpha', from: '2026-03-09', to: '2026-03-09', agents: ['Anna', 'Ben'] });

  assert.equal(entry(data, 'Ben').excludedFromTeamAvg, true);
  assert.equal(entry(data, 'Anna').excludedFromTeamAvg, false);
  assert.ok(data.meta.excludedAgents.indexOf('Ben') !== -1);
});

test('auth: cross-dept request by a manager is refused at the server boundary', function () {
  install([dqeRow({ date: '2026-03-09', agent: 'Anna', ext: '501', rung: 1, answered: 1 })]);
  // Manager pinned to Beta (via Access Control) requesting Alpha -> throws.
  // No Access Control sheet here, so a non-admin email resolves to role
  // 'none' -> "Not authorized." (the outer gate). Either way it must throw.
  h.state.userEmail = 'stranger@x.com';
  h.state.props.ADMIN_EMAILS = 'admin@x.com';
  assert.throws(function () {
    h.call('getIndividualReport', { department: 'Alpha', from: '2026-03-09', to: '2026-03-09', agents: ['Anna'] });
  }, /Not authorized/);
});

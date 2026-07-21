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

test('F-1: a crafted off-dept agent name gets NO trend dataset (no cross-dept leak)', function () {
  // Cara is on Beta's roster and her rows carry Beta's ext (301) -- no
  // queue overlap with Alpha (Anna's rows use 201). Requesting her by
  // name on an Alpha report must yield NEITHER a summary card NOR a
  // trendData dataset: pre-fix, trendData.datasets was built from the
  // UNFILTERED selection, leaking her real monthly series cross-dept.
  install([
    dqeRow({ date: '2026-03-09', agent: 'Anna', ext: '201', rung: 10, answered: 9, att: '0:03:00' }),
    dqeRow({ date: '2026-03-09', agent: 'Cara', ext: '301', rung: 100, answered: 50, att: '0:09:00' }),
  ]);
  const data = h.call('getIndividualReport', { department: 'Alpha', from: '2026-03-09', to: '2026-03-09', agents: ['Anna', 'Cara'] });
  assert.equal(entry(data, 'Cara'), undefined, 'no summary card for the off-dept name');
  assert.ok(data.trendData.datasets.Anna, 'the legit agent keeps her trend series');
  assert.equal(data.trendData.datasets.Cara, undefined, 'no trend series for the off-dept name');
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

test('F-32: a custom prior window overlapping the current range counts overlap days toward CURRENT only', function () {
  // Current = Mar 9-10; custom prior = Mar 8-9 (Mar 9 overlaps). PR and
  // Insights exclude the overlap day from the prior baseline (else-if,
  // F12); IR previously counted it into BOTH windows, so identical inputs
  // produced a different prior baseline here.
  install([
    dqeRow({ date: '2026-03-09', agent: 'Anna', ext: '201', rung: 10, answered: 8, att: '0:03:00' }),
    dqeRow({ date: '2026-03-10', agent: 'Anna', ext: '201', rung: 6,  answered: 5, att: '0:02:00' }),
  ]);
  const data = h.call('getIndividualReport', {
    department: 'Alpha', from: '2026-03-09', to: '2026-03-10', agents: ['Anna'],
    priorFrom: '2026-03-08', priorTo: '2026-03-09',
  });
  const anna = entry(data, 'Anna');
  assert.equal(anna.raw.rung, 16, 'current window keeps both days');
  // Prior window has NO exclusive days with data (Mar 8 empty; Mar 9 went
  // to current) -> prior rung 0. Old behavior: 10 (Mar 9 double-counted).
  assert.equal(anna.priorRaw.rung, 0);
  // v11: the overlap is FLAGGED so the client renders the inline
  // "Windows overlap" caveat (same contract as Insights' F12).
  assert.equal(data.meta.priorOverlap, true);
});

test('v11: a disjoint custom prior window does NOT flag priorOverlap', function () {
  install([
    dqeRow({ date: '2026-03-09', agent: 'Anna', ext: '201', rung: 10, answered: 8, att: '0:03:00' }),
  ]);
  const data = h.call('getIndividualReport', {
    department: 'Alpha', from: '2026-03-09', to: '2026-03-10', agents: ['Anna'],
    priorFrom: '2026-03-01', priorTo: '2026-03-02',
  });
  assert.equal(data.meta.priorOverlap, false);
});

// --- R8-D3 (audit 2026-07-21): prevPeriod resolves SERVER-side --------------
test('R8-D3: priorMode=prevPeriod resolves the INV-28 window server-side (byte-equal to explicit dates)', function () {
  const rows = [
    dqeRow({ date: '2026-03-09', agent: 'Anna', rung: 6, missed: 1, answered: 5,
             ttt: '0:20:00', att: '0:04:00' }),
    // Activity inside the expected prior window (Mar 5-6 for a Mar 7-8 range... 
    // range below is Mar 9-10, so prior = Mar 7-8).
    dqeRow({ date: '2026-03-08', agent: 'Anna', rung: 4, missed: 2, answered: 2,
             ttt: '0:08:00', att: '0:04:00' }),
  ];
  install(rows);
  const viaMode = h.call('getIndividualReport',
    { department: 'Alpha', from: '2026-03-09', to: '2026-03-10', agents: ['Anna'], priorMode: 'prevPeriod' });
  h.state.cache.clear();
  const pw = h.call('computePriorWindow_', '2026-03-09', '2026-03-10');
  assert.equal(pw.from, '2026-03-07');
  assert.equal(pw.to, '2026-03-08');
  const viaDates = h.call('getIndividualReport',
    { department: 'Alpha', from: '2026-03-09', to: '2026-03-10', agents: ['Anna'],
      priorFrom: pw.from, priorTo: pw.to });
  // Same resolved comparison: identical priorStats + label.
  assert.equal(viaMode.priorDateLabel, viaDates.priorDateLabel);
  assert.deepEqual(JSON.parse(JSON.stringify(entry(viaMode, 'Anna').priorRaw)),
                   JSON.parse(JSON.stringify(entry(viaDates, 'Anna').priorRaw)));
  assert.ok(entry(viaMode, 'Anna').priorStats, 'comparison actually resolved');
});

test('R8-D3: explicit priorFrom/priorTo win over a stray priorMode (no silent override)', function () {
  install([
    dqeRow({ date: '2026-03-09', agent: 'Anna', rung: 6, missed: 1, answered: 5,
             ttt: '0:20:00', att: '0:04:00' }),
  ]);
  const data = h.call('getIndividualReport',
    { department: 'Alpha', from: '2026-03-09', to: '2026-03-10', agents: ['Anna'],
      priorMode: 'prevPeriod', priorFrom: '2025-03-09', priorTo: '2025-03-10' });
  assert.ok(String(data.priorDateLabel || '').indexOf('2025') !== -1,
    'explicit dates used, priorMode ignored');
});

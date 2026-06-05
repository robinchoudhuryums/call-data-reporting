'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deepEqual } = require('node:assert'); // legacy: prototype-agnostic for cross-realm vm values
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { dqeRow, dqeSheet, rosterGrid } = require('../harness/fixtures');

// InsightsReport reuses deltaBlock_ (PerformanceReport) + buildTeamInsights_
// (Util) + the Data.gs aggregation primitives -- all loaded into the shared
// vm global scope, mirroring Apps Script's flat scope.
const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'CompanyOverview.gs',
          'QCDReport.gs', 'DeptConfig.gs', 'Data.gs', 'PerformanceReport.gs',
          'InsightsReport.gs'],
});

const ROSTER = rosterGrid({
  Alpha: ['Anna, 201', 'Ben, 202'],
  Beta:  ['Cara, 301'],
});

function install(rows) {
  h.state.userEmail = 'admin@x.com';
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.props.ADMIN_EMAILS = 'admin@x.com';
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: { 'DO NOT EDIT!': ROSTER, 'DQE Historical Data': dqeSheet(rows) },
  });
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  h.state.cache.clear();
}

function agent(data, name) {
  return data.agentData.filter(function (a) { return a.name === name; })[0];
}

test('Insights: prior window + team rollup + per-agent current-vs-prior deltas', function () {
  // Selected 2026-03-09..2026-03-15 (7 days) -> prior 2026-03-02..2026-03-08.
  install([
    dqeRow({ date: '2026-03-10', agent: 'Anna', ext: '501', rung: 10, missed: 1, answered: 8, att: '0:03:00' }), // current
    dqeRow({ date: '2026-03-05', agent: 'Anna', ext: '501', rung: 4,  missed: 2, answered: 3, att: '0:04:00' }), // prior
  ]);
  const data = h.call('getInsightsReport', { department: 'Alpha', from: '2026-03-09', to: '2026-03-15', agents: ['Anna'] });

  // Mode + auto-adjacent prior window (INV-28).
  assert.equal(data.meta.comparisonMode, 'prior');
  assert.equal(data.meta.priorFrom, '2026-03-02');
  assert.equal(data.meta.priorTo, '2026-03-08');

  // Team rollup carries current (val) + prior (prev) + delta.
  assert.equal(data.teamStats.rung.val, 10);
  assert.equal(data.teamStats.rung.prev, 4);
  assert.equal(data.teamStats.rung.delta, 6);
  assert.equal(data.teamStats.answered.val, 8);
  assert.equal(data.teamStats.answered.prev, 3);

  // The novel bit: each per-agent card has its OWN current-vs-prior deltas.
  const anna = agent(data, 'Anna');
  assert.equal(anna.matchedViaRoster, true);
  assert.equal(anna.metrics.rung.val, 10);
  assert.equal(anna.metrics.rung.prev, 4);
  assert.equal(anna.metrics.answered.val, 8);
  assert.equal(anna.metrics.answered.prev, 3);
  // Weighted ATT (INV-25): current single day 0:03:00, prior 0:04:00.
  assert.equal(anna.metrics.att.formatted, '0:03:00');
  assert.equal(anna.metrics.att.prev, 240);
});

test('Insights INV-53: floater appears as a card but is excluded from the team rollup', function () {
  install([
    dqeRow({ date: '2026-03-10', agent: 'Anna', ext: '501', rung: 10,  missed: 1, answered: 8,  att: '0:03:00' }),
    dqeRow({ date: '2026-03-10', agent: 'Cara', ext: '501', rung: 100, missed: 5, answered: 50, att: '0:09:00' }), // Beta floater into Alpha
  ]);
  const data = h.call('getInsightsReport', { department: 'Alpha', from: '2026-03-09', to: '2026-03-15', agents: ['Anna', 'Cara'] });

  // Team current totals exclude Cara's 100/50 (floater-exclusion contract).
  assert.equal(data.teamStats.rung.val, 10);
  assert.equal(data.teamStats.answered.val, 8);
  assert.equal(data.meta.rosterAgentCount, 1);
  assert.equal(data.meta.queueOnlyAgentCount, 1);

  // Cara still gets a card, tagged as a queue-only floater with her home dept,
  // showing her OWN numbers.
  const cara = agent(data, 'Cara');
  assert.equal(cara.matchedViaRoster, false);
  assert.equal(cara.matchedViaQueue, true);
  deepEqual(cara.sourceHomes, ['Beta']);
  assert.equal(cara.metrics.rung.val, 100);
  assert.equal(cara.metrics.answered.val, 50);
});

test('Insights: cross-dept request is rejected for a manager', function () {
  install([dqeRow({ date: '2026-03-10', agent: 'Anna', ext: '501', rung: 5, answered: 4 })]);
  // A non-admin with no Access Control row resolves to role 'none'.
  h.state.userEmail = 'stranger@x.com';
  assert.throws(function () {
    h.call('getInsightsReport', { department: 'Alpha', from: '2026-03-09', to: '2026-03-15', agents: ['Anna'] });
  }, /Not authorized/);
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deepEqual } = require('node:assert'); // legacy: prototype-agnostic for cross-realm vm values
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { dqeRow, dqeSheet, rosterGrid } = require('../harness/fixtures');

const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'CompanyOverview.gs',
          'QCDReport.gs', 'DeptConfig.gs', 'Data.gs', 'PerformanceReport.gs'],
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

test('INV-28: auto prior period = immediately-preceding same-length window', function () {
  // Selected 2026-03-09..2026-03-15 (7 days) -> prior 2026-03-02..2026-03-08.
  install([
    dqeRow({ date: '2026-03-10', agent: 'Anna', ext: '501', rung: 10, missed: 1, answered: 8, att: '0:03:00' }), // current
    dqeRow({ date: '2026-03-05', agent: 'Anna', ext: '501', rung: 4,  missed: 2, answered: 3, att: '0:04:00' }), // prior
  ]);
  const data = h.call('getPerformanceReport', { department: 'Alpha', from: '2026-03-09', to: '2026-03-15', agents: ['Anna'] });

  assert.equal(data.meta.priorFrom, '2026-03-02');
  assert.equal(data.meta.priorTo, '2026-03-08');
  assert.equal(data.meta.priorIsCustom, false);

  // Team current-vs-prior deltas (INV-28). teamStats.<metric> =
  // { val: current, prev: prior, delta }.
  assert.equal(data.teamStats.rung.val, 10);
  assert.equal(data.teamStats.rung.prev, 4);
  assert.equal(data.teamStats.rung.delta, 6);
  assert.equal(data.teamStats.answered.val, 8);
  assert.equal(data.teamStats.answered.prev, 3);
});

test('INV-28: a custom prior range overrides the auto window (priorIsCustom)', function () {
  install([
    dqeRow({ date: '2026-03-10', agent: 'Anna', ext: '501', rung: 10, answered: 8 }),
    dqeRow({ date: '2026-01-03', agent: 'Anna', ext: '501', rung: 5,  answered: 4 }), // in custom prior
  ]);
  const data = h.call('getPerformanceReport', {
    department: 'Alpha', from: '2026-03-09', to: '2026-03-15',
    priorFrom: '2026-01-01', priorTo: '2026-01-07', agents: ['Anna'],
  });
  assert.equal(data.meta.priorFrom, '2026-01-01');
  assert.equal(data.meta.priorTo, '2026-01-07');
  assert.equal(data.meta.priorIsCustom, true);
  assert.equal(data.teamStats.rung.val, 10);   // current
  assert.equal(data.teamStats.rung.prev, 5);   // custom-prior row
});

test('INV-53: floater is in agentData but excluded from team totals', function () {
  install([
    dqeRow({ date: '2026-03-10', agent: 'Anna', ext: '501', rung: 10, answered: 8, att: '0:03:00' }),
    dqeRow({ date: '2026-03-10', agent: 'Cara', ext: '501', rung: 100, answered: 50, att: '0:09:00' }), // floater
  ]);
  const data = h.call('getPerformanceReport', { department: 'Alpha', from: '2026-03-09', to: '2026-03-15', agents: ['Anna', 'Cara'] });

  // Team current totals exclude Cara's 100/50.
  assert.equal(data.teamStats.rung.val, 10);
  assert.equal(data.teamStats.answered.val, 8);

  const cara = agent(data, 'Cara');
  assert.equal(cara.matchedViaRoster, false);
  assert.equal(cara.matchedViaQueue, true);
  deepEqual(cara.sourceHomes, ['Beta']);
  assert.equal(agent(data, 'Anna').matchedViaRoster, true);
});

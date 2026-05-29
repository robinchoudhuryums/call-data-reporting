'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deepEqual } = require('node:assert'); // legacy: prototype-agnostic for cross-realm vm values
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { dqeRow, dqeSheet, rosterGrid } = require('../harness/fixtures');

const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'CompanyOverview.gs',
          'QCDReport.gs', 'DeptConfig.gs', 'Data.gs', 'CompareRangesReport.gs'],
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

const ANNA = function (date, o) {
  return dqeRow(Object.assign({ date: date, agent: 'Anna', ext: '501' }, o));
};

test('INV-35: lengthMismatch true when the longer period is >= 1.2x the shorter', function () {
  install([ANNA('2026-03-03', { rung: 5, answered: 4 })]);
  const data = h.call('getCompareRanges', {
    department: 'Alpha',
    p1From: '2026-03-01', p1To: '2026-03-07',     // 7 days
    p2From: '2026-03-01', p2To: '2026-03-30',     // 30 days
    agents: ['Anna'],
  });
  assert.equal(data.meta.p1Days, 7);
  assert.equal(data.meta.p2Days, 30);
  assert.equal(data.meta.lengthMismatch, true);
});

test('INV-35: equal-length periods are not flagged', function () {
  install([ANNA('2026-03-03', { rung: 5, answered: 4 })]);
  const data = h.call('getCompareRanges', {
    department: 'Alpha',
    p1From: '2026-03-01', p1To: '2026-03-07',     // 7 days
    p2From: '2026-04-01', p2To: '2026-04-07',     // 7 days
    agents: ['Anna'],
  });
  assert.equal(data.meta.lengthMismatch, false);
});

test('INV-35: the 1.2x boundary is inclusive (1.2 flags, 1.1 does not)', function () {
  install([ANNA('2026-03-03', { rung: 5, answered: 4 })]);

  const at12 = h.call('getCompareRanges', {
    department: 'Alpha',
    p1From: '2026-03-01', p1To: '2026-03-10',     // 10 days
    p2From: '2026-04-01', p2To: '2026-04-12',     // 12 days -> 1.2x exactly
    agents: ['Anna'],
  });
  assert.equal(at12.meta.lengthMismatch, true);

  const at11 = h.call('getCompareRanges', {
    department: 'Alpha',
    p1From: '2026-03-01', p1To: '2026-03-10',     // 10 days
    p2From: '2026-04-01', p2To: '2026-04-11',     // 11 days -> 1.1x
    agents: ['Anna'],
  });
  assert.equal(at11.meta.lengthMismatch, false);
});

test('per-agent P1/P2 split + INV-53 floater excluded from team totals', function () {
  install([
    ANNA('2026-03-03', { rung: 5, answered: 4, att: '0:03:00' }),   // P1
    ANNA('2026-04-03', { rung: 9, answered: 7, att: '0:03:00' }),   // P2
    // Cara floater, only in P2.
    dqeRow({ date: '2026-04-03', agent: 'Cara', ext: '501', rung: 100, answered: 80, att: '0:09:00' }),
  ]);
  const data = h.call('getCompareRanges', {
    department: 'Alpha',
    p1From: '2026-03-01', p1To: '2026-03-07',
    p2From: '2026-04-01', p2To: '2026-04-07',
    agents: ['Anna', 'Cara'],
  });

  const anna = agent(data, 'Anna');
  assert.equal(anna.p1.raw.rung, 5);
  assert.equal(anna.p2.raw.rung, 9);
  assert.equal(anna.matchedViaRoster, true);

  const cara = agent(data, 'Cara');
  assert.equal(cara.matchedViaRoster, false);
  assert.equal(cara.matchedViaQueue, true);
  deepEqual(cara.sourceHomes, ['Beta']);

  // Team totals exclude Cara: P2 (val) = Anna's 9, P1 (prev) = Anna's 5.
  assert.equal(data.teamStats.rung.val, 9);
  assert.equal(data.teamStats.rung.prev, 5);
});

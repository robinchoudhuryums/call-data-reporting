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

test('Insights parity: teamStats + trendData match the Performance Report on identical inputs', function () {
  // THE consolidation gate: Insights bills itself as PR's department
  // rollup + per-agent deltas. Both load into this vm and share
  // deltaBlock_ / the INV-28 prior window / INV-25 weighted ATT /
  // INV-53 roster gating -- so on the same fixture, the same request
  // must produce identical team tiles, prior window, and 12-mo trend.
  // If this ever breaks, the two reports have silently diverged and
  // PR cannot be retired in favor of Insights.
  install([
    dqeRow({ date: '2026-03-10', agent: 'Anna', ext: '501', rung: 10, missed: 1, answered: 8, att: '0:03:00', ttt: '0:24:00' }),
    dqeRow({ date: '2026-03-11', agent: 'Ben',  ext: '501', rung: 6,  missed: 2, answered: 4, att: '0:02:00', ttt: '0:08:00' }),
    dqeRow({ date: '2026-03-05', agent: 'Anna', ext: '501', rung: 4,  missed: 2, answered: 3, att: '0:04:00', ttt: '0:12:00' }), // prior window
    dqeRow({ date: '2025-11-12', agent: 'Anna', ext: '501', rung: 20, missed: 4, answered: 15, att: '0:05:00', ttt: '1:15:00' }), // trend-only month
    dqeRow({ date: '2026-03-10', agent: 'Cara', ext: '501', rung: 50, missed: 9, answered: 30, att: '0:09:00' }), // Beta floater
  ]);
  const req = { department: 'Alpha', from: '2026-03-09', to: '2026-03-15', agents: ['Anna', 'Ben', 'Cara'] };
  const pr  = h.call('getPerformanceReport', req);
  h.state.cache.clear();   // separate prefixes anyway; cleared for hygiene
  const ins = h.call('getInsightsReport', req);

  // Same auto-adjacent prior window (INV-28).
  assert.equal(ins.meta.priorFrom, pr.meta.priorFrom);
  assert.equal(ins.meta.priorTo,   pr.meta.priorTo);

  // Team tiles identical across all six metrics + every delta field.
  ['rung', 'missed', 'answered', 'pct', 'ttt', 'att'].forEach(function (k) {
    ['val', 'prev', 'delta', 'deltaPct', 'formatted', 'type'].forEach(function (f) {
      deepEqual(ins.teamStats[k][f], pr.teamStats[k][f],
        'teamStats.' + k + '.' + f + ' diverged between Insights and PR');
    });
  });

  // Same trend window + identical monthly rollup series.
  assert.equal(ins.meta.trendStart, pr.meta.trendStart);
  assert.equal(ins.meta.trendEnd,   pr.meta.trendEnd);
  deepEqual(ins.trendData.labels, pr.trendData.labels);
  deepEqual(ins.trendData.series, pr.trendData.series);

  // Same prior label rendering.
  assert.equal(ins.priorDateLabel, pr.priorDateLabel);
});

test('Insights: explicit priorFrom/priorTo overrides the auto-adjacent window', function () {
  install([
    dqeRow({ date: '2026-03-10', agent: 'Anna', ext: '501', rung: 10, missed: 1, answered: 8, att: '0:03:00' }), // current
    dqeRow({ date: '2026-03-05', agent: 'Anna', ext: '501', rung: 4,  missed: 2, answered: 3, att: '0:04:00' }), // auto-adjacent window
    dqeRow({ date: '2025-03-12', agent: 'Anna', ext: '501', rung: 7,  missed: 3, answered: 5, att: '0:06:00' }), // YoY window
  ]);
  const data = h.call('getInsightsReport', {
    department: 'Alpha', from: '2026-03-09', to: '2026-03-15', agents: ['Anna'],
    priorFrom: '2025-03-09', priorTo: '2025-03-15',
  });
  assert.equal(data.meta.comparisonMode, 'custom');
  assert.equal(data.meta.priorFrom, '2025-03-09');
  assert.equal(data.meta.priorTo,   '2025-03-15');
  // prev comes from the YoY window's row (7 rung), NOT the adjacent one (4).
  assert.equal(data.teamStats.rung.val, 10);
  assert.equal(data.teamStats.rung.prev, 7);
  const anna = agent(data, 'Anna');
  assert.equal(anna.metrics.answered.prev, 5);
  // Same-length windows (7d vs 7d) -> no INV-35 mismatch.
  assert.equal(data.meta.currentDays, 7);
  assert.equal(data.meta.priorDays, 7);
  assert.equal(data.meta.lengthMismatch, false);

  // A custom prior of a different length (>= 1.2x) flips the INV-35 flag.
  h.state.cache.clear();
  const mismatched = h.call('getInsightsReport', {
    department: 'Alpha', from: '2026-03-09', to: '2026-03-15', agents: ['Anna'],
    priorFrom: '2025-03-01', priorTo: '2025-03-28',   // 28 days vs 7
  });
  assert.equal(mismatched.meta.currentDays, 7);
  assert.equal(mismatched.meta.priorDays, 28);
  assert.equal(mismatched.meta.lengthMismatch, true);

  // Half-supplied prior windows are rejected.
  h.state.cache.clear();
  assert.throws(function () {
    h.call('getInsightsReport', {
      department: 'Alpha', from: '2026-03-09', to: '2026-03-15', agents: ['Anna'],
      priorFrom: '2025-03-09',
    });
  }, /priorFrom\/priorTo/);
});

test('Insights trendData: monthly team rollup excludes floaters (INV-53)', function () {
  install([
    dqeRow({ date: '2026-03-10', agent: 'Anna', ext: '501', rung: 10, missed: 1, answered: 8,  att: '0:03:00' }),
    dqeRow({ date: '2025-12-09', agent: 'Anna', ext: '501', rung: 6,  missed: 1, answered: 5,  att: '0:02:00' }), // earlier trend month
    dqeRow({ date: '2026-03-10', agent: 'Cara', ext: '501', rung: 100, missed: 5, answered: 50, att: '0:09:00' }), // floater
  ]);
  const data = h.call('getInsightsReport', { department: 'Alpha', from: '2026-03-09', to: '2026-03-15', agents: ['Anna', 'Cara'] });

  // 13 monthly buckets: first-of-month(2026-03-15 minus 12 mo) = 2025-03 .. 2026-03.
  // Assert by SERIES INDEX (parallel to the generateMonthList_ month keys),
  // not by label text: the harness host's local TZ differs from the script
  // TZ, which shifts the *label* formatting by a month (a harness artifact
  // only -- Apps Script's process TZ is the manifest TZ, so production
  // labels are correct). Index 9 = '2025-12'; index 12 = '2026-03'.
  assert.equal(data.trendData.labels.length, 13);
  assert.equal(data.trendData.series.length, 13);
  // Dec '25 bucket carries Anna's earlier-month row.
  assert.equal(data.trendData.series[9].answered, 5);
  // Mar '26 bucket carries Anna's 8 answered but NOT floater Cara's 50.
  assert.equal(data.trendData.series[12].answered, 8);
  assert.equal(data.trendData.series[12].rung, 10);
});

test('Insights: cross-dept request is rejected for a manager', function () {
  install([dqeRow({ date: '2026-03-10', agent: 'Anna', ext: '501', rung: 5, answered: 4 })]);
  // A non-admin with no Access Control row resolves to role 'none'.
  h.state.userEmail = 'stranger@x.com';
  assert.throws(function () {
    h.call('getInsightsReport', { department: 'Alpha', from: '2026-03-09', to: '2026-03-15', agents: ['Anna'] });
  }, /Not authorized/);
});

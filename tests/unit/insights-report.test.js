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
          'InsightsReport.gs',
          // Digest.gs provides renderInsightsEmailBody_ (+ digestTakeaway_/
          // digestDeltaHtml_) that sendInsightsReportEmail reuses for the
          // server-rendered HTML email. In Apps Script these share global
          // scope; the harness must load the file that defines them.
          'Digest.gs'],
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

test('Insights F1: rosterAgentCount counts only roster members ACTIVE in the current window (INV-27)', function () {
  // Both Anna + Ben selected (both on the Alpha roster), but only Anna has a
  // row in the current window. The client divides the team total by
  // meta.rosterAgentCount to get the per-agent team baseline -- counting Ben
  // (zero activity) would dilute it. Pre-fix this was 2 (all selected roster);
  // post-fix it is 1 (active roster only), matching the Individual Report.
  install([
    dqeRow({ date: '2026-03-10', agent: 'Anna', ext: '201', rung: 10, missed: 1, answered: 8, att: '0:03:00' }),
  ]);
  const data = h.call('getInsightsReport', { department: 'Alpha', from: '2026-03-09', to: '2026-03-15', agents: ['Anna', 'Ben'] });

  assert.equal(data.meta.rosterAgentCount, 1);     // Anna only -- Ben had no activity
  assert.equal(data.meta.queueOnlyAgentCount, 0);  // both selected names are roster, no floaters
  assert.equal(data.teamStats.answered.val, 8);    // team total still Anna's 8
});

test('Insights F12: meta.priorOverlap flags a custom prior window that overlaps the current range', function () {
  install([
    dqeRow({ date: '2026-03-10', agent: 'Anna', ext: '201', rung: 10, missed: 1, answered: 8, att: '0:03:00' }),
  ]);
  // Current 03-09..03-15; custom prior 03-12..03-18 overlaps on 03-12..03-15.
  const overlap = h.call('getInsightsReport', {
    department: 'Alpha', from: '2026-03-09', to: '2026-03-15',
    agents: ['Anna'], priorFrom: '2026-03-12', priorTo: '2026-03-18',
  });
  assert.equal(overlap.meta.comparisonMode, 'custom');
  assert.equal(overlap.meta.priorOverlap, true);

  // Non-overlapping custom prior -> false.
  const disjoint = h.call('getInsightsReport', {
    department: 'Alpha', from: '2026-03-09', to: '2026-03-15',
    agents: ['Anna'], priorFrom: '2026-03-01', priorTo: '2026-03-07',
  });
  assert.equal(disjoint.meta.priorOverlap, false);

  // Auto-adjacent prior (no custom window) is disjoint by construction.
  const auto = h.call('getInsightsReport', {
    department: 'Alpha', from: '2026-03-09', to: '2026-03-15', agents: ['Anna'],
  });
  assert.equal(auto.meta.comparisonMode, 'prior');
  assert.equal(auto.meta.priorOverlap, false);
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

test('Insights: 1-day range (from == to) compares against the previous day', function () {
  install([
    dqeRow({ date: '2026-03-10', agent: 'Anna', ext: '501', rung: 10, missed: 1, answered: 8, att: '0:03:00' }),
    dqeRow({ date: '2026-03-09', agent: 'Anna', ext: '501', rung: 4,  missed: 2, answered: 3, att: '0:04:00' }),
  ]);
  const data = h.call('getInsightsReport', { department: 'Alpha', from: '2026-03-10', to: '2026-03-10', agents: ['Anna'] });
  // INV-28 degenerate case: a 1-day window's auto-adjacent prior is the
  // single previous day (shared computePriorWindow_ math).
  assert.equal(data.meta.priorFrom, '2026-03-09');
  assert.equal(data.meta.priorTo,   '2026-03-09');
  assert.equal(data.meta.currentDays, 1);
  assert.equal(data.meta.priorDays, 1);
  assert.equal(data.teamStats.rung.val, 10);
  assert.equal(data.teamStats.rung.prev, 4);
});

test('Insights: email export sends a server-rendered HTML report to the active user', function () {
  install([dqeRow({ date: '2026-03-10', agent: 'Anna', ext: '501', rung: 5, answered: 4, att: '0:02:00' })]);
  h.state.sentEmails.length = 0;
  // New behavior: recomputes the report from the modal's params and emails an
  // HTML body (renderInsightsEmailBody_), NOT an html2canvas screenshot.
  const res = h.call('sendInsightsReportEmail', {
    department: 'Alpha', from: '2026-03-09', to: '2026-03-15', agents: ['Anna'],
  });
  assert.equal(res.to, 'admin@x.com');
  assert.equal(h.state.sentEmails.length, 1);
  const mail = h.state.sentEmails[0];
  assert.equal(mail.to, 'admin@x.com');
  assert.ok(mail.subject.indexOf('Insights Report:') === 0, 'subject is an Insights Report');
  assert.ok(mail.htmlBody && mail.htmlBody.indexOf('Anna') !== -1, 'HTML body includes the agent');
  assert.ok(mail.htmlBody.indexOf('Alpha') !== -1, 'HTML body names the department');
  assert.ok(!mail.inlineImages, 'no inline image — server-rendered HTML, not a screenshot');
  // Agent-free run: an empty selection now DEFAULTS to the full department
  // roster (the digest pattern, INV-45) instead of throwing -- the
  // QCD-replacement queue / dept quick-look. The email still sends,
  // recomputed over the whole roster (Alpha = Anna + Ben).
  const resAll = h.call('sendInsightsReportEmail', { department: 'Alpha', from: '2026-03-09', to: '2026-03-15', agents: [] });
  assert.equal(resAll.to, 'admin@x.com');
  assert.equal(h.state.sentEmails.length, 2);
  assert.ok(h.state.sentEmails[1].htmlBody.indexOf('Alpha') !== -1, 'agent-free email still names the department');
});

test('Insights: agent-free run defaults to the full department roster (INV-45)', function () {
  install([
    dqeRow({ date: '2026-03-10', agent: 'Anna', ext: '501', rung: 5, answered: 4 }),
    dqeRow({ date: '2026-03-11', agent: 'Ben',  ext: '502', rung: 3, answered: 2 }),
  ]);
  // No agents in the request -> resolves to the whole Alpha roster (Anna, Ben),
  // so a manager gets the team rollup + every roster card without picking.
  const data = h.call('getInsightsReport', { department: 'Alpha', from: '2026-03-09', to: '2026-03-15', agents: [] });
  // .join over deepEqual: harness vm-realm arrays trip deepStrictEqual's prototype check.
  assert.equal(data.meta.agents.slice().sort().join(','), 'Anna,Ben');
  assert.ok(agent(data, 'Anna'), 'Anna card present from the roster default');
  assert.ok(agent(data, 'Ben'),  'Ben card present from the roster default');
  // Identical to explicitly selecting the whole roster.
  const explicit = h.call('getInsightsReport', { department: 'Alpha', from: '2026-03-09', to: '2026-03-15', agents: ['Anna', 'Ben'] });
  assert.equal(data.teamStats.answered.val, explicit.teamStats.answered.val);
});

test('Insights: cross-dept request is rejected for a manager', function () {
  install([dqeRow({ date: '2026-03-10', agent: 'Anna', ext: '501', rung: 5, answered: 4 })]);
  // A non-admin with no Access Control row resolves to role 'none'.
  h.state.userEmail = 'stranger@x.com';
  assert.throws(function () {
    h.call('getInsightsReport', { department: 'Alpha', from: '2026-03-09', to: '2026-03-15', agents: ['Anna'] });
  }, /Not authorized/);
});

// -- Queue health (QCD-into-Insights consolidation) + sub-queue toggle --------

const DC_HEADERS = ['Department', 'QCD Queues', 'Overview Parent', 'Team Avg Excludes',
                    'Queue Ext Overrides', 'Active', 'Updated By', 'Updated At', 'Notes'];
// QCD row: MonthYear | Week | Date | Queue | Source | Total | Answered |
//          Abandoned | LongestWait | AvgAnswer | Abandoned % | Violations
function qcdRow(date, queue, total, abandoned, violations) {
  return ['Mar 2026', 'W2', date, queue, 'Total Calls', total, total - abandoned,
          abandoned, '0:05:00', '0:00:30', '', violations];
}

function installWithQcd(dqeRows, deptConfigRows, qcdRows) {
  h.state.userEmail = 'admin@x.com';
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.props.ADMIN_EMAILS = 'admin@x.com';
  const sheets = {
    'DO NOT EDIT!': ROSTER,
    'DQE Historical Data': dqeSheet(dqeRows),
    'Dept Config': [DC_HEADERS].concat(deptConfigRows),
  };
  if (qcdRows) {
    sheets['QCD Historical Data'] = [['Month Year', 'Week', 'Date', 'Call Queue',
      'Call Source', 'Total Calls', 'Total Answered', 'Abandoned', 'Longest Wait',
      'Avg Answer', 'Abandoned %', 'Violations']].concat(qcdRows);
  }
  h.state.spreadsheet = makeFakeSpreadsheet({ timeZone: 'America/Chicago', sheets: sheets });
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  h.state.cache.clear();
}

test('queuesForDept_: includeChildren=false returns the dept\'s own queues only', function () {
  installWithQcd([], [
    ['Alpha', 'A_Q_Alpha', '',      '', '', 'TRUE', 'a@x.com', '', ''],
    ['Beta',  'A_Q_Beta',  'Alpha', '', '', 'TRUE', 'a@x.com', '', ''],   // Beta nests under Alpha
  ], null);
  deepEqual(h.call('queuesForDept_', 'Alpha'), ['A_Q_Alpha', 'A_Q_Beta'], 'default = INV-51 rollup');
  deepEqual(h.call('queuesForDept_', 'Alpha', { includeChildren: false }), ['A_Q_Alpha']);
  assert.equal(h.call('deptHasSubQueues_', 'Alpha'), true);
  assert.equal(h.call('deptHasSubQueues_', 'Beta'), false);
});

test('Insights: queueHealth carries window totals, prior deltas base, and violation dates', function () {
  installWithQcd(
    [dqeRow({ date: '2026-03-10', agent: 'Anna', ext: '501', rung: 10, missed: 1, answered: 8, att: '0:03:00' })],
    [['Alpha', 'A_Q_Alpha', '', '', '', 'TRUE', 'a@x.com', '', '']],
    [
      qcdRow('2026-03-10', 'A_Q_Alpha', 100, 10, 1),   // current window (abd 10%)
      qcdRow('2026-03-05', 'A_Q_Alpha', 80,  2,  0),   // prior window  (abd 2.5%)
    ]);
  const data = h.call('getInsightsReport', {
    department: 'Alpha', from: '2026-03-09', to: '2026-03-15', agents: ['Anna'],
  });
  const qh = data.queueHealth;
  assert.ok(qh, 'queueHealth present when the dept has mapped queues + QCD data');
  assert.equal(qh.totals.totalCalls, 100);
  assert.equal(qh.totals.abandoned, 10);
  assert.equal(qh.totals.abandonedPctStr, '10.00%');
  assert.equal(qh.priorTotals.totalCalls, 80);
  assert.equal(qh.perQueue.length, 1);
  assert.equal(qh.perQueue[0].queue, 'A_Q_Alpha');
  assert.equal(qh.perQueue[0].violations, 1);
  assert.equal(qh.perQueue[0].violationDates.join(','), '2026-03-10');
});

test('Insights: queueHealth is null for an unmapped dept / missing QCD sheet (best-effort)', function () {
  // No Dept Config row for Alpha and no constant mapping -> unmapped.
  installWithQcd(
    [dqeRow({ date: '2026-03-10', agent: 'Anna', ext: '501', rung: 5, missed: 1, answered: 4, att: '0:02:00' })],
    [], [qcdRow('2026-03-10', 'A_Q_Alpha', 100, 10, 1)]);
  const unmapped = h.call('getInsightsReport', {
    department: 'Alpha', from: '2026-03-09', to: '2026-03-15', agents: ['Anna'],
  });
  assert.equal(unmapped.queueHealth, null);

  // Mapped dept but no QCD sheet at all -> still null, report intact.
  installWithQcd(
    [dqeRow({ date: '2026-03-10', agent: 'Anna', ext: '501', rung: 5, missed: 1, answered: 4, att: '0:02:00' })],
    [['Alpha', 'A_Q_Alpha', '', '', '', 'TRUE', 'a@x.com', '', '']], null);
  const noSheet = h.call('getInsightsReport', {
    department: 'Alpha', from: '2026-03-09', to: '2026-03-15', agents: ['Anna'],
  });
  assert.equal(noSheet.queueHealth, null);
  assert.ok(noSheet.teamStats, 'rest of the report unaffected');
});

test('Insights: queueHealth.trend carries monthly abandoned-% per queue + dept total', function () {
  installWithQcd(
    [dqeRow({ date: '2026-03-10', agent: 'Anna', ext: '501', rung: 10, missed: 1, answered: 8, att: '0:03:00' })],
    [
      ['Alpha', 'A_Q_Alpha', '',      '', '', 'TRUE', 'a@x.com', '', ''],
      ['Beta',  'A_Q_Beta',  'Alpha', '', '', 'TRUE', 'a@x.com', '', ''],
    ],
    [
      qcdRow('2026-03-10', 'A_Q_Alpha', 100, 10, 1),
      qcdRow('2026-03-10', 'A_Q_Beta',  50,  1,  0),
      qcdRow('2026-02-10', 'A_Q_Alpha', 200, 4,  0),   // prior month bucket
    ]);
  const data = h.call('getInsightsReport', {
    department: 'Alpha', from: '2026-03-09', to: '2026-03-15', agents: ['Anna'],
  });
  const trend = data.queueHealth && data.queueHealth.trend;
  assert.ok(trend, 'trend present');
  assert.ok(trend.labels.length >= 2, '12-mo monthly axis');
  assert.equal(Object.keys(trend.perQueue).length, 2, 'one series per queue (children shown, separated)');
  assert.equal(trend.perQueue['A_Q_Alpha'].length, trend.labels.length, 'series aligned to axis');
  assert.equal(trend.total.length, trend.labels.length);
  // March bucket (last label): Alpha 10/100 = 10%, Beta 1/50 = 2% (shown as its
  // own line). Sub-queues are now SEPARATED, so the dept total is OWN-only --
  // Alpha 10/100 = 10% (Beta excluded), not the old 11/150 = 7.3% rollup.
  const last = trend.labels.length - 1;
  assert.equal(trend.perQueue['A_Q_Alpha'][last], 10);
  assert.equal(trend.perQueue['A_Q_Beta'][last], 2);
  assert.equal(trend.total[last], 10);
});

// -- My Department QCD snapshot: per-queue separation -------------------------

test('dept QCD snapshot separates queues (and tags sub-queue owners)', function () {
  installWithQcd([], [
    ['Alpha', 'A_Q_Alpha', '',      '', '', 'TRUE', 'a@x.com', '', ''],
    ['Beta',  'A_Q_Beta',  'Alpha', '', '', 'TRUE', 'a@x.com', '', ''],
  ], [
    qcdRow('2026-03-10', 'A_Q_Alpha', 100, 10, 1),
    qcdRow('2026-03-10', 'A_Q_Beta',  50,  5,  0),
    qcdRow('2026-03-09', 'A_Q_Alpha', 999, 99, 9),   // older date -- ignored
  ]);
  const snap = h.call('computeDeptQcdSnapshot_', 'Alpha', 'America/Chicago');
  assert.equal(snap.date, '2026-03-10');
  assert.equal(snap.perQueue.length, 2, 'one entry per queue, never summed away');
  const alpha = snap.perQueue.filter(q => q.queue === 'A_Q_Alpha')[0];
  const beta  = snap.perQueue.filter(q => q.queue === 'A_Q_Beta')[0];
  assert.equal(alpha.subDept, null, 'own queue carries no sub-queue tag');
  assert.equal(beta.subDept, 'Beta', 'child dept queue is tagged with its owner');
  assert.equal(alpha.totalCalls, 100);
  assert.equal(alpha.abandonedPctStr, '10.00%');
  assert.equal(beta.totalCalls, 50);
  // P3: the unqualified dept total is OWN-queues-only (Alpha 100), so it
  // reconciles with the QCD modal / Overview -- the child (Beta) is NOT folded
  // in. The all-inclusive figure is surfaced separately via allTotals; the
  // sub-queue rollup via subTotals.
  assert.equal(snap.totalCalls, 100, 'canonical total = own queues only');
  assert.equal(snap.violations, 1, 'own-queue violations');
  assert.equal(snap.mainQueueCount, 1);
  assert.equal(snap.subQueueCount, 1);
  assert.equal(snap.subTotals.totalCalls, 50, 'sub-queue rollup');
  assert.equal(snap.allTotals.totalCalls, 150, 'all queues incl. sub-queues');
  assert.equal(snap.allTotals.violations, 1);

  // Single-queue dept (no children): own total stands alone; no sub/all rollup.
  const single = h.call('computeDeptQcdSnapshot_', 'Beta', 'America/Chicago');
  assert.equal(single.perQueue.length, 1);
  assert.equal(single.perQueue[0].queue, 'A_Q_Beta');
  assert.equal(single.totalCalls, 50);
  assert.equal(single.subQueueCount, 0);
  assert.equal(single.subTotals, null, 'no sub-queues -> subTotals null');
  assert.equal(single.allTotals, null, 'no sub-queues -> allTotals null');
});

test('Insights: queueHealth daily series + always-separated sub-queues', function () {
  installWithQcd(
    [dqeRow({ date: '2026-03-10', agent: 'Anna', ext: '501', rung: 10, missed: 1, answered: 8, att: '0:03:00' })],
    [
      ['Alpha', 'A_Q_Alpha', '',      '', '', 'TRUE', 'a@x.com', '', ''],
      ['Beta',  'A_Q_Beta',  'Alpha', '', '', 'TRUE', 'a@x.com', '', ''],
    ],
    [
      qcdRow('2026-03-10', 'A_Q_Alpha', 100, 10, 1),
      qcdRow('2026-03-11', 'A_Q_Alpha', 80,  2,  0),
      qcdRow('2026-03-10', 'A_Q_Beta',  50,  5,  0),
    ]);
  const data = h.call('getInsightsReport', {
    department: 'Alpha', from: '2026-03-09', to: '2026-03-15', agents: ['Anna'],
  });
  const qh = data.queueHealth;
  const t = qh.trend;
  // Sub-queues are ALWAYS separated now (the queueHealthOwnOnly toggle was
  // retired in seq #1). Children are SHOWN as their own lines/rows, but the
  // dept total/trend is OWN-only (Alpha).
  assert.equal(t.dailyLabels.join(','), '2026-03-10,2026-03-11');
  assert.equal(t.dailyTotal[0], 10);   // own-only Alpha: 10/100 = 10%
  assert.equal(t.dailyTotal[1], 2.5);  // 2/80
  assert.equal(Object.keys(t.dailyPerQueue).length, 2, 'both queues shown as lines');
  assert.equal(t.dailyPerQueue['A_Q_Beta'][0], 10);  // 5/50 (Beta shown separately)
  assert.equal(qh.hasSubQueues, true);
  assert.equal(qh.subQueuesSeparated, true);
  // Children are shown (both queues listed) but EXCLUDED from the dept total.
  assert.equal(qh.queues.join(','), 'A_Q_Alpha,A_Q_Beta');
  assert.equal(qh.totals.totalCalls, 180, 'dept total is own-only (Alpha 100+80), Beta excluded');
  // perQueue rows carry the sub-queue owner tag for the separated group.
  const betaRow = qh.perQueue.filter(function (q) { return q.queue === 'A_Q_Beta'; })[0];
  assert.equal(betaRow.subDept, 'Beta');
  const alphaRow = qh.perQueue.filter(function (q) { return q.queue === 'A_Q_Alpha'; })[0];
  assert.equal(alphaRow.subDept, null);

  // Consolidation Phase 1 (gap 3): dailySeries passes through -- the per-day
  // numeric rows the QCD modal's daily table renders, dept-OWN queues,
  // selected-range scoped (Beta excluded from the dept daily total).
  assert.equal(qh.dailySeries.length, 2, 'two days of own-queue QCD data');
  assert.equal(qh.dailySeries[0].date, '2026-03-10');
  assert.equal(qh.dailySeries[0].totalCalls, 100);
  assert.equal(qh.dailySeries[0].abandoned, 10);
  assert.equal(qh.dailySeries[1].totalCalls, 80);
  // Consolidation Phase 1 (gap 2): perQueue rows carry the full bySource
  // breakdown (here just the 'Total Calls' rollup -> 'Overall'), aggregated
  // over the range (Alpha 100 + 80 = 180).
  assert.ok(Array.isArray(alphaRow.bySource), 'perQueue row carries bySource');
  const overall = alphaRow.bySource.filter(function (s) { return s.isOverall; })[0];
  assert.ok(overall, 'bySource has the Overall rollup row');
  assert.equal(overall.totalCalls, 180);

  // Consolidation Phase 1 (gap 1): trend.metrics carries Total Calls +
  // Violations series parallel to the default abandoned-% series, so the
  // by-queue chart tab can switch metric. Own-dept total = Alpha only.
  // NOTE: compare via join(',') not deepEqual -- the harness returns arrays
  // from a vm realm whose Array.prototype differs, which trips deepStrictEqual.
  assert.ok(t.metrics && t.metrics.totalCalls && t.metrics.violations, 'trend.metrics present');
  assert.equal(t.metrics.totalCalls.dailyTotal.join(','), '100,80', 'own-dept daily total calls');
  assert.equal(t.metrics.totalCalls.dailyPerQueue['A_Q_Beta'].join(','), '50,0', 'child daily total calls');
  assert.equal(t.metrics.violations.dailyTotal.join(','), '1,0', 'own-dept daily violations');
});

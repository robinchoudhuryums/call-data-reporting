'use strict';

// UX-2 follow-on: probeBriefThresholds (Diagnostics.gs) -- the editor-run,
// admin-gated, READ-ONLY probe that shows what "normal" looks like for the
// three Insights brief rows that have no standard yet: share of answered,
// queue wait, and the monthly answer-rate trend (Operator State #76).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

const h = loadGas({ files: ['Config.gs', 'Util.gs', 'Auth.gs', 'Data.gs', 'NeonRead.gs', 'QCDReport.gs', 'Diagnostics.gs'] });

test('briefStats_ / briefPercentile_ / briefSpearman_: the small maths the probe reports', function () {
  const s = h.call('briefStats_', [14, 13, 12, 11, 10, 10, 9, 8, 7, 6]);
  assert.equal(s.mean, 10);
  assert.equal(Math.round(s.sd * 100) / 100, 2.45, 'the worked example from the options discussion');
  assert.equal(h.call('briefStats_', []).n, 0);
  assert.equal(h.call('briefPercentile_', [5, 1, 3], 0.5), 3);
  assert.equal(h.call('briefPercentile_', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
  assert.equal(h.call('briefPercentile_', [], 0.5), null);
  assert.equal(h.call('briefSpearman_', [1, 2, 3, 4, 5], [10, 20, 30, 40, 50]), 1);
  assert.equal(h.call('briefSpearman_', [1, 2, 3, 4, 5], [50, 40, 30, 20, 10]), -1);
  assert.equal(h.call('briefSpearman_', [1, 2, 3], [1, 2, 3]), null, 'under 4 pairs is not reported');
  assert.equal(h.call('briefSpearman_', [1, 2, 3, 4], [7, 7, 7, 7]), null, 'a flat series has no rank spread');
});

test('briefShareMonth_: shares, the per-day-worked view, and the 1/2 SD counts', function () {
  // Five full-timers on 20 days; Eve only worked 10 days, so her RAW share is
  // low while her per-day output is the team's norm -- the reason the per-day
  // view exists. Zed (2 days) and Low (2 rung) fail the gates.
  const agents = [
    { agent: 'Ann', answered: 400, rung: 420, days: 20 },
    { agent: 'Bob', answered: 400, rung: 420, days: 20 },
    { agent: 'Cy',  answered: 400, rung: 420, days: 20 },
    { agent: 'Di',  answered: 800, rung: 820, days: 20 },
    { agent: 'Eve', answered: 200, rung: 210, days: 10 },
    { agent: 'Zed', answered: 50,  rung: 50,  days: 2 },
    { agent: 'Low', answered: 2,   rung: 2,   days: 12 },
  ];
  const m = h.call('briefShareMonth_', agents);
  assert.equal(m.agents, 5, 'the days and rung gates drop Zed and Low');
  assert.equal(m.equalSharePts, 20);
  assert.equal(m.perDayMean, 24, 'per day: 20, 20, 20, 40, 20');
  assert.equal(m.maxZAgent, 'Di');
  assert.equal(m.maxZ, 2, 'Di sits exactly 2 SD above');
  assert.equal(m.beyond1Sd, 1);
  assert.equal(m.beyond2Sd, 0, '"beyond" is strictly greater than');
  assert.ok(m.shareSdPts > 0 && m.maxShareGapPts > 0);
  assert.equal(h.call('briefShareMonth_', agents.slice(0, 4)), null, 'fewer than 5 qualifying agents is not assessed');
});

test('briefRateSwings_: month-over-month, vs the 3-month average, and the threshold counts', function () {
  const r = h.call('briefRateSwings_', [
    { month: '2026-01', rate: 90 }, { month: '2026-02', rate: 88 }, { month: '2026-03', rate: 89 },
    { month: '2026-04', rate: 83 }, { month: '2026-05', rate: null }, { month: '2026-06', rate: 86 },
  ]);
  assert.equal(JSON.stringify(r.rows.map(function (x) { return x.momPts; })), '[null,-2,1,-6,null,null]');
  assert.equal(r.rows[3].vs3Pts, -6, '83 vs avg(90, 88, 89) = 89');
  assert.equal(r.rows[5].vs3Pts, null, 'a gap month in the prior three leaves vs3 out');
  assert.equal(r.mom.n, 3);
  assert.equal(r.mom.atLeast2, 2);
  assert.equal(r.mom.atLeast5, 1);
  assert.equal(JSON.stringify(r.mom.worst), '{"month":"2026-04","pts":-6}');
});

test('briefQueueWait_: weighted avg answer, longest, own-history ratios, daily jumpiness', function () {
  const months = ['2026-01', '2026-02', '2026-03', '2026-04'];
  const days = [];
  months.forEach(function (m, i) {
    for (let d = 1; d <= 5; d++) {
      days.push({ iso: m + '-0' + d, calls: 100, answered: 90,
        avgAnswerSec: i === 3 ? 60 : 30, longestSec: i === 3 ? 600 : 300 });
    }
  });
  days.push({ iso: '2025-12-31', calls: 999, answered: 999, avgAnswerSec: 999, longestSec: 9999 });   // outside the months
  const q = h.call('briefQueueWait_', days, months);
  assert.equal(q.calls, 2000);
  assert.equal(q.avgAnswerSec, 38, '(15 days x 30 + 5 x 60) weighted by answered = 37.5');
  assert.equal(q.longestSec, 600);
  assert.equal(q.ownAvg.months, 1, 'only April has three prior months');
  assert.equal(q.ownAvg.maxRatio, 2);
  assert.equal(q.ownAvg.atLeast150, 1);
  assert.equal(q.ownLongest.atLeast125, 1);
  assert.ok(q.dailyAvgCvPct > 0);
});

test('briefProbeWindow_: the 12 whole months ending last month, or the explicit window', function () {
  const props = { getProperty: function () { return null; } };
  const w = h.call('briefProbeWindow_', props, '2026-10-13');
  assert.equal(w.from, '2025-10-01');
  assert.equal(w.to, '2026-09-30');
  assert.equal(w.months.length, 12);
  assert.equal(w.months[0], '2025-10');
  assert.equal(w.months[11], '2026-09');
  const p2 = { getProperty: function (k) { return { BRIEF_PROBE_FROM: '2026-06-01', BRIEF_PROBE_TO: '2026-08-31' }[k] || null; } };
  const w2 = h.call('briefProbeWindow_', p2, '2026-10-13');
  assert.equal(w2.months.join(','), '2026-06,2026-07,2026-08');
});

test('probeBriefThresholds: admin-gated, reads through the DAL, writes nothing, reports all three sections', function () {
  const saved = {};
  const stub = function (name, fn) { saved[name] = h.ctx[name]; h.ctx[name] = fn; };
  let gated = false;
  stub('assertAdmin_', function () { gated = true; });
  h.state.props = { BRIEF_PROBE_FROM: '2026-01-01', BRIEF_PROBE_TO: '2026-06-30' };
  stub('getAllDepartments_', function () { return ['CSR']; });
  stub('getRosterForDepartment_', function () { return { names: ['A', 'B', 'C', 'D', 'E', 'Boss'] }; });
  stub('getTeamAvgExcludes_', function () { return ['Boss']; });
  stub('getAnswerStandardFor_', function () { return { target: 92, band: 2 }; });
  stub('getDeptQcdQueues_', function () { return ['A_Q_CustomerSuccess']; });
  const months = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];
  const rows = [];
  months.forEach(function (m, mi) {
    for (let d = 1; d <= 6; d++) {
      ['A', 'B', 'C', 'D', 'E'].forEach(function (a) {
        rows.push({ dateIso: m + '-0' + d, agent: a, totalRung: 20, totalAnswered: a === 'A' ? 19 : (mi === 5 ? 14 : 18), totalMissed: 1 });
      });
      rows.push({ dateIso: m + '-0' + d, agent: 'Boss', totalRung: 2, totalAnswered: 2, totalMissed: 0 });
      rows.push({ dateIso: m + '-0' + d, agent: 'A_Q_CSR', totalRung: 0, totalAnswered: 0, totalMissed: 0 });   // sentinel, off-roster
    }
  });
  let dqeArgs = null;
  stub('sheetFetchDqeRows_', function (f, t) { dqeArgs = [f, t]; return rows; });
  const qv = [], qd = [];
  months.forEach(function (m) {
    ['Total Calls', 'CSR'].forEach(function (src) {
      const v = new Array(12).fill(''), dsp = new Array(12).fill('');
      v[2] = m + '-02'; v[3] = 'A_Q_CustomerSuccess'; v[4] = src; v[5] = 100; v[6] = 95;
      dsp[8] = '0:05:00'; dsp[9] = '0:00:30';   // I longest, J avg answer
      qv.push(v); qd.push(dsp);
    });
    const u = new Array(12).fill(''); u[2] = m + '-02'; u[3] = 'A_Q_Nobody'; u[4] = 'Total Calls'; u[5] = 5;
    qv.push(u); qd.push(new Array(12).fill(''));
  });
  stub('readQcdGrid_', function () { return { values: qv, displays: qd, ssTZ: 'America/Chicago' }; });
  stub('logStatusReturn_', function (o) { return o; });
  const before = JSON.stringify(h.state.props);
  try {
    const out = h.call('probeBriefThresholds');
    assert.ok(gated, 'assertAdmin_ runs');
    assert.equal(dqeArgs.join(','), '2026-01-01,2026-06-30');
    assert.equal(out.source, 'sheet');
    assert.equal(out.months.length, 6);
    // 1. share: Boss excluded (INV-26), the sentinel never on the roster.
    assert.equal(out.share[0].monthsAssessed, 6);
    assert.equal(out.share[0].typicalAgents, 5);
    assert.equal(out.share[0].equalSharePts, 20);
    // 2. queue: Total Calls rows only (the CSR source row is not double-counted), unmapped skipped.
    assert.equal(out.queues.length, 1);
    assert.equal(out.queues[0].calls, 600);
    assert.equal(out.queues[0].avgAnswerSec, 30);
    assert.equal(out.queues[0].longestSec, 300);
    assert.equal(out.queues[0].vsCompany, 1);
    assert.equal(out.unmappedQueuesSkipped, 1);
    // 3. rates: every roster agent incl. Boss; June drops.
    const r = out.rates[0];
    assert.equal(r.band, 2);
    assert.equal(r.monthly.length, 6);
    assert.ok(r.monthly[5] < r.monthly[4], 'June is lower');
    assert.equal(r.mom.atLeast5, 1, 'the June drop crosses 5 points');
    assert.ok(out.pooledRateSwings.mom.n === 5);
    assert.equal(JSON.stringify(h.state.props), before, 'read-only: no property written or cleared');
  } finally {
    Object.keys(saved).forEach(function (k) { if (saved[k] === undefined) delete h.ctx[k]; else h.ctx[k] = saved[k]; });
  }
});

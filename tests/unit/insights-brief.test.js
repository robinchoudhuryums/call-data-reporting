'use strict';

// UX-2 (owner 2026-10-13): the Insights ranked brief. The rules came from
// probeBriefThresholds (Operator State #76) and are recorded in
// docs/next-steps.md "UX-2 RULED":
//   - top line: the dept answer target + its amber band (answerTierCls_);
//   - queue health: red at a window abandon rate of 4.00% or more; amber for a
//     violation day, or an avg answer 1.5x the queue's OWN prior-3-month
//     median (judged only at 5+ calls a day); green otherwise;
//   - agents: red = behind the team AND slipping; amber = behind, or slipping
//     while on par; "slipping" is ignored on windows more than 7 days apart;
//   - trend: the latest WHOLE month vs the average of the 3 before it -- red
//     at 12+ points down, amber 8 to 12 down, green 8+ up;
//   - callbacks / team detail: always grey (no standard yet);
//   - ranking: red, amber, green, grey; ties in the fixed section order.
// The client rules are PURE functions lifted out of script-8-insights.html
// (the date-presets.test.js technique); the queue-wait verdict is server-side
// (InsightsReport.gs::insQueueWaitVerdict_), driven here through the real
// computeQcdReport_.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { rosterGrid } = require('../harness/fixtures');

const DIR = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');

function extractFn(file, name) {
  const text = fs.readFileSync(path.join(DIR, file), 'utf8');
  const start = text.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, name + ' is missing from ' + file);
  const open = text.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  // eslint-disable-next-line no-new-func
  return new Function('return (' + text.slice(start, end) + ');')();
}

const F = 'script-8-insights.html';
const topTier = extractFn(F, 'insBriefTopTier_');
const queueV = extractFn(F, 'insBriefQueue_');
const agentsV = extractFn(F, 'insBriefAgents_');
const trendV = extractFn(F, 'insBriefTrend_');
const shade = extractFn(F, 'insTrendShade_');
const rank = extractFn(F, 'insBriefRank_');

test('top line: the answer-target tier classes map to the brief colours', function () {
  assert.equal(topTier(' bm-target'), 'green');
  assert.equal(topTier(' bm-watch'), 'amber');
  assert.equal(topTier(' bm-bad'), 'red');
  assert.equal(topTier(''), 'grey');
});

test('queue health: 4.00% is red, a violation day or a slow queue is amber, else green', function () {
  const q = function (name, pct, viol, wait) {
    return { queue: name, totalCalls: 100, abandonedPct: pct, violations: viol, wait: wait || null };
  };
  let v = queueV({ perQueue: [q('A_Q_A', 4.0, 1), q('A_Q_B', 6.1, 2)] }, 4);
  assert.equal(v.tier, 'red', 'exactly 4.00% breaks the standard (QO-2)');
  assert.match(v.text, /A_Q_B abandoned 6\.1% \(limit 4%\) \(\+1 more\)/, 'worst queue named first');
  v = queueV({ perQueue: [q('A_Q_A', 3.99, 2)] }, 4);
  assert.equal(v.tier, 'amber');
  assert.match(v.text, /A_Q_A had 2 violation days/);
  v = queueV({ perQueue: [q('A_Q_A', 1, 0, { flagged: true, ratio: 1.6, avgAnswerSec: 40, ownMedianSec: 25 })] }, 4);
  assert.equal(v.tier, 'amber', 'a queue answering 1.5x+ slower than its own norm');
  assert.match(v.text, /40s on average, 1\.6x its usual 25s/);
  v = queueV({ perQueue: [q('A_Q_A', 1, 0, { flagged: false, ratio: 2, eligible: false })] }, 4);
  assert.equal(v.tier, 'green', 'an unflagged (too-small) queue never turns amber');
  assert.equal(queueV(null, 4).tier, 'grey');
  assert.equal(queueV({ unmapped: true }, 4).tier, 'grey');
  assert.match(queueV({ unmapped: true }, 4).text, /No queues mapped/, 'a config gap stays visible as a grey row');
  assert.equal(queueV({ error: true }, 4).tier, 'grey');
  assert.equal(queueV({ perQueue: [{ queue: 'A_Q_A', totalCalls: 0, abandonedPct: 50 }] }, 4).tier, 'grey',
    'a queue with no calls in the window is not judged');
});

test('agents: behind + slipping is red; behind, or slipping while on par, is amber', function () {
  const r = function (name, standing, trend, judged) {
    return { name: name, standing: standing, trend: trend, judged: judged !== false };
  };
  let v = agentsV([r('Ann', 'attention', 'regressed'), r('Bo', 'steady', 'mixed'), r('Cy', 'strong', 'improved')], false);
  assert.equal(v.tier, 'red');
  assert.match(v.text, /Ann \(behind, slipping\)/);
  v = agentsV([r('Ann', 'attention', 'improved'), r('Bo', 'steady', 'mixed')], false);
  assert.equal(v.tier, 'amber', 'behind but improving');
  v = agentsV([r('Ann', 'steady', 'regressed'), r('Bo', 'steady', 'mixed')], false);
  assert.equal(v.tier, 'amber', 'slipping while on par');
  v = agentsV([r('Ann', 'strong', 'regressed'), r('Bo', 'steady', 'mixed')], false);
  assert.equal(v.tier, 'green', 'ahead of the team and slipping is not flagged');
  v = agentsV([r('Ann', 'attention', 'regressed'), r('Bo', 'steady', 'regressed')], true);
  assert.equal(v.tier, 'amber', 'unequal windows: slipping ignored, so amber at most');
  assert.equal(v.amber.length, 1, 'and the on-par slip no longer counts');
  assert.equal(agentsV([r('Ann', 'attention', 'regressed'), r('Bo', 'steady', 'mixed', false)], false).tier, 'grey',
    'fewer than 2 judged agents is not enough to compare');
  const many = ['A', 'B', 'C', 'D', 'E'].map(function (n) { return r(n, 'attention', 'mixed'); });
  assert.match(agentsV(many, false).text, /\+2 more$/, 'the list is capped at three names');
});

test('trend: latest WHOLE month vs its prior 3-month average, 8 / 12 point bands', function () {
  const m = function (month, pct) { return { month: month, pct: pct, rung: 100 }; };
  const base = [m('2026-05', 90), m('2026-06', 90), m('2026-07', 90)];
  assert.equal(trendV(base.concat([m('2026-08', 78)]), '2026-08-31').tier, 'red', '12 down is red');
  assert.equal(trendV(base.concat([m('2026-08', 82)]), '2026-08-31').tier, 'amber', '8 down is amber');
  assert.equal(trendV(base.concat([m('2026-08', 82.1)]), '2026-08-31').tier, 'grey', 'just under 8 down is grey');
  assert.equal(trendV(base.concat([m('2026-08', 98)]), '2026-08-31').tier, 'green', '8 up is green');
  const v = trendV(base.concat([m('2026-08', 85.2)]), '2026-08-31');
  assert.equal(v.change, -4.8);
  assert.equal(v.text, 'Aug answer rate 85.2%, 4.8 pts below its prior 3-month average');
  // A window ending part-way through September judges August, not September.
  const partial = trendV(base.concat([m('2026-08', 78), m('2026-09', 99)]), '2026-09-15');
  assert.equal(partial.month, '2026-08');
  assert.equal(partial.tier, 'red');
  assert.equal(trendV(base.concat([m('2026-08', 78), m('2026-09', 99)]), '2026-09-30').month, '2026-09',
    'a window ending on the last day makes that month whole');
  assert.equal(trendV(base, '2026-07-31').tier, 'grey', 'fewer than 4 whole months');
  assert.equal(trendV([m('2026-05', 90), { month: '2026-06', pct: 0, rung: 0 }, m('2026-07', 90), m('2026-08', 70)], '2026-08-31').tier,
    'grey', 'a prior month with no calls cannot anchor the average');
});

test('trend shading: neutral within 2 points, full colour at 15', function () {
  assert.equal(shade(1.9).t, 0);
  assert.equal(shade(-2).t, 0);
  assert.equal(shade(15).t, 1);
  assert.equal(shade(-30).t, 1);
  assert.equal(shade(8.5).t, 0.5);
  assert.equal(shade(-8.5).dir, 'down');
  assert.equal(shade(null).t, 0);
});

test('ranking: red, amber, green, grey; ties in the fixed section order', function () {
  const out = rank([
    { key: 'trend', tier: 'grey' }, { key: 'detail', tier: 'grey' }, { key: 'agents', tier: 'amber' },
    { key: 'queue', tier: 'amber' }, { key: 'callbacks', tier: 'grey' }, { key: 'x', tier: 'red' },
  ]).map(function (r) { return r.key; });
  assert.deepEqual(out, ['x', 'queue', 'agents', 'callbacks', 'detail', 'trend']);
});

test('--caution (the brief amber) is defined at every site --stale is, with the same values', function () {
  const css = fs.readFileSync(path.join(DIR, 'styles.html'), 'utf8');
  const vals = function (name) {
    return (css.match(new RegExp('^\\s*' + name + ':\\s*([^;]+);', 'gm')) || [])
      .map(function (l) { return l.replace(/^\s*[^:]+:\s*/, '').replace(/;$/, '').trim(); });
  };
  assert.deepEqual(vals('--caution'), vals('--stale'));
  assert.deepEqual(vals('--caution-soft'), vals('--stale-soft'));
  assert.ok(vals('--caution').length >= 5);
  assert.match(css, /\.ins-brief--amber \{ border-left-color: var\(--caution\); \}/, 'amber rows use --caution');
  assert.match(css, /\.ins-brief--red\s+\{ border-left-color: var\(--warn\); \}/, 'red rows use --warn');
  assert.match(css, /body:not\(\[data-view-as="manager"\]\) #insights-results\.ins-has-brief #ins-headline/,
    'the headline hides only while the brief can show');
});

test('the brief container is admin-only (View-as hides it)', function () {
  const html = fs.readFileSync(path.join(DIR, 'dashboard.html'), 'utf8');
  assert.match(html, /<div id="ins-brief" class="ins-brief" data-admin-only style="display:none;"/);
});

// ── Server: the queue-wait verdict ───────────────────────────────────────────

const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'Data.gs', 'DeptConfig.gs', 'NeonRead.gs',
          'QCDReport.gs', 'InsightsReport.gs'],
  capture: ['DEPT_CONFIG_HEADERS'],
});

test('insQueueWaitVerdict_: 1.5x the median of the 3 prior whole months, at 5+ calls a day', function () {
  const months = [
    { month: '2026-05', avgAnswerSec: 99 },   // outside the 3 prior months
    { month: '2026-06', avgAnswerSec: 20 },
    { month: '2026-07', avgAnswerSec: 30 },
    { month: '2026-08', avgAnswerSec: 25 },
    { month: '2026-09', avgAnswerSec: 60 },   // the window's own month
  ];
  const days = [{ totalCalls: 30 }, { totalCalls: 30 }, { totalCalls: 0 }];
  let v = h.call('insQueueWaitVerdict_', { avgAnswerSec: 38, totalCalls: 60 }, months, days, '2026-09-01');
  assert.equal(v.ownMedianSec, 25);
  assert.equal(v.ratio, 1.52);
  assert.equal(v.callsPerDay, 30, 'calls per ACTIVE day');
  assert.equal(v.flagged, true);
  v = h.call('insQueueWaitVerdict_', { avgAnswerSec: 37, totalCalls: 60 }, months, days, '2026-09-01');
  assert.equal(v.flagged, false, '1.48x is under the line');
  v = h.call('insQueueWaitVerdict_', { avgAnswerSec: 60, totalCalls: 8 }, months, [{ totalCalls: 4 }, { totalCalls: 4 }], '2026-09-01');
  assert.equal(v.eligible, false);
  assert.equal(v.flagged, false, 'a queue under 5 calls a day is never flagged');
  v = h.call('insQueueWaitVerdict_', { avgAnswerSec: 60, totalCalls: 60 }, months.slice(2), days, '2026-09-01');
  assert.equal(v.insufficient, true, 'fewer than 3 prior months');
  v = h.call('insQueueWaitVerdict_', { avgAnswerSec: 60, totalCalls: 60 },
    [{ month: '2026-06', avgAnswerSec: 20 }, { month: '2026-07', avgAnswerSec: 0 }, { month: '2026-08', avgAnswerSec: 25 }], days, '2026-09-01');
  assert.equal(v.insufficient, true, 'a prior month with no answered calls cannot anchor the median');
});

test('queue health carries each queue\'s wait verdict from the real QCD monthly buckets', function () {
  const QCD_HEADER = ['Month Year', 'Week', 'Date', 'Call Queue', 'Call Source', 'Total Calls',
    'Total Answered', 'Abandoned', 'Longest Wait', 'Avg Answer', 'Abandoned %', 'Violations'];
  const row = function (iso, q, total, avg, src) {
    return ['', '', iso, q, src || 'Total Calls', total, total - 2, 2, '0:02:00', avg, '', 0];
  };
  const rows = [];
  ['2026-06', '2026-07', '2026-08'].forEach(function (m) {
    rows.push(row(m + '-10', 'A_Q_Big', 100, '0:00:20'));
    rows.push(row(m + '-10', 'A_Q_Tiny', 3, '0:00:20'));
  });
  ['01', '02', '03'].forEach(function (d) {
    rows.push(row('2026-09-' + d, 'A_Q_Big', 100, '0:00:40'));
    rows.push(row('2026-09-' + d, 'A_Q_Big', 50, '0:09:00', 'CSR'));   // a sub-source: never counted
    rows.push(row('2026-09-' + d, 'A_Q_Tiny', 3, '0:00:40'));
  });
  h.state.userEmail = 'admin@x.com';
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.props.ADMIN_EMAILS = 'admin@x.com';
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {
    'DO NOT EDIT!': rosterGrid({ Alpha: ['Anna, 201'] }),
    'Dept Config': [h.consts.DEPT_CONFIG_HEADERS].concat([['Alpha', 'A_Q_Big, A_Q_Tiny', '', '', '', 'TRUE', '', '', '', '']]),
    'QCD Historical Data': [QCD_HEADER].concat(rows),
  } });
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  h.ctx.QCD_SHEET_DATA_MEMO_ = null;
  h.state.cache.clear();

  const rep = h.call('computeQcdReport_', 'Alpha', '2026-09-01', '2026-09-03', true, true);
  const aug = rep.trendData.perQueue.A_Q_Big.monthly.filter(function (b) { return b.month === '2026-08'; })[0];
  assert.equal(aug.avgAnswerSec, 20, 'the monthly bucket carries its answered-weighted avg answer');

  const qh = h.call('insightsQueueHealth_', 'Alpha', '2026-09-01', '2026-09-03', '2026-08-29', '2026-08-31');
  const by = {};
  qh.perQueue.forEach(function (q) { by[q.queue] = q.wait; });
  assert.equal(by.A_Q_Big.ownMedianSec, 20);
  assert.equal(by.A_Q_Big.ratio, 2);
  assert.equal(by.A_Q_Big.flagged, true, '100 calls a day at twice its own norm');
  assert.equal(by.A_Q_Tiny.ratio, 2);
  assert.equal(by.A_Q_Tiny.flagged, false, '3 calls a day is too few to judge');
});

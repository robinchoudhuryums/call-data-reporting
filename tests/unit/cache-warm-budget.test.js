'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// O-4 (2026-09-03 broad scan): warmReportCaches_ runs under a WHOLE-RUN
// budget. Apps Script kills a trigger around 6 minutes and the kill skips
// catch/finally, so an overrunning warm never reached recordCacheWarm_ and
// the Health page kept showing the previous day's "ok". Only the Insights
// phase had a budget; the Overview + per-dept summaries + qcdAll phases did
// not. Driven with a fake clock that advances per unit of work.

const h = loadGas({ files: ['Config.gs', 'CacheWarm.gs'] });

function run(opts) {
  const MIN = 60 * 1000;
  let clock = 1700000000000;
  const calls = { overview: 0, summary: 0, qcd: 0, insights: 0 };
  const realNow = Date.now;
  Date.now = function () { return clock; };
  h.state.props = {};
  h.ctx.getLatestDataDate = function () { return '2026-08-31'; };
  h.ctx.getLatestDataDates = function () { return { qcd: '2026-08-31', dqe: '2026-08-31' }; };
  h.ctx.getAllDepartments_ = function () { return ['A', 'B', 'C', 'D', 'E']; };
  h.ctx.getCompanyOverview = function () { calls.overview++; clock += opts.overviewMin * MIN; };
  h.ctx.getDepartmentSummary = function () { calls.summary++; clock += opts.summaryMin * MIN; };
  h.ctx.getQcdAllDepartments = function () { calls.qcd++; clock += MIN; };
  h.ctx.getInsightsReport = function () { calls.insights++; clock += (opts.insightsMin == null ? 0.1 : opts.insightsMin) * MIN; };
  try { h.call('warmReportCaches_'); } finally { Date.now = realNow; }
  return { calls: calls, result: h.state.props.CACHE_WARM_LAST_RESULT, at: h.state.props.CACHE_WARM_LAST };
}

test('O-4: a fast run warms everything and records ok with no skips', function () {
  const r = run({ overviewMin: 0.1, summaryMin: 0.1 });
  assert.equal(r.calls.overview, 1);
  assert.equal(r.calls.summary, 5);
  assert.equal(r.calls.qcd, 1);
  assert.equal(r.calls.insights, 10);
  assert.match(r.result, /^ok \(17 warmed, /);
  assert.doesNotMatch(r.result, /skipped/);
  assert.ok(r.at, 'stamped');
});

test('O-4: a slow run stops warming at the budget and STILL records its outcome', function () {
  // Overview 1 min, each summary 2 min: A (1->3), B (3->5), C's check at 5 min
  // is at the 5-min budget (not over) -> runs (5->7), D and E skipped; qcdAll
  // and both Insights windows skipped.
  const r = run({ overviewMin: 1, summaryMin: 2 });
  assert.equal(r.calls.summary, 3);
  assert.equal(r.calls.qcd, 0);
  assert.equal(r.calls.insights, 0);
  assert.match(r.result, /^ok \(4 warmed, 2 summaries skipped on budget, qcdAll skipped on budget, 10 insights skipped on budget/);
  assert.ok(r.at, 'the run ENDED by recording, instead of being killed past its catch blocks');
});

test('O-4: the budget is below the platform ceiling', function () {
  assert.ok(h.ctx.CACHE_WARM_TOTAL_BUDGET_MS < 6 * 60 * 1000);
});

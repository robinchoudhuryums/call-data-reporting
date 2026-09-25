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
  calls.qcdArgs = []; calls.insightsArgs = [];
  h.ctx.getQcdAllDepartments = function (req) { calls.qcd++; calls.qcdArgs.push(req); clock += MIN; };
  h.ctx.getInsightsReport = function (req) { calls.insights++; calls.insightsArgs.push(req); clock += (opts.insightsMin == null ? 0.1 : opts.insightsMin) * MIN; };
  // Batch 8 (S2A-4 / ENG-10): the warm now reads the previous business day
  // and the picker's init endpoint -- stubbed here (Util.gs / IR not loaded).
  h.ctx.prevBusinessDayIso_ = function () { return opts.prevBusiness || '2026-08-31'; };
  h.ctx.getInsightsReportInit = function (req) {
    return opts.init ? opts.init(req) : { agents: ['Ann', 'Bo', 'Cy'], activeAgents: ['Bo', 'Ann'] };
  };
  if (opts.latestQcd) h.ctx.getLatestDataDates = function () { return { qcd: opts.latestQcd, dqe: opts.latestQcd }; };
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

// O-1 (broad-scan 2026-09-17): the OPS-8 contract is prefix-coded and the Health
// classifier paints an `ok` prefix green, so a run in which EVERY warm threw
// recorded "ok (0 warmed, 16 failed …)" and rendered healthy. A run that warmed
// nothing while something failed is FAILED-ALL.
test('O-1: a run that warmed nothing and failed something records FAILED-ALL, never ok', function () {
  const realNow = Date.now;
  h.state.props = {};
  h.ctx.getLatestDataDate = function () { return '2026-08-31'; };
  h.ctx.getAllDepartments_ = function () { return ['A', 'B']; };
  const boom = function () { throw new Error('Service Spreadsheets timed out'); };
  h.ctx.getCompanyOverview = boom;
  h.ctx.getDepartmentSummary = boom;
  h.ctx.getQcdAllDepartments = boom;
  h.ctx.getInsightsReport = boom;
  try { h.call('warmReportCaches_'); } finally { Date.now = realNow; }
  assert.match(h.state.props.CACHE_WARM_LAST_RESULT, /^FAILED-ALL \(0 warmed, \d+ failed/);
  assert.ok(h.state.props.CACHE_WARM_LAST, 'still stamped');
  // A PARTIAL failure stays ok -- the caches that did warm are real work.
  h.state.props = {};
  h.ctx.getCompanyOverview = function () {};
  try { h.call('warmReportCaches_'); } finally { Date.now = realNow; }
  assert.match(h.state.props.CACHE_WARM_LAST_RESULT, /^ok \(1 warmed, \d+ failed/);
});

// ENG-10 (broad-scan 2026-09-23, Batch 8): the all-dept Queue report modal
// preloads the LATEST QCD date (qcdAllDeptDefaultDates_), not calendar
// yesterday -- warming literal yesterday missed every Monday and post-holiday.
test('ENG-10: the qcdAll warm targets the latest QCD date, gated on the previous BUSINESS day', function () {
  // A Monday: latest QCD is Friday 2026-08-28, which IS the previous business day.
  let r = run({ overviewMin: 0.1, summaryMin: 0.1, latestQcd: '2026-08-28', prevBusiness: '2026-08-28' });
  assert.equal(r.calls.qcd, 1, 'a Monday morning warms (calendar yesterday would have been Sunday)');
  assert.deepEqual(JSON.parse(JSON.stringify(r.calls.qcdArgs[0])), { from: '2026-08-28', to: '2026-08-28' });
  // Import not landed yet: latest QCD is older than the previous business day.
  r = run({ overviewMin: 0.1, summaryMin: 0.1, latestQcd: '2026-08-27', prevBusiness: '2026-08-28' });
  assert.equal(r.calls.qcd, 0, 'never pins a pre-ingest report');
});

// S2A-4: the quick-start chips run the DEPT window with the ACTIVE agents
// ticked; the warm used the whole roster over 30 days and never matched.
test('S2A-4: the second Insights warm is the chip request -- dept window, the picker\'s active agents', function () {
  const r = run({ overviewMin: 0.1, summaryMin: 0.1 });
  const args = JSON.parse(JSON.stringify(r.calls.insightsArgs));
  const chip = args.filter(function (a) { return a.agents.length > 0; });
  assert.equal(chip.length, 5, 'one chip warm per dept');
  chip.forEach(function (a) {
    assert.equal(a.from, '2026-08-31'); assert.equal(a.to, '2026-08-31');
    assert.deepEqual(a.agents, ['Bo', 'Ann'], 'the ACTIVE list the picker ticks');
  });
  assert.equal(args.filter(function (a) { return a.agents.length === 0; }).length, 5, 'the agent-free dept default stays');
  assert.ok(args.every(function (a) { return a.from === a.to; }), 'no 30-day launcher window any more');
  // Nobody active: the picker ticks everyone, so the warm does too.
  const r2 = run({ overviewMin: 0.1, summaryMin: 0.1, init: function () { return { agents: ['Ann', 'Bo'], activeAgents: [] }; } });
  const chip2 = JSON.parse(JSON.stringify(r2.calls.insightsArgs)).filter(function (a) { return a.agents.length > 0; });
  assert.deepEqual(chip2[0].agents, ['Ann', 'Bo']);
});


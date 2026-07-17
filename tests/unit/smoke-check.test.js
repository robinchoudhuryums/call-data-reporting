'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

// Live smoke harness (SmokeCheck.gs, Batch 10). The point here is the
// HARNESS mechanics -- admin gate, per-check isolation, the skipped
// cascade, the OPS-8 prefix-coded result string, property + email
// side effects, telemetry suppression -- not the compute helpers it
// exercises (each is stubbed; they have their own suites).

const h = loadGas({ files: ['Config.gs', 'Util.gs', 'Auth.gs', 'SmokeCheck.gs'] });

function install(opts) {
  opts = opts || {};
  h.state.userEmail = opts.email || 'admin@x.com';
  h.state.props = { SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' };
  if (opts.props) Object.keys(opts.props).forEach(function (k) { h.state.props[k] = opts.props[k]; });
  h.state.sentEmails.length = 0;
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {
    'DQE Historical Data': [['h'], ['r1'], ['r2']],
  } });
  // Healthy stubs; individual tests override.
  h.ctx.getLatestDataDate = function () { return '2026-07-16'; };
  h.ctx.getDqeReadSource_ = function () { return 'sheet'; };
  h.ctx.getAllDepartments_ = function () { return ['CSR', 'Sales']; };
  h.ctx.computeSummary_ = function () { return { rows: [{}, {}] }; };
  h.ctx.computeMissedCallsReport_ = function () {
    return { meta: { totalMissed: 3, abandonedCallCount: 1, abandonedDetailLost: false } };
  };
  h.ctx.getRosterForDepartment_ = function () { return { names: ['Anna', 'Bob'] }; };
  h.ctx.resolveInsightsAgents_ = function (raw, roster) { return roster.names.slice(); };
  h.ctx.computeInsights_ = function () { return { teamStats: {}, queueHealth: {} }; };
  h.ctx.getLatestDataDates = function () { return { dqe: '2026-07-16', qcd: '2026-07-16' }; };
  h.ctx.computeQcdAllDepartments_ = function () {
    return { depts: [{}, {}, {}], grandTotals: { totalCalls: 42 } };
  };
}

function byName(res, name) {
  return res.checks.filter(function (c) { return c.name === name; })[0];
}

test('smoke: admin-gated at the server boundary', function () {
  install({ email: 'stranger@x.com' });
  assert.throws(function () { h.call('runLiveSmoke'); }, /admin/i);
});

test('smoke: healthy install -> every check passes, ok-prefixed result, property + email recorded', function () {
  install();
  const res = h.call('runLiveSmoke');
  assert.equal(res.checks.length, 7);
  res.checks.forEach(function (c) { assert.ok(c.ok, c.name + ' should pass: ' + c.note); });
  assert.deepEqual(Array.from(res.checks.map(function (c) { return c.name; })),
    ['sheet-open', 'latest-dqe-date', 'dept-summary', 'missed-report',
     'insights', 'qcd-alldept', 'neon']);
  assert.match(res.summary, /^ok 7\/7 \| /, 'OPS-8 prefix: healthy run leads with ok');
  assert.equal(h.state.props.SMOKE_LAST_RESULT, res.summary);
  assert.ok(h.state.props.SMOKE_LAST, 'SMOKE_LAST timestamp recorded');
  assert.equal(h.state.sentEmails.length, 1, 'result email sent');
  assert.equal(h.state.sentEmails[0], 'admin@x.com', 'sent to getAdminEmails_()');
  // Unconfigured Neon is an informational pass, not a failure.
  assert.equal(byName(res, 'neon').note, 'n/a (Neon unconfigured)');
});

test('smoke: a failed prerequisite cascades as labeled skips, result leads with FAILED', function () {
  install();
  h.ctx.getLatestDataDate = function () { return 'garbage'; };
  const res = h.call('runLiveSmoke');
  assert.equal(byName(res, 'sheet-open').ok, true, 'independent check still passes');
  assert.equal(byName(res, 'latest-dqe-date').ok, false);
  assert.match(byName(res, 'dept-summary').note, /^skipped:/);
  assert.match(byName(res, 'missed-report').note, /^skipped:/);
  assert.match(byName(res, 'insights').note, /^skipped:/);
  assert.equal(byName(res, 'qcd-alldept').ok, true, 'qcd path is independent of the DQE latest date');
  assert.match(res.summary, /^FAILED 4\/7 \| /, 'OPS-8 prefix: failing run leads with FAILED');
});

test('smoke: a throwing check degrades to its own FAIL (never aborts the sweep)', function () {
  install();
  h.ctx.computeSummary_ = function () { throw new Error('roster exploded'); };
  const res = h.call('runLiveSmoke');
  const c = byName(res, 'dept-summary');
  assert.equal(c.ok, false);
  assert.match(c.note, /roster exploded/);
  // dept was resolved before the throw, so the dependents still run.
  assert.equal(byName(res, 'missed-report').ok, true);
  assert.equal(byName(res, 'insights').ok, true);
});

test('smoke: configured-but-unreachable Neon is a FAIL (unlike unconfigured)', function () {
  install({ props: { NEON_HOST: 'h' } });
  h.ctx.getDashboardNeonConn_ = function () { return null; };
  const res = h.call('runLiveSmoke');
  const c = byName(res, 'neon');
  assert.equal(c.ok, false);
  assert.match(c.note, /unreachable/);
});

test('smoke: Report Usage telemetry is suppressed during the run and restored after (F-27)', function () {
  install();
  let flagDuring = null;
  h.ctx.computeSummary_ = function () {
    flagDuring = h.ctx.REPORT_USAGE_SUPPRESS_;
    return { rows: [] };
  };
  h.call('runLiveSmoke');
  assert.equal(flagDuring, true, 'suppress flag set while checks run');
  assert.equal(h.ctx.REPORT_USAGE_SUPPRESS_, false, 'restored after the run');
});

test('smoke: insights window = 7 days ending on the latest date (noon-anchored ISO math)', function () {
  install();
  let seen = null;
  h.ctx.computeInsights_ = function (dept, from, to) {
    seen = { dept: dept, from: from, to: to };
    return { teamStats: {} };
  };
  h.call('runLiveSmoke');
  assert.deepEqual({ dept: seen.dept, from: seen.from, to: seen.to },
    { dept: 'CSR', from: '2026-07-10', to: '2026-07-16' });
  // Month/year boundaries.
  assert.equal(h.call('smokeShiftIso_', '2026-07-01', -1), '2026-06-30');
  assert.equal(h.call('smokeShiftIso_', '2026-01-01', -1), '2025-12-31');
});

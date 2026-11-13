'use strict';

// P5 (owner 2026-11-13): the custodial roster column ("Other") -- a home for
// people with call records who belong to no call-handling team. It must stay
// a real department by NAME (My Department, the reports, Access Control) and
// be skipped by the three surfaces that walk EVERY department: the Overview,
// the coaching flags / gates, and cache warming.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadGas, DASHBOARD_DIR } = require('../harness/loadGas');

const plain = (x) => JSON.parse(JSON.stringify(x));

test('P5: the custodial list is exact-match, and every custodial department is hidden from the Overview', function () {
  const h = loadGas({ files: ['Config.gs', 'Util.gs', 'CompanyOverview.gs'], capture: ['CUSTODIAL_DEPTS', 'OVERVIEW_HIDDEN_DEPTS'] });
  const custodial = plain(h.consts.CUSTODIAL_DEPTS), hidden = plain(h.consts.OVERVIEW_HIDDEN_DEPTS);
  assert.deepEqual(custodial, ['Other']);
  custodial.forEach(function (d) {
    assert.ok(hidden.indexOf(d) !== -1, d + ' must be listed in OVERVIEW_HIDDEN_DEPTS (no tile, no chart line, out of the company aggregate)');
    assert.equal(h.call('ovDeptVisibleForCompany_', d), false);
    assert.equal(h.call('isCustodialDept_', d), true);
  });
  ['other', 'Other ', 'OTHER', 'Others', '', null, undefined, 'CSR', 'CSR Backup'].forEach(function (d) {
    assert.equal(h.call('isCustodialDept_', d), false, 'exact header match only: ' + JSON.stringify(d));
  });
  assert.equal(h.call('ovDeptVisibleForCompany_', 'CSR'), true);
});

test('P5: the hidden list spells the department out -- a top-level reference across files depends on load order', function () {
  const src = fs.readFileSync(path.join(DASHBOARD_DIR, 'CompanyOverview.gs'), 'utf8');
  const decl = src.match(/const OVERVIEW_HIDDEN_DEPTS = ([^;]+);/);
  assert.ok(decl, 'the declaration is where it was');
  assert.ok(!/CUSTODIAL_DEPTS/.test(decl[1]), 'CompanyOverview.gs loads before Config.gs; a concat here would throw at load');
});

test('P5: the coaching scan and the gates list never touch a custodial department', function () {
  const h = loadGas({ files: ['Config.gs', 'Util.gs', 'Coaching.gs'] });
  h.state.userEmail = 'admin@x.com';
  h.state.props = { SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' };
  h.ctx.resolveUser_ = function () { return { email: 'admin@x.com', role: 'admin' }; };
  h.ctx.getLatestDataDate = function () { return '2026-07-20'; };
  h.ctx.getAllDepartments_ = function () { return ['CSR', 'Other', 'Sales']; };
  h.ctx.getTeamAvgExcludes_ = function () { return []; };
  const scanned = [];
  const row = function (agent, a, m) { return { agent: agent, matchedViaRoster: true, totalAnswered: a, totalMissed: m, totalRung: a + m }; };
  h.ctx.computeSummary_ = function (dept) {
    scanned.push(dept);
    // The same flaggable shape in every department: one strong agent, one far behind.
    return { rows: [row('Strong ' + dept, 180, 20), row('Low ' + dept, 15, 55)] };
  };
  const out = h.call('previewCoachingFlags');
  assert.deepEqual(scanned, ['CSR', 'Sales'], 'Other is not even read');
  assert.deepEqual(plain(out.flags.map(function (f) { return f.dept; })).sort(), ['CSR', 'Sales']);
  assert.equal(out.errors.length, 0);

  h.ctx.coachingEffectiveGates_ = function (d) { return { dept: d }; };
  assert.deepEqual(Object.keys(plain(h.call('coachingAllDeptGates_'))).sort(), ['CSR', 'Sales'], 'no gate row to edit for it');
});

test('P5: cache warming skips a custodial department in every phase', function () {
  const h = loadGas({ files: ['Config.gs', 'CacheWarm.gs'] });
  const seen = { summary: [], insights: [], init: [] };
  h.state.props = {};
  h.ctx.getLatestDataDate = function () { return '2026-08-31'; };
  h.ctx.getLatestDataDates = function () { return { qcd: '2026-08-31', dqe: '2026-08-31' }; };
  h.ctx.getAllDepartments_ = function () { return ['A', 'Other', 'B']; };
  h.ctx.getCompanyOverview = function () { h.ctx.noteReportCache_('write'); };
  h.ctx.getDepartmentSummary = function (req) { seen.summary.push(req.department); h.ctx.noteReportCache_('write'); };
  h.ctx.getQcdAllDepartments = function () { h.ctx.noteReportCache_('write'); };
  h.ctx.getInsightsReport = function (req) { seen.insights.push(req.department); h.ctx.noteReportCache_('write'); };
  h.ctx.prevBusinessDayIso_ = function () { return '2026-08-31'; };
  h.ctx.getInsightsReportInit = function (req) { seen.init.push(req.department); return { agents: ['Ann'], activeAgents: ['Ann'] }; };
  h.call('warmReportCaches_');
  assert.deepEqual(seen.summary, ['A', 'B']);
  assert.ok(seen.insights.length > 0 && seen.insights.indexOf('Other') === -1, 'no Insights run for it: ' + seen.insights.join(','));
  assert.ok(seen.init.indexOf('Other') === -1);
  assert.match(String(h.state.props.CACHE_WARM_LAST_RESULT), /^ok /);
});

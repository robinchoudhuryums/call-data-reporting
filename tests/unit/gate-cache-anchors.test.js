'use strict';

// GCA-1..8 (broad scan 2026-11-09, Batch 6: the release-gate tools and the
// cache anchors) and RUN-9..11 (the Batch 5 follow-ons). This suite holds the
// halves with no fixture of their own elsewhere:
//
//   GCA-3   the Overview blob is held briefly, not for 6 h, when Neon is
//           configured and the tile-line read came back short.
//   GCA-6   a daily alert run that SENT drops the Overview blob, so the tiles'
//           "alerted" flag is not stuck off for the TTL.
//   GCA-8   the three cache puts that skipped silently past the size guard say so.
//   RUN-10  an Alert Config / Dept Config read that fell back to the sheet
//           under CONFIG_SOURCE=neon is flagged (the alerts outcome leads WARN).
//   RUN-11  the queue report's claim release runs under the script lock.
//
// Beside their fixtures: GCA-1 / GCA-2 / GCA-5 in outbound-report.test.js,
// GCA-4 in inbound-qcd-parity.test.js, GCA-7 in direct-fallback.test.js,
// RUN-9 in engine-runs.test.js, RUN-10's Health row in system-health.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { rosterGrid } = require('../harness/fixtures');

const DASH = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');
const src = function (f) { return fs.readFileSync(path.join(DASH, f), 'utf8'); };

// ── GCA-3: the Overview blob's tier ─────────────────────────────────────────
test('GCA-3: an Overview blob missing its Neon tile lines is cached for ten minutes, not six hours', function () {
  const h = loadGas({ files: ['Config.gs', 'Util.gs', 'DeptConfig.gs', 'CompanyOverview.gs', 'Data.gs'] });
  const LATEST = '2026-09-21';
  const run = function (props, conn, parts) {
    h.state.userEmail = 'admin@x.com';
    h.state.props = Object.assign({ SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' }, props || {});
    h.state.cache.clear();
    Object.keys(h.state.cacheTtls).forEach(function (k) { delete h.state.cacheTtls[k]; });
    h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {
      'DO NOT EDIT!': rosterGrid({ Service: ['Anna, 301'] }),
      'DQE Historical Data': [['h'], ['x']],
      'Alert Log': [['Timestamp', 'Dept', 'Date', 'Rate', 'Threshold', 'Status', 'Sent', 'Triggered By']] } });
    h.ctx.getAllDepartments_ = function () { return ['Service']; };
    h.ctx.resolveUser_ = function () { return { email: 'admin@x.com', role: 'admin', department: null, departments: ['Service'] }; };
    h.ctx.getLatestDataDate = function () { return LATEST; };
    h.ctx.getDqeReadSource_ = function () { return 'sheet'; };
    h.ctx.inboundQueuesForDept_ = function () { return []; };
    h.ctx.sheetFetchDqeRows_ = function () {
      return [{ dateIso: LATEST, agent: 'Anna', totalUnique: 30, totalRung: 30, totalMissed: 3, totalAnswered: 27,
                tttSec: 2430, attSec: 90, avgAbdWaitSec: 0, csrAvgAbdWaitSec: 0, queueSplit: '' }];
    };
    h.ctx.computeQcdSnapshots_ = function () { return { _companyDaily: {} }; };
    ['computeOverviewPipelineFreshness_', 'computeOverviewOrphanNag_', 'computeOverviewUnmappedQcd_'].forEach(function (k) {
      h.ctx[k] = function () { return null; };
    });
    h.ctx.logReportUsage_ = function () {};
    h.ctx.getDashboardNeonConn_ = function () { return conn; };
    h.ctx.ovReadOutboundByDept_ = function () { return parts ? parts.outbound : null; };
    h.ctx.ovReadDirectByDept_ = function () { return parts ? parts.direct : null; };
    h.call('getCompanyOverview', {});
    const keys = Object.keys(h.state.cacheTtls).filter(function (k) { return /^companyOverview:v\d+/.test(k); });
    assert.equal(keys.length, 1, 'the blob was cached once');
    return h.state.cacheTtls[keys[0]];
  };
  const conn = { close: function () {} };
  assert.equal(run({ NEON_HOST: 'ep.neon' }, null), 600, 'Neon configured but unreachable: held briefly (was 6 h)');
  assert.equal(run({ NEON_HOST: 'ep.neon' }, conn, { outbound: {}, direct: null }), 600, 'one of the two reads failed');
  assert.equal(run({ NEON_HOST: 'ep.neon' }, conn, { outbound: {}, direct: {} }), 6 * 3600, 'both lines read: the full tier');
  assert.equal(run({}, null), 6 * 3600, 'no Neon on this install: there is no line to wait for');
});

// ── GCA-6 / RUN-10 (alerts) ─────────────────────────────────────────────────
const al = loadGas({ files: ['Config.gs', 'Util.gs', 'EmailKit.gs', 'DeptConfig.gs', 'Alerts.gs', 'Notifications.gs', 'SystemHealth.gs'] });
function installAl(props) {
  al.state.userEmail = 'admin@x.com';
  al.state.props = Object.assign({ SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' }, props || {});
  al.state.sentEmails.length = 0;
  al.state.cache.clear();
  al.state.spreadsheet = makeFakeSpreadsheet({ sheets: {
    'Alert Config': [['Department', 'Threshold %', 'Extra Recipients', 'Active', 'Notes', 'Skip Dates'], ['CSR', 80, '', 'TRUE', '', '']],
    'Alert Log': [['Timestamp', 'Department', 'Date Checked', 'Threshold', 'Answer Rate', 'Sent', 'Recipients', 'Triggered By', 'Notes', 'Status']],
    'Access Control': [['Email', 'Department', 'Notes'], ['csr.mgr@x.com', 'CSR', '']],
    'Exception Days': [['Date', 'Departments', 'Reason', 'Active', 'Added By', 'Added At']],
    'Dept Config': [['Department', 'QCD Queues', 'Overview Parent', 'Team Avg Excludes', 'Queue Ext Overrides', 'Active', 'Updated By', 'Updated At', 'Notes'],
      ['CSR', 'A_Q_CSR', '', '', '', 'TRUE', 'a', '', '']],
  } });
  al.ctx.EXCEPTION_DAYS_MEMO_ = null;
  al.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  al.ctx.getAllDepartments_ = function () { return ['CSR']; };
  al.ctx.resolveUser_ = function (email) { return { email: email, role: email === 'admin@x.com' ? 'admin' : 'none' }; };
  al.ctx.isIsoDate_ = function (v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v)); };
  al.ctx.getRosterForDepartment_ = function () { return { names: ['Ann'] }; };
  al.ctx.isCompanyHoliday_ = function () { return false; };
  al.ctx.alertRowsForRange_ = function () { return {}; };
  al.ctx.sendAlertEmail_ = function () {};
  al.ctx.overviewCacheKey_ = function () { return 'companyOverview:test-key'; };
}
function stubRate(pct) {
  al.ctx.computeDeptAnswerRateForDate_ = function () {
    return { rung: 100, answered: pct, missed: 100 - pct, pct: pct, lowAgents: [], agents: [] };
  };
}

test('GCA-6: a run that sent an alert drops the Overview blob; a preview or a quiet run leaves it', function () {
  const KEY = 'companyOverview:test-key';
  installAl(); stubRate(50);
  al.state.cache.set(KEY, 'blob-before-the-run');
  al.call('runAlertsCore_', '2026-10-14', true, 'admin@x.com');           // preview
  assert.equal(al.state.cache.has(KEY), true, 'a preview sends nothing, so the flags did not change');
  al.call('runAlertsCore_', '2026-10-14', false, 'daily-trigger');        // the real run, below threshold
  assert.equal(al.state.cache.has(KEY), false, 'the next Overview load recomputes with the alerted flag (was: stuck off for the TTL)');

  installAl(); stubRate(95);
  al.state.cache.set(KEY, 'blob');
  const res = al.call('runAlertsCore_', '2026-10-14', false, 'daily-trigger');
  assert.equal(res[0].status, 'above-threshold');
  assert.equal(al.state.cache.has(KEY), true, 'nothing was sent: nothing to bust');

  // A failing bust never fails the run.
  installAl(); stubRate(50);
  al.ctx.overviewCacheKey_ = function () { throw new Error('not signed in'); };
  assert.doesNotThrow(function () { al.call('runAlertsCore_', '2026-10-14', false, 'daily-trigger'); });
});

test('RUN-10: an Alert Config read that fell back to the sheet under CONFIG_SOURCE=neon is flagged, and the run leads WARN', function () {
  installAl({ CONFIG_SOURCE: 'neon' });
  const realNeon = al.ctx.neonAlertConfigRawValues_;
  try {
    al.ctx.neonAlertConfigRawValues_ = function () { return null; };   // unreachable
    const cfg = al.call('readAlertConfig_');
    assert.equal(cfg.length, 1, 'the sheet\'s rules still run the alerts');
    assert.equal(al.call('alertConfigFellBack_'), true);
    al.ctx.neonAlertConfigRawValues_ = function () { return [['CSR', 80, '', true, '', '']]; };
    al.call('readAlertConfig_');
    assert.equal(al.call('alertConfigFellBack_'), false, 'a read Neon answered clears it');
  } finally { al.ctx.neonAlertConfigRawValues_ = realNeon; }
  installAl();   // CONFIG_SOURCE=sheet: the sheet IS the source
  al.call('readAlertConfig_');
  assert.equal(al.call('alertConfigFellBack_'), false);

  const rows = [{ department: 'CSR', status: 'above-threshold' }];
  const warn = al.call('alertsOutcomeString_', '2026-10-14', rows, { configFellBack: true });
  assert.match(warn, /^WARN 2026-10-14: the alert rules were read from the Alert Config SHEET because Neon was unreachable/);
  assert.equal(al.call('healthOutcomeIsBad_', warn), true);
  assert.match(al.call('alertsOutcomeString_', '2026-10-14', rows, {}), /^ok 2026-10-14: /);
  // A real failure still leads.
  assert.match(al.call('alertsOutcomeString_', '2026-10-14', [{ department: 'CSR', status: 'error' }], { configFellBack: true }), /^FAILED-PARTIAL /);
  assert.match(src('Alerts.gs'), /if \(alertConfigFellBack_\(\)\) finalOpts\.configFellBack = true;/, 'the daily trigger passes it');
});

test('RUN-10: a Dept Config read that fell back to the sheet under CONFIG_SOURCE=neon is flagged', function () {
  installAl({ CONFIG_SOURCE: 'neon' });
  const realNeon = al.ctx.neonReadDeptConfigRows_;
  try {
    al.ctx.neonReadDeptConfigRows_ = function () { return null; };
    const state = al.inExecution(function () {
      const rows = al.call('readDeptConfigRows_');
      return { n: rows.length, fell: al.call('deptConfigFellBack_') };
    });
    assert.equal(state.n, 1, 'the sheet row is served');
    assert.equal(state.fell, true);
    al.ctx.neonReadDeptConfigRows_ = function () { return []; };
    assert.equal(al.inExecution(function () { al.call('readDeptConfigRows_'); return al.call('deptConfigFellBack_'); }), false);
  } finally { al.ctx.neonReadDeptConfigRows_ = realNeon; }
  installAl();
  assert.equal(al.inExecution(function () { al.call('readDeptConfigRows_'); return al.call('deptConfigFellBack_'); }), false,
    'CONFIG_SOURCE=sheet never sets it');
});

// ── RUN-11 ──────────────────────────────────────────────────────────────────
test('RUN-11: the queue report claim is released under the script lock, and still released when the lock is busy', function () {
  const h = loadGas({ files: ['Config.gs', 'Util.gs', 'Auth.gs', 'Data.gs', 'QueueReportEmail.gs'] });
  h.state.props = { SPREADSHEET_ID: 'fake' };
  const props = h.ctx.PropertiesService.getScriptProperties();
  const a = h.call('queueReportClaimSend_', props, '2026-07-10', false);
  const before = h.state.locks;
  h.call('queueReportReleaseSend_', props, a.token);
  assert.equal(h.state.locks, before + 1, 'the compare-then-delete takes the lock the claim takes');
  assert.equal(h.state.props.QUEUE_REPORT_SENDING, undefined);
  assert.equal(h.state.lockHeld, false, 'and gives it back');
  // A busy lock: the release still happens (the stale-claim rule covers a miss).
  const b = h.call('queueReportClaimSend_', props, '2026-07-10', false);
  h.state.lockBusy = true;
  try { h.call('queueReportReleaseSend_', props, b.token); } finally { h.state.lockBusy = false; }
  assert.equal(h.state.props.QUEUE_REPORT_SENDING, undefined);
});

// ── GCA-8 ───────────────────────────────────────────────────────────────────
test('GCA-8: the three cache puts that skip past the size guard now say so', function () {
  assert.match(src('QCDReport.gs'), /over the 100000-byte cache guard -- NOT cached/);
  assert.match(src('CompanyOverview.gs'), /over the 92000-byte cache guard -- '\s*\n\s*\+ 'NOT cached/);
  assert.match(src('NeonRead.gs'), /neonGetAgentExtPairs_: cache put failed at /);
  assert.doesNotMatch(src('NeonRead.gs'), /catch \(ce\) \{ \/\* harmless \*\/ \}/);

  // Behaviour, on the all-department report: an over-size payload is logged, not cached.
  const h = loadGas({ files: ['Config.gs', 'Util.gs', 'Auth.gs', 'DeptConfig.gs', 'Data.gs', 'QCDReport.gs'] });
  h.state.props = { SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' };
  h.state.cache.clear();
  const logs = [];
  h.ctx.Logger = { log: function (m) { logs.push(String(m)); } };
  h.ctx.qcdAllFreshnessAnchor_ = function () { return '2026-06-10'; };
  h.ctx.computeQcdAllDepartments_ = function () {
    return { depts: [{ dept: 'CSR', pad: 'x'.repeat(100500) }], meta: {} };
  };
  const out = h.call('qcdAllDeptCachedData_', '2026-06-10', '2026-06-10', {});
  assert.equal(out.cacheHit, false);
  assert.equal(Array.from(h.state.cache.keys()).filter(function (k) { return /^qcdAll:/.test(k); }).length, 0);
  assert.ok(logs.some(function (l) { return /over the 100000-byte cache guard -- NOT cached/.test(l); }), logs.join(' | '));
});

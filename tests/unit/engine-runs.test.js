'use strict';

// RUN-1..8 (broad scan 2026-11-09, Batch 5): the scheduled engines' own
// outcomes. This suite holds the alert / digest / queue-report halves; the
// coaching, all-department budget and smoke halves sit beside their fixtures
// (coaching.test.js RUN-2 / RUN-6, qcd-report.test.js RUN-3,
// smoke-check.test.js RUN-8).
//
//   RUN-1  the "callers not called back" reason is judged against the calls
//          LOADED: a caller who tried again is a miss, not "cannot be judged".
//          Runs the REAL episode engine (only the SQL fetch is faked).
//   RUN-2  a reason that could not be checked turns the run outcome bad.
//   RUN-4  the run marker and an interim outcome are written BEFORE the
//          reasons run.
//   RUN-5  a digest sent from the sheet because Neon (CONFIG_SOURCE=neon) was
//          unreachable says so and does not read ok.
//   RUN-7  the queue report's in-flight claim is released only by its owner.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { dqeRow, dqeSheet, rosterGrid } = require('../harness/fixtures');

const J = (x) => JSON.parse(JSON.stringify(x));

// ── RUN-1: the callbacks reason over the real engine ────────────────────────
const cb = loadGas({ files: ['Config.gs', 'Util.gs', 'Auth.gs', 'NeonCoverage.gs', 'EmailKit.gs', 'Alerts.gs', 'Notifications.gs',
  'AlertReasons.gs', 'InboundReport.gs', 'OutboundReport.gs'] });
// Mon 2026-10-12: three callers could not get through on the CSR queue.
//   k1 tries again Tue 10-13 at 10:00 -- still nobody calls them back.
//   k2 never hears from anyone.
//   k3 is called back by Ann (CSR) the same morning.
const BLOB = {
  cbCounts: [],
  cbAb: [
    [1, '2026-10-12', '09:00:00', 'a_q_csr', 'c1', true],
    [1, '2026-10-13', '10:00:00', 'a_q_csr', 'c1b', true],
    [2, '2026-10-12', '11:00:00', 'a_q_csr', 'c2', true],
    [3, '2026-10-12', '08:00:00', 'a_q_csr', 'c3', true],
  ],
  cbOb: [[3, '2026-10-12', '08:30:00', 'o3', 'Ann', true]],
  cbAns: [],
};
function installCb(through, props) {
  cb.state.userEmail = 'admin@x.com';
  cb.state.props = Object.assign({ SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' }, props || {});
  cb.state.sentEmails.length = 0;
  cb.state.spreadsheet = makeFakeSpreadsheet({ sheets: {
    'Alert Config': [['Department', 'Threshold %', 'Extra Recipients', 'Active', 'Notes', 'Skip Dates'], ['CSR', 80, '', 'TRUE', '', '']],
    'Alert Log': [['Timestamp', 'Department', 'Date Checked', 'Threshold', 'Answer Rate', 'Sent', 'Recipients', 'Triggered By', 'Notes', 'Status']],
    'Exception Days': [['Date', 'Departments', 'Reason', 'Active', 'Added By', 'Added At']],
  } });
  cb.state.cache.clear();
  cb.ctx.ALERT_REASON_RULES_MEMO_ = null;
  cb.ctx.EXCEPTION_DAYS_MEMO_ = null;
  const sqlSeen = [];
  cb.ctx.getDashboardNeonConn_ = function () {
    return {
      createStatement: function () {
        return {
          executeQuery: function (sql) {
            sqlSeen.push(sql);
            let read = false;
            return { next: function () { if (read) return false; read = true; return true; },
                     getString: function () { return JSON.stringify(Object.assign({ cbThrough: through }, BLOB)); },
                     close: function () {} };
          },
          close: function () {},
        };
      },
      close: function () {},
    };
  };
  cb.ctx.inboundQueuesForDept_ = function () { return ['A_Q_CSR']; };
  cb.ctx.obCallbackDeptMap_ = function () { return { ownersOf: { a_q_csr: ['CSR'] }, parentOf: {}, childrenOf: {} }; };
  cb.ctx.buildDeptsByAgent_ = function () { return { Ann: ['CSR'] }; };
  cb.ctx.obTodayIso_ = function () { return '2026-10-14'; };   // the run happens Wed morning
  cb.ctx.getAllDepartments_ = function () { return ['CSR']; };
  cb.ctx.isCompanyHoliday_ = function () { return false; };
  cb.ctx.getRosterForDepartment_ = function () { return { names: ['Ann'] }; };
  return sqlSeen;
}

test('RUN-1: a caller who tried again on the assessed day is a MISS once the calls are loaded (real engine)', function () {
  const sql = installCb('2026-10-13');
  const out = J(cb.call('alertCallbackMisses_', 'CSR', '2026-10-12', '2026-10-13'));
  assert.equal(sql.length, 1, 'one read');
  assert.equal(out.available, true);
  assert.equal(out.total, 3);
  assert.equal(out.pending, 0, 'nothing is "not loaded" -- both tables are through the assessed day');
  assert.deepEqual(out.missed.map(function (m) { return [m.firstHms, m.attempts]; }),
    [['09:00:00', 2], ['11:00:00', 1]], 'the repeat caller (2 attempts) and the one nobody called; Ann\'s callback is handled');
  assert.equal(out.dataThrough, '2026-10-13');
  // The engine itself still calls the repeat caller's episode pending (its
  // deadline moved with the second attempt) -- that is what used to be read
  // as "cannot be judged".
  const list = cb.call('obCallbackListEpisodes_', cb.ctx.getDashboardNeonConn_(),
    { from: '2026-10-12', to: '2026-10-12', dept: 'CSR', companyView: false, scopeDepts: ['CSR'] }, 0, 1);
  assert.deepEqual(J(list.eps).map(function (e) { return e.outcome; }).sort(), ['none', 'own', 'pending']);
});

test('RUN-1: with the assessed day NOT loaded the callers stay unjudged, and the note says what is loaded', function () {
  installCb('2026-10-12');
  const out = J(cb.call('alertCallbackMisses_', 'CSR', '2026-10-12', '2026-10-13'));
  assert.equal(out.pending, 2, 'k1 and k2: Tuesday\'s dials are not in the data yet');
  assert.equal(out.missed.length, 0);
  // An unknown load date falls back to the engine's own rule (through
  // yesterday), so the two never disagree about what "pending" means.
  installCb(null);
  const unk = J(cb.call('alertCallbackMisses_', 'CSR', '2026-10-12', '2026-10-13'));
  assert.equal(unk.pending, 0);
  assert.equal(unk.missed.length, 2);
  // Run on the assessed day itself (yesterday is the 12th): not loaded yet.
  installCb('2026-10-13');
  cb.ctx.obTodayIso_ = function () { return '2026-10-13'; };
  assert.equal(J(cb.call('alertCallbackMisses_', 'CSR', '2026-10-12', '2026-10-13')).pending, 2);
});

test('RUN-1 / RUN-2: the reason run emails the misses; an unloaded day is skipped and flagged unevaluated', function () {
  const rules = { ALERT_REASON_RULES: JSON.stringify({ CSR: { callbacks: { minCallers: 2 } } }) };
  installCb('2026-10-13', rules);
  let rows = [];
  cb.call('runAlertReasons_', '2026-10-13', false, false, [], function (r) { rows.push(J(r)); });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'sent', 'two callers were not called back (was: skipped, "calls are not loaded")');
  assert.match(rows[0].notes, /2 of 3 caller\(s\) who could not get through on 2026-10-12 were not called back/);
  assert.equal(rows[0].unevaluated, undefined);
  const mail = cb.state.sentEmails.filter(function (m) { return !/^\[Copy\]/.test(m.subject); })[0];
  assert.match(mail.subject, /CSR: 2 callers not called back within a business day/);

  installCb('2026-10-12', rules);
  rows = [];
  cb.call('runAlertReasons_', '2026-10-13', false, false, [], function (r) { rows.push(J(r)); });
  assert.equal(rows[0].status, 'skipped');
  assert.equal(rows[0].unevaluated, true);
  assert.match(rows[0].notes, /cannot be judged yet -- the per-call data is loaded through 2026-10-12, not 2026-10-13/);
  assert.equal(cb.state.sentEmails.length, 0);

  installCb('2026-10-13', rules);
  cb.ctx.getDashboardNeonConn_ = function () { return null; };
  rows = [];
  cb.call('runAlertReasons_', '2026-10-13', false, false, [], function (r) { rows.push(J(r)); });
  assert.equal(rows[0].unevaluated, true, 'Neon unreachable: also not checked');
});

// ── RUN-2: the outcome string ───────────────────────────────────────────────
test('RUN-2: a reason that could not be checked makes the run INCONCLUSIVE; a configured skip does not', function () {
  const h = loadGas({ files: ['Config.gs', 'Util.gs', 'Alerts.gs', 'SystemHealth.gs'] });
  const dept = { department: 'CSR', status: 'above-threshold' };
  const unchecked = { department: 'CSR', reason: 'callbacks', status: 'skipped', unevaluated: true };
  const skipDate = { department: 'CSR', reason: 'callbacks', status: 'skipped' };
  const quiet = { department: 'Sales', reason: 'agent-low', status: 'quiet' };
  const bad = h.call('alertsOutcomeString_', '2026-10-13', [dept, unchecked, quiet]);
  assert.match(bad, /^INCONCLUSIVE 2026-10-13: 1 alert reason\(s\) could not be checked/);
  assert.match(bad, /reasons: 1 checked, 0 fired, 1 not checked/);
  assert.equal(h.call('healthOutcomeIsBad_', bad), true, 'the Health row needs attention (was ok)');
  const ok = h.call('alertsOutcomeString_', '2026-10-13', [dept, skipDate, quiet]);
  assert.match(ok, /^ok 2026-10-13: /, 'a skip date or an exception day is configuration, not a failed check');
  assert.match(ok, /reasons: 2 checked, 0 fired\b/);
  // A department error still leads.
  assert.match(h.call('alertsOutcomeString_', '2026-10-13', [{ department: 'CSR', status: 'error' }, unchecked]), /^FAILED-PARTIAL /);
});

// ── RUN-4: the marker before the reasons ────────────────────────────────────
test('RUN-4: the core run calls afterDepts once, after the department rows and before the reasons', function () {
  installCb('2026-10-13', { ALERT_REASON_RULES: JSON.stringify({ CSR: { callbacks: { minCallers: 9 } } }) });
  cb.ctx.sendAlertEmail_ = function () {};
  cb.ctx.alertRowsForRange_ = function () { return {}; };
  cb.ctx.computeDeptAnswerRateForDate_ = function () { return { rung: 10, answered: 9, missed: 1, pct: 90, lowAgents: [], agents: [] }; };
  const order = [];
  const realReasons = cb.ctx.runAlertReasons_;
  cb.ctx.runAlertReasons_ = function () { order.push('reasons'); return realReasons.apply(null, arguments); };
  let res;
  try {
    res = cb.call('runAlertsCore_', '2026-10-13', false, 'daily-trigger', {
      afterDepts: function (soFar) { order.push('hook:' + soFar.length + ':' + soFar.filter(function (r) { return r.reason; }).length); },
    });
  } finally { cb.ctx.runAlertReasons_ = realReasons; }
  assert.deepEqual(order, ['hook:1:0', 'reasons'], 'one department row, no reason row yet');
  assert.equal(res.filter(function (r) { return r.reason; }).length, 1, 'the reasons still ran');
  // A throwing hook never fails the run; no hook is the old call shape.
  assert.doesNotThrow(function () {
    cb.call('runAlertsCore_', '2026-10-13', true, 'admin@x.com', { afterDepts: function () { throw new Error('boom'); } });
    cb.call('runAlertsCore_', '2026-10-13', true, 'admin@x.com');
  });
});

test('RUN-4: the daily trigger marks the date and records an interim outcome before the reasons can hang', function () {
  const h = loadGas({ files: ['Config.gs', 'Util.gs', 'Auth.gs', 'DeptConfig.gs', 'Alerts.gs', 'Digest.gs', 'SystemHealth.gs',
    'AlertReasons.gs'] });
  const install = function (props) {
    h.state.props = Object.assign({ SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' }, props || {});
    h.ctx.ALERT_REASON_RULES_MEMO_ = null;
    h.ctx.ScriptApp = { getProjectTriggers: function () { return []; }, deleteTrigger: function () {},
      newTrigger: function () { throw new Error('unused'); } };
    h.ctx.getCompanyHolidayRanges_ = function () { return []; };
    h.ctx.digestLatestDqeIso_ = function () { return '2026-09-21'; };
  };
  const at = new Date('2026-09-22T08:05:00-05:00');   // assesses Mon 2026-09-21
  const snap = {};
  const core = function (dateIso, dryRun, by, hooks) {
    const soFar = [{ department: 'CSR', status: 'sent' }];
    snap.before = { marker: h.state.props.ALERTS_RUN_MARKER, last: h.state.props.ALERTS_LAST_RESULT };
    hooks.afterDepts(soFar);
    snap.atHook = { marker: h.state.props.ALERTS_RUN_MARKER, last: h.state.props.ALERTS_LAST_RESULT };
    return soFar.concat([{ department: 'CSR', reason: 'callbacks', status: 'quiet' }]);
  };

  install({ ALERT_REASON_RULES: JSON.stringify({ CSR: { callbacks: { minCallers: 2 } } }) });
  h.ctx.runAlertsCore_ = core;
  h.call('alertsGatedAttempt_', at, 'trigger');
  assert.equal(snap.before.marker, undefined);
  assert.equal(snap.atHook.marker, '2026-09-21', 'the date is marked run before the reasons -- a stopped run is not re-sendable');
  assert.match(snap.atHook.last, /^INCONCLUSIVE 2026-09-21: the alert reasons had not finished when this was recorded; 1 dept\(s\) assessed, 1 fired/);
  assert.equal(h.call('healthOutcomeIsBad_', snap.atHook.last), true, 'a run stopped there does not read ok');
  assert.match(h.state.props.ALERTS_LAST_RESULT, /^ok 2026-09-21: .*reasons: 1 checked, 0 fired/, 'a finished run overwrites it');

  // With no reason rule there is nothing to wait for: the marker, no interim record.
  install();
  h.ctx.runAlertsCore_ = core;
  h.call('alertsGatedAttempt_', at, 'trigger');
  assert.equal(snap.atHook.marker, '2026-09-21');
  assert.equal(snap.atHook.last, undefined);
  assert.match(h.state.props.ALERTS_LAST_RESULT, /^ok 2026-09-21: /);
});

// ── RUN-5: the digest's subscriber list ─────────────────────────────────────
test('RUN-5: a digest run that read its subscribers from the sheet because Neon was down says so (WARN)', function () {
  const h = loadGas({ files: ['Config.gs', 'Util.gs', 'Auth.gs', 'CompanyOverview.gs', 'QCDReport.gs', 'DeptConfig.gs', 'Data.gs',
    'NeonRead.gs', 'InsightsReport.gs', 'Digest.gs', 'EmailKit.gs', 'SystemHealth.gs'] });
  const install = function (props) {
    h.state.props = Object.assign({ SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' }, props || {});
    h.state.sentEmails.length = 0;
    h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {
      'DO NOT EDIT!': rosterGrid({ Alpha: ['Anna, 201'] }),
      'DQE Historical Data': dqeSheet([dqeRow({ date: '2026-09-02', agent: 'Anna', ext: '201', rung: 10, missed: 1, answered: 9, att: '0:03:00' })]),
      'Digest Config': [['Email', 'Department', 'Cadence', 'Active', 'Notes', 'Format'], ['m@x.com', 'Alpha', 'daily', 'TRUE', '', 'summary']],
    } });
    ['DEPT_CONFIG_ROWS_MEMO_', 'DQE_DATE_BOUNDS_MEMO_', 'DQE_SHEET_ROWS_MEMO_', 'DQE_DATE_COL_MEMO_', 'DQE_EXT_GRID_MEMO_',
      'COMPANY_HOLIDAYS_MEMO_', 'EXCEPTION_DAYS_MEMO_'].forEach(function (k) { h.ctx[k] = null; });
    h.state.cache.clear();
    h.ctx.ScriptApp = { getProjectTriggers: function () { return []; }, deleteTrigger: function () {}, newTrigger: function () { throw new Error('unused'); } };
  };
  const win = { window: { fromIso: '2026-09-02', toIso: '2026-09-02' } };
  const realNeon = h.ctx.neonDigestConfigRawValues_;

  install({ CONFIG_SOURCE: 'neon' });
  h.ctx.neonDigestConfigRawValues_ = function () { return null; };   // unreachable
  h.call('sendDigestsForCadence_', 'daily', win);
  let res = h.state.props.DIGEST_LAST_RESULT_daily;
  assert.match(res, /^WARN 2026-09-02: sent 1 of 1 -- the subscriber list came from the Digest Config SHEET because Neon/);
  assert.equal(h.call('healthOutcomeIsBad_', res), true, 'needs attention on the Health page (was ok)');
  assert.equal(h.state.sentEmails.filter(function (m) { return m.to === 'm@x.com'; }).length, 1, 'the digest still went out');

  // Neon answered: a plain ok, from Neon's rows.
  install({ CONFIG_SOURCE: 'neon' });
  h.ctx.neonDigestConfigRawValues_ = function () { return [['n@x.com', 'Alpha', 'daily', true, '', 'summary']]; };
  h.call('sendDigestsForCadence_', 'daily', win);
  res = h.state.props.DIGEST_LAST_RESULT_daily;
  assert.match(res, /^ok 2026-09-02: sent 1 of 1/);
  assert.doesNotMatch(res, /SHEET/);
  assert.equal(h.state.sentEmails.filter(function (m) { return m.to === 'n@x.com'; }).length, 1);

  // CONFIG_SOURCE=sheet: the sheet IS the source -- no note.
  install();
  h.ctx.neonDigestConfigRawValues_ = function () { throw new Error('must not be read'); };
  h.call('sendDigestsForCadence_', 'daily', win);
  assert.match(h.state.props.DIGEST_LAST_RESULT_daily, /^ok 2026-09-02: sent 1 of 1/);
  h.ctx.neonDigestConfigRawValues_ = realNeon;
});

// ── RUN-7: the queue report's in-flight claim ───────────────────────────────
test('RUN-7: a late sender releases only its own claim, never the one that took over', function () {
  const h = loadGas({ files: ['Config.gs', 'Util.gs', 'Auth.gs', 'Data.gs', 'QueueReportEmail.gs'] });
  h.state.props = { SPREADSHEET_ID: 'fake' };
  const props = h.ctx.PropertiesService.getScriptProperties();
  const realNow = Date.now;
  let clock = realNow.call(Date);
  Date.now = function () { return clock; };
  try {
    const a = J(h.call('queueReportClaimSend_', props, '2026-07-10', false));
    assert.equal(a.ok, true);
    assert.equal(h.state.props.QUEUE_REPORT_SENDING, a.token);
    assert.equal(J(h.call('queueReportClaimSend_', props, '2026-07-10', false)).reason, 'in-flight');
    clock += 16 * 60000;   // A outlives the 15-minute stale window
    const b = J(h.call('queueReportClaimSend_', props, '2026-07-10', false));
    assert.equal(b.ok, true, 'B takes over the stale claim');
    assert.notEqual(b.token, a.token);
    h.call('queueReportReleaseSend_', props, a.token);   // A finally finishes
    assert.equal(h.state.props.QUEUE_REPORT_SENDING, b.token, 'B\'s claim survives (was deleted)');
    assert.equal(J(h.call('queueReportClaimSend_', props, '2026-07-10', false)).reason, 'in-flight', 'so a third sender still stands down');
    h.call('queueReportReleaseSend_', props, b.token);
    assert.equal(h.state.props.QUEUE_REPORT_SENDING, undefined, 'the owner\'s release clears it');
  } finally { Date.now = realNow; }
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'apps-script',
    'department-dashboard', 'QueueReportEmail.gs'), 'utf8');
  assert.equal((src.match(/queueReportReleaseSend_\(props, claim\.token\)/g) || []).length, 2, 'both senders pass their token');
  assert.doesNotMatch(src, /queueReportReleaseSend_\(props\);/);
});

// ── RUN-9 (Batch 5 follow-on) ───────────────────────────────────────────────
test('RUN-9: a callback made AFTER the assessed day does not count as handled when the check is run later', function () {
  // Mon 10-12 a caller cannot get through; they try again Tue 10-13 (which
  // keeps their episode open a day longer), and Ann calls them back Wed 10-14.
  // Asked "by the end of Tue 10-13", nobody had.
  const late = {
    cbCounts: [],
    cbAb: [[1, '2026-10-12', '09:00:00', 'a_q_csr', 'c1', true], [1, '2026-10-13', '09:00:00', 'a_q_csr', 'c1b', true]],
    cbOb: [[1, '2026-10-14', '10:00:00', 'o1', 'Ann', true]],
    cbAns: [],
    cbThrough: '2026-10-19',
  };
  installCb('2026-10-19');
  cb.ctx.obTodayIso_ = function () { return '2026-10-20'; };   // a re-run a week later
  cb.ctx.getDashboardNeonConn_ = function () {
    return { createStatement: function () {
      return { executeQuery: function () {
        let read = false;
        return { next: function () { if (read) return false; read = true; return true; },
                 getString: function () { return JSON.stringify(late); }, close: function () {} };
      }, close: function () {} };
    }, close: function () {} };
  };
  const out = J(cb.call('alertCallbackMisses_', 'CSR', '2026-10-12', '2026-10-13'));
  assert.equal(out.total, 1);
  assert.deepEqual(out.missed.map(function (m) { return [m.firstHms, m.attempts]; }), [['09:00:00', 2]],
    'two attempts and no callback by the end of the 13th (was: counted as handled by the callback on the 14th)');
  // Without the cutoff the engine would have called it handled.
  const scope = { from: '2026-10-12', to: '2026-10-12', dept: 'CSR', companyView: false, scopeDepts: ['CSR'] };
  const all = cb.call('obCallbackListEpisodes_', cb.ctx.getDashboardNeonConn_(), scope, 0, 1);
  assert.deepEqual(J(all.eps).map(function (e) { return e.outcome; }), ['own']);
  const cut = cb.call('obCallbackListEpisodes_', cb.ctx.getDashboardNeonConn_(), scope, 0, 1, '2026-10-13');
  assert.deepEqual(J(cut.eps).map(function (e) { return e.outcome; }), ['none']);
  assert.equal(cut.ev.ob.length, 0, 'the events themselves are cut, so the lists built from them agree');
});

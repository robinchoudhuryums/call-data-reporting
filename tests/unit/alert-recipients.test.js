'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

// B-5: low-answer-rate alert recipient resolution (Alerts.gs::
// lookupDeptManagers_). The exact-match dept comparison silently excluded
// ALL/'*'-sentinel managers (the all-departments role) from EVERY dept's
// alert; this suite is the function's first coverage.

const h = loadGas({ files: ['Config.gs', 'Util.gs', 'Auth.gs', 'DeptConfig.gs', 'Alerts.gs'] });

function install(rows) {
  h.state.props = { SPREADSHEET_ID: 'fake' };
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {
    'Access Control': [['Email', 'Department', 'Notes']].concat(rows),
  } });
}

test('EML-1: ALL/'+ '*-sentinel managers are OPT-IN only; dept managers always resolve', function () {
  const rows = [
    ['csr.mgr@x.com',   'CSR',   ''],
    ['sales.mgr@x.com', 'Sales', ''],
    ['ops.lead@x.com',  'ALL',   'all-departments manager'],
    ['star.lead@x.com', '*',     'sentinel variant'],
    ['blank@x.com',     '',      'no dept -> ignored'],
  ];
  install(rows);
  assert.deepEqual(JSON.parse(JSON.stringify(h.call('lookupDeptManagers_', 'CSR'))), ['csr.mgr@x.com'],
    'by default an ALL manager gets NO dept-manager email (owner ruling 2026-09-30, reverses B-5)');
  install(rows);
  h.state.props.ALL_DEPT_NOTIFY_OPT_IN = 'OPS.Lead@x.com; someone.else@x.com';
  const csr = h.call('lookupDeptManagers_', 'CSR');
  assert.deepEqual(JSON.parse(JSON.stringify(csr)), ['csr.mgr@x.com', 'ops.lead@x.com'],
    'an opted-in ALL manager (case-insensitive) receives it; the one not listed still does not');
  const sales = h.call('lookupDeptManagers_', 'Sales');
  assert.ok(sales.indexOf('ops.lead@x.com') !== -1, 'opt-in covers every dept');
  assert.ok(sales.indexOf('csr.mgr@x.com') === -1, 'single-dept manager stays scoped');
  assert.ok(sales.indexOf('someone.else@x.com') === -1, 'the opt-in list only filters ALL rows -- it never ADDS a recipient');
});

test('B-5: missing Access Control sheet -> empty recipient list (no throw)', function () {
  h.state.props = { SPREADSHEET_ID: 'fake' };
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {} });
  assert.deepEqual(JSON.parse(JSON.stringify(h.call('lookupDeptManagers_', 'CSR'))), []);
});

// P1 (broad-scan 2026-08-27): the recipient lookup used to read only cols 1-2,
// so a Role=agent row (which shares the Department column since Phase A) became
// a To: recipient of manager alerts whose body names each under-threshold
// teammate with per-agent numbers -- the teammate-identity disclosure the agent
// role's privacy contract forbids. Recipients are MANAGER rows only: blank Role
// = legacy manager (Auth.gs's own default), unknown roles fail closed.
test('P1: agent-role rows are NEVER alert recipients; blank role = manager; unknown role fails closed', function () {
  h.state.props = { SPREADSHEET_ID: 'fake' };
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {
    'Access Control': [
      ['Email', 'Department', 'Notes', 'Role', 'Agent Name'],
      ['csr.mgr@x.com',    'CSR', '', 'manager', ''],
      ['legacy.mgr@x.com', 'CSR', '', '',        ''],          // blank role -> manager
      ['csr.agent@x.com',  'CSR', '', 'agent',   'Jane Doe'],  // MUST be excluded
      ['weird.row@x.com',  'CSR', '', 'auditor', ''],          // unknown role -> fail closed
      ['all.agent@x.com',  'ALL', '', 'agent',   'Roy Kent'],  // agent + ALL sentinel -> still excluded
      ['ops.lead@x.com',   'ALL', '', 'Manager', 'case-insensitive role'],
    ],
  } });
  h.state.props.ALL_DEPT_NOTIFY_OPT_IN = 'ops.lead@x.com,all.agent@x.com';   // EML-1: opted in, so the role rule is what decides
  const csr = JSON.parse(JSON.stringify(h.call('lookupDeptManagers_', 'CSR')));
  assert.deepEqual(csr, ['csr.mgr@x.com', 'legacy.mgr@x.com', 'ops.lead@x.com'],
    'manager + blank-role + opted-in ALL-sentinel manager only; agent (even opted in) and unknown roles excluded');
});

// The pre-agent 3-column sheet must still read cleanly (the fake sheet enforces
// getMaxColumns, F-5 -- an unbounded 4-col read would THROW here, the REP-10 class).
test('P1: a legacy 3-column Access Control sheet still resolves managers (width-bounded read)', function () {
  install([['old.mgr@x.com', 'CSR', 'pre-agent-role install']]);
  assert.deepEqual(JSON.parse(JSON.stringify(h.call('lookupDeptManagers_', 'CSR'))),
    ['old.mgr@x.com']);
});

// O-5 (broad-scan 2026-09-17): the daily alerts engine records an OPS-8
// prefix-coded outcome (ALERTS_LAST / ALERTS_LAST_RESULT) so the Health page's
// outcome table can show it; `ok` only when no department errored.
test('O-5: alertsOutcomeString_ is ok with no errors and FAILED-PARTIAL with any', function () {
  const ok = h.call('alertsOutcomeString_', '2026-09-16',
    [{ status: 'sent' }, { status: 'above-threshold' }, { status: 'skipped' }]);
  assert.match(ok, /^ok 2026-09-16: 3 dept\(s\) assessed, 1 fired \(1 above-threshold, 1 sent, 1 skipped\)/);
  const bad = h.call('alertsOutcomeString_', '2026-09-16', [{ status: 'sent' }, { status: 'error' }]);
  assert.match(bad, /^FAILED-PARTIAL 2026-09-16: 1 dept error\(s\); 2 dept\(s\) assessed, 1 fired/);
  assert.match(h.call('alertsOutcomeString_', '2026-09-16', []), /^ok 2026-09-16: 0 dept\(s\) assessed, 0 fired/);
  h.state.props = h.state.props || {};
  h.call('recordAlertsOutcome_', 'ok 2026-09-16: x');
  assert.equal(h.state.props.ALERTS_LAST_RESULT, 'ok 2026-09-16: x');
  assert.ok(h.state.props.ALERTS_LAST);
});

// EN-8 (broad-scan 2026-10-01): MailApp rejects the WHOLE send when one address
// is malformed, so one bad Access Control / Extra Recipients cell cost the dept
// its alert. Bad addresses are skipped and reported; the rest still receive it.
test('EN-8: a malformed address is skipped (and reported), the valid ones still resolve', function () {
  install([['mgr@x.com', 'CSR'], ['typo at x.com', 'CSR']]);
  const invalid = [];
  const out = h.call('resolveRecipients_', { department: 'CSR', extraRecipients: ['ext@y.com', 'no-at-sign', 'a@b'] }, invalid);
  assert.deepEqual(Array.from(out), ['mgr@x.com', 'ext@y.com']);
  assert.deepEqual(Array.from(invalid), ['typo at x.com', 'no-at-sign', 'a@b']);
  // The one-argument call is unchanged.
  assert.deepEqual(Array.from(h.call('resolveRecipients_', { department: 'CSR', extraRecipients: [] })), ['mgr@x.com']);
});

test('EN-8: the run sends to the valid recipients and the Alert Log names what it skipped', function () {
  h.state.props = { SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' };
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {
    'Access Control': [['Email', 'Department', 'Notes'], ['mgr@x.com', 'CSR'], ['typo at x.com', 'CSR']],
    'Alert Log': [['Timestamp']],
  } });
  h.ctx.isIsoDate_ = function (v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v)); };
  h.ctx.appendAlertLog_ = function () {};
  h.ctx.getAllDepartments_ = function () { return ['CSR']; };
  h.ctx.readAlertConfig_ = function () { return [{ department: 'CSR', active: true, threshold: 90, skipDates: '', extraRecipients: [] }]; };
  h.ctx.getRosterForDepartment_ = function () { return { names: ['A'] }; };
  h.ctx.computeDeptAnswerRateForDate_ = function () { return { rung: 10, answered: 5, missed: 5, pct: 50, lowAgents: [] }; };
  const sentTo = [];
  h.ctx.sendAlertEmail_ = function (entry, d, stats, to) { sentTo.push(Array.from(to)); };
  const res = h.call('runAlertsCore_', '2026-09-21', false, 'daily-trigger');
  assert.equal(res[0].status, 'sent');
  assert.deepEqual(sentTo, [['mgr@x.com']]);
  assert.match(res[0].notes, /Sent to 1 recipient \(skipped 1 invalid address: typo at x\.com\)/);
});

// EN-7 (broad-scan 2026-10-01): the alert said "% of rung calls" even when
// ANSWER_RATE_FORMULA=answerable made the denominator answered + missed.
test('EN-7: the alert email names the denominator the active formula used', function () {
  const h3 = loadGas({ files: ['Config.gs', 'Util.gs', 'EmailKit.gs', 'Alerts.gs'] });
  const html = function (formula) {
    h3.state.props = { ADMIN_EMAILS: 'admin@x.com' };
    if (formula) h3.state.props.ANSWER_RATE_FORMULA = formula;
    h3.ctx.ANSWER_RATE_FORMULA_MEMO_ = null;
    h3.state.sentEmails.length = 0;
    h3.call('sendAlertEmail_', { department: 'CSR', threshold: 90 }, '2026-09-21',
      { pct: 50, rung: 10, answered: 5, missed: 5, lowAgents: [] }, ['m@x.com'], []);
    return h3.state.sentEmails[0].htmlBody;
  };
  assert.match(html(''), /of rung calls on/);
  assert.match(html('answerable'), /of answered-or-missed calls on/);
  assert.doesNotMatch(html('answerable'), /of rung calls/);
});

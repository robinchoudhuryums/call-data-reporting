'use strict';

// Step 5c (owner plan 2026-10-16): two new alert REASONS, admin-only while
// trialled -- an agent below X% on each of the last N workdays, and callers
// who could not get through and were not called back within a business day.
// They ride the daily alert run (same date, claim and log), email the ADMINS
// only, and are tagged `reason:<kind>:` in the Alert Log so the drift chip and
// History never count them.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

const J = (x) => JSON.parse(JSON.stringify(x));
const h = loadGas({ files: ['Config.gs', 'Util.gs', 'EmailKit.gs', 'Alerts.gs', 'Notifications.gs', 'AlertReasons.gs'] });

const REAL = {};
['computeDeptAnswerRateForDate_', 'alertRowsForRange_', 'alertCallbackMisses_', 'obCallbackListEpisodes_']
  .forEach(function (k) { REAL[k] = h.ctx[k]; });

function install(opts) {
  opts = opts || {};
  Object.keys(REAL).forEach(function (k) { h.ctx[k] = REAL[k]; });
  h.state.userEmail = 'admin@x.com';
  h.state.props = Object.assign({ SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' }, opts.props || {});
  h.state.sentEmails.length = 0;
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {
    'Alert Config': [['Department', 'Threshold %', 'Extra Recipients', 'Active', 'Notes', 'Skip Dates'],
      ['CSR', 80, '', 'TRUE', '', opts.skip || '']],
    'Alert Log': [['Timestamp', 'Department', 'Date Checked', 'Threshold', 'Answer Rate', 'Sent',
      'Recipients', 'Triggered By', 'Notes', 'Status']],
    'Access Control': [['Email', 'Department', 'Notes'], ['csr.mgr@x.com', 'CSR', '']],
  } });
  h.ctx.getAllDepartments_ = function () { return ['CSR', 'Sales']; };
  h.ctx.resolveUser_ = function (email) { return { email: email, role: email === 'admin@x.com' ? 'admin' : 'none' }; };
  h.ctx.isIsoDate_ = function (v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v)); };
  h.ctx.getRosterForDepartment_ = function () { return { names: ['Ann', 'Bob', 'Mgr'] }; };
  h.ctx.isCompanyHoliday_ = function () { return false; };
  h.ctx.getTeamAvgExcludes_ = function () { return ['Mgr']; };
  h.ctx.alertRowsForRange_ = function () { return {}; };
}

// Ann is below 50% every day; Bob dips once above; Mgr is a manager.
const DAYS = {
  '2026-10-14': [['Ann', 30], ['Bob', 40], ['Mgr', 10]],
  '2026-10-13': [['Ann', 45], ['Bob', 70], ['Mgr', 10]],
  '2026-10-12': [['Ann', 20], ['Bob', 40], ['Mgr', 10]],
};
function stubDays() {
  h.ctx.computeDeptAnswerRateForDate_ = function (dept, iso) {
    const ag = (DAYS[iso] || []).map(function (x) { return { name: x[0], pct: x[1], answered: x[1], missed: 100 - x[1], rung: 100 }; });
    return { rung: 300, answered: 150, missed: 150, pct: 90, lowAgents: [], agents: ag };
  };
}

test('PURE: an agent fires only when below on EVERY day; a day off or one good day clears them; managers excluded', function () {
  install();
  const perDay = [
    { iso: '2026-10-14', agents: [{ name: 'Ann', pct: 30 }, { name: 'Bob', pct: 40 }, { name: 'Cy', pct: 10 }, { name: 'Mgr', pct: 5 }] },
    { iso: '2026-10-13', agents: [{ name: 'Ann', pct: 45 }, { name: 'Bob', pct: 70 }, { name: 'Mgr', pct: 5 }] },
    { iso: '2026-10-12', agents: [{ name: 'Ann', pct: 20 }, { name: 'Bob', pct: 40 }, { name: 'Cy', pct: 10 }, { name: 'Mgr', pct: 5 }] },
  ];
  const out = J(h.call('alertAgentLowFindings_', perDay, 50, ['Mgr']));
  assert.deepEqual(out.map(function (f) { return f.name; }), ['Ann'],
    'Bob had one day at 70%; Cy took no calls on 10-13; Mgr is excluded');
  assert.equal(out[0].days.length, 3);
  assert.deepEqual(J(h.call('alertAgentLowFindings_', perDay, 50, [])).map(function (f) { return f.name; }), ['Mgr', 'Ann'],
    'lowest average first; without the exclusion the manager would fire');
  assert.equal(J(h.call('alertAgentLowFindings_', perDay, 45, ['Mgr'])).length, 0, '45% on 10-13 is not BELOW 45%');
});

test('agent-low in the daily run: one window read, admins only, tagged in the log, its own outcome segment', function () {
  install({ props: { ALERT_REASON_RULES: JSON.stringify({ CSR: { agentLow: { threshold: 50, days: 3 } } }) } });
  stubDays();
  const ranges = [];
  h.ctx.alertRowsForRange_ = function (f, t) { ranges.push([f, t]); return {}; };
  h.ctx.sendAlertEmail_ = function () { throw new Error('the dept rule must not fire here'); };
  const res = h.call('runAlertsCore_', '2026-10-14', false, 'daily-trigger');
  const reason = res.filter(function (r) { return r.reason === 'agent-low'; })[0];
  assert.deepEqual(ranges, [['2026-10-12', '2026-10-14']], 'the three workdays in ONE read');
  assert.equal(reason.status, 'sent');
  assert.match(reason.notes, /1 agent\(s\) below 50% on each of the last 3 workdays \(2026-10-12\.\.2026-10-14\): Ann/);
  const real = h.state.sentEmails.filter(function (m) { return !/^\[Copy\]/.test(m.subject); });
  assert.equal(real.length, 1);
  assert.equal(real[0].to, 'admin@x.com', 'ADMINS only -- never the dept manager');
  assert.match(real[0].subject, /^\[Dashboard Alert · admin trial\] CSR: 1 agent below 50% for 3 workdays/);
  assert.match(real[0].htmlBody, /Ann<\/strong>: 20\.0% · 45\.0% · 30\.0%/, 'oldest first');
  const log = h.state.spreadsheet.getSheetByName('Alert Log').getDataRange().getValues();
  const row = log.filter(function (r) { return /^reason:/.test(r[7]); })[0];
  assert.equal(row[7], 'reason:agent-low:daily-trigger');
  const outcome = h.call('alertsOutcomeString_', '2026-10-14', res);
  assert.match(outcome, /^ok 2026-10-14: 1 dept\(s\) assessed, 0 fired \(1 above-threshold\); reasons: 1 checked, 1 fired/,
    'reason rows never inflate the dept count');
  const drift = J(h.call('computeThresholdDrift_', h.call('readAlertConfig_'), 30));
  assert.equal(drift.CSR.total, 1, 'only the answer-rate row counts toward drift');
});

test('agent-low preview sends nothing and says would-send; a quiet window logs quiet', function () {
  install({ props: { ALERT_REASON_RULES: JSON.stringify({ CSR: { agentLow: { threshold: 50, days: 3 } } }) } });
  stubDays();
  h.ctx.sendAlertEmail_ = function () {};
  let res = h.call('runAlertsCore_', '2026-10-14', true, 'admin@x.com');
  const r1 = res.filter(function (r) { return r.reason; })[0];
  assert.equal(r1.status, 'would-send');
  assert.equal(h.state.sentEmails.length, 0);
  install({ props: { ALERT_REASON_RULES: JSON.stringify({ CSR: { agentLow: { threshold: 15, days: 3 } } }) } });
  stubDays();
  h.ctx.sendAlertEmail_ = function () {};
  res = h.call('runAlertsCore_', '2026-10-14', false, 'daily-trigger');
  assert.equal(res.filter(function (r) { return r.reason; })[0].status, 'quiet');
});

test('callbacks: unavailable and partial days are SKIPPED (never "nobody called back"); a miss emails the admins', function () {
  const rules = JSON.stringify({ CSR: { callbacks: { minCallers: 2 } } });
  const run = function (misses) {
    install({ props: { ALERT_REASON_RULES: rules } });
    stubDays();
    h.ctx.sendAlertEmail_ = function () {};
    const asked = [];
    h.ctx.alertCallbackMisses_ = function (dept, ab, thru) { asked.push([dept, ab, thru]); return misses; };
    const res = h.call('runAlertsCore_', '2026-10-13', false, 'daily-trigger');   // a Tuesday
    return { row: res.filter(function (r) { return r.reason === 'callbacks'; })[0], asked: asked };
  };
  let x = run({ available: false, missed: [], pending: 0, total: 0, error: 'no conn' });
  assert.deepEqual(x.asked, [['CSR', '2026-10-12', '2026-10-13']], 'the previous workday\'s callers, judged through the assessed day');
  assert.equal(x.row.status, 'skipped');
  assert.match(x.row.notes, /Callback data unavailable/);
  x = run({ available: true, missed: [{ firstHms: '07:15:00', queue: 'A_Q_CSR', attempts: 1 }], pending: 3, total: 9 });
  assert.equal(x.row.status, 'skipped');
  assert.match(x.row.notes, /cannot be judged yet/);
  x = run({ available: true, missed: [{ firstHms: '07:15:00', queue: 'A_Q_CSR', attempts: 1 }], pending: 0, total: 9 });
  assert.equal(x.row.status, 'quiet', 'one miss is under the 2-caller floor');
  x = run({ available: true, missed: [{ firstHms: '07:15:00', queue: 'A_Q_CSR', attempts: 2 },
    { firstHms: '13:05:00', queue: 'A_Q_CSR', attempts: 1 }], pending: 0, total: 9 });
  assert.equal(x.row.status, 'sent');
  const mail = h.state.sentEmails.filter(function (m) { return !/^\[Copy\]/.test(m.subject); })[0];
  assert.equal(mail.to, 'admin@x.com');
  assert.match(mail.subject, /CSR: 2 callers not called back within a business day/);
  assert.match(mail.htmlBody, /9:15 AM · A_Q_CSR · 2 attempts/, 'stored PST shown as CST');
  assert.doesNotMatch(mail.body, /\d{10}/, 'no caller number anywhere');
});

test('callbacks window: Monday judges Friday\'s callers with a 3-day window over the callback engine', function () {
  install();
  let got = null;
  h.ctx.getDashboardNeonConn_ = function () { return { close: function () {} }; };
  h.ctx.obCallbackListEpisodes_ = function (conn, scope, extra, win) {
    got = { scope: scope, extra: extra, win: win };
    return { eps: [
      { outcome: 'none', firstHms: '08:00:00', attempts: [{ q: 'A_Q_CSR' }] },
      { outcome: 'own', firstHms: '09:00:00', attempts: [{ q: 'A_Q_CSR' }] },
      { outcome: 'gotThrough', firstHms: '10:00:00', attempts: [{ q: 'A_Q_CSR' }] },
    ] };
  };
  const out = J(h.call('alertCallbackMisses_', 'CSR', '2026-10-09', '2026-10-12'));
  assert.equal(got.win, 3, 'Friday -> Monday');
  assert.equal(got.scope.from, '2026-10-09');
  assert.equal(got.scope.to, '2026-10-09');
  assert.equal(got.scope.dept, 'CSR');
  assert.equal(out.available, true);
  assert.equal(out.total, 3);
  assert.equal(out.missed.length, 1, 'own dial and got-through both count as handled');
  h.ctx.getDashboardNeonConn_ = function () { return null; };
  assert.equal(h.call('alertCallbackMisses_', 'CSR', '2026-10-09', '2026-10-12').available, false);
});

test('a dept skip date silences its reasons on the trigger path only', function () {
  install({ skip: '2026-10-14', props: { ALERT_REASON_RULES: JSON.stringify({ CSR: { agentLow: { threshold: 50, days: 3 } } }) } });
  stubDays();
  h.ctx.sendAlertEmail_ = function () {};
  const res = h.call('runAlertsCore_', '2026-10-14', false, 'daily-trigger');
  assert.equal(res.filter(function (r) { return r.reason; })[0].status, 'skipped');
});

test('a reason that throws is an error row, and the run still finishes', function () {
  install({ props: { ALERT_REASON_RULES: JSON.stringify({ CSR: { agentLow: { threshold: 50, days: 3 } }, Sales: { agentLow: { threshold: 50, days: 3 } } }) } });
  stubDays();
  h.ctx.sendAlertEmail_ = function () {};
  h.ctx.computeDeptAnswerRateForDate_ = function (dept) {
    if (dept === 'CSR') throw new Error('boom');
    return { rung: 1, answered: 1, missed: 0, pct: 100, lowAgents: [], agents: [] };
  };
  const res = h.call('runAlertsCore_', '2026-10-14', false, 'daily-trigger');
  const rs = res.filter(function (r) { return r.reason; });
  assert.deepEqual(J(rs.map(function (r) { return r.department + ':' + r.status; })), ['CSR:error', 'Sales:quiet']);
  assert.match(h.call('alertsOutcomeString_', '2026-10-14', res), /^FAILED-PARTIAL/);
});

test('saveAlertReasonRule: admin-only, validated, under the lock; blanks clear', function () {
  install();
  assert.throws(function () { h.call('saveAlertReasonRule', { department: 'CSR', agentLowThreshold: 40, agentLowDays: 1 }); }, /from 2 to 20/);
  assert.throws(function () { h.call('saveAlertReasonRule', { department: 'CSR', agentLowThreshold: 140, agentLowDays: 5 }); }, /from 1 to 100/);
  assert.throws(function () { h.call('saveAlertReasonRule', { department: 'Nope', callbacksMin: 1 }); }, /Unknown department/);
  const locks = h.state.locks;
  const r = J(h.call('saveAlertReasonRule', { department: 'CSR', agentLowThreshold: 40, agentLowDays: 5, callbacksMin: 1 }));
  assert.ok(h.state.locks > locks);
  assert.deepEqual(r.rules.CSR, { agentLow: { threshold: 40, days: 5 }, callbacks: { minCallers: 1 } });
  h.call('saveAlertReasonRule', { department: 'CSR', agentLowThreshold: '', agentLowDays: '', callbacksMin: '' });
  assert.equal(h.state.props.ALERT_REASON_RULES, undefined);
  h.ctx.assertAdmin_ = function () { throw new Error('Admin only.'); };
  try {
    assert.throws(function () { h.call('saveAlertReasonRule', { department: 'CSR', callbacksMin: 1 }); }, /Admin only/);
  } finally { delete h.ctx.assertAdmin_; }
});

test('History never treats a reason row as "what happened" to the answer-rate rule', function () {
  install();
  const sheet = h.state.spreadsheet.getSheetByName('Alert Log');
  sheet.appendRow([new Date(), 'CSR', '2026-10-14', 50, '', 'TRUE', 'admin@x.com', 'reason:agent-low:daily-trigger', '', 'sent']);
  const got = J(h.call('notifyAlertLogByDate_', 'CSR', '2026-10-01'));
  assert.deepEqual(got, {});
});

// ── Client: the reasons read as sentences; reason rows label themselves ───
const fs = require('fs');
const path = require('path');
const S7 = fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard', 'script-7-admin.html'), 'utf8');
function extractFn(text, name) {
  const start = text.indexOf('function ' + name + '(');
  assert.ok(start !== -1, name + ' exists');
  let depth = 0, i = text.indexOf('{', start);
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (!depth) break; }
  }
  return text.slice(start, i + 1);
}
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const reasonSentence = new Function('escapeHtml', 'return (' + extractFn(S7, 'alReasonSentenceHtml_') + ');')(escapeHtml);

test('client: each reason reads as the sentence it enforces, and says the ADMINS are emailed', function () {
  assert.equal(reasonSentence('CSR', 'agentLow', { threshold: 40, days: 5 }),
    'When an agent in <strong>CSR</strong> answers under <strong>40%</strong> on each of the last <strong>5</strong> workdays, email the admins.');
  assert.equal(reasonSentence('CSR', 'callbacks', { minCallers: 1 }),
    'When a caller who could not get through to <strong>CSR</strong> is not called back within a business day, email the admins.');
  assert.match(reasonSentence('<b>', 'callbacks', { minCallers: 3 }), /<strong>3<\/strong> or more callers .*&lt;b&gt;.* are not called back/);
  const results = extractFn(S7, 'alRenderResults_');
  assert.match(results, /r\.reason === 'callbacks' \? \(Number\(r\.threshold\) \|\| 0\) \+ '\+ callers'/,
    'a callbacks threshold is a caller count, never rendered as a %');
});

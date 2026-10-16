'use strict';

// Step 5a (owner plan 2026-10-16): the Notifications page -- the alert rules
// read as sentences, a "would it have fired?" history, a test send to the
// requesting admin only, and the MANAGER LAYER: a manager may only make their
// department's alert STRICTER, the server refuses anything looser, the
// stricter of the two values applies at send time, and the whole layer is
// inert (refused + not applied) until an admin flips NOTIFY_MANAGER_EDIT.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

const J = (x) => JSON.parse(JSON.stringify(x));
const h = loadGas({ files: ['Config.gs', 'Util.gs', 'EmailKit.gs', 'Alerts.gs', 'Notifications.gs'] });

const USERS = {
  'admin@x.com': { email: 'admin@x.com', role: 'admin', department: null, departments: ['CSR', 'Sales'] },
  'csr.mgr@x.com': { email: 'csr.mgr@x.com', role: 'manager', department: 'CSR', departments: ['CSR'] },
  'agent@x.com': { email: 'agent@x.com', role: 'agent', department: null, departments: [] },
};

// Functions some tests stub; install() puts the real ones back.
const REAL = {};
['sendAlertEmail_', 'computeDeptAnswerRateForDate_', 'alertRowsForRange_', 'prevBusinessDayIso_']
  .forEach(function (k) { REAL[k] = h.ctx[k]; });

function install(opts) {
  opts = opts || {};
  Object.keys(REAL).forEach(function (k) { h.ctx[k] = REAL[k]; });
  h.state.userEmail = opts.user || 'admin@x.com';
  h.state.props = Object.assign({ SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' }, opts.props || {});
  h.state.sentEmails.length = 0;
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {
    'Alert Config': [['Department', 'Threshold %', 'Extra Recipients', 'Active', 'Notes', 'Skip Dates'],
      ['CSR', 80, 'ext@x.com', 'TRUE', '', '2026-10-05'],
      ['Sales', 70, '', 'TRUE', '', '']],
    'Alert Log': [['Timestamp', 'Department', 'Date Checked', 'Threshold', 'Answer Rate', 'Sent',
      'Recipients', 'Triggered By', 'Notes', 'Status']].concat(opts.log || []),
    'Access Control': [['Email', 'Department', 'Notes'], ['csr.mgr@x.com', 'CSR', '']],
    'Report Usage': [['Timestamp', 'Report', 'Dept', 'Role', 'Email', 'Cache']],
  } });
  h.ctx.resolveUser_ = function (email) { return USERS[email] || { email: email, role: 'none', departments: [] }; };
  h.ctx.getAllDepartments_ = function () { return ['CSR', 'Sales']; };
  h.ctx.isIsoDate_ = function (v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v)); };
  h.ctx.getRosterForDepartment_ = function () { return { names: ['A'] }; };
  h.ctx.isCompanyHoliday_ = function () { return false; };
}

// ── The stricter-only rule (pure) ─────────────────────────────────────────

test('stricter-of: a higher alert threshold is stricter; a missing manager value leaves the admin\'s', function () {
  install();
  assert.equal(h.call('notifyStricterOf_', 'alertThreshold', 80, 88), 88);
  assert.equal(h.call('notifyStricterOf_', 'alertThreshold', 90, 88), 90, 'the admin raising past the manager wins');
  assert.equal(h.call('notifyStricterOf_', 'alertThreshold', 80, null), 80);
  assert.equal(h.call('notifyStricterOf_', 'alertThreshold', 80, ''), 80);
  assert.equal(h.call('notifyCheckStricter_', 'alertThreshold', 80, 85, '%'), null);
  assert.equal(h.call('notifyCheckStricter_', 'alertThreshold', 80, 80, '%'), null, 'equal is allowed');
  assert.match(h.call('notifyCheckStricter_', 'alertThreshold', 80, 75, '%'),
    /only make this rule stricter: the admin's value is 80%, so choose 80% or higher/);
  assert.throws(function () { h.call('notifyStricterOf_', 'scheduleHour', 8, 7); }, /Unknown notification field/,
    'window length / schedule have no manager field');
});

test('the effective threshold ignores a stored manager value while the layer is OFF', function () {
  install({ props: { NOTIFY_MANAGER_RULES: JSON.stringify({ CSR: { alertThreshold: 88, by: 'csr.mgr@x.com' } }) } });
  const off = J(h.call('alertEffectiveThreshold_', { department: 'CSR', threshold: 80 }));
  assert.deepEqual(off, { threshold: 80, admin: 80, manager: null, source: 'admin' });
  install({ props: { NOTIFY_MANAGER_EDIT: 'true',
    NOTIFY_MANAGER_RULES: JSON.stringify({ CSR: { alertThreshold: 88, by: 'csr.mgr@x.com' } }) } });
  const on = J(h.call('alertEffectiveThreshold_', { department: 'CSR', threshold: 80 }));
  assert.deepEqual(on, { threshold: 88, admin: 80, manager: 88, source: 'manager' });
  const adminWins = J(h.call('alertEffectiveThreshold_', { department: 'CSR', threshold: 92 }));
  assert.equal(adminWins.threshold, 92);
  assert.equal(adminWins.source, 'admin');
});

test('a malformed NOTIFY_MANAGER_RULES reads as empty -- the admin\'s rules apply', function () {
  install({ props: { NOTIFY_MANAGER_EDIT: 'true', NOTIFY_MANAGER_RULES: '{not json' } });
  assert.deepEqual(J(h.call('readNotifyManagerRules_')), {});
  assert.equal(h.call('alertEffectiveThreshold_', { department: 'CSR', threshold: 80 }).threshold, 80);
});

// ── The write path ────────────────────────────────────────────────────────

test('a manager is refused while the layer is off; an admin may set it (to try it)', function () {
  install({ user: 'csr.mgr@x.com' });
  assert.throws(function () { h.call('saveNotifyManagerRule', { department: 'CSR', alertThreshold: 85 }); },
    /not available yet/);
  assert.throws(function () { h.call('getNotifyRules'); }, /not available yet/);
  assert.equal(h.state.props.NOTIFY_MANAGER_RULES, undefined, 'nothing written');
  install({ user: 'admin@x.com' });
  const res = J(h.call('saveNotifyManagerRule', { department: 'CSR', alertThreshold: 85 }));
  assert.equal(JSON.parse(h.state.props.NOTIFY_MANAGER_RULES).CSR.alertThreshold, 85);
  const csr = res.rules.filter(function (r) { return r.department === 'CSR'; })[0];
  assert.equal(csr.managerThreshold, 85);
  assert.equal(csr.effectiveThreshold, 80, 'stored, but not applied while the layer is off');
});

test('released: a manager may only tighten their OWN department, under the lock, audited', function () {
  install({ user: 'csr.mgr@x.com', props: { NOTIFY_MANAGER_EDIT: 'true' } });
  assert.throws(function () { h.call('saveNotifyManagerRule', { department: 'CSR', alertThreshold: 75 }); },
    /only make this rule stricter/);
  assert.throws(function () { h.call('saveNotifyManagerRule', { department: 'Sales', alertThreshold: 90 }); },
    /Not authorized for this department/);
  assert.throws(function () { h.call('saveNotifyManagerRule', { department: 'CSR', alertThreshold: 140 }); },
    /between 1 and 100/);
  assert.equal(h.state.props.NOTIFY_MANAGER_RULES, undefined, 'no refused save wrote anything');
  const locksBefore = h.state.locks;
  const res = J(h.call('saveNotifyManagerRule', { department: 'CSR', alertThreshold: 88 }));
  assert.ok(h.state.locks > locksBefore, 'the write takes the script lock');
  assert.deepEqual(res.rules.map(function (r) { return r.department; }), ['CSR'], 'a manager sees only their dept');
  assert.equal(res.rules[0].effectiveThreshold, 88);
  assert.equal(res.rules[0].effectiveSource, 'manager');
  const stored = JSON.parse(h.state.props.NOTIFY_MANAGER_RULES).CSR;
  assert.equal(stored.by, 'csr.mgr@x.com');
  const usage = h.state.spreadsheet.getSheetByName('Report Usage').getDataRange().getValues();
  assert.equal(usage[usage.length - 1][1], 'notify:manager-rule');
  // A blank value clears it; the property is removed once empty.
  h.call('saveNotifyManagerRule', { department: 'CSR', alertThreshold: '' });
  assert.equal(h.state.props.NOTIFY_MANAGER_RULES, undefined);
});

test('an agent is refused even when released; setNotifyManagerEdit is admin-only', function () {
  install({ user: 'agent@x.com', props: { NOTIFY_MANAGER_EDIT: 'true' } });
  assert.throws(function () { h.call('saveNotifyManagerRule', { department: 'CSR', alertThreshold: 90 }); }, /Not authorized/);
  install({ user: 'csr.mgr@x.com' });
  h.ctx.assertAdmin_ = function () { throw new Error('Admin only.'); };
  try {
    assert.throws(function () { h.call('setNotifyManagerEdit', { enabled: true }); }, /Admin only/);
  } finally { delete h.ctx.assertAdmin_; }
});

test('a dept with no admin rule cannot get a manager value', function () {
  install({ user: 'admin@x.com' });
  h.ctx.getAllDepartments_ = function () { return ['CSR', 'Sales', 'Power']; };
  assert.throws(function () { h.call('saveNotifyManagerRule', { department: 'Power', alertThreshold: 90 }); },
    /no alert rule for Power yet/);
});

// ── The engine applies the stricter value ─────────────────────────────────

function stubRun(pct) {
  h.ctx.computeDeptAnswerRateForDate_ = function () { return { rung: 10, answered: 5, missed: 5, pct: pct, lowAgents: [] }; };
  const sent = [];
  h.ctx.sendAlertEmail_ = function (entry, d, stats, to) { sent.push({ threshold: entry.threshold, to: Array.from(to) }); };
  return sent;
}

test('the daily run applies the manager\'s stricter value only once released, and says so', function () {
  const rules = JSON.stringify({ CSR: { alertThreshold: 90 } });
  install({ props: { NOTIFY_MANAGER_RULES: rules } });
  let sent = stubRun(85);
  let res = h.call('runAlertsCore_', '2026-10-14', false, 'daily-trigger');
  const csrOff = res.filter(function (r) { return r.department === 'CSR'; })[0];
  assert.equal(csrOff.status, 'above-threshold', 'off: 85% clears the admin\'s 80%');
  assert.equal(csrOff.threshold, 80);
  assert.equal(sent.length, 0);

  install({ props: { NOTIFY_MANAGER_EDIT: 'true', NOTIFY_MANAGER_RULES: rules } });
  sent = stubRun(85);
  res = h.call('runAlertsCore_', '2026-10-14', false, 'daily-trigger');
  const csrOn = res.filter(function (r) { return r.department === 'CSR'; })[0];
  assert.equal(csrOn.status, 'sent', 'on: 85% is below the manager\'s 90%');
  assert.equal(csrOn.threshold, 90, 'the log carries the applied threshold');
  assert.match(csrOn.notes, /manager-set 90%, stricter than the admin's 80%/);
  assert.equal(sent[0].threshold, 90, 'the email states the applied threshold');
});

// ── History ───────────────────────────────────────────────────────────────

test('history: one window read, a verdict per workday under the rule as it stands, the real outcome beside it', function () {
  install({ log: [
    [new Date(), 'CSR', '2026-10-14', 80, 70, 'TRUE', 'csr.mgr@x.com', 'daily-trigger', '', 'sent'],
    [new Date(), 'CSR', '2026-10-14', 80, 70, 'FALSE', '', 'preview:admin@x.com', '', 'would-send'],
    [new Date(), 'CSR', '2026-10-13', 80, 85, 'FALSE', '', 'test:admin@x.com', '', 'test-sent'],
  ] });
  h.ctx.prevBusinessDayIso_ = function () { return '2026-10-14'; };
  const ranges = [];
  h.ctx.alertRowsForRange_ = function (f, t) { ranges.push([f, t]); return {}; };
  const pctBy = { '2026-10-14': 70, '2026-10-13': 85, '2026-10-12': 79.9, '2026-10-09': null, '2026-10-08': 81 };
  h.ctx.computeDeptAnswerRateForDate_ = function (dept, iso) {
    const p = pctBy[iso];
    return p == null ? { rung: 0, answered: 0, missed: 0, pct: 0, lowAgents: [] }
      : { rung: 10, answered: 5, missed: 5, pct: p, lowAgents: [] };
  };
  const out = J(h.call('getAlertHistory', { department: 'CSR', days: 5 }));
  assert.deepEqual(ranges, [['2026-10-08', '2026-10-14']], 'ONE read covering the five workdays (weekend skipped)');
  assert.deepEqual(out.days.map(function (d) { return d.date; }),
    ['2026-10-14', '2026-10-13', '2026-10-12', '2026-10-09', '2026-10-08'], 'newest first, workdays only');
  assert.deepEqual(out.days.map(function (d) { return d.verdict; }),
    ['would-fire', 'quiet', 'would-fire', 'no-data', 'quiet']);
  assert.equal(out.firedCount, 2);
  assert.equal(out.assessedCount, 4);
  assert.deepEqual(out.days[0].logged, { status: 'sent', triggeredBy: 'daily-trigger' },
    'the real run is joined; the preview row is not');
  assert.equal(out.days[1].logged, null, 'a test send is not "what happened"');
  install();
  h.ctx.prevBusinessDayIso_ = function () { return '2026-10-06'; };
  h.ctx.alertRowsForRange_ = function () { return {}; };
  h.ctx.computeDeptAnswerRateForDate_ = function () { return { rung: 10, answered: 5, missed: 5, pct: 50, lowAgents: [] }; };
  const skip = J(h.call('getAlertHistory', { department: 'CSR', days: 2 }));
  assert.equal(skip.days[1].date, '2026-10-05');
  assert.equal(skip.days[1].skipped, true, 'the rule\'s own skip date is marked');
  assert.equal(skip.assessedCount, 1, 'and not counted as assessed');
});

// ── Test send ─────────────────────────────────────────────────────────────

test('test send: the real email to the requesting admin ONLY, marked [Test], logged as test-sent', function () {
  install({ user: 'admin@x.com' });
  h.ctx.computeDeptAnswerRateForDate_ = function () { return { rung: 10, answered: 9, missed: 1, pct: 90, lowAgents: [] }; };
  const r = J(h.call('sendAlertTest', { department: 'CSR', date: '2026-10-14' }));
  assert.equal(r.sentTo, 'admin@x.com');
  assert.equal(r.wouldFire, false, '90% clears 80%: a quiet day still sends the test');
  const real = h.state.sentEmails.filter(function (m) { return !/^\[Copy\]/.test(m.subject); });
  assert.equal(real.length, 1);
  assert.equal(real[0].to, 'admin@x.com', 'no manager, no extra recipient');
  assert.ok(!real[0].cc, 'nobody copied');
  assert.match(real[0].subject, /^\[Test\] \[Dashboard Alert\] CSR answer rate 90\.0% on 2026-10-14/);
  assert.match(real[0].htmlBody, /Only you received this/);
  assert.match(real[0].htmlBody, /would <strong>not<\/strong> have fired/);
  const log = h.state.spreadsheet.getSheetByName('Alert Log').getDataRange().getValues();
  const last = log[log.length - 1];
  assert.equal(last[7], 'test:admin@x.com');
  assert.equal(last[9], 'test-sent');
  assert.equal(last[5], 'FALSE', 'a test is never "Sent"');
  assert.throws(function () { h.call('sendAlertTest', { department: 'Nope', date: '2026-10-14' }); }, /No alert rule/);
  h.ctx.computeDeptAnswerRateForDate_ = function () { return { rung: 0, pct: 0, lowAgents: [] }; };
  assert.throws(function () { h.call('sendAlertTest', { department: 'CSR', date: '2026-10-14' }); }, /No calls for CSR/);
});

test('drift ignores test sends (only daily-trigger rows count)', function () {
  install({ log: [[new Date(), 'CSR', '2026-10-13', 80, 85, 'FALSE', 'admin@x.com', 'test:admin@x.com', '', 'test-sent']] });
  const drift = J(h.call('computeThresholdDrift_', h.call('readAlertConfig_'), 30));
  assert.equal(drift.CSR.total, 0);
});

test('workdays helper: newest first, weekends + holidays skipped', function () {
  install();
  const days = J(h.call('notifyWorkdaysEnding_', '2026-10-11', 3, function (iso) { return iso === '2026-10-08'; }));
  assert.deepEqual(days, ['2026-10-09', '2026-10-07', '2026-10-06'], 'Sunday steps back to Friday; the holiday is skipped');
});

// ── Client: the sentence, and the release switch reaching the client ─────

const ROOT = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');
const S7 = fs.readFileSync(path.join(ROOT, 'script-7-admin.html'), 'utf8');
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
const sentence = new Function('escapeHtml', 'return (' + extractFn(S7, 'notifyRuleSentenceHtml_') + ');')(escapeHtml);

test('client: each rule reads as a sentence, naming the threshold that APPLIES', function () {
  assert.equal(sentence({ department: 'CSR', active: true, threshold: 80, extraRecipients: ['a@x.com'] }, null),
    'When <strong>CSR</strong>&rsquo;s answer rate on a workday falls below <strong>80%</strong>, email its managers and a@x.com.');
  assert.match(sentence({ department: 'CSR', active: true, threshold: 80, extraRecipients: [] },
    { effectiveThreshold: 88 }), /below <strong>88%<\/strong>, email its managers\./);
  assert.match(sentence({ department: 'CSR', active: false, threshold: 80 }, null), /^Paused &mdash; when .* it would email/);
  assert.match(sentence({ department: '<b>', active: true, invalidThreshold: true, thresholdRaw: 'x' }, null),
    /&lt;b&gt;.*not monitored/);
});

test('client: the manager surface renders only when released, and Settings asks for it', function () {
  assert.match(extractFn(S7, 'notifySettingsOpen_'), /if \(!\(USER && USER\.notifyEdit\)\) \{ sec\.hidden = true; return; \}/);
  const chrome = fs.readFileSync(path.join(ROOT, 'script-2-chrome.html'), 'utf8');
  assert.match(chrome, /notifySettingsOpen_\(\);/);
  const code = fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8');
  assert.match(code, /notifyEdit: user\.role === 'manager' && typeof notifyManagerEditEnabled_ === 'function'\s*&& notifyManagerEditEnabled_\(\),/,
    'the envelope flag is manager-only and follows the release switch');
  const html = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');
  assert.match(html, /<div id="settings-notify" hidden>/, 'hidden by default');
});

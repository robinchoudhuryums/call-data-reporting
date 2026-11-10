'use strict';

// EXD-1..5 (broad scan 2026-11-09, Batch 4): exception days (#81) end to end.
//
//   EXD-1  the reason is admin-typed free text and is escaped wherever it
//          reaches markup (the agent panel's day strip put it raw in a title).
//   EXD-2  the admin "include exception days" switch engages: it resolves the
//          CALLER (resolveUser_ needs the email; with none it is role 'none'),
//          and the editor's save / remove audit rows name the user.
//   EXD-3  the Daily Call Queue Report and the digest say an exception day is
//          one, instead of EMPTY / "the roster or queue mapping".
//   EXD-4  the agent-below-threshold reason reads a workday with no agent data
//          as no-data and keeps an agent with duplicate rows; the rule History
//          does not count an exception day.
//   EXD-5  the include switch is part of every last-good signature and of the
//          outbound view's key.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { dqeRow, dqeSheet, rosterGrid } = require('../harness/fixtures');

const DASH = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');
const J = (x) => JSON.parse(JSON.stringify(x));
const EXC_HEAD = ['Date', 'Departments', 'Reason', 'Active', 'Added By', 'Added At'];
const MEMOS = ['DEPT_CONFIG_ROWS_MEMO_', 'QCD_SHEET_DATA_MEMO_', 'DQE_DATE_BOUNDS_MEMO_', 'DQE_SHEET_ROWS_MEMO_',
  'DQE_DATE_COL_MEMO_', 'DQE_EXT_GRID_MEMO_', 'EXCEPTION_DAYS_MEMO_', 'COMPANY_HOLIDAYS_MEMO_'];

/** One top-level function's source from a client fragment, by brace matching. */
function clientFn(src, name) {
  const at = src.indexOf('function ' + name + '(');
  assert.ok(at >= 0, name + ' not found');
  let i = src.indexOf('{', at), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) break; }
  }
  return src.slice(at, i + 1);
}

// ── EXD-1 ───────────────────────────────────────────────────────────────────
test('EXD-1: the exception-day reason is escaped everywhere it reaches markup', function () {
  const files = fs.readdirSync(DASH).filter(function (f) { return /^script-\d+-.*\.html$/.test(f); });
  let uses = 0;
  files.forEach(function (f) {
    const src = fs.readFileSync(path.join(DASH, f), 'utf8');
    src.split('\n').forEach(function (line, n) {
      if (line.indexOf('excMarkText_(') === -1 || /function excMarkText_\(/.test(line)) return;
      uses++;
      const safe = /escapeHtml\(excMarkText_\(/.test(line) || /\.textContent = /.test(line);
      assert.ok(safe, f + ':' + (n + 1) + ' puts excMarkText_() into markup unescaped: ' + line.trim());
    });
  });
  assert.ok(uses >= 4, 'the sweep found the call sites (' + uses + ')');
  const strip = fs.readFileSync(path.join(DASH, 'script-10-escalations.html'), 'utf8');
  assert.match(strip, /\(d\.exceptionDay \? ' · ' \+ escapeHtml\(excMarkText_\(d\.exceptionDay\)\) : ''\)/);
});

// ── EXD-2 ───────────────────────────────────────────────────────────────────
const ex = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'CompanyOverview.gs', 'QCDReport.gs', 'DeptConfig.gs', 'Data.gs',
          'NeonRead.gs', 'ExceptionDays.gs'],
  capture: ['SHEETS'],
});
function installEx(user, excRows) {
  ex.state.props = { SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' };
  ex.state.userEmail = user;
  const sheets = {
    'DO NOT EDIT!': rosterGrid({ Alpha: ['Anna, 201'], Beta: ['Cara, 301'] }),
    'DQE Historical Data': dqeSheet([dqeRow({ date: '2026-09-21', agent: 'Anna', ext: '201', rung: 10, missed: 4, answered: 6 })]),
    'Access Control': [['Email', 'Department', 'Notes'], ['mgr@x.com', 'Alpha', '']],
  };
  sheets[ex.consts.SHEETS.EXCEPTION_DAYS] = [EXC_HEAD.slice()].concat(excRows || []);
  sheets[ex.consts.SHEETS.REPORT_USAGE] = [['Timestamp', 'Report', 'Department', 'Role', 'Email', 'Cache Hit']];
  ex.state.spreadsheet = makeFakeSpreadsheet({ sheets: sheets });
  ex.state.cache.clear();
  MEMOS.forEach(function (k) { ex.ctx[k] = null; });
}

test('EXD-2: the include switch engages for an admin through the REAL resolver, and only for an admin', function () {
  installEx('admin@x.com', [['2026-09-21', '', '8x8 outage', 'TRUE', 'a', '']]);
  const admin = ex.inExecution(function () {
    const set = ex.call('setExceptionIncludeFromReq_', { includeExceptionDays: true });
    return { set: set, on: ex.call('exceptionIncludeOn_'), day: ex.call('exceptionDayFor_', '2026-09-21', 'Alpha') };
  });
  assert.equal(admin.set, true, 'no stub: resolveUser_ is handed the session email (was called with none -> role none)');
  assert.equal(admin.on, true);
  assert.equal(admin.day, null, 'the day counts while the admin includes it');

  installEx('mgr@x.com', [['2026-09-21', '', '8x8 outage', 'TRUE', 'a', '']]);
  const mgr = ex.inExecution(function () {
    ex.call('setExceptionIncludeFromReq_', { includeExceptionDays: true });
    return { on: ex.call('exceptionIncludeOn_'), day: J(ex.call('exceptionDayFor_', '2026-09-21', 'Alpha')) };
  });
  assert.equal(mgr.on, false, 'a manager asking for it still gets the exclusion');
  assert.equal(mgr.day.reason, '8x8 outage');

  installEx('admin@x.com', []);
  assert.equal(ex.call('setExceptionIncludeFromReq_', {}), false, 'not asked for: off');
  // No bare call is left anywhere on the server.
  fs.readdirSync(DASH).filter(function (f) { return /\.gs$/.test(f); }).forEach(function (f) {
    assert.doesNotMatch(fs.readFileSync(path.join(DASH, f), 'utf8'), /resolveUser_\(\)/, f + ' calls resolveUser_() with no email');
  });
});

test('EXD-2: an admin\'s include reaches the report -- My Department counts the day again', function () {
  installEx('admin@x.com', [['2026-09-21', '', '8x8 outage', 'TRUE', 'a', '']]);
  const req = { department: 'Alpha', from: '2026-09-21', to: '2026-09-21' };
  const out = ex.call('getDepartmentSummary', req);
  assert.equal(out.totals.totalRung, 0, 'left out by default');
  const inc = ex.call('getDepartmentSummary', Object.assign({ includeExceptionDays: true }, req));
  assert.equal(inc.totals.totalRung, 10, 'the admin view includes it');
  assert.notEqual(inc.meta.cacheHit, true, 'under its own cache key, never the excluded payload');
});

test('EXD-2: the editor\'s save / remove audit rows name the admin', function () {
  installEx('admin@x.com', []);
  ex.call('saveExceptionDay', { date: '2026-09-21', reason: '8x8 outage', departments: [] });
  ex.call('removeExceptionDay', { date: '2026-09-21' });
  const usage = ex.state.spreadsheet.getSheetByName(ex.consts.SHEETS.REPORT_USAGE).getDataRange().getValues().slice(1);
  assert.deepEqual(usage.map(function (r) { return [r[1], r[3], r[4]]; }),
    [['exceptionDays:save', 'admin', 'admin@x.com'], ['exceptionDays:remove', 'admin', 'admin@x.com']]);
});

// ── EXD-3: Daily Call Queue Report ──────────────────────────────────────────
const qr = loadGas({ files: ['Config.gs', 'Util.gs', 'Auth.gs', 'Data.gs', 'QueueReportEmail.gs'], capture: ['SHEETS'] });
function installQr(excRows) {
  qr.state.props = { SPREADSHEET_ID: 'fake', QUEUE_REPORT_ENABLED: 'true', ADMIN_EMAILS: 'admin@x.com' };
  const sheets = {
    'Queue Report Subscribers': [['Email', 'Active', 'Notes'], ['on@x.com', 'TRUE', '']],
    'QCD Historical Data': [['Month Year', 'Week', 'Date'], ['', '', '2026-07-10']],
  };
  sheets[qr.consts.SHEETS.EXCEPTION_DAYS] = [EXC_HEAD.slice()].concat(excRows || []);
  qr.state.spreadsheet = makeFakeSpreadsheet({ sheets: sheets });
  qr.state.cache.clear();
  qr.ctx.EXCEPTION_DAYS_MEMO_ = null;
}
function runPoll() {
  const realDate = qr.ctx.Date;
  const fixed = new realDate('2026-07-13T07:00:00-05:00');   // Mon, in the morning window; target Fri Jul 10
  qr.ctx.Date = function (a) { return arguments.length ? new realDate(a) : new realDate(fixed.getTime()); };
  qr.ctx.Date.now = function () { return fixed.getTime(); };
  qr.ctx.prevBusinessDayIso_ = function () { return '2026-07-10'; };
  qr.ctx.isCompanyHoliday_ = function () { return false; };
  try { qr.call('runDailyQueueReport_'); }
  finally { qr.ctx.Date = realDate; delete qr.ctx.prevBusinessDayIso_; delete qr.ctx.isCompanyHoliday_; }
}

test('EXD-3: the queue report poll records EXCEPTION-DAY once, computes nothing, and is not a Health fault', function () {
  installQr([['2026-07-10', '', '8x8 outage', 'TRUE', 'a', '']]);
  let computed = 0;
  qr.ctx.qcdAllDeptCachedData_ = function () { computed++; return { data: { depts: [], meta: {} } }; };
  const sent = [];
  qr.ctx.MailApp = { sendEmail: function (a) { sent.push(a); } };
  runPoll();
  const res = qr.state.props.QUEUE_REPORT_LAST_RESULT;
  assert.match(res, /^EXCEPTION-DAY 2026-07-10 — an exception day \(8x8 outage\)/);
  assert.match(res, /left out of every report/);
  assert.equal(computed, 0, 'the all-department report is not recomputed on every poll');
  assert.equal(sent.length, 0);
  assert.equal(qr.state.props.QUEUE_REPORT_LAST_SENT, undefined, 'the day is not marked sent');
  const hl = loadGas({ files: ['Config.gs', 'Util.gs', 'SystemHealth.gs'] });
  assert.equal(hl.call('healthOutcomeIsBad_', res), false, 'the Health row reads it as a normal outcome');
  // The next poll does not rewrite the record.
  const stamp = qr.state.props.QUEUE_REPORT_LAST;
  qr.state.props.QUEUE_REPORT_LAST = 'unchanged';
  runPoll();
  assert.equal(qr.state.props.QUEUE_REPORT_LAST, 'unchanged');
  assert.ok(stamp);

  // A ONE-department exception day does not stop the report (the other queues have figures).
  installQr([['2026-07-10', 'CSR', 'CSR line down', 'TRUE', 'a', '']]);
  computed = 0;
  qr.ctx.qcdAllDeptCachedData_ = function () { computed++; return { data: { depts: [], meta: {} } }; };
  runPoll();
  assert.equal(computed, 1, 'computed as usual');
  assert.match(qr.state.props.QUEUE_REPORT_LAST_RESULT, /^EMPTY 2026-07-10/);
  delete qr.ctx.qcdAllDeptCachedData_;
});

test('EXD-3: a preview or a manual send of an exception day says why, and never claims the day', function () {
  installQr([['2026-07-10', '', '8x8 outage', 'TRUE', 'a', '']]);
  qr.ctx.qcdAllDeptCachedData_ = function () { throw new Error('must not compute'); };
  qr.ctx.MailApp = { sendEmail: function () { throw new Error('must not send'); } };
  assert.throws(function () { qr.call('sendQueueReportForDate_', '2026-07-10', { to: 'admin@x.com', isPreview: true }); },
    /Not sent: 2026-07-10 is an exception day \(8x8 outage\) -- its queue figures are left out of every report/);
  const res = J(qr.call('sendQueueReportForDate_', '2026-07-10', {}));
  assert.equal(res.exceptionDay, true);
  assert.equal(res.emptyReport, true, 'so every caller\'s "never claim the day" rule applies unchanged');
  assert.equal(res.count, 0);
  delete qr.ctx.qcdAllDeptCachedData_;
});

// ── EXD-3: digest ───────────────────────────────────────────────────────────
test('EXD-3: a digest whose window is an exception day says so, not "the roster or the queue mapping"', function () {
  const h = loadGas({
    files: ['Config.gs', 'Util.gs', 'Auth.gs', 'CompanyOverview.gs', 'QCDReport.gs', 'DeptConfig.gs', 'Data.gs',
            'NeonRead.gs', 'InsightsReport.gs', 'Digest.gs', 'EmailKit.gs'],
    capture: ['SHEETS'],
  });
  const install = function (excRows) {
    h.state.props = { SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' };
    const sheets = {
      'DO NOT EDIT!': rosterGrid({ Alpha: ['Anna, 201', 'Ben, 202'] }),
      'DQE Historical Data': dqeSheet([dqeRow({ date: '2026-09-21', agent: 'Anna', ext: '201', rung: 10, missed: 4, answered: 6, att: '0:03:00' })]),
    };
    sheets[h.consts.SHEETS.EXCEPTION_DAYS] = [EXC_HEAD.slice()].concat(excRows || []);
    h.state.spreadsheet = makeFakeSpreadsheet({ sheets: sheets });
    h.state.cache.clear();
    MEMOS.forEach(function (k) { h.ctx[k] = null; });
  };
  install([['2026-09-21', '', '8x8 <outage>', 'TRUE', 'a', '']]);
  const html = h.call('digestSummaryHtml_', 'Alpha', '2026-09-21', '2026-09-21', {});
  assert.match(html, /Exception day left out/);
  assert.match(html, /2026-09-21 \(8x8 &lt;outage&gt;\) is an exception day for Alpha/, 'named, with its reason escaped');
  assert.doesNotMatch(html, /No calls recorded/);
  assert.doesNotMatch(html, /roster or the queue mapping/);

  // A quiet day that is NOT an exception day keeps the R32 note.
  install([]);
  const quiet = h.call('digestSummaryHtml_', 'Alpha', '2026-09-22', '2026-09-22', {});
  assert.match(quiet, /No calls recorded/);
  assert.doesNotMatch(quiet, /Exception day/);
  // A stale send carries neither (its own callout explains the zeros).
  install([['2026-09-21', '', 'x', 'TRUE', 'a', '']]);
  assert.doesNotMatch(h.call('digestSummaryHtml_', 'Alpha', '2026-09-21', '2026-09-21', { stale: true }), /Exception day|No calls recorded/);
  // Another department's exception day is not this department's.
  install([['2026-09-21', 'Beta', 'x', 'TRUE', 'a', '']]);
  assert.doesNotMatch(h.call('digestSummaryHtml_', 'Alpha', '2026-09-21', '2026-09-21', {}), /Exception day/);
});

// ── EXD-4: alert reason + History ───────────────────────────────────────────
const al = loadGas({ files: ['Config.gs', 'Util.gs', 'EmailKit.gs', 'Alerts.gs', 'Notifications.gs', 'AlertReasons.gs'] });
function installAl(opts) {
  opts = opts || {};
  al.state.userEmail = 'admin@x.com';
  al.state.props = Object.assign({ SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' }, opts.props || {});
  al.state.sentEmails.length = 0;
  al.state.spreadsheet = makeFakeSpreadsheet({ sheets: {
    'Alert Config': [['Department', 'Threshold %', 'Extra Recipients', 'Active', 'Notes', 'Skip Dates'], ['CSR', 80, '', 'TRUE', '', '']],
    'Alert Log': [['Timestamp', 'Department', 'Date Checked', 'Threshold', 'Answer Rate', 'Sent', 'Recipients', 'Triggered By', 'Notes', 'Status']],
    'Access Control': [['Email', 'Department', 'Notes'], ['csr.mgr@x.com', 'CSR', '']],
    'Exception Days': [EXC_HEAD.slice()].concat(opts.exc || []),
  } });
  al.state.cache.clear();
  al.ctx.EXCEPTION_DAYS_MEMO_ = null;
  al.ctx.ALERT_REASON_RULES_MEMO_ = null;
  al.ctx.getAllDepartments_ = function () { return ['CSR', 'Sales']; };
  al.ctx.resolveUser_ = function (email) { return { email: email, role: email === 'admin@x.com' ? 'admin' : 'none' }; };
  al.ctx.isIsoDate_ = function (v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v)); };
  al.ctx.getRosterForDepartment_ = function () { return { names: ['Ann', 'Bob'] }; };
  al.ctx.isCompanyHoliday_ = function () { return false; };
  al.ctx.getTeamAvgExcludes_ = function () { return []; };
  al.ctx.alertRowsForRange_ = function () { return {}; };
}

test('EXD-4: an agent with duplicate rows on a day is still judged (the rows fold into one)', function () {
  installAl();
  const merged = J(al.call('alertMergeDayAgents_', [
    { name: 'Ann', rung: 10, answered: 2, missed: 8, pct: 20 },
    { name: 'Bob', rung: 10, answered: 9, missed: 1, pct: 90 },
    { name: 'Ann', rung: 10, answered: 4, missed: 6, pct: 40 }]));
  assert.deepEqual(merged.map(function (a) { return [a.name, a.answered, a.missed, a.pct]; }),
    [['Ann', 6, 14, 30], ['Bob', 9, 1, 90]]);
  const perDay = [
    { iso: '2026-10-14', agents: [{ name: 'Ann', rung: 10, answered: 2, missed: 8, pct: 20 }, { name: 'Ann', rung: 10, answered: 4, missed: 6, pct: 40 }] },
    { iso: '2026-10-13', agents: [{ name: 'Ann', rung: 10, answered: 3, missed: 7, pct: 30 }] },
  ];
  const out = J(al.call('alertAgentLowFindings_', perDay, 50, []));
  assert.deepEqual(out.map(function (f) { return f.name; }), ['Ann'], 'the second row used to read as "missed an earlier day"');
  assert.deepEqual(out[0].days.map(function (d) { return d.pct; }), [30, 30]);
  assert.deepEqual(J(al.call('alertMergeDayAgents_', null)), []);
});

test('EXD-4: a workday with no agent call data logs no-data, never "quiet"', function () {
  installAl({ props: { ALERT_REASON_RULES: JSON.stringify({ CSR: { agentLow: { threshold: 50, days: 2 } } }) } });
  const byIso = { '2026-10-14': [], '2026-10-13': [{ name: 'Ann', rung: 10, answered: 3, missed: 7, pct: 30 }] };
  al.ctx.computeDeptAnswerRateForDate_ = function (dept, iso) { return { rung: 0, answered: 0, missed: 0, pct: 0, lowAgents: [], agents: byIso[iso] || [] }; };
  const rows = [];
  al.call('runAlertReasons_', '2026-10-14', false, false, [], function (r) { rows.push(J(r)); });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'no-data');
  assert.match(rows[0].notes, /No agent call data for 2026-10-14 -- the 2-workday check was not assessed/);
  assert.equal(al.state.sentEmails.length, 0);
  // With data on both days and nobody below, it is quiet as before.
  byIso['2026-10-14'] = [{ name: 'Ann', rung: 10, answered: 9, missed: 1, pct: 90 }];
  rows.length = 0;
  al.call('runAlertReasons_', '2026-10-14', false, false, [], function (r) { rows.push(J(r)); });
  assert.equal(rows[0].status, 'quiet');
});

test('EXD-4: the rule History shows an exception day as one and leaves it out of both counts', function () {
  installAl({ exc: [['2026-10-13', '', '8x8 "outage"', 'TRUE', 'a', '']] });
  al.ctx.prevBusinessDayIso_ = function () { return '2026-10-14'; };
  // The rows are still there to read (queue narrowing off): below threshold every day.
  al.ctx.computeDeptAnswerRateForDate_ = function () { return { rung: 10, answered: 5, missed: 5, pct: 50, lowAgents: [] }; };
  const out = J(al.call('getAlertHistory', { department: 'CSR', days: 3 }));
  assert.deepEqual(out.days.map(function (d) { return [d.date, d.verdict]; }),
    [['2026-10-14', 'would-fire'], ['2026-10-13', 'exception-day'], ['2026-10-12', 'would-fire']]);
  assert.equal(out.days[1].reason, '8x8 "outage"');
  assert.equal(out.days[1].pct, null);
  assert.equal(out.assessedCount, 2, 'not a workday the rule was judged on (was 3)');
  assert.equal(out.firedCount, 2, 'nor one it would have fired on (was 3)');
  delete al.ctx.prevBusinessDayIso_;

  // The panel renders it, with the reason escaped.
  const admin = fs.readFileSync(path.join(DASH, 'script-7-admin.html'), 'utf8');
  const ctx = vm.createContext({ escapeHtml: function (s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); } });
  vm.runInContext(clientFn(admin, 'alRuleHistoryHtml_'), ctx);
  ctx.h = { threshold: 80, firedCount: 2, assessedCount: 2, days: out.days };
  const html = vm.runInContext('alRuleHistoryHtml_(h)', ctx);
  assert.match(html, /title="8x8 &quot;outage&quot;">exception day<\/span>/);
  assert.equal((html.match(/would fire/g) || []).length, 2);
});

// ── EXD-5 ───────────────────────────────────────────────────────────────────
test('EXD-5: the include switch is part of every last-good signature and of the outbound view key', function () {
  const dept = fs.readFileSync(path.join(DASH, 'script-5-dept.html'), 'utf8');
  const make = function (on) {
    const ctx = vm.createContext({ excIncludeOn_: function () { return on; } });
    vm.runInContext(clientFn(dept, 'reportSig_'), ctx);
    return function (req) { ctx.req = req; return vm.runInContext('reportSig_(req)', ctx); };
  };
  const req = { department: 'CSR', from: '2026-09-21', to: '2026-09-22', agents: ['Bob', 'Ann'] };
  const off = make(false)(req), on = make(true)(req);
  assert.notEqual(off, on, 'the included view is a different signature');
  assert.equal(off, JSON.stringify({ department: 'CSR', from: '2026-09-21', to: '2026-09-22', agents: ['Ann', 'Bob'] }),
    'off: exactly what it was, so stored copies still match');
  assert.deepEqual(JSON.parse(on).exc, true);
  // Every keep-last-good report takes its signature from reportSig_.
  ['script-5-dept.html', 'script-6-ir.html', 'script-8-insights.html', 'script-9-inbound-direct.html'].forEach(function (f) {
    const src = fs.readFileSync(path.join(DASH, f), 'utf8');
    (src.match(/reportSwrPaint_\('[a-z]+', ([A-Za-z_]+)/g) || []).forEach(function (m) {
      const v = m.split(', ')[1];
      assert.match(src, new RegExp('(const|var) ' + v + ' = reportSig_\\('), f + ': ' + v + ' is not built by reportSig_');
    });
  });
  assert.match(dept, /var __sig = reportSig_\(req\);\s*\n\s*var __swrHit = reportLastGoodRead_\('summary', __sig\);/);
  // The outbound view refetches for the other mode.
  assert.match(dept, /\+ '\|' \+ \(m\.priorFrom \|\| ''\) \+ '\|' \+ \(m\.priorTo \|\| ''\)\s*\n\s*\+ \(excIncludeOn_\(\) \? '\|x' : ''\);/);
});

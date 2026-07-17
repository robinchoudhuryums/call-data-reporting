'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

// Automated Daily Call Queue Report email (QueueReportEmail.gs): the report is
// emailed for the PREVIOUS WORKDAY, once daily, to opt-in subscribers, but ONLY
// after that day's QCD data has landed. The gate decision is a pure helper
// (queueReportGateDecision_) so the window / weekday / holiday / dedupe /
// readiness logic is testable without a clock.
const h = loadGas({ files: ['Config.gs', 'Util.gs', 'Data.gs', 'QueueReportEmail.gs'] });

function baseCtx(over) {
  // A "would send" context: enabled, mid-window, a weekday, no holiday, data
  // ready (latestQcd >= target), not yet sent.
  return Object.assign({
    enabled: true, hour: 8, dow: 3, holiday: false,
    targetIso: '2026-07-10', lastSent: '', latestQcd: '2026-07-10',
  }, over || {});
}

test('gate: sends when enabled + in-window + weekday + data ready + not yet sent', function () {
  const d = h.call('queueReportGateDecision_', baseCtx());
  assert.equal(d.send, true);
  assert.equal(d.reason, 'ready');
});

test('gate: skips when disabled / outside window / weekend / holiday', function () {
  assert.equal(h.call('queueReportGateDecision_', baseCtx({ enabled: false })).reason, 'disabled');
  assert.equal(h.call('queueReportGateDecision_', baseCtx({ hour: 5 })).reason, 'outside-window');   // before 6
  assert.equal(h.call('queueReportGateDecision_', baseCtx({ hour: 12 })).reason, 'outside-window');  // noon exclusive
  assert.equal(h.call('queueReportGateDecision_', baseCtx({ dow: 6 })).reason, 'weekend');
  assert.equal(h.call('queueReportGateDecision_', baseCtx({ dow: 0 })).reason, 'weekend');
  assert.equal(h.call('queueReportGateDecision_', baseCtx({ holiday: true })).reason, 'holiday');
});

test('gate: dedupe -- already sent this target date -> skip', function () {
  const d = h.call('queueReportGateDecision_', baseCtx({ lastSent: '2026-07-10' }));
  assert.equal(d.send, false);
  assert.equal(d.reason, 'already-sent');
});

test('gate: readiness -- QCD not yet at the target date -> not-ready (retry next poll)', function () {
  // Import hasn't written the target day's QCD yet (latest is the day before).
  assert.equal(h.call('queueReportGateDecision_', baseCtx({ latestQcd: '2026-07-09' })).reason, 'not-ready');
  assert.equal(h.call('queueReportGateDecision_', baseCtx({ latestQcd: '' })).reason, 'not-ready');
  // Exactly caught up -> ready.
  assert.equal(h.call('queueReportGateDecision_', baseCtx({ latestQcd: '2026-07-10' })).send, true);
});

test('subscribers: parses active/inactive rows, skips blank emails', function () {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: {
      'Queue Report Subscribers': [
        ['Email', 'Active', 'Notes'],
        ['a@x.com', 'TRUE', 'CSR lead'],
        ['b@x.com', 'FALSE', 'paused'],
        ['', 'TRUE', 'blank -- skipped'],
        ['c@x.com', '', 'empty active -> active'],
      ],
    },
  });
  const subs = h.call('readQueueReportSubscribers_', null);
  assert.equal(subs.length, 3);
  assert.equal(subs[0].email, 'a@x.com');
  assert.equal(subs[0].active, true);
  assert.equal(subs[1].active, false);      // FALSE
  assert.equal(subs[2].email, 'c@x.com');
  assert.equal(subs[2].active, true);       // blank active defaults to active
});

test('readiness read: queueReportQcdLatestIso_ returns the max QCD date', function () {
  h.state.props.SPREADSHEET_ID = 'fake';
  // QCD Historical Data: Month|Week|Date(col3)|... -- put ISO dates in col 3.
  const row = function (iso) { return ['Jul 2026', 'W28', iso, 'A_Q_X', 'Total Calls', 10, 8, 2, '', '', '', 0]; };
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: {
      'QCD Historical Data': [
        ['Month Year', 'Week', 'Date', 'Call Queue', 'Call Source', 'Total Calls',
         'Total Answered', 'Abandoned', 'Longest Wait', 'Avg Answer', 'Abandoned %', 'Violations'],
        row('2026-07-08'), row('2026-07-10'), row('2026-07-09'),
      ],
    },
  });
  assert.equal(h.call('queueReportQcdLatestIso_', null), '2026-07-10');
});

test('readiness read: no QCD sheet -> empty (not-ready)', function () {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.spreadsheet = makeFakeSpreadsheet({ timeZone: 'America/Chicago', sheets: {} });
  assert.equal(h.call('queueReportQcdLatestIso_', null), '');
});

// Verdict-layer email (design update): verdict alert + KPI row + worst-first
// per-queue td-bar table. CSR (7.0%, 2 viol) is a WATCH offender; Sales (2.5%,
// 0 viol) is HEALTHY.
function emailFixture() {
  return {
    dateLabel: 'Jul 10, 2026',
    depts: [
      { dept: 'CSR', parent: null,
        totals: { totalCalls: 100, totalAnswered: 93, abandoned: 7, abandonedPct: 7.0,
          abandonedPctStr: '7.00%', longestWait: '0:02:10', avgAnswer: '0:00:20', violations: 2 },
        queues: [{ queue: 'A_Q_CSR', totalCalls: 100, totalAnswered: 93, abandoned: 7,
          abandonedPct: 7.0, abandonedPctStr: '7.00%', violations: 2 }] },
      { dept: 'Sales', parent: null,
        totals: { totalCalls: 40, totalAnswered: 39, abandoned: 1, abandonedPct: 2.5,
          abandonedPctStr: '2.50%', longestWait: '0:01:00', avgAnswer: '0:00:15', violations: 0 },
        queues: [{ queue: 'A_Q_SALES', totalCalls: 40, totalAnswered: 39, abandoned: 1,
          abandonedPct: 2.5, abandonedPctStr: '2.50%', violations: 0 }] },
    ],
    grandTotals: { totalCalls: 140, totalAnswered: 132, abandoned: 8, abandonedPct: 5.71,
      abandonedPctStr: '5.71%', longestWait: '0:02:10', avgAnswer: '0:00:18', violations: 2 },
  };
}

test('email HTML: verdict alert + KPI row + worst-first table, bound to server figures', function () {
  h.state.props.DASHBOARD_URL = 'https://example.com/exec';
  const html = h.call('buildQueueReportEmailHtml_', emailFixture(), '2026-07-10', false);
  assert.match(html, /Daily Call Queue Report/);
  assert.match(html, /Jul 10, 2026/);
  assert.match(html, /Company total/);
  assert.match(html, /5\.71%/);                             // company aban % (grandTotals)
  assert.match(html, /example\.com\/exec#\/overview/);      // bulletproof CTA
  // Verdict: 1 queue over 5% (A_Q_CSR) -> alert fires with the offender.
  assert.match(html, /over the 5% line/);
  assert.match(html, /A_Q_CSR/);
  // WATCH offender carries the watch color; the HEALTHY row the green.
  assert.match(html, /#c66b4b/);                            // CSR (7%, 2 viol) = WATCH
  assert.match(html, /#3d9476/);                            // Sales (2.5%) = HEALTHY
  // Worst-first: CSR section precedes Sales.
  assert.ok(html.indexOf('CSR') < html.indexOf('Sales'), 'worst-first: CSR before Sales');
  // Old plain-table warn color is gone.
  assert.doesNotMatch(html, /#B45309/);
});

test('email HTML: a clean day renders the "under the 5% line" verdict (no alert)', function () {
  const clean = emailFixture();
  clean.depts[0].totals.abandonedPct = 3.0; clean.depts[0].totals.abandonedPctStr = '3.00%';
  clean.depts[0].totals.violations = 0; clean.depts[0].queues[0].abandonedPct = 3.0;
  clean.depts[0].queues[0].abandonedPctStr = '3.00%'; clean.depts[0].queues[0].violations = 0;
  clean.grandTotals.abandonedPct = 2.8; clean.grandTotals.abandonedPctStr = '2.80%'; clean.grandTotals.violations = 0;
  const html = h.call('buildQueueReportEmailHtml_', clean, '2026-07-10', false);
  assert.match(html, /All queues held under the 5% line/);
  assert.doesNotMatch(html, /over the 5% line/);
});

test('email HTML: empty day renders the no-activity note without throwing', function () {
  const html = h.call('buildQueueReportEmailHtml_', { dateLabel: 'Jul 10, 2026', depts: [], grandTotals: {} }, '2026-07-10', false);
  assert.match(html, /No queue activity recorded/);
});

// ── Batch 2 (O-1 / O-4 / O-7): send-loop reliability ────────────────────────

test('O-4: duplicate subscriber rows are flagged first-row-wins (no double-send)', function () {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: {
      'Queue Report Subscribers': [
        ['Email', 'Active', 'Notes'],
        ['a@x.com', 'TRUE', 'first'],
        ['A@X.com', 'TRUE', 'hand-edited duplicate'],
        ['b@x.com', 'TRUE', ''],
      ],
    },
  });
  const subs = h.call('readQueueReportSubscribers_', null);
  assert.equal(subs.length, 3, 'duplicate stays visible in the list');
  assert.equal(subs[0].duplicateRow, undefined);
  assert.equal(subs[1].duplicateRow, true, 'later copy flagged');
  assert.equal(subs.filter(function (s) { return s.active && !s.duplicateRow; }).length, 2,
    'send loop sees each subscriber once');
});

test('O-1: a mid-list send failure is isolated; successes and failures both reported', function () {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: {
      'Queue Report Subscribers': [
        ['Email', 'Active', 'Notes'],
        ['ok1@x.com', 'TRUE', ''], ['bad@x.com', 'TRUE', ''], ['ok2@x.com', 'TRUE', ''],
      ],
    },
  });
  h.ctx.qcdAllDeptCachedData_ = function () {
    return { data: { dateLabel: 'Jul 10, 2026', depts: [], grandTotals: {} } };
  };
  const sent = [];
  h.ctx.MailApp = { sendEmail: function (arg) {
    if (String(arg.to).indexOf('bad@') === 0) throw new Error('Invalid email: bad@x.com');
    sent.push(arg.to);
  } };
  const res = h.call('sendQueueReportForDate_', '2026-07-10', {});
  // Array.from: vm-realm arrays fail deepStrictEqual on prototype identity.
  assert.deepEqual(Array.from(res.to), ['ok1@x.com', 'ok2@x.com'], 'later subscriber still receives the report');
  assert.equal(res.count, 2);
  assert.equal(res.failed.length, 1);
  assert.equal(res.failed[0].email, 'bad@x.com');
});

test('O-1: the single-address preview path still throws (admin sees the error)', function () {
  h.ctx.qcdAllDeptCachedData_ = function () {
    return { data: { dateLabel: 'Jul 10, 2026', depts: [], grandTotals: {} } };
  };
  h.ctx.MailApp = { sendEmail: function () { throw new Error('quota'); } };
  assert.throws(function () {
    h.call('sendQueueReportForDate_', '2026-07-10', { to: 'admin@x.com', isPreview: true });
  }, /quota/);
});

test('O-7: a window-closed-without-send day is flagged ONCE (MISSED result + one admin email)', function () {
  h.state.props = { ADMIN_EMAILS: 'admin@x.com', QUEUE_REPORT_LAST_SENT: '2026-07-08' };
  h.state.sentEmails.length = 0;
  const props = {
    getProperty: function (k) { return h.state.props[k] || null; },
    setProperty: function (k, v) { h.state.props[k] = String(v); },
  };
  const mails = [];
  h.ctx.MailApp = { sendEmail: function (arg) { mails.push(arg); } };
  // TZ-absolute so the fixture is host-TZ independent: Fri Jul 10, 2 PM
  // Chicago (CDT = UTC-5) -- post-window.
  const afternoon = new Date('2026-07-10T14:00:00-05:00');
  h.call('queueReportFlagMissedDay_', props, afternoon, '2026-07-09');
  assert.equal(h.state.props.QUEUE_REPORT_LAST_MISSED, '2026-07-09');
  assert.match(h.state.props.QUEUE_REPORT_LAST_RESULT, /^MISSED 2026-07-09/);
  assert.equal(mails.length, 1, 'one admin notification');
  // Second post-window poll the same day: no re-flag, no second email.
  h.call('queueReportFlagMissedDay_', props, afternoon, '2026-07-09');
  assert.equal(mails.length, 1, 'flagged once per target day');
});

test('O-7: morning polls, sent days, and fresh installs are never flagged', function () {
  const mails = [];
  h.ctx.MailApp = { sendEmail: function (arg) { mails.push(arg); } };
  function freshProps(over) {
    const bag = Object.assign({ ADMIN_EMAILS: 'admin@x.com' }, over || {});
    return {
      bag: bag,
      getProperty: function (k) { return bag[k] || null; },
      setProperty: function (k, v) { bag[k] = String(v); },
    };
  }
  // Morning (pre-window-close, 7 AM Chicago) -> no flag.
  let p = freshProps({ QUEUE_REPORT_LAST_SENT: '2026-07-08' });
  h.call('queueReportFlagMissedDay_', p, new Date('2026-07-10T07:00:00-05:00'), '2026-07-09');
  assert.equal(p.bag.QUEUE_REPORT_LAST_MISSED, undefined);
  // Already sent the target -> no flag.
  p = freshProps({ QUEUE_REPORT_LAST_SENT: '2026-07-09' });
  h.call('queueReportFlagMissedDay_', p, new Date('2026-07-10T14:00:00-05:00'), '2026-07-09');
  assert.equal(p.bag.QUEUE_REPORT_LAST_MISSED, undefined);
  // Fresh install (nothing ever sent) -> no baseline, no flag.
  p = freshProps({});
  h.call('queueReportFlagMissedDay_', p, new Date('2026-07-10T14:00:00-05:00'), '2026-07-09');
  assert.equal(p.bag.QUEUE_REPORT_LAST_MISSED, undefined);
  assert.equal(mails.length, 0);
});

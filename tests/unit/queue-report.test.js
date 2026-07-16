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

test('email HTML: renders dept rows + grand total, warn-tints abandoned % over 5%', function () {
  h.state.props.DASHBOARD_URL = 'https://example.com/exec';
  const data = {
    dateLabel: 'Jul 10, 2026',
    depts: [
      { dept: 'CSR', parent: null, totals: { totalCalls: 100, totalAnswered: 93, abandoned: 7,
        abandonedPct: 7.0, abandonedPctStr: '7.00%', longestWait: '0:02:10', avgAnswer: '0:00:20', violations: 2 } },
      { dept: 'Sales', parent: null, totals: { totalCalls: 40, totalAnswered: 39, abandoned: 1,
        abandonedPct: 2.5, abandonedPctStr: '2.50%', longestWait: '0:01:00', avgAnswer: '0:00:15', violations: 0 } },
    ],
    grandTotals: { totalCalls: 140, totalAnswered: 132, abandoned: 8, abandonedPct: 5.71,
      abandonedPctStr: '5.71%', longestWait: '0:02:10', avgAnswer: '0:00:18', violations: 2 },
  };
  const html = h.call('buildQueueReportEmailHtml_', data, '2026-07-10', false);
  assert.match(html, /Daily Call Queue Report/);
  assert.match(html, /Jul 10, 2026/);
  assert.match(html, /CSR/);
  assert.match(html, /Company total/);
  assert.match(html, /7\.00%/);
  assert.match(html, /5\.71%/);
  assert.match(html, /example\.com\/exec#\/overview/);   // dashboard link
  // The 7.00% (>=5) cell carries the warn color; the 2.50% (<5) does not.
  assert.match(html, /#B45309[^<]*>7\.00%/);
  assert.doesNotMatch(html, /#B45309[^<]*>2\.50%/);
});

test('email HTML: empty day renders the no-activity note without throwing', function () {
  const html = h.call('buildQueueReportEmailHtml_', { dateLabel: 'Jul 10, 2026', depts: [], grandTotals: {} }, '2026-07-10', false);
  assert.match(html, /No queue activity recorded/);
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// F-4: getCallJourney's exact-id fallback (needed because inbound_calls
// stores RAW queue names that miss the dept-scoped predicate) used to trust
// the client's claim that the call id was "already dept-entitled upstream" --
// any manager with another dept's call id could pull that call's journey.
// The server now verifies the claim itself via callIdInDeptMissedReport_:
// the id must appear as an abandoned parent id in the dept's OWN Missed
// Calls report for that date (agent timelines or the queue-only section).

const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'InboundReport.gs'],
});

function stubMissedReport(rpt) {
  h.ctx.getMissedCallsReport = function (req) {
    stubMissedReport.lastReq = req;
    if (rpt instanceof Error) throw rpt;
    return rpt;
  };
}

const RPT = {
  agents: [
    { name: 'Anna', missedTimes: [
      { date: '2026-06-22', time: '9:05', abandoned: true, parentId: 'PA' },
      { date: '2026-06-22', time: '9:40', abandoned: false, parentId: null },
    ] },
  ],
  queueOnly: [
    { queue: 'A_Q_CSR', entries: [
      { date: '2026-06-22', time: '10:00', abandoned: true, parentId: 'PQ' },
    ] },
  ],
};

test('F-4: id on an agent timeline in the dept\'s missed report -> entitled', function () {
  stubMissedReport(RPT);
  assert.equal(h.call('callIdInDeptMissedReport_', 'CSR', '2026-06-22', 'PA'), true);
  // The check runs against the dept's own single-day report.
  assert.equal(stubMissedReport.lastReq.department, 'CSR');
  assert.equal(stubMissedReport.lastReq.from, '2026-06-22');
  assert.equal(stubMissedReport.lastReq.to, '2026-06-22');
});

test('F-4: id in the queue-only abandoned section -> entitled', function () {
  stubMissedReport(RPT);
  assert.equal(h.call('callIdInDeptMissedReport_', 'CSR', '2026-06-22', 'PQ'), true);
});

test('F-4: an id NOT in the dept\'s missed report -> refused', function () {
  stubMissedReport(RPT);
  assert.equal(h.call('callIdInDeptMissedReport_', 'CSR', '2026-06-22', 'OTHER-DEPT-ID'), false);
});

test('F-4: report compute failure -> refused (fallback stays closed)', function () {
  stubMissedReport(new Error('boom'));
  assert.equal(h.call('callIdInDeptMissedReport_', 'CSR', '2026-06-22', 'PA'), false);
});

test('F-4: blank dept or id -> refused without computing a report', function () {
  stubMissedReport(new Error('should not be called'));
  assert.equal(h.call('callIdInDeptMissedReport_', '', '2026-06-22', 'PA'), false);
  assert.equal(h.call('callIdInDeptMissedReport_', 'CSR', '2026-06-22', ''), false);
});

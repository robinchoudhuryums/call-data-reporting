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

// ── R-3: the all-departments manager (Access Control dept = ALL) ────────────
function fakeJourneyConn(callJson) {
  return {
    prepareStatement: function () {
      let done = false;
      return {
        setString: function () {},
        executeQuery: function () {
          return {
            next: function () { if (done) return false; done = true; return true; },
            getString: function () { return callJson; },
            close: function () {},
          };
        },
        close: function () {},
      };
    },
    close: function () {},
  };
}

test('R-3: allDepts manager can drill any dept\'s journey (was: threw on every drill)', function () {
  h.ctx.isIsoDate_ = function (s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s)); };
  h.ctx.resolveUser_ = function () {
    return { role: 'manager', allDepts: true, department: null, departments: ['CSR', 'Sales'] };
  };
  h.ctx.getAllDepartments_ = function () { return ['CSR', 'Sales']; };
  h.ctx.inboundQueuesForDept_ = function () { return ['A_Q_CustomerSuccess']; };
  h.ctx.callerLookupShapeCall_ = function (c) { return c; };
  h.ctx.getDashboardNeonConn_ = function () {
    return fakeJourneyConn(JSON.stringify({ call_date: '2026-06-22', call_id: 'PA' }));
  };
  const res = h.call('getCallJourney', { callId: 'PA', date: '2026-06-22', department: 'Sales' });
  assert.equal(res.found, true, 'no "Not authorized" throw for the viewed dept');
});

test('R-3: single-dept managers stay pinned (no widening leak)', function () {
  h.ctx.isIsoDate_ = function (s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s)); };
  h.ctx.resolveUser_ = function () {
    return { role: 'manager', allDepts: false, department: 'CSR' };
  };
  h.ctx.getAllDepartments_ = function () { return ['CSR', 'Sales']; };
  assert.throws(function () {
    h.call('getCallJourney', { callId: 'PA', date: '2026-06-22', department: 'Sales' });
  }, /Not authorized for this department/);
});

// ── PC-5 (broad-scan 2026-10-01): the link is the capability, inbound kind too ──
// The receiving dept's internal transfer record carries related_call_id = the
// CUSTOMER call; its "view that call's path" link failed both arms (the customer
// call sits in the ORIGIN dept's queues, not in the receiving Missed report).

// A fake conn that routes on the SQL text. `linkers(predicated)` answers the
// related_call_id probe; the to_jsonb lookup answers with `callJson` only when
// UNSCOPED (the scoped lookup misses, as the real queue-name space does).
function routingConn(opts) {
  return {
    prepareStatement: function (sql) {
      let rows = [];
      if (/related_call_id = \?/.test(sql)) {
        rows = (opts.linkers(/entry_queue/.test(sql)) || []).map(function (id) { return { linker: id }; });
      } else if (/to_jsonb\(c\)/.test(sql)) {
        rows = /entry_queue/.test(sql) ? [] : [{ j: opts.callJson }];
      } else if (/MIN\(call_date\)/.test(sql)) {
        rows = [{ min_d: '2026-01-01', day_has: 'true' }];
      }
      let i = -1;
      return {
        setString: function () {},
        executeQuery: function () {
          return { next: function () { i++; return i < rows.length; },
                   getString: function (k) { return rows[i][k]; },
                   getBoolean: function (k) { return !!rows[i][k]; }, close: function () {} };
        },
        close: function () {},
      };
    },
    close: function () {},
  };
}

function withJourney(user, conn, fn) {
  const saved = { resolveUser_: h.ctx.resolveUser_, getDashboardNeonConn_: h.ctx.getDashboardNeonConn_,
                  getAllDepartments_: h.ctx.getAllDepartments_, assertManagerOrAdmin_: h.ctx.assertManagerOrAdmin_,
                  inboundQueuesForDept_: h.ctx.inboundQueuesForDept_, inboundDeptFinalLabels_: h.ctx.inboundDeptFinalLabels_,
                  isIsoDate_: h.ctx.isIsoDate_ };
  h.ctx.resolveUser_ = function () { return user; };
  h.ctx.getDashboardNeonConn_ = function () { return conn; };
  h.ctx.getAllDepartments_ = function () { return ['CSR', 'Billing']; };
  h.ctx.assertManagerOrAdmin_ = function () {};
  h.ctx.inboundQueuesForDept_ = function (d) { return d === 'Billing' ? ['A_Q_Billing'] : ['A_Q_CSR']; };
  h.ctx.inboundDeptFinalLabels_ = function (d) { return [String(d).toLowerCase()]; };
  h.ctx.isIsoDate_ = function (s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s)); };
  try { return fn(); } finally { Object.keys(saved).forEach(function (k) { h.ctx[k] = saved[k]; }); }
}

const BILLING_MGR = { role: 'manager', department: 'Billing', departments: ['Billing'], email: 'b@x.com' };
const CUSTOMER_CALL = JSON.stringify({ call_date: '2026-06-22', call_id: 'C1', disposition: 'answered',
  entry_queue: 'A_Q_CSR', journey: [] });

test('PC-5: the receiving dept\'s manager reaches the customer call their own transfer record links to', function () {
  stubMissedReport({ agents: [], queueOnly: [] });   // not in Billing's Missed report
  const res = withJourney(BILLING_MGR, routingConn({
    callJson: CUSTOMER_CALL,
    linkers: function (predicated) { return predicated ? ['T1'] : ['T1']; },   // T1 is Billing's own record
  }), function () { return h.call('getCallJourney', { callId: 'C1', date: '2026-06-22', department: 'Billing' }); });
  assert.equal(res.found, true, 'pre-PC-5: a reason-less "not found" dead end');
  assert.ok(res.call, 'the call is served (its shape is callerLookupShapeCall_\'s, pinned elsewhere)');
});

test('PC-5: no drillable link -> still refused, reason-less (the SEC-7 rule holds)', function () {
  stubMissedReport({ agents: [], queueOnly: [] });
  const res = withJourney(BILLING_MGR, routingConn({
    callJson: CUSTOMER_CALL,
    linkers: function () { return []; },
  }), function () { return h.call('getCallJourney', { callId: 'C1', date: '2026-06-22', department: 'Billing' }); });
  assert.equal(res.found, false);
  assert.equal(res.reason, undefined, 'a gate-closed manager learns nothing about the call');
});

test('PC-5: a link reachable only through the manager\'s Missed report (arm 2) also entitles', function () {
  stubMissedReport({ agents: [], queueOnly: [{ queue: 'A_Q_Billing', entries: [{ parentId: 'T9' }] }] });
  const res = withJourney(BILLING_MGR, routingConn({
    callJson: CUSTOMER_CALL,
    linkers: function (predicated) { return predicated ? [] : ['T9']; },
  }), function () { return h.call('getCallJourney', { callId: 'C1', date: '2026-06-22', department: 'Billing' }); });
  assert.equal(res.found, true);
});

'use strict';

// Transfer filter, Phase 0 (owner request 2026-10-05): the read-only shape
// probe in cdr-import/transferFilter.js, plus the concurrency helpers it shares
// with the inbound capture (icGroupLegsByRoot_ / icBusyIndexes_ /
// icConcurrentMatches_, extracted from buildInboundCallRecords_ so the probe
// links a transfer to its customer call by the capture's OWN rule).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

const h = loadGas({ project: 'cdr-import', files: ['buildDQEHistoricalData.js', 'inboundCalls.js', 'transferFilter.js'] });

// 44-wide Call_Legs row from named fields (indices per IC_COL) -- the
// inbound-calls.test.js builder.
function leg(o) {
  const r = new Array(44).fill('');
  r[0] = o.callId; r[1] = o.legId; r[2] = o.start; r[3] = o.connected || ''; r[4] = o.stop || '';
  r[5] = o.direction; r[6] = o.talk || '0:00:00'; r[7] = o.callTime || '0:00:00';
  r[8] = o.caller; r[9] = o.callerName || ''; r[10] = o.callee; r[11] = o.calleeName || '';
  r[14] = o.parent || 'N/A'; r[16] = o.dialIn || 'N/A';
  r[23] = o.missed || '-'; r[24] = o.abandoned || '-'; r[25] = o.answered || '-';
  r[36] = o.dept || 'N/A';
  return r;
}
const D = '06/04/2026 ';

// A customer call into A_Q_CSR (ext 103) answered by Raymond (ext 215),
// 10:00:05 - 10:05:00. The caller-ID name is customer data.
function customerAnsweredBy215(callId, phone) {
  return [
    leg({ callId, legId: 1, start: D + '09:59:50', stop: D + '10:00:05', direction: 'Incoming',
          caller: phone || '12145559999', callerName: 'WIRELESS CALLER', callee: '103', calleeName: 'A_Q_CSR' }),
    leg({ callId, legId: 2, start: D + '10:00:05', connected: D + '10:00:05', stop: D + '10:05:00',
          direction: 'Incoming', talk: '0:04:55', caller: phone || '12145559999', callerName: 'WIRELESS CALLER',
          callee: '215', calleeName: 'Raymond (Ray) Mathews', answered: 'Answered', dept: 'CSR' }),
  ];
}

const ROSTER = h.call('tfRosterFromGrid_',
  ['CSR', 'Sales', 'FieldOps', '', 'Insurance block'],
  [
    ['Raymond (Ray) Mathews, 215', 'Sam Seller, 300', 'Marie (Muskaan) Jindal, 279', '', 'not a dept'],
    ['Dana Desk, 352',             'Pat (P) Lee, 301, 302', '', '', ''],
    ['',                           'Raymond (Ray) Mathews, 215', '', '', ''],
  ]);

function classify(rows, dept, queues) {
  return h.call('tfClassifyTransfers_', rows, { dept, queues, roster: ROSTER });
}

test('tfRosterFromGrid_: INV-03 cells, every extension, two rosters, stops at the first blank header', function () {
  assert.deepEqual(Array.from(ROSTER.depts), ['CSR', 'Sales', 'FieldOps']);
  assert.ok(ROSTER.byDept.Sales.exts['301'] && ROSTER.byDept.Sales.exts['302'], 'every digit-only token is an extension');
  assert.ok(ROSTER.byDept.Sales.names['Raymond (Ray) Mathews'] && ROSTER.byDept.CSR.names['Raymond (Ray) Mathews'],
    'an agent on two rosters is in both');
  assert.equal(ROSTER.nameOfExt['302'], 'Pat (P) Lee');
  assert.equal(ROSTER.byDept['Insurance block'], undefined, 'nothing past the blank header');
});

test('tfDeptQueuesFromConfig_: QCD Queues + both sides of each alias, that dept only', function () {
  const row = (d, q, a) => { const r = new Array(10).fill(''); r[0] = d; r[1] = q; r[5] = true; r[9] = a; return r; };
  const out = h.call('tfDeptQueuesFromConfig_', 'CSR', [
    row('CSR', 'A_Q_CustomerSuccess, A_Q_Intake', 'A_Q_CSR=A_Q_CustomerSuccess, Backup CSR, 103'),
    row('Sales', 'A_Q_Sales', ''),
  ]);
  assert.deepEqual(Array.from(out), ['A_Q_CustomerSuccess', 'A_Q_Intake', 'A_Q_CSR', 'Backup CSR'],
    'raw + canonical names, no extension, no duplicate, no other dept');
  assert.equal(h.call('tfDeptQueuesFromConfig_', 'Billing', []).length, 0);
});

test('icConcurrentMatches_: the +/-5 s slack is inclusive and the own group is excluded', function () {
  const busy = [{ root: 'A', ext: '215', startMs: 10000, endMs: 20000 }];
  assert.equal(h.call('icConcurrentMatches_', busy, '215', 5000, 'X').length, 1);
  assert.equal(h.call('icConcurrentMatches_', busy, '215', 25000, 'X').length, 1);
  assert.equal(h.call('icConcurrentMatches_', busy, '215', 4999, 'X').length, 0);
  assert.equal(h.call('icConcurrentMatches_', busy, '215', 15000, 'A').length, 0, 'never the event\'s own group');
  assert.equal(h.call('icConcurrentMatches_', busy, '216', 15000, 'X').length, 0);
});

test('QUEUE transfer: an employee on a customer call dials the dept queue -> linked to that call, answered', function () {
  const res = classify(customerAnsweredBy215('900001').concat([
    leg({ callId: '900100', legId: 1, start: D + '10:03:00', connected: D + '10:03:00', stop: D + '10:03:20',
          direction: 'Internal', caller: '215', callerName: 'Raymond Mathews', callee: '400', calleeName: 'A_Q_Sales' }),
    // The queue delivering it: caller = the queue ext. Not a direct transfer.
    leg({ callId: '900101', legId: 1, parent: '900100', start: D + '10:03:20', connected: D + '10:03:20',
          stop: D + '10:08:00', direction: 'Internal', talk: '0:04:40', caller: '400',
          callee: '300', calleeName: 'Sam Seller', answered: 'Answered' }),
  ]), 'Sales', ['A_Q_Sales']);
  assert.equal(res.queue.length, 1);
  const t = res.queue[0];
  assert.equal(t.root, '900100');
  assert.equal(t.caller.name, 'Raymond (Ray) Mathews', 'named from the roster by extension');
  assert.equal(t.caller.rostered, true);
  assert.equal(t.target, 'A_Q_Sales');
  assert.equal(t.link.kind, 'inbound');
  assert.equal(t.link.root, '900001');
  assert.equal(t.outcome.state, 'answered');
  assert.equal(t.outcome.by, 'Sam Seller');
  assert.equal(t.inWindow, true);
  assert.equal(res.direct.length, 0, 'the queue ringing Sam is the delivery, not a direct transfer');
});

test('QUEUE transfer with no customer call at that moment is listed, unlinked', function () {
  const res = classify([
    leg({ callId: '900200', legId: 1, start: D + '13:00:00', stop: D + '13:02:00', direction: 'Internal',
          caller: '279', callerName: 'Marie (Muskaan) Jindal', callee: '400', calleeName: 'A_Q_Sales',
          abandoned: 'Abandoned', missed: 'Missed' }),
  ], 'Sales', ['A_Q_Sales']);
  assert.equal(res.queue.length, 1);
  assert.equal(res.queue[0].link.kind, 'none');
  assert.equal(res.queue[0].outcome.state, 'abandoned');
});

test('a customer entering the queue, and a queue delivery carrying the CUSTOMER\'s name, are not transfers', function () {
  const res = classify(customerAnsweredBy215('900300').concat([
    leg({ callId: '900301', legId: 1, start: D + '11:00:00', stop: D + '11:00:30', direction: 'Incoming',
          caller: '19725550101', callerName: 'SMITH JOHN', callee: '400', calleeName: 'A_Q_Sales' }),
    // A_Q_CSR's ext (103, seen on the tab) delivering a call to a Sales-rostered
    // agent; CALLER NAME is the customer's caller ID.
    leg({ callId: '900302', legId: 1, parent: '900300', start: D + '10:00:04', direction: 'Internal',
          caller: '103', callerName: 'Rita Grant', callee: '215', calleeName: 'Raymond (Ray) Mathews', missed: 'Missed' }),
  ]), 'Sales', ['A_Q_Sales']);
  assert.equal(res.queue.length, 0);
  assert.equal(res.direct.length, 0);
});

test('DIRECT transfer: linked when placed during a customer call, unlinked for a colleague call', function () {
  const res = classify(customerAnsweredBy215('900400').concat([
    leg({ callId: '900401', legId: 1, start: D + '10:04:00', connected: D + '10:04:02', stop: D + '10:06:00',
          direction: 'Internal', talk: '0:01:58', caller: '215', callee: '301', calleeName: 'Pat Lee', answered: 'Answered' }),
    leg({ callId: '900402', legId: 1, start: D + '14:00:00', connected: D + '14:00:02', stop: D + '14:01:00',
          direction: 'Internal', talk: '0:00:58', caller: '279', callee: '302', calleeName: 'Pat (P) Lee', answered: 'Answered' }),
  ]), 'Sales', ['A_Q_Sales']);
  assert.equal(res.direct.length, 2);
  const byRoot = {};
  res.direct.forEach(t => { byRoot[t.root] = t; });
  assert.equal(byRoot['900401'].link.kind, 'inbound');
  assert.equal(byRoot['900401'].link.root, '900400');
  assert.equal(byRoot['900401'].target, 'Pat (P) Lee', 'the roster name, by extension');
  assert.equal(byRoot['900402'].link.kind, 'none', 'a colleague call -- what "allow unlinked" adds');
});

test('ambiguous: two concurrent customer calls -> not linked, never guessed', function () {
  const res = classify(customerAnsweredBy215('900500').concat(customerAnsweredBy215('900501', '12145550002')).concat([
    leg({ callId: '900502', legId: 1, start: D + '10:03:00', stop: D + '10:03:30', direction: 'Internal',
          caller: '215', callee: '400', calleeName: 'A_Q_Sales' }),
  ]), 'Sales', ['A_Q_Sales']);
  assert.equal(res.queue[0].link.kind, 'ambiguous');
  assert.equal(res.queue[0].link.n, 2);
});

test('one transfer per root call: re-rings of the same queue are one row', function () {
  const res = classify([
    leg({ callId: '900600', legId: 1, start: D + '12:00:00', stop: D + '12:00:30', direction: 'Internal',
          caller: '279', callee: '400', calleeName: 'A_Q_Sales' }),
    leg({ callId: '900601', legId: 1, parent: '900600', start: D + '12:00:31', stop: D + '12:01:00', direction: 'Internal',
          caller: '279', callee: '400', calleeName: 'A_Q_Sales' }),
  ], 'Sales', ['A_Q_Sales']);
  assert.equal(res.queue.length, 1);
});

test('work window: R49 early floor for the CSR family only; 3:00 PM PST end', function () {
  const at = (cid, t, q) => leg({ callId: cid, legId: 1, start: D + t, stop: D + t, direction: 'Internal',
                                   caller: '279', callee: '400', calleeName: q });
  const csr = classify([at('901', '06:10:00', 'A_Q_CSR'), at('902', '15:10:00', 'A_Q_CSR')], 'CSR', ['A_Q_CSR']);
  const w = {}; csr.queue.forEach(t => { w[t.root] = t.inWindow; });
  assert.equal(w['901'], true, '6:10 PST is inside the CSR family\'s 6:00 floor');
  assert.equal(w['902'], false, 'after 3:00 PM PST');
  const sales = classify([at('903', '06:10:00', 'A_Q_Sales')], 'Sales', ['A_Q_Sales']);
  assert.equal(sales.queue[0].inWindow, false, 'every other queue keeps the 6:30 floor');
});

test('POSSIBLE BLIND: the customer re-enters the dept queue after an answer; same-second fan-out rings are not', function () {
  const res = classify(customerAnsweredBy215('900700').concat([
    leg({ callId: '900700', legId: 3, start: D + '10:05:00', stop: D + '10:05:40', direction: 'Incoming',
          caller: '12145559999', callee: '400', calleeName: 'A_Q_Sales' }),
    // Rang Dana (CSR) in the same second Raymond was answered: a fan-out ring.
    leg({ callId: '900700', legId: 9, start: D + '10:00:05', direction: 'Incoming',
          caller: '12145559999', callee: '352', calleeName: 'Dana Desk', missed: 'Missed' }),
  ]), 'Sales', ['A_Q_Sales']);
  assert.equal(res.blindQueue.length, 1);
  assert.equal(res.blindQueue[0].answeredBy, 'Raymond (Ray) Mathews');
  assert.equal(res.blindQueue[0].target, 'A_Q_Sales');
  const csr = classify(customerAnsweredBy215('900700').concat([
    leg({ callId: '900700', legId: 9, start: D + '10:00:05', direction: 'Incoming',
          caller: '12145559999', callee: '352', calleeName: 'Dana Desk', missed: 'Missed' }),
  ]), 'CSR', ['A_Q_CSR']);
  assert.equal(csr.blindDirect.length, 0, 'a ring in the answer\'s own second is the fan-out');
  const later = classify(customerAnsweredBy215('900700').concat([
    leg({ callId: '900700', legId: 9, start: D + '10:05:01', direction: 'Incoming',
          caller: '12145559999', callee: '352', calleeName: 'Dana Desk', missed: 'Missed' }),
  ]), 'CSR', ['A_Q_CSR']);
  assert.equal(later.blindDirect.length, 1);
  assert.equal(later.blindDirect[0].target, 'Dana Desk');
});

test('the report names employees and call ids but never a customer number or caller-ID name', function () {
  const rows = customerAnsweredBy215('900800').concat([
    leg({ callId: '900801', legId: 1, start: D + '10:03:00', stop: D + '10:03:20', direction: 'Internal',
          caller: '215', callee: '400', calleeName: 'A_Q_Sales' }),
    leg({ callId: '900800', legId: 3, start: D + '10:05:00', stop: D + '10:05:40', direction: 'Incoming',
          caller: '12145559999', callerName: 'WIRELESS CALLER', callee: '400', calleeName: 'A_Q_Sales' }),
  ]);
  const res = classify(rows, 'Sales', ['A_Q_Sales']);
  const lines = Array.from(h.call('tfReportLines_', res, { date: '2026-06-04', dept: 'Sales', queues: ['A_Q_Sales'] }));
  const text = lines.join('\n');
  assert.match(text, /Raymond \(Ray\) Mathews/);
  assert.match(text, /call 900801/);
  assert.match(text, /\(1\) QUEUE transfers into Sales's queues[^\n]*: 1 call/);
  assert.match(text, /\(3a\)[^\n]*: 1 call/);
  assert.doesNotMatch(text, /2145559999|WIRELESS CALLER/, 'no customer data');
  assert.match(text, /A_Q_Sales\* \(\d+\)/, 'counted queues are starred');
  assert.match(text, /A_Q_CSR \(\d+\)/, 'queues on the tab that are not counted are listed unstarred');
});

test('same-tree link: a transfer leg under the customer call\'s own root is linked as "tree"', function () {
  // The warm-transfer shape (owner's 2026-08-21 sample): the employee's
  // outbound customer leg and their queue leg share one root, so the
  // concurrency index (which excludes the event's own group) cannot link it.
  const res = classify([
    leg({ callId: '900900', legId: 1, start: D + '09:00:00', connected: D + '09:00:05', stop: D + '09:10:00',
          direction: 'Outgoing', talk: '0:09:55', caller: '279', callerName: 'Marie (Muskaan) Jindal',
          callee: '19725550188', answered: 'Answered' }),
    leg({ callId: '900901', legId: 1, parent: '900900', start: D + '09:04:00', stop: D + '09:05:00',
          direction: 'Internal', caller: '279', callerName: 'Marie (Muskaan) Jindal',
          callee: '400', calleeName: 'A_Q_Sales' }),
  ], 'Sales', ['A_Q_Sales']);
  assert.equal(res.queue.length, 1);
  assert.equal(res.queue[0].link.kind, 'tree');
  assert.equal(res.queue[0].link.root, '900900');
});

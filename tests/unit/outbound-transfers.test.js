'use strict';

// Owner report 2026-10-23: a warm transfer counted as the receiving rep's
// OUTBOUND call. 8x8 writes the hand-over as a new call whose only external
// leg is `Outgoing` from the rep to the customer, so the capture's
// no-Incoming gate passes it. diagnoseOutboundTransfers measures the two
// signals that tie it back -- the "Transfer To Call ID" link (A) and the
// number being live on another call at that moment (B) -- before either
// becomes a rule. The fixture is the owner's own 10/22 example, abridged.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

const h = loadGas({ project: 'cdr-import', files: ['inboundCalls.js', 'outboundCalls.js'] });
const J = (x) => JSON.parse(JSON.stringify(x));
const CUST = '18115557777';

function leg(o) {
  const r = new Array(44).fill('');
  r[0] = o.id; r[1] = o.leg; r[2] = '10/22/2026 ' + o.start; r[3] = o.conn ? '10/22/2026 ' + o.conn : 'N/A';
  r[4] = '10/22/2026 ' + o.stop; r[5] = o.dir; r[6] = o.talk || '0:00:00'; r[7] = o.talk || '0:00:00';
  r[8] = o.caller; r[9] = o.callerName || 'N/A'; r[10] = o.callee; r[11] = o.calleeName || 'N/A';
  r[14] = o.parent || 'N/A'; r[15] = o.to || 'N/A'; r[16] = 'N/A';
  r[23] = '-'; r[24] = '-'; r[25] = o.ans || '-'; r[36] = 'Customer Success';
  return r;
}

// A: the customer's inbound call, answered by Camila (304), transferred to B.
// B: Camila consults Nicolas (250) via a queue; the customer is merged in as
//    Nicolas's Outgoing leg, then sent on to PAP (Incoming legs) and Percy.
// C: Percy consults Julienne (297) via A_Q_CSR; the customer is merged in as
//    Julienne's Outgoing leg -- the "outbound call" the owner found.
function ownerExample() {
  return [
    leg({ id: 'A', leg: 1, start: '8:42:49', stop: '8:43:07', dir: 'Incoming', caller: CUST, callee: '999', calleeName: 'Introduction - New' }),
    leg({ id: 'A', leg: 3, start: '8:43:40', stop: '8:43:54', dir: 'Incoming', caller: CUST, callee: '103', calleeName: 'A_Q_CSR', ans: 'Answered' }),
    leg({ id: 'A', leg: 4, start: '8:43:54', conn: '8:43:54', stop: '8:52:06', dir: 'Incoming', talk: '0:08:12', caller: CUST,
          callee: '304', calleeName: 'Camila (Cheshta) Bhutani', to: 'B', ans: 'Answered' }),
    leg({ id: 'B', leg: 1, start: '8:46:38', stop: '8:47:01', dir: 'Internal', caller: '304', callerName: 'Camila (Cheshta) Bhutani',
          callee: '183', calleeName: 'A_Q_Manual_Mobility', ans: 'Answered' }),
    leg({ id: 'B', leg: 2, start: '8:47:01', conn: '8:47:01', stop: '8:56:20', dir: 'Internal', talk: '0:09:18', caller: '304',
          callee: '250', calleeName: 'Nicolas (Nitin) Ghonasgi', ans: 'Answered' }),
    leg({ id: 'B', leg: 4, start: '8:52:07', conn: '8:52:07', stop: '8:58:25', dir: 'Outgoing', talk: '0:06:17', caller: '250',
          callerName: 'Nicolas (Nitin) Ghonasgi', callee: CUST, to: 'C', ans: 'Answered' }),
    leg({ id: 'B', leg: 7, start: '8:56:27', conn: '8:56:27', stop: '8:58:25', dir: 'Incoming', talk: '0:01:57', caller: CUST,
          callee: '215', calleeName: 'Percy (Praveen) Shukla', to: 'C', ans: 'Answered' }),
    leg({ id: 'C', leg: 1, start: '8:57:11', conn: '8:57:11', stop: '8:57:16', dir: 'Internal', caller: '215', callerName: 'Percy (Praveen) Shukla',
          callee: '103', calleeName: 'A_Q_CSR', ans: 'Answered' }),
    leg({ id: 'C1', leg: 1, start: '8:57:11', conn: '8:57:14', stop: '8:57:15', dir: 'Internal', caller: 'CallQueue (103)',
          callee: '297', calleeName: 'Julienne Inaanuran', parent: 'C', to: 'C', ans: 'Answered' }),
    leg({ id: 'C', leg: 2, start: '8:57:16', conn: '8:57:16', stop: '9:00:16', dir: 'Internal', talk: '0:02:59', caller: '215',
          callee: '297', calleeName: 'Julienne Inaanuran', ans: 'Answered' }),
    leg({ id: 'C', leg: 4, start: '8:58:26', conn: '8:58:26', stop: '9:00:16', dir: 'Outgoing', talk: '0:01:50', caller: '297',
          callerName: 'Julienne Inaanuran', callee: CUST, ans: 'Answered' }),
  ];
}

test('the capture counts the hand-over as an outbound call today (the bug being measured)', function () {
  const recs = J(h.call('buildOutboundCallRecords_', ownerExample()));
  assert.deepEqual(recs.map((r) => r.callId + ':' + r.agentName), ['C:Julienne Inaanuran'],
    'B has Incoming legs, so only C slips through -- as Julienne dialing the customer');
});

test('both signals tie the owner\'s example back to the call it came from', function () {
  const rows = J(h.call('ocTransferHandoffs_', ownerExample()));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].transferFrom, 'B', '(A) B names C in Transfer To Call ID');
  assert.equal(rows[0].handoverFrom, 'B', '(B) the customer was on B until 1 s before');
  assert.equal(rows[0].inboundChain, true, 'and the chain started as the customer\'s inbound call');
});

test('a queue leg naming its own call (Parent + Transfer To = its root) is not a transfer', function () {
  const rows = ownerExample().filter((r) => r[0] !== 'B');   // drop the real source
  const out = J(h.call('ocTransferHandoffs_', rows));
  assert.equal(out[0].transferFrom, null, 'C1 -> C is the call\'s own queue leg');
});

test('a genuine callback -- after the customer\'s call ended, no transfer link -- is neither', function () {
  const rows = [
    leg({ id: 'X', leg: 1, start: '9:00:00', conn: '9:00:00', stop: '9:05:00', dir: 'Incoming', talk: '0:05:00', caller: CUST,
          callee: '304', ans: 'Answered' }),
    leg({ id: 'Y', leg: 1, start: '9:20:00', conn: '9:20:10', stop: '9:22:00', dir: 'Outgoing', talk: '0:01:50', caller: '304',
          callerName: 'Camila (Cheshta) Bhutani', callee: CUST, ans: 'Answered' }),
  ];
  const out = J(h.call('ocTransferHandoffs_', rows));
  assert.equal(out.length, 1);
  assert.equal(out[0].callId, 'Y');
  assert.equal(out[0].transferFrom, null);
  assert.equal(out[0].handoverFrom, null);
});

test('an OUTBOUND call handed to a colleague: the original stays, the hand-over is flagged (outbound chain)', function () {
  const rows = [
    leg({ id: 'P', leg: 1, start: '10:00:00', conn: '10:00:05', stop: '10:04:00', dir: 'Outgoing', talk: '0:03:55', caller: '304',
          callerName: 'Camila (Cheshta) Bhutani', callee: CUST, to: 'Q', ans: 'Answered' }),
    leg({ id: 'Q', leg: 1, start: '10:03:00', conn: '10:03:00', stop: '10:04:00', dir: 'Internal', talk: '0:01:00', caller: '304',
          callee: '250', ans: 'Answered' }),
    leg({ id: 'Q', leg: 2, start: '10:04:01', conn: '10:04:01', stop: '10:09:00', dir: 'Outgoing', talk: '0:04:59', caller: '250',
          callerName: 'Nicolas (Nitin) Ghonasgi', callee: CUST, ans: 'Answered' }),
  ];
  const out = J(h.call('ocTransferHandoffs_', rows));
  const by = {}; out.forEach((r) => { by[r.callId] = r; });
  assert.equal(by.P.transferFrom, null);
  assert.equal(by.Q.transferFrom, 'P');
  assert.equal(by.Q.handoverFrom, 'P');
  assert.equal(by.Q.inboundChain, false);
  const s = J(h.call('ocSummarizeHandoffs_', out));
  assert.equal(s.outbound, 2);
  assert.equal(s.both, 1);
  assert.equal(s.outboundChain, 1);
  assert.equal(s.agents['Nicolas (Nitin) Ghonasgi'], 1);
  assert.ok(!JSON.stringify(s).includes(CUST), 'no phone number in the summary');
});

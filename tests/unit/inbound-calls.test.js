'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// buildInboundCallRecords_ is pure (no Apps Script globals), so we load just
// the one cdr-import file. The scenarios below are the real Raw Data shapes
// from the sample calls (caller names/numbers swapped to equivalents).
const h = loadGas({ project: 'cdr-import', files: ['inboundCalls.js'] });

// Build a 44-wide Raw Data leg row from named fields (indices per IC_COL).
function leg(o) {
  const r = new Array(44).fill('');
  r[0] = o.callId; r[1] = o.legId; r[2] = o.start; r[3] = o.connected || ''; r[4] = o.stop || '';
  r[5] = o.direction; r[6] = o.talk || '0:00:00'; r[7] = o.callTime || '0:00:00';
  r[8] = o.caller; r[9] = o.callerName || ''; r[10] = o.callee; r[11] = o.calleeName || '';
  r[14] = o.parent || 'N/A'; r[16] = o.dialIn || 'N/A';
  r[23] = o.missed || '-'; r[24] = o.abandoned || '-'; r[25] = o.answered || '-';
  r[32] = o.holdDur || '0:00:00'; r[33] = o.calleeDisc || 'N/A'; r[34] = o.callerDisc || 'N/A';
  r[36] = o.dept || 'N/A';
  return r;
}
function build(rows) { return h.call('buildInboundCallRecords_', rows); }
function rec(records, callId) { return records.filter(r => r.callId === String(callId))[0]; }

test('abandoned in queue (THOMAS -> A_Q_Intake)', function () {
  const recs = build([
    leg({ callId: '668970', legId: 1, start: '06/04/2026 10:36:07', stop: '06/04/2026 10:36:25', direction: 'Incoming', caller: '12159998888', callerName: 'THOMAS', callee: '999', calleeName: 'Introduction - New', dialIn: '19722281820' }),
    leg({ callId: '668970', legId: 2, start: '06/04/2026 10:36:25', stop: '06/04/2026 10:37:06', direction: 'Incoming', caller: '12159998888', callee: '9999', calleeName: 'Normal Call Menu - New', dialIn: '19722281820' }),
    leg({ callId: '668970', legId: 3, start: '06/04/2026 10:37:06', stop: '06/04/2026 10:38:24', direction: 'Incoming', caller: '12159998888', callee: '108', calleeName: 'A_Q_Intake', dialIn: '19722281820', missed: 'Missed', abandoned: 'Abandoned' }),
  ]);
  assert.equal(recs.length, 1);
  const r = rec(recs, '668970');
  assert.equal(r.callerNumber, '+12159998888');
  assert.equal(r.disposition, 'abandoned');
  assert.equal(r.abandonStage, 'queue');
  assert.equal(r.entryQueue, 'A_Q_Intake');
  assert.equal(r.numQueues, 1);
  assert.equal(r.numTransfers, 0);
  assert.equal(r.dialIn, '19722281820');
  assert.equal(r.abandonedOnHold, false);
  assert.equal(r.callDate, '2026-06-04');
});

test('abandoned in IVR menu (EMILY) -> abandon_stage=ivr, no queue', function () {
  const recs = build([
    leg({ callId: '645993', legId: 1, start: '06/04/2026 05:41:26', stop: '06/04/2026 05:41:43', direction: 'Incoming', caller: '14047772222', callee: '999', calleeName: 'Introduction - New', dialIn: '19722281820' }),
    leg({ callId: '645993', legId: 2, start: '06/04/2026 05:41:43', stop: '06/04/2026 05:42:27', direction: 'Incoming', caller: '14047772222', callee: '9999', calleeName: 'Normal Call Menu - New', dialIn: '19722281820', missed: 'Missed', abandoned: 'Abandoned' }),
  ]);
  const r = rec(recs, '645993');
  assert.equal(r.callerNumber, '+14047772222');
  assert.equal(r.disposition, 'abandoned');
  assert.equal(r.abandonStage, 'ivr');
  assert.equal(r.entryQueue, null);
  assert.equal(r.numQueues, 0);
});

test('answered THEN abandoned-on-hold (19482229999, held 6:33)', function () {
  const recs = build([
    leg({ callId: '689774', legId: 1, start: '06/04/2026 14:22:00', stop: '06/04/2026 14:22:16', direction: 'Incoming', caller: '19482229999', callee: '999', calleeName: 'Introduction - New', dialIn: '18668646332' }),
    leg({ callId: '689774', legId: 2, start: '06/04/2026 14:22:16', stop: '06/04/2026 14:22:49', direction: 'Incoming', caller: '19482229999', callee: '9999', calleeName: 'Normal Call Menu - New', dialIn: '18668646332' }),
    leg({ callId: '689774', legId: 3, start: '06/04/2026 14:22:49', stop: '06/04/2026 14:23:06', direction: 'Incoming', caller: '19482229999', callee: '103', calleeName: 'A_Q_CSR', dialIn: '18668646332' }),
    leg({ callId: '689774', legId: 4, start: '06/04/2026 14:23:06', connected: '06/04/2026 14:23:06', stop: '06/04/2026 14:31:35', direction: 'Incoming', talk: '0:08:28', caller: '19482229999', callee: '352', calleeName: 'Daniel (Dishant) Sahani', answered: 'Answered', holdDur: '0:06:33', callerDisc: 'TRUE', dialIn: '18668646332', dept: 'Customer Success' }),
    // CallForking satellite (Parent links back) -- must NOT create a 2nd record.
    leg({ callId: '689878', legId: 2, parent: '689774', start: '06/04/2026 14:23:04', direction: 'Internal', caller: 'CallQueue (103)', callee: '352', calleeName: 'Daniel (Dishant) Sahani', answered: 'Answered' }),
  ]);
  assert.equal(recs.length, 1, 'forking satellite folds into the one root call');
  const r = rec(recs, '689774');
  assert.equal(r.callerNumber, '+19482229999');
  assert.equal(r.disposition, 'answered');
  assert.equal(r.abandonedOnHold, true);     // answered AND dropped on hold
  assert.equal(r.holdSeconds, 393);          // 6:33
  assert.equal(r.entryQueue, 'A_Q_CSR');
  assert.equal(r.numQueues, 1);
  assert.equal(r.finalDept, 'Customer Success');
  assert.equal(r.waitSeconds, 66);           // 14:22:00 -> 14:23:06
});

test('multi-queue bounce / transfer (Ida): num_queues=3, num_transfers=2', function () {
  const recs = build([
    leg({ callId: '672942', legId: 1, start: '06/04/2026 11:18:57', stop: '06/04/2026 11:19:14', direction: 'Incoming', caller: '12107773333', callee: '999', calleeName: 'Introduction - New', dialIn: '18668646332' }),
    leg({ callId: '672942', legId: 3, start: '06/04/2026 11:20:01', stop: '06/04/2026 11:20:07', direction: 'Incoming', caller: '12107773333', callee: '114', calleeName: 'A_Q_Resupply', dialIn: '18668646332' }),
    leg({ callId: '672942', legId: 6, start: '06/04/2026 11:20:45', stop: '06/04/2026 11:21:15', direction: 'Incoming', caller: '12107773333', callee: '183', calleeName: 'A_Q_Manual_Mobility', dialIn: '18668646332' }),
    leg({ callId: '672942', legId: 9, start: '06/04/2026 11:26:50', stop: '06/04/2026 11:27:02', direction: 'Incoming', caller: '12107773333', callee: '167', calleeName: 'A_Q_PowerChairs', dialIn: '18668646332' }),
    leg({ callId: '672942', legId: 10, start: '06/04/2026 11:27:02', connected: '06/04/2026 11:27:02', stop: '06/04/2026 11:30:23', direction: 'Incoming', talk: '0:03:21', caller: '12107773333', callee: '140', calleeName: 'Sally (Sanahanbi) Devi', answered: 'Answered', dialIn: '18668646332', dept: 'Patient Intake - Power Mobility' }),
  ]);
  const r = rec(recs, '672942');
  assert.equal(r.disposition, 'answered');
  assert.equal(r.numQueues, 3);
  assert.equal(r.numTransfers, 2);
  assert.equal(r.entryQueue, 'A_Q_Resupply');
  assert.equal(r.finalQueue, 'A_Q_PowerChairs');
  assert.equal(r.callerNumber, '+12107773333');
});

test('re-ring same agent N times = ONE abandoned record (Rita)', function () {
  const fork = (cid) => leg({ callId: cid, legId: 1, parent: '658622', start: '06/04/2026 08:53:29', direction: 'Internal', caller: '103', callerName: 'Rita Grant', callee: '352', calleeName: 'Daniel (Dishant) Sahani', missed: 'Missed' });
  const recs = build([
    leg({ callId: '658622', legId: 1, start: '06/04/2026 08:52:40', stop: '06/04/2026 08:52:57', direction: 'Incoming', caller: '12148886666', callee: '999', calleeName: 'Introduction - New', dialIn: '19722281820' }),
    leg({ callId: '658622', legId: 2, start: '06/04/2026 08:52:57', stop: '06/04/2026 08:53:29', direction: 'Incoming', caller: '12148886666', callee: '9999', calleeName: 'Normal Call Menu - New', dialIn: '19722281820' }),
    leg({ callId: '658622', legId: 3, start: '06/04/2026 08:53:29', stop: '06/04/2026 08:55:09', direction: 'Incoming', caller: '12148886666', callee: '103', calleeName: 'A_Q_CSR', dialIn: '19722281820', missed: 'Missed', abandoned: 'Abandoned' }),
    fork('658733'), fork('658776'), fork('658794'), fork('658824'),
  ]);
  assert.equal(recs.length, 1);
  const r = rec(recs, '658622');
  assert.equal(r.disposition, 'abandoned');
  assert.equal(r.abandonStage, 'queue');
  assert.equal(r.callerNumber, '+12148886666');
  assert.equal(r.numQueues, 1);
});

test('outbound call produces NO inbound record', function () {
  const recs = build([
    leg({ callId: '694041', legId: 1, start: '06/04/2026 15:09:14', connected: '06/04/2026 15:09:14', stop: '06/04/2026 15:09:24', direction: 'Outgoing', talk: '0:00:09', caller: '338', callerName: 'Priscila (Priti) Singh', callee: '+18006240756', answered: 'Answered', callerDisc: 'TRUE' }),
    leg({ callId: '694041', legId: 2, start: '06/04/2026 15:09:14', direction: 'Internal', caller: '338', callee: 'CallRecording' }),
  ]);
  assert.equal(recs.length, 0);
});

test('anonymous inbound caller -> recorded with null caller number', function () {
  const recs = build([
    leg({ callId: '700001', legId: 1, start: '06/04/2026 09:00:00', stop: '06/04/2026 09:00:30', direction: 'Incoming', caller: 'Anonymous', callee: '103', calleeName: 'A_Q_CSR', dialIn: '18668646332', missed: 'Missed', abandoned: 'Abandoned' }),
  ]);
  assert.equal(recs.length, 1);
  const r = rec(recs, '700001');
  assert.equal(r.callerNumber, null);
  assert.equal(r.disposition, 'abandoned');
});

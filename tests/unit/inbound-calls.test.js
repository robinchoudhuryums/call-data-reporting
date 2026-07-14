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

test('abandoned IN QUEUE while held: abandonedOnHold is independent of answered', function () {
  // Caller was parked (hold duration on the queue leg) and hung up
  // while held WITHOUT ever being answered -- disposition stays
  // 'abandoned' but the on-hold flag + hold seconds must still be
  // captured (the icIsTrue_ check at the abandoned-on-hold site is
  // deliberately independent of `answered`).
  const recs = build([
    leg({ callId: '770001', legId: 1, start: '06/04/2026 11:00:00', stop: '06/04/2026 11:00:20', direction: 'Incoming', caller: '12145550000', callee: '999', calleeName: 'Introduction - New', dialIn: '19722281820' }),
    leg({ callId: '770001', legId: 2, start: '06/04/2026 11:00:20', stop: '06/04/2026 11:03:45', direction: 'Incoming', caller: '12145550000', callee: '103', calleeName: 'A_Q_CSR', dialIn: '19722281820', missed: 'Missed', abandoned: 'Abandoned', holdDur: '0:02:10', callerDisc: 'TRUE' }),
  ]);
  assert.equal(recs.length, 1);
  const r = rec(recs, '770001');
  assert.equal(r.disposition, 'abandoned');
  assert.equal(r.abandonStage, 'queue');
  assert.equal(r.abandonedOnHold, true);
  assert.equal(r.holdSeconds, 130);
  assert.equal(r.entryQueue, 'A_Q_CSR');
});

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

test('inline SQL escapers neutralize quotes + coerce ints/hash', function () {
  // Free-text fields (e.g. final_dept) are single-quote escaped; ints/hash
  // are validated -- so the inline insert is injection-safe.
  assert.equal(h.call('icSqlStr_', "Intake - O'Brien (Complex)"), "'Intake - O''Brien (Complex)'");
  assert.equal(h.call('icSqlStr_', null), 'NULL');
  assert.equal(h.call('icSqlStr_', ''), 'NULL');
  assert.equal(h.call('icSqlStr_', "x'); DROP TABLE inbound_calls;--"), "'x''); DROP TABLE inbound_calls;--'");
  assert.equal(h.call('icSqlInt_', 393), '393');
  assert.equal(h.call('icSqlInt_', null), 'NULL');
  assert.equal(h.call('icSqlInt_', 'notnum'), 'NULL');
  assert.equal(h.call('icSqlHash_', 'a'.repeat(64)), "'" + 'a'.repeat(64) + "'");
  assert.equal(h.call('icSqlHash_', "x'; --"), 'NULL');   // non-hex -> NULL, never inlined
  assert.equal(h.call('icSqlHash_', null), 'NULL');
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

// -- Journey extension (call_start + leg-by-leg path) -------------------------

test('journey: callStart + ordered events with kinds, durations, and flags', function () {
  const recs = build([
    leg({ callId: '810001', legId: 1, start: '06/04/2026 10:36:07', stop: '06/04/2026 10:36:25', direction: 'Incoming', caller: '12159998888', callee: '999', calleeName: 'Introduction - New', dialIn: '19722281820' }),
    leg({ callId: '810001', legId: 2, start: '06/04/2026 10:36:25', stop: '06/04/2026 10:38:20', direction: 'Incoming', caller: '12159998888', callee: '108', calleeName: 'A_Q_Intake', dialIn: '19722281820' }),
    leg({ callId: '810001', legId: 3, start: '06/04/2026 10:37:02', stop: '06/04/2026 10:37:14', direction: 'Incoming', caller: '12159998888', callee: '201', calleeName: 'Anna Smith', dialIn: '19722281820', missed: 'Missed', parent: '810001' }),
    leg({ callId: '810001', legId: 4, start: '06/04/2026 10:38:20', connected: '06/04/2026 10:38:24', stop: '06/04/2026 10:42:36', direction: 'Incoming', caller: '12159998888', callee: '202', calleeName: 'Ben Lee', dialIn: '19722281820', talk: '0:04:12', answered: 'Answered', holdDur: '0:02:10', dept: 'Intake' }),
  ]);
  assert.equal(recs.length, 1);
  const r = rec(recs, '810001');
  assert.equal(r.callStart, '10:36:07');
  assert.equal(r.journey.length, 4);
  // Ordered by leg start; kinds classify queue vs answered vs other legs.
  // (joined-string compare: vm-realm arrays fail deepStrictEqual on prototype)
  assert.equal(r.journey.map(e => e.kind).join(','), 'leg,queue,leg,answer');
  assert.equal(r.journey[1].name, 'A_Q_Intake');
  assert.equal(r.journey[1].secs, 115);
  assert.equal(r.journey[2].name, 'Anna Smith');
  assert.equal(r.journey[2].missed, true);
  assert.equal(r.journey[3].name, 'Ben Lee');
  assert.equal(r.journey[3].talk, 252);
  assert.equal(r.journey[3].hold, 130);
  assert.equal(r.journey[3].t, '10:38:20');
});

test('journey: phone-looking callee names are masked (no raw numbers in Neon)', function () {
  const recs = build([
    leg({ callId: '810002', legId: 1, start: '06/04/2026 11:00:00', stop: '06/04/2026 11:00:20', direction: 'Incoming', caller: '12145550000', callee: '103', calleeName: 'A_Q_CSR', dialIn: '19722281820' }),
    leg({ callId: '810002', legId: 2, start: '06/04/2026 11:00:20', stop: '06/04/2026 11:01:00', direction: 'Outgoing', caller: '103', callee: '+18005551234', calleeName: '+1 (800) 555-1234', missed: 'Missed', abandoned: 'Abandoned' }),
  ]);
  const r = rec(recs, '810002');
  assert.equal(r.journey[1].name, '(external number)');
  assert.equal(r.journey[1].abandoned, true);
});

test('journey: event count is capped', function () {
  const legs = [];
  for (let i = 0; i < 60; i++) {
    legs.push(leg({ callId: '810003', legId: i + 1,
      start: '06/04/2026 09:00:' + String(i).padStart(2, '0'),
      stop: '06/04/2026 09:01:00', direction: 'Incoming',
      caller: '12145550000', callee: '103', calleeName: 'A_Q_CSR', dialIn: '19722281820' }));
  }
  const r = rec(build(legs), '810003');
  assert.equal(r.journey.length, 40);   // IC_JOURNEY_MAX_EVENTS
});

test('size-aware SQL chunking: batches respect the char budget; oversize tuple stands alone', function () {
  const chunk = (tuples, budget) => h.call('icChunkTuplesByChars_', tuples, budget);

  // Mixed sizes: budget forces a flush before the big tuple.
  const small = '(' + 'a'.repeat(8) + ')';     // 10 chars
  const big   = '(' + 'b'.repeat(58) + ')';    // 60 chars
  const batches = chunk([small, small, big, small], 30);
  assert.equal(batches.length, 3);
  assert.equal(batches[0].length, 2, 'two smalls fit in one 30-char batch');
  assert.equal(batches[1].length, 1, 'oversize tuple gets its own batch');
  assert.equal(batches[1][0], big);
  assert.equal(batches[2].length, 1, 'trailing small flushes as the final batch');

  // Every batch's joined length stays within budget (except a lone
  // oversize tuple, which cannot be split).
  const uniform = Array.from({ length: 25 }, () => small);
  chunk(uniform, 35).forEach(function (b) {
    assert.ok(b.join(',').length <= 35);
  });

  // Order is preserved across batches.
  const tagged = Array.from({ length: 9 }, (_, i) => '(' + i + ')');
  const flat = [];
  chunk(tagged, 12).forEach(function (b) { b.forEach(function (t) { flat.push(t); }); });
  assert.equal(flat.join(''), tagged.join(''));

  assert.equal(chunk([], 100).length, 0, 'no tuples -> no batches');
});

test('IMP-1: "Backup CSR" is recognized as a queue (abandon stage, entry queue, journey kind)', function () {
  // Backup CSR is a first-class live queue (the DQE pipeline's queue regex
  // is (A_Q_\w+|Backup CSR)). Pre-fix, a call whose only queue leg was
  // Backup CSR was captured as abandon_stage='ivr' with entry_queue=NULL --
  // it fell into the unattributable IVR bucket and disappeared from CSR's
  // per-dept Inbound report/heatmap, permanently (Call_Legs prune ~14d).
  const recs = build([
    leg({ callId: '900001', legId: 1, start: '06/04/2026 09:10:00', stop: '06/04/2026 09:10:15', direction: 'Incoming', caller: '12145551111', callee: '999', calleeName: 'Introduction - New', dialIn: '19722281820' }),
    leg({ callId: '900001', legId: 2, start: '06/04/2026 09:10:15', stop: '06/04/2026 09:11:45', direction: 'Incoming', caller: '12145551111', callee: '110', calleeName: 'Backup CSR', dialIn: '19722281820', missed: 'Missed', abandoned: 'Abandoned' }),
  ]);
  assert.equal(recs.length, 1);
  const r = rec(recs, '900001');
  assert.equal(r.disposition, 'abandoned');
  assert.equal(r.abandonStage, 'queue', 'Backup CSR abandon is a QUEUE abandon, not IVR');
  assert.equal(r.entryQueue, 'Backup CSR');
  assert.equal(r.finalQueue, 'Backup CSR');
  const queueEvents = r.journey.filter(function (ev) { return ev.kind === 'queue'; });
  assert.equal(queueEvents.length, 1, 'the Backup CSR leg renders as a queue journey event');
  assert.equal(queueEvents[0].name, 'Backup CSR');
  // Case-insensitive like the A_Q_ arm; and non-queue names still are not queues.
  assert.equal(h.call('icIsQueueName_', 'BACKUP CSR'), true);
  assert.equal(h.call('icIsQueueName_', 'Backup CSR Team'), false, 'prefix-only lookalikes are NOT queues');
  assert.equal(h.call('icIsQueueName_', 'Jane Backup CSR'), false);
});

// ---- L2: authoritative per-date replace (writeInboundCallsToNeon opts) --------
// A fake JDBC conn records every executed statement so we can assert the
// authoritative write DELETEs the payload's dates (same txn, before the upsert)
// and a plain write does not. Stubs getReachableNeonConn_ (neonWrite.js, not
// loaded); no HMAC_SECRET so the caller_hash path stays off (cdrHashPhone_ is
// never reached).
function fakeInboundConn(cap) {
  cap.executed = []; cap.commits = 0; cap.rollbacks = 0;
  function stmt() { return { execute: function (sql) { cap.executed.push(sql); return true; }, close: function () {} }; }
  return {
    setAutoCommit: function () {},
    createStatement: stmt,
    commit: function () { cap.commits++; },
    rollback: function () { cap.rollbacks++; },
    close: function () {},
  };
}
const L2_ROWS = [
  leg({ callId: '668970', legId: 1, start: '06/04/2026 10:36:07', stop: '06/04/2026 10:36:25', direction: 'Incoming', caller: '12159998888', callee: '999', calleeName: 'Introduction - New', dialIn: '19722281820' }),
  leg({ callId: '668970', legId: 3, start: '06/04/2026 10:37:06', stop: '06/04/2026 10:38:24', direction: 'Incoming', caller: '12159998888', callee: '108', calleeName: 'A_Q_Intake', dialIn: '19722281820', missed: 'Missed', abandoned: 'Abandoned' }),
];

test('L2: authoritative write DELETEs the payload dates before the upsert (same txn)', function () {
  const cap = {};
  h.ctx.getReachableNeonConn_ = function () { return fakeInboundConn(cap); };
  h.call('writeInboundCallsToNeon', L2_ROWS, { authoritative: true });
  const dels = cap.executed.filter(s => /DELETE FROM inbound_calls/.test(s));
  assert.equal(dels.length, 1, 'exactly one DELETE fired');
  assert.match(dels[0], /call_date IN \('2026-06-04'::date\)/, 'DELETE scoped to the payload date');
  const delIdx = cap.executed.findIndex(s => /DELETE FROM inbound_calls/.test(s));
  const insIdx = cap.executed.findIndex(s => /INSERT INTO inbound_calls/.test(s));
  assert.ok(delIdx >= 0 && insIdx > delIdx, 'DELETE precedes the INSERT');
  assert.equal(cap.commits, 1, 'one commit (delete + insert are atomic)');
});

test('L2: non-authoritative write is upsert-only (no DELETE)', function () {
  const cap = {};
  h.ctx.getReachableNeonConn_ = function () { return fakeInboundConn(cap); };
  h.call('writeInboundCallsToNeon', L2_ROWS);   // no opts -> upsert-only
  assert.equal(cap.executed.filter(s => /DELETE FROM inbound_calls/.test(s)).length, 0,
    'a partial-set caller (no authoritative) never deletes');
  assert.ok(cap.executed.some(s => /INSERT INTO inbound_calls/.test(s)), 'still upserts');
});

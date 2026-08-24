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

// ---- R5: ivr/direct stage split + first_agent capture --------------------------

test('R5: abandoned DIRECT call (rang a person, no queue) -> abandon_stage=direct, firstAgent set', function () {
  // Caller dialed an agent's DID; the ring leg carries the agent's name +
  // a real Departments value (the discriminator -- IVR/menu legs have
  // dept N/A). Pre-fix this landed in the 'ivr' bucket, inflating the
  // Inbound report's "Abandoned in IVR" tile to ~25% of calls.
  const recs = build([
    leg({ callId: '910001', legId: 1, start: '06/04/2026 11:20:00', stop: '06/04/2026 11:20:40', direction: 'Incoming', caller: '12145552222', callee: '352', calleeName: 'Daniel (Dishant) Sahani', dialIn: '19725550123', missed: 'Missed', abandoned: 'Abandoned', dept: 'Customer Success' }),
  ]);
  const r = rec(recs, '910001');
  assert.equal(r.disposition, 'abandoned');
  assert.equal(r.abandonStage, 'direct', 'person-leg abandon is DIRECT, not IVR');
  assert.equal(r.entryQueue, null);
  assert.equal(r.firstAgent, 'Daniel (Dishant) Sahani');
});

test('R5: true IVR abandon stays ivr; firstAgent null when no person leg rang', function () {
  const recs = build([
    leg({ callId: '910002', legId: 1, start: '06/04/2026 05:41:26', stop: '06/04/2026 05:41:43', direction: 'Incoming', caller: '14047773333', callee: '999', calleeName: 'Introduction - New', dialIn: '19722281820' }),
    leg({ callId: '910002', legId: 2, start: '06/04/2026 05:41:43', stop: '06/04/2026 05:42:27', direction: 'Incoming', caller: '14047773333', callee: '9999', calleeName: 'Normal Call Menu - New', dialIn: '19722281820', missed: 'Missed', abandoned: 'Abandoned' }),
  ]);
  const r = rec(recs, '910002');
  assert.equal(r.abandonStage, 'ivr', 'menu legs carry no dept -> still IVR');
  assert.equal(r.firstAgent, null);
});

test('R5: firstAgent = FIRST person leg (queues/menus skipped; phone-shaped callees never stored)', function () {
  const recs = build([
    leg({ callId: '910003', legId: 1, start: '06/04/2026 10:00:00', stop: '06/04/2026 10:00:10', direction: 'Incoming', caller: '12145554444', callee: '999', calleeName: 'Introduction - New', dialIn: '19722281820' }),
    leg({ callId: '910003', legId: 2, start: '06/04/2026 10:00:10', stop: '06/04/2026 10:00:50', direction: 'Incoming', caller: '12145554444', callee: '103', calleeName: 'A_Q_CSR', dialIn: '19722281820' }),
    leg({ callId: '910003', legId: 3, start: '06/04/2026 10:00:50', stop: '06/04/2026 10:01:10', direction: 'Incoming', caller: '12145554444', callee: '241', calleeName: '+1 (312) 555-0100', dialIn: '19722281820', dept: 'CSR' }),
    leg({ callId: '910003', legId: 4, start: '06/04/2026 10:01:10', connected: '06/04/2026 10:01:10', stop: '06/04/2026 10:05:00', direction: 'Incoming', talk: '0:03:50', caller: '12145554444', callee: '352', calleeName: 'Anna Smith', answered: 'Answered', dialIn: '19722281820', dept: 'CSR' }),
  ]);
  const r = rec(recs, '910003');
  assert.equal(r.firstAgent, 'Anna Smith',
    'IVR (no dept), queue, and phone-shaped legs are all skipped');
});

// ---- Internal-transfer path enrichment (journey-only, unique-match-only) ------
// An agent answers an inbound call and transfers the caller to a queue; the
// caller abandons in that queue. The transfer-abandon is a SEPARATE
// internal-only leg group the record builder drops, so the caller's captured
// inbound journey used to just end at the transfer. The enrichment cross-refs
// the abandon to the answering agent's concurrent inbound call and, ONLY on a
// unique match, appends one synthetic transfer-abandon event to that journey.
// Metric fields (disposition/counts/queues) are NEVER touched.

// A captured inbound answered by ext 215 (RAYMOND MATHEWS), 10:00:05 -> 10:05:00.
function capturedInboundAnsweredBy215(callId) {
  return [
    leg({ callId: callId, legId: 1, start: '06/04/2026 09:59:50', stop: '06/04/2026 10:00:05', direction: 'Incoming', caller: '12145559999', callee: '103', calleeName: 'A_Q_CSR', dialIn: '19722281820' }),
    leg({ callId: callId, legId: 2, start: '06/04/2026 10:00:05', connected: '06/04/2026 10:00:05', stop: '06/04/2026 10:05:00', direction: 'Incoming', talk: '0:04:55', caller: '12145559999', callee: '215', calleeName: 'Raymond (Ray) Mathews', answered: 'Answered', dialIn: '19722281820', dept: 'CSR' }),
  ];
}
// The internal-only transfer group: ext 215 transfers to A_Q_Spanish @ 10:03:00,
// caller abandons after a 40s wait. No Incoming leg -> not its own record.
function transferAbandonBy215(callId, startTime) {
  return leg({ callId: callId, legId: 1, start: startTime, stop: '06/04/2026 10:03:40', direction: 'Internal', talk: '0:00:00', callTime: '0:00:40', caller: '215', callee: '260', calleeName: 'A_Q_Spanish', abandoned: 'Abandoned', missed: 'Missed' });
}

test('transfer-path: unique concurrent inbound -> synthetic abandon appended to that journey', function () {
  const recs = build(capturedInboundAnsweredBy215('820001').concat([
    transferAbandonBy215('820900', '06/04/2026 10:03:00'),
  ]));
  // Round-17: the internal group is ALSO written as its own record (it is the
  // receiving dept's abandon, and their Missed report's path button keys on
  // it). The caller's enrichment below is unchanged.
  assert.equal(recs.length, 2);
  const r = rec(recs, '820001');
  assert.ok(r, 'the captured inbound record exists');
  // Metric fields are untouched -- the caller was still ANSWERED; queues from
  // the call's OWN legs only.
  assert.equal(r.disposition, 'answered');
  assert.equal(r.entryQueue, 'A_Q_CSR');
  assert.equal(r.finalQueue, 'A_Q_CSR');
  assert.equal(r.numQueues, 1);
  assert.equal(r.numTransfers, 0);
  // The journey gains ONE synthetic transfer-abandon event at the end.
  assert.equal(r.journey.length, 3);
  const t = r.journey[r.journey.length - 1];
  assert.equal(t.kind, 'queue');
  assert.equal(t.name, 'A_Q_Spanish');
  assert.equal(t.abandoned, true);
  assert.equal(t.transfer, true, 'flagged as a cross-referenced enrichment');
  assert.equal(t.t, '10:03:00');
  assert.equal(t.secs, 40);
});

test('transfer-path (Round-17): the matched internal group is written, linked, and origin-prefixed', function () {
  const recs = build(capturedInboundAnsweredBy215('820001').concat([
    transferAbandonBy215('820900', '06/04/2026 10:03:00'),
  ]));
  const ir = rec(recs, '820900');
  assert.ok(ir, 'the receiving dept needs a record to hang its "path" drill on');
  assert.equal(ir.isInternal, true, 'journey-only: every metric query excludes is_internal');
  assert.equal(ir.relatedCallId, '820001', 'links back to the caller\'s call');
  // Its OWN metric fields describe the internal leg, untouched by the prefix.
  assert.equal(ir.entryQueue, 'A_Q_Spanish');
  assert.equal(ir.disposition, 'abandoned');

  // The journey reads as ONE story: origin queue -> answering agent -> the
  // abandon in the receiving queue.
  const kinds = ir.journey.map(function (e) { return e.kind + ':' + e.name; });
  assert.deepEqual(JSON.parse(JSON.stringify(kinds)),
    ['queue:A_Q_CSR', 'answer:Raymond (Ray) Mathews', 'queue:A_Q_Spanish']);
  // The two reconstructed events are flagged as cross-referenced, the call's
  // own leg is not -- provenance stays legible.
  assert.equal(ir.journey[0].origin, true);
  assert.equal(ir.journey[0].transfer, true);
  assert.equal(ir.journey[1].origin, true);
  assert.equal(ir.journey[1].talk, 295, 'the agent\'s real talk seconds (10:00:05 -> 10:05:00)');
  assert.ok(!ir.journey[2].origin, 'the abandon is this call\'s own leg, not reconstructed');
  assert.equal(ir.journey[2].abandoned, true);
});

test('transfer-path (Round-17): an AMBIGUOUS group is still written, but WITHOUT a fabricated origin', function () {
  const recs = build(
    capturedInboundAnsweredBy215('820010').concat(
    capturedInboundAnsweredBy215('820011')).concat([
      transferAbandonBy215('820910', '06/04/2026 10:03:00'),
  ]));
  const ir = rec(recs, '820910');
  assert.ok(ir, 'still captured -- the receiving dept sees the abandon either way');
  // Unset is written as SQL NULL (icSqlStr_ treats null/undefined alike).
  assert.ok(ir.relatedCallId == null, 'never guesses which of two concurrent calls owns it');
  assert.deepEqual(JSON.parse(JSON.stringify(ir.journey.map(function (e) { return e.name; }))),
    ['A_Q_Spanish'], 'no origin hop invented when the match is not unique');
});

test('transfer-path: AMBIGUOUS (agent on two concurrent inbound calls) -> no enrichment', function () {
  const recs = build(
    capturedInboundAnsweredBy215('820002').concat(
    capturedInboundAnsweredBy215('820003')).concat([
      transferAbandonBy215('820901', '06/04/2026 10:03:00'),
  ]));
  // Both captured calls stay 2-event journeys; neither gets the abandon.
  assert.equal(rec(recs, '820002').journey.length, 2);
  assert.equal(rec(recs, '820003').journey.length, 2);
  assert.ok(recs.every(r => r.journey.every(e => !e.transfer)),
    'never guesses which of two concurrent calls owns the transfer');
});

test('transfer-path: no concurrent inbound for the ext -> left as-is (no path reconstructed)', function () {
  const recs = build(capturedInboundAnsweredBy215('820004').concat([
    // ext 999 transfers/abandons, but no captured inbound was answered by 999.
    leg({ callId: '820902', legId: 1, start: '06/04/2026 10:03:00', stop: '06/04/2026 10:03:30', direction: 'Internal', caller: '999', callee: '260', calleeName: 'A_Q_Spanish', abandoned: 'Abandoned', missed: 'Missed' }),
  ]));
  const r = rec(recs, '820004');
  assert.equal(r.journey.length, 2, 'unchanged');
  assert.ok(r.journey.every(e => !e.transfer));
});

test('transfer-path: abandon OUTSIDE the +/-5s window is not attached (no window widening)', function () {
  const recs = build(capturedInboundAnsweredBy215('820005').concat([
    // Abandon at 10:05:10 -- 10s past the answered leg stop (10:05:00) -> miss.
    transferAbandonBy215('820903', '06/04/2026 10:05:10'),
  ]));
  const r = rec(recs, '820005');
  assert.equal(r.journey.length, 2, 'temporal near-miss stays unresolved');
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

// ---- P-1: expectedDateIso pins the authoritative replace to the import's date.
// A stray carry-over leg from the previous day (the F2 scenario) used to put
// D-1 into the payload's date set -- the authoritative DELETE then wiped ALL
// of D-1's inbound_calls rows (no sheet primary -> permanent loss) and
// replaced them with the lone stray fragment.
const P1_STRAY_ROWS = L2_ROWS.concat([
  leg({ callId: '555001', legId: 1, start: '06/03/2026 14:00:00', stop: '06/03/2026 14:01:00', direction: 'Incoming', caller: '12155550000', callee: '108', calleeName: 'A_Q_Intake', dialIn: '19722281820' }),
]);

test('P-1: stray-dated records are dropped and the DELETE never touches their date', function () {
  const cap = {};
  h.ctx.getReachableNeonConn_ = function () { return fakeInboundConn(cap); };
  h.call('writeInboundCallsToNeon', P1_STRAY_ROWS,
    { authoritative: true, expectedDateIso: '2026-06-04' });
  const dels = cap.executed.filter(s => /DELETE FROM inbound_calls/.test(s));
  assert.equal(dels.length, 1, 'exactly one DELETE fired');
  assert.match(dels[0], /call_date IN \('2026-06-04'::date\)/, 'DELETE scoped to the expected date');
  assert.ok(!dels[0].includes('2026-06-03'), 'the stray D-1 date is NOT deleted');
  const ins = cap.executed.filter(s => /INSERT INTO inbound_calls/.test(s)).join('\n');
  assert.ok(!ins.includes('2026-06-03'), 'the stray fragment is not written either');
});

test('P-1: without expectedDateIso the old trust-the-payload behavior is unchanged', function () {
  const cap = {};
  h.ctx.getReachableNeonConn_ = function () { return fakeInboundConn(cap); };
  h.call('writeInboundCallsToNeon', P1_STRAY_ROWS, { authoritative: true });
  const dels = cap.executed.filter(s => /DELETE FROM inbound_calls/.test(s));
  assert.equal(dels.length, 1);
  assert.ok(dels[0].includes('2026-06-04') && dels[0].includes('2026-06-03'),
    'both payload dates deleted when no expected date is pinned (legacy contract)');
});

// ---- R8-N: capture-time queue-name normalization (raw -> QCD-canonical) -----
// Seeded from Dept Config's "Inbound queue aliases" `raw=canonical` pairs
// (cross-project best-effort read, the INV-46 soft-coupling pattern).

const DC_HEADERS_N = ['Department', 'QCD Queues', 'Overview Parent', 'Team Avg Excludes',
  'Queue Ext Overrides', 'Active', 'Updated By', 'Updated At', 'Notes', 'Inbound Queue Aliases'];
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

function installDeptConfigN(aliasCell, active) {
  h.ctx.getTargetSsId_ = function () { return 'fake-target'; };
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {
    'Dept Config': [DC_HEADERS_N,
      ['CSR', 'A_Q_CustomerSuccess', '', '', '', active === false ? 'FALSE' : 'TRUE',
       'admin@x.com', '', '', aliasCell]],
  } });
}

test('R8-N: icQueueCanonicalMap_ parses raw=canonical pairs; plain aliases and inactive rows do not map', function () {
  installDeptConfigN('A_Q_CSR=A_Q_CustomerSuccess, Backup CSR');
  h.call('icResetConfigMemos_');   // F1: one reset covers every Dept-Config memo
  const map = h.call('icQueueCanonicalMap_');
  assert.equal(map['a_q_csr'], 'A_Q_CustomerSuccess', 'pair maps (case-insensitive key)');
  assert.equal(map['backup csr'], undefined, 'plain alias stays attribution-only');
  installDeptConfigN('A_Q_CSR=A_Q_CustomerSuccess', /*active=*/false);
  h.call('icResetConfigMemos_');   // F1: one reset covers every Dept-Config memo
  assert.deepEqual(Object.keys(h.call('icQueueCanonicalMap_')), [], 'inactive row ignored');
  delete h.ctx.getTargetSsId_;
});

test('R8-N: entry/final_queue are translated at capture; the journey keeps the RAW name', function () {
  installDeptConfigN('A_Q_Intake=A_Q_IntakeCanon');
  const cap = {};
  h.ctx.getReachableNeonConn_ = function () { return fakeInboundConn(cap); };
  h.call('writeInboundCallsToNeon', L2_ROWS);
  const ins = cap.executed.filter(s => /INSERT INTO inbound_calls/.test(s))[0];
  assert.ok(ins, 'insert fired');
  assert.match(ins, /'A_Q_IntakeCanon'/, 'entry_queue translated to the canonical name');
  assert.match(ins, /A_Q_Intake(?!Canon)/, 'journey JSON keeps the raw phone-system name');
  delete h.ctx.getTargetSsId_;
});

test('R8-N: no Dept Config reachable -> capture stays raw (best-effort no-op)', function () {
  delete h.ctx.getTargetSsId_;   // loader can't resolve the target ss
  h.state.spreadsheet = null;
  const cap = {};
  h.ctx.getReachableNeonConn_ = function () { return fakeInboundConn(cap); };
  h.call('writeInboundCallsToNeon', L2_ROWS);
  const ins = cap.executed.filter(s => /INSERT INTO inbound_calls/.test(s))[0];
  assert.match(ins, /'A_Q_Intake'/, 'raw name preserved when no map is available');
});

// ---- F1: queue-name recognition is fed by Dept Config, not just the regex ----
// The hardcoded /^A_Q_/ + 'Backup CSR' patterns already cost one silent,
// permanent mis-capture (IMP-1). A queue named outside them used to yield
// entry_queue=NULL -> attributable to NO dept -> invisible in every dept's
// Inbound report AND in the two diagnostics that scan entry_queue.

test('F1b: BRAND-PREFIXED queues are recognized without any config (UDC_/UUC_A_Q_*)', function () {
  h.call('icResetConfigMemos_');   // prove it needs no Dept Config at all
  // Both are first-class queues per the DQE pipeline's DQE_EXCLUDED_AGENTS;
  // the old `^A_Q_` anchor made them invisible to the inbound capture
  // (UDC_A_Q_Main measured at 38 abandoned calls in one ~8-week window).
  assert.equal(h.call('icIsQueueName_', 'UDC_A_Q_Main'), true);
  assert.equal(h.call('icIsQueueName_', 'UUC_A_Q_Main'), true);
  assert.equal(h.call('icIsQueueName_', 'udc_a_q_main'), true, 'case-insensitive');
  assert.equal(h.call('icIsQueueName_', 'A_Q_CustomerSuccess'), true, 'unprefixed still matches');
  // The 'Backup CSR' arm must stay EXACT -- widening it the way the DQE
  // pipeline's boundary pattern does would make a person a queue (IMP-1 pins).
  assert.equal(h.call('icIsQueueName_', 'Jane Backup CSR'), false);
  assert.equal(h.call('icIsQueueName_', 'Backup CSR Team'), false);
  // A brand IVR node is NOT a queue -- it carries no A_Q_ token.
  assert.equal(h.call('icIsQueueName_', 'Universal Dialysis Center'), false);
  assert.equal(h.call('icIsQueueName_', 'PAP Advt'), false);
});

test('F1b: a UDC-prefixed queue abandon is a QUEUE abandon with entry_queue set', function () {
  h.call('icResetConfigMemos_');
  const recs = build([
    leg({ callId: '990100', legId: 1, start: '07/23/2026 10:00:00', stop: '07/23/2026 10:00:12',
          direction: 'Incoming', caller: '12145551111', callee: '999',
          calleeName: 'Universal Dialysis Center', dialIn: '18668646332' }),
    leg({ callId: '990100', legId: 2, start: '07/23/2026 10:00:12', stop: '07/23/2026 10:02:40',
          direction: 'Incoming', caller: '12145551111', callee: '150',
          calleeName: 'UDC_A_Q_Main', dialIn: '18668646332',
          missed: 'Missed', abandoned: 'Abandoned' }),
  ]);
  const r = rec(recs, '990100');
  assert.equal(r.disposition, 'abandoned');
  assert.equal(r.abandonStage, 'queue', 'was mis-filed as ivr before F1b');
  assert.equal(r.entryQueue, 'UDC_A_Q_Main', 'attributable now (was NULL)');
  assert.equal(r.numQueues, 1);
});

test('F1: a Dept-Config queue name outside the A_Q_/Backup-CSR patterns is recognized', function () {
  h.call('icResetConfigMemos_');
  assert.equal(h.call('icIsQueueName_', 'Sales Overflow'), false,
    'not a queue while no config is loaded (pre-F1 behavior)');

  installDeptConfigN('Sales Overflow');          // a RAW inbound alias
  h.call('icResetConfigMemos_');
  h.call('icLoadConfiguredQueueNames_');
  assert.equal(h.call('icIsQueueName_', 'Sales Overflow'), true, 'alias-listed name is a queue');
  assert.equal(h.call('icIsQueueName_', 'sales overflow'), true, 'match is case-insensitive');
  assert.equal(h.call('icIsQueueName_', 'A_Q_CustomerSuccess'), true,
    'the QCD Queues column feeds recognition too');
  assert.equal(h.call('icIsQueueName_', 'Sales'), false, 'unrelated names are still not queues');
  assert.equal(h.call('icIsQueueName_', 'A_Q_Anything'), true, 'the regex arm still stands alone');
  delete h.ctx.getTargetSsId_;
  h.call('icResetConfigMemos_');
});

test('F1: the raw side of a raw=canonical pair is recognized; digit-only tokens are not', function () {
  installDeptConfigN('A_Q_CSR=A_Q_CustomerSuccess, 138');
  h.call('icResetConfigMemos_');
  h.call('icLoadConfiguredQueueNames_');
  assert.equal(h.call('icIsQueueName_', 'A_Q_CSR'), true);
  assert.equal(h.call('icIsQueueName_', '138'), false,
    'a digit token is an extension, never a queue name');
  delete h.ctx.getTargetSsId_;
  h.call('icResetConfigMemos_');
});

test('F1: an inactive Dept Config row contributes no queue names', function () {
  installDeptConfigN('Sales Overflow', /*active=*/false);
  h.call('icResetConfigMemos_');
  h.call('icLoadConfiguredQueueNames_');
  assert.equal(h.call('icIsQueueName_', 'Sales Overflow'), false);
  delete h.ctx.getTargetSsId_;
  h.call('icResetConfigMemos_');
});

// ---- F2: the zero-record authoritative cleanup ------------------------------
// inbound_calls has no sheet primary, so a date whose legitimate record count
// is zero could never shed phantom rows from an earlier import: the writer
// returned before the authoritative DELETE. Gated on a NON-EMPTY source, since
// an unreadable grid is the one case where deleting would destroy good data.

// Internal-only legs (no Incoming leg): real source rows that yield no
// INBOUND call record -- the shape of a date whose legitimate count is zero.
const F2_INTERNAL_ONLY = [
  leg({ callId: '5001', legId: 1, start: '07/20/2026 09:00:00', stop: '07/20/2026 09:00:30',
        direction: 'Outgoing', caller: '101', callerName: 'Jane Agent',
        callee: '102', calleeName: 'Bob Agent', talk: '0:00:25', answered: 'Answered', dept: 'CSR' }),
];

test('F2: authoritative + source rows + zero records -> DELETEs the expected date', function () {
  const cap = {};
  h.ctx.getReachableNeonConn_ = function () { return fakeInboundConn(cap); };
  const res = h.call('writeInboundCallsToNeon', F2_INTERNAL_ONLY,
    { authoritative: true, expectedDateIso: '2026-07-20' });
  const del = (cap.executed || []).filter(s => /DELETE FROM inbound_calls/.test(s));
  assert.equal(del.length, 1, 'the stale date was deleted');
  assert.match(del[0], /call_date = '2026-07-20'::date/, 'scoped to the EXPECTED date only');
  assert.equal(res.inserted, 0);
  assert.ok(!(cap.executed || []).some(s => /INSERT INTO inbound_calls/.test(s)),
    'nothing inserted');
});

test('F2: an EMPTY source never deletes (an unreadable grid must not destroy data)', function () {
  const cap = {};
  h.ctx.getReachableNeonConn_ = function () { return fakeInboundConn(cap); };
  const res = h.call('writeInboundCallsToNeon', [],
    { authoritative: true, expectedDateIso: '2026-07-20' });
  // Field-wise, not deepEqual: the object crosses the vm realm boundary, so it
  // is never reference-equal to a host-realm literal under assert/strict.
  assert.equal(res.inserted, 0);
  assert.equal(res.skipped, 0);
  assert.equal(res.cleared, undefined, 'no cleanup was attempted');
  assert.equal((cap.executed || []).length, 0, 'no statement ran at all');
});

test('F2: NON-authoritative zero-record runs never delete', function () {
  const cap = {};
  h.ctx.getReachableNeonConn_ = function () { return fakeInboundConn(cap); };
  h.call('writeInboundCallsToNeon', F2_INTERNAL_ONLY, { expectedDateIso: '2026-07-20' });
  assert.ok(!(cap.executed || []).some(s => /DELETE FROM inbound_calls/.test(s)));
});

test('F2: zero records + Neon unreachable -> flagged unreachable so the date is retried', function () {
  h.ctx.getReachableNeonConn_ = function () { return null; };
  const res = h.call('writeInboundCallsToNeon', F2_INTERNAL_ONLY,
    { authoritative: true, expectedDateIso: '2026-07-20' });
  assert.equal(res.unreachable, true,
    'the deferred mirror must keep the date queued rather than mark it done');
});

test('C-1: an ALL-STRAY yield refuses the zero-record cleanup (wrong-day grid must not delete)', function () {
  // Source grid holds ONLY records dated outside the expected date -- the
  // signature of a mislabeled/wrong-day Call_Legs grid, not a zero-call day.
  // The old gate ("source non-empty") deleted the expected date's rows here;
  // with no sheet primary that loss is permanent past the retention window.
  const cap = {};
  h.ctx.getReachableNeonConn_ = function () { return fakeInboundConn(cap); };
  const strayOnly = [
    leg({ callId: '555001', legId: 1, start: '06/03/2026 14:00:00', stop: '06/03/2026 14:01:00',
          direction: 'Incoming', caller: '12155550000', callee: '108',
          calleeName: 'A_Q_Intake', dialIn: '19722281820' }),
  ];
  const res = h.call('writeInboundCallsToNeon', strayOnly,
    { authoritative: true, expectedDateIso: '2026-06-04' });
  assert.equal(res.allStray, true, 'refusal is reported to the caller');
  assert.equal(res.strayCount, 1);
  assert.equal(res.cleared, undefined, 'no cleanup happened');
  assert.equal((cap.executed || []).length, 0,
    'no statement ran -- the expected date\'s rows are untouched');
});

test('C-6: an ALL-UNPARSED yield refuses the zero-record cleanup (format drift must not delete)', function () {
  // Every record the grid yields has an unparseable first-leg timestamp, so
  // callDate is null on all of them -- the timestamp-format-drift signature.
  // Without the C-6 arm these pass the stray gate (they are not stray-DATED,
  // they are date-LESS) and the delete-only pass would wipe the expected date
  // while the capture is blind.
  const cap = {};
  h.ctx.getReachableNeonConn_ = function () { return fakeInboundConn(cap); };
  const unparsedOnly = [
    leg({ callId: '555002', legId: 1, start: '2026-06-04T14:00:00Z', stop: '2026-06-04T14:01:00Z',
          direction: 'Incoming', caller: '12155550000', callee: '108',
          calleeName: 'A_Q_Intake', dialIn: '19722281820' }),
  ];
  const res = h.call('writeInboundCallsToNeon', unparsedOnly,
    { authoritative: true, expectedDateIso: '2026-06-04' });
  assert.equal(res.allUnparsed, true, 'refusal is reported to the caller');
  assert.equal(res.unparsedDropped, 1);
  assert.equal(res.cleared, undefined, 'no cleanup happened');
  assert.equal((cap.executed || []).length, 0,
    'no statement ran -- the expected date\'s rows are untouched');
});

// ---- Round-16: internal-origin queue calls (journey-only capture) -----------
// An employee dials another dept's queue internally (every leg
// Direction=Internal) and the call is abandoned. Previously dropped entirely,
// so the Missed report's "path" drill answered "not in the inbound-call
// records". Now captured as a FLAGGED record (isInternal) that every metric
// query excludes -- fixture modeled on the 2026-08-04 production sample
// (ext 270 -> A_Q_Eligibility_MM&R, ring cycling through three agents).

test('internal-origin queue call: captured as an isInternal record with the full journey', function () {
  const recs = build([
    leg({ callId: '1783982365872', legId: 1, start: '08/04/2026 14:20:15', connected: '08/04/2026 14:20:16', stop: '08/04/2026 14:21:59', direction: 'Internal', callTime: '0:01:43', caller: '270', callerName: 'Sonia Santos', callee: '383', calleeName: 'A_Q_Eligibility_MM&R', missed: 'Missed', abandoned: 'Abandoned', dept: 'Patient Intake - Supplies' }),
    leg({ callId: '1783982365878', legId: 1, parent: '1783982365872', start: '08/04/2026 14:20:16', stop: '08/04/2026 14:20:26', direction: 'Internal', callTime: '0:00:10', caller: 'CallQueue (383)', callee: '283', calleeName: 'Felisha Casey', missed: 'Missed', dept: 'Patient Intake - Mobility/DME' }),
    leg({ callId: '1783982365947', legId: 1, parent: '1783982365872', start: '08/04/2026 14:20:36', stop: '08/04/2026 14:20:46', direction: 'Internal', callTime: '0:00:10', caller: '383', callee: '236', calleeName: 'Amber (Aayushi) Panchal', missed: 'Missed', dept: 'Eligibility Verification' }),
  ]);
  assert.equal(recs.length, 1, 'the internal queue call is captured');
  const r = rec(recs, '1783982365872');
  assert.equal(r.isInternal, true);
  assert.equal(r.disposition, 'abandoned');
  assert.equal(r.abandonStage, 'queue');
  assert.equal(r.entryQueue, 'A_Q_Eligibility_MM&R');
  assert.equal(r.callDate, '2026-08-04');
  assert.equal(r.callStart, '14:20:15');
  assert.equal(r.callerNumber, null, 'no external caller -- writes a NULL caller_hash');
  assert.ok(r.waitSeconds >= 100 && r.waitSeconds <= 110, 'wait = origin start -> abandon stop (~104s)');
  // Journey: the queue leg + both agent rings survive for the path drill.
  const names = r.journey.map(function (ev) { return ev.name; });
  assert.ok(names.indexOf('A_Q_Eligibility_MM&R') !== -1, 'queue event present');
  assert.ok(names.indexOf('Felisha Casey') !== -1 && names.indexOf('Amber (Aayushi) Panchal') !== -1,
    'agent ring events present');
});

test('internal agent-to-agent call (no queue leg) stays uncaptured', function () {
  const recs = build([
    leg({ callId: '990001', legId: 1, start: '08/04/2026 15:00:00', connected: '08/04/2026 15:00:02', stop: '08/04/2026 15:01:00', direction: 'Internal', talk: '0:00:58', caller: '270', callee: '283', calleeName: 'Felisha Casey', answered: 'Answered', dept: 'CSR' }),
  ]);
  assert.equal(recs.length, 0, 'no queue leg -> not captured');
});

test('external inbound records stay isInternal=false (metric queries key on the flag)', function () {
  const recs = build(capturedInboundAnsweredBy215('830001'));
  assert.equal(rec(recs, '830001').isInternal, false);
});

// ---- Round-16b: internal record links its originating inbound call ----------
// The owner's "nested timeframe" heuristic: an internal queue call placed
// WHILE the originating employee was answering a captured inbound call
// (customer parked on hold) carries relatedCallId -> that call, so the path
// drill can present the full story. Unique-match-only, the R11-N discipline.

test('internal call nested in the originator’s answered inbound: relatedCallId links it (unique match)', function () {
  const recs = build(capturedInboundAnsweredBy215('840001').concat([
    // ext 215 dials A_Q_Spanish at 10:02, rings out MISSED (not abandoned --
    // an abandoned unique match becomes R11-N enrichment instead).
    leg({ callId: '840900', legId: 1, start: '06/04/2026 10:02:00', stop: '06/04/2026 10:02:30', direction: 'Internal', callTime: '0:00:30', caller: '215', callee: '260', calleeName: 'A_Q_Spanish', missed: 'Missed' }),
  ]));
  assert.equal(recs.length, 2, 'captured inbound + the standalone internal record');
  const ir = rec(recs, '840900');
  assert.equal(ir.isInternal, true);
  assert.equal(ir.relatedCallId, '840001', 'linked to the call the employee was on');
  assert.equal(rec(recs, '840001').relatedCallId, undefined, 'external record carries no link');
});

test('ambiguous nesting (two concurrent calls) or no concurrent call: no link', function () {
  // Two captured inbounds answered by 215 over the same window -> ambiguous.
  const recs = build(capturedInboundAnsweredBy215('850001')
    .concat(capturedInboundAnsweredBy215('850002'))
    .concat([
      leg({ callId: '850900', legId: 1, start: '06/04/2026 10:02:00', stop: '06/04/2026 10:02:30', direction: 'Internal', callTime: '0:00:30', caller: '215', callee: '260', calleeName: 'A_Q_Spanish', missed: 'Missed' }),
    ]));
  assert.equal(rec(recs, '850900').relatedCallId, undefined, 'ambiguous -> never guesses');
});

// ── Round-17b: WHO placed an internal-origin call ───────────────────────────
// `firstAgent` derives from the CALLEE name across the group's legs, and an
// internal-origin group's only callee IS the queue (which icIsQueueName_
// skips), so these records carried no indication of who placed the call --
// the receiving dept's path drill read "an internal call abandoned in your
// queue" with nothing actionable. The originator lives in the CALLER columns.
// Fixture mirrors the owner's real 2026-08-21 legs (Field Ops rep on an
// OUTBOUND patient call dials A_Q_Spanish for translation; nobody answers).

test('internal-origin: captures the originating agent + raw org label from the caller side', function () {
  const recs = build([
    leg({ callId: '830001', legId: 1, start: '08/21/2026 07:14:57',
          connected: '08/21/2026 07:14:57', stop: '08/21/2026 07:20:07',
          direction: 'Internal', callTime: '0:05:09',
          caller: '279', callerName: 'Marie (Muskaan) Jindal',
          callee: '138', calleeName: 'A_Q_Spanish',
          missed: 'Missed', abandoned: 'Abandoned',
          dept: 'Field Operations (Market Activity)' }),
  ]);
  const r = rec(recs, '830001');
  assert.ok(r, 'the internal-origin abandon is captured (the receiving queue drills it)');
  assert.equal(r.isInternal, true);
  assert.equal(r.originAgent, 'Marie (Muskaan) Jindal');
  assert.equal(r.originDept, 'Field Operations (Market Activity)');
  // firstAgent stays null -- the only callee is the queue. That is exactly the
  // hole originAgent fills; it must not be papered over by reusing firstAgent.
  assert.equal(r.firstAgent, null);
  // Metric fields untouched by the addition.
  assert.equal(r.disposition, 'abandoned');
  assert.equal(r.entryQueue, 'A_Q_Spanish');
});

test('internal-origin: a phone-shaped or queue caller name is never stored as the originator', function () {
  const phoneNamed = build([
    leg({ callId: '830002', legId: 1, start: '08/21/2026 08:00:00', stop: '08/21/2026 08:02:00',
          direction: 'Internal', callTime: '0:02:00',
          caller: '12145559999', callerName: '+1 214 555 9999',
          callee: '138', calleeName: 'A_Q_Spanish',
          missed: 'Missed', abandoned: 'Abandoned', dept: 'CSR' }),
  ]);
  assert.equal(rec(phoneNamed, '830002').originAgent, null,
    'a raw number must never land in origin_agent (the firstAgent PHI guard)');

  const queueNamed = build([
    leg({ callId: '830003', legId: 1, start: '08/21/2026 08:10:00', stop: '08/21/2026 08:12:00',
          direction: 'Internal', callTime: '0:02:00',
          caller: '144', callerName: 'A_Q_FieldOps',
          callee: '138', calleeName: 'A_Q_Spanish',
          missed: 'Missed', abandoned: 'Abandoned', dept: 'CSR' }),
  ]);
  assert.equal(rec(queueNamed, '830003').originAgent, null, 'a queue is not an originator');
  // A blank/N-A org label yields null rather than the literal string.
  const noDept = build([
    leg({ callId: '830004', legId: 1, start: '08/21/2026 08:20:00', stop: '08/21/2026 08:22:00',
          direction: 'Internal', callTime: '0:02:00',
          caller: '279', callerName: 'Marie (Muskaan) Jindal',
          callee: '138', calleeName: 'A_Q_Spanish',
          missed: 'Missed', abandoned: 'Abandoned', dept: 'N/A' }),
  ]);
  assert.equal(rec(noDept, '830004').originDept, null);
  assert.equal(rec(noDept, '830004').originAgent, 'Marie (Muskaan) Jindal');
});

test('externally-originated calls carry NO originator (the field is internal-only)', function () {
  const recs = build([
    leg({ callId: '830010', legId: 1, start: '08/21/2026 09:00:00', stop: '08/21/2026 09:00:20',
          direction: 'Incoming', caller: '12145550000', callerName: 'WIRELESS CALLER',
          callee: '103', calleeName: 'A_Q_CSR', dialIn: '19722281820',
          missed: 'Missed', abandoned: 'Abandoned' }),
  ]);
  const r = rec(recs, '830010');
  assert.ok(!r.isInternal, 'an externally-originated call is never flagged internal');
  assert.equal(r.originAgent, null, 'nothing changes for the externally-originated population');
  assert.equal(r.originDept, null);
});

// ── Step 4: link the assist to the requester's concurrent OUTBOUND call ─────
// Validated shape (owner's 2026-08-21 legs): a Field Ops rep on an OUTGOING
// patient call dials A_Q_Spanish for translation and nobody answers. agentBusy
// keys on the CALLEE ext, so that rep is invisible to the inbound matcher --
// the outbound index is what makes the link findable. Unique-match only, and
// an INBOUND match always wins.

function outboundPatientCallBy279(callId, connected, stop) {
  return [
    leg({ callId: callId, legId: 1, start: connected, connected: connected, stop: stop,
          direction: 'Outgoing', talk: '0:05:39', caller: '279',
          callerName: 'Marie (Muskaan) Jindal', callee: '19722224444',
          answered: 'Answered', dept: 'Field Operations (Market Activity)' }),
    // The recording artifact that rides along -- talk=0, must never be treated
    // as evidence of anything.
    leg({ callId: callId, legId: 2, start: connected, stop: stop, direction: 'Internal',
          caller: '279', callerName: 'Marie (Muskaan) Jindal', callee: 'CallRecording',
          dept: 'Field Operations (Market Activity)' }),
  ];
}
function assistAbandon279(callId, start, stop) {
  return leg({ callId: callId, legId: 1, start: start, connected: start, stop: stop,
               direction: 'Internal', callTime: '0:05:09', caller: '279',
               callerName: 'Marie (Muskaan) Jindal', callee: '138', calleeName: 'A_Q_Spanish',
               missed: 'Missed', abandoned: 'Abandoned',
               dept: 'Field Operations (Market Activity)' });
}

test('Step 4: an assist placed during an OUTBOUND call links to that call', function () {
  const recs = build(
    outboundPatientCallBy279('840001', '08/21/2026 07:14:29', '08/21/2026 07:20:09').concat([
      assistAbandon279('840900', '08/21/2026 07:14:57', '08/21/2026 07:20:07'),
    ]));
  const ir = rec(recs, '840900');
  assert.ok(ir, 'the assist abandon is still captured for the receiving queue');
  assert.equal(ir.isInternal, true);
  assert.equal(ir.relatedCallId, '840001');
  assert.equal(ir.relatedCallKind, 'outbound', 'the drill must query outbound_calls, not inbound');
  assert.equal(ir.originAgent, 'Marie (Muskaan) Jindal');
});

test('Step 4: an INBOUND match wins over a concurrent outbound one', function () {
  // Same agent on BOTH a captured inbound and an outbound call across the
  // abandon. The handed-over customer is the stronger relationship.
  const recs = build(
    capturedInboundAnsweredBy215('840010').concat(
    outboundPatientCallBy279('840011', '06/04/2026 10:02:00', '06/04/2026 10:06:00')).concat([
      leg({ callId: '840901', legId: 1, start: '06/04/2026 10:03:00', connected: '06/04/2026 10:03:00',
            stop: '06/04/2026 10:03:40', direction: 'Internal', callTime: '0:00:40',
            caller: '215', callerName: 'Raymond (Ray) Mathews', callee: '260',
            calleeName: 'A_Q_Spanish', missed: 'Missed', abandoned: 'Abandoned', dept: 'CSR' }),
    ]));
  const ir = rec(recs, '840901');
  assert.equal(ir.relatedCallKind, 'inbound');
  assert.equal(ir.relatedCallId, '840010');
});

test('Step 4: never guesses -- two concurrent outbound calls leave it unlinked', function () {
  const recs = build(
    outboundPatientCallBy279('840020', '08/21/2026 07:14:00', '08/21/2026 07:21:00').concat(
    outboundPatientCallBy279('840021', '08/21/2026 07:14:10', '08/21/2026 07:21:10')).concat([
      assistAbandon279('840902', '08/21/2026 07:14:57', '08/21/2026 07:20:07'),
    ]));
  const ir = rec(recs, '840902');
  assert.ok(ir.relatedCallId == null, 'ambiguous -> no link, no guess');
  assert.ok(ir.relatedCallKind == null);
});

test('Step 4: a non-overlapping outbound call is not linked', function () {
  const recs = build(
    outboundPatientCallBy279('840030', '08/21/2026 09:00:00', '08/21/2026 09:05:00').concat([
      assistAbandon279('840903', '08/21/2026 07:14:57', '08/21/2026 07:20:07'),
    ]));
  assert.ok(rec(recs, '840903').relatedCallId == null,
    'the requester must have been on the call AT the assist time');
});

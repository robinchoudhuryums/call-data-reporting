'use strict';

// Unit coverage of the direct-extension call metrics engine
// (cdr-import/directCallMetrics.js) -- the busy/overlap carve-out, the
// internal/external split, the work-window filter, and dedup. The engine is a
// PURE function so it loads + runs in the vm with no Apps Script services.
// See docs/direct-extension-metrics-design.md for the approved definitions.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

const h = loadGas({ project: 'cdr-import', files: ['directCallMetrics.js'] });
const compute = h.fn('computeDirectCallMetrics');

// Roster: Anna ext 101 (CSR), Bob ext 102 (CSR). External callers are phones.
const MAPS = {
  extToAgent: { '101': { name: 'Anna', dept: 'CSR' }, '102': { name: 'Bob', dept: 'CSR' } },
  queueExtSet: new Set(['103']),
  exclusions: new Set(['103']),
};

// Raw Data row (>=26 cols). Indices match the engine's column map.
function row(o) {
  const r = new Array(26).fill('');
  r[0]  = o.cid || '';
  r[2]  = o.start || '';                 // "MM/DD/YYYY H:MM:SS"
  r[5]  = o.dir || '';                   // Incoming | Internal | Outgoing
  r[6]  = o.talk || '';                  // H:MM:SS
  r[7]  = o.callTime || '';              // H:MM:SS (ring/hold duration)
  r[8]  = o.caller || '';                // CALLER ext/number (col I)
  r[9]  = o.callerName || '';            // CALLER NAME (col J)
  r[10] = o.callee || '';               // CALLEE ext/number (col K)
  r[11] = o.calleeName || '';            // CALLEE NAME (col L) -- e.g. 'A_Q_CSR'
  r[13] = o.ctx || '';                   // CONTEXT ('CallQueue...' => queue leg)
  r[14] = o.parent || '';                // PARENT_CALL (col O)
  r[22] = o.callerId || '';              // CALLER_ID (col W) -- DQE queue marker
  r[23] = o.missed ? 'Missed' : '';
  r[25] = o.answered ? 'Answered' : '';
  return r;
}
function grid(rows) { return [new Array(26).fill('')].concat(rows); }
function rowFor(res, agent) { return res.rows.filter(function (r) { return r.agent === agent; })[0]; }

const D = '03/09/2026 ';   // date prefix; 10:00:00 -> 36000s (in 6:30-15:00 window)

test('inbound external answered -> ib_ext_answered + talk', function () {
  const res = compute(grid([
    row({ cid: 'A', start: D + '10:00:00', dir: 'Incoming', talk: '0:01:00', callTime: '0:01:00', caller: '+15551234567', callee: '101', answered: true }),
  ]), MAPS, {});
  const a = rowFor(res, 'Anna');
  assert.equal(a.ib_ext_answered, 1);
  assert.equal(a.ib_ext_talk_sec, 60);
  assert.equal(a.ib_ext_missed_free, 0);
  assert.equal(a.ib_ext_missed_busy, 0);
});

test('inbound missed with no overlap -> missed_free', function () {
  const res = compute(grid([
    row({ cid: 'A', start: D + '10:00:00', dir: 'Incoming', callTime: '0:00:20', caller: '+15551234567', callee: '101', missed: true }),
  ]), MAPS, {});
  const a = rowFor(res, 'Anna');
  assert.equal(a.ib_ext_missed_free, 1);
  assert.equal(a.ib_ext_missed_busy, 0);
});

test('inbound missed while on another (outbound) call -> missed_busy', function () {
  const res = compute(grid([
    // Anna on an outbound call 10:00:00 -> 10:05:00 (300s talk).
    row({ cid: 'OUT', start: D + '10:00:00', dir: 'Outgoing', talk: '0:05:00', callTime: '0:05:00', caller: '101', callee: '+15559999999' }),
    // Inbound ring at 10:02:00 (mid-call) -> excused.
    row({ cid: 'IN', start: D + '10:02:00', dir: 'Incoming', callTime: '0:00:20', caller: '+15551234567', callee: '101', missed: true }),
  ]), MAPS, {});
  const a = rowFor(res, 'Anna');
  assert.equal(a.ib_ext_missed_busy, 1);
  assert.equal(a.ib_ext_missed_free, 0);
});

test('miss within the 5s wrap-up tail -> busy; miss past the tail -> free', function () {
  // Anna on a call 10:00:00 -> 10:05:00. Tail extends busy to 10:05:05.
  const busyLeg = row({ cid: 'C1', start: D + '10:00:00', dir: 'Outgoing', talk: '0:05:00', callTime: '0:05:00', caller: '101', callee: '+15559999999' });

  const inTail = compute(grid([busyLeg,
    row({ cid: 'R', start: D + '10:05:03', dir: 'Incoming', callTime: '0:00:10', caller: '+15551112222', callee: '101', missed: true }),
  ]), MAPS, {});
  assert.equal(rowFor(inTail, 'Anna').ib_ext_missed_busy, 1, 'ring 3s after hangup is within the 5s tail');

  const pastTail = compute(grid([busyLeg,
    row({ cid: 'R', start: D + '10:05:08', dir: 'Incoming', callTime: '0:00:10', caller: '+15551112222', callee: '101', missed: true }),
  ]), MAPS, {});
  assert.equal(rowFor(pastTail, 'Anna').ib_ext_missed_free, 1, 'ring 8s after hangup is past the tail');
});

test('a ring whose CALLER is a queue extension is NOT a direct inbound (queue leak fix)', function () {
  // 103 is the CS-queue ext (in queueExtSet). A "ring" from 103 -> agent is the
  // queue distributing a call, not a direct inbound miss against the agent.
  const res = compute(grid([
    row({ cid: 'Q1', start: D + '11:07:45', dir: 'Internal', callTime: '0:00:20', caller: '103', callee: '101', missed: true }),
  ]), MAPS, {});
  assert.equal(rowFor(res, 'Anna'), undefined, 'ring from queue ext 103 is excluded from direct inbound');
});

test('answered queue call: the agent Outgoing talk leg is NOT a direct outbound (sibling-leg queue fix)', function () {
  // Leg 1 marks the whole call as a queue call (callee 103 / name A_Q_CSR);
  // Leg 4 (same call id) is the agent answering, shown as Outgoing with the
  // talk time -> must NOT count as a direct outbound.
  const res = compute(grid([
    row({ cid: 'QC', start: D + '10:00:00', dir: 'Incoming', caller: '+15551234567', callee: '103', calleeName: 'A_Q_CSR' }),
    row({ cid: 'QC', start: D + '10:00:15', dir: 'Outgoing', talk: '0:04:00', callTime: '0:04:00', caller: '101', callee: '+15551234567' }),
  ]), MAPS, {});
  const a = rowFor(res, 'Anna');
  assert.ok(!a || (a.ob_ext_total === 0 && a.ob_int_total === 0),
    'the answered-queue-call Outgoing leg is not counted as a direct outbound');
});

test('queue identified by CALLER_ID marker (A_Q_*) also excludes the call', function () {
  const res = compute(grid([
    row({ cid: 'QW', start: D + '10:30:00', dir: 'Incoming', callTime: '0:00:20', caller: '+15551234567', callee: '101', callerId: 'A_Q_CSR', missed: true }),
  ]), MAPS, {});
  assert.equal(rowFor(res, 'Anna'), undefined, 'CALLER_ID A_Q_CSR marks it a queue call, not a direct miss');
});

test('a QUEUE call the agent was on makes them busy for a direct miss', function () {
  const res = compute(grid([
    // Queue leg (ctx CallQueue) Anna answered 10:00:00 -> 10:03:00.
    row({ cid: 'Q', start: D + '10:00:00', dir: 'Incoming', talk: '0:03:00', callTime: '0:03:00', caller: '103', callee: '101', ctx: 'CallQueue(103)', answered: true }),
    // Direct inbound ring at 10:01:30 -> excused (busy on the queue call).
    row({ cid: 'IN', start: D + '10:01:30', dir: 'Incoming', callTime: '0:00:20', caller: '+15551234567', callee: '101', missed: true }),
  ]), MAPS, {});
  const a = rowFor(res, 'Anna');
  assert.equal(a.ib_ext_missed_busy, 1);
  // The queue call itself must NOT be counted as a direct inbound event.
  assert.equal(a.ib_ext_answered, 0);
  assert.equal(a.ib_int_answered, 0);
});

test('hold time extends the busy window', function () {
  const res = compute(grid([
    // Talk 60s + hold 240s (callTime 300) starting 10:00:00 -> busy until 10:05:00.
    row({ cid: 'H', start: D + '10:00:00', dir: 'Incoming', talk: '0:01:00', callTime: '0:05:00', caller: '+15558888888', callee: '101', answered: true }),
    // Ring at 10:04:00 -- during the HOLD portion (past talk-end 10:01:00) -> busy.
    row({ cid: 'IN', start: D + '10:04:00', dir: 'Incoming', callTime: '0:00:20', caller: '+15551234567', callee: '101', missed: true }),
  ]), MAPS, {});
  assert.equal(rowFor(res, 'Anna').ib_ext_missed_busy, 1);
});

test('internal vs external split (Internal -> int, Incoming -> ext)', function () {
  const res = compute(grid([
    row({ cid: 'I1', start: D + '11:00:00', dir: 'Internal', callTime: '0:00:15', caller: '102', callee: '101', missed: true }),
    row({ cid: 'E1', start: D + '11:01:00', dir: 'Incoming', callTime: '0:00:15', caller: '+15551234567', callee: '101', missed: true }),
  ]), MAPS, {});
  const a = rowFor(res, 'Anna');
  assert.equal(a.ib_int_missed_free, 1);
  assert.equal(a.ib_ext_missed_free, 1);
});

test('multi-leg inbound call is deduped to one event', function () {
  const res = compute(grid([
    row({ cid: 'M', start: D + '10:00:00', dir: 'Incoming', callTime: '0:00:10', caller: '+15551234567', callee: '101', missed: true }),
    row({ cid: 'M', start: D + '10:00:05', dir: 'Incoming', callTime: '0:00:12', caller: '+15551234567', callee: '101', missed: true }),
  ]), MAPS, {});
  assert.equal(rowFor(res, 'Anna').ib_ext_missed_free, 1);
});

test('outbound is activity only: total / connected / talk, int vs ext callee', function () {
  const res = compute(grid([
    // external connected
    row({ cid: 'O1', start: D + '09:00:00', dir: 'Outgoing', talk: '0:02:00', callTime: '0:02:00', caller: '101', callee: '+15559999999' }),
    // external no-answer (talk 0) -> total++ but not connected
    row({ cid: 'O2', start: D + '09:05:00', dir: 'Outgoing', callTime: '0:00:25', caller: '101', callee: '+15557777777' }),
    // internal connected (callee is a known ext)
    row({ cid: 'O3', start: D + '09:10:00', dir: 'Outgoing', talk: '0:00:30', callTime: '0:00:30', caller: '101', callee: '102' }),
  ]), MAPS, {});
  const a = rowFor(res, 'Anna');
  assert.equal(a.ob_ext_total, 2);
  assert.equal(a.ob_ext_connected, 1);
  assert.equal(a.ob_ext_talk_sec, 120);
  assert.equal(a.ob_int_total, 1);
  assert.equal(a.ob_int_connected, 1);
  assert.equal(a.ob_int_talk_sec, 30);
});

test('rings outside the 6:30-15:00 work window are NOT counted', function () {
  const res = compute(grid([
    row({ cid: 'EARLY', start: D + '05:00:00', dir: 'Incoming', callTime: '0:00:20', caller: '+15551234567', callee: '101', missed: true }),
    row({ cid: 'LATE',  start: D + '16:00:00', dir: 'Incoming', callTime: '0:00:20', caller: '+15551234567', callee: '101', missed: true }),
  ]), MAPS, {});
  const a = rowFor(res, 'Anna');
  assert.equal(a, undefined, 'no in-window direct events -> Anna has no row');
});

test('busy detection uses calls even when they START before the window', function () {
  const res = compute(grid([
    // Outbound call starts 6:25 (before window) and runs to 6:35.
    row({ cid: 'PRE', start: D + '06:25:00', dir: 'Outgoing', talk: '0:10:00', callTime: '0:10:00', caller: '101', callee: '+15559999999' }),
    // In-window ring at 6:32 -> excused (agent still on the pre-window call).
    row({ cid: 'IN', start: D + '06:32:00', dir: 'Incoming', callTime: '0:00:20', caller: '+15551234567', callee: '101', missed: true }),
  ]), MAPS, {});
  assert.equal(rowFor(res, 'Anna').ib_ext_missed_busy, 1);
});

test('collectSamples: examples are gathered, and a missed_busy sample names its blocker', function () {
  const res = compute(grid([
    row({ cid: 'OUT', start: D + '10:00:00', dir: 'Outgoing', talk: '0:05:00', callTime: '0:05:00', caller: '101', callee: '+15559999999' }),
    row({ cid: 'IN',  start: D + '10:02:00', dir: 'Incoming', callTime: '0:00:20', caller: '+15551234567', callee: '101', missed: true }),
    row({ cid: 'FREE', start: D + '13:00:00', dir: 'Incoming', callTime: '0:00:20', caller: '+15558887777', callee: '101', missed: true }),
  ]), MAPS, { collectSamples: true });
  const s = res.meta.samples;
  assert.ok(s, 'samples present when collectSamples=true');
  assert.equal(s.ib_missed_busy.length, 1);
  assert.equal(s.ib_missed_free.length, 1);
  assert.equal(s.ob_connected.length, 1);
  const busy = s.ib_missed_busy[0];
  assert.equal(busy.callId, 'IN');
  assert.equal(busy.blockedByCallId, 'OUT', 'missed_busy sample names the blocking call id for Raw Data verification');
  assert.equal(busy.caller, '+15551234567');
});

test('no samples collected by default (collectSamples off)', function () {
  const res = compute(grid([
    row({ cid: 'A', start: D + '10:00:00', dir: 'Incoming', callTime: '0:00:20', caller: '+15551234567', callee: '101', missed: true }),
  ]), MAPS, {});
  assert.equal(res.meta.samples, undefined);
});

test('answer rate inputs: answered excluded-from-rate busy miss surfaced separately', function () {
  const res = compute(grid([
    row({ cid: 'A1', start: D + '12:00:00', dir: 'Incoming', talk: '0:01:00', callTime: '0:01:00', caller: '+1551', callee: '101', answered: true }),
    row({ cid: 'A2', start: D + '12:10:00', dir: 'Incoming', callTime: '0:00:20', caller: '+1552', callee: '101', missed: true }),  // free
    // busy miss during A1's window-overlapping... use a separate busy source:
    row({ cid: 'B0', start: D + '12:20:00', dir: 'Outgoing', talk: '0:05:00', callTime: '0:05:00', caller: '101', callee: '+1559' }),
    row({ cid: 'A3', start: D + '12:22:00', dir: 'Incoming', callTime: '0:00:20', caller: '+1553', callee: '101', missed: true }),  // busy
  ]), MAPS, {});
  const a = rowFor(res, 'Anna');
  // answered=1, missed_free=1, missed_busy=1.
  assert.equal(a.ib_ext_answered, 1);
  assert.equal(a.ib_ext_missed_free, 1);
  assert.equal(a.ib_ext_missed_busy, 1);
  // The dashboard rate (Phase 2) = answered/(answered+missed_free) = 1/2 = 50%,
  // with the 1 busy miss surfaced but excluded -- pinned here as the contract.
  const denom = a.ib_ext_answered + a.ib_ext_missed_free;
  assert.equal(a.ib_ext_answered / denom, 0.5);
});

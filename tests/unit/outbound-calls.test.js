'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// buildOutboundCallRecords_ is pure. outboundCalls.js leans on inboundCalls.js
// for IC_COL + the ic* helpers (same-project flat global scope), so both files
// load together.
const h = loadGas({ project: 'cdr-import', files: ['inboundCalls.js', 'outboundCalls.js'] });

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
function build(rows) { return h.call('buildOutboundCallRecords_', rows); }

test('connected outbound: agent + dept + talk/ring captured, callee normalized', function () {
  const recs = build([
    leg({ callId: '900001', legId: 1, start: '07/22/2026 09:00:00', connected: '07/22/2026 09:00:12',
      stop: '07/22/2026 09:03:24', direction: 'Outgoing', talk: '0:03:12', caller: '214',
      callerName: 'Maria G', callee: '12145550123', answered: 'Answered', dept: 'CSR' }),
  ]);
  assert.equal(recs.length, 1);
  const r = recs[0];
  assert.equal(r.callId, '900001');
  assert.equal(r.callDate, '2026-07-22');
  assert.equal(r.callStart, '09:00:00');
  assert.equal(r.calleeNumber, '+12145550123');   // canonical form -> same hash space as inbound
  assert.equal(r.agentExt, '214');
  assert.equal(r.agentName, 'Maria G');
  assert.equal(r.department, 'CSR');
  assert.equal(r.connected, true);
  assert.equal(r.talkSeconds, 192);
  assert.equal(r.ringSeconds, 12);                // start -> connected
  assert.equal(r.attempts, 1);
});

test('unanswered outbound: connected=false, ring = start -> stop', function () {
  const recs = build([
    leg({ callId: '900002', legId: 1, start: '07/22/2026 10:00:00', stop: '07/22/2026 10:00:35',
      direction: 'Outgoing', caller: '305', callee: '+12145550999', missed: 'Missed', dept: 'Sales' }),
  ]);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].connected, false);
  assert.equal(recs[0].talkSeconds, 0);
  assert.equal(recs[0].ringSeconds, 35);
});

test('a group with ANY Incoming leg is inbound, never outbound (agent Outgoing talk leg excluded)', function () {
  // The answered-inbound-queue-call shape: the agent's own leg is 'Outgoing'
  // with talk>0 -- direction alone would misfile it as an outbound call.
  const recs = build([
    leg({ callId: '910001', legId: 1, start: '07/22/2026 11:00:00', stop: '07/22/2026 11:00:20',
      direction: 'Incoming', caller: '12145551111', callee: '103', calleeName: 'A_Q_CSR' }),
    leg({ callId: '910001', legId: 2, start: '07/22/2026 11:00:20', connected: '07/22/2026 11:00:25',
      stop: '07/22/2026 11:04:00', direction: 'Outgoing', talk: '0:03:35', caller: '214',
      callee: '12145551111', answered: 'Answered', dept: 'CSR' }),
  ]);
  assert.equal(recs.length, 0);
});

test('internal-only groups (no external callee) produce no record', function () {
  const recs = build([
    leg({ callId: '920001', legId: 1, start: '07/22/2026 12:00:00', stop: '07/22/2026 12:01:00',
      direction: 'Outgoing', talk: '0:00:50', caller: '214', callee: '305',
      calleeName: 'Bob R', answered: 'Answered', dept: 'CSR' }),
  ]);
  assert.equal(recs.length, 0);
});

test('phone-shaped agent name is dropped (ext kept); journey masks the dialed number', function () {
  const recs = build([
    leg({ callId: '930001', legId: 1, start: '07/22/2026 13:00:00', connected: '07/22/2026 13:00:05',
      stop: '07/22/2026 13:01:00', direction: 'Outgoing', talk: '0:00:55', caller: '214',
      callerName: '+1 (214) 555-0100', callee: '12145550777', calleeName: '+1 214-555-0777',
      answered: 'Answered', dept: 'CSR' }),
  ]);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].agentName, null);
  assert.equal(recs[0].agentExt, '214');
  assert.ok(recs[0].journey.length >= 1);
  assert.equal(recs[0].journey[0].name, '(external number)');   // PHI mask, no raw number in Neon
});

test('re-dial legs in one group: attempts counted, first external callee identifies the call', function () {
  const recs = build([
    leg({ callId: '940001', legId: 1, start: '07/22/2026 14:00:00', stop: '07/22/2026 14:00:20',
      direction: 'Outgoing', caller: '214', callee: '12145550123', dept: 'CSR' }),
    leg({ callId: '940001', legId: 2, start: '07/22/2026 14:00:30', connected: '07/22/2026 14:00:36',
      stop: '07/22/2026 14:02:00', direction: 'Outgoing', talk: '0:01:24', caller: '214',
      callee: '12145550123', answered: 'Answered', dept: 'CSR' }),
  ]);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].attempts, 2);
  assert.equal(recs[0].connected, true);
  assert.equal(recs[0].talkSeconds, 84);
});

// ---- writer: authoritative replace + P-1 guard + hash inlining ---------------

function fakeConn(cap) {
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
const OB_ROWS = [
  leg({ callId: '900001', legId: 1, start: '07/22/2026 09:00:00', connected: '07/22/2026 09:00:12',
    stop: '07/22/2026 09:03:24', direction: 'Outgoing', talk: '0:03:12', caller: '214',
    callerName: 'Maria G', callee: '12145550123', answered: 'Answered', dept: 'CSR' }),
];

test('writer: authoritative DELETE precedes the upsert (same txn) + hash index DDL', function () {
  const cap = {};
  h.ctx.getReachableNeonConn_ = function () { return fakeConn(cap); };
  delete h.state.props.HMAC_SECRET;
  h.call('writeOutboundCallsToNeon', OB_ROWS, { authoritative: true, expectedDateIso: '2026-07-22' });
  assert.ok(cap.executed.some(s => /CREATE INDEX IF NOT EXISTS idx_outbound_calls_callee_hash/.test(s)),
    'hash index created idempotently (no operator console step)');
  const delIdx = cap.executed.findIndex(s => /DELETE FROM outbound_calls/.test(s));
  const insIdx = cap.executed.findIndex(s => /INSERT INTO outbound_calls/.test(s));
  assert.ok(delIdx >= 0 && insIdx > delIdx, 'DELETE precedes the INSERT');
  assert.match(cap.executed[delIdx], /call_date IN \('2026-07-22'::date\)/);
  assert.equal(cap.commits, 1, 'delete + insert are atomic');
  // No HMAC_SECRET -> NULL callee_hash written (heals on re-import).
  assert.match(cap.executed[insIdx], /'2026-07-22'::date,'900001',NULL/);
});

test('writer P-1: stray-dated records are dropped; DELETE pinned to the expected date', function () {
  const cap = {};
  h.ctx.getReachableNeonConn_ = function () { return fakeConn(cap); };
  const stray = leg({ callId: '888888', legId: 1, start: '07/21/2026 23:50:00',
    stop: '07/21/2026 23:51:00', direction: 'Outgoing', talk: '0:00:40', caller: '305',
    callee: '12145550001', answered: 'Answered', dept: 'Sales' });
  h.call('writeOutboundCallsToNeon', OB_ROWS.concat([stray]),
    { authoritative: true, expectedDateIso: '2026-07-22' });
  const dels = cap.executed.filter(s => /DELETE FROM outbound_calls/.test(s));
  assert.equal(dels.length, 1);
  assert.match(dels[0], /call_date IN \('2026-07-22'::date\)/, 'only the expected date is deleted');
  assert.ok(!dels[0].includes('2026-07-21'), 'the stray date is never deleted');
  const ins = cap.executed.filter(s => /INSERT INTO outbound_calls/.test(s)).join('');
  assert.ok(!ins.includes('888888'), 'the stray record is dropped, not written');
});

test('writer: non-authoritative is upsert-only; HMAC secret inlines the 64-hex hash', function () {
  const cap = {};
  h.ctx.getReachableNeonConn_ = function () { return fakeConn(cap); };
  h.state.props.HMAC_SECRET = 's';
  const HEX = 'ab'.repeat(32);
  h.ctx.cdrHashPhone_ = function (raw, secret) {
    assert.equal(raw, '+12145550123');
    assert.equal(secret, 's');
    return HEX;
  };
  h.call('writeOutboundCallsToNeon', OB_ROWS);
  assert.equal(cap.executed.filter(s => /DELETE FROM outbound_calls/.test(s)).length, 0);
  const ins = cap.executed.filter(s => /INSERT INTO outbound_calls/.test(s)).join('');
  assert.ok(ins.includes("'" + HEX + "'"), 'callee_hash inlined from cdrHashPhone_');
  assert.ok(ins.includes("'Maria G'"), 'agent name written');
  delete h.state.props.HMAC_SECRET;
  delete h.ctx.cdrHashPhone_;
});

test('writer: Neon unreachable -> clean skip status (never throws into the import)', function () {
  h.ctx.getReachableNeonConn_ = function () { return null; };
  const res = h.call('writeOutboundCallsToNeon', OB_ROWS, { authoritative: true, expectedDateIso: '2026-07-22' });
  assert.equal(res.inserted, 0);
  assert.ok(res.skipped > 0);
  assert.ok(!res.error);
});

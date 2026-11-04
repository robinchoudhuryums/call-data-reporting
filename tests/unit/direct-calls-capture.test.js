'use strict';

// AC-6 (owner 2026-11-04): the per-call DIRECT list behind the agent panel's
// Direct tab. cdr-import's computeDirectCallMetrics emits one record per
// direct call per agent from the SAME events its daily counts come from; the
// writer stores them in Neon direct_calls (an outside party as a hash only);
// the dashboard's agentDayDirect_ serves them, falling back to the outside
// callers in inbound_calls for dates before the capture. Admin-only.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadGas } = require('../harness/loadGas');

const imp = loadGas({ project: 'cdr-import', files: ['neonWrite.js', 'directCallMetrics.js'] });
const dash = loadGas({ files: ['Config.gs', 'Util.gs', 'OutboundReport.gs', 'AgentDay.gs'] });

const MAPS = {
  extToAgent: { '101': { name: 'Anna', dept: 'CSR' }, '102': { name: 'Bob', dept: 'Sales' } },
  queueExtSet: new Set(['103']), exclusions: new Set(['103']),
};
function row(o) {
  const r = new Array(26).fill('');
  r[0] = o.cid || ''; r[2] = o.start || ''; r[3] = o.connected || ''; r[4] = o.stop || '';
  r[5] = o.dir || ''; r[6] = o.talk || ''; r[7] = o.callTime || '';
  r[8] = o.caller || ''; r[9] = o.callerName != null ? o.callerName : ((MAPS.extToAgent[o.caller] || {}).name || '');
  r[10] = o.callee || ''; r[11] = o.calleeName != null ? o.calleeName : ((MAPS.extToAgent[o.callee] || {}).name || '');
  r[13] = o.ctx || ''; r[14] = o.parent || ''; r[22] = o.callerId || '';
  r[23] = o.missed ? 'Missed' : ''; r[25] = o.answered ? 'Answered' : '';
  return r;
}
const grid = (rows) => [new Array(26).fill('')].concat(rows);
const D = '03/09/2026 ';
const J = (x) => JSON.parse(JSON.stringify(x));

test('AC-6: the pass emits one record per direct call -- colleagues by name, an outside party only as a number for the writer', function () {
  const res = imp.fn('computeDirectCallMetrics')(grid([
    // Anna dials Bob (internal), Bob answers.
    row({ cid: 'I1', start: D + '09:00:00', dir: 'Internal', talk: '0:01:30', callTime: '0:01:40', caller: '101', callee: '102', answered: true }),
    // An outside caller rings Anna; she misses it (free).
    row({ cid: 'E1', start: D + '10:00:00', dir: 'Incoming', callTime: '0:00:25', caller: '+15551234567', callee: '101', calleeName: 'Anna', callerName: 'JOHN CUSTOMER', missed: true }),
    // After the 3 PM PST window: an outside call Anna answers.
    row({ cid: 'E2', start: D + '15:30:00', dir: 'Incoming', talk: '0:02:00', callTime: '0:02:05', caller: '+15557654321', callee: '101', answered: true }),
    // A queue call is never direct.
    row({ cid: 'Q1', start: D + '11:00:00', dir: 'Incoming', talk: '0:01:00', callTime: '0:01:00', caller: '+15550000000', callee: '101', ctx: 'CallQueue', answered: true }),
  ]), MAPS, { events: true });
  const ev = J(res.events);
  const anna = ev.filter((e) => e.agent === 'Anna');
  const bob = ev.filter((e) => e.agent === 'Bob');
  assert.deepEqual(anna.map((e) => [e.callId, e.direction, e.side, e.outcome, e.inWindow]),
    [['I1', 'out', 'int', 'connected', true], ['E1', 'in', 'ext', 'missed_free', true], ['E2', 'in', 'ext', 'answered', false]],
    'every direct call, all hours, flagged by the work window; the queue call is out');
  assert.equal(anna[0].otherName, 'Bob', 'a colleague is named from the roster');
  assert.equal(anna[1].otherName, null, 'an outside caller\'s CNAM name is never kept');
  assert.equal(anna[1].otherNumber, '+15551234567', 'the number rides along for the writer to hash');
  assert.equal(anna[1].ringSec, 25);
  assert.equal(anna[1].callStart, '10:00:00', 'raw PST, the call tables\' convention');
  assert.deepEqual(bob.map((e) => [e.callId, e.direction, e.otherName, e.outcome, e.talkSec]), [['I1', 'in', 'Anna', 'answered', 90]]);
  // The counts are unchanged by the option, and come from the same events.
  const plain = imp.fn('computeDirectCallMetrics')(grid([
    row({ cid: 'I1', start: D + '09:00:00', dir: 'Internal', talk: '0:01:30', callTime: '0:01:40', caller: '101', callee: '102', answered: true }),
  ]), MAPS, {});
  assert.equal(plain.events, undefined, 'no events unless asked -- the existing shape is untouched');
});

test('AC-6: the stored row holds a hash, never the number; one row per call per agent per direction', function () {
  const e = { callId: 'E1', agent: 'Anna', dept: 'CSR', direction: 'in', side: 'ext', callStart: '10:00:00', ringSec: 25, talkSec: 0,
    outcome: 'missed_free', inWindow: true, otherName: null, otherExt: null, otherNumber: '+15551234567' };
  const t = imp.call('dcEventTuple_', '2026-03-09', e, 'abc123hash');
  assert.match(t, /^\('2026-03-09'::date|^\(\$nq\$2026-03-09\$nq\$::date/);
  assert.ok(t.indexOf('abc123hash') !== -1);
  assert.ok(!/5551234567/.test(t), 'the phone number never reaches the SQL: ' + t);
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script', 'cdr-import', 'directCallMetrics.js'), 'utf8');
  assert.match(src, /ON CONFLICT \(call_date, call_id, agent_name, direction\) DO NOTHING/);
  assert.match(src, /DELETE FROM direct_calls WHERE call_date = \?::date/, 'each date is replaced whole');
  assert.match(src, /const ne = \(events !== undefined\) \? dcWriteEvents_\(conn, isoDate, events\) : null;\s*conn\.commit\(\);/,
    'the list is written in the SAME transaction as the day\'s counts');
});

test('AC-6: the dashboard list -- the capture from its first date, the outside callers before it, nothing when unreadable', function () {
  const cap = { available: true, directStart: '2026-11-01', direct: [
    { call_id: 'I1', direction: 'out', side: 'int', call_start: '09:00:00', ring_sec: null, talk_sec: 90, outcome: 'connected', in_window: true, other_name: 'Bob', other_ext: '102' },
    { call_id: 'E1', direction: 'in', side: 'ext', call_start: '10:00:00', ring_sec: 25, talk_sec: 0, outcome: 'missed_free', in_window: true, other_name: null, other_ext: null },
    { call_id: 'X1', direction: 'out', side: 'int', call_start: '11:00:00', ring_sec: null, talk_sec: 0, outcome: 'not_connected', in_window: false, other_name: null, other_ext: '455' },
  ], inbound: [] };
  let d = J(dash.call('agentDayDirect_', cap, 'Anna', '2026-11-03'));
  assert.equal(d.source, 'capture');
  assert.deepEqual(d.rows.map((r) => [r.callId, r.other, r.outcome, r.inWindow]),
    [['I1', 'Bob', 'connected', true], ['E1', 'Outside caller', 'missed_free', true], ['X1', 'Extension 455', 'not_connected', false]]);
  // A captured date with no direct calls is a real empty list.
  d = J(dash.call('agentDayDirect_', Object.assign({}, cap, { direct: [] }), 'Anna', '2026-11-03'));
  assert.equal(d.source, 'capture');
  assert.equal(d.rows.length, 0);
  // Before the capture began: the outside callers who rang her line first, from inbound_calls.
  const pre = { available: true, directStart: '2026-11-01', direct: [], inbound: [
    { call_id: 'A', call_start: '08:00:00', entry_queue: '', first_agent: 'Anna', disposition: 'answered', is_internal: false },
    { call_id: 'B', call_start: '08:30:00', entry_queue: 'A_Q_CSR', first_agent: 'Anna', disposition: 'missed', is_internal: false },
    { call_id: 'C', call_start: '09:00:00', entry_queue: null, first_agent: 'Anna', disposition: 'abandoned', is_internal: false },
    { call_id: 'D', call_start: '09:30:00', entry_queue: null, first_agent: 'Bob', disposition: 'missed', is_internal: false },
  ] };
  d = J(dash.call('agentDayDirect_', pre, 'Anna', '2026-10-20'));
  assert.equal(d.source, 'inbound');
  assert.deepEqual(d.rows.map((r) => [r.callId, r.other, r.outcome]), [['A', 'Outside caller', 'answered'], ['C', 'Outside caller', 'abandoned']],
    'queue calls and someone else\'s line are left out');
  // No table yet (cdr-import not deployed): same fallback.
  d = J(dash.call('agentDayDirect_', Object.assign({}, pre, { direct: null, directStart: null }), 'Anna', '2026-10-20'));
  assert.equal(d.source, 'inbound');
  // Neon unreadable: no source at all.
  d = J(dash.call('agentDayDirect_', { available: false, direct: null, inbound: [] }, 'Anna', '2026-10-20'));
  assert.equal(d.source, null);
  assert.equal(d.rows.length, 0);
});

test('AC-6: admin-only, the hash is never selected, and the client tab shows only when the server sent a source', function () {
  const gs = fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard', 'AgentDay.gs'), 'utf8');
  assert.match(gs, /var dir = isAdmin \? agentDayDirect_\(cap, scope\.agentName, scope\.date\)\s*: \{ rows: \[\], source: null/);
  const sel = gs.slice(gs.indexOf('FROM direct_calls WHERE') - 400, gs.indexOf('FROM direct_calls WHERE'));
  assert.ok(!/other_hash/.test(sel), 'the outside party\'s hash never leaves the database');
  const cl = fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard', 'script-10-escalations.html'), 'utf8');
  assert.match(cl, /const showDirect = !!meta\.directSource;/);
  assert.match(cl, /\(showDirect \? tabBtn\('direct', 'Direct calls', direct\.length\) : ''\)/);
});

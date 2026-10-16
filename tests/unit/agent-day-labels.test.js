'use strict';

// Step 2 1b (owner 2026-10-16): the agent panel's per-call lists say WHO was on
// the other end -- as LABELS only, because the capture stores no phone number
// and no outside name (docs/per-call-capture.md):
//   - inbound "From": the staff caller (internal calls), else the insurer the
//     number belongs to (ADMIN-ONLY for now -- the Inbound report's temporary
//     gate), else "outside" plus the company line it came in on;
//   - outbound "To": the colleague an internal dial reached, else the insurer
//     (admin), else outside -- and "unknown" when a row has no outside number
//     but no colleague either (a row that failed to hash must not read as an
//     internal call);
//   - the CALLBACK cue: the latest same-day inbound call from the number
//     dialled that came BEFORE the dial, among those the viewer may see.
// Load-bearing: a staff name prints ONLY when it is exactly a roster name, and
// the number hashes are compared in SQL and never selected.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

const FILES = ['Config.gs', 'Util.gs', 'OutboundReport.gs', 'AgentDay.gs'];
const J = (v) => JSON.parse(JSON.stringify(v));
const ROSTER = { 'Ann Agent': ['CSR'], 'Bea Buddy': ['Sales'], 'Cal Colleague': ['CSR', 'Sales'] };

const h = loadGas({ files: FILES });

test('inbound From: a roster colleague by name; anything else unnamed', () => {
  const ctx = { roster: ROSTER, depts: { CSR: true, Sales: true } };
  const from = (r) => J(h.ctx.agentDayInboundFrom_(r, ctx));
  assert.deepEqual(from({ is_internal: true, origin_agent: 'Bea Buddy', origin_dept: 'Sales' }),
    { kind: 'staff', name: 'Bea Buddy', dept: 'Sales' });
  assert.deepEqual(from({ is_internal: true, origin_agent: 'Not On Any Roster', origin_dept: 'Raw Org Label' }),
    { kind: 'staff', name: null, dept: null }, 'a non-roster name and an unknown dept never print');
});

test('inbound From: outside -> the insurer if known, and the named dial-in line', () => {
  const ctx = { dialLabels: { '18668646332': 'Main CSR Line' }, insurer: { c1: 'Acme Health' } };
  const from = (r) => J(h.ctx.agentDayInboundFrom_(r, ctx));
  assert.deepEqual(from({ call_id: 'c1', dial_in_number: '+1 (866) 864-6332' }),
    { kind: 'outside', insurer: 'Acme Health', line: 'Main CSR Line' });
  assert.deepEqual(from({ call_id: 'c2', dial_in_number: '8668646332' }),
    { kind: 'outside', insurer: null, line: 'Main CSR Line' }, 'a 10-digit number matches the 11-digit key');
  assert.deepEqual(from({ call_id: 'c3', dial_in_number: '5551234567' }),
    { kind: 'outside', insurer: null, line: null }, 'an unnamed line shows no number');
});

test('outbound To: a roster colleague from the path; masked outside legs never match; no number + no colleague = unknown', () => {
  const ctx = { roster: ROSTER, agentName: 'Ann Agent', insurer: { o9: 'Acme Health' } };
  const to = (r) => J(h.ctx.agentDayOutboundTo_(r, ctx));
  const path = (names) => JSON.stringify(names.map((n) => (n === 'Q' ? { kind: 'queue', name: 'A_Q_CSR' } : { name: n })));
  assert.deepEqual(to({ no_ext: true, journey: path(['Ann Agent', 'Q', 'Cal Colleague']) }),
    { kind: 'staff', name: 'Cal Colleague', dept: 'CSR' }, 'the dialler and queues are skipped');
  assert.deepEqual(to({ no_ext: true, journey: path(['Ann Agent', 'A.P.', '(external caller)', '(unknown)']) }),
    { kind: 'unknown' }, 'masked outside names are not roster names');
  assert.deepEqual(to({ no_ext: true, journey: 'not json' }), { kind: 'unknown' });
  assert.deepEqual(to({ call_id: 'o9', no_ext: false }), { kind: 'outside', insurer: 'Acme Health' });
  assert.deepEqual(to({ call_id: 'o8', no_ext: false }), { kind: 'outside', insurer: null });
});

test('callback: the latest EARLIER same-day inbound call the viewer may see', () => {
  const pick = (ob, m, ctx) => J(h.ctx.agentDayPickCallback_(ob, m, ctx));
  const m = [
    { ib: 'i1', ts: '08:10:00', d: 'abandoned', q: 'A_Q_CSR' },
    { ib: 'i2', ts: '09:45:00', d: 'answered', q: 'A_Q_Sales' },   // another dept's queue
    { ib: 'i3', ts: '11:00:00', d: 'answered', q: 'A_Q_CSR' },     // AFTER the dial
  ];
  const mgr = { inboundIds: {}, deptQueues: { a_q_csr: true }, isAdmin: false };
  assert.deepEqual(pick('10:30:00', m, mgr), { time: '08:10:00', disposition: 'abandoned', inboundCallId: null },
    'a manager skips the other dept\'s 09:45 call and never looks past the dial');
  assert.deepEqual(pick('10:30:00', m, { inboundIds: {}, deptQueues: {}, isAdmin: true }),
    { time: '09:45:00', disposition: 'answered', inboundCallId: null }, 'an admin sees any');
  assert.deepEqual(pick('10:30:00', m, { inboundIds: { i2: true }, deptQueues: {}, isAdmin: false }),
    { time: '09:45:00', disposition: 'answered', inboundCallId: 'i2' },
    'a call on the agent\'s own list counts, and carries its id so the client can point at it');
  assert.equal(h.ctx.agentDayPickCallback_('07:00:00', m, mgr), null, 'nothing earlier -> no cue');
  assert.equal(h.ctx.agentDayPickCallback_('', m, mgr), null);
});

// ── End to end through a fake Neon ─────────────────────────────────────────

function fakeConn(rec) {
  const route = function (sql) {
    if (/insurance_numbers/.test(sql) && /FROM inbound_calls c/.test(sql)) return [{ id: 'in-1', n: 'Acme Health' }];
    if (/insurance_numbers/.test(sql) && /FROM outbound_calls o/.test(sql)) return [{ id: 'ob-2', n: 'Acme Health' }];
    if (/JOIN inbound_calls c/.test(sql)) {
      return [{ ob: 'ob-1', ib: 'in-1', ts: '08:00:00', d: 'abandoned', q: 'A_Q_CSR' }];
    }
    if (/FROM inbound_calls WHERE/.test(sql)) {
      return [
        { call_id: 'in-1', call_start: '08:00:00', entry_queue: 'A_Q_CSR', disposition: 'answered', is_internal: false,
          first_agent: 'Ann Agent', journey: JSON.stringify([{ kind: 'agent', name: 'Ann Agent', talk: 30 }]),
          dial_in_number: '18668646332' },
        { call_id: 'in-2', call_start: '09:00:00', entry_queue: 'A_Q_CSR', disposition: 'answered', is_internal: true,
          first_agent: 'Ann Agent', journey: JSON.stringify([{ kind: 'agent', name: 'Ann Agent', talk: 20 }]),
          origin_agent: 'Bea Buddy', origin_dept: 'Sales' },
      ];
    }
    if (/FROM outbound_calls WHERE/.test(sql)) {
      return [
        { call_id: 'ob-1', call_start: '10:00:00', connected: true, talk_seconds: 60, ring_seconds: 9, attempts: 1, no_ext: false, journey: null },
        { call_id: 'ob-2', call_start: '11:00:00', connected: false, talk_seconds: 0, ring_seconds: 20, attempts: 1, no_ext: false, journey: null },
        { call_id: 'ob-3', call_start: '12:00:00', connected: true, talk_seconds: 40, ring_seconds: 3, attempts: 1, no_ext: true,
          journey: JSON.stringify([{ name: 'Ann Agent' }, { name: 'Cal Colleague' }]) },
      ];
    }
    return [];
  };
  return {
    prepareStatement: function (sql) {
      rec.sql.push(sql);
      return {
        setString: function () {},
        executeQuery: function () {
          const rows = route(sql); let done = false;
          return { next: function () { if (done) return false; done = true; return true; },
                   getString: function () { return JSON.stringify(rows); }, close: function () {} };
        },
        close: function () {},
      };
    },
    close: function () {},
  };
}

function fresh(user) {
  const f = loadGas({ files: FILES });
  f.ctx.isIsoDate_ = function (s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); };
  f.ctx.getAllDepartments_ = function () { return ['CSR', 'Sales']; };
  f.ctx.buildDeptsByAgent_ = function () { return ROSTER; };
  f.ctx.resolveUser_ = function () { return user; };
  f.ctx.assertAdmin_ = function () { if (user.role !== 'admin') throw new Error('Admin only.'); };
  f.ctx.assertDeptAccess_ = function (u, d) { if (u.role !== 'admin' && (u.departments || []).indexOf(d) === -1) throw new Error('Not authorized'); };
  f.ctx.agentDayFetchDalRows_ = function () { return []; };
  f.ctx.inboundDialInLabels_ = function () { return { '18668646332': 'Main CSR Line' }; };
  f.ctx.inboundQueuesForDept_ = function (d) { return d === 'CSR' ? ['A_Q_CSR'] : []; };
  f.ctx.logReportUsage_ = function () {};
  const rec = { sql: [] };
  f.ctx.getDashboardNeonConn_ = function () { return fakeConn(rec); };
  return { f: f, rec: rec };
}

test('end to end (admin): From / To labels, insurer names, the callback cue', () => {
  const { f, rec } = fresh({ email: 'a@x', role: 'admin', departments: ['CSR', 'Sales'] });
  const d = J(f.call('getAgentDay', { agentName: 'Ann Agent', date: '2026-10-15' }));
  const byId = (list, id) => list.filter((c) => c.callId === id)[0];
  assert.deepEqual(byId(d.inbound, 'in-1').from, { kind: 'outside', insurer: 'Acme Health', line: 'Main CSR Line' });
  assert.deepEqual(byId(d.inbound, 'in-2').from, { kind: 'staff', name: 'Bea Buddy', dept: 'Sales' });
  assert.deepEqual(byId(d.outbound, 'ob-1').callback, { time: '08:00:00', disposition: 'abandoned', inboundCallId: 'in-1' });
  assert.deepEqual(byId(d.outbound, 'ob-2').to, { kind: 'outside', insurer: 'Acme Health' });
  assert.equal(byId(d.outbound, 'ob-2').callback, null);
  assert.deepEqual(byId(d.outbound, 'ob-3').to, { kind: 'staff', name: 'Cal Colleague', dept: 'CSR' });
  // PHI: no statement SELECTS a hash -- they are only compared in SQL.
  rec.sql.forEach(function (sql) {
    const select = sql.slice(0, sql.search(/\bFROM\b/));
    assert.ok(!/caller_hash|callee_hash|phone_hash/.test(select.replace(/\(callee_hash IS NULL\) AS no_ext/, '')),
      'a hash is never selected: ' + sql.slice(0, 120));
  });
});

test('end to end (manager): no insurer read at all; the line label still shows', () => {
  const { f, rec } = fresh({ email: 'm@x', role: 'manager', department: 'CSR', departments: ['CSR'] });
  const d = J(f.call('getAgentDay', { agentName: 'Ann Agent', date: '2026-10-15' }));
  assert.ok(!rec.sql.some((s) => /insurance_numbers/.test(s)), 'the insurer join is not even run for a manager');
  const in1 = d.inbound.filter((c) => c.callId === 'in-1')[0];
  assert.deepEqual(in1.from, { kind: 'outside', insurer: null, line: 'Main CSR Line' });
  const ob2 = d.outbound.filter((c) => c.callId === 'ob-2')[0];
  assert.deepEqual(ob2.to, { kind: 'outside', insurer: null });
});

test('a failing label read costs the label, never the day', () => {
  const { f } = fresh({ email: 'a@x', role: 'admin', departments: ['CSR', 'Sales'] });
  const real = f.ctx.getDashboardNeonConn_;
  f.ctx.getDashboardNeonConn_ = function () {
    const c = real();
    const prep = c.prepareStatement;
    c.prepareStatement = function (sql) {
      if (/insurance_numbers|JOIN inbound_calls c/.test(sql)) throw new Error('relation "insurance_numbers" does not exist');
      return prep(sql);
    };
    return c;
  };
  const d = J(f.call('getAgentDay', { agentName: 'Ann Agent', date: '2026-10-15' }));
  assert.equal(d.meta.neonAvailable, true, 'the day still reads');
  assert.equal(d.inbound.length, 2);
  assert.equal(d.outbound.length, 3);
  assert.equal(d.outbound[0].callback, null);
  assert.equal(d.inbound[0].from.insurer, null);
});

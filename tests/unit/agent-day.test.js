'use strict';

// 6d: the agent-day interaction view (AgentDay.gs) — "what did agent X do on
// day Y?".
//
// Three things here are load-bearing and none of them is obvious from the
// payload shape, so they get the bulk of the pins:
//
//  1. THE HORIZON IS THREE TIERS, decided by WHAT CAME BACK. The owner's
//     original 14-day assumption was wrong (that is the Call_Legs REBUILD
//     horizon); journeys live ~90 days and per-call rows ~400. Past the
//     journey horizon the inbound side can only show calls the agent RANG
//     FIRST, and that is unrecoverable — so the tier must be reported
//     honestly rather than silently showing a short list.
//  2. THE `journey LIKE '%name%'` PRE-FILTER IS A SUPERSET. It is a cheap
//     index-free narrowing, not the match. One agent's name inside another's
//     (or inside a queue name) comes back too, and only the exact INV-04
//     check drops it. A row kept on a LIKE hit alone would put someone
//     else's call on this agent's page.
//  3. AUTH IS SERVER-DERIVED FROM THE ROSTER. The client sends a NAME; the
//     dept comes from buildDeptsByAgent_ and goes through the shared
//     assertDeptAccess_ gate. A crossover agent has several homes and ANY of
//     them entitles; an unrostered name has none and is admin-only, because
//     "no home → allow" would make the gate bypassable by misspelling.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

const h = loadGas({ files: ['Config.gs', 'Util.gs', 'AgentDay.gs'] });

// Objects built inside the vm have a different Object prototype, so strict
// deepEqual reports "same structure but not reference-equal". Round-trip
// through JSON to compare by VALUE, which is what these assertions mean.
const plain = function (v) { return JSON.parse(JSON.stringify(v)); };

function installStubs_() {
  h.ctx.isIsoDate_ = function (s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); };
  h.ctx.getAllDepartments_ = function () { return ['CSR', 'Sales', 'Power']; };
  h.ctx.buildDeptsByAgent_ = function () {
    return {
      'Ann Agent': ['CSR'],
      'Cross Over': ['CSR', 'Sales'],       // two roster homes
      'Sal Seller': ['Sales'],
    };
  };
  h.ctx.resolveUser_ = function () {
    return h.state.testUser || { email: 'a@x.com', role: 'admin', departments: ['CSR', 'Sales', 'Power'] };
  };
  h.ctx.assertAdmin_ = function () {
    const u = h.ctx.resolveUser_();
    if (!u || u.role !== 'admin') throw new Error('Admin only.');
  };
}
installStubs_();

// ── The tier rule ───────────────────────────────────────────────────────────

test('THE RULE: the tier is decided by what CAME BACK, not by the calendar', function () {
  const tier = h.ctx.agentDayTier_;
  assert.equal(tier(5, true, 2), 'full', 'a journey present is full fidelity, whatever the date');
  assert.equal(tier(5, false, 2), 'degraded', 'capture rows with no journey = first_agent only');
  assert.equal(tier(0, false, 3), 'degraded', 'outbound alone still beats having nothing');
  assert.equal(tier(0, false, 0), 'dqe-only', 'nothing captured -> the DQE slots are the whole story');
});

test('a 200-day-old day with journeys intact reports FULL, not a calendar-guessed degrade', function () {
  // The prune is flag-gated and its horizons are tunable, so a calendar-only
  // tier would apologise for a degrade that never happened.
  assert.equal(h.ctx.agentDayTier_(4, true, 0), 'full');
});

test('degradedReason separates the three reasons a day can be thin', function () {
  const r = h.ctx.agentDayDegradedReason_;
  assert.equal(r({ tier: 'full', ageDays: 500, journeyHorizonDays: 90, captureHorizonDays: 400 }, true),
    null, 'a full day never apologises');
  assert.equal(r({ tier: 'degraded', ageDays: 3, journeyHorizonDays: 90, captureHorizonDays: 400 }, false),
    'neon-down', 'an outage is temporary and must not read as permanent loss');
  assert.equal(r({ tier: 'dqe-only', ageDays: 500, journeyHorizonDays: 90, captureHorizonDays: 400 }, true),
    'before-capture');
  assert.equal(r({ tier: 'degraded', ageDays: 120, journeyHorizonDays: 90, captureHorizonDays: 400 }, true),
    'journey-pruned');
  assert.equal(r({ tier: 'degraded', ageDays: 2, journeyHorizonDays: 90, captureHorizonDays: 400 }, true),
    'not-captured', 'a recent thin day is a quiet day, not a retention problem');
});

test('age arithmetic is UTC, so a DST boundary cannot shift a horizon by a day', function () {
  const age = h.ctx.agentDayAgeDays_;
  assert.equal(age('2026-09-14', '2026-09-15'), 1);
  assert.equal(age('2026-03-01', '2026-03-31'), 30, 'spans the US DST change');
  assert.equal(age('2026-09-15', '2026-09-15'), 0);
  assert.equal(age('2026-09-16', '2026-09-15'), -1, 'a future date is negative, not clamped');
});

// ── Role attribution off the journey ────────────────────────────────────────

const J = function (evs) { return evs; };

test('THE RULE: an agent absent from the journey yields null, so a LIKE false positive is DROPPED', function () {
  // 'Ann Agent' is a substring of nothing here; the call rang ANOTHER agent
  // whose name merely contains it, which is exactly what LIKE returns.
  const role = h.ctx.agentDayInboundRole_(
    J([{ t: '09:00:00', name: 'Ann Agentson', kind: 'leg', missed: true }]), 'Ann Agent');
  assert.equal(role, null,
    'a substring match must not be read as this agent touching the call');
});

test('the strongest role wins when an agent appears on several legs of one call', function () {
  const r = h.ctx.agentDayInboundRole_(J([
    { t: '09:00:00', name: 'Ann Agent', kind: 'leg', missed: true, secs: 12 },
    { t: '09:01:00', name: 'Ann Agent', kind: 'leg', secs: 8 },
    { t: '09:02:00', name: 'Ann Agent', kind: 'answer', talk: 240, secs: 6 },
  ]), 'Ann Agent');
  assert.equal(r.role, 'answered', 'rang -> missed -> answered must read as answered');
  assert.equal(r.talkSec, 240);
});

test('a missed ring outranks a plain ring; a plain ring is the floor', function () {
  assert.equal(h.ctx.agentDayInboundRole_(J([
    { t: '09:00:00', name: 'Ann Agent', kind: 'leg', secs: 4 },
    { t: '09:01:00', name: 'Ann Agent', kind: 'leg', missed: true, secs: 20 },
  ]), 'Ann Agent').role, 'missed');
  assert.equal(h.ctx.agentDayInboundRole_(J([
    { t: '09:00:00', name: 'Ann Agent', kind: 'leg', secs: 4 },
  ]), 'Ann Agent').role, 'rang');
});

test('talk>0 counts as answered even when kind was not stamped "answer"', function () {
  const r = h.ctx.agentDayInboundRole_(J([
    { t: '09:00:00', name: 'Ann Agent', kind: 'leg', talk: 30 },
  ]), 'Ann Agent');
  assert.equal(r.role, 'answered');
});

test('a queue leg carrying the agent name is not a touch', function () {
  assert.equal(h.ctx.agentDayInboundRole_(J([
    { t: '09:00:00', name: 'A_Q_CSR', kind: 'queue' },
  ]), 'Ann Agent'), null);
  assert.equal(h.ctx.agentDayInboundRole_(null, 'Ann Agent'), null);
  assert.equal(h.ctx.agentDayInboundRole_([], 'Ann Agent'), null);
});

// ── Which rows survive the LIKE pre-filter ──────────────────────────────────

test('THE RULE: a LIKE false positive is DROPPED — it is another agent\u2019s call', function () {
  // No exact journey appearance AND someone else rang it first.
  assert.equal(h.ctx.agentDayKeepRow_(null, 'Ann Agentson', 'Ann Agent'), null);
  assert.equal(h.ctx.agentDayKeepRow_(null, null, 'Ann Agent'), null);
});

test('THE RULE: a journey-pruned day keeps the calls this agent RANG FIRST', function () {
  // This single arm IS the degraded tier. Without it every day past the
  // journey horizon renders EMPTY instead of as a disclosed subset -- which
  // reads as "this agent did nothing", the exact misread 6d exists to avoid.
  const kept = h.ctx.agentDayKeepRow_(null, 'Ann Agent', 'Ann Agent');
  assert.ok(kept, 'a first_agent match must survive a NULLed journey');
  assert.equal(kept.role, 'rang');
  assert.equal(kept.ringSec, null, 'a pruned journey carries no ring time — never guess one');
});

test('an exact journey role always wins over the first_agent fallback', function () {
  const role = { role: 'answered', ringSec: 5, talkSec: 200, order: 2 };
  assert.deepEqual(plain(h.ctx.agentDayKeepRow_(role, 'Someone Else', 'Ann Agent')), plain(role),
    'the journey is the better evidence whenever it exists');
});

// ── Counts + the reconciliation disclosure ──────────────────────────────────

test('counts fold the day by role, and outbound talk joins the talk total', function () {
  const c = h.ctx.agentDayCounts_(
    [{ role: 'answered', talkSec: 100 }, { role: 'missed' }, { role: 'rang' },
     { role: 'answered', talkSec: 50 }],
    [{ connected: true, talkSec: 20 }, { connected: false, talkSec: 0 }]);
  assert.deepEqual(plain(c), { inboundTotal: 4, answered: 2, missed: 1, rang: 1,
    outboundTotal: 2, outboundConnected: 1, talkSec: 170 });
});

test('THE RULE: a short list is DISCLOSED against the daily total, never silently served', function () {
  const rec = h.ctx.agentDayReconcile_;
  // Full tier and the numbers line up -> the page can say so.
  assert.deepEqual(plain(rec({ answered: 7 }, { answered: 7 }, 'full')),
    { checked: true, exact: true, note: null });
  // Full tier, numbers differ -> say why they can legitimately differ.
  const gap = rec({ answered: 5 }, { answered: 7 }, 'full');
  assert.equal(gap.exact, false);
  assert.match(gap.note, /work window/, 'the note must explain the gap, not just report it');
  // Degraded -> the list is a SUBSET by construction, and says so.
  const sub = rec({ answered: 2 }, { answered: 7 }, 'degraded');
  assert.equal(sub.exact, false);
  assert.match(sub.note, /SUBSET/);
  // No DQE row at all -> nothing to check against; claim nothing.
  assert.deepEqual(plain(rec({ answered: 2 }, null, 'full')),
    { checked: false, exact: false, note: null });
});

test('reconcile never claims exact on a degraded day, even when the numbers happen to match', function () {
  const r = h.ctx.agentDayReconcile_({ answered: 7 }, { answered: 7 }, 'degraded');
  assert.equal(r.exact, false,
    'a coincidental match on a subset is not agreement, and saying so would '
    + 'tell a manager the page is complete when it is not');
});

// ── Authorization ───────────────────────────────────────────────────────────

test('THE RULE: the dept is re-derived from the ROSTER, never taken from the client', function () {
  h.state.testUser = { email: 'm@x.com', role: 'manager', department: 'CSR', departments: ['CSR'] };
  // A client-supplied department is not even read.
  const s = h.call('agentDayResolve_',
    { agentName: 'Ann Agent', date: '2026-09-14', department: 'Sales' });
  assert.equal(s.dept, 'CSR');
  h.state.testUser = null;
});

test('a CROSSOVER agent is visible to a manager of ANY of their roster homes', function () {
  h.state.testUser = { email: 'm@x.com', role: 'manager', department: 'Sales', departments: ['Sales'] };
  const s = h.call('agentDayResolve_', { agentName: 'Cross Over', date: '2026-09-14' });
  assert.equal(s.dept, 'Sales', 'the home the manager owns is the one that resolves');
  assert.deepEqual(plain(s.homes), ['CSR', 'Sales'], 'both homes ship, so the client can disclose the crossover');
  h.state.testUser = null;
});

test('a manager owning NONE of the agent’s homes is refused with a real reason', function () {
  h.state.testUser = { email: 'p@x.com', role: 'manager', department: 'Power', departments: ['Power'] };
  assert.throws(function () {
    h.call('agentDayResolve_', { agentName: 'Ann Agent', date: '2026-09-14' });
  }, /Not authorized for this department/);
  h.state.testUser = null;
});

test('THE RULE: an UNROSTERED name is admin-only — no home must never mean "allow"', function () {
  h.state.testUser = { email: 'm@x.com', role: 'manager', department: 'CSR', departments: ['CSR'] };
  assert.throws(function () {
    h.call('agentDayResolve_', { agentName: 'Ghost Dialer', date: '2026-09-14' });
  }, /Admin only/);
  // The admin CAN see it, flagged as unrostered so the client can say so.
  h.state.testUser = { email: 'a@x.com', role: 'admin', departments: ['CSR'] };
  const s = h.call('agentDayResolve_', { agentName: 'Ghost Dialer', date: '2026-09-14' });
  assert.equal(s.unrostered, true);
  assert.equal(s.dept, null);
  h.state.testUser = null;
});

test('an all-depts manager reaches any agent; role none and agent are refused', function () {
  h.state.testUser = { email: 'all@x.com', role: 'manager', allDepts: true, departments: ['CSR', 'Sales', 'Power'] };
  assert.equal(h.call('agentDayResolve_', { agentName: 'Sal Seller', date: '2026-09-14' }).dept, 'Sales');
  // The Phase A allowlist: anything that is not admin|manager is out.
  ['none', 'agent'].forEach(function (role) {
    h.state.testUser = { email: 'x@x.com', role: role, departments: [] };
    assert.throws(function () {
      h.call('agentDayResolve_', { agentName: 'Ann Agent', date: '2026-09-14' });
    }, /Not authorized/, 'role ' + role + ' must not reach an agent-day');
  });
  h.state.testUser = null;
});

test('input validation runs before any lookup', function () {
  assert.throws(function () {
    h.call('agentDayResolve_', { agentName: '', date: '2026-09-14' });
  }, /agentName is required/);
  assert.throws(function () {
    h.call('agentDayResolve_', { agentName: 'Ann Agent', date: 'yesterday' });
  }, /YYYY-MM-DD/);
});

// ── Shaping + PHI ───────────────────────────────────────────────────────────

test('THE RULE: no shaped row carries a caller identity', function () {
  const row = h.ctx.agentDayShapeInbound_({
    call_id: 'ic-1', call_start: '09:00:00', entry_queue: 'A_Q_CSR',
    final_queue: 'A_Q_CSR', disposition: 'Answered', wait_seconds: 30,
    hold_seconds: 0, is_internal: false, num_transfers: 0,
    // Fields a caller-targeted shaper would carry — none may survive here.
    caller_hash: 'deadbeef', dial_in_number: '+15551234567',
  }, { role: 'answered', ringSec: 5, talkSec: 200 });
  const json = JSON.stringify(row);
  assert.ok(!/deadbeef/.test(json), 'a caller hash must never reach the client');
  assert.ok(!/5551234567/.test(json), 'a phone number must never reach the client');
  assert.equal(row.role, 'answered');
  assert.equal(row.talkSec, 200);
});

test('the outbound shaper defaults attempts to 1 and keeps a null ring null', function () {
  const r = h.ctx.agentDayShapeOutbound_({
    call_id: 'oc-1', call_start: '10:00:00', connected: true,
    talk_seconds: 90, ring_seconds: null,
  });
  assert.equal(r.attempts, 1, 'a dialled call is at least one attempt');
  assert.equal(r.ringSec, null, 'an unknown ring stays null, never 0 — 0 is a fact');
  assert.equal(r.connected, true);
});

// ── Source pins the shape alone cannot carry ────────────────────────────────

const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script',
  'department-dashboard', 'AgentDay.gs'), 'utf8');

test('the response is NOT cached — an agent-keyed payload stays out of the shared cache', function () {
  assert.ok(!/CacheService/.test(SRC),
    'getAgentDay must not cache: the Caller Lookup model. If this ever changes, '
    + 'the key must hash the agent name (INV-36) and carry the freshness tag.');
});

test('the Neon read is LABELLED for the egress ranking (EA-1)', function () {
  // Pin the GUARD too, not just the call: an earlier version of this pin
  // matched happily while the call sat behind `if (false)`.
  assert.match(SRC,
    /if \(typeof neonNoteEgress_ === 'function'\) neonNoteEgress_\(bytes, 'agentDay'\);/,
    'an unlabelled journey-bearing read folds into "other" and the Health '
    + 'gauge loses a whole surface');
});

test('the inbound query keeps BOTH the journey pre-filter and the first_agent arm', function () {
  assert.match(SRC, /journey LIKE \? OR first_agent = \?/,
    'dropping the first_agent arm would make every degraded (journey-pruned) '
    + 'day read as empty rather than as a subset');
  assert.match(SRC, /setString\(2, '%' \+ agentName \+ '%'\)/,
    'the agent name must be BOUND, never inlined into SQL');
});

test('the DQE half goes through the DAL, so DQE_READ_SOURCE is honored', function () {
  assert.match(SRC, /function agentDayFetchDalRows_/);
  assert.match(SRC, /neonFetchDqeRows_/);
  assert.match(SRC, /sheetFetchDqeRows_/);
  assert.match(SRC, /neonDqeRowsUsable_/,
    'the LM2 rule: a reachable-but-empty Neon read is trusted, not fallen back on');
});

'use strict';

// Agent role Phase B: getAgentHome (AgentHome.gs). Pins the identity rules
// (agents: always self, request can't rename them; admins: explicit preview;
// managers refused), the own-vs-team projection (INV-05 ATT reconciliation
// with the My Department table; INV-53 roster-only team figures via the
// computeSummary_ totals), the ordinal-only rank, the trend/missed detail
// extraction (INV-04 exact-name filter excludes INV-23 sentinels by
// construction; coerced slot cells recover or drop, never guess), and that
// the payload NEVER carries teammate identities.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

const h = loadGas({ files: ['Config.gs', 'Util.gs', 'AgentHome.gs'] });

function summaryFixture() {
  return {
    rows: [
      { agent: 'Maria Lopez', matchedViaRoster: true, totalRung: 160, totalMissed: 9,
        totalAnswered: 142, totalUnique: 120, attSeconds: 192, daysActive: 9 },
      { agent: 'Devon Park', matchedViaRoster: true, totalRung: 150, totalMissed: 20,
        totalAnswered: 120, totalUnique: 100, attSeconds: 185, daysActive: 9 },
      { agent: 'Idle Agent', matchedViaRoster: true, totalRung: 0, totalMissed: 0,
        totalAnswered: 0, totalUnique: 0, attSeconds: 0, daysActive: 0 },
      { agent: 'Floater One', matchedViaRoster: false, totalRung: 50, totalMissed: 1,
        totalAnswered: 49, totalUnique: 40, attSeconds: 100, daysActive: 3 },
    ],
    totals: { totalAnswered: 262, totalMissed: 29, totalRung: 310, attSeconds: 188, rosterAgentCount: 3 },
  };
}

function dalFixture() {
  return [
    { dateIso: '2026-08-12', agent: 'Maria Lopez', totalAnswered: 20, totalMissed: 2,
      slots: ['10:23:33,10:08:41', '', '12/30/1899 14:41:00', 'junk'] },
    { dateIso: '2026-08-13', agent: 'Maria Lopez', totalAnswered: 18, totalMissed: 0, slots: ['', ''] },
    { dateIso: '2026-08-13', agent: 'Devon Park', totalAnswered: 9, totalMissed: 5, slots: ['09:00:00'] },
    { dateIso: '2026-08-13', agent: 'A_Q_CSR', totalAnswered: 0, totalMissed: 4, slots: ['08:15:00'] },  // INV-23 sentinel
    { dateIso: '2026-07-01', agent: 'Maria Lopez', totalAnswered: 5, totalMissed: 5, slots: ['08:00:00'] }, // pre-window
  ];
}

function install(role, opts) {
  opts = opts || {};
  h.state.props = { SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' };
  h.state.userEmail = role === 'admin' ? 'admin@x.com' : 'agent1@x.com';
  if (h.state.cache && h.state.cache.clear) h.state.cache.clear();
  h.ctx.resolveUser_ = function () {
    if (role === 'agent') {
      return { email: 'agent1@x.com', role: 'agent', department: null, departments: [],
               allDepts: false, agentDept: 'CSR', agentName: 'Maria Lopez' };
    }
    if (role === 'admin') return { email: 'admin@x.com', role: 'admin', departments: ['CSR'] };
    if (role === 'manager') return { email: 'm@x.com', role: 'manager', department: 'CSR', departments: ['CSR'] };
    return { email: 'x@x.com', role: 'none', departments: [] };
  };
  h.ctx.getAllDepartments_ = function () { return ['CSR', 'Sales']; };
  h.ctx.isIsoDate_ = function (s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); };
  h.ctx.parseIsoNoon_ = function (iso) {
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  };
  h.ctx.hashAgents_ = function (list) { return 'h' + list.join('|').length; };
  h.ctx.logReportUsage_ = function () {};
  h.ctx.computeSummary_ = function (dept, from, to, scope) {
    h.state.summaryCalls = (h.state.summaryCalls || 0) + 1;
    assert.equal(scope, 'roster');
    return opts.summary || summaryFixture();
  };
  h.ctx.ahFetchDalRows_ = function () { return opts.dal || dalFixture(); };
}

// -- gates --------------------------------------------------------------------

test('agents are always themselves: a crafted request naming another agent is ignored', function () {
  install('agent');
  const d = h.call('getAgentHome', { from: '2026-08-01', to: '2026-08-13',
    department: 'Sales', agentName: 'Devon Park' });   // ignored for agents
  assert.equal(d.meta.department, 'CSR');
  assert.equal(d.meta.agentName, 'Maria Lopez');
});

test('managers and role-none are refused; admins need explicit preview params', function () {
  install('manager');
  assert.throws(function () { h.call('getAgentHome', { from: '2026-08-01', to: '2026-08-13' }); }, /Not authorized/);
  install('none');
  assert.throws(function () { h.call('getAgentHome', { from: '2026-08-01', to: '2026-08-13' }); }, /Not authorized/);
  install('admin');
  assert.throws(function () { h.call('getAgentHome', { from: '2026-08-01', to: '2026-08-13' }); }, /department and agentName/);
  const d = h.call('getAgentHome', { from: '2026-08-01', to: '2026-08-13',
    department: 'CSR', agentName: 'Devon Park' });
  assert.equal(d.meta.agentName, 'Devon Park');
  assert.throws(function () {
    h.call('getAgentHome', { from: '2026-08-01', to: '2026-08-13', department: 'Nope', agentName: 'X' });
  }, /Unknown department/);
});

// -- payload ------------------------------------------------------------------

test('own KPIs + team aggregates + ordinal rank; no teammate identities in the payload', function () {
  install('agent');
  const d = h.call('getAgentHome', { from: '2026-08-01', to: '2026-08-13' });
  assert.equal(d.me.answered, 142);
  assert.equal(d.me.missed, 9);
  assert.equal(d.me.answerRatePct, 94);
  assert.equal(d.me.attSeconds, 192, 'INV-05 simple mean — reconciles with the manager table row');
  assert.equal(d.team.answered, 262, 'roster-only totals (INV-53: floater excluded upstream)');
  assert.equal(d.team.rosterAgentCount, 3);
  assert.equal(d.team.activeAgents, 2, 'idle roster agent not counted active');
  assert.equal(d.team.answerRatePct, 90);
  assert.equal(d.rank.rank, 1);
  assert.equal(d.rank.of, 2, 'idle agent is unranked, never branded last');
  // The one relational element is the ordinal — no names beyond the caller's.
  const json = JSON.stringify(d);
  assert.ok(json.indexOf('Devon Park') === -1, 'no teammate names in the payload');
  assert.ok(json.indexOf('Floater One') === -1);
});

test('trend covers the 30-day window; missed detail covers the selected window; sentinels and others excluded', function () {
  install('agent');
  const d = h.call('getAgentHome', { from: '2026-08-10', to: '2026-08-13' });
  assert.equal(d.meta.trendFrom, '2026-07-15');
  assert.deepEqual(JSON.parse(JSON.stringify(d.trend.map(function (p) { return p.date; }))),
    ['2026-08-12', '2026-08-13'], 'own rows only, pre-trend-window row excluded');
  assert.equal(d.trend[0].ratePct, 90.9);
  // Missed detail: own rows in [from..to]; coerced "12/30/1899 14:41:00"
  // recovers its trailing time; 'junk' drops; times sort chronologically.
  // Phase C shape: entries carry {t, ring, wait} -- with no Neon conn in
  // this install the join is unavailable, so ring/wait are null and
  // meta.waitsAvailable is false (bare timestamps, never guessed).
  assert.equal(d.missedDays.length, 1);
  assert.equal(d.missedDays[0].date, '2026-08-12');
  assert.deepEqual(JSON.parse(JSON.stringify(d.missedDays[0].entries)), [
    { t: '10:08:41', ring: null, wait: null },
    { t: '10:23:33', ring: null, wait: null },
    { t: '14:41:00', ring: null, wait: null },
  ]);
  assert.equal(d.missedTotal, 3);
  assert.equal(d.meta.waitsAvailable, false);
});

test('Phase C: wait join decorates matching rings (PST journey +2h -> CST slots); unmatched stay bare', function () {
  install('agent');
  // Fake Neon conn: two calls. Call A's journey holds Maria's missed ring at
  // 08:08:41 PST (= 10:08:41 CST, matching the first slot time), ring 12s,
  // call started 08:07:11 PST -> wait 90s. Call B's ring at 12:41:00 PST
  // matches the coercion-recovered 14:41:00 slot.
  const recs = [
    { d: '2026-08-12', call_start: '08:07:11',
      journey: JSON.stringify([
        { t: '08:08:41', name: 'Maria Lopez', kind: 'leg', missed: true, secs: 12 },
        { t: '08:09:00', name: 'Someone Else', kind: 'leg', missed: true, secs: 5 },
      ]) },
    { d: '2026-08-12', call_start: '08:20:00',
      journey: JSON.stringify([
        { t: '12:41:00', name: 'Maria Lopez', kind: 'leg', missed: true, secs: 8 },
      ]) },
  ];
  h.ctx.getDashboardNeonConn_ = function () {
    return {
      prepareStatement: function () {
        return {
          setString: function () {},
          executeQuery: function () {
            let done = false;
            return {
              next: function () { if (done) return false; done = true; return true; },
              getString: function () { return JSON.stringify(recs); },
              close: function () {},
            };
          },
          close: function () {},
        };
      },
      close: function () {},
    };
  };
  const d = h.call('getAgentHome', { from: '2026-08-10', to: '2026-08-13' });
  assert.equal(d.meta.waitsAvailable, true);
  const entries = JSON.parse(JSON.stringify(d.missedDays[0].entries));
  assert.deepEqual(entries[0], { t: '10:08:41', ring: 12, wait: 90 }, 'matched ring decorated');
  assert.deepEqual(entries[1], { t: '10:23:33', ring: null, wait: null }, 'no matching journey -> bare timestamp');
  assert.deepEqual(entries[2], { t: '14:41:00', ring: 8, wait: 15660 }, 'second call ring matched (elapsed-from-pickup semantics)');
});

// -- Phase C: My History ------------------------------------------------------

function histDal() {
  return [
    { dateIso: '2026-07-03', agent: 'Maria Lopez', totalAnswered: 10, totalMissed: 2, attSec: 180 },
    { dateIso: '2026-07-10', agent: 'Maria Lopez', totalAnswered: 30, totalMissed: 0, attSec: 120 },
    { dateIso: '2026-07-10', agent: 'Devon Park', totalAnswered: 8, totalMissed: 8, attSec: 200 },
    { dateIso: '2026-08-01', agent: 'Maria Lopez', totalAnswered: 4, totalMissed: 1, attSec: 100 },
    { dateIso: '2026-08-01', agent: 'A_Q_CSR', totalAnswered: 0, totalMissed: 9, attSec: 0 },   // sentinel: not on roster
  ];
}

test('Phase C: agentHistoryBlob_/OwnView_ — monthly rollup, INV-25 weighted ATT, team from roster only, best-month floor', function () {
  install('agent');
  const months = h.call('agentHistoryBlob_', histDal(), ['Maria Lopez', 'Devon Park']);
  const view = JSON.parse(JSON.stringify(h.call('agentHistoryOwnView_', months, 'Maria Lopez')));
  assert.equal(view.length, 2);
  const jul = view[0], aug = view[1];
  assert.equal(jul.month, '2026-07');
  assert.equal(jul.me.answered, 40);
  assert.equal(jul.me.ratePct, 95.2);
  // INV-25 weighted: (180*10 + 120*30) / 40 = 135 — NOT the simple mean 150.
  assert.equal(jul.me.attWeightedSeconds, 135);
  // Team July includes Devon (roster), excludes the sentinel: (40+8)/(48+10).
  assert.equal(jul.team.ratePct, 82.8);
  assert.equal(jul.best, true, 'July clears the 10-call floor and has the best rate');
  assert.equal(aug.me.answered, 4);
  assert.ok(!aug.best, 'August (5 calls) is under the best-month floor');
  assert.equal(aug.prevDeltaPts, Math.round((80 - 95.2) * 10) / 10);
});

test('Phase C: getAgentHistory — INV-29 window, cached per dept, no teammate identities in the payload', function () {
  install('agent');
  h.ctx.getLatestDataDate = function () { return '2026-08-13'; };
  h.ctx.getRosterForDepartment_ = function () { return { names: ['Maria Lopez', 'Devon Park'] }; };
  h.state.histCalls = 0;
  h.ctx.ahFetchDalRows_ = function (from, to, opts) {
    h.state.histCalls++;
    assert.equal(opts, null, 'history fetch carries no missed detail');
    assert.equal(from, '2025-08-01', 'INV-29: 12 months back, snapped to the 1st');
    assert.equal(to, '2026-08-13');
    return histDal();
  };
  const d = h.call('getAgentHistory', {});
  assert.equal(d.meta.department, 'CSR');
  assert.equal(d.meta.from, '2025-08-01');
  assert.equal(d.months.length, 2);
  assert.ok(JSON.stringify(d).indexOf('Devon Park') === -1, 'no teammate identity in the payload');
  h.call('getAgentHistory', {});
  assert.equal(h.state.histCalls, 1, 'second call served from the dept cache');
});

test('zero-activity agent: hasData false, null rate, unranked — never an error', function () {
  install('agent', { summary: {
    rows: [{ agent: 'Someone Else', matchedViaRoster: true, totalRung: 5, totalMissed: 1,
             totalAnswered: 4, totalUnique: 4, attSeconds: 60, daysActive: 1 }],
    totals: { totalAnswered: 4, totalMissed: 1, totalRung: 5, attSeconds: 60, rosterAgentCount: 1 },
  }, dal: [] });
  const d = h.call('getAgentHome', { from: '2026-08-01', to: '2026-08-13' });
  assert.equal(d.me.hasData, false);
  assert.equal(d.me.answered, 0);
  assert.equal(d.me.answerRatePct, null);
  assert.equal(d.rank, null);
  assert.equal(d.missedTotal, 0);
  assert.ok(JSON.stringify(d).indexOf('Someone Else') === -1, 'still no teammate identity');
});

test('team blob is computed once per (dept, window) and shared across callers (cache)', function () {
  install('agent');
  h.state.summaryCalls = 0;
  h.call('getAgentHome', { from: '2026-08-01', to: '2026-08-13' });
  h.call('getAgentHome', { from: '2026-08-01', to: '2026-08-13' });
  assert.equal(h.state.summaryCalls, 1, 'second call served from the team cache');
});

test('input validation: bad dates throw', function () {
  install('agent');
  assert.throws(function () { h.call('getAgentHome', { from: 'nope', to: '2026-08-13' }); }, /YYYY-MM-DD/);
  assert.throws(function () { h.call('getAgentHome', { from: '2026-08-14', to: '2026-08-13' }); }, /on or before/);
});

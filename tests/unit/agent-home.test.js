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
  assert.equal(d.missedDays.length, 1);
  assert.equal(d.missedDays[0].date, '2026-08-12');
  assert.deepEqual(JSON.parse(JSON.stringify(d.missedDays[0].times)),
    ['10:08:41', '10:23:33', '14:41:00']);
  assert.equal(d.missedTotal, 3);
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

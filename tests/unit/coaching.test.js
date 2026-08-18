'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// Coaching / turnover-suggestion engine, Phase 1 (dark). The pure gates are
// the point here: absolute rate floor AND behind-team gap AND missed-volume,
// over computeSummary_-shaped rows; TEAM_AVG_EXCLUDES out of both the team
// aggregate and candidacy. previewCoachingFlags is exercised with stubbed
// computeSummary_ / dept / holiday plumbing (its own compute is pinned by the
// dept-summary suite).

const h = loadGas({ files: ['Config.gs', 'Util.gs', 'Coaching.gs'] });

function row(agent, answered, missed, opts) {
  opts = opts || {};
  return {
    agent: agent,
    matchedViaRoster: opts.roster !== false,
    totalAnswered: answered,
    totalMissed: missed,
    totalRung: answered + missed,
  };
}

test('coaching: all three gates must hold — a qualifying agent is flagged with rate/team/gap detail', function () {
  // Team (excluding Low): Anna 180/20 + Bob 170/30 => 350/400 = 87.5%.
  // With Low: (350+30)/(400+70) — but Low is a candidate, not excluded, so the
  // team aggregate INCLUDES Low: (180+170+30)/(200+200+70) = 380/470 = 80.85%.
  const rows = [row('Anna', 180, 20), row('Bob', 170, 30), row('Low', 30, 40)];
  const flags = h.call('computeCoachingFlags_', rows, []);
  assert.equal(flags.length, 1);
  const f = flags[0];
  assert.equal(f.agent, 'Low');
  assert.equal(f.ratePct, 42.9, '30/70');
  assert.equal(f.teamRatePct, 80.9, 'team aggregate includes the candidate');
  assert.equal(f.gapPts, 38, 'gap behind team');
  assert.equal(f.missed, 40);
});

test('coaching: the volume gate blocks a low-rate agent under the missed floor', function () {
  // 5/15 = 25% answered — terrible, but only 15 missed rings (< 20).
  const rows = [row('Anna', 180, 20), row('Quiet', 5, 15)];
  assert.equal(h.call('computeCoachingFlags_', rows, []).length, 0);
});

test('coaching: the absolute gate blocks an agent at/above 50% even when behind the team', function () {
  // 55% answered, team ~90% — behind, but above the absolute floor.
  const rows = [row('Anna', 900, 100), row('Mid', 55, 45)];
  assert.equal(h.call('computeCoachingFlags_', rows, []).length, 0);
});

test('coaching: the relative gate blocks a struggling agent on a struggling team', function () {
  // Everyone ~45% — Low is not 5 pts behind the team, so no flag (team
  // problem, not a person problem).
  const rows = [row('A', 45, 55), row('B', 46, 54), row('C', 44, 56)];
  assert.equal(h.call('computeCoachingFlags_', rows, []).length, 0);
});

test('coaching: TEAM_AVG_EXCLUDES leaves both the team aggregate and candidacy', function () {
  // Manager Robin has awful numbers; excluded, so (a) he is never flagged and
  // (b) the team rate is computed without him — which is what pushes Low over
  // the relative gate.
  const rows = [row('Anna', 180, 20), row('Robin Choudhury', 5, 95), row('Low', 30, 40)];
  const withEx = h.call('computeCoachingFlags_', rows, ['Robin Choudhury']);
  assert.deepEqual(Array.from(withEx.map(function (f) { return f.agent; })), ['Low']);
  const without = h.call('computeCoachingFlags_', rows, []);
  assert.ok(without.some(function (f) { return f.agent === 'Robin Choudhury'; }),
    'un-excluded, the manager row would be flagged — the exclusion is doing the work');
});

test('coaching: non-roster rows and zero-activity rows are ignored', function () {
  const rows = [row('Floater', 10, 60, { roster: false }), row('Idle', 0, 0), row('Anna', 180, 20)];
  assert.equal(h.call('computeCoachingFlags_', rows, []).length, 0);
});

test('coaching: window walks back over weekends and holidays', function () {
  // 2026-07-20 is a Monday. 10 working days back with 2026-07-10 (Fri) a
  // holiday: to=07-20, then 07-17..13 (5), 07-10 skipped (holiday), 07-09..07
  // (3), 07-06 (Mon) = 10th.
  const win = h.call('coachingWindowFromLatest_', '2026-07-20', 10, function (iso) {
    return iso === '2026-07-10';
  });
  assert.equal(win.to, '2026-07-20');
  assert.equal(win.from, '2026-07-06');
  // A Sunday latest steps back to Friday first.
  const win2 = h.call('coachingWindowFromLatest_', '2026-07-19', 5, function () { return false; });
  assert.equal(win2.to, '2026-07-17');
  assert.equal(win2.from, '2026-07-13');
});

test('coaching: previewCoachingFlags is admin-gated, scans every dept best-effort, stamps dept on each flag', function () {
  h.state.userEmail = 'admin@x.com';
  h.state.props = { SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' };
  // Auth.gs isn't loaded — stub the resolver assertAdmin_ leans on.
  h.ctx.resolveUser_ = function () {
    return { email: h.state.userEmail, role: h.state.userEmail === 'admin@x.com' ? 'admin' : 'none' };
  };
  h.ctx.getLatestDataDate = function () { return '2026-07-20'; };
  h.ctx.getAllDepartments_ = function () { return ['CSR', 'Sales', 'Broken']; };
  h.ctx.getTeamAvgExcludes_ = function () { return []; };
  h.ctx.computeSummary_ = function (dept) {
    if (dept === 'Broken') throw new Error('boom');
    if (dept === 'CSR') return { rows: [row('Anna', 180, 20), row('Low', 30, 40)] };
    return { rows: [row('Sane', 90, 10)] };
  };
  const out = h.call('previewCoachingFlags');
  assert.equal(out.available, true);
  assert.deepEqual(JSON.parse(JSON.stringify(out.window)), { from: '2026-07-07', to: '2026-07-20' },
    '10 business days back from Mon 07-20, no holidays configured');
  assert.equal(out.flags.length, 1);
  assert.equal(out.flags[0].dept, 'CSR');
  assert.equal(out.flags[0].agent, 'Low');
  assert.equal(out.errors.length, 1, 'a throwing dept records an error, not a dead scan');
  assert.equal(out.errors[0].dept, 'Broken');
  assert.equal(out.thresholds.minMissed, 20);

  h.state.userEmail = 'stranger@x.com';
  assert.throws(function () { h.call('previewCoachingFlags'); }, /admin/i);
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// CE-1 (owner 2026-10-09): the callback figures count contact EPISODES.
// docs/next-steps.md "Callback episodes + direct lines" carries the rulings;
// this suite pins the ONE engine both sources share (obCallbackEpisodes_) and
// its summaries, rule by rule:
//   * an episode = one caller trying to reach one TEAM; attempts join while it
//     is open and within the window of the previous attempt;
//   * it closes on an own-team dial (the team's family: itself, its parent, its
//     children) or the caller getting through on a family queue -- a dial from
//     another team does NOT close it;
//   * outcome precedence own > gotThrough > other > pending > none, the five
//     partitioning the episodes;
//   * a dial that closes its own team's episode is CONSUMED -- never "another
//     team" for the caller's other open episodes (ruling 5);
//   * delay runs from the FIRST attempt.

const h = loadGas({ files: ['Config.gs', 'Util.gs', 'InboundReport.gs', 'OutboundReport.gs'] });

// Teams: CSR (queue a_q_csr), Sales (a_q_sales) with sub-queue PAP (a_q_pap),
// and an unmapped queue a_q_mystery.
const OWNERS = { a_q_csr: ['CSR'], a_q_sales: ['Sales'], a_q_pap: ['PAP'] };
const PARENT = { PAP: 'Sales' };
const CHILDREN = { Sales: ['PAP'], CSR: [], PAP: [] };
const ROSTER = { Cara: ['CSR'], Sam: ['Sales'], Pat: ['PAP'], Bill: ['Billing'] };

function ctx(over) {
  return Object.assign({
    from: '2026-09-01', to: '2026-09-30', todayIso: '2026-10-09', windowDays: 3,
    ownersOf: OWNERS, parentOf: PARENT, childrenOf: CHILDREN,
    homesOf: function (a) { return ROSTER[a] || []; },
  }, over || {});
}
const ab = (k, d, t, q, id) => [k, d, t, q, id || ('ab-' + k + '-' + d + '-' + t)];
const ob = (k, d, t, agent, connected, id) => [k, d, t, id || ('ob-' + k + '-' + d + '-' + t), agent, !!connected];
const ans = (k, d, t, q) => [k, d, t, q];
function run(ev, over) {
  return JSON.parse(JSON.stringify(h.ctx.obCallbackEpisodes_(
    { ab: ev.ab || [], ob: ev.ob || [], ans: ev.ans || [] }, ctx(over))));
}

test('one abandon + an own-team dial = one episode called back by own team, timed from the attempt', function () {
  const eps = run({ ab: [ab(1, '2026-09-10', '08:00:00', 'a_q_csr')],
                    ob: [ob(1, '2026-09-10', '08:30:00', 'Cara', true)] });
  assert.equal(eps.length, 1);
  assert.equal(eps[0].outcome, 'own');
  assert.equal(eps[0].delaySec, 1800);
  assert.equal(eps[0].connected, true);
  assert.equal(eps[0].agent, 'Cara');
  assert.equal(eps[0].teamKey, 'CSR');
});

test('five rapid attempts and one callback are ONE episode, not five failures', function () {
  const eps = run({
    ab: ['08:00:00', '08:02:00', '08:04:00', '08:06:00', '08:08:00']
      .map((t) => ab(1, '2026-09-10', t, 'a_q_csr')),
    ob: [ob(1, '2026-09-10', '09:00:00', 'Cara', false)],
  });
  assert.equal(eps.length, 1);
  assert.equal(eps[0].attempts.length, 5);
  assert.equal(eps[0].outcome, 'own', 'an unconnected own dial still closes it -- the agent did their part');
  assert.equal(eps[0].delaySec, 3600, 'from the FIRST attempt, the customer’s actual wait');
});

test('called back Monday, unanswered again Wednesday = two episodes; the second needs its own callback', function () {
  const eps = run({
    ab: [ab(1, '2026-09-14', '08:00:00', 'a_q_csr'), ab(1, '2026-09-16', '10:00:00', 'a_q_csr')],
    ob: [ob(1, '2026-09-14', '09:00:00', 'Cara', true)],
  });
  assert.deepEqual(eps.map((e) => e.outcome), ['own', 'none']);
});

test('phone tag: each round the agent dials is its own called-back episode', function () {
  const eps = run({
    ab: [ab(1, '2026-09-14', '08:00:00', 'a_q_csr'), ab(1, '2026-09-14', '11:00:00', 'a_q_csr')],
    ob: [ob(1, '2026-09-14', '09:00:00', 'Cara', false), ob(1, '2026-09-14', '12:00:00', 'Cara', false)],
  });
  assert.deepEqual(eps.map((e) => e.outcome), ['own', 'own']);
  assert.deepEqual(eps.map((e) => e.connected), [false, false], 'phone tag shows as a low connected rate');
});

test('another team’s dial does NOT close the episode; a later own dial still wins', function () {
  const eps = run({
    ab: [ab(1, '2026-09-10', '08:00:00', 'a_q_csr'), ab(1, '2026-09-10', '10:00:00', 'a_q_csr')],
    ob: [ob(1, '2026-09-10', '09:00:00', 'Bill', true), ob(1, '2026-09-11', '09:00:00', 'Cara', true)],
  });
  assert.equal(eps.length, 1, 'the 10:00 attempt joined: Bill’s dial did not close the episode');
  assert.equal(eps[0].attempts.length, 2);
  assert.equal(eps[0].outcome, 'own');
  assert.equal(eps[0].agent, 'Cara');
});

test('only another team dialed -> "other", carrying that first dial', function () {
  const eps = run({ ab: [ab(1, '2026-09-10', '08:00:00', 'a_q_csr')],
                    ob: [ob(1, '2026-09-10', '09:00:00', 'Bill', true), ob(1, '2026-09-10', '10:00:00', 'Bill', false)] });
  assert.equal(eps[0].outcome, 'other');
  assert.equal(eps[0].delaySec, 3600);
  assert.equal(eps[0].agent, 'Bill');
  assert.equal(eps[0].connected, true);
});

test('got through: an answered call on a FAMILY queue closes it; another team’s queue does not', function () {
  const eps = run({
    ab: [ab(1, '2026-09-10', '08:00:00', 'a_q_csr'), ab(2, '2026-09-10', '08:00:00', 'a_q_csr')],
    ans: [ans(1, '2026-09-10', '09:00:00', 'a_q_csr'), ans(2, '2026-09-10', '09:00:00', 'a_q_sales')],
    ob: [ob(1, '2026-09-10', '10:00:00', 'Bill', true)],
  });
  const by = {}; eps.forEach((e) => { by[e.k] = e; });
  assert.equal(by[1].outcome, 'gotThrough', 'got through before anyone dialed');
  assert.equal(by[1].delaySec, 3600);
  assert.equal(by[2].outcome, 'none', 'reaching Sales is not reaching CSR');
});

test('own beats got-through beats other (the precedence)', function () {
  // Bill (other) dials first, then the caller gets through -> gotThrough.
  const a = run({ ab: [ab(1, '2026-09-10', '08:00:00', 'a_q_csr')],
                  ob: [ob(1, '2026-09-10', '08:30:00', 'Bill', true)],
                  ans: [ans(1, '2026-09-10', '09:00:00', 'a_q_csr')] });
  assert.equal(a[0].outcome, 'gotThrough');
  // An own dial before the caller gets through -> own.
  const b = run({ ab: [ab(1, '2026-09-10', '08:00:00', 'a_q_csr')],
                  ob: [ob(1, '2026-09-10', '08:30:00', 'Cara', true)],
                  ans: [ans(1, '2026-09-10', '09:00:00', 'a_q_csr')] });
  assert.equal(b[0].outcome, 'own');
});

test('ruling 5: a dial that closes its OWN team’s episode is consumed, never "another team" elsewhere', function () {
  const eps = run({
    ab: [ab(1, '2026-09-10', '08:00:00', 'a_q_csr'), ab(1, '2026-09-10', '08:05:00', 'a_q_sales')],
    ob: [ob(1, '2026-09-10', '09:00:00', 'Sam', true)],
  });
  const by = {}; eps.forEach((e) => { by[e.teamKey] = e; });
  assert.equal(by.Sales.outcome, 'own');
  assert.equal(by.CSR.outcome, 'none', 'Sam called about the Sales episode, not CSR’s');
});

test('without an open episode of its own, a team’s dial DOES count as another team', function () {
  const eps = run({ ab: [ab(1, '2026-09-10', '08:00:00', 'a_q_csr')],
                    ob: [ob(1, '2026-09-10', '09:00:00', 'Sam', true)] });
  assert.equal(eps[0].outcome, 'other');
});

test('family: a parent’s agent closes a sub-queue episode, and a sub-queue agent the parent’s', function () {
  const eps = run({
    ab: [ab(1, '2026-09-10', '08:00:00', 'a_q_pap'), ab(2, '2026-09-10', '08:00:00', 'a_q_sales')],
    ob: [ob(1, '2026-09-10', '09:00:00', 'Sam', true), ob(2, '2026-09-10', '09:00:00', 'Pat', true)],
  });
  assert.deepEqual(eps.map((e) => e.outcome), ['own', 'own']);
  assert.equal(eps.find((e) => e.k === 1).teamKey, 'PAP');
});

test('the window is INCLUSIVE of the attempt date + N, and runs from the LAST attempt', function () {
  const inc = run({ ab: [ab(1, '2026-09-10', '08:00:00', 'a_q_csr')],
                    ob: [ob(1, '2026-09-13', '16:00:00', 'Cara', true)] });
  assert.equal(inc[0].outcome, 'own', 'day + 3 still counts (the old lateral’s <= rule)');
  const late = run({ ab: [ab(1, '2026-09-10', '08:00:00', 'a_q_csr')],
                     ob: [ob(1, '2026-09-14', '08:00:00', 'Cara', true)] });
  assert.equal(late[0].outcome, 'none', 'day + 4 is past the window');
  const ext = run({ ab: [ab(1, '2026-09-10', '08:00:00', 'a_q_csr'), ab(1, '2026-09-13', '08:00:00', 'a_q_csr')],
                    ob: [ob(1, '2026-09-15', '08:00:00', 'Cara', true)] });
  assert.equal(ext.length, 1, 'the day-3 attempt joined');
  assert.equal(ext[0].outcome, 'own', 'the window re-anchors on the last attempt');
  const split = run({ ab: [ab(1, '2026-09-10', '08:00:00', 'a_q_csr'), ab(1, '2026-09-14', '08:00:00', 'a_q_csr')] });
  assert.equal(split.length, 2, 'an attempt past the window opens a new episode');
});

test('a dial BEFORE the abandon never counts; one in the same second does', function () {
  const before = run({ ab: [ab(1, '2026-09-10', '08:00:00', 'a_q_csr')],
                       ob: [ob(1, '2026-09-10', '07:59:59', 'Cara', true)] });
  assert.equal(before[0].outcome, 'none');
  const same = run({ ab: [ab(1, '2026-09-10', '08:00:00', 'a_q_csr')],
                     ob: [ob(1, '2026-09-10', '08:00:00', 'Cara', true)] });
  assert.equal(same[0].outcome, 'own');
  assert.equal(same[0].delaySec, 0);
});

test('pending: still inside the window as of the script-TZ today; past it, none', function () {
  const eps = run({ ab: [ab(1, '2026-09-29', '08:00:00', 'a_q_csr'), ab(2, '2026-09-25', '08:00:00', 'a_q_csr')] },
    { todayIso: '2026-10-02' });
  const by = {}; eps.forEach((e) => { by[e.k] = e; });
  assert.equal(by[1].outcome, 'pending', '09-29 + 3 = 10-02 >= today: still inside (PCR-3 inclusive)');
  assert.equal(by[2].outcome, 'none');
});

test('an unmapped queue is its own team: nobody is "own", so any dial is another team', function () {
  const eps = run({ ab: [ab(1, '2026-09-10', '08:00:00', 'a_q_mystery')],
                    ob: [ob(1, '2026-09-10', '09:00:00', 'Cara', true)] });
  assert.equal(eps[0].teamKey, '');
  assert.equal(eps[0].outcome, 'other');
});

test('episodes START in the window: an attempt outside [from, to] is not an episode', function () {
  const eps = run({ ab: [ab(1, '2026-08-31', '08:00:00', 'a_q_csr'), ab(2, '2026-09-01', '08:00:00', 'a_q_csr')] });
  assert.deepEqual(eps.map((e) => e.k), [2]);
});

test('the five outcomes PARTITION the episodes and every rate divides by episodes', function () {
  const ev = { ab: [], ob: [], ans: [] };
  // own, other, gotThrough, pending, none -- two of each.
  for (let i = 0; i < 2; i++) {
    ev.ab.push(ab(10 + i, '2026-09-10', '08:00:00', 'a_q_csr')); ev.ob.push(ob(10 + i, '2026-09-10', '09:00:00', 'Cara', i === 0));
    ev.ab.push(ab(20 + i, '2026-09-10', '08:00:00', 'a_q_csr')); ev.ob.push(ob(20 + i, '2026-09-10', '09:00:00', 'Bill', true));
    ev.ab.push(ab(30 + i, '2026-09-10', '08:00:00', 'a_q_csr')); ev.ans.push(ans(30 + i, '2026-09-10', '09:00:00', 'a_q_csr'));
    ev.ab.push(ab(40 + i, '2026-09-29', '08:00:00', 'a_q_csr'));
    ev.ab.push(ab(50 + i, '2026-09-10', '08:00:00', 'a_q_csr'));
  }
  ev.ab.push(ab(10, '2026-09-10', '08:05:00', 'a_q_csr'));   // a repeat attempt inside an episode
  const eps = h.ctx.obCallbackEpisodes_(ev, ctx({ todayIso: '2026-10-01' }));
  const s = JSON.parse(JSON.stringify(h.ctx.obSummarizeEpisodes_(eps, true)));
  assert.equal(s.episodes, 10);
  assert.equal(s.attempts, 11);
  assert.equal(s.repeatEpisodes, 1);
  assert.equal(s.own + s.gotThrough + s.other + s.pending + s.none, s.episodes);
  assert.deepEqual([s.own, s.other, s.gotThrough, s.pending, s.none], [2, 2, 2, 2, 2]);
  assert.equal(s.ownPct, 20);
  assert.equal(s.ownConnected, 1);
  assert.equal(s.ownConnectedPct, 10);
  assert.equal(s.otherConnected, 2);
  assert.equal(s.medianCallbackSec, 3600, 'own-team delays only');
  assert.equal(s.delayBuckets.h1, 2, 'buckets count own-team callbacks');
  assert.equal(Object.keys(s.delayBuckets).reduce((a, k) => a + s.delayBuckets[k], 0), s.own);
});

test('no episodes -> null rates, never NaN', function () {
  const s = JSON.parse(JSON.stringify(h.ctx.obSummarizeEpisodes_([], true)));
  assert.equal(s.episodes, 0);
  assert.equal(s.ownPct, null);
  assert.equal(s.medianCallbackSec, null);
});

test('counts: abandonedTotal keeps its raw meaning; phone-menu + direct-line hang-ups are counted apart', function () {
  const rows = [
    { w: 'cur', kind: 'queue', anon: false, q: 'a_q_csr', n: 10 },
    { w: 'cur', kind: 'queue', anon: true, q: 'a_q_csr', n: 2 },
    { w: 'cur', kind: 'menu', anon: false, q: '', n: 30 },
    { w: 'cur', kind: 'menu', anon: true, q: '', n: 5 },
    { w: 'cur', kind: 'direct', anon: false, q: '', n: 7 },
    { w: 'pri', kind: 'queue', anon: false, q: 'a_q_csr', n: 99 },
  ];
  const c = JSON.parse(JSON.stringify(h.ctx.obEpCounts_(rows, 'cur')));
  assert.equal(c.abandonedTotal, 54, 'every abandon in the scope -- the Inbound report parity');
  assert.equal(c.abandonedAnonymous, 7);
  assert.equal(c.queueAbandons, 12);
  assert.equal(c.queueAnonymous, 2);
  assert.equal(c.abandonedTracked, 10);
  assert.equal(c.phoneMenuAbandons, 35);
  assert.equal(c.directLineAbandons, 7);
});

test('series: per FIRST-attempt day and hour, own over episodes', function () {
  const eps = h.ctx.obCallbackEpisodes_({
    ab: [ab(1, '2026-09-10', '08:00:00', 'a_q_csr'), ab(2, '2026-09-10', '08:30:00', 'a_q_csr'),
         ab(3, '2026-09-11', null, 'a_q_csr')],
    ob: [ob(1, '2026-09-10', '09:00:00', 'Cara', true), ob(2, '2026-09-10', '09:00:00', 'Bill', true)],
  }, ctx());
  const s = JSON.parse(JSON.stringify(h.ctx.obEpSeries_(eps)));
  assert.deepEqual(s.daily, [
    { date: '2026-09-10', episodes: 2, own: 1, other: 1, ratePct: 50 },
    { date: '2026-09-11', episodes: 1, own: 0, other: 0, ratePct: 0 },
  ]);
  assert.deepEqual(s.byHour, [{ hour: 8, episodes: 2, own: 1, ratePct: 50 }],
    'no start time -> no hour axis, but it still counts per day');
});

test('per-dept table: parent rows include sub-queues, the total counts each episode once, the headline skips unmapped', function () {
  const eps = h.ctx.obCallbackEpisodes_({
    ab: [ab(1, '2026-09-10', '08:00:00', 'a_q_sales'), ab(2, '2026-09-10', '08:00:00', 'a_q_pap'),
         ab(3, '2026-09-10', '08:00:00', 'a_q_csr'), ab(4, '2026-09-10', '08:00:00', 'a_q_mystery')],
    ob: [ob(1, '2026-09-10', '09:00:00', 'Sam', true), ob(2, '2026-09-10', '09:00:00', 'Pat', false),
         ob(3, '2026-09-10', '09:00:00', 'Bill', true), ob(4, '2026-09-10', '09:00:00', 'Ghost', false)],
  }, ctx());
  const counts = [
    { w: 'cur', kind: 'queue', anon: false, q: 'a_q_sales', n: 1 },
    { w: 'cur', kind: 'queue', anon: false, q: 'a_q_pap', n: 1 },
    { w: 'cur', kind: 'queue', anon: true, q: 'a_q_pap', n: 3 },
    { w: 'cur', kind: 'queue', anon: false, q: 'a_q_csr', n: 1 },
    { w: 'cur', kind: 'queue', anon: false, q: 'a_q_mystery', n: 1 },
    { w: 'cur', kind: 'menu', anon: false, q: '', n: 40 },
  ];
  const t = JSON.parse(JSON.stringify(h.ctx.obEpByDept_(eps, counts, ctx(), ROSTER)));
  const by = {}; t.rows.forEach((r) => { by[r.dept] = r; });
  assert.deepEqual(t.rows.map((r) => r.dept), ['CSR', 'PAP', 'Sales', 'Not mapped to a department'],
    'unmapped last');
  assert.equal(by.Sales.episodes, 2, 'the parent holds its sub-queue’s episode');
  assert.equal(by.PAP.episodes, 1);
  assert.equal(by.PAP.parent, 'Sales');
  assert.equal(by.PAP.abandonedAnonymous, 3);
  assert.equal(by.Sales.abandonedAnonymous, 3, 'the parent includes its sub-queue’s anonymous abandons');
  assert.equal(by.CSR.other, 1);
  assert.deepEqual(by.CSR.byCaller, [{ label: 'Billing', kind: 'other', calledBack: 1, connected: 1 }]);
  assert.deepEqual(by['Not mapped to a department'].byCaller,
    [{ label: 'Unrostered', kind: 'other', calledBack: 1, connected: 0 }]);
  assert.equal(by['Not mapped to a department'].tallies.unrostered, 1);
  assert.equal(t.total.episodes, 4, 'each episode ONCE -- never the sum of rows (5)');
  assert.equal(t.total.own, 2);
  assert.equal(t.total.mappedEpisodes, 3);
  assert.equal(t.total.mappedOwnPct, 66.7, 'no team can own a callback on a queue mapped to none');
  assert.equal(t.total.phoneMenuAbandons, 40);
  assert.deepEqual(t.unmappedQueues, [{ queue: 'a_q_mystery', tracked: 1, total: 1 }]);
});

test('a queue mapped to two depts lands in BOTH rows and once in the total', function () {
  const owners = Object.assign({}, OWNERS, { a_q_shared: ['CSR', 'Sales'] });
  const c = ctx({ ownersOf: owners });
  const eps = h.ctx.obCallbackEpisodes_({ ab: [ab(1, '2026-09-10', '08:00:00', 'a_q_shared')],
                                         ob: [ob(1, '2026-09-10', '09:00:00', 'Cara', true)] }, c);
  assert.equal(eps[0].teamKey, 'CSR+Sales');
  assert.equal(eps[0].outcome, 'own', 'a dialer from either owner is own');
  const t = JSON.parse(JSON.stringify(h.ctx.obEpByDept_(eps, [], c, ROSTER)));
  assert.deepEqual(t.rows.map((r) => [r.dept, r.episodes]), [['CSR', 1], ['Sales', 1]]);
  assert.equal(t.total.episodes, 1);
});

test('the engine output carries no caller identity beyond the per-request integer key', function () {
  const eps = run({ ab: [ab(7, '2026-09-10', '08:00:00', 'a_q_csr', 'call-1')] });
  assert.deepEqual(Object.keys(eps[0]).sort(),
    ['agent', 'attempts', 'connected', 'delaySec', 'firstHms', 'firstIso', 'k', 'outcome', 'teamKey', 'teams']);
  assert.deepEqual(eps[0].attempts, [{ iso: '2026-09-10', hms: '08:00:00', id: 'call-1', q: 'a_q_csr' }]);
});

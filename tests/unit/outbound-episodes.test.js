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
    ['agent', 'attempts', 'connected', 'delaySec', 'dial', 'firstHms', 'firstIso', 'k', 'outcome', 'teamKey', 'teams']);
  assert.deepEqual(eps[0].attempts, [{ iso: '2026-09-10', hms: '08:00:00', id: 'call-1', q: 'a_q_csr' }]);
});

// ── CE-2: the deciding dial and the late tags ───────────────────────────────

test('CE-2: the DECIDING dial is recorded for own and other; none / got-through carry none', function () {
  const eps = run({
    ab: [ab(1, '2026-09-10', '08:00:00', 'a_q_csr'), ab(2, '2026-09-10', '08:00:00', 'a_q_csr'),
         ab(3, '2026-09-10', '08:00:00', 'a_q_csr'), ab(4, '2026-09-10', '08:00:00', 'a_q_csr')],
    ob: [ob(1, '2026-09-10', '09:00:00', 'Bill', true, 'b1'), ob(1, '2026-09-11', '09:00:00', 'Cara', false, 'c1'),
         ob(2, '2026-09-10', '10:00:00', 'Bill', true, 'b2')],
    ans: [ans(3, '2026-09-10', '09:30:00', 'a_q_csr')],
  });
  const by = {}; eps.forEach((e) => { by[e.k] = e; });
  assert.deepEqual(by[1].dial, { iso: '2026-09-11', hms: '09:00:00', id: 'c1' },
    'the own dial decided it, not Bill’s earlier one');
  assert.deepEqual(by[2].dial, { iso: '2026-09-10', hms: '10:00:00', id: 'b2' }, 'the first other-team dial');
  assert.equal(by[3].dial, null, 'got through: no dial decided it');
  assert.equal(by[4].dial, null);
});

test('CE-2: events read PAST the window never move an outcome', function () {
  const eps = run({ ab: [ab(1, '2026-09-10', '08:00:00', 'a_q_csr')],
                    ob: [ob(1, '2026-09-20', '09:00:00', 'Cara', true)],
                    ans: [ans(1, '2026-09-18', '09:00:00', 'a_q_csr')] });
  assert.equal(eps[0].outcome, 'none');
});

test('CE-2 late tags: the first dial and the first got-through AFTER the deadline, within the horizon', function () {
  const ev = { ab: [ab(1, '2026-09-10', '08:00:00', 'a_q_csr'), ab(1, '2026-09-11', '08:00:00', 'a_q_csr')],
    ob: [ob(1, '2026-09-14', '23:59:00', 'Cara', true),    // = last attempt + 3: inside the window
         ob(1, '2026-09-16', '10:00:00', 'Bill', false),   // day 5 after the last attempt: late, another team
         ob(1, '2026-09-17', '10:00:00', 'Cara', true)],
    ans: [ans(1, '2026-09-18', '09:00:00', 'a_q_sales'),  // another team's queue: not "got through"
          ans(1, '2026-09-19', '09:00:00', 'a_q_csr')] };
  const c = ctx();
  // Engine first: the in-window own dial decides it -- tags are for `none` only,
  // so test the helper on a hand-shaped none episode with the same attempts.
  const ep = { k: 1, teams: ['CSR'], attempts: [{ iso: '2026-09-10' }, { iso: '2026-09-11' }] };
  const tags = JSON.parse(JSON.stringify(h.ctx.obEpLateTags_(ep, ev, c, 14)));
  assert.deepEqual(tags.calledBack, { iso: '2026-09-16', hms: '10:00:00', daysAfter: 5, team: 'other', agent: 'Bill' },
    'the first dial PAST the deadline (09-14), counted from the last attempt');
  assert.deepEqual(tags.gotThrough, { iso: '2026-09-19', hms: '09:00:00', daysAfter: 8 },
    'only a family queue counts as getting through');
});

test('CE-2 late tags: nothing past the horizon, and an own-team late dial is labelled own', function () {
  const ep = { k: 1, teams: ['PAP'], attempts: [{ iso: '2026-09-10' }] };
  const far = JSON.parse(JSON.stringify(h.ctx.obEpLateTags_(ep,
    { ob: [ob(1, '2026-09-28', '09:00:00', 'Sam', true)], ans: [] }, ctx(), 14)));
  assert.equal(far.calledBack, null, '09-13 deadline + 14 = 09-27: 09-28 is past the horizon');
  const near = JSON.parse(JSON.stringify(h.ctx.obEpLateTags_(ep,
    { ob: [ob(1, '2026-09-20', '09:00:00', 'Sam', true)], ans: [] }, ctx(), 14)));
  assert.equal(near.calledBack.team, 'own', 'Sam is on the parent’s roster: the family rule');
  const other = JSON.parse(JSON.stringify(h.ctx.obEpLateTags_({ k: 2, teams: ['PAP'], attempts: [{ iso: '2026-09-10' }] },
    { ob: [ob(1, '2026-09-20', '09:00:00', 'Sam', true)], ans: [] }, ctx(), 14)));
  assert.equal(other.calledBack, null, 'another caller’s dial is never this caller’s tag');
});

// ── CE-3: direct lines ──────────────────────────────────────────────────────
// A person's-line attempt carries its OWN team (the line owner's homes) and
// owner; an answered call to a person's line reaches that person's team.

const dab = (k, d, t, owner, id) => {
  const homes = ROSTER[owner] || (owner === 'Sales Voicemails' ? ['Sales'] : []);
  return [k, d, t, '', id || ('d-' + k + '-' + d + '-' + t), homes, owner];
};

test('CE-3: a direct attempt takes its team from the line owner, and records whose line it rang', function () {
  const eps = run({ ab: [dab(1, '2026-09-10', '08:00:00', 'Cara'), dab(1, '2026-09-10', '09:00:00', 'Cara')],
                    ob: [ob(1, '2026-09-10', '10:00:00', 'Cara', true)] });
  assert.equal(eps.length, 1);
  assert.equal(eps[0].teamKey, 'CSR');
  assert.deepEqual(eps[0].attempts.map((a) => a.owner), ['Cara', 'Cara']);
  assert.equal(eps[0].outcome, 'own');
});

test('CE-3: an ANSWERED call to a family person’s line is "got through"; to another team’s person it is not', function () {
  const eps = run({ ab: [dab(1, '2026-09-10', '08:00:00', 'Cara'), dab(2, '2026-09-10', '08:00:00', 'Cara')],
                    ans: [[1, '2026-09-10', '09:00:00', '', 'Cara'], [2, '2026-09-10', '09:00:00', '', 'Sam']] });
  const by = {}; eps.forEach((e) => { by[e.k] = e; });
  assert.equal(by[1].outcome, 'gotThrough');
  assert.equal(by[2].outcome, 'none', 'reaching Sales is not reaching CSR');
  // ...and a queue answer still counts for a direct episode of the same team.
  const q = run({ ab: [dab(1, '2026-09-10', '08:00:00', 'Cara')], ans: [ans(1, '2026-09-10', '09:00:00', 'a_q_csr')] });
  assert.equal(q[0].outcome, 'gotThrough');
});

test('CE-3: queue attempts are untouched -- no owner key, team from the queue', function () {
  const eps = run({ ab: [ab(1, '2026-09-10', '08:00:00', 'a_q_csr')] });
  assert.equal(eps[0].teamKey, 'CSR');
  assert.ok(!('owner' in eps[0].attempts[0]));
});

test('CE-3: the shared Sales voicemail box belongs to Sales, case-insensitively; anyone else on no roster to no team', function () {
  const homesOf = h.ctx.obDirectHomesOf_({ Cara: ['CSR'] });
  assert.deepEqual(JSON.parse(JSON.stringify(homesOf('Sales Voicemails'))), ['Sales']);
  assert.deepEqual(JSON.parse(JSON.stringify(homesOf('sales voicemails'))), ['Sales']);
  assert.deepEqual(JSON.parse(JSON.stringify(homesOf('Cara'))), ['CSR']);
  assert.deepEqual(JSON.parse(JSON.stringify(homesOf('Stranger'))), []);
  assert.equal(h.ctx.obDirectIsVoicemailLine_('Sales Voicemails'), true);
  assert.equal(h.ctx.obDirectIsVoicemailLine_('Cara'), false);
});

test('CE-3: after hours = a weekend, a company holiday, or a start outside the 06:30-15:00 PST window', function () {
  const realHol = h.ctx.isCompanyHoliday_;
  h.ctx.isCompanyHoliday_ = function (iso) { return iso === '2026-09-07'; };
  try {
    assert.equal(h.ctx.obDirectIsAfterHours_('2026-09-08', '10:00:00'), false, 'a Tuesday mid-morning');
    assert.equal(h.ctx.obDirectIsAfterHours_('2026-09-08', '06:29:59'), true, 'before the window');
    assert.equal(h.ctx.obDirectIsAfterHours_('2026-09-08', '06:30:00'), false);
    assert.equal(h.ctx.obDirectIsAfterHours_('2026-09-08', '15:00:00'), true, 'the window end is exclusive');
    assert.equal(h.ctx.obDirectIsAfterHours_('2026-09-12', '10:00:00'), true, 'a Saturday');
    assert.equal(h.ctx.obDirectIsAfterHours_('2026-09-07', '10:00:00'), true, 'a company holiday');
    assert.equal(h.ctx.obDirectIsAfterHours_('2026-09-08', null), false, 'no start: work hours (the window-clause convention)');
  } finally { h.ctx.isCompanyHoliday_ = realHol; }
});

test('CE-3: the direct summary splits own-team callbacks into "by the person" and "by their team"', function () {
  const eps = h.ctx.obCallbackEpisodes_({
    ab: [dab(1, '2026-09-10', '08:00:00', 'Cara'), dab(2, '2026-09-10', '08:00:00', 'Cara'),
         dab(3, '2026-09-10', '08:00:00', 'Cara')],
    ob: [ob(1, '2026-09-10', '09:00:00', 'Cara', true), ob(2, '2026-09-10', '09:00:00', 'Dana', false)],
  }, ctx({ homesOf: function (a) { return Object.assign({ Dana: ['CSR'] }, ROSTER)[a] || []; } }));
  const s = JSON.parse(JSON.stringify(h.ctx.obDirectSummary_(eps)));
  assert.deepEqual([s.episodes, s.own, s.ownByPerson, s.ownByTeam, s.none], [3, 2, 1, 1, 1]);
  assert.equal(s.ownByPersonPct, 33.3);
  assert.equal(s.ownByPerson + s.ownByTeam, s.own);
});

test('CE-3: the counts split missed / abandoned, anonymous, the voicemail box and lines on no roster', function () {
  const c = JSON.parse(JSON.stringify(h.ctx.obDirectCounts_([
    { disp: 'missed', anon: false, who: 'Cara', n: 10 },
    { disp: 'abandoned', anon: false, who: 'Cara', n: 4 },
    { disp: 'missed', anon: true, who: 'Cara', n: 2 },
    { disp: 'missed', anon: false, who: 'Sales Voicemails', n: 5 },
    { disp: 'abandoned', anon: false, who: 'Stranger', n: 1 },
  ], h.ctx.obDirectHomesOf_({ Cara: ['CSR'] }))));
  assert.deepEqual(c, { calls: 22, anonymous: 2, trackable: 20, missed: 17, abandoned: 5, voicemailBox: 5, unownedLines: 1, misdials: 0 });
});

test('FO-1: a ring under 8 s is a misdial -- counted, not trackable; an unknown ring is not a misdial', function () {
  assert.equal(h.ctx.obDirectIsMisdial_(7), true);
  assert.equal(h.ctx.obDirectIsMisdial_('0'), true);
  assert.equal(h.ctx.obDirectIsMisdial_(8), false, 'the boundary is strict: 8 s is a real ring');
  [null, undefined, '', ' ', 'x'].forEach(function (v) {
    assert.equal(h.ctx.obDirectIsMisdial_(v), false, 'unknown stays in the rate: ' + JSON.stringify(v));
  });
  const c = JSON.parse(JSON.stringify(h.ctx.obDirectCounts_([
    { disp: 'missed', anon: false, who: 'Cara', mis: false, n: 10 },
    { disp: 'abandoned', anon: false, who: 'Cara', mis: true, n: 4 },
    { disp: 'abandoned', anon: true, who: 'Cara', mis: true, n: 1 },
  ], h.ctx.obDirectHomesOf_({ Cara: ['CSR'] }))));
  assert.deepEqual([c.calls, c.misdials, c.anonymous, c.trackable], [15, 5, 1, 10],
    'misdials stay in the call total, leave the trackable population');
});

test('FO-2: obShiftHms_ adds hours and wraps at midnight like the SQL interval', function () {
  assert.equal(h.ctx.obShiftHms_('10:00:00', 2), '12:00:00');
  assert.equal(h.ctx.obShiftHms_('23:30:05', 2), '01:30:05');
  assert.equal(h.ctx.obShiftHms_('9:05:00', 2), '11:05:00');
  assert.equal(h.ctx.obShiftHms_('', 2), '');
});

test('CE-3: a dept view’s line owners are its (and its sub-queues’) roster plus its shared lines', function () {
  const names = JSON.parse(JSON.stringify(h.ctx.obDirectScopeNames_(['Sales', 'PAP'],
    { Sam: ['Sales'], Pat: ['PAP'], Cara: ['CSR'], Casey: ['CSR', 'Sales'] })));
  assert.deepEqual(names, ['Casey', 'Pat', 'Sales Voicemails', 'Sam']);
  assert.deepEqual(JSON.parse(JSON.stringify(h.ctx.obDirectScopeNames_(['CSR'], { Cara: ['CSR'] }))), ['Cara']);
});

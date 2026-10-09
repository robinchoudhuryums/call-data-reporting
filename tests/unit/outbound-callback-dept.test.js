'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// CB-1 (2026-09-28), rebuilt on CE-1's contact EPISODES (owner 2026-10-09):
// the per-dept callback table on the Outbound report's COMPANY view. Pins:
//   (1) the partition own + gotThrough + other + pending + none === episodes,
//       on every row AND the total row -- the property a grouping bug breaks;
//   (2) the rulings: an own-team dial closes an episode (the team's family --
//       itself, its parent, its children), a same-second tie is broken by
//       call_id, a parent's row includes its children's episodes, a
//       double-mapped queue (M2) lands in both rows, an unmapped queue gets
//       its own row and stays OUT of the headline, the total counts each
//       episode once, a hang-up that reached no queue is counted apart;
//   (3) the named tallies (multi-roster, unrostered, no agent);
//   (4) ENTRY-QUEUE-ONLY attribution for abandons -- the on-hold arm of the
//       inbound dept predicate can never fire for this population;
//   (5) source parity: the Neon path (event rows HAND-DERIVED from the
//       fixture with the SQL's clauses) and the sheet fallback agree.

const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'NeonCoverage.gs',
          'InboundReport.gs', 'OutboundReport.gs'],
});

const FROM = '2026-08-10', TO = '2026-08-11';
const D = '2026-08-10';

// Outbound: [date, callId, calleeHash, agent, ext, dept, connected,
//            talkSec, ringSec, attempts, callStart, journey]
const OB_ROWS = [
  [D, 'o1', 'h1', 'Ann', '101', '', 'TRUE', 60, 5, 1, '09:00:00', ''],
  [D, 'o2', 'h2', 'Bob', '201', '', 'FALSE', 0, 9, 1, '08:30:00', ''],
  [D, 'o3', 'h4', 'Sofia', '301', '', 'TRUE', 40, 5, 1, '08:40:00', ''],
  [D, 'o4', 'h5', 'Ann', '101', '', 'FALSE', 0, 9, 1, '08:35:00', ''],
  [D, 'o5', 'h6', 'Casey', '401', '', 'TRUE', 30, 5, 1, '09:10:00', ''],
  [D, 'o6', 'h7', 'Ghost', '999', '', 'FALSE', 0, 9, 1, '10:00:00', ''],
  [D, 'o7', 'h8', '', '', '', 'TRUE', 20, 5, 1, '09:45:00', ''],
  // A same-second tie on h10: Bob's row comes FIRST in the grid, but o11 < o20
  // so Ann's dial is the "first" callback on both paths.
  [D, 'o20', 'h10', 'Bob', '201', '', 'TRUE', 50, 5, 1, '10:30:00', ''],
  [D, 'o11', 'h10', 'Ann', '101', '', 'FALSE', 0, 9, 1, '10:30:00', ''],
];
let ibSeq = 0;
function ibRow(hash, entryQueue, callStart, opts) {
  opts = opts || {};
  const r = new Array(17).fill('');
  r[0] = D; r[1] = 'ib' + (++ibSeq); r[3] = hash; r[5] = opts.disposition || 'abandoned';
  r[7] = opts.onHold ? 'TRUE' : 'FALSE';
  r[10] = entryQueue; r[12] = opts.finalDept || ''; r[15] = callStart;
  r[16] = 'FALSE';
  return r;
}
const IB_ROWS = [
  ibRow('h1', 'A_Q_CSR', '08:00:00'),       // Ann 09:00 (connected)      CSR own
  ibRow('h2', 'A_Q_CSR', '08:05:00'),       // Bob 08:30                  CSR other (Sales)
  ibRow('h3', 'A_Q_CSR', '08:10:00'),       // never                      CSR none
  ibRow('', 'A_Q_CSR', '08:15:00'),         // anonymous                  untrackable
  ibRow('h4', 'A_Q_Spanish', '08:20:00'),   // Sofia 08:40 (connected)    Spanish own
  // A final_dept label naming SALES must NOT move an abandon: the entry
  // queue is the whole rule for this population.
  // Ann is on the PARENT's roster, so for a Spanish episode she is own team.
  ibRow('h5', 'A_Q_Spanish', '08:25:00', { finalDept: 'sales', onHold: true }),   // Ann 08:35
  ibRow('h6', 'A_Q_Shared', '09:00:00'),    // Casey 09:10 (connected)    Power+Sales own (Sales)
  ibRow('h7', 'A_Q_Shared', '09:05:00'),    // Ghost 10:00                unrostered -> other
  ibRow('h8', 'A_Q_Mystery', '09:30:00'),   // no agent 09:45 (connected) unmapped row, other
  ibRow('h9', '', '09:40:00'),              // no queue reached           counted, NOT an episode
  ibRow('h10', 'A_Q_CSR', '10:00:00'),      // tie -> Ann (o11)           CSR own
];

// Each dept's OWN queues; the child-inclusive list (inboundQueuesForDept_'s
// default) adds a parent's children's.
const OWN_QUEUES = {
  CSR: ['A_Q_CSR'],
  Spanish: ['A_Q_Spanish'],
  Sales: ['A_Q_Shared'],             // M2: one queue, two depts
  Power: ['A_Q_Shared'],
};
const CHILDREN = { CSR: ['Spanish'] };
const ROSTER = {
  Ann: ['CSR'], Sofia: ['Spanish'], Bob: ['Sales'], Pat: ['Power'],
  Casey: ['CSR', 'Sales'],           // a crossover dialer
};

/** The event blob obCallbackEventsSql_ returns for this fixture (company view), derived with the SQL's clauses. */
function neonEvents() {
  const abs = IB_ROWS.filter((r) => r[5] === 'abandoned');
  const counts = {};
  abs.forEach((r) => {
    const q = String(r[10]).trim().toLowerCase();
    const kind = q ? 'queue' : 'menu';
    const key = [kind, !r[3], q].join('|');
    const c = counts[key] || (counts[key] = { w: 'cur', kind: kind, anon: !r[3], q: q, n: 0 });
    c.n++;
  });
  const tracked = abs.filter((r) => r[3] && String(r[10]).trim());
  const hashes = Array.from(new Set(tracked.map((r) => r[3]))).sort();
  const k = {}; hashes.forEach((x, i) => { k[x] = i + 1; });
  return {
    agents: [],
    cbCounts: Object.keys(counts).map((x) => counts[x]),
    cbAb: tracked.map((r) => [k[r[3]], r[0], r[15], String(r[10]).trim().toLowerCase(), r[1]]),
    cbOb: OB_ROWS.filter((o) => k[o[2]]).map((o) => [k[o[2]], o[0], o[10], o[1], o[3], o[6] === 'TRUE']),
    cbAns: [],
    coverageStart: D,
  };
}

function fakeTab(rows, width) {
  return {
    getLastRow: function () { return rows.length + 1; },
    getMaxColumns: function () { return width; },
    getLastColumn: function () { return width; },
    getRange: function (row, col, numRows, numCols) {
      return {
        getDisplayValues: function () {
          const out = [];
          for (let i = 0; i < numRows; i++) {
            const src = rows[row - 2 + i] || [];
            const line = [];
            for (let c = 0; c < numCols; c++) {
              const v = src[col - 1 + c];
              line.push(v == null ? '' : String(v));
            }
            out.push(line);
          }
          return out;
        },
      };
    },
  };
}
function connReturning(json, sink) {
  return {
    createStatement: function () {
      return {
        executeQuery: function (sql) {
          if (sink) sink.push(sql);
          let n = 0;
          return { next: function () { return n++ === 0; },
                   getString: function () { return json; }, close: function () {} };
        },
        close: function () {},
      };
    },
    close: function () {},
  };
}
function install(opts) {
  opts = opts || {};
  h.state.cache.clear();
  h.state.props = { ADMIN_EMAILS: 'x@x.com', SPREADSHEET_ID: 'fake' };
  h.state.userEmail = 'x@x.com';
  h.ctx.resolveUser_ = function () { return { role: 'admin', department: null, email: 'x@x.com' }; };
  h.ctx.getAllDepartments_ = function () { return ['CSR', 'Power', 'Sales', 'Spanish']; };
  h.ctx.isIsoDate_ = function (s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s)); };
  h.ctx.reportFreshnessTag_ = function () { return 'tag'; };
  h.ctx.logReportUsage_ = function () {};
  h.ctx.computePriorWindow_ = function () { return null; };
  h.ctx.inboundQueuesForDept_ = function (d, o) {
    const own = (OWN_QUEUES[d] || []).slice();
    if (o && o.includeChildren === false) return own;
    (CHILDREN[d] || []).forEach(function (c) { own.push.apply(own, OWN_QUEUES[c] || []); });
    return own;
  };
  h.ctx.inboundChildDepts_ = function (d) { return (CHILDREN[d] || []).slice(); };
  h.ctx.getFinalDeptLabels_ = function (d) { return [String(d).toLowerCase()]; };
  h.ctx.getAllFinalDeptLabels_ = function () { return ['csr', 'sales', 'power', 'spanish']; };
  h.ctx.buildDeptsByAgent_ = function () { return ROSTER; };
  h.ctx.obTodayIso_ = function () { return opts.today || '2026-09-01'; };
  h.ctx.getDashboardNeonConn_ = function () { return opts.conn || null; };
  h.ctx.openSpreadsheet_ = function () {
    return {
      getSheetByName: function (name) {
        if (name === 'Outbound Calls') return fakeTab(OB_ROWS, 12);
        if (name === 'Inbound Calls') return fakeTab(IB_ROWS, 17);
        return null;
      },
    };
  };
}
const plain = (x) => JSON.parse(JSON.stringify(x));
const byDept = (t) => { const o = {}; t.rows.forEach((r) => { o[r.dept] = r; }); return o; };

function assertInvariant(row, label) {
  assert.equal(row.own + row.gotThrough + row.other + row.pending + row.none, row.episodes,
    label + ': the five outcomes partition the episodes');
}

test('CB-1 parity: the hand-derived Neon events and the sheet fallback shape to the SAME table', function () {
  install({ conn: connReturning(JSON.stringify(neonEvents())) });
  const live = h.call('getOutboundReport', { from: FROM, to: TO, department: 'ALL' });
  assert.ok(!live.meta.fallbackSource);
  install({ conn: null });
  const fb = h.call('getOutboundReport', { from: FROM, to: TO, department: 'ALL' });
  assert.equal(fb.meta.fallbackSource, 'sheet');
  assert.deepEqual(plain(fb.callback), plain(live.callback), 'the tiles agree');
  assert.deepEqual(plain(fb.callbackByDept), plain(live.callbackByDept), 'the table agrees');
});

test('CB-1 on episodes: own / other / none per dept -- the rulings, worked by hand', function () {
  install({ conn: null });
  const t = h.call('getOutboundReport', { from: FROM, to: TO, department: 'ALL' }).callbackByDept;
  const r = byDept(t);
  // CSR (parent): its row holds the child's episodes too. Sofia (Spanish)
  // closing h4 and Ann (CSR, the parent) closing h5 are both own team; the
  // h10 tie went to Ann (o11 < o20), so it is own as well.
  assert.equal(r.CSR.episodes, 6);
  assert.equal(r.CSR.own, 4);
  assert.equal(r.CSR.other, 1, 'Bob (Sales) dialing h2 is another team');
  assert.equal(r.CSR.none, 1);
  assert.equal(r.CSR.ownPct, 66.7);
  assert.equal(r.CSR.ownConnected, 2);
  assert.equal(r.CSR.medianCallbackSec, 1500, 'median of 600 / 1200 / 1800 / 3600');
  assert.equal(r.CSR.parent, null);
  assert.equal(r.CSR.abandonedAnonymous, 1);
  // Spanish (child): its family includes the parent, so Ann's dial is own.
  assert.equal(r.Spanish.parent, 'CSR');
  assert.equal(r.Spanish.own, 2);
  assert.deepEqual(plain(r.Spanish.byCaller.map((b) => [b.kind, b.label])),
    [['own', 'CSR'], ['own', 'Spanish']]);
  // M2: one queue, two depts -- the same two episodes in both rows, and a
  // dial from either owner is own (Casey is on Sales).
  assert.equal(r.Sales.episodes, 2);
  assert.equal(r.Power.episodes, 2);
  assert.equal(r.Sales.own, 1);
  assert.equal(r.Power.own, 1, 'the shared queue’s team is BOTH depts');
  // Unmapped: its own row, nothing can be "own".
  const un = r['Not mapped to a department'];
  assert.equal(un.unmapped, true);
  assert.equal(un.episodes, 1, 'h8 only -- h9 reached no queue, so it is no episode at all');
  assert.equal(un.own, 0);
  assert.equal(un.other, 1);
  assert.deepEqual(plain(t.unmappedQueues), [{ queue: 'a_q_mystery', tracked: 1, total: 1 }]);
  assert.equal(t.rows[t.rows.length - 1].unmapped, true, 'the unmapped row sorts last');
  t.rows.forEach((row) => assertInvariant(row, row.dept));
});

test('CB-1: the named tallies -- multi-roster, unrostered, no agent', function () {
  install({ conn: null });
  const r = byDept(h.call('getOutboundReport', { from: FROM, to: TO, department: 'ALL' }).callbackByDept);
  assert.deepEqual(plain(r.Sales.tallies), { multiRoster: 1, unrostered: 1, noAgent: 0 });
  assert.deepEqual(plain(r.Power.tallies), { multiRoster: 1, unrostered: 1, noAgent: 0 });
  assert.deepEqual(plain(r.Power.byCaller.map((b) => [b.kind, b.label, b.calledBack])),
    [['own', 'CSR + Sales', 1], ['other', 'Unrostered', 1]],
    'a crossover dialer is NAMED as both homes, never folded into one peer dept');
  assert.deepEqual(plain(r['Not mapped to a department'].tallies), { multiRoster: 0, unrostered: 0, noAgent: 1 });
});

test('CB-1: the TOTAL counts each episode once, reconciles with the tiles, and the headline skips unmapped', function () {
  install({ conn: null });
  const rep = h.call('getOutboundReport', { from: FROM, to: TO, department: 'ALL' });
  const t = rep.callbackByDept.total;
  const cb = rep.callback;
  assert.equal(t.episodes, cb.episodes);
  assert.equal(t.own, cb.own);
  assert.equal(t.ownConnected, cb.ownConnected);
  assert.equal(t.medianCallbackSec, cb.medianCallbackSec);
  assert.equal(t.episodes, 9);
  assert.equal(t.own, 5);
  assert.equal(t.other, 3);
  assert.equal(t.none, 1);
  assertInvariant(t, 'total');
  assert.equal(t.mappedEpisodes, 8);
  assert.equal(t.mappedOwnPct, 62.5, 'no team can own the unmapped row’s callback');
  // The context counts: every abandon stays in abandonedTotal (Inbound parity).
  assert.equal(cb.abandonedTotal, 11);
  assert.equal(cb.abandonedTracked, 9);
  assert.equal(cb.phoneMenuAbandons, 1, 'h9');
  // The rows deliberately do NOT sum to it (M2 + parent rollups).
  const sum = rep.callbackByDept.rows.reduce((a, r) => a + r.episodes, 0);
  assert.ok(sum > t.episodes, 'double-mapped + parent rows overlap -- never sum them');
});

test('CB-1: pending per row follows the same inclusive window as the tile', function () {
  install({ conn: null, today: '2026-08-12' });   // 08-10 is today - 2: still callable
  const rep = h.call('getOutboundReport', { from: FROM, to: TO, department: 'ALL' });
  const r = byDept(rep.callbackByDept);
  assert.equal(r.CSR.pending, 1, 'h3');
  assert.equal(r.CSR.none, 0);
  assert.equal(rep.callbackByDept.total.pending, rep.callback.pending);
  assert.equal(rep.callback.pending, 1);
});

test('CB-1: a single-dept view carries no table (company view only)', function () {
  install({ conn: null });
  const rep = h.call('getOutboundReport', { from: FROM, to: TO, department: 'CSR' });
  assert.equal(rep.callbackByDept, null);
});

test('CE-1 SQL: one abandon CTE, integer caller keys, and no hash ever selected out', function () {
  const sink = [];
  install({ conn: connReturning(JSON.stringify(neonEvents()), sink) });
  h.call('getOutboundReport', { from: FROM, to: TO, department: 'ALL' });
  const sql = sink.join('\n');
  assert.match(sql, /^WITH cb_ab AS \(/);
  assert.match(sql, /dense_rank\(\) OVER \(ORDER BY x\.h\)/, 'callers are keyed by an integer, per request');
  assert.match(sql, /JOIN cb_k k ON k\.h = o\.callee_hash/, 'dials joined by the shared hash space');
  assert.match(sql, /JOIN cb_k k ON k\.h = a\.caller_hash/, 'answered calls likewise');
  assert.match(sql, /WHERE a\.disposition = 'answered' AND COALESCE\(a\.is_internal, FALSE\) = FALSE/);
  // Every json_build_array that leaves the database carries the key, never the hash.
  (sql.match(/json_build_array\([^)]*\)/g) || []).forEach(function (arr) {
    assert.ok(!/\bh\b|caller_hash|callee_hash/.test(arr), 'no hash in ' + arr);
  });
  assert.match(sql, /o\.call_date BETWEEN '2026-08-10'::date AND '2026-08-14'::date/,
    'dials through to + OUTBOUND_CALLBACK_WINDOW_DAYS');
  assert.equal(sql.split('FROM inbound_calls c').length - 1, 1, 'the abandon scan runs ONCE');
});

// (4) Entry-queue-only attribution. For disposition='abandoned' the on-hold
// arm is structurally dead, so the dept predicate reduces to the entry-queue
// test -- whatever final_dept / abandoned_on_hold hold. Exhaustive over the
// inputs that could matter.
test('CB-1: an ABANDON is attributed by its entry queue alone (the on-hold arm cannot fire)', function () {
  const qSet = { a_q_csr: true };
  const labels = ['csr'];
  const allLabels = ['csr', 'sales'];
  ['A_Q_CSR', 'A_Q_Sales', ''].forEach(function (eq) {
    ['', 'csr', 'sales', 'unknown label'].forEach(function (fd) {
      [true, false].forEach(function (onHold) {
        const row = ibRow('hx', eq, '08:00:00', { finalDept: fd, onHold: onHold });
        assert.equal(h.call('ihRowInDept_', row, qSet, labels, allLabels), eq === 'A_Q_CSR',
          'abandon eq=' + eq + ' fd=' + fd + ' onHold=' + onHold);
      });
    });
  });
  // ...and the SQL predicate's on-hold arm requires disposition='answered'.
  const pred = h.call('inboundDeptPredicate_', 'CSR', ['A_Q_CSR']);
  assert.match(pred, /\(c\.disposition='answered' AND COALESCE\(c\.abandoned_on_hold, false\)\) AND lower\(trim\(c\.final_dept\)\)/);
});

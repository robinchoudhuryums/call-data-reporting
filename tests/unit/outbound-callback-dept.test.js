'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// CB-1 (2026-09-28): the per-dept callback table on the Outbound report's
// COMPANY view (docs/outbound-callback-dept-plan.md Part 1). Pins:
//   (1) the arithmetic invariant own + other + none === tracked, on every row
//       AND the total row -- the one property a grouping bug breaks quietly;
//   (2) the rulings: the FIRST callback decides own/other (incl. a same-second
//       tie broken by call_id), a parent's row includes its children's queues
//       AND agents, a double-mapped queue (M2) lands in both rows, an unmapped
//       queue gets its own row, the total row comes from the queue axis;
//   (3) the named tallies (multi-roster, unrostered, no agent);
//   (4) ENTRY-QUEUE-ONLY attribution for abandons -- the on-hold arm of the
//       inbound dept predicate can never fire for this population;
//   (5) source parity: the Neon path (a HAND-COMPUTED blob, not a second
//       implementation) and the sheet fallback shape to the same table.

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
function ibRow(hash, entryQueue, callStart, opts) {
  opts = opts || {};
  const r = new Array(17).fill('');
  r[0] = D; r[3] = hash; r[5] = opts.disposition || 'abandoned';
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
  ibRow('h4', 'A_Q_Spanish', '08:20:00'),   // Sofia 08:40 (connected)    Spanish own, CSR own
  // A final_dept label naming SALES must NOT move an abandon: the entry
  // queue is the whole rule for this population.
  ibRow('h5', 'A_Q_Spanish', '08:25:00', { finalDept: 'sales', onHold: true }),   // Ann 08:35
  ibRow('h6', 'A_Q_Shared', '09:00:00'),    // Casey 09:10 (connected)    Sales own / Power other
  ibRow('h7', 'A_Q_Shared', '09:05:00'),    // Ghost 10:00                unrostered
  ibRow('h8', 'A_Q_Mystery', '09:30:00'),   // no agent 09:45 (connected) unmapped row
  ibRow('h9', '', '09:40:00'),              // never                      unmapped row
  ibRow('h10', 'A_Q_CSR', '10:00:00'),      // tie -> Ann (o11)           CSR own
];

const QUEUES = {
  CSR: ['A_Q_CSR', 'A_Q_Spanish'],   // a parent's list includes its child's
  Spanish: ['A_Q_Spanish'],
  Sales: ['A_Q_Shared'],             // M2: one queue, two depts
  Power: ['A_Q_Shared'],
};
const ROSTER = {
  Ann: ['CSR'], Sofia: ['Spanish'], Bob: ['Sales'], Pat: ['Power'],
  Casey: ['CSR', 'Sales'],           // a crossover dialer
};

// The raw callbackByDept blob the SQL returns for this fixture, WORKED BY
// HAND from the rows above (delays in seconds from each abandon's start).
const RAW_BY_DEPT = {
  rows: [
    { dept: '', total: 2, anon: 0, called_back: 1, connected: 1, median: 900, pending: 0 },
    { dept: 'CSR', total: 7, anon: 1, called_back: 5, connected: 2, median: 1500, pending: 0 },
    { dept: 'Power', total: 2, anon: 0, called_back: 2, connected: 1, median: 1950, pending: 0 },
    { dept: 'Sales', total: 2, anon: 0, called_back: 2, connected: 1, median: 1950, pending: 0 },
    { dept: 'Spanish', total: 2, anon: 0, called_back: 2, connected: 1, median: 900, pending: 0 },
  ],
  cells: [
    { dept: '', agent: '', called_back: 1, connected: 1 },
    { dept: 'CSR', agent: 'Ann', called_back: 3, connected: 1 },
    { dept: 'CSR', agent: 'Bob', called_back: 1, connected: 0 },
    { dept: 'CSR', agent: 'Sofia', called_back: 1, connected: 1 },
    { dept: 'Power', agent: 'Casey', called_back: 1, connected: 1 },
    { dept: 'Power', agent: 'Ghost', called_back: 1, connected: 0 },
    { dept: 'Sales', agent: 'Casey', called_back: 1, connected: 1 },
    { dept: 'Sales', agent: 'Ghost', called_back: 1, connected: 0 },
    { dept: 'Spanish', agent: 'Ann', called_back: 1, connected: 0 },
    { dept: 'Spanish', agent: 'Sofia', called_back: 1, connected: 1 },
  ],
  qcells: [
    { q: 'a_q_csr', agent: 'Ann', called_back: 2, connected: 1 },
    { q: 'a_q_csr', agent: 'Bob', called_back: 1, connected: 0 },
    { q: 'a_q_mystery', agent: '', called_back: 1, connected: 1 },
    { q: 'a_q_shared', agent: 'Casey', called_back: 1, connected: 1 },
    { q: 'a_q_shared', agent: 'Ghost', called_back: 1, connected: 0 },
    { q: 'a_q_spanish', agent: 'Ann', called_back: 1, connected: 0 },
    { q: 'a_q_spanish', agent: 'Sofia', called_back: 1, connected: 1 },
  ],
  unmapped: [
    { q: '', tracked: 1, total: 1 },
    { q: 'a_q_mystery', tracked: 1, total: 1 },
  ],
};
const RAW_CALLBACK = {
  abandonedTotal: 11, abandonedAnonymous: 1, calledBack: 8, calledBackConnected: 4,
  medianCallbackSec: 1350, pendingTail: 0,
  delayBuckets: { m15: 3, h1: 5, h4: 0, d1: 0, later: 0 },
};

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
  h.ctx.inboundQueuesForDept_ = function (d) { return (QUEUES[d] || []).slice(); };
  h.ctx.inboundChildDepts_ = function (d) { return d === 'CSR' ? ['Spanish'] : []; };
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
  assert.equal(row.ownCalledBack + row.otherCalledBack + row.notCalledBack, row.tracked,
    label + ': own + other + none must equal tracked');
  assert.equal(row.ownCalledBack + row.otherCalledBack, row.calledBack, label + ': own + other = called back');
}

test('CB-1 parity: the hand-computed Neon blob and the sheet fallback shape to the SAME table', function () {
  install({ conn: connReturning(JSON.stringify({
    agents: [], callback: RAW_CALLBACK, callbackDaily: [], callbackByHour: [],
    callbackByDept: RAW_BY_DEPT, coverageStart: D })) });
  const live = h.call('getOutboundReport', { from: FROM, to: TO, department: 'ALL' });
  assert.ok(!live.meta.fallbackSource);
  install({ conn: null });
  const fb = h.call('getOutboundReport', { from: FROM, to: TO, department: 'ALL' });
  assert.equal(fb.meta.fallbackSource, 'sheet');
  assert.deepEqual(plain(fb.callback), plain(live.callback), 'the tiles agree');
  assert.deepEqual(plain(fb.callbackByDept), plain(live.callbackByDept), 'the table agrees');
});

test('CB-1: own / other / none per dept -- the rulings, worked by hand', function () {
  install({ conn: null });
  const t = h.call('getOutboundReport', { from: FROM, to: TO, department: 'ALL' }).callbackByDept;
  const r = byDept(t);
  // CSR (parent): its row includes the child's queue AND counts the child's
  // agents as "us" -- Sofia (Spanish) calling back an A_Q_Spanish abandon is
  // CSR's own; the h10 tie went to Ann (o11 < o20), so it is own too.
  assert.equal(r.CSR.tracked, 6);
  assert.equal(r.CSR.ownCalledBack, 4);
  assert.equal(r.CSR.otherCalledBack, 1);
  assert.equal(r.CSR.notCalledBack, 1);
  assert.equal(r.CSR.ownPct, 66.7);
  assert.equal(r.CSR.ownConnected, 2);
  assert.equal(r.CSR.medianCallbackSec, 1500);
  assert.equal(r.CSR.parent, null);
  // Spanish (child): indented under CSR; Ann (CSR only) is NOT a Spanish member.
  assert.equal(r.Spanish.parent, 'CSR');
  assert.equal(r.Spanish.ownCalledBack, 1);
  assert.equal(r.Spanish.otherCalledBack, 1);
  assert.deepEqual(plain(r.Spanish.byCaller.map((b) => [b.kind, b.label])),
    [['own', 'Spanish'], ['dept', 'CSR']]);
  // M2: one queue, two depts -- the same two abandons in both rows.
  assert.equal(r.Sales.tracked, 2);
  assert.equal(r.Power.tracked, 2);
  assert.equal(r.Sales.ownCalledBack, 1, 'Casey is on the Sales roster -> own');
  assert.equal(r.Power.ownCalledBack, 0, 'Casey is not on Power -> other');
  // Unmapped: its own row, nothing can be "own".
  const un = r['Not mapped to a department'];
  assert.equal(un.unmapped, true);
  assert.equal(un.tracked, 2);
  assert.equal(un.ownCalledBack, 0);
  assert.equal(un.otherCalledBack, 1);
  assert.deepEqual(plain(t.unmappedQueues), [
    { queue: '(no entry queue)', tracked: 1, total: 1 },
    { queue: 'a_q_mystery', tracked: 1, total: 1 },
  ]);
  assert.equal(t.rows[t.rows.length - 1].unmapped, true, 'the unmapped row sorts last');
  t.rows.forEach((row) => assertInvariant(row, row.dept));
});

test('CB-1: the named tallies -- multi-roster, unrostered, no agent', function () {
  install({ conn: null });
  const r = byDept(h.call('getOutboundReport', { from: FROM, to: TO, department: 'ALL' }).callbackByDept);
  assert.deepEqual(plain(r.Sales.tallies), { multiRoster: 1, unrostered: 1, noAgent: 0 });
  assert.deepEqual(plain(r.Power.tallies), { multiRoster: 1, unrostered: 1, noAgent: 0 });
  assert.deepEqual(plain(r.Power.byCaller.map((b) => [b.kind, b.label, b.calledBack])),
    [['multi', 'CSR + Sales', 1], ['unrostered', 'Unrostered', 1]],
    'a crossover dialer is NAMED as both homes, never folded into one peer dept');
  assert.deepEqual(plain(r['Not mapped to a department'].tallies), { multiRoster: 0, unrostered: 0, noAgent: 1 });
});

test('CB-1: the TOTAL row is computed once from the queue axis and reconciles with the tiles', function () {
  install({ conn: null });
  const rep = h.call('getOutboundReport', { from: FROM, to: TO, department: 'ALL' });
  const t = rep.callbackByDept.total;
  assert.equal(t.tracked, rep.callback.abandonedTracked);
  assert.equal(t.calledBack, rep.callback.calledBack);
  assert.equal(t.calledBackConnected, rep.callback.calledBackConnected);
  assert.equal(t.medianCallbackSec, rep.callback.medianCallbackSec);
  // Own at company level = the dialer belongs to ANY dept the queue maps to.
  assert.equal(t.ownCalledBack, 5);
  assert.equal(t.otherCalledBack, 3);
  assert.equal(t.notCalledBack, 2);
  assertInvariant(t, 'total');
  // The rows deliberately do NOT sum to it (M2 + parent rollups).
  const sumTracked = rep.callbackByDept.rows.reduce((a, r) => a + r.tracked, 0);
  assert.ok(sumTracked > t.tracked, 'double-mapped + parent rows overlap -- never sum them');
});

test('CB-1: pending per row follows the same inclusive window as the tile', function () {
  install({ conn: null, today: '2026-08-12' });   // 08-10 is today - 2: still callable
  const rep = h.call('getOutboundReport', { from: FROM, to: TO, department: 'ALL' });
  const r = byDept(rep.callbackByDept);
  assert.equal(r.CSR.pendingTail, 1, 'h3');
  assert.equal(r['Not mapped to a department'].pendingTail, 1, 'h9');
  assert.equal(rep.callbackByDept.total.pendingTail, rep.callback.pendingTail);
  assert.equal(rep.callback.pendingTail, 2);
});

test('CB-1: a single-dept view carries no table (company view only)', function () {
  install({ conn: null });
  const rep = h.call('getOutboundReport', { from: FROM, to: TO, department: 'CSR' });
  assert.equal(rep.callbackByDept, null);
});

test('CB-1 SQL: one CTE pass, the queue map as VALUES (child + double-mapped pairs), unmapped kept', function () {
  const sink = [];
  install({ conn: connReturning(JSON.stringify({ agents: [], callback: RAW_CALLBACK,
    callbackDaily: [], callbackByHour: [], callbackByDept: RAW_BY_DEPT, coverageStart: D }), sink) });
  h.call('getOutboundReport', { from: FROM, to: TO, department: 'ALL' });
  const sql = sink.join('\n');
  assert.match(sql, /'callbackByDept', \(WITH qmap AS \(SELECT \* FROM \(VALUES /);
  assert.match(sql, /\('a_q_spanish', 'CSR'\)/, 'a parent row includes its child queue');
  assert.match(sql, /\('a_q_spanish', 'Spanish'\)/);
  assert.match(sql, /\('a_q_shared', 'Power'\)/);
  assert.match(sql, /\('a_q_shared', 'Sales'\)/, 'M2: both depts');
  assert.match(sql, /LEFT JOIN qmap m ON m\.queue = ab\.q/, 'LEFT join -- an unmapped queue is kept, never dropped');
  assert.match(sql, /COALESCE\(trim\(cb\.agent_name\),''\) AS agent/, 'the FIRST callback\'s dialer');
  assert.equal(sql.split('(WITH qmap').length - 1, 1, 'the lateral runs ONCE for the table');
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

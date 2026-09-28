'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// S2C-2 (owner ruling 2026-09-28): an on-hold abandon that happened while the
// answering agent was calling ANOTHER dept -- which never picked up -- counts
// for that TARGET dept in the Inbound report, not for the dept that answered.
// Pins:
//   (1) the tallies only RECLASSIFY: total / answered never move, the tile is
//       raw - out + in, and the company view carries no tallies at all;
//   (2) the SQL rule: exactly ONE linked internal record (inbound kind), not
//       answered, with an entry queue; the subquery is CASE-guarded to on-hold
//       answered rows; `out` = in scope and target NOT one of the dept's
//       queues, `in` = out of scope and target IS one of them;
//   (3) the sample tool's pure tally applies the SAME rule and names the
//       not-moved neighbours (target answered, ambiguous, same dept, blind).
// The SQL itself was executed against Postgres 16 on a fixture when this
// shipped (fix-history S2C-2); these pins keep its shape from drifting.

const h = loadGas({ files: ['Config.gs', 'InboundReport.gs'] });

function fakeConn(payload) {
  const cap = { sqls: [] };
  return {
    cap: cap,
    conn: {
      createStatement: function () {
        return {
          executeQuery: function (sql) {
            cap.sqls.push(sql);
            if (/information_schema/.test(sql)) return { next: function () { return false; }, close: function () {} };
            let done = false;
            return { next: function () { if (done) return false; done = true; return true; },
                     getString: function () { return JSON.stringify(payload); }, close: function () {} };
          },
          close: function () {},
        };
      },
      close: function () {},
    },
  };
}
function install(payload) {
  h.ctx.computePriorWindow_ = function () { return { from: '2026-06-01', to: '2026-06-08' }; };
  h.ctx.inboundDialInLabels_ = function () { return {}; };
  h.ctx.getAllFinalDeptLabels_ = function () { return ['customer success', 'inside sales']; };
  h.ctx.getFinalDeptLabels_ = function (d) { return d === 'CSR' ? ['customer success'] : ['inside sales']; };
  h.ctx.getOverviewParentMap_ = function () { return {}; };
  const f = fakeConn(payload);
  h.ctx.getDashboardNeonConn_ = function () { return f.conn; };
  return f;
}
const PAYLOAD = {
  kpis: { total: 40, answered: 30, abandoned: 5, abandonedOnHold: 6 },
  kpisPrior: { total: 38, answered: 29, abandonedOnHold: 4 },
  xfer: { out: 2, in: 3 }, xferPrior: { out: 1, in: 0 },
  byInsurer: [], byDialIn: [], byQueue: [], byDialInInsurer: [], daily: [], outsideWindow: {},
};
const DEPT = { from: '2026-06-09', to: '2026-06-16', dept: 'CSR', companyView: false, deptQueues: ['A_Q_CSR'] };

test('S2C-2: a dept view moves on-hold transfer abandons -- and ONLY that tile', function () {
  install(PAYLOAD);
  const r = JSON.parse(JSON.stringify(h.call('computeInboundReport_', DEPT)));
  assert.equal(r.kpis.abandonedOnHold, 6 - 2 + 3);
  assert.equal(r.kpis.onHoldTransferOut, 2);
  assert.equal(r.kpis.onHoldTransferIn, 3);
  assert.equal(r.kpis.total, 40, 'the answering dept keeps the call');
  assert.equal(r.kpis.answered, 30, 'its agent did answer it');
  assert.equal(r.kpisPrior.abandonedOnHold, 4 - 1 + 0, 'the delta chip compares like with like');
});

test('S2C-2: the company view carries no tallies (a move between depts nets to zero)', function () {
  const f = install(PAYLOAD);
  const r = JSON.parse(JSON.stringify(h.call('computeInboundReport_',
    { from: '2026-06-09', to: '2026-06-16', dept: '', companyView: true, deptQueues: [] })));
  assert.equal(r.kpis.abandonedOnHold, 6);
  assert.equal(r.kpis.onHoldTransferIn, 0);
  assert.ok(!/'xfer'/.test(f.cap.sqls.join('\n')));
});

test('S2C-2 SQL: unique, unanswered, inbound-kind link; CASE-guarded; out/in split on the dept queues', function () {
  const f = install(PAYLOAD);
  h.call('computeInboundReport_', DEPT);
  const sql = f.cap.sqls.join('\n');
  assert.match(sql, /'xfer', \(SELECT json_build_object\('out'/);
  assert.match(sql, /'xferPrior', /);
  const x = h.call('inboundXferTargetSql_');
  assert.match(x, /^\(CASE WHEN c\.disposition = 'answered' AND COALESCE\(c\.abandoned_on_hold, false\) THEN \(/,
    'the correlated lookup runs only for the few on-hold rows');
  assert.match(x, /CASE WHEN count\(\*\) = 1 THEN min\(lower\(trim\(x\.entry_queue\)\)\) END/, 'UNIQUE link only');
  assert.match(x, /x\.related_call_id = c\.call_id/);
  assert.match(x, /COALESCE\(x\.related_call_kind, 'inbound'\) = 'inbound'/, 'an OUTBOUND link is not a transfer of this caller');
  assert.match(x, /x\.disposition <> 'answered'/, 'the target never picked up');
  assert.match(x, /COALESCE\(x\.is_internal, false\)/);
  assert.match(sql, /s\.xt IS NOT NULL AND s\.xt NOT IN \('a_q_csr'\)/, 'out: target outside the dept');
  assert.match(sql, /AND NOT COALESCE\(\(\(\(\(c\.disposition='answered'/, 'in: rows OUTSIDE the dept scope...');
  assert.match(sql, /s\.xt IN \('a_q_csr'\)/, '...whose target is one of its queues');
});

test('S2C-2 sample tool: the same rule, and every not-moved neighbour is named', function () {
  const labelsOf = function (d) { return d === 'CSR' ? ['customer success'] : ['inside sales']; };
  const map = { pairs: [{ queue: 'a_q_csr', dept: 'CSR' }, { queue: 'a_q_sales', dept: 'Sales' }] };
  const rows = [
    { d: '2026-06-09', s: '09:00:00', id: 'c1', fd: 'Customer Success', oh: true, hold: 40,
      l: [{ id: 'x1', q: 'a_q_sales', disp: 'abandoned' }] },                                 // moved
    { d: '2026-06-09', id: 'c2', fd: 'Customer Success', oh: true,
      l: [{ id: 'x2', q: 'a_q_sales', disp: 'answered' }] },                                  // target answered
    { d: '2026-06-09', id: 'c3', fd: 'Customer Success', oh: true,
      l: [{ id: 'x3', q: 'a_q_sales', disp: 'abandoned' }, { id: 'x4', q: 'a_q_sales', disp: 'missed' }] }, // ambiguous
    { d: '2026-06-09', id: 'c4', fd: 'Customer Success', oh: true,
      l: [{ id: 'x5', q: 'a_q_csr', disp: 'abandoned' }] },                                   // same dept
    { d: '2026-06-09', id: 'c5', fd: 'Customer Success', oh: false,
      l: [{ id: 'x6', q: 'a_q_sales', disp: 'abandoned' }] },                                 // blind transfer
    { d: '2026-06-09', id: 'c6', fd: 'Customer Success', oh: true,
      l: [{ id: 'x7', q: 'a_q_sales', disp: 'answered' }, { id: 'x8', q: 'a_q_sales', disp: 'abandoned' }] }, // one unanswered -> moved
  ];
  const t = JSON.parse(JSON.stringify(h.call('xferSampleTally_', rows, map, labelsOf)));
  assert.deepEqual(t.moved.map(function (m) { return [m.callId, m.xferId, m.targetDepts]; }),
    [['c1', 'x1', ['Sales']], ['c6', 'x8', ['Sales']]]);
  assert.deepEqual([t.targetAnswered, t.ambiguous, t.sameDept, t.blind], [1, 1, 1, 1]);
  assert.deepEqual(t.byRoute, { 'Customer Success -> a_q_sales (Sales)': 2 });
  assert.ok(!/hash|caller_number/i.test(JSON.stringify(t)), 'ids, times, queues and labels only');
});

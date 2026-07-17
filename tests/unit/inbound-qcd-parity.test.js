'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// Batch 8 vetting tool: compareInboundVsQcdAbandons_ joins the two
// abandonment lenses per day -- QCD Historical Data (canonical queues,
// source-aware grid) vs inbound_calls (raw queues, the shared
// inboundDeptPredicate_) -- reporting strict abandons AND the
// answered-on-hold carve-out so the parked definitional discrepancy is
// quantifiable before any un-gating decision.

const h = loadGas({ files: ['Config.gs', 'InboundReport.gs'] });

function installStubs(inboundDays) {
  h.ctx.queuesForDept_ = function () { return ['A_Q_CustomerSuccess']; };
  h.ctx.getInboundQueueAliases_ = function () { return ['A_Q_CSR']; };
  h.ctx.rowDateIso_ = function (v) { return String(v || ''); };
  // Grid shape from readQcdGrid_: 12-col rows, QCD_HISTORICAL_COLS positions.
  const qrow = function (d, queue, source, abandoned) {
    const r = new Array(12).fill('');
    r[2] = d; r[3] = queue; r[4] = source; r[7] = abandoned;
    return r;
  };
  h.ctx.readQcdGrid_ = function () {
    return { ssTZ: 'America/Chicago', values: [
      qrow('2026-06-01', 'A_Q_CustomerSuccess', 'Total Calls', 5),
      qrow('2026-06-02', 'A_Q_CustomerSuccess', 'Total Calls', 3),
      qrow('2026-06-01', 'A_Q_CustomerSuccess', 'CSR', 99),          // sub-source: ignored
      qrow('2026-06-01', 'A_Q_Other', 'Total Calls', 99),            // other dept: ignored
      qrow('2026-05-01', 'A_Q_CustomerSuccess', 'Total Calls', 99),  // out of range (sheet path)
    ], displays: [] };
  };
  const cap = { sqls: [] };
  h.ctx.__cap = cap;
  const conn = {
    prepareStatement: function (sql) {
      cap.sqls.push(sql);
      let done = false;
      return {
        setString: function () {},
        executeQuery: function () {
          return {
            next: function () { if (done) return false; done = true; return true; },
            getString: function () { return JSON.stringify(inboundDays); },
            close: function () {},
          };
        },
        close: function () {},
      };
    },
    close: function () {},
  };
  return conn;
}

test('parity core: per-day join of QCD vs inbound with both definitions', function () {
  const conn = installStubs([
    { d: '2026-06-01', ab: 4, hold: 1 },
    { d: '2026-06-03', ab: 2, hold: 0 },   // inbound-only day
  ]);
  const r = h.call('compareInboundVsQcdAbandons_', 'CSR', '2026-06-01', '2026-06-03', conn);
  assert.deepEqual(Array.from(r.inboundQueues), ['A_Q_CustomerSuccess', 'A_Q_CSR'],
    'attribution uses the canonical ∪ raw-alias union');
  assert.equal(r.days.length, 3, 'union of both sides\' days');
  const d1 = r.days[0], d2 = r.days[1], d3 = r.days[2];
  assert.deepEqual([d1.date, d1.qcdAbandoned, d1.inboundAbandoned, d1.inboundOnHold, d1.diff, d1.diffWithHold],
    ['2026-06-01', 5, 4, 1, -1, 0]);
  assert.deepEqual([d2.date, d2.qcdAbandoned, d2.inboundAbandoned, d2.diff],
    ['2026-06-02', 3, 0, -3], 'QCD-only day still listed');
  assert.deepEqual([d3.date, d3.qcdAbandoned, d3.inboundAbandoned, d3.diff],
    ['2026-06-03', 0, 2, 2], 'inbound-only day still listed');
  assert.deepEqual([r.totals.qcd, r.totals.inboundAbandoned, r.totals.inboundOnHold], [8, 6, 1]);
  // The inbound query scopes with the SAME dept predicate the report uses
  // (raw alias present) and counts both definitions.
  const sql = h.ctx.__cap.sqls[0];
  assert.ok(sql.indexOf("'A_Q_CSR'") !== -1, 'predicate carries the raw alias');
  assert.ok(/FILTER \(WHERE c\.disposition = 'abandoned'\)/.test(sql));
  assert.ok(/abandoned_on_hold/.test(sql), 'on-hold carve-out counted separately');
});

test('parity core: read-only (no INSERT/UPDATE/DELETE in any statement)', function () {
  const conn = installStubs([]);
  h.call('compareInboundVsQcdAbandons_', 'CSR', '2026-06-01', '2026-06-03', conn);
  h.ctx.__cap.sqls.forEach(function (sql) {
    assert.ok(!/insert|update|delete|drop|alter/i.test(sql), 'vetting tool never writes');
  });
});

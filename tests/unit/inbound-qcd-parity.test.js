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
  assert.ok(/FILTER \(WHERE c\.disposition = 'abandoned'/.test(sql));
  assert.ok(/abandoned_on_hold/.test(sql), 'on-hold carve-out counted separately');
});

// ---- 2026-07: the work-window scope -----------------------------------------
// QCD's Abandoned column only counts calls inside the 6:30 AM - 3:00 PM PST work
// window; inbound_calls captures around the clock. Comparing them unfiltered
// inflated the inbound side of every row (measured: 11 of CSR's 113 abandons in
// a 2-week window were out of hours, 9 of them after 3 PM PST at a 47% abandon
// rate). Out-of-window calls are RESEARCH data per the owner ruling -- reported,
// never folded into a dept metric.
test('parity: the inbound side is scoped to the PST work window', function () {
  const conn = installStubs([]);
  h.call('compareInboundVsQcdAbandons_', 'CSR', '2026-06-01', '2026-06-03', conn);
  const sql = h.ctx.__cap.sqls[0];
  assert.ok(sql.indexOf("c.call_start >= '06:30:00'") !== -1,
    'window start bound present, raw PST (call_start is NOT CST-shifted)');
  assert.ok(sql.indexOf("c.call_start < '15:00:00'") !== -1,
    'window end bound is half-open, matching the pipeline predicate');
  assert.ok(sql.indexOf('c.call_start IS NULL OR') !== -1,
    'pre-extension rows (NULL call_start) count as IN-window -- dropping them '
    + 'would silently shrink historical dates and read as a fixed gap');
});

test('parity: out-of-window calls are reported separately, never in the diff', function () {
  const conn = installStubs([
    { d: '2026-06-01', ab: 4, hold: 1, ab_outside: 3, calls_outside: 7 },
  ]);
  const r = h.call('compareInboundVsQcdAbandons_', 'CSR', '2026-06-01', '2026-06-03', conn);
  const d1 = r.days[0];
  assert.equal(d1.inboundAbandoned, 4, 'in-window abandons only');
  assert.equal(d1.diff, -1, 'diff is in-window vs QCD -- the out-of-window 3 must NOT leak in');
  assert.equal(d1.outsideWindowAbandoned, 3);
  assert.equal(d1.outsideWindowCalls, 7);
  assert.equal(r.totals.outsideWindowAbandoned, 3, 'tracked in totals for research');
  assert.equal(r.totals.outsideWindowCalls, 7);
  assert.equal(r.totals.inboundAbandoned, 4,
    'the dept-facing total stays in-window -- the whole point of the scope');
});

test('parity core: read-only (no INSERT/UPDATE/DELETE in any statement)', function () {
  const conn = installStubs([]);
  h.call('compareInboundVsQcdAbandons_', 'CSR', '2026-06-01', '2026-06-03', conn);
  h.ctx.__cap.sqls.forEach(function (sql) {
    assert.ok(!/insert|update|delete|drop|alter/i.test(sql), 'vetting tool never writes');
  });
});

// ---- Batch 5: the NO-entry_queue bucket ------------------------------------
// The unattributed-queue scan filters `COALESCE(entry_queue,'') <> ''`, so a
// call whose queue the capture never RECOGNIZED (entry_queue NULL) had no row to
// report -- the same filter that hides it from the Dept Config discovery panel.
// Those calls count in the ADMIN company view but attribute to NO dept, so they
// mechanically contribute to any "company total != sum of depts" gap, which is
// the shape of the discrepancy this check exists to settle.

test('Batch 5: the check probes calls with NO entry_queue and splits them by stage', function () {
  // Route each SQL to its own fixture: the run issues an unattributed-queue
  // scan and (new) a no-entry_queue aggregate.
  const rows = { unattr: [{ q: 'A_Q_Ghost', n: 7 }],
                 noq: [{ disposition: 'abandoned', stage: 'ivr', n: 41 },
                       { disposition: 'abandoned', stage: 'direct', n: 6 },
                       { disposition: 'answered', stage: '(n/a)', n: 12 }] };
  const sqls = [];
  const conn = {
    prepareStatement: function (sql) {
      sqls.push(sql);
      const noQueueProbe = /COALESCE\(entry_queue, ''\) = ''/.test(sql);
      const unattrProbe = /COALESCE\(entry_queue, ''\) <> ''/.test(sql);
      let done = false;
      return {
        setString: function () {}, setInt: function () {},
        executeQuery: function () {
          return {
            next: function () { if (done) return false; done = true; return true; },
            getString: function () {
              if (noQueueProbe) return JSON.stringify(rows.noq);
              if (unattrProbe) return JSON.stringify(rows.unattr);
              return JSON.stringify([]);           // the per-dept day joins
            },
            close: function () {},
          };
        },
        close: function () {},
      };
    },
    close: function () {},
  };
  installStubs([]);
  // Util.gs isn't loaded in this suite (it loads Config + InboundReport), so the
  // admin gate needs a stub -- the gate itself is pinned in escalations/auth tests.
  h.ctx.assertAdmin_ = function () {};
  h.ctx.getDashboardNeonConn_ = function () { return conn; };
  h.ctx.getAllDepartments_ = function () { return ['CSR']; };
  h.state.userEmail = 'admin@x.com';
  h.state.props.ADMIN_EMAILS = 'admin@x.com';

  const out = h.call('runInboundQcdParityCheck');
  assert.equal(out.available, true);
  assert.ok(Array.isArray(out.noEntryQueue), 'the new bucket is returned');
  assert.equal(out.noEntryQueue.length, 3, 'one entry per (disposition, stage)');
  const ivr = out.noEntryQueue.filter(function (r) {
    return r.disposition === 'abandoned' && r.stage === 'ivr';
  })[0];
  assert.ok(ivr, 'the abandoned+ivr slice -- where an unrecognized queue would hide');
  assert.equal(ivr.calls, 41);
  assert.ok(sqls.some(function (s) { return /COALESCE\(entry_queue, ''\) = ''/.test(s); }),
    'a probe for NULL/empty entry_queue actually ran');
  assert.ok(out.unattributed.length >= 0, 'the existing unattributed scan still runs');
});

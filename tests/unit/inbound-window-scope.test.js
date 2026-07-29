'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// 2026-07 work-window scope. QCD's Abandoned column only counts calls inside
// the 6:30 AM - 3:00 PM PST window; the inbound capture runs around the clock.
// Every DEPT-FACING inbound figure is therefore window-scoped, and out-of-window
// traffic is surfaced in its own research block that must never reach a dept
// metric (owner ruling). Measured when this shipped: 70 before-hours calls
// (2 abandoned), 2,494 in window (102), 19 after hours (9 -- a 47% abandon rate
// against 4.1% in window).
//
// See docs/known-issues.md "QCD Abandoned vs inbound_calls abandons".

const h = loadGas({ files: ['Config.gs', 'InboundReport.gs'] });

function fakeConn(payload) {
  const cap = { sqls: [] };
  const rs = function (json) {
    let done = false;
    return {
      next: function () { if (done) return false; done = true; return true; },
      getString: function () { return json; },
      close: function () {},
    };
  };
  const conn = {
    createStatement: function () {
      return {
        executeQuery: function (sql) {
          cap.sqls.push(sql);
          // the first_agent catalog probe returns an empty result
          if (/information_schema/.test(sql)) {
            return { next: function () { return false; }, close: function () {} };
          }
          return rs(JSON.stringify(payload));
        },
        close: function () {},
      };
    },
    close: function () {},
  };
  return { conn: conn, cap: cap };
}

function install() {
  h.ctx.computePriorWindow_ = function () { return { from: '2026-06-01', to: '2026-06-08' }; };
  h.ctx.inboundDialInLabels_ = function () { return {}; };
  h.ctx.coverageNoteUpsert_ = function () {};
}

test('window clause: in-window bound is raw PST and half-open; NULL counts as in-window', function () {
  install();
  const inside = h.call('inboundWindowClause_', true);
  assert.ok(inside.indexOf("c.call_start >= '06:30:00'") !== -1,
    'start bound is RAW PST -- call_start is not CST-shifted by the capture');
  assert.ok(inside.indexOf("c.call_start < '15:00:00'") !== -1,
    'end bound half-open, matching the pipeline predicate');
  assert.ok(/^\(c\.call_start IS NULL OR/.test(inside),
    'pre-extension rows (NULL call_start) count as IN-window; excluding them '
    + 'would silently shrink every historical date');
  assert.equal(h.call('inboundWindowClause_', false), 'NOT ' + inside,
    'the outside clause is the exact negation -- no call can fall in both, '
    + 'and none can fall in neither');
});

test('report: every dept-facing sub-select is window-scoped', function () {
  install();
  const f = fakeConn({ kpis: {}, kpisPrior: {}, byInsurer: [], byDialIn: [],
                       byQueue: [], byDialInInsurer: [], daily: [], outsideWindow: {} });
  h.ctx.getDashboardNeonConn_ = function () { return f.conn; };
  h.call('computeInboundReport_', { from: '2026-06-09', to: '2026-06-16',
    dept: 'CSR', deptQueues: ['A_Q_CSR'], companyView: false });

  const sql = f.cap.sqls.filter(function (q) { return !/information_schema/.test(q); })[0];
  // Guard against a future sub-select being added off an unscoped predicate.
  // Every ALIASED, row-filtering sub-select (`FROM inbound_calls c`) must carry
  // the window; the window clause appears once per such sub-select, including
  // the research block's negated copy.
  const froms = sql.split('FROM inbound_calls c').length - 1;
  const scoped = sql.split("c.call_start >= '06:30:00'").length - 1;
  assert.ok(froms >= 7, 'sanity: the payload really does have many sub-selects (' + froms + ')');
  assert.equal(scoped, froms,
    'every dept-facing FROM inbound_calls c must be window-scoped -- found ' + scoped
    + ' of ' + froms + '. A new sub-select was added off an unscoped predicate.');
  assert.ok(/NOT \(c\.call_start IS NULL/.test(sql),
    'the research block uses the negated clause');
  // ONE deliberate exemption: coverageStart asks "when did capture begin",
  // which is a data-availability fact, not a dept metric. It is unaliased and
  // unfiltered on purpose -- scoping it would move the reported coverage start
  // to the first in-window call and mis-warn on the client's coverage note.
  assert.ok(/'coverageStart', \(SELECT MIN\(call_date\)::text FROM inbound_calls\)/.test(sql),
    'coverageStart stays deliberately unscoped');
});

test('report: the research block is separate from kpis and never empty-shaped', function () {
  install();
  const f = fakeConn({
    kpis: { total: 2494, abandoned: 102 },
    kpisPrior: {}, byInsurer: [], byDialIn: [], byQueue: [], byDialInInsurer: [], daily: [],
    outsideWindow: { calls: 89, abandoned: 11, answered: 70,
                     beforeCalls: 70, beforeAbandoned: 2,
                     afterCalls: 19, afterAbandoned: 9 },
  });
  h.ctx.getDashboardNeonConn_ = function () { return f.conn; };
  const r = h.call('computeInboundReport_', { from: '2026-06-09', to: '2026-06-16',
    dept: 'CSR', deptQueues: ['A_Q_CSR'], companyView: false });

  assert.equal(r.kpis.total, 2494, 'KPIs are the in-window figures');
  assert.equal(r.kpis.abandoned, 102);
  assert.equal(r.outsideWindow.calls, 89);
  assert.equal(r.outsideWindow.afterAbandoned, 9);
  assert.equal(r.outsideWindow.abandonedPct, 12.4, '11/89 to one decimal');
  // The whole point of the ruling: an out-of-window call cannot reach a KPI.
  assert.ok(r.kpis.total < r.kpis.total + r.outsideWindow.calls,
    'outsideWindow is additive-but-separate, never folded into kpis.total');
});

test('report: outsideWindow is always present, zeroed, on the empty payload', function () {
  install();
  const e = h.call('emptyInboundReport_', { from: '2026-06-09', to: '2026-06-16',
    dept: 'CSR', deptQueues: [], companyView: false });
  assert.equal(e.outsideWindow.calls, 0);
  assert.equal(e.outsideWindow.abandonedPct, 0, 'no divide-by-zero on an empty block');
});

test('heatmap keeps its own INV-18 band and is NOT double-scoped', function () {
  install();
  const f = fakeConn([]);
  h.ctx.getDashboardNeonConn_ = function () { return f.conn; };
  h.ctx.CacheService = { getScriptCache: function () {
    return { get: function () { return null; }, put: function () {} }; } };
  h.ctx.inboundResolveRequest_ = function () {
    return { from: '2026-06-09', to: '2026-06-16', dept: 'CSR',
             deptQueues: ['A_Q_CSR'], companyView: false };
  };
  h.call('getInboundHeatmap', {});
  const sql = f.cap.sqls[0];
  // The heatmap band (8 AM - 5 PM CST) is the INV-18 display convention and is
  // 30 min WIDER at the start than the work window on purpose. Adding the
  // work-window clause on top would silently narrow the grid's first column.
  assert.ok(sql.indexOf("c.call_start >= '06:30:00'") === -1,
    'heatmap must NOT carry the work-window clause -- it is already bounded by '
    + 'INBOUND_HEATMAP_WINDOW_START_HOUR/END_HOUR (INV-18)');
  assert.ok(/28800/.test(sql) || /8 \* 3600/.test(sql) || sql.indexOf('28800') !== -1,
    'heatmap still bounded by its own 8 AM CST window start');
});


// -- the answered-on-hold carve-out's final_dept arm (2026-07) ----------------
// Measured: 146 answered-then-abandoned-on-hold calls in a 2-week window, and
// the parity check reported onHold=0.0 for EVERY dept on EVERY day. Cause:
// final_dept holds the raw CDR org-chart label ("Customer Success", "Inside
// Sales - Power Mobility", "Patient Intake - Supplies") and not one matches a
// dashboard dept header, so `lower(trim(final_dept)) = lower(<dept>)` never
// matched. The fix is an admin-authored label map that must stay ADDITIVE.

test('carve-out: with no label map the predicate is equivalent to the old one', function () {
  install();
  delete h.ctx.getFinalDeptLabels_;
  h.ctx.getFinalDeptLabels_ = function (d) { return [String(d).toLowerCase()]; };
  const p = h.call('inboundDeptPredicate_', 'CSR', ['A_Q_CSR']);
  assert.ok(p.indexOf("lower(trim(c.final_dept)) IN ('csr')") !== -1,
    'a dept with no mapped labels still matches its own name -- installs whose '
    + 'labels happen to match keep working with zero config');
});

test('carve-out: mapped labels all reach the SQL, lowercased', function () {
  install();
  h.ctx.getFinalDeptLabels_ = function () {
    return ['csr', 'customer success', 'patient care'];
  };
  const p = h.call('inboundDeptPredicate_', 'CSR', ['A_Q_CSR']);
  assert.ok(p.indexOf("IN ('csr','customer success','patient care')") !== -1,
    'every mapped label is matched, not just the first');
  // The two arms stay mutually exclusive: an on-hold answered call attributes
  // by final_dept, everything else by entry_queue. One call, one dept.
  assert.ok(/OR \(NOT \(c\.disposition='answered'/.test(p),
    'the entry-queue arm is still NOT-gated on the on-hold predicate');
  assert.ok(p.indexOf("c.entry_queue IN ('A_Q_CSR')") !== -1);
});

test('carve-out: a label with a quote is escaped, not injected', function () {
  install();
  h.ctx.getFinalDeptLabels_ = function () { return ["o'brien co"]; };
  const p = h.call('inboundDeptPredicate_', 'CSR', ['A_Q_CSR']);
  assert.ok(p.indexOf("'o''brien co'") !== -1,
    'labels are admin free text -- they must route through inboundSqlLit_');
});

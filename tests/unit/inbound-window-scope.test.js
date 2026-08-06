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
  // DeptConfig.gs is not loaded here; the union accessor is stubbed to a
  // realistic two-dept map so the carve-out tests below exercise the shape the
  // predicate actually sees in production.
  h.ctx.getAllFinalDeptLabels_ = function () {
    return ['csr', 'customer success', 'sales', 'inside sales'];
  };
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
  // The arms stay mutually exclusive for a MAPPED label: an on-hold answered
  // call attributes by final_dept, everything else by entry_queue. One call,
  // one dept. (An UNMAPPED label takes the entry-queue fallback -- below.)
  assert.ok(/OR \(\(NOT \(c\.disposition='answered'/.test(p),
    'the entry-queue arm is still NOT-gated on the on-hold predicate');
  // B-4: case-insensitive queue matching (lowercased literal, lower() column).
  assert.ok(p.indexOf("lower(trim(coalesce(c.entry_queue,''))) IN ('a_q_csr')") !== -1);
});

test('B-4: a case-mismatched configured queue name still attributes (both sides lowercased)', function () {
  // A Dept Config alias entered as 'A_Q_Csr' vs a stored raw 'A_Q_CSR' used to
  // attribute calls in the Missed report (case-insensitive) but silently NOT
  // here -- and the parity check could not see it, because the name LOOKS
  // mapped. Both predicates now lowercase both sides.
  install();
  const p = h.call('inboundDeptPredicate_', 'CSR', ['A_Q_Csr']);
  assert.ok(p.indexOf("IN ('a_q_csr')") !== -1,
    'the configured name is lowercased into the literal, matching any stored casing');
  const j = h.call('callJourneyDeptPredicate_', 'CSR', ['a_q_CSR']);
  assert.ok(j.indexOf("lower(trim(coalesce(c.entry_queue,''))) IN ('a_q_csr')") !== -1);
  assert.ok(j.indexOf("lower(trim(coalesce(c.final_queue,''))) IN ('a_q_csr')") !== -1);
});


// -- the unmapped-label fallback (2026-07, the Field Ops ambiguity) -----------
// An on-hold-answered call whose raw label is in NO dept's list used to
// attribute to NOBODY: the on-hold arm is exclusive, so the entry-queue arm was
// skipped and the call left every dept's report. It now falls back to the entry
// queue. This is what makes an AMBIGUOUS label safe to leave unmapped, which is
// the only correct handling: `Field Ops` and `Field Ops Power` carry both
// "Field Operations (...)" labels interchangeably, so mapping a shared label to
// both double-counts and mapping it to one steals the other's calls.

test('carve-out: an on-hold call with an UNMAPPED label falls back to the entry queue', function () {
  install();
  h.ctx.getFinalDeptLabels_ = function () { return ['field ops']; };
  const p = h.call('inboundDeptPredicate_', 'Field Ops', ['A_Q_FieldOps']);
  assert.ok(p.indexOf("NOT IN ('csr','customer success','sales','inside sales')") !== -1,
    'the fallback gates on the UNION of every dept\'s labels, not this dept\'s');
  assert.ok(/\(NOT \(c\.disposition='answered' AND COALESCE\(c\.abandoned_on_hold, false\)\) OR lower\(trim\(coalesce\(c\.final_dept,''\)\)\) NOT IN/.test(p),
    'the entry-queue arm fires when the call is NOT on-hold OR its label is unmapped');
});

test('carve-out: the fallback gates on the UNION so a mapped label cannot double-count', function () {
  install();
  // A call whose label is 'customer success' (mapped to CSR) but whose entry
  // queue is Sales's. CSR claims it via the label arm; Sales must NOT also
  // claim it via the fallback, or the dept totals exceed the company total.
  h.ctx.getFinalDeptLabels_ = function () { return ['sales', 'inside sales']; };
  const sales = h.call('inboundDeptPredicate_', 'Sales', ['A_Q_Sales']);
  // 'customer success' is in the union, so Sales's fallback excludes it.
  assert.ok(sales.indexOf("'customer success'") !== -1,
    "another dept's mapped label appears in the NOT IN union, closing the "
    + 'fallback for it -- this is the double-count guard');
  h.ctx.getFinalDeptLabels_ = function () { return ['csr', 'customer success']; };
  const csr = h.call('inboundDeptPredicate_', 'CSR', ['A_Q_CSR']);
  assert.ok(csr.indexOf("lower(trim(c.final_dept)) IN ('csr','customer success')") !== -1,
    'CSR still claims it by label -- exactly one dept counts the call');
});

test('carve-out: a blank/NULL final_dept takes the fallback, not oblivion', function () {
  install();
  h.ctx.getFinalDeptLabels_ = function () { return ['csr']; };
  const p = h.call('inboundDeptPredicate_', 'CSR', ['A_Q_CSR']);
  assert.ok(p.indexOf("coalesce(c.final_dept,'')") !== -1,
    'NULL is coalesced so `NOT IN` is TRUE rather than NULL -- three-valued '
    + 'logic would drop the row from BOTH arms (the L10 lesson)');
  // The empty string must never enter the union, or coalesce(...)='' would be
  // IN it and a label-less on-hold call would lose the fallback again.
  const withBlank = h.call('inboundDeptPredicate_', 'CSR', ['A_Q_CSR']);
  assert.ok(!/NOT IN \([^)]*''[^']/.test(withBlank),
    "the union must not contain '' -- getAllFinalDeptLabels_ skips empties");
});

test('carve-out: an unreadable label union fails OPEN to the entry queue', function () {
  install();
  h.ctx.getAllFinalDeptLabels_ = function () { return []; };
  h.ctx.getFinalDeptLabels_ = function () { return ['csr']; };
  const p = h.call('inboundDeptPredicate_', 'CSR', ['A_Q_CSR']);
  assert.ok(/OR \(\(NOT \(c\.disposition='answered' AND COALESCE\(c\.abandoned_on_hold, false\)\) OR true\)/.test(p),
    'an empty union makes every label look unmapped, so on-hold calls attribute '
    + 'by entry queue. Degrading to the entry queue is the safe direction: no '
    + 'dept loses calls and nothing can double-count');
});

test('carve-out: a label with a quote is escaped, not injected', function () {
  install();
  h.ctx.getFinalDeptLabels_ = function () { return ["o'brien co"]; };
  const p = h.call('inboundDeptPredicate_', 'CSR', ['A_Q_CSR']);
  assert.ok(p.indexOf("'o''brien co'") !== -1,
    'labels are admin free text -- they must route through inboundSqlLit_');
});

// ---- Round-16: internal-origin rows are metric-invisible --------------------
// Internal-origin queue calls (is_internal=TRUE, the journey-only capture for
// the Missed report's path drill) must be excluded from every METRIC query --
// and must NOT be excluded from the journey lookups, or the fix defeats
// itself. Count-based like the window guard above: a new metric sub-select
// that forgets the clause (or a journey query that gains it) moves a count.
const { test: testInt } = require('node:test');
const assertInt = require('node:assert/strict');
const fsInt = require('fs');
const pathInt = require('path');
const irSrcInt = fsInt.readFileSync(pathInt.join(__dirname, '..', '..',
  'apps-script', 'department-dashboard', 'InboundReport.gs'), 'utf8');

testInt('is_internal exclusion: on the 5 aliased metric ranges, the 4 parity queries, and nowhere else', function () {
  // (The two regexes are disjoint -- "(c.is_internal" never matches the bare
  // "(is_internal" pattern -- so no subtraction is needed.)
  const aliased = (irSrcInt.match(/COALESCE\(c\.is_internal, FALSE\) = FALSE/g) || []).length;
  const bare = (irSrcInt.match(/COALESCE\(is_internal, FALSE\) = FALSE/g) || []).length;
  assertInt.equal(aliased, 5,
    'aliased exclusions: report dr + insurer daily + heatmap + cell drill + compare');
  assertInt.equal(bare, 4,
    'bare exclusions: the two parity queue/call lists + the two parity breakdowns');
  // getCallJourney's two lookups (scoped + exact-id fallback) must include
  // internal rows -- pin by locality: no exclusion clause within the function.
  const fnStart = irSrcInt.indexOf('function getCallJourney');
  const fnSlice = irSrcInt.slice(fnStart, fnStart + 6000);
  assertInt.ok(fnStart !== -1 && fnSlice.indexOf('is_internal') === -1,
    'getCallJourney must NOT exclude internal rows -- serving them is the point');
});

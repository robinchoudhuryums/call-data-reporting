'use strict';

// QV-2 (owner 2026-10-29): getDayQuickView (DayQuickView.gs), the day quick
// view's ONE request. It adds no data path of its own -- each part is the
// existing public endpoint for a one-day window -- so the point here is the
// WRAPPER: the dept gate up front, the date list (ISO, deduped, at most 3),
// the SEC-1 cap, each part called with exactly that day (and the exception
// flag), outbound only when asked, a failing part reported per day while the
// others return, the inner usage rows suppressed and ONE `dayView` row logged
// (none for a prefetch), and the suppress switch restored even on a throw.
// The three endpoints are stubbed; their own suites pin them.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

const h = loadGas({ files: ['Config.gs', 'Util.gs', 'DayQuickView.gs'] });

function install(opts) {
  opts = opts || {};
  const log = { calls: [], usage: [] };
  h.ctx.REPORT_USAGE_SUPPRESS_ = false;
  h.ctx.resolveUser_ = function () { return opts.user || { role: 'admin', email: 'a@x.com' }; };
  h.ctx.getAllDepartments_ = function () { return ['CSR', 'Sales']; };
  h.ctx.logReportUsage_ = function (report, dept, user, hit) {
    if (h.ctx.REPORT_USAGE_SUPPRESS_) return;   // the real one's first line
    log.usage.push({ report: report, dept: dept, hit: hit });
  };
  const stub = function (name) {
    return function (req) {
      log.calls.push({ fn: name, req: JSON.parse(JSON.stringify(req)), suppressed: h.ctx.REPORT_USAGE_SUPPRESS_ });
      h.ctx.logReportUsage_(name, req.department, null, false);   // as the real endpoints do
      if (opts.throwOn && opts.throwOn[name]) throw new Error(opts.throwOn[name]);
      return { meta: { from: req.from, cacheHit: !!opts.allHit }, tag: name + ':' + req.from };
    };
  };
  h.ctx.getDepartmentSummary = stub('summary');
  h.ctx.getMissedCallsReport = stub('missed');
  h.ctx.getDeptOutboundSummary = stub('outbound');
  return log;
}

test('QV-2: one request returns each day\'s summary, missed calls and (asked-for) outbound, each part a one-day window', function () {
  const log = install();
  const out = h.call('getDayQuickView', { department: 'CSR', dates: ['2026-10-06', '2026-10-07'], outbound: true });
  assert.deepEqual(JSON.parse(JSON.stringify(out.meta.dates)), ['2026-10-06', '2026-10-07']);
  assert.equal(out.days['2026-10-06'].summary.tag, 'summary:2026-10-06');
  assert.equal(out.days['2026-10-07'].missed.tag, 'missed:2026-10-07');
  assert.equal(out.days['2026-10-07'].outbound.tag, 'outbound:2026-10-07');
  assert.deepEqual(JSON.parse(JSON.stringify(out.days['2026-10-06'].errors)), {});
  assert.equal(log.calls.length, 6);
  log.calls.forEach(function (c) {
    assert.equal(c.req.department, 'CSR');
    assert.equal(c.req.from, c.req.to, 'every part reads exactly one day');
    assert.equal(c.req.includeExceptionDays, undefined);
  });
  assert.ok(typeof out.meta.partMs['2026-10-06:summary'] === 'number', 'each part is timed');
});

test('QV-2: outbound is read only when asked; the exception-day flag reaches every part', function () {
  const log = install();
  const out = h.call('getDayQuickView', { department: 'CSR', dates: ['2026-10-19'], includeExceptionDays: true });
  assert.equal(out.days['2026-10-19'].outbound, null);
  assert.deepEqual(log.calls.map(function (c) { return c.fn; }), ['summary', 'missed']);
  log.calls.forEach(function (c) { assert.equal(c.req.includeExceptionDays, true); });
});

test('QV-2: a failing part is reported for its day and the others still return', function () {
  install({ throwOn: { outbound: 'The Outbound report is admin-only while it is being vetted.' } });
  const out = h.call('getDayQuickView', { department: 'CSR', dates: ['2026-10-06'], outbound: true });
  const d = out.days['2026-10-06'];
  assert.equal(d.outbound, null);
  assert.match(d.errors.outbound, /admin-only/);
  assert.ok(d.summary && d.missed, 'summary + missed unaffected');
});

test('QV-2: the inner usage rows are suppressed; ONE dayView row per request, none for a prefetch; the switch is restored', function () {
  let log = install();
  h.call('getDayQuickView', { department: 'CSR', dates: ['2026-10-06', '2026-10-07'], outbound: true });
  assert.ok(log.calls.every(function (c) { return c.suppressed === true; }), 'every part ran suppressed');
  assert.deepEqual(log.usage, [{ report: 'dayView', dept: 'CSR', hit: false }]);
  assert.equal(h.ctx.REPORT_USAGE_SUPPRESS_, false, 'restored after');
  log = install({ allHit: true });
  h.call('getDayQuickView', { department: 'CSR', dates: ['2026-10-06'] });
  assert.deepEqual(log.usage, [{ report: 'dayView', dept: 'CSR', hit: true }], 'a request served wholly from cache says so');
  log = install();
  h.call('getDayQuickView', { department: 'CSR', dates: ['2026-10-05', '2026-10-07'], prefetch: true });
  assert.deepEqual(log.usage, [], 'a prefetch logs nothing (it counts days nobody opened)');
  // A cache-warm context that already suppresses stays suppressed.
  log = install();
  h.ctx.REPORT_USAGE_SUPPRESS_ = true;
  h.call('getDayQuickView', { department: 'CSR', dates: ['2026-10-06'] });
  assert.equal(h.ctx.REPORT_USAGE_SUPPRESS_, true);
  assert.deepEqual(log.usage, []);
});

test('QV-2: the gates -- dept access up front, ISO dates, at most 3, deduped, the SEC-1 cap', function () {
  let log = install({ user: { role: 'manager', department: 'Sales', departments: ['Sales'] } });
  assert.throws(function () { h.call('getDayQuickView', { department: 'CSR', dates: ['2026-10-06'] }); }, /Not authorized for this department/);
  assert.equal(log.calls.length, 0, 'nothing is read for a department the viewer cannot reach');
  log = install({ user: { role: 'agent', agentName: 'Ann' } });
  assert.throws(function () { h.call('getDayQuickView', { department: 'CSR', dates: ['2026-10-06'] }); }, /Not authorized/);
  install({ user: { role: 'manager', department: 'CSR', departments: ['CSR'] } });
  assert.ok(h.call('getDayQuickView', { department: 'CSR', dates: ['2026-10-06'] }).days['2026-10-06'], 'a manager of the dept passes');
  install();
  assert.throws(function () { h.call('getDayQuickView', { department: '', dates: ['2026-10-06'] }); }, /Department is required/);
  assert.throws(function () { h.call('getDayQuickView', { department: 'CSR', dates: [] }); }, /At least one date/);
  assert.throws(function () { h.call('getDayQuickView', { department: 'CSR', dates: ['10/06/2026'] }); }, /YYYY-MM-DD/);
  assert.throws(function () { h.call('getDayQuickView', { department: 'CSR', dates: ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06'] }); },
    /At most 3/);
  assert.throws(function () { h.call('getDayQuickView', { department: 'CSR', dates: ['2023-01-02', '2026-10-06'] }); }, /capped at 731 days/);
  log = install();
  const out = h.call('getDayQuickView', { department: 'CSR', dates: ['2026-10-06', '2026-10-06'] });
  assert.deepEqual(JSON.parse(JSON.stringify(out.meta.dates)), ['2026-10-06'], 'duplicates collapse');
  assert.equal(log.calls.length, 2);
});

test('QV-2: the suppress switch is restored even when a part throws something the wrapper does not catch', function () {
  install();
  h.ctx.getMissedCallsReport = function () { h.ctx.REPORT_USAGE_SUPPRESS_ = 'tampered'; throw new Error('boom'); };
  const out = h.call('getDayQuickView', { department: 'CSR', dates: ['2026-10-06'] });
  assert.match(out.days['2026-10-06'].errors.missed, /boom/);
  assert.equal(h.ctx.REPORT_USAGE_SUPPRESS_, false);
});

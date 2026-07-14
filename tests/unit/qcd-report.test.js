'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deepEqual } = require('node:assert'); // legacy: prototype-agnostic for cross-realm vm values
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { rosterGrid } = require('../harness/fixtures');

// Batch-4 QCD fixes that needed parent/child + double-mapped fixtures
// (deferred from that batch): the F-15 daily date axis and the F-36
// all-departments grand-total dedup.

const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'Data.gs', 'DeptConfig.gs',
          'QCDReport.gs', 'CompanyOverview.gs'],
  capture: ['DEPT_CONFIG_HEADERS'],
});
const DC_HEADERS = h.consts.DEPT_CONFIG_HEADERS;

const QCD_HEADER = ['Month Year', 'Week', 'Date', 'Call Queue', 'Call Source',
  'Total Calls', 'Total Answered', 'Abandoned', 'Longest Wait', 'Avg Answer',
  'Abandoned %', 'Violations'];

function qcdRow(dateIso, queue, total, answered, abandoned, violations) {
  return ['', '', dateIso, queue, 'Total Calls', total, answered, abandoned,
          '0:01:00', '0:00:20', '', violations];
}

// Dept Config row (INV-54 header order): Department | QCD Queues |
// Overview Parent | Team Avg Excludes | Queue Ext Overrides | Active | ...
function dcRow(dept, queues, parent) {
  return [dept, queues, parent || '', '', '', 'TRUE', '', '', '', ''];
}

function install(roster, deptConfigRows, qcdRows) {
  h.state.userEmail = 'admin@x.com';
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.props.ADMIN_EMAILS = 'admin@x.com';
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: {
      'DO NOT EDIT!': roster,
      'Dept Config': [DC_HEADERS].concat(deptConfigRows),
      'QCD Historical Data': [QCD_HEADER].concat(qcdRows),
    },
  });
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  h.ctx.QCD_SHEET_DATA_MEMO_ = null;   // per-execution QCD sheet memo
  h.state.cache.clear();
}

test('F-15: the daily axis covers a sub-queue-only date (dept total zero-fills, child keeps its numbers)', function () {
  // Alpha owns A_Q_Alpha; Kid is a sub-queue dept (Overview parent = Alpha)
  // owning A_Q_Kid. June 2 has ONLY Kid activity -- pre-fix the axis came
  // from the own-queues dailyAcc, so June 2 vanished from the child's
  // daily line (and Insights' inherited queueHealth.trend daily series).
  install(
    rosterGrid({ Alpha: ['Anna, 201'], Kid: ['Kara, 301'] }),
    [dcRow('Alpha', 'A_Q_Alpha'), dcRow('Kid', 'A_Q_Kid', 'Alpha')],
    [
      qcdRow('2026-06-01', 'A_Q_Alpha', 100, 90, 10, 0),
      qcdRow('2026-06-02', 'A_Q_Kid',    50, 40, 10, 1),   // sub-queue ONLY
    ]);

  const rep = h.call('computeQcdReport_', 'Alpha', '2026-06-01', '2026-06-02',
    /*includeSubQueues=*/ true, /*separateSubQueues=*/ true);

  // The child queue is present, tagged, and excluded from the dept total.
  const kidRow = rep.queueBreakdown.filter(function (r) { return r.queue === 'A_Q_Kid'; })[0];
  assert.ok(kidRow, 'child queue row exists');
  assert.equal(kidRow.subDept, 'Kid');
  assert.equal(rep.totals.totalCalls, 100, 'dept total = own queues only');

  // F-15: the axis has BOTH dates; the sub-queue-only date zero-fills the
  // dept-total row (own queues genuinely had no calls that day)...
  const dates = rep.dailySeries.map(function (d) { return d.date; });
  deepEqual(dates, ['2026-06-01', '2026-06-02']);
  assert.equal(rep.dailySeries[1].totalCalls, 0);
  // ...while the child's per-queue daily line keeps its real numbers on
  // that date (pre-fix: the date was missing from perQueue entirely).
  const kidDaily = rep.perQueue['A_Q_Kid'].daily;
  assert.equal(kidDaily.length, 2);
  assert.equal(kidDaily[1].date, '2026-06-02');
  assert.equal(kidDaily[1].totalCalls, 50);
  assert.equal(kidDaily[1].violations, 1);
  // The parent's own line zero-fills the child-only date.
  assert.equal(rep.perQueue['A_Q_Alpha'].daily[1].totalCalls, 0);
});

test('F-36: a double-mapped queue counts ONCE in the company grand total (per-dept sections keep it under both)', function () {
  // A_Q_Shared is (mis)configured into BOTH Alpha's and Beta's queue
  // lists. The per-dept sections intentionally show it under both (the
  // M2 Overview decision) but the grand total must not double-count.
  install(
    rosterGrid({ Alpha: ['Anna, 201'], Beta: ['Ben, 401'] }),
    [dcRow('Alpha', 'A_Q_Shared'), dcRow('Beta', 'A_Q_Shared')],
    [qcdRow('2026-06-01', 'A_Q_Shared', 100, 90, 10, 2)]);

  const rep = h.call('getQcdAllDepartments', { from: '2026-06-01', to: '2026-06-01' });

  assert.equal(rep.depts.length, 2, 'both dept sections render');
  rep.depts.forEach(function (d) {
    assert.equal(d.totals.totalCalls, 100, d.dept + ' section shows the queue');
    assert.equal(d.totals.violations, 2);
  });
  // Grand total: 100 calls / 2 violations, NOT 200 / 4 (the pre-fix sum
  // of dept subtotals).
  assert.equal(rep.grandTotals.totalCalls, 100);
  assert.equal(rep.grandTotals.abandoned, 10);
  assert.equal(rep.grandTotals.violations, 2);
});

test('rangeOnly perf flag: queueBreakdown + totals are byte-identical to a full compute when out-of-range trend rows exist', function () {
  // The all-departments Daily Call Queue Report consumes ONLY
  // rep.queueBreakdown / rep.totals (it discards trendData / dailySeries /
  // perQueue), so getQcdAllDepartments passes rangeOnly=true to skip the
  // 12-month trend-window rows. This pins that the skip cannot alter the
  // range-scoped output: a full compute (which folds trend-only rows into
  // monthly buckets) and a rangeOnly compute must produce the same
  // queueBreakdown / totals.
  install(
    rosterGrid({ Alpha: ['Anna, 201'] }),
    [dcRow('Alpha', 'A_Q_Alpha')],
    [
      // In-range rows (the selected window).
      qcdRow('2026-06-01', 'A_Q_Alpha', 100, 90, 10, 1),
      qcdRow('2026-06-02', 'A_Q_Alpha',  80, 78,  2, 0),
      // Out-of-range but WITHIN the 12-month trend window -- a full compute
      // folds these into monthly buckets; rangeOnly must skip them without
      // touching queueBreakdown / totals.
      qcdRow('2026-03-15', 'A_Q_Alpha', 999, 111, 888, 9),
      qcdRow('2026-01-10', 'A_Q_Alpha', 500, 250, 250, 5),
    ]);

  const full = h.call('computeQcdReport_', 'Alpha', '2026-06-01', '2026-06-02',
    false, false, /*rangeOnly=*/ false);
  // Reset the per-execution QCD memo so the second compute re-reads cleanly.
  h.ctx.QCD_SHEET_DATA_MEMO_ = null;
  h.state.cache.clear();
  const ranged = h.call('computeQcdReport_', 'Alpha', '2026-06-01', '2026-06-02',
    false, false, /*rangeOnly=*/ true);

  // The range-scoped surfaces the all-dept report reads are identical.
  deepEqual(ranged.queueBreakdown, full.queueBreakdown);
  deepEqual(ranged.totals, full.totals);

  // Sanity: the range total reflects ONLY the two in-range days (180 calls),
  // never the out-of-range trend rows (which would have added 1499).
  assert.equal(full.totals.totalCalls, 180);
  assert.equal(ranged.totals.totalCalls, 180);
});

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
          'QCDReport.gs', 'CompanyOverview.gs', 'QueueReportEmail.gs'],
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

test('R12-24: violationsMtd sums month-to-date through the range end (range violations untouched)', function () {
  // Range = Jun 10 only (1 violation that day). Earlier SAME-month rows carry
  // 3 more violations; a PRIOR-month row carries 5 that must NOT count.
  install(
    rosterGrid({ Alpha: ['Anna, 201'] }),
    [dcRow('Alpha', 'A_Q_Alpha')],
    [
      qcdRow('2026-05-20', 'A_Q_Alpha', 50, 40, 10, 5),   // prior month: excluded from MTD
      qcdRow('2026-06-03', 'A_Q_Alpha', 60, 55,  5, 2),   // MTD, before the range
      qcdRow('2026-06-05', 'A_Q_Alpha', 60, 55,  5, 1),   // MTD, before the range
      qcdRow('2026-06-10', 'A_Q_Alpha', 80, 70, 10, 1),   // the selected day
    ]);
  const rep = h.call('getQcdAllDepartments', { from: '2026-06-10', to: '2026-06-10' });
  assert.equal(rep.depts.length, 1);
  const d = rep.depts[0];
  assert.equal(d.totals.violations, 1, 'range violations stay the selected day');
  assert.equal(d.totals.violationsMtd, 4, 'MTD = Jun 3 + Jun 5 + Jun 10 (2+1+1), May excluded');
  assert.equal(d.queues[0].violationsMtd, 4);
  assert.equal(rep.grandTotals.violations, 1);
  assert.equal(rep.grandTotals.violationsMtd, 4);
  // Counts/durations stay range-scoped: only Jun 10 rows.
  assert.equal(d.totals.totalCalls, 80);
});

// ---- Round-16: the MTD verdict block (owner spec) --------------------------
//
// The verdict band's MTD sub-lines compare month-start(range end)..end
// against the ENTIRE previous month -- a FULL-MONTH baseline, deliberately
// NOT the INV-28 same-length window (percentages are ratios; volume is
// compared as per-WORKDAY averages so unequal window lengths stay fair).

test('mtd block: month windows, workday counts, and totals include a dept quiet on the range day', function () {
  // Jun 10 2026 = Wednesday. MTD Jun 1(Mon)..Jun 10 = 8 workdays.
  // Prior = ALL of May 2026 = 21 workdays (no COMPANY_HOLIDAYS set).
  // Beta has MTD activity but ZERO calls on the range day -- it is omitted
  // from depts[] (the legacy active-queues rule) yet MUST still contribute
  // to the company MTD totals, which is why the accumulation sits before
  // the dTotal===0 skip.
  install(
    rosterGrid({ Alpha: ['Anna, 201'], Beta: ['Ben, 401'] }),
    [dcRow('Alpha', 'A_Q_Alpha'), dcRow('Beta', 'A_Q_Beta')],
    [
      qcdRow('2026-06-10', 'A_Q_Alpha', 100, 90, 10, 0),   // the selected day
      qcdRow('2026-06-03', 'A_Q_Alpha',  50, 45,  5, 0),   // MTD, before the range
      qcdRow('2026-06-04', 'A_Q_Beta',   30, 30,  0, 0),   // MTD only -- Beta quiet on Jun 10
      qcdRow('2026-05-15', 'A_Q_Alpha', 200, 180, 20, 0),  // prior month
      qcdRow('2026-05-20', 'A_Q_Beta',  100, 95,  5, 0),   // prior month
      qcdRow('2026-04-30', 'A_Q_Alpha', 999, 1, 998, 0),   // outside BOTH windows
    ]);
  const rep = h.call('getQcdAllDepartments', { from: '2026-06-10', to: '2026-06-10' });

  assert.equal(rep.depts.length, 1, 'Beta (quiet on the range day) is not a section');
  const m = rep.mtd;
  assert.ok(m, 'payload carries the mtd block');
  assert.equal(m.from, '2026-06-01');
  assert.equal(m.to, '2026-06-10');
  assert.equal(m.priorFrom, '2026-05-01');
  assert.equal(m.priorTo, '2026-05-31', 'prior window is the FULL previous month');
  assert.equal(m.priorLabel, 'May');
  assert.equal(m.workdays, 8);
  assert.equal(m.priorWorkdays, 21);
  assert.equal(m.totalCalls, 180, 'MTD totals include the quiet dept (100+50+30)');
  assert.equal(m.answered, 165);
  assert.equal(m.abandoned, 15);
  assert.ok(Math.abs(m.abandonedPct - (15 / 180 * 100)) < 1e-9);
  assert.equal(m.priorTotalCalls, 300, 'April row excluded');
  assert.equal(m.priorAnswered, 275);
  assert.equal(m.priorAbandoned, 25);
  // Round-16 Option 1: each queue row carries its own MTD/prior-month call
  // totals (per-queue pace sub-line + CSV), from the same window passes.
  const alphaQ = rep.depts[0].queues[0];
  assert.equal(alphaQ.mtdTotalCalls, 150, 'Alpha queue MTD = Jun 3 + Jun 10 (50+100)');
  assert.equal(alphaQ.priorTotalCalls, 200, 'Alpha queue prior = the May row');
});

test('mtd block: the F-36 unique-queue dedup applies to MTD and prior-month totals too', function () {
  install(
    rosterGrid({ Alpha: ['Anna, 201'], Beta: ['Ben, 401'] }),
    [dcRow('Alpha', 'A_Q_Shared'), dcRow('Beta', 'A_Q_Shared')],
    [
      qcdRow('2026-06-01', 'A_Q_Shared', 100, 90, 10, 0),
      qcdRow('2026-05-10', 'A_Q_Shared', 80, 75, 5, 0),
    ]);
  const rep = h.call('getQcdAllDepartments', { from: '2026-06-01', to: '2026-06-01' });
  assert.equal(rep.mtd.totalCalls, 100, 'double-mapped queue counts once in MTD');
  assert.equal(rep.mtd.priorTotalCalls, 80, 'and once in the prior month');
});

test('mtd block: the email KPI tiles render the MTD sub-lines (and omit them without mtd)', function () {
  install(
    rosterGrid({ Alpha: ['Anna, 201'] }),
    [dcRow('Alpha', 'A_Q_Alpha')],
    [
      qcdRow('2026-06-10', 'A_Q_Alpha', 100, 90, 10, 0),
      qcdRow('2026-06-03', 'A_Q_Alpha',  50, 45,  5, 0),
      qcdRow('2026-05-15', 'A_Q_Alpha', 210, 190, 20, 0),
    ]);
  const rep = h.call('getQcdAllDepartments', { from: '2026-06-10', to: '2026-06-10' });
  const html = h.call('buildQueueReportEmailHtml_', rep, '2026-06-10', false);
  // ('MTD' alone is a weak marker -- the Viol column header carries it too.)
  // MTD avg = 150 calls / 8 workdays = 18.75 -> 19/day; prior 210/21 = 10/day.
  assert.ok(html.indexOf('19/day') !== -1, 'volume sub-line is a per-workday average');
  assert.ok(html.indexOf('pts vs May') !== -1, 'percent deltas name the prior month');
  // A payload with no mtd (defensive path) renders the pre-v6 tiles.
  const stripped = JSON.parse(JSON.stringify(rep));
  delete stripped.mtd;
  const html2 = h.call('buildQueueReportEmailHtml_', stripped, '2026-06-10', false);
  assert.ok(html2.indexOf('/day') === -1 && html2.indexOf('pts vs') === -1,
    'no mtd block -> no MTD sub-lines');
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

// ── #3: QCD Neon read-back parity (QCD_READ_SOURCE=neon) ───────────────────
// computeQcdReport_ must produce an IDENTICAL report whether it reads the QCD
// sheet (default) or qcd_history via neonFetchQcdGrid_. A fake JDBC connection
// serves json_agg payloads built from the SAME logical rows the sheet fixture
// holds -- honoring the bound date params, so the windowed read is exercised.

// One logical dataset -> both sources. source defaults to 'Total Calls' and
// the durations match qcdRow ('0:01:00' longest / '0:00:20' avg).
const QDATA = [
  { date: '2026-06-01', queue: 'A_Q_Alpha', total: 100, answered: 90, abandoned: 10, violations: 1 },
  { date: '2026-06-02', queue: 'A_Q_Alpha', total: 80,  answered: 78, abandoned: 2,  violations: 0 },
  { date: '2026-06-02', queue: 'A_Q_Kid',   total: 50,  answered: 40, abandoned: 10, violations: 1 },
  // Older row (inside the 12-mo trend window, outside the selected range).
  { date: '2026-03-15', queue: 'A_Q_Alpha', total: 40,  answered: 38, abandoned: 2,  violations: 0 },
];

function qcdSheetRowsFromData() {
  return QDATA.map(function (d) {
    return qcdRow(d.date, d.queue, d.total, d.answered, d.abandoned, d.violations);
  });
}

function qcdNeonRowsFor(fromIso, toIso) {
  return QDATA
    .filter(function (d) { return d.date >= fromIso && d.date <= toIso; })
    .map(function (d) {
      return {
        d: d.date, call_queue: d.queue, call_source: 'Total Calls',
        total_calls: d.total, total_answered: d.answered, abandoned: d.abandoned,
        longest_wait: '0:01:00', avg_answer: '0:00:20', violations: d.violations,
      };
    });
}

function fakeQcdConn() {
  const rsFor = function (json) {
    let consumed = false;
    return {
      next: function () { if (consumed) return false; consumed = true; return true; },
      getString: function () { return json; },
      close: function () {},
    };
  };
  return {
    prepareStatement: function (sql) {
      const params = {};
      return {
        setString: function (i, v) { params[i] = v; },
        executeQuery: function () {
          if (sql.indexOf('FROM qcd_history WHERE call_date BETWEEN') !== -1) {
            return rsFor(JSON.stringify(qcdNeonRowsFor(params[1], params[2])));
          }
          throw new Error('Unexpected prepared SQL: ' + sql);
        },
        close: function () {},
      };
    },
    createStatement: function () {
      return {
        executeQuery: function (sql) {
          if (sql.indexOf('MAX(call_date)') !== -1) {
            const max = QDATA.map(function (d) { return d.date; }).sort().pop();
            return rsFor(max);   // neonGetMaxQcdDate_ reads getString('d') -> the ISO
          }
          throw new Error('Unexpected SQL: ' + sql);
        },
        close: function () {},
      };
    },
    close: function () {},
  };
}

function installQcd(source) {
  install(
    rosterGrid({ Alpha: ['Anna, 201'], Kid: ['Kara, 301'] }),
    [dcRow('Alpha', 'A_Q_Alpha'), dcRow('Kid', 'A_Q_Kid', 'Alpha')],
    qcdSheetRowsFromData());
  h.ctx.QCD_NEON_GRID_MEMO_ = null;   // reset the per-window Neon memo too
  h.ctx.QCD_SHEET_DATA_MEMO_ = null;  // R-1: snapshots share the whole-sheet memo now
  if (source === 'neon') {
    h.state.props.QCD_READ_SOURCE = 'neon';
    h.ctx.getDashboardNeonConn_ = fakeQcdConn;
  } else {
    delete h.state.props.QCD_READ_SOURCE;
    h.ctx.getDashboardNeonConn_ = function () { return null; };
  }
}

function scrubQcd(rep) {
  const c = JSON.parse(JSON.stringify(rep));
  if (c.meta) delete c.meta.generatedAt;
  return c;
}

test('#3 QCD Neon parity: computeQcdReport_ is identical from sheet and Neon (full trend path)', function () {
  installQcd('sheet');
  const fromSheet = scrubQcd(h.call('computeQcdReport_', 'Alpha', '2026-06-01', '2026-06-02', true, true));
  installQcd('neon');
  const fromNeon = scrubQcd(h.call('computeQcdReport_', 'Alpha', '2026-06-01', '2026-06-02', true, true));

  assert.equal(JSON.stringify(fromNeon), JSON.stringify(fromSheet),
    'queueBreakdown, totals, dailySeries, trendData all match across sources');
  // Sanity: non-trivial (own queue total = 180; child excluded from dept total).
  assert.equal(fromSheet.totals.totalCalls, 180);
  const kid = fromSheet.queueBreakdown.filter(function (r) { return r.queue === 'A_Q_Kid'; })[0];
  assert.equal(kid.subDept, 'Kid');
  // The older trend-window row folds into the monthly series identically.
  assert.ok(fromSheet.trendData.series.length > 0);
});

test('#3 QCD Neon parity: rangeOnly path identical across sources', function () {
  installQcd('sheet');
  const s = scrubQcd(h.call('computeQcdReport_', 'Alpha', '2026-06-01', '2026-06-02', false, false, true));
  installQcd('neon');
  const n = scrubQcd(h.call('computeQcdReport_', 'Alpha', '2026-06-01', '2026-06-02', false, false, true));
  assert.equal(JSON.stringify(n), JSON.stringify(s));
});

test('#3 QCD Neon fallback: neon flag with no connection serves the sheet result', function () {
  installQcd('neon');
  h.ctx.getDashboardNeonConn_ = function () { return null; };   // Neon down
  h.ctx.QCD_NEON_GRID_MEMO_ = null;
  const fallback = scrubQcd(h.call('computeQcdReport_', 'Alpha', '2026-06-01', '2026-06-02', true, true));
  installQcd('sheet');
  const sheet = scrubQcd(h.call('computeQcdReport_', 'Alpha', '2026-06-01', '2026-06-02', true, true));
  assert.equal(JSON.stringify(fallback), JSON.stringify(sheet), 'graceful fallback, no throw');
});

test('#3 QCD Neon parity: getQcdAllDepartments (the Daily Call Queue Report) identical across sources', function () {
  installQcd('sheet');
  const s = h.call('getQcdAllDepartments', { from: '2026-06-01', to: '2026-06-02' });
  installQcd('neon');
  const n = h.call('getQcdAllDepartments', { from: '2026-06-01', to: '2026-06-02' });
  // Scrub run-volatile meta (cacheHit / computeMs).
  const scrub = function (d) { const c = JSON.parse(JSON.stringify(d)); if (c.meta) { delete c.meta.cacheHit; delete c.meta.computeMs; } return c; };
  assert.equal(JSON.stringify(scrub(n)), JSON.stringify(scrub(s)),
    'company grand total + per-dept sections match across sources');
  // Each dept lists its OWN queues (includeChildren:false): Alpha's A_Q_Alpha
  // (100+80) as one section, Kid's A_Q_Kid (50) as its own section. Grand
  // total dedups by unique queue name: 180 + 50 = 230.
  assert.equal(s.grandTotals.totalCalls, 230);
  assert.equal(s.depts.length, 2, 'Alpha and Kid each render as their own section');
});

// ── R-1: the three formerly sheet-hardwired QCD readers honor the flag ──────

test('R-1: computeQcdSnapshots_ (Overview chips) identical from sheet and Neon', function () {
  installQcd('sheet');
  const s = h.call('computeQcdSnapshots_', ['Alpha', 'Kid'], '2026-06-01', 'America/Chicago');
  installQcd('neon');
  const n = h.call('computeQcdSnapshots_', ['Alpha', 'Kid'], '2026-06-01', 'America/Chicago');
  assert.equal(JSON.stringify(n), JSON.stringify(s), 'per-dept snapshots match across sources');
  assert.ok(s.Alpha, 'Alpha snapshot present (sanity: fixture rows in window)');
});

test('R-1: computeDeptQcdSnapshot_ (My Department panel) identical from sheet and Neon', function () {
  installQcd('sheet');
  const s = h.call('computeDeptQcdSnapshot_', 'Alpha', 'America/Chicago',
    { from: '2026-06-01', to: '2026-06-02' });
  installQcd('neon');
  const n = h.call('computeDeptQcdSnapshot_', 'Alpha', 'America/Chicago',
    { from: '2026-06-01', to: '2026-06-02' });
  assert.equal(JSON.stringify(n), JSON.stringify(s), 'panel payload matches across sources');
  assert.ok(s && s.date, 'sanity: non-null snapshot with a latest date');
});

test('Round-16: qcdSnapshot ships mtdPrior (ENTIRE previous month) + workday counts for the MTD-view deltas', function () {
  // Latest data day Jun 10 2026 (Wed) -> MTD anchor month June: Jun 1(Mon)..
  // Jun 10 = 8 workdays; prior = ALL of May = 21 workdays. April excluded.
  install(
    rosterGrid({ Alpha: ['Anna, 201'] }),
    [dcRow('Alpha', 'A_Q_Alpha')],
    [
      qcdRow('2026-06-10', 'A_Q_Alpha', 100, 90, 10, 1),
      qcdRow('2026-06-03', 'A_Q_Alpha',  50, 45,  5, 0),
      qcdRow('2026-05-15', 'A_Q_Alpha', 200, 180, 20, 2),
      qcdRow('2026-04-30', 'A_Q_Alpha', 999, 1, 998, 9),   // outside both windows
    ]);
  // The R-1 parity tests above leave QCD_READ_SOURCE='neon' + a stubbed conn
  // behind; this test reads the SHEET fixture.
  h.state.props.QCD_READ_SOURCE = '';
  const snap = h.call('computeDeptQcdSnapshot_', 'Alpha', 'America/Chicago', {});
  assert.ok(snap && snap.mtd, 'snapshot with an mtd block');
  assert.equal(snap.mtdStart, '2026-06-01');
  assert.equal(snap.mtdPriorStart, '2026-05-01');
  assert.equal(snap.mtdPriorEnd, '2026-05-31', 'prior window is the FULL previous month');
  assert.equal(snap.mtdPriorLabel, 'May');
  assert.equal(snap.mtdWorkdays, 8);
  assert.equal(snap.mtdPriorWorkdays, 21);
  assert.equal(snap.mtd.totalCalls, 150, 'MTD = Jun 3 + Jun 10');
  assert.equal(snap.mtdPrior.totalCalls, 200, 'prior = the May row only');
  assert.equal(snap.mtdPrior.abandoned, 20);
  // Same builder both sides: the per-queue pages line up by queue name.
  assert.equal(snap.mtdPrior.perQueue.length, 1);
  assert.equal(snap.mtdPrior.perQueue[0].queue, 'A_Q_Alpha');
});

test('R-1: neonGetMaxQcdDate_ serves the freshness pill QCD component; null falls back', function () {
  installQcd('neon');
  assert.equal(h.call('neonGetMaxQcdDate_'), '2026-06-02');
  h.ctx.getDashboardNeonConn_ = function () { return null; };   // Neon down
  assert.equal(h.call('neonGetMaxQcdDate_'), null, 'no conn -> null (caller falls back to the sheet scan)');
});

test('R-1: neon flag with Neon down falls back to the sheet for both snapshot readers', function () {
  installQcd('neon');
  h.ctx.getDashboardNeonConn_ = function () { return null; };
  h.ctx.QCD_NEON_GRID_MEMO_ = null;
  const fb = h.call('computeDeptQcdSnapshot_', 'Alpha', 'America/Chicago',
    { from: '2026-06-01', to: '2026-06-02' });
  installQcd('sheet');
  const s = h.call('computeDeptQcdSnapshot_', 'Alpha', 'America/Chicago',
    { from: '2026-06-01', to: '2026-06-02' });
  assert.equal(JSON.stringify(fb), JSON.stringify(s), 'graceful sheet fallback, no throw');
});

test('#3 getQcdReadSource_ defaults to sheet, honors explicit neon', function () {
  installQcd('sheet');
  assert.equal(h.call('getQcdReadSource_'), 'sheet');
  h.state.props.QCD_READ_SOURCE = 'NEON';   // case-insensitive
  assert.equal(h.call('getQcdReadSource_'), 'neon');
  h.state.props.QCD_READ_SOURCE = 'garbage';
  assert.equal(h.call('getQcdReadSource_'), 'sheet');
});

// ---- R5: parity-gate ±1s duration tolerance ----------------------------------
// The writer's normalizeDuration Math.round(serial*86400) and Sheets' display
// formatter round a half-second average to DIFFERENT sides of the boundary
// (20.4999...96 -> 20 vs "0:00:21"), deterministically -- re-import reproduces
// it. The gate ignores ±1s on the two duration fields (counts stay exact) so
// that float noise can't block the QCD_READ_SOURCE flip, while >1s drift and
// any count difference still fail.
function parityGrids_(sheetAvg, neonAvg, sheetCalls, neonCalls) {
  const mk = function (avg, calls) {
    const row = ['', '', '2026-06-24', 'A_Q_Alpha', 'Total Calls',
                 calls, calls, 0, '0:01:00', avg, '', 0];
    return { values: [row], displays: [row.map(String)], ssTZ: 'America/Chicago' };
  };
  h.ctx.readQcdSheetData_ = function () { return mk(sheetAvg, sheetCalls); };
  h.ctx.neonFetchQcdGrid_ = function () { return mk(neonAvg, neonCalls); };
}

function parityRun_() {
  const lines = [];
  const realLogger = h.ctx.Logger;
  h.ctx.Logger = { log: function () {
    let s = String(arguments[0]);
    for (let i = 1; i < arguments.length; i++) s = s.replace(/%s/, String(arguments[i]));
    lines.push(s);
  } };
  let out;
  try { out = h.call('compareQcdSources_'); } finally { h.ctx.Logger = realLogger; }
  parityRun_.last = out;   // Batch 6: the gate returns a structured verdict now
  return lines.join('\n');
}

test('R5: ±1s avgAnswer rounding diff is IGNORED (gate passes, diff surfaced as rounding)', function () {
  installQcd('sheet');
  h.state.props.QCD_PARITY_FROM = '2026-06-24';
  h.state.props.QCD_PARITY_TO = '2026-06-24';
  parityGrids_('0:00:21', '0:00:20', 10, 10);
  const log = parityRun_();
  assert.match(log, /QCD PARITY CLEAN/, 'off-by-one duration must not block the flip');
  assert.match(log, /rounding diffs \(IGNORED/, 'the ignored diff is still surfaced');
});

test('R5: >1s duration drift and count differences still FAIL the gate', function () {
  installQcd('sheet');
  h.state.props.QCD_PARITY_FROM = '2026-06-24';
  h.state.props.QCD_PARITY_TO = '2026-06-24';
  parityGrids_('0:00:25', '0:00:20', 10, 10);
  assert.match(parityRun_(), /QCD PARITY MISMATCH/, '5s apart is real drift');
  parityGrids_('0:00:20', '0:00:20', 10, 9);
  assert.match(parityRun_(), /QCD PARITY MISMATCH/, 'counts stay exact');
});

// ---- Batch 6: the read-source gates must not pass on ZERO comparisons -------
// This is what made Batch 6 (flip QCD_READ_SOURCE) unsafe: with no comparable
// rows on either side -- the in-source default range is a fixed week that ages
// out of the data, or a typo'd/future QCD_PARITY_* property, or a trimmed sheet
// -- all three mismatch counters were 0 and the gate printed
// "QCD PARITY CLEAN ... gate PASSED" having compared NOTHING. neonFetchQcdGrid_
// returns a non-null EMPTY grid for an empty range, so the !neonGrid guard does
// not cover it. Same false-clean class CORE-5/F-5 fixed for the CONFIG gates.

function parityEmpty_(opts) {
  const o = opts || {};
  const grid = function (rows) {
    return { values: rows || [], displays: (rows || []).map(function () { return []; }),
             ssTZ: 'America/Chicago', missing: false };
  };
  h.ctx.readQcdSheetData_ = function () { return grid(o.sheetRows); };
  h.ctx.neonFetchQcdGrid_ = function () { return grid(o.neonRows); };
}

test('Batch 6: ZERO comparable rows is INCONCLUSIVE, never CLEAN', function () {
  installQcd('sheet');
  h.state.props.QCD_PARITY_FROM = '2030-01-01';   // a range the data cannot cover
  h.state.props.QCD_PARITY_TO = '2030-01-07';
  parityEmpty_({ sheetRows: [], neonRows: [] });
  const log = parityRun_();
  assert.doesNotMatch(log, /QCD PARITY CLEAN/, 'must NOT claim a pass on an empty comparison');
  assert.match(log, /INCONCLUSIVE/, 'says so explicitly');
  assert.match(log, /Do NOT flip QCD_READ_SOURCE/, 'tells the operator not to act on it');
  const v = parityRun_.last;
  assert.equal(v.clean, false, 'structured verdict is not clean');
  assert.equal(v.compared, 0, 'reports that nothing was compared');
  assert.ok(v.error, 'carries a reason');
});

test('Batch 6: an unreachable Neon grid is not-clean WITH a reason (no silent undefined)', function () {
  installQcd('sheet');
  h.state.props.QCD_PARITY_FROM = '2026-06-24';
  h.state.props.QCD_PARITY_TO = '2026-06-24';
  h.ctx.readQcdSheetData_ = function () {
    return { values: [], displays: [], ssTZ: 'America/Chicago', missing: false };
  };
  h.ctx.neonFetchQcdGrid_ = function () { return null; };   // unreachable / unconfigured
  parityRun_();
  const v = parityRun_.last;
  assert.equal(v.clean, false);
  assert.match(v.error, /Neon grid unavailable/);
});

test('Batch 6: a missing QCD sheet is not-clean WITH a reason', function () {
  installQcd('sheet');
  h.ctx.readQcdSheetData_ = function () { return { missing: true }; };
  parityRun_();
  const v = parityRun_.last;
  assert.equal(v.clean, false);
  assert.match(v.error, /sheet missing/);
});

test('Batch 6: a REAL clean run reports clean + the rows it compared', function () {
  installQcd('sheet');
  h.state.props.QCD_PARITY_FROM = '2026-06-24';
  h.state.props.QCD_PARITY_TO = '2026-06-24';
  parityGrids_('0:00:20', '0:00:20', 10, 10);   // identical sides
  const log = parityRun_();
  assert.match(log, /QCD PARITY CLEAN/);
  const v = parityRun_.last;
  assert.equal(v.clean, true);
  assert.ok(v.compared > 0, 'a pass must be backed by real compared rows');
});

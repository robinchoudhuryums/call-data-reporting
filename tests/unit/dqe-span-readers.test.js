'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
// legacy: prototype-agnostic for cross-realm vm values (the compute-summary
// convention -- an array built inside the vm fails deepStrictEqual on its
// prototype alone, which says nothing about the values under test).
const { deepEqual } = require('node:assert');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { dqeRow, dqeSheet, rosterGrid } = require('../harness/fixtures');

// R41: the five DQE readers that bypassed the DAL and never adopted R26b's
// bounded-span read -- computeSummary_ (charged PER DEPT), the Individual
// Report, Insights, computeActiveAgentsInRange_ and the alert engine. Each ran
// its own whole-sheet getRange + getValues + getDisplayValues to answer a
// windowed question. They now share dqeWindowRowSpan_.
//
// Two properties decide whether that transform is correct, and the existing
// per-reader suites can see NEITHER, because their fixtures are date-ordered
// and window-local:
//
//   (1) OUT-OF-ORDER rows. `DQE Historical Data` is not reliably date-ordered
//       -- a backfill of older dates appends after newer rows -- so a tail
//       scan would stop early and silently drop them. A span cannot: an
//       out-of-order row merely widens it. The per-row date filter has to
//       survive too, since the span contains out-of-range rows in the middle.
//
//   (2) The ALL-HISTORY ext derivation. Four of the five ALSO derive
//       deptQueueExts from the same bulk grid, and that derivation needs every
//       extension a roster agent has EVER used, not the window's. Feeding it
//       the span would silently shrink the set and change which floaters are
//       recognized -- a behavior change wearing an optimization's clothes, and
//       the one way this refactor could have shipped looking green.

const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'CompanyOverview.gs',
          'QCDReport.gs', 'DeptConfig.gs', 'Data.gs', 'IndividualReport.gs',
          'InsightsReport.gs', 'Alerts.gs'],
});

// Cara is on Beta's roster, so she is a FLOATER into Alpha whenever her rows
// carry one of Alpha's data-derived queue extensions.
const ROSTER = rosterGrid({
  Alpha: ['Anna, 201', 'Ben, 202'],
  Beta:  ['Cara, 301'],
});

function install(rows) {
  h.state.userEmail = 'admin@x.com';
  h.state.props = { SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' };
  h.state.spreadsheet = makeFakeSpreadsheet({
    timeZone: 'America/Chicago',
    sheets: { 'DO NOT EDIT!': ROSTER, 'DQE Historical Data': dqeSheet(rows) },
  });
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  h.ctx.DQE_DATE_BOUNDS_MEMO_ = null;
  h.ctx.DQE_SHEET_ROWS_MEMO_ = null;
  h.ctx.ALERT_DATE_ROWS_MEMO_ = null;
  h.state.cache.clear();
}

/** Counts wide (full-width) reads of DQE Historical Data. */
function r41CountWideReads() {
  const sheet = h.state.spreadsheet.getSheetByName('DQE Historical Data');
  const real = sheet.getRange;
  let wide = 0;
  sheet.getRange = function (startRow, startCol, numRows, numCols) {
    // The ext slice is cols A..D; the aggregation read is the full width.
    if (numCols && numCols > 4) wide++;
    return real.apply(sheet, arguments);
  };
  return { get count() { return wide; }, restore: function () { sheet.getRange = real; } };
}

/**
 * The backfill shape: an OLDER date sitting AFTER newer rows. A tail scan
 * stops at the newer block and never reaches 03-09; a span reaches back to it.
 * The 02-01 row in the middle is out of window and must still be filtered out
 * by the per-row check the span does not replace.
 */
function outOfOrderRows() {
  return [
    dqeRow({ date: '2026-03-10', agent: 'Anna', ext: '501', rung: 10, missed: 2, answered: 8, ttt: '0:20:00', att: '0:02:30' }),
    // 03-09 starts here...
    dqeRow({ date: '2026-03-09', agent: 'Ben',  ext: '501', rung: 2, missed: 0, answered: 2, ttt: '0:04:00', att: '0:02:00' }),
    // ...FOREIGN dates sit in the middle of the span. Two of them, because the
    // readers fetch different widths: 02-01 is outside computeSummary_'s and
    // the alert engine's windows but INSIDE IR's and Insights' (they fetch
    // [trendStart, to] for the 12-month trend), so only a row older than the
    // trend start can prove THEIR per-row filter is load-bearing.
    dqeRow({ date: '2026-02-01', agent: 'Anna', ext: '501', rung: 99, missed: 99, answered: 99, ttt: '9:00:00', att: '0:09:00' }),
    dqeRow({ date: '2024-01-02', agent: 'Anna', ext: '501', rung: 500, missed: 500, answered: 500, ttt: '9:00:00', att: '0:09:00' }),
    dqeRow({ date: '2026-03-10', agent: 'Ben',  ext: '501', rung: 6,  missed: 1, answered: 5, ttt: '0:10:00', att: '0:02:00' }),
    // ...and the backfilled 03-09 remainder is appended LAST -- the whole point.
    dqeRow({ date: '2026-03-09', agent: 'Anna', ext: '501', rung: 4, missed: 1, answered: 3, ttt: '0:08:00', att: '0:02:40' }),
  ];
}

test('R41: computeSummary_ returns every windowed row when a backfill sits out of order', function () {
  install(outOfOrderRows());
  const data = h.call('computeSummary_', 'Alpha', '2026-03-09', '2026-03-10', 'both');
  const anna = data.rows.filter(function (r) { return r.agent === 'Anna'; })[0];
  const ben  = data.rows.filter(function (r) { return r.agent === 'Ben'; })[0];
  // Both days counted for both agents -- the trailing 03-09 block included.
  assert.equal(anna.totalRung, 14, 'the out-of-order 03-09 row is not dropped');
  assert.equal(anna.totalAnswered, 11);
  assert.equal(anna.daysActive, 2);
  assert.equal(ben.totalRung, 8);
  // And the out-of-WINDOW row that sits INSIDE the span is still excluded --
  // the span bounds the read, the per-row filter does the filtering.
  assert.ok(anna.totalRung < 99, 'the 2026-02-01 row inside the span is filtered out');
});

test('R41: a span read equals the full scan it replaced, whatever the row order', function () {
  const rows = outOfOrderRows();
  install(rows);
  const spanned = h.call('computeSummary_', 'Alpha', '2026-03-09', '2026-03-10', 'both');

  // Same data, sorted by date: the span now covers a contiguous leading block,
  // so this is the arrangement the OLD unbounded scan and the new one must
  // agree on. Any divergence means the span changed the answer.
  const sorted = rows.slice().sort(function (a, b) {
    return String(a.vals[1]).localeCompare(String(b.vals[1]));
  });
  install(sorted);
  const ordered = h.call('computeSummary_', 'Alpha', '2026-03-09', '2026-03-10', 'both');

  const scrub = function (d) {
    const c = JSON.parse(JSON.stringify(d));
    if (c.meta) { delete c.meta.generatedAt; delete c.meta.computeMs; delete c.meta.cacheHit; }
    return c;
  };
  assert.deepEqual(scrub(spanned), scrub(ordered), 'row order cannot change the payload');
});

test('R41: the dept ext set stays ALL-HISTORY -- a floater is recognized on an ext seen only OUTSIDE the window', function () {
  // 501 is Alpha's derived queue ext, and it appears ONLY on a roster row
  // dated well before the report window. Cara (Beta's roster) rings 501 inside
  // the window, so she is an Alpha floater -- but ONLY if the ext derivation
  // still scans all history. Derive it from the window's span instead and 501
  // is unknown, Cara silently stops being a floater, and nothing else fails.
  install([
    dqeRow({ date: '2026-01-05', agent: 'Anna', ext: '501', rung: 5, answered: 5 }),
    dqeRow({ date: '2026-03-10', agent: 'Anna', ext: '',    rung: 10, missed: 2, answered: 8 }),
    dqeRow({ date: '2026-03-10', agent: 'Cara', ext: '501', rung: 7,  missed: 1, answered: 6 }),
  ]);

  const active = h.call('computeActiveAgentsInRange_', 'Alpha', '2026-03-10', '2026-03-10',
                        h.call('getRosterForDepartment_', 'Alpha'));
  const floaterNames = active.floaters.map(function (f) { return f.name; });
  deepEqual(floaterNames, ['Cara'],
    'Cara stays a floater on an extension only an out-of-window row proves is Alpha\'s');
  deepEqual(active.agents, ['Anna']);

  // Same property through computeSummary_'s own derivation: scope 'both'
  // surfaces the floater row, which requires the same all-history ext set.
  install([
    dqeRow({ date: '2026-01-05', agent: 'Anna', ext: '501', rung: 5, answered: 5 }),
    dqeRow({ date: '2026-03-10', agent: 'Anna', ext: '',    rung: 10, missed: 2, answered: 8 }),
    dqeRow({ date: '2026-03-10', agent: 'Cara', ext: '501', rung: 7,  missed: 1, answered: 6 }),
  ]);
  const data = h.call('computeSummary_', 'Alpha', '2026-03-10', '2026-03-10', 'both');
  const cara = data.rows.filter(function (r) { return r.agent === 'Cara'; })[0];
  assert.ok(cara, 'computeSummary_ still matches the floater via the all-history ext set');
  assert.equal(cara.matchedViaRoster, false);
});

test('R41: a window with no rows at all skips the wide read entirely', function () {
  install(outOfOrderRows());
  const c = r41CountWideReads();
  let data;
  try {
    data = h.call('computeSummary_', 'Alpha', '2026-06-01', '2026-06-30', 'both');
    // The point is the READ, not the result: an unbounded scan also returns
    // nothing here (the per-row filter drops every row), so asserting only on
    // the payload would pass with the span removed.
    assert.equal(c.count, 0, 'an empty window costs no full-width read at all');
  } finally { c.restore(); }
  assert.equal(data.rows.length, 0, 'and the payload is empty, not a throw');
  assert.equal(data.totals.totalRung, 0);
});

test('R41: a populated window costs exactly ONE full-width read', function () {
  install(outOfOrderRows());
  const c = r41CountWideReads();
  try {
    h.call('computeSummary_', 'Alpha', '2026-03-09', '2026-03-10', 'both');
    assert.equal(c.count, 1, 'the span is read once; the ext slice is narrow');
  } finally { c.restore(); }
});

test('R41: the alert engine reads its one day out of an out-of-order sheet', function () {
  install(outOfOrderRows());
  const rows = h.call('alertRowsForDate_', '2026-03-09');
  const byAgent = {};
  rows.forEach(function (r) { byAgent[r.agent] = r; });
  assert.equal(rows.length, 2, 'both 03-09 rows found though they trail newer dates');
  assert.equal(byAgent.Anna.rung, 4);
  assert.equal(byAgent.Ben.answered, 2);
  // The alert engine's date test is exact-match, so nothing from 03-10 or
  // 02-01 may leak in even though both sit inside the scanned span.
  assert.ok(!rows.some(function (r) { return r.rung === 10 || r.rung === 99; }),
    'other dates inside the span do not leak into a single-day read');
  // This is the reader where the per-row date check is LOAD-BEARING: it has no
  // second window gate, so the span must bound the read and the filter must do
  // the filtering. (computeSummary_ re-filters in its aggregation loop against
  // from/to + priorFrom/priorTo, so its read-side check is belt-and-braces.)
});

test('R41: IR and Insights read their windows out of an out-of-order sheet', function () {
  install(outOfOrderRows());
  const ir = h.call('computeIndividualReport_', 'Alpha', '2026-03-09', '2026-03-10', ['Anna'], h.call('getRosterForDepartment_', 'Alpha'));
  const card = ir.summaryData.filter(function (r) { return r.name === 'Anna'; })[0];
  assert.ok(card, 'IR renders the agent');
  assert.equal(card.raw.rung, 14, 'IR sees both days incl. the trailing backfill');
  // NB the 2024 row cannot be used to pin IR's read-side date filter: the
  // trend buckets by a fixed 12-month month-key list, so an out-of-window row
  // is dropped by the bucketing whether or not the read filtered it. Measured,
  // not assumed -- removing IR's filter leaves this suite green. Same for
  // computeSummary_ (its aggregation loop re-checks from/to and
  // priorFrom/priorTo). The alert engine above is the ONE reader whose
  // read-side filter is genuinely load-bearing, and that is where it is pinned.
  // Everywhere else the filter is defense-in-depth and stays for the rule's
  // sake, not because a test can prove it.

  install(outOfOrderRows());
  const ins = h.call('computeInsights_', 'Alpha', '2026-03-09', '2026-03-10', [], h.call('getRosterForDepartment_', 'Alpha'));
  assert.ok(ins.teamStats, 'Insights renders');
  assert.equal(ins.teamStats.rung.val, 22, 'Insights sums both agents across both days');
});

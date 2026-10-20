'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

// F-14: the Overview tile's "X viol MTD" count. computeQcdSnapshots_'s
// single row filter used to run the 30-day snapshot-window check BEFORE the
// MTD accumulation, so once the month outgrew the window (day 31 of a
// 31-day month) the early days' violations silently dropped from the chip
// while the QCD modal's full-scan MTD kept them. The fix keeps a row when
// it is inside the window OR inside the current month.

const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Data.gs', 'DeptConfig.gs', 'QCDReport.gs', 'CompanyOverview.gs'],
});

const QCD_HEADER = ['Month Year', 'Week', 'Date', 'Call Queue', 'Call Source',
  'Total Calls', 'Total Answered', 'Abandoned', 'Longest Wait', 'Avg Answer',
  'Abandoned %', 'Violations'];

function qcdRow(dateIso, queue, violations) {
  return ['', '', dateIso, queue, 'Total Calls', 100, 90, 10, '0:01:00', '0:00:20', '10.0%', violations];
}

function iso(d) {
  const p = function (n) { return n < 10 ? '0' + n : String(n); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

test('F-14: MTD violations survive the snapshot-window filter', function () {
  // Anchor to the REAL current month (mtdStart is computed from the live
  // clock inside computeQcdSnapshots_). sinceIso = tomorrow, so BOTH rows
  // are "before the window" -- the old filter dropped both; the fixed
  // filter must keep the current-month row (MTD) and still drop the
  // previous-month row.
  const now = new Date();
  const firstOfMonth = iso(new Date(now.getFullYear(), now.getMonth(), 1, 12));
  const prevMonthMid = iso(new Date(now.getFullYear(), now.getMonth() - 1, 15, 12));
  const tomorrow     = iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12));

  // 'CSR' resolves queues via the DEPT_QCD_QUEUES constant (no Dept Config
  // sheet installed -> constant fallback, INV-54). Use its first queue.
  h.state.props.SPREADSHEET_ID = 'fake';
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  h.ctx.QCD_SHEET_DATA_MEMO_ = null;   // R-1: snapshots now read via readQcdGrid_ (memoized)
  h.ctx.QCD_NEON_GRID_MEMO_ = null;
  const csrQueues = h.call('getDeptQcdQueues_', 'CSR');
  assert.ok(csrQueues.length > 0, 'CSR has constant-mapped queues');
  const q = csrQueues[0];

  h.state.spreadsheet = makeFakeSpreadsheet({
    sheets: {
      'QCD Historical Data': [QCD_HEADER,
        qcdRow(firstOfMonth, q, 3),   // current month, outside the window -> MTD must keep it
        qcdRow(prevMonthMid, q, 7),   // previous month, outside the window -> still dropped
      ],
    },
  });
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  h.ctx.QCD_SHEET_DATA_MEMO_ = null;   // R-1: snapshots now read via readQcdGrid_ (memoized)
  h.ctx.QCD_NEON_GRID_MEMO_ = null;

  const out = h.call('computeQcdSnapshots_', ['CSR'], tomorrow, 'America/Chicago');
  assert.ok(out.CSR, 'CSR snapshot exists (the MTD row keeps the dept alive)');
  // Old code: 0 (row dropped before MTD accumulation). Wrong-in-the-other-
  // direction would be 10 (prev month leaking in). Correct: 3.
  assert.equal(out.CSR.violationsMtd, 3);
});

// #1: per-day abandoned series feeding the Overview chart's Abandoned metric
// views. computeQcdSnapshots_ accumulates a per-dept `daily` map (iso ->
// {totalCalls, abandoned}) for IN-WINDOW rows (>= sinceIso), summed across the
// dept's queues; formatDept turns it into trendAbandoned / trendAbandonedPct.
function qcdRowTA(dateIso, queue, total, abandoned) {
  return ['', '', dateIso, queue, 'Total Calls', total, total - abandoned, abandoned,
          '0:01:00', '0:00:20', '', 0];
}

test('#1: per-day abandoned series accumulates in-window rows + excludes pre-window', function () {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  h.ctx.QCD_SHEET_DATA_MEMO_ = null;   // R-1: snapshots now read via readQcdGrid_ (memoized)
  h.ctx.QCD_NEON_GRID_MEMO_ = null;
  const q = h.call('getDeptQcdQueues_', 'CSR')[0];
  const since = '2026-06-01';
  h.state.spreadsheet = makeFakeSpreadsheet({
    sheets: {
      'QCD Historical Data': [QCD_HEADER,
        qcdRowTA('2026-06-02', q, 100, 8),    // in window
        qcdRowTA('2026-06-03', q, 50, 5),     // in window
        qcdRowTA('2026-05-20', q, 200, 40),   // BEFORE window -> excluded from daily
      ],
    },
  });
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  h.ctx.QCD_SHEET_DATA_MEMO_ = null;   // R-1: snapshots now read via readQcdGrid_ (memoized)
  h.ctx.QCD_NEON_GRID_MEMO_ = null;

  const out = h.call('computeQcdSnapshots_', ['CSR'], since, 'America/Chicago');
  assert.ok(out.CSR && out.CSR.daily, 'daily map present on the snapshot');
  assert.equal(out.CSR.daily['2026-06-02'].abandoned, 8);
  assert.equal(out.CSR.daily['2026-06-02'].totalCalls, 100);
  assert.equal(out.CSR.daily['2026-06-03'].abandoned, 5);
  assert.equal(out.CSR.daily['2026-06-03'].totalCalls, 50);
  assert.ok(!out.CSR.daily['2026-05-20'], 'pre-window date excluded from the daily series');
});

// summary:v12: the My Department QCD side-panel period toggle (Yesterday / MTD).
// computeDeptQcdSnapshot_ ships the latest-day block at the top level (Yesterday)
// PLUS an `mtd` block (+ `mtdStart`) summing every row in the latest date's
// calendar month up to that date. Same block shape; latest-day fields untouched.
test('summary:v12: QCD snapshot carries an MTD block summing the latest month', function () {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  h.ctx.QCD_SHEET_DATA_MEMO_ = null;   // R-1: snapshots now read via readQcdGrid_ (memoized)
  h.ctx.QCD_NEON_GRID_MEMO_ = null;
  const q = h.call('getDeptQcdQueues_', 'CSR')[0];
  h.state.spreadsheet = makeFakeSpreadsheet({
    sheets: {
      // Two days in the same month + one prior-month day. Latest day is 06-15.
      'QCD Historical Data': [QCD_HEADER,
        qcdRowTA('2026-06-01', q, 100, 10),   // in month, before latest
        qcdRowTA('2026-06-15', q, 40, 4),      // latest day
        qcdRowTA('2026-05-31', q, 200, 50),    // prior month -> excluded from MTD
      ],
    },
  });
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  h.ctx.QCD_SHEET_DATA_MEMO_ = null;   // R-1: snapshots now read via readQcdGrid_ (memoized)
  h.ctx.QCD_NEON_GRID_MEMO_ = null;

  const snap = h.call('computeDeptQcdSnapshot_', 'CSR', 'America/Chicago');
  assert.ok(snap, 'snapshot returned');
  // Yesterday (top-level) = the latest day only.
  assert.equal(snap.date, '2026-06-15');
  assert.equal(snap.totalCalls, 40);
  assert.equal(snap.abandoned, 4);
  // MTD block: 06-01 + 06-15, excluding the 05-31 prior-month row.
  assert.ok(snap.mtd, 'mtd block present');
  assert.equal(snap.mtdStart, '2026-06-01');
  assert.equal(snap.mtd.totalCalls, 140);
  assert.equal(snap.mtd.abandoned, 14);
});

// R10-5 (summary:v14): the range block carries an answered-weighted average
// answer time over the dept's own queues, parsed from the Avg Answer DISPLAY
// strings (INV-02). The Yesterday/MTD blocks don't accumulate it -> null.
function qcdRowAvg(dateIso, queue, answered, avgAnswer) {
  return ['', '', dateIso, queue, 'Total Calls', answered, answered, 0,
          '0:01:00', avgAnswer, '', 0];
}

test('R10-5: range block avgAnswer is answered-weighted; other blocks stay null', function () {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  h.ctx.QCD_SHEET_DATA_MEMO_ = null;
  h.ctx.QCD_NEON_GRID_MEMO_ = null;
  const q = h.call('getDeptQcdQueues_', 'CSR')[0];
  h.state.spreadsheet = makeFakeSpreadsheet({
    sheets: {
      'QCD Historical Data': [QCD_HEADER,
        qcdRowAvg('2026-06-02', q, 90, '0:00:20'),   // 90 answered @ 20s
        qcdRowAvg('2026-06-03', q, 10, '0:01:00'),   // 10 answered @ 60s
      ],
    },
  });
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  h.ctx.QCD_SHEET_DATA_MEMO_ = null;
  h.ctx.QCD_NEON_GRID_MEMO_ = null;

  const snap = h.call('computeDeptQcdSnapshot_', 'CSR', 'America/Chicago',
    { from: '2026-06-01', to: '2026-06-30' });
  assert.ok(snap && snap.range, 'range block present');
  // Weighted: (20*90 + 60*10) / 100 = 24s -- NOT the 40s row-mean.
  assert.equal(snap.range.avgAnswerSec, 24);
  assert.equal(snap.range.avgAnswer, '0:00:24');
  // Yesterday / MTD blocks never accumulate it.
  assert.equal(snap.avgAnswerSec, null);
  assert.equal(snap.mtd.avgAnswerSec, null);
  // R11-C1: no prior window supplied -> no prior block.
  assert.equal(snap.rangePrior, null);
});

// R11-C1 (summary:v15): the E5 prior window rides into the snapshot as a
// second range block, so the Avg-answer tile can chip its delta. Same
// single-scan accumulation; disjoint windows bucket independently.
test('R11-C1: rangePrior accumulates the prior window separately from range', function () {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  h.ctx.QCD_SHEET_DATA_MEMO_ = null;
  h.ctx.QCD_NEON_GRID_MEMO_ = null;
  const q = h.call('getDeptQcdQueues_', 'CSR')[0];
  h.state.spreadsheet = makeFakeSpreadsheet({
    sheets: {
      'QCD Historical Data': [QCD_HEADER,
        qcdRowAvg('2026-06-10', q, 50, '0:00:30'),   // current window: 30s
        qcdRowAvg('2026-06-03', q, 50, '0:01:00'),   // prior window: 60s
      ],
    },
  });
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  h.ctx.QCD_SHEET_DATA_MEMO_ = null;
  h.ctx.QCD_NEON_GRID_MEMO_ = null;

  const snap = h.call('computeDeptQcdSnapshot_', 'CSR', 'America/Chicago',
    { from: '2026-06-08', to: '2026-06-12', priorFrom: '2026-06-01', priorTo: '2026-06-05' });
  assert.ok(snap && snap.range && snap.rangePrior, 'both blocks present');
  assert.equal(snap.range.avgAnswerSec, 30);
  assert.equal(snap.range.totalCalls, 50);
  assert.equal(snap.rangePrior.avgAnswerSec, 60);
  assert.equal(snap.rangePrior.totalCalls, 50);
  assert.equal(snap.rangePrior.from, '2026-06-01');
});

// R10-5: CSR-only dept transfer stats from CSR Transfer Historical Data --
// weighted sum(Transferred)/sum(Total Calls) over in-range rows; null for
// non-CSR depts and missing sheets (best-effort, the dashboard's first read
// of that INV-52 sheet).
const CSR_TR_HEADER = ['Month Year', 'Week', 'Date', 'Agent', 'Trans %',
  'Total Calls', 'Transferred'];

test('R10-5: computeCsrTransferRange_ weights by calls, scopes to range, gates to CSR', function () {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.spreadsheet = makeFakeSpreadsheet({
    sheets: {
      'CSR Transfer Historical Data': [CSR_TR_HEADER,
        ['', '', '2026-06-02', 'Agent A', '10.0%', 100, 10],
        ['', '', '2026-06-03', 'Agent B', '40.0%', 50, 20],
        ['', '', '2026-05-20', 'Agent A', '90.0%', 200, 180],   // out of range
      ],
    },
  });
  const out = h.call('computeCsrTransferRange_', 'CSR', '2026-06-01', '2026-06-30');
  assert.ok(out, 'CSR in-range rows produce a block');
  // Weighted: 30/150 = 20.0% -- NOT the 25% mean of the per-row Trans %.
  assert.equal(out.pct, 20);
  assert.equal(out.pctStr, '20.0%');
  assert.equal(out.transferred, 30);
  assert.equal(out.totalCalls, 150);
  assert.equal(out.days, 2);
  // Non-CSR dept -> null (server ships the tile only for CSR).
  assert.equal(h.call('computeCsrTransferRange_', 'Sales', '2026-06-01', '2026-06-30'), null);
  // Missing sheet -> null, never a throw.
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {} });
  assert.equal(h.call('computeCsrTransferRange_', 'CSR', '2026-06-01', '2026-06-30'), null);
});

// L4 (broad-scan 2026-08-27): the Neon-path read window must cover the E5
// PRIOR window too -- `_readFrom` considered opts.from but never
// opts.priorFrom, so a selection reaching near/past the 180-day lookback
// silently truncated byQueueRangePrior (the team-strip delta chips' prior
// side) on the Neon path; a from older than the lookback truncated it
// entirely.
test('L4: the snapshot read window starts at priorFrom when it precedes from and the lookback', function () {
  const captured = [];
  const realGrid = h.ctx.readQcdGrid_;
  h.ctx.readQcdGrid_ = function (fromIso, toIso) {
    captured.push([fromIso, toIso]);
    return { missing: true };   // window captured; snapshot cleanly nulls out
  };
  try {
    const out = h.call('computeDeptQcdSnapshot_', 'CSR', null,
      { from: '2025-01-10', to: '2025-01-20', priorFrom: '2024-12-27', priorTo: '2025-01-09' });
    assert.equal(out, null, 'missing grid -> null snapshot (unchanged)');
    assert.equal(captured.length, 1);
    assert.equal(captured[0][0], '2024-12-27',
      'the read starts at priorFrom, not min(from, 180d lookback)');
  } finally { h.ctx.readQcdGrid_ = realGrid; }
});

// D-1 (broad-scan 2026-09-17): the month start was `new Date(y, m, 1)` -- a
// SCRIPT-TZ midnight instant -- formatted in the SPREADSHEET's TZ. Chicago is
// CDT (UTC-5) from March to November while Mexico City stays UTC-6, so that
// instant rendered as the previous month's LAST day and every "viol MTD" chip
// and Insights violationsMtd on the sheet path counted it. The F-14 test above
// passed 'America/Chicago' as ssTZ (same-tz) and so could not see it. This
// pins the live pair under a DST-month clock.
function atInstant_(isoUtc, fn) {
  const RealDate = h.ctx.Date;
  const fixed = RealDate.parse(isoUtc);
  function FakeDate() {
    if (arguments.length === 0) return new RealDate(fixed);
    return new RealDate(...arguments);
  }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.parse = RealDate.parse;
  FakeDate.now = function () { return fixed; };
  h.ctx.Date = FakeDate;
  try { return fn(); } finally { h.ctx.Date = RealDate; }
}

test('D-1: MTD violations start on the 1st in the SCRIPT TZ, never the sheet-TZ render of a script-midnight instant', function () {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  h.ctx.QCD_SHEET_DATA_MEMO_ = null;
  h.ctx.QCD_NEON_GRID_MEMO_ = null;
  const q = h.call('getDeptQcdQueues_', 'CSR')[0];
  h.state.spreadsheet = makeFakeSpreadsheet({
    sheets: {
      'QCD Historical Data': [QCD_HEADER,
        qcdRow('2026-08-31', q, 7),   // last day of the PREVIOUS month -- must NOT count
        qcdRow('2026-09-01', q, 3),   // first of the current month -- must count
        qcdRow('2026-09-10', q, 2),
      ],
    },
  });
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  h.ctx.QCD_SHEET_DATA_MEMO_ = null;
  h.ctx.QCD_NEON_GRID_MEMO_ = null;
  // Sept 15 2026, 18:00 UTC = 13:00 CDT = 12:00 Mexico City: a DST-split day.
  atInstant_('2026-09-15T18:00:00Z', function () {
    assert.equal(h.call('mtdStartIso_'), '2026-09-01', 'the shared resolver is a script-TZ calendar string');
    // The live pair: script America/Chicago (shim), spreadsheet America/Mexico_City.
    const out = h.call('computeQcdSnapshots_', ['CSR'], '2026-09-16', 'America/Mexico_City');
    assert.ok(out.CSR, 'CSR snapshot exists');
    assert.equal(out.CSR.violationsMtd, 5, 'Sep 1 + Sep 10 only; Aug 31 (7) must not leak in');
    // The same rule through the Insights / QCD-report helper.
    const grid = [qcdRow('2026-08-31', q, 7), qcdRow('2026-09-01', q, 3), qcdRow('2026-09-10', q, 2)];
    assert.equal(h.call('computeMtdViolations_', 'CSR', grid, 'America/Mexico_City'), 5);
  });
});

// QO-1 (broad-scan 2026-10-01): MTD is month-to-date through the LATEST QCD
// DATE, not through today (the D-8 rule My Department and the emails follow).
// On the 1st the latest data is still last month's, and the chip read a green
// "0 viol MTD" beside last month's numbers. The month's 1st also sits outside
// a 30-day window on the 1st, so the snapshot must read back to it.
test('QO-1: on the 1st, MTD covers the latest data date\'s month -- from its 1st, never the month before', function () {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  h.ctx.QCD_SHEET_DATA_MEMO_ = null;
  h.ctx.QCD_NEON_GRID_MEMO_ = null;
  const q = h.call('getDeptQcdQueues_', 'CSR')[0];
  h.state.spreadsheet = makeFakeSpreadsheet({
    sheets: {
      'QCD Historical Data': [QCD_HEADER,
        qcdRow('2026-08-31', q, 7),   // the month before -- must NOT count
        qcdRow('2026-09-01', q, 3),   // outside the 30-day window, inside the latest month
        qcdRow('2026-09-30', q, 2),   // the latest data date
      ],
    },
  });
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  h.ctx.QCD_SHEET_DATA_MEMO_ = null;
  h.ctx.QCD_NEON_GRID_MEMO_ = null;
  atInstant_('2026-10-01T15:00:00Z', function () {
    const out = h.call('computeQcdSnapshots_', ['CSR'], '2026-09-02', 'America/Chicago');
    assert.ok(out.CSR);
    assert.equal(out.CSR.date, '2026-09-30');
    assert.equal(out.CSR.violationsMtd, 5, 'Sep 1 + Sep 30; pre-fix this was 0 (October had no rows yet)');
  });
});

test('QO-1: the Neon path re-reads from the latest month\'s 1st when the window starts after it', function () {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  const q = h.call('getDeptQcdQueues_', 'CSR')[0];
  const all = [qcdRow('2026-09-01', q, 3), qcdRow('2026-09-30', q, 2)];
  const reads = [];
  const realGrid = h.ctx.readQcdGrid_;
  h.ctx.readQcdGrid_ = function (from, to) {
    reads.push(from + '..' + to);
    const rows = all.filter(function (r) { return r[2] >= from && r[2] <= to; });
    return { values: rows, displays: rows.map(function (r) { return r.map(String); }) };
  };
  try {
    atInstant_('2026-10-01T15:00:00Z', function () {
      const out = h.call('computeQcdSnapshots_', ['CSR'], '2026-09-02', 'America/Chicago');
      assert.deepEqual(reads, ['2026-09-02..2026-10-01', '2026-09-01..2026-10-01']);
      assert.equal(out.CSR.violationsMtd, 5);
    });
  } finally { h.ctx.readQcdGrid_ = realGrid; }
});

// DATA-4 (broad-scan 2026-10-12): on the Neon path an unreachable Neon falls
// back to the sheet; when that copy is missing or trimmed below the window the
// snapshot is empty, and the readers used to return it UNflagged -- the
// payload then cached for 6 h with no Queue panel or chips. Now the execution
// is flagged (the D-5 skip-put rule), but ONLY when it actually fell back.
test('DATA-4: an empty snapshot after a Neon fallback flags the execution; the same empty window on the sheet path does not', function () {
  const reset = function () {
    h.state.props.SPREADSHEET_ID = 'fake';
    h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null; h.ctx.QCD_SHEET_DATA_MEMO_ = null; h.ctx.QCD_NEON_GRID_MEMO_ = null;
    h.call('resetExecReadFailureFlags_');
  };
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {} });   // the fallback sheet is gone
  // Neon path, Neon unreachable.
  reset();
  h.state.props.QCD_READ_SOURCE = 'neon';
  const realFetch = h.ctx.neonFetchQcdGrid_;
  h.ctx.neonFetchQcdGrid_ = function () { return null; };
  try {
    assert.equal(h.call('computeDeptQcdSnapshot_', 'CSR', 'America/Chicago', {}), null);
    assert.equal(h.call('qcdSnapshotReadFailed_'), true, 'the per-dept snapshot flags it');
    reset();
    h.call('computeQcdSnapshots_', ['CSR'], '2026-10-01', 'America/Chicago');
    assert.equal(h.call('qcdSnapshotReadFailed_'), true, 'the Overview snapshot flags it');
  } finally {
    h.ctx.neonFetchQcdGrid_ = realFetch;
    delete h.state.props.QCD_READ_SOURCE;
  }
  // Sheet path, same missing sheet: a genuinely empty source, not an outage.
  reset();
  assert.equal(h.call('computeDeptQcdSnapshot_', 'CSR', 'America/Chicago', {}), null);
  assert.equal(h.call('qcdSnapshotReadFailed_'), false, 'no fallback, no flag -- caches as before');
});

// F5 (broad-scan 2026-10-14): DATA-4's flag reached the snapshot readers but
// not computeQcdReport_, which feeds Insights Queue health (and the UX-2
// brief). A Neon miss with an empty -- or trimmed -- sheet fallback returned a
// zero report unflagged, so getInsightsReport cached "0 calls / 0.00%" for 6 h.
test('F5: computeQcdReport_ flags the execution when a Neon fallback leaves it empty or trimmed; a reachable source does not', function () {
  const reset = function () {
    h.state.props.SPREADSHEET_ID = 'fake';
    h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null; h.ctx.QCD_SHEET_DATA_MEMO_ = null; h.ctx.QCD_NEON_GRID_MEMO_ = null;
    h.call('resetExecReadFailureFlags_');
  };
  const realFetch = h.ctx.neonFetchQcdGrid_;
  try {
    h.state.props.QCD_READ_SOURCE = 'neon';
    h.ctx.neonFetchQcdGrid_ = function () { return null; };   // unreachable -> sheet fallback
    // (1) the fallback sheet exists but is empty
    h.state.spreadsheet = makeFakeSpreadsheet({ sheets: { 'QCD Historical Data': [QCD_HEADER] } });
    reset();
    h.call('computeQcdReport_', 'CSR', '2026-09-01', '2026-09-30', {});
    assert.equal(h.call('qcdSnapshotReadFailed_'), true, 'empty fallback: never cached as a real zero');
    // (2) the fallback sheet is trimmed below the window
    h.state.spreadsheet = makeFakeSpreadsheet({ sheets: { 'QCD Historical Data': [QCD_HEADER,
      ['Jan 2026', 'W1', '01/05/2026', 'A_Q_CustomerSuccess', 'Total Calls', 50, 48, 2, '0:01:00', '0:00:20', '4.00%', 1]] } });
    reset();
    h.call('computeQcdReport_', 'CSR', '2026-09-01', '2026-09-30', {});
    assert.equal(h.call('qcdSnapshotReadFailed_'), true, 'trimmed fallback: flagged too');
  } finally {
    h.ctx.neonFetchQcdGrid_ = realFetch;
    delete h.state.props.QCD_READ_SOURCE;
  }
  // The sheet path, same empty window: a genuinely quiet range, not an outage.
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: { 'QCD Historical Data': [QCD_HEADER] } });
  reset();
  h.call('computeQcdReport_', 'CSR', '2026-09-01', '2026-09-30', {});
  assert.equal(h.call('qcdSnapshotReadFailed_'), false, 'no fallback, no flag -- caches as before');
});

// QD-2 (owner 2026-10-20, companyOverview:v29): the tile's abandoned chips
// showed the LATEST QCD day whatever the card period was, so a sub-queue with
// no abandons that day read "Abd 0.0%" on a 30-day view. With
// `opts.periodFromIso` the snapshot also carries a per-queue day map, and
// ovQcdPeriods_ sums it into the card periods -- the same windows as the
// tile's Rung / Ans / Miss, capped at the latest DQE date.
test('QD-2: the card periods sum each queue over their own window, capped at the latest DQE date', function () {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null; h.ctx.QCD_SHEET_DATA_MEMO_ = null; h.ctx.QCD_NEON_GRID_MEMO_ = null;
  const q = h.call('getDeptQcdQueues_', 'CSR')[0];
  const now = new Date();
  const day = function (back) { return iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, 12)); };
  const latest = day(1);
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: { 'QCD Historical Data': [QCD_HEADER,
    qcdRowTA(day(1), q, 50, 0),     // the latest day: no abandons (the "Abd 0.0%" shape)
    qcdRowTA(day(5), q, 100, 8),    // inside 30 days
    qcdRowTA(day(45), q, 200, 20),  // inside 60 / 90, outside 30
    qcdRowTA(day(150), q, 40, 2),   // inside the year, OUTSIDE the 90-day chart window (the widened read)
    qcdRowTA(day(0), q, 999, 999),  // past the latest DQE date: never in a period
  ] } });
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null; h.ctx.QCD_SHEET_DATA_MEMO_ = null; h.ctx.QCD_NEON_GRID_MEMO_ = null;
  const out = h.call('computeQcdSnapshots_', ['CSR'], day(89), 'America/Chicago', { periodFromIso: day(200) });
  assert.ok(out.CSR && out.CSR.queueDaily, 'the per-queue day map rides along');
  const w = { trendStartIso: day(30), last60StartIso: day(59), last90StartIso: day(89), ytdStartIso: day(200) };
  const p = JSON.parse(JSON.stringify(h.call('ovQcdPeriods_', out.CSR.queueDaily, w, latest)));
  assert.equal(p.last30.totalCalls, 150); assert.equal(p.last30.abandoned, 8);
  assert.equal(p.last30.abandonedPctStr, (8 / 150 * 100).toFixed(2) + '%', 'not the latest day\'s 0.00%');
  assert.equal(p.last60.totalCalls, 350); assert.equal(p.last60.abandoned, 28);
  assert.equal(p.last90.totalCalls, 350);
  assert.equal(p.ytd.totalCalls, 390, 'the year reaches past the chart window; the day after the latest DQE date is never counted');
  assert.equal(p.ytd.abandoned, 30);
  assert.equal(out.CSR.totalCalls, 999, 'the snapshot itself is still the latest QCD day (here one past the latest DQE date)');
  assert.equal(p.last30.perQueue, undefined, 'a single-queue dept ships no per-queue rows (they would repeat the totals)');
  assert.equal(p.last30.from, day(30)); assert.equal(p.last30.to, latest);
});

test('QD-2: a card period with no queue rows is null, never a false 0.00%; two queues ship per-queue rows', function () {
  const qd = { A_Q_X: { '2026-01-05': [10, 1, 0] }, A_Q_Y: { '2026-01-06': [20, 4, 1] } };
  const w = { trendStartIso: '2026-09-01', last60StartIso: '2026-08-01', last90StartIso: '2026-07-01', ytdStartIso: '2026-01-01' };
  const p = JSON.parse(JSON.stringify(h.call('ovQcdPeriods_', qd, w, '2026-09-30')));
  assert.equal(p.last30, null); assert.equal(p.last90, null);
  assert.equal(p.ytd.totalCalls, 30);
  assert.equal(JSON.stringify(p.ytd.perQueue.map(function (r) { return [r.queue, r.totalCalls, r.abandoned, r.violations]; })),
    '[["A_Q_X",10,1,0],["A_Q_Y",20,4,1]]');
});

test('QD-2: without periodFromIso the snapshot is unchanged (the YTD chart caller)', function () {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null; h.ctx.QCD_SHEET_DATA_MEMO_ = null; h.ctx.QCD_NEON_GRID_MEMO_ = null;
  const q = h.call('getDeptQcdQueues_', 'CSR')[0];
  const now = new Date();
  const d1 = iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12));
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: { 'QCD Historical Data': [QCD_HEADER, qcdRowTA(d1, q, 50, 5)] } });
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null; h.ctx.QCD_SHEET_DATA_MEMO_ = null; h.ctx.QCD_NEON_GRID_MEMO_ = null;
  const out = h.call('computeQcdSnapshots_', ['CSR'], d1, 'America/Chicago');
  assert.equal(JSON.stringify(out.CSR.queueDaily), '{}');
  assert.equal(out.CSR.abandoned, 5);
});

test('QD-2: periodFromIso widens the READ window too (the Neon path reads only what it asks for)', function () {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null; h.ctx.QCD_SHEET_DATA_MEMO_ = null; h.ctx.QCD_NEON_GRID_MEMO_ = null;
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: { 'QCD Historical Data': [QCD_HEADER] } });
  const realRead = h.ctx.readQcdGrid_;
  const froms = [];
  h.ctx.readQcdGrid_ = function (from, to) { froms.push(from); return realRead.apply(null, arguments); };
  try {
    h.call('computeQcdSnapshots_', ['CSR'], '2026-09-01', 'America/Chicago', { periodFromIso: '2026-01-01' });
  } finally { h.ctx.readQcdGrid_ = realRead; }
  assert.equal(froms[0], '2026-01-01', 'the read starts at the YTD start, not the chart window');
});

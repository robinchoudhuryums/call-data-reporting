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
    timeZone: 'America/Chicago',
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
    timeZone: 'America/Chicago',
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
    timeZone: 'America/Chicago',
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
    timeZone: 'America/Chicago',
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
    timeZone: 'America/Chicago',
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
  h.state.spreadsheet = makeFakeSpreadsheet({ timeZone: 'America/Chicago', sheets: {} });
  assert.equal(h.call('computeCsrTransferRange_', 'CSR', '2026-06-01', '2026-06-30'), null);
});

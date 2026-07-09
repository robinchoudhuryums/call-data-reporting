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

  const out = h.call('computeQcdSnapshots_', ['CSR'], tomorrow, 'America/Chicago');
  assert.ok(out.CSR, 'CSR snapshot exists (the MTD row keeps the dept alive)');
  // Old code: 0 (row dropped before MTD accumulation). Wrong-in-the-other-
  // direction would be 10 (prev month leaking in). Correct: 3.
  assert.equal(out.CSR.violationsMtd, 3);
});

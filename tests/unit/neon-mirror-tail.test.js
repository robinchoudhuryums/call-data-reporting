'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deepEqual } = require('node:assert'); // legacy: prototype-agnostic for cross-realm vm values
const { loadGas } = require('../harness/loadGas');
const { makeFakeSheet } = require('../harness/fakeSheet');

// F-20: the deferred Neon mirror's bounded tail-scan. Each drained date used
// to re-read the ENTIRE historical sheet; nmReadDateRowsTail_ reads a bounded
// bottom window, widening (x4 -> full) when the date is absent from the
// window or its block is clipped at the window top -- and must return a
// row set IDENTICAL to a full scan in every case.

const h = loadGas({ project: 'cdr-import', files: ['neonWrite.js', 'NeonMirror.js'] });

// Grid rows: [junk, 'M/D/YYYY', payload] -- dateCol0 = 1, width 3.
function row(dateStr, payload) { return ['', dateStr, payload]; }

// Builds a fake sheet from data rows (header prepended) and wraps getRange
// to record each read's window size (numRows).
function instrumentedSheet(rows) {
  const sheet = makeFakeSheet('CDR Historical Data', [['h1', 'h2', 'h3']].concat(rows));
  sheet._reads = [];
  const realGetRange = sheet.getRange.bind(sheet);
  sheet.getRange = function (r, c, nr, nc) {
    sheet._reads.push(nr);
    return realGetRange(r, c, nr, nc);
  };
  return sheet;
}

function tailRead(sheet, iso) {
  return h.fn('nmReadDateRowsTail_')(sheet, 3, 1, iso);
}

test('F-20: a recent date fully inside the tail window is read WITHOUT scanning the whole sheet', function () {
  h.state.props.NEON_MIRROR_TAIL_ROWS = '4';
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(row('06/01/2026', 'old-' + i));
  rows.push(row('07/08/2026', 'a'));
  rows.push(row('07/08/2026', 'b'));
  const sheet = instrumentedSheet(rows);

  const out = tailRead(sheet, '2026-07-08');
  deepEqual(out.map(function (r) { return r[2]; }), ['a', 'b']);
  assert.equal(sheet._reads.length, 1, 'accepted on the first window');
  assert.ok(sheet._reads[0] < rows.length, 'window smaller than the sheet ('
    + sheet._reads[0] + ' of ' + rows.length + ' rows)');
});

test('F-20: a block clipped at the window top forces a WIDEN (no partial mirror)', function () {
  h.state.props.NEON_MIRROR_TAIL_ROWS = '2';
  // The date has 4 rows; a 2-row tail sees only the last 2 AND its top row
  // matches -> must widen rather than mirror half the block.
  const rows = [row('06/01/2026', 'old')];
  for (let i = 0; i < 4; i++) rows.push(row('07/08/2026', 'p' + i));
  const sheet = instrumentedSheet(rows);

  const out = tailRead(sheet, '2026-07-08');
  deepEqual(out.map(function (r) { return r[2]; }), ['p0', 'p1', 'p2', 'p3']);
  assert.ok(sheet._reads.length > 1, 'widened past the first window');
});

test('F-20: an OLD date near the top still mirrors correctly (falls back to a full scan)', function () {
  h.state.props.NEON_MIRROR_TAIL_ROWS = '3';
  const rows = [row('05/01/2026', 'ancient-a'), row('05/01/2026', 'ancient-b')];
  for (let i = 0; i < 30; i++) rows.push(row('07/0' + ((i % 7) + 1) + '/2026', 'recent-' + i));
  const sheet = instrumentedSheet(rows);

  const out = tailRead(sheet, '2026-05-01');
  deepEqual(out.map(function (r) { return r[2]; }), ['ancient-a', 'ancient-b']);
});

test('F-20: an absent date returns [] (after covering the full sheet)', function () {
  h.state.props.NEON_MIRROR_TAIL_ROWS = '3';
  const sheet = instrumentedSheet([row('06/01/2026', 'x'), row('06/02/2026', 'y')]);
  deepEqual(tailRead(sheet, '2026-01-01'), []);
});

test('F-20: default window applies when the property is unset (parity with a full scan)', function () {
  delete h.state.props.NEON_MIRROR_TAIL_ROWS;
  const rows = [row('06/01/2026', 'old'), row('07/08/2026', 'a'), row('06/30/2026', 'z'), row('07/08/2026', 'b')];
  const sheet = instrumentedSheet(rows);
  // Non-contiguous same-date rows STILL return completely here because the
  // default 3000-row window covers the whole small sheet (start === 2).
  deepEqual(tailRead(sheet, '2026-07-08').map(function (r) { return r[2]; }), ['a', 'b']);
});

test('IMP-11: a queued date whose Call_Legs sheet was pruned HARD-fails instead of silently dequeuing', function () {
  // inbound_calls has NO sheet primary: once Call_Legs_<iso> is pruned
  // (~14d retention) the date's inbound rows are unrecoverable. The old
  // path returned rows:0 success and dequeued -- an invisible permanent
  // loss. Now it throws (-> neonMirror:Inbound failure row; the IMP-6
  // retry cap parks it with one final gave-up email).
  const realBackfill = h.ctx.backfillInboundCalls;
  try {
    h.ctx.backfillInboundCalls = function () {
      return { inserted: 0, processed: 0, skippedDone: 0, skippedEmpty: 0,
               failures: 0, unreachable: false, stoppedEarly: null, sheetsFound: 0 };
    };
    assert.throws(function () { h.call('mirrorInboundForDate_', '2026-06-01'); },
      /no longer exists .*unrecoverable|cannot be re-derived/i);

    // Sheet present but empty (zero legs) is a legitimate nothing-to-mirror.
    h.ctx.backfillInboundCalls = function () {
      return { inserted: 0, processed: 0, skippedDone: 0, skippedEmpty: 1,
               failures: 0, unreachable: false, stoppedEarly: null, sheetsFound: 1 };
    };
    assert.equal(h.call('mirrorInboundForDate_', '2026-06-02').rows, 0);

    // Unreachable still keeps the date queued (retry-forever, never counts
    // toward the IMP-6 hard-error cap).
    h.ctx.backfillInboundCalls = function () {
      return { inserted: 0, processed: 0, skippedDone: 0, skippedEmpty: 0,
               failures: 0, unreachable: true, stoppedEarly: null, sheetsFound: 1 };
    };
    assert.equal(h.call('mirrorInboundForDate_', '2026-06-03').unreachable, true);
  } finally { h.ctx.backfillInboundCalls = realBackfill; }
});

// --- R8-2 (audit 2026-07-21): deferred-mirror payload correctness pins ---------

const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

test('R8-2: mirrorQcdForDate_ parses DISPLAY strings to numbers (setInt/setDouble-safe) and %-displays to FRACTIONS', function () {
  delete h.state.props.NEON_MIRROR_TAIL_ROWS;
  const ss = makeFakeSpreadsheet({ sheets: { 'QCD Historical Data': [
    ['Month Year', 'Week', 'Date', 'Call Queue', 'Call Source', 'Total Calls',
     'Total Answered', 'Abandoned', 'Longest Wait', 'Avg Answer', 'Abandoned %', 'Violations'],
    // Thousands-grouped + %-formatted displays (what getDisplayValues serves
    // on a formatted sheet).
    ['Jul 2026', 'W2', '07/08/2026', 'A_Q_X', 'Total Calls', '1,234', '1,200', '34',
     '0:01:00', '0:00:30', '2.76%', '1'],
    // Bare-decimal display (unformatted cell) passes through as the fraction.
    ['Jul 2026', 'W2', '07/08/2026', 'A_Q_Y', 'Total Calls', '72', '68', '4',
     '0:00:40', '0:00:20', '0.0526', '0'],
  ] } });
  let captured = null;
  const realWrite = h.ctx.writeQCDRowsToNeon;
  try {
    h.ctx.writeQCDRowsToNeon = function (batch, opts) { captured = { batch, opts }; return { rows: batch.length }; };
    const res = h.call('mirrorQcdForDate_', ss, '2026-07-08');
    assert.equal(res.rows, 2);
    const b0 = captured.batch[0], b1 = captured.batch[1];
    // Numeric fields are NUMBERS -- "72" || 0 used to keep the STRING, which
    // the Jdbc bridge rejects at setInt/setDouble.
    assert.equal(b0.totalCalls, 1234);
    assert.equal(b0.totalAnswered, 1200);
    assert.equal(b0.abandoned, 34);
    assert.equal(b0.violations, 1);
    // "%"-display converts to the inline writer's FRACTION units
    // (Config.gs ABANDONED_PCT: 0..1 decimal, NOT percent).
    assert.ok(Math.abs(b0.abandonedPct - 0.0276) < 1e-9, 'percent display -> fraction');
    assert.equal(b1.abandonedPct, 0.0526, 'bare decimal passes through');
    [b0, b1].forEach(function (b) {
      ['totalCalls', 'totalAnswered', 'abandoned', 'violations', 'abandonedPct'].forEach(function (k) {
        assert.equal(typeof b[k], 'number', k + ' must be a number');
      });
    });
    // Durations stay display strings -- the writer runs normalizeDuration.
    assert.equal(b0.longestWait, '0:01:00');
    assert.equal(captured.opts.authoritative, true, 'IMP-5 per-date replace preserved');
  } finally { h.ctx.writeQCDRowsToNeon = realWrite; }
});

test('R8-2 (REP-10 propagated): mirrorDqeForDate_ reads 34 cols (A-AH) -- 36 threw on a width-trimmed sheet', function () {
  delete h.state.props.NEON_MIRROR_TAIL_ROWS;
  const dqeHeader = [];
  for (let c = 0; c < 34; c++) dqeHeader.push('h' + c);
  const dqeRow = new Array(34).fill('');
  dqeRow[0] = 'Jul 2026'; dqeRow[1] = '07/08/2026'; dqeRow[2] = 'Anna';
  dqeRow[4] = '3'; dqeRow[5] = '5'; dqeRow[6] = '1'; dqeRow[7] = '4';
  const ss = makeFakeSpreadsheet({ sheets: { 'DQE Historical Data': [dqeHeader, dqeRow] } });
  const sheet = ss.getSheetByName('DQE Historical Data');
  const widths = [];
  const realGetRange = sheet.getRange.bind(sheet);
  sheet.getRange = function (r, c, nr, nc) { widths.push(nc); return realGetRange(r, c, nr, nc); };
  let captured = null;
  const realWrite = h.ctx.writeDQERowsToNeon;
  try {
    h.ctx.writeDQERowsToNeon = function (batch, opts) { captured = batch; return { rows: batch.length }; };
    const res = h.call('mirrorDqeForDate_', ss, '2026-07-08');
    assert.equal(res.rows, 1);
    assert.ok(widths.length > 0, 'tail read happened');
    widths.forEach(function (w) { assert.equal(w, 34, 'every DQE read is 34 cols wide'); });
    assert.equal(captured[0].agentName, 'Anna');
    assert.equal(captured[0].totalRung, 5);
  } finally { h.ctx.writeDQERowsToNeon = realWrite; }
});

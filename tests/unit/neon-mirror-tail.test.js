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

// ---- F12: every mirror step is attempted, least-recoverable first ------------
// neonMirrorDate_'s step() used to RETHROW on a hard error, so a failure in an
// early step aborted the date -- across all NEON_MIRROR_MAX_ATTEMPTS retries --
// and Inbound/Outbound (no sheet primary, ~14-day source retention) were never
// attempted before the gave-up path dropped the date. They now run FIRST, and
// every step gets its turn regardless of an earlier hard error; the aggregated
// error still throws so the caller's attempt-counting is unchanged.

function stubMirrors_(calls, failing) {
  const mk = (label) => function () {
    calls.push(label);
    if (failing === label) throw new Error(label + ' exploded');
    return { rows: 1 };
  };
  h.ctx.mirrorCdrForDate_      = mk('CDR');
  h.ctx.mirrorQcdForDate_      = mk('QCD');
  h.ctx.mirrorDqeForDate_      = mk('DQE');
  h.ctx.mirrorInboundForDate_  = mk('Inbound');
  h.ctx.mirrorOutboundForDate_ = mk('Outbound');
  h.ctx.logPipelineHealthWithFallback_ = function () {};
}

test('F12: Inbound/Outbound run BEFORE the sheet-derivable types', function () {
  const calls = [];
  stubMirrors_(calls, null);
  const ok = h.fn('neonMirrorDate_')(null, '2026-07-20');
  assert.equal(ok, true, 'all steps succeeded');
  deepEqual(calls, ['Inbound', 'Outbound', 'CDR', 'QCD', 'DQE']);
});

test('F12: a hard error in an early step does NOT skip the later steps', function () {
  const calls = [];
  stubMirrors_(calls, 'Inbound');            // the first step blows up
  assert.throws(function () { h.fn('neonMirrorDate_')(null, '2026-07-20'); },
    /Inbound exploded/, 'the hard error still propagates to the caller');
  deepEqual(calls, ['Inbound', 'Outbound', 'CDR', 'QCD', 'DQE'],
    'every remaining step was still attempted');
});

test('F12: multiple hard errors are aggregated into ONE throw after every step', function () {
  const calls = [];
  const mk = (label, boom) => function () {
    calls.push(label);
    if (boom) throw new Error(label + ' exploded');
    return { rows: 1 };
  };
  h.ctx.mirrorInboundForDate_  = mk('Inbound', true);
  h.ctx.mirrorOutboundForDate_ = mk('Outbound', false);
  h.ctx.mirrorCdrForDate_      = mk('CDR', true);
  h.ctx.mirrorQcdForDate_      = mk('QCD', false);
  h.ctx.mirrorDqeForDate_      = mk('DQE', false);
  h.ctx.logPipelineHealthWithFallback_ = function () {};
  assert.throws(function () { h.fn('neonMirrorDate_')(null, '2026-07-20'); },
    function (e) {
      assert.match(e.message, /Inbound exploded/);
      assert.match(e.message, /CDR exploded/, 'both failures are reported');
      return true;
    });
  assert.equal(calls.length, 5, 'all five steps ran');
});

test('F12: an unreachable step still returns false (date stays queued) without throwing', function () {
  const calls = [];
  stubMirrors_(calls, null);
  h.ctx.mirrorQcdForDate_ = function () { calls.push('QCD'); return { unreachable: true }; };
  const ok = h.fn('neonMirrorDate_')(null, '2026-07-20');
  assert.equal(ok, false, 'incomplete -> caller keeps the date queued');
  assert.equal(calls.length, 5, 'unreachable never short-circuited (unchanged behavior)');
});

// ── B1 (broad-scan F10): the drain's RUNTIME BUDGET ────────────────────────
//
// runNeonMirror_ used to iterate every queued date with no clock check. Dates
// stay queued by design while Neon is unreachable, so a multi-day outage grows
// the queue -- and once one full pass exceeded Apps Script's ~6-min ceiling the
// run was killed at the same point every time and the drain could never
// complete. Silently: the queue rewrite is at the BOTTOM of the loop (so a
// timeout preserved the queue but emitted no summary), and the IMP-6 attempt
// counter increments only on a THROW, so a timeout never counted an attempt,
// never tripped the retry cap, and never sent the gave-up email.
// (makeFakeSpreadsheet is already imported above.)

function installQueue_(isoDates, attempts) {
  const rows = isoDates.map(function (iso) {
    return ['2026-08-19T00:00:00Z', iso, 'daily', attempts === undefined ? '' : attempts];
  });
  const ss = makeFakeSpreadsheet({
    sheets: { 'Neon Mirror Queue': [['Enqueued At', 'Call Date', 'Source', 'Attempts']].concat(rows) },
  });
  h.state.spreadsheet = ss;
  // getTargetSsId_ lives in autoImport.js, which this suite does not load.
  h.ctx.getTargetSsId_ = function () { return 'fake'; };
  return ss.getSheetByName('Neon Mirror Queue');
}

/** Remaining queued dates, reading the sheet the way the code rewrote it. */
function queuedDates_(sheet) {
  return sheet._data.slice(1)
    .filter(function (r) { return r && r[1]; })
    .map(function (r) { return { iso: String(r[1]), attempts: r[3] }; });
}

test('B1: the drain stops at its budget, leaves the rest QUEUED, and says so', function () {
  const sheet = installQueue_(['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13']);
  h.state.props.NEON_MIRROR_BUDGET_MS = '1';        // trip after the first date
  const logged = [];
  h.ctx.neonMirrorLog_ = function (ss, step, status, rows, t0, notes) {
    logged.push({ step: step, status: status, notes: notes });
  };
  const drained = [];
  h.ctx.neonMirrorDate_ = function (ss, iso) {
    drained.push(iso);
    const until = Date.now() + 3;                   // burn past the 1 ms budget
    while (Date.now() < until) { /* spin */ }
    return true;
  };

  h.call('runNeonMirror_');

  assert.equal(drained.length, 1, 'the budget stopped the loop after one date');
  assert.deepEqual(drained, ['2026-08-10'], 'and it started at the head of the queue');

  const left = queuedDates_(sheet);
  assert.deepEqual(left.map(function (r) { return r.iso; }),
    ['2026-08-11', '2026-08-12', '2026-08-13'],
    'every untried date stays queued -- the drained one is gone');

  const budgetRow = logged.filter(function (l) { return l.step === 'neonMirror:budget'; });
  assert.equal(budgetRow.length, 1, 'a durable row explains the stop (this was the silence)');
  assert.match(budgetRow[0].notes, /3 date\(s\) left/);
  assert.equal(budgetRow[0].status, 'success',
    'nothing FAILED -- nothing was tried; a backlog draining a few per run is working');
});

test('B1: budget-skipped dates keep their attempt count (they were never tried)', function () {
  const sheet = installQueue_(['2026-08-10', '2026-08-11'], 3);
  h.state.props.NEON_MIRROR_BUDGET_MS = '1';
  h.ctx.neonMirrorLog_ = function () {};
  h.ctx.neonMirrorDate_ = function () {
    const until = Date.now() + 3;
    while (Date.now() < until) { /* spin */ }
    return true;
  };

  h.call('runNeonMirror_');

  const left = queuedDates_(sheet);
  assert.equal(left.length, 1);
  assert.equal(left[0].attempts, 3,
    'a timeout must not penalize an untried date -- incrementing here would walk '
    + 'it toward the IMP-6 gave-up drop without ever having failed');
});

test('B1: a generous budget drains everything (default path unchanged)', function () {
  const sheet = installQueue_(['2026-08-10', '2026-08-11', '2026-08-12']);
  delete h.state.props.NEON_MIRROR_BUDGET_MS;       // fall back to the 4-min default
  const logged = [];
  h.ctx.neonMirrorLog_ = function (ss, step) { logged.push(step); };
  h.ctx.neonMirrorDate_ = function () { return true; };

  h.call('runNeonMirror_');

  assert.deepEqual(queuedDates_(sheet), [], 'the whole queue drained');
  assert.equal(logged.indexOf('neonMirror:budget'), -1,
    'no budget row when the budget was never hit');
});

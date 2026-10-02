'use strict';

// ING-4 (broad-scan 2026-09-23, owner-approved 2026-09-28): the import used to
// process ONLY the newest Call_Legs sheet, so a day uploaded shortly before or
// after another was lost silently (the newer sheet already processed -> the
// older one's trigger returned "ALREADY PROCESSED", or it lost the script
// lock). Every unprocessed sheet is now imported oldest-first, with a one-shot
// catch-up when the time budget or the lock gets in the way.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

const h = loadGas({ project: 'cdr-import', files: ['autoImport.js'] });
// PIPE-2: the pending window ends at TODAY; pin it so the fixed fixture dates
// below never age out of the window as the calendar moves.
h.ctx.pendingImportTodayIso_ = function () { return '2026-09-25'; };

function fakeSource(names) {
  return {
    getSheets: function () { return names.map(function (n) { return { getName: function () { return n; } }; }); },
    toast: function () {},
  };
}

test('pendingCallLegsDates_: unprocessed dates, OLDEST first, inside the window', function () {
  const names = ['Raw Data', 'Call_Legs_2026-09-24', 'Call_Legs_2026-09-22', 'Call_Legs_2026-09-23',
                 'Call_Legs_2026-08-01', 'CDR Output'];
  const out = h.call('pendingCallLegsDates_', names, ['Call_Legs_2026-09-22'], 14);
  assert.deepEqual(Array.from(out), ['2026-09-23', '2026-09-24'],
    '09-22 is processed; 08-01 is outside the 14-day window of the newest sheet');
  assert.deepEqual(Array.from(h.call('pendingCallLegsDates_', ['Raw Data'], [], 14)), []);
});

test('processPendingImports_: imports every pending date oldest-first, the newest LAST', function () {
  const calls = [];
  h.state.props = {};
  h.state.spreadsheet = fakeSource(['Call_Legs_2026-09-24', 'Call_Legs_2026-09-23']);
  const orig = h.ctx.processNewImport;
  h.ctx.processNewImport = function (force, iso, silent, ss, cache, opts) {
    calls.push({ force: force, iso: iso, silent: silent, noAlert: !!(opts && opts.noAlert) });
    const known = JSON.parse(h.state.props.lastSheets || '[]');
    known.push('Call_Legs_' + iso);
    h.state.props.lastSheets = JSON.stringify(known);
    return 'DONE: 1s';
  };
  try {
    const last = h.call('processPendingImports_');
    assert.deepEqual(calls.map(function (c) { return c.iso; }), ['2026-09-23', '2026-09-24'],
      'the older upload is no longer skipped, and the newest runs last (the output sheets end on it)');
    assert.ok(calls.every(function (c) { return c.force === false && c.silent === false && c.noAlert; }),
      'each date runs through the unchanged daily path, with no blocking alert');
    assert.equal(last, 'DONE: 1s');
  } finally {
    h.ctx.processNewImport = orig;
  }
});

test('processPendingImports_: an ALREADY-IN-HISTORY date is remembered, not retried forever', function () {
  let n = 0;
  h.state.props = {};
  h.state.spreadsheet = fakeSource(['Call_Legs_2026-09-23']);
  const orig = h.ctx.processNewImport;
  h.ctx.processNewImport = function () { n++; return 'ALREADY IN HISTORY'; };
  try {
    h.call('processPendingImports_');
    assert.equal(n, 1);
    assert.ok(JSON.parse(h.state.props.lastSheets).indexOf('Call_Legs_2026-09-23') !== -1);
  } finally {
    h.ctx.processNewImport = orig;
  }
});

test('processPendingImports_: out of time budget -> stops and schedules the one-shot catch-up', function () {
  h.state.props = {};
  h.state.createdTriggers.length = 0;
  const origBudget = h.ctx.bulkTimeLimitMs_;
  h.ctx.bulkTimeLimitMs_ = function () { return 1; };   // any second date is over budget (the real floor is 1 min)
  h.state.spreadsheet = fakeSource(['Call_Legs_2026-09-22', 'Call_Legs_2026-09-23', 'Call_Legs_2026-09-24']);
  const seen = [];
  const orig = h.ctx.processNewImport;
  h.ctx.processNewImport = function (force, iso) {
    seen.push(iso);
    const known = JSON.parse(h.state.props.lastSheets || '[]');
    known.push('Call_Legs_' + iso);
    h.state.props.lastSheets = JSON.stringify(known);
    const t = Date.now(); while (Date.now() - t < 3) { /* spend > the 1 ms budget */ }
    return 'DONE: 1s';
  };
  try {
    h.call('processPendingImports_');
    assert.deepEqual(seen, ['2026-09-22'], 'one date per run when the budget is exhausted');
    assert.ok(h.state.createdTriggers.indexOf('runPendingImportCatchUp_') !== -1, 'the rest is scheduled, not dropped');
  } finally {
    h.ctx.processNewImport = orig;
    h.ctx.bulkTimeLimitMs_ = origBudget;
  }
});

test('onChange lock-skip: the dropped grid now schedules a catch-up import', function () {
  h.state.createdTriggers.length = 0;
  h.state.lockBusy = true;
  const orig = h.ctx.logPipelineHealthWithFallback_;
  h.ctx.logPipelineHealthWithFallback_ = function () {};
  try {
    h.call('onChange', { changeType: 'INSERT_GRID' });
    assert.ok(h.state.createdTriggers.indexOf('runPendingImportCatchUp_') !== -1);
  } finally {
    h.state.lockBusy = false;
    h.ctx.logPipelineHealthWithFallback_ = orig;
  }
});

// ── PIPE-1 / PIPE-2 (broad-scan 2026-10-01) ─────────────────────────────────

test('PIPE-2: the window ends at TODAY -- a future-dated tab is never a candidate and never the anchor', function () {
  const names = ['Call_Legs_2026-09-29', 'Call_Legs_2026-09-30', 'Call_Legs_2026-10-30'];
  // The pre-fix shape: the typo'd 10-30 tab (already imported once) anchored the
  // window, and every real date fell below its floor -> silent "MISSING".
  assert.deepEqual(Array.from(h.call('pendingCallLegsDates_', names, ['Call_Legs_2026-10-30'], 14)), [],
    'documents the old newest-tab anchor (the default when no today is passed)');
  assert.deepEqual(Array.from(h.call('pendingCallLegsDates_', names, ['Call_Legs_2026-10-30'], 14, '2026-09-30')),
    ['2026-09-29', '2026-09-30'], 'anchored on today: the real dates are pending again');
  assert.deepEqual(Array.from(h.call('pendingCallLegsDates_', names, [], 14, '2026-09-30')),
    ['2026-09-29', '2026-09-30'], 'a tab dated after today is not pending');
  assert.deepEqual(Array.from(h.call('pendingCallLegsDates_', ['Call_Legs_2026-09-10'], [], 14, '2026-09-30')), [],
    'older than today - 14 days is outside the window');
});

function withImports(fn, impl) {
  const orig = h.ctx.processNewImport;
  const origLog = h.ctx.logPipelineHealthWithFallback_;
  const rows = [];
  h.ctx.logPipelineHealthWithFallback_ = function (ss, ev) { rows.push(ev); };
  h.ctx.processNewImport = impl;
  try { return fn(rows); } finally {
    h.ctx.processNewImport = orig;
    h.ctx.logPipelineHealthWithFallback_ = origLog;
  }
}
function okImport(calls) {
  return function (force, iso, silent, ss, cache, opts) {
    calls.push({ iso: iso, noFailureEmail: !!(opts && opts.noFailureEmail) });
    if (iso === '2026-09-22') return 'ERROR: Source sheet empty.';
    const known = JSON.parse(h.state.props.lastSheets || '[]');
    known.push('Call_Legs_' + iso);
    h.state.props.lastSheets = JSON.stringify(known);
    return 'DONE: 1s';
  };
}

test('PIPE-1: a failing date is tried ONCE per run and no longer blocks the newer dates', function () {
  h.state.props = {};
  h.state.spreadsheet = fakeSource(['Call_Legs_2026-09-22', 'Call_Legs_2026-09-23', 'Call_Legs_2026-09-24']);
  const calls = [];
  withImports(function () {
    const last = h.call('processPendingImports_');
    assert.deepEqual(calls.map(function (c) { return c.iso; }), ['2026-09-22', '2026-09-23', '2026-09-24'],
      'one attempt at the bad date, then the newer dates import (pre-fix: 31 attempts at 09-22, nothing else)');
    assert.equal(last, 'DONE: 1s');
    assert.equal(calls[0].noFailureEmail, false, 'the FIRST failure of a date emails');
    const fails = JSON.parse(h.state.props.PENDING_IMPORT_FAILURES);
    assert.equal(fails['2026-09-22'].n, 1);
    assert.ok(/Source sheet empty/.test(fails['2026-09-22'].err));
  }, okImport(calls));
});

test('PIPE-1: retries do not email; the date is PARKED after the attempt cap, logged once, then left alone', function () {
  h.state.props = {};
  h.state.spreadsheet = fakeSource(['Call_Legs_2026-09-22']);
  const calls = [];
  withImports(function (rows) {
    h.call('processPendingImports_');
    h.call('processPendingImports_');
    assert.equal(rows.filter(function (r) { return r.step === 'autoImport:parked'; }).length, 0, 'not parked yet');
    h.call('processPendingImports_');
    assert.deepEqual(calls.map(function (c) { return c.noFailureEmail; }), [false, true, true],
      'one email per failing date, not one per attempt');
    const parked = rows.filter(function (r) { return r.step === 'autoImport:parked'; });
    assert.equal(parked.length, 1);
    assert.equal(parked[0].status, 'failure');
    assert.ok(/2026-09-22/.test(parked[0].notes) && /Manual Processing/.test(parked[0].notes));
    h.call('processPendingImports_');
    assert.equal(calls.length, 3, 'a parked date is not retried automatically');
  }, okImport(calls));
});

test('PIPE-1: the ledger clears itself when the parked tab is removed, and says so once', function () {
  h.state.props = { PENDING_IMPORT_FAILURES: JSON.stringify({ '2026-09-22': { n: 3, at: 'x', err: 'ERROR: x' } }) };
  h.state.spreadsheet = fakeSource(['Call_Legs_2026-09-23']);   // the bad tab was deleted
  const calls = [];
  withImports(function (rows) {
    h.call('processPendingImports_');
    assert.equal(h.state.props.PENDING_IMPORT_FAILURES, undefined, 'entry dropped, property deleted');
    const ok = rows.filter(function (r) { return r.step === 'autoImport:parked'; });
    assert.equal(ok.length, 1);
    assert.equal(ok[0].status, 'success', 'Health stops flagging the parked step');
    assert.deepEqual(calls.map(function (c) { return c.iso; }), ['2026-09-23']);
  }, okImport(calls));
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadGas } = require('../harness/loadGas');

// WEEKEND/HOLIDAY STALENESS CREDIT.
//
// The data-freshness surfaces measured staleness in raw wall-clock hours
// against a 36h threshold. Friday's data is ~57h old by Monday 9am, so BOTH
// the header pill and the Overview pipeline banner warned every Monday
// morning on data that was perfectly current -- Friday IS the most recent
// workday and nothing was missing. IngestWatchdog.gs had solved this from
// the start (ingestWatchdogNonBusinessCredit_, OPS-7: 24h allowance per
// weekend/holiday day in the gap); the other two surfaces never adopted it.
//
// Pinned here: (1) the Overview banner APPLIES the credit (the wiring that
// was missing -- the helper already existed); (2) the credit helper's own
// arithmetic; (3) a source tripwire that the client pill does the same,
// since its staleness lives inside the assembled-client IIFE where only the
// rendered-UI gate can execute it (the D2 client-pin pattern).

const ROOT = path.join(__dirname, '..', '..');
const DASH = path.join(ROOT, 'apps-script', 'department-dashboard');

const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'IngestWatchdog.gs', 'CompanyOverview.gs'],
});

// A Pipeline Health row N hours old, in the 'yyyy-MM-dd HH:mm' script-TZ
// shape the reader parses.
function rowHoursAgo(hours, over) {
  const d = new Date(Date.now() - hours * 3600000);
  const p = function (n) { return (n < 10 ? '0' : '') + n; };
  const ts = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
           + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  return Object.assign({ step: 'processIntegratedHistory:DQE', status: 'success',
                         rows: 1200, timestamp: ts }, over || {});
}

// The real credit helper, captured BEFORE any stubbing: assigning over a vm
// global loses the original, and the last test exercises the real arithmetic.
const REAL_CREDIT_ = h.ctx.ingestWatchdogNonBusinessCredit_;

function install(rows, credit) {
  h.ctx.readPipelineHealth_ = function () { return rows; };
  // Utilities.parseDate is deliberately not shimmed; parse the known
  // 'yyyy-MM-dd HH:mm' fixture shape directly so the reader can resolve it.
  h.ctx.parsePipelineHealthTimestamp_ = function (ts) {
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(String(ts || ''));
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  };
  // The credit helper is stubbed to a KNOWN value so the assertion is
  // deterministic regardless of which weekday the suite runs on -- what is
  // under test is that the banner applies it at all.
  h.ctx.ingestWatchdogNonBusinessCredit_ = function () { return credit; };
}

test('Overview banner: a Friday build read on Monday is NOT stale (48h of weekend credit)', function () {
  // 60h since the last successful DQE build -- past the raw 36h threshold.
  install([rowHoursAgo(60)], 48);
  const out = h.call('computeOverviewPipelineFreshness_');
  assert.equal(out.isStale, false,
    'weekend days must not count toward staleness -- this is the Monday false alarm');
  assert.ok(out.hoursSinceFresh >= 59 && out.hoursSinceFresh <= 61,
    'the REPORTED age stays literal wall-clock hours (honest); only the verdict is adjusted');
});

test('Overview banner: the same gap with NO non-business days IS stale', function () {
  install([rowHoursAgo(60)], 0);
  assert.equal(h.call('computeOverviewPipelineFreshness_').isStale, true,
    'a genuine mid-week 60h gap must still warn');
});

test('Overview banner: credit cannot rescue a long outage', function () {
  // 8 days dark, with a full weekend inside it.
  install([rowHoursAgo(24 * 8)], 48);
  assert.equal(h.call('computeOverviewPipelineFreshness_').isStale, true);
});

test('Overview banner: a rows:0 no-op success still does not count as freshness (F5 intact)', function () {
  install([rowHoursAgo(2, { rows: 0 })], 0);
  const out = h.call('computeOverviewPipelineFreshness_');
  assert.equal(out.hoursSinceFresh, null);
  assert.equal(out.isStale, true, 'no qualifying build found -> stale, unchanged by this work');
});

test('the credit helper itself: 24h per weekend/holiday day, capped at 14 days back', function () {
  // Real arithmetic (restored -- the banner tests above stub this global).
  h.ctx.ingestWatchdogNonBusinessCredit_ = REAL_CREDIT_;
  // Whatever today is, the credit over a 7-day lookback must be a whole
  // number of days and cover at least one weekend.
  const week = h.call('ingestWatchdogNonBusinessCredit_', 24 * 7);
  assert.equal(week % 24, 0, 'credit is whole days');
  assert.ok(week >= 48, 'any 7-day window contains a full weekend (got ' + week + 'h)');
  assert.equal(h.call('ingestWatchdogNonBusinessCredit_', 0), 0);
  assert.equal(h.call('ingestWatchdogNonBusinessCredit_', null), 0);
  // The 14-day walk-back cap bounds the credit no matter how long the gap.
  assert.ok(h.call('ingestWatchdogNonBusinessCredit_', 24 * 365) <= 14 * 24);
});

test('client pill: the header freshness pill applies the same non-business credit', function () {
  // Source tripwire (the D2 client-pin pattern): the pill's staleness lives
  // inside the assembled-client IIFE, so only the rendered-UI gate can run
  // it -- but a regression that reverts to raw `ageHours >= 36` would sail
  // through that gate too (it renders fine, it is just wrong on Mondays).
  const src = fs.readFileSync(path.join(DASH, 'script-1-core.html'), 'utf8');
  assert.ok(/function freshnessNonBusinessCredit_/.test(src),
    'the pill lost its non-business credit helper');
  assert.ok(/is-stale',\s*businessAgeHours >= 36/.test(src),
    'the pill must gate .is-stale on the CREDIT-ADJUSTED age, not raw ageHours '
    + '-- raw hours make every Monday morning read as stale on current data.');
  assert.ok(/isCompanyHolidayIso_/.test(src),
    'company holidays are non-business days too (OPS-7 parity)');
});

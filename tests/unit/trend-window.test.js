'use strict';

// INV-29 trend-window contract. computeTrendStartDate_ (Util.gs) is the
// single source of truth for the 12-month trend axis shared by the
// Individual, Performance, Insights, and QCD reports. Before the M3
// consolidation each report hand-copied this block, with no test pinning
// them together -- a silent-drift trap, since INV-29 *requires* IR and PR
// to align. This suite pins the helper's behavior; the cross-report
// alignment is now structural (all four call this one helper) and is
// additionally exercised by the Insights<->PR parity test.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

const h = loadGas({ files: ['Config.gs', 'Util.gs'] });

// Mirror IndividualReport/QCD's parseIso_: noon-anchored local Date so the
// helper's +-1h DST wobble guard is exercised the same way it is in prod.
function d(iso) {
  const p = iso.split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12);
}
function isoOf(dt) {
  const pad = (n) => (n < 10 ? '0' + n : String(n));
  return dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate());
}
const trendStart = (from, to) => isoOf(h.call('computeTrendStartDate_', d(from), d(to)));

test('normal range: trend = first-of-month(end - 12 months)', function () {
  assert.equal(trendStart('2026-05-01', '2026-05-30'), '2025-05-01');
  // end mid-month -> still snaps to the 1st of the month 12 months back
  assert.equal(trendStart('2026-03-09', '2026-03-09'), '2025-03-01');
});

test('range > 366 days: the range IS the window (trend start = range start)', function () {
  assert.equal(trendStart('2024-01-01', '2025-06-30'), '2024-01-01');
});

test('full calendar year (Jan 1 - Dec 31): the range IS the window', function () {
  assert.equal(trendStart('2025-01-01', '2025-12-31'), '2025-01-01');
});

test('366-day boundary does NOT trigger range-as-window (uses 12-mo lookback)', function () {
  // 2025-01-01 .. 2026-01-01 inclusive = 366 days, but diffDays is not
  // > 366 and it is not a full calendar year, so the 12-mo lookback wins.
  assert.equal(trendStart('2025-01-01', '2026-01-01'), '2025-01-01');
});

test('partial year that is NOT Jan1-Dec31 uses 12-mo lookback, not the range', function () {
  // Feb 1 - Dec 31 same year: not a full calendar year -> 12-mo lookback.
  assert.equal(trendStart('2025-02-01', '2025-12-31'), '2024-12-01');
});

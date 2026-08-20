'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// Follow-on to C1 (broad-scan F7): first coverage on dashboardCDR.js — the
// OTHER live, menu-reachable, zero-test cdr-report file. Scope is the PURE
// aggregation helpers that feed its four setValues sites (the per-agent
// contact lists, the diagnostics counts, and the TOTALS row's recomputed
// Rate/ATT columns — the v9 changelog's headline fix). The 480-line
// generateCustomReportCore_ end-to-end (sheet inputs + charts + diagnostics)
// remains uncovered and is recorded as a follow-on: it needs the C1-style
// fixture treatment, not a smoke assert.

const h = loadGas({ project: 'cdr-report', files: ['dashboardCDR.js'] });

test('dashCDR: countItemsInList sums (N) multipliers and counts bare names as 1', function () {
  const f = h.fn('countItemsInList');
  assert.equal(f(''), 0);
  assert.equal(f(null), 0);
  assert.equal(f('John Smith'), 1);
  assert.equal(f('John Smith(3), Jane Doe, Acme(5)'), 9);
  assert.equal(f(' , ,'), 0, 'empty tokens are skipped, not counted');
});

test('dashCDR: durationToSeconds handles H:MM:SS strings, day-fraction numbers, and junk', function () {
  const f = h.fn('durationToSeconds');
  assert.equal(f('0:15:03'), 903);
  assert.equal(f('1:00:00'), 3600);
  assert.equal(f(0.5), 43200, 'a serial number is a day fraction');
  assert.equal(f(null), 0);
  assert.equal(f('90'), 0, 'not H:MM:SS-shaped -> 0, never NaN');
  assert.equal(f('junk'), 0);
});

test('dashCDR: parseAndAggregate merges (N) counts per key; EXT type strips trailing timestamps', function () {
  const agg = {};
  h.fn('parseAndAggregate')('Jane(2), Bob, Jane', agg, 'NAME');
  assert.deepEqual(JSON.parse(JSON.stringify(agg)), { Jane: 3, Bob: 1 });
  const ext = {};
  h.fn('parseAndAggregate')('204 10:23:33, 204 11:05:00, 209 9:01:02', ext, 'EXT');
  assert.deepEqual(JSON.parse(JSON.stringify(ext)), { 204: 2, 209: 1 },
    'the timestamp suffix must not split one extension into distinct keys');
});

test('dashCDR: mapToContactString sorts by count desc, caps at CONTACT_CAP with an explicit remainder', function () {
  const f = h.fn('mapToContactString');
  assert.equal(f({}), '');
  assert.equal(f({ A: 1, B: 3 }), 'B(3), A', 'count>1 gets the (N); singletons stay bare');
  const big = {};
  for (let i = 0; i < 20; i++) big['n' + i] = 20 - i;
  const out = f(big);
  assert.match(out, /… \+5 more$/, 'past the 15-entry cap the remainder is stated, never silently cut');
});

test('dashCDR: buildTotalsRow recomputes Rate as dept Ans/Total and ATT as dept TTT/Answered — never a sum of ratios', function () {
  // The v9 changelog's headline fix: a summed ATT column is arithmetic
  // nonsense (sum of per-agent means); the totals row must recompute from
  // the dept-level numerator/denominator.
  // Production header shape (line ~505): `<cat> Total`, `<cat> Ans`,
  // `<cat> Rate` -- the Rate recompute parses the category prefix back out,
  // so a bare 'Rate' header would (correctly) find nothing and write 0.
  const headers = ['Agent', 'IB Ext Total', 'IB Ext Ans', 'IB Ext Rate', 'TTT', 'ATT'];
  const rows = [
    ['A', 10, 8, 0.8, 800, 100],
    ['B', 30, 15, 0.5, 3000, 200],
  ];
  const totals = JSON.parse(JSON.stringify(h.fn('buildTotalsRow')(headers, rows)));
  assert.equal(totals[1], 40);
  assert.equal(totals[2], 23);
  assert.ok(Math.abs(totals[3] - 23 / 40) < 1e-9, 'Rate = 23/40, NOT 0.8+0.5');
  assert.equal(totals[4], 3800);
  assert.ok(Math.abs(totals[5] - 3800 / 23) < 1e-9, 'ATT = dept TTT / dept Ans, NOT 100+200');
});

test('dashCDR: buildTotalsRow guards the zero-denominator Rate (no NaN into a cell)', function () {
  const headers = ['Agent', 'IB Ext Total', 'IB Ext Ans', 'IB Ext Rate'];
  const totals = JSON.parse(JSON.stringify(h.fn('buildTotalsRow')(headers, [['A', 0, 0, 0]])));
  assert.equal(totals[3], 0, 'a zero dept total renders 0, never NaN/Infinity');
});

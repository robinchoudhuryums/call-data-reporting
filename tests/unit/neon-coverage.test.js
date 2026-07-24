'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// Neon coverage check (NeonCoverage.gs, R7/G-2). Pins the PURE pieces --
// the tolerant display-date parser, the per-date comparison classifier,
// and the inbound zero-row-weekday expectation (holiday + capture-floor
// aware). The JDBC/sheet read wrappers are thin and follow the pinned
// json_agg discipline; the editor-run driver is exercised live.

const h = loadGas({ files: ['Config.gs', 'Util.gs', 'Auth.gs', 'NeonCoverage.gs'] });

// ── ncCellDateIso_ ──────────────────────────────────────────────────────

test('coverage: ncCellDateIso_ normalizes ISO and M/D/YYYY display values, rejects junk', function () {
  assert.equal(h.ctx.ncCellDateIso_('2026-07-15'), '2026-07-15');
  assert.equal(h.ctx.ncCellDateIso_('7/5/2026'), '2026-07-05');
  assert.equal(h.ctx.ncCellDateIso_('12/30/1899'), '1899-12-30');   // coerced-cell render still parses
  assert.equal(h.ctx.ncCellDateIso_(''), null);
  assert.equal(h.ctx.ncCellDateIso_('Sonia Alvarez'), null);
  assert.equal(h.ctx.ncCellDateIso_('2026-7-5'), null);   // non-padded ISO is not a sheet render
  assert.equal(h.ctx.ncCellDateIso_(null), null);
});

// ── ncCompareCoverage_ ──────────────────────────────────────────────────

test('coverage: classifier splits missing-in-neon / count-mismatch / extra-in-neon, sorted', function () {
  const cmp = h.ctx.ncCompareCoverage_(
    { '2026-07-14': 40, '2026-07-15': 41, '2026-07-16': 39 },
    { '2026-07-14': 40, '2026-07-15': 30, '2026-07-17': 5 }
  );
  // JSON round-trip: vm-realm objects fail strict deepEqual on prototype.
  const j = function (x) { return JSON.parse(JSON.stringify(x)); };
  assert.deepEqual(j(cmp.missingInNeon), [{ date: '2026-07-16', sheetRows: 39 }]);
  assert.deepEqual(j(cmp.countMismatch),
    [{ date: '2026-07-15', sheetRows: 41, neonRows: 30 }]);
  assert.deepEqual(j(cmp.extraInNeon), [{ date: '2026-07-17', neonRows: 5 }]);
});

test('coverage: identical maps -> no findings; empty maps -> no findings', function () {
  const clean = h.ctx.ncCompareCoverage_({ '2026-07-14': 12 }, { '2026-07-14': 12 });
  assert.equal(clean.missingInNeon.length + clean.countMismatch.length + clean.extraInNeon.length, 0);
  const empty = h.ctx.ncCompareCoverage_({}, {});
  assert.equal(empty.missingInNeon.length + empty.countMismatch.length + empty.extraInNeon.length, 0);
});

// ── ncExpectedWeekdayGaps_ ──────────────────────────────────────────────

// 2026-07-13 is a Monday; 13..17 = Mon..Fri, 18/19 weekend.
test('coverage: inbound gap check flags zero-row weekdays only', function () {
  const gaps = h.ctx.ncExpectedWeekdayGaps_('2026-07-13', '2026-07-19',
    { '2026-07-13': 10, '2026-07-15': 8, '2026-07-16': 9, '2026-07-17': 7 },
    '2026-01-01', function () { return false; });
  assert.deepEqual(Array.from(gaps), ['2026-07-14']);   // weekend days never expected
});

test('coverage: holidays and pre-capture days are not expected', function () {
  const gaps = h.ctx.ncExpectedWeekdayGaps_('2026-07-13', '2026-07-17',
    { '2026-07-16': 9, '2026-07-17': 7 },
    '2026-07-15',                                    // capture began mid-window
    function (iso) { return iso === '2026-07-15'; }  // and the 15th is a holiday
  );
  // 13th/14th predate capture, 15th is a holiday, 16th/17th have rows.
  assert.deepEqual(Array.from(gaps), []);
});

test('coverage: null capture floor (empty table) -> every eligible weekday is a gap', function () {
  const gaps = h.ctx.ncExpectedWeekdayGaps_('2026-07-13', '2026-07-15', {}, null,
    function () { return false; });
  assert.deepEqual(Array.from(gaps), ['2026-07-13', '2026-07-14', '2026-07-15']);
});

// ── ncMissingTableError_ (outbound_calls may predate its capture deploy) ─

test('coverage: missing-table probe errors classify as clean skips, real failures do not', function () {
  assert.equal(h.ctx.ncMissingTableError_('outbound_calls: relation "outbound_calls" does not exist'), true);
  assert.equal(h.ctx.ncMissingTableError_('ERROR: relation "outbound_calls" does not exist (SQLState 42P01)'), true);
  assert.equal(h.ctx.ncMissingTableError_('outbound_calls: connection reset by peer'), false);
  assert.equal(h.ctx.ncMissingTableError_('timeout waiting for connection'), false);
  assert.equal(h.ctx.ncMissingTableError_(''), false);
  assert.equal(h.ctx.ncMissingTableError_(null), false);
});

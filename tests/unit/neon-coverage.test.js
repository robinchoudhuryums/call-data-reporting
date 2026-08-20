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

test('B-2: ncReclassifyTrimmed_ moves extra-in-neon to informational sheetTrimmed under a neon read source', function () {
  const j = function (x) { return JSON.parse(JSON.stringify(x)); };
  const mk = function () {
    return h.ctx.ncCompareCoverage_(
      { '2026-07-15': 41 },
      { '2026-07-15': 41, '2026-07-17': 5 }   // 07-17 exists in Neon only
    );
  };
  // neon source: the trimmed-sheet end state -- not a phantom finding.
  const neon = h.ctx.ncReclassifyTrimmed_(mk(), 'neon');
  assert.equal(neon.extraInNeon.length, 0, 'no phantom findings under neon');
  assert.deepEqual(j(neon.sheetTrimmed), [{ date: '2026-07-17', neonRows: 5 }]);
  // sheet source (and anything else): unchanged -- still a real phantom.
  const sheet = h.ctx.ncReclassifyTrimmed_(mk(), 'sheet');
  assert.deepEqual(j(sheet.extraInNeon), [{ date: '2026-07-17', neonRows: 5 }]);
  assert.equal(sheet.sheetTrimmed, undefined);
  // missing-in-neon stays a finding in BOTH modes (sheet rows must mirror).
  const still = h.ctx.ncReclassifyTrimmed_(
    h.ctx.ncCompareCoverage_({ '2026-07-16': 39 }, {}), 'neon');
  assert.equal(still.missingInNeon.length, 1);
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

// ── E1: the Call_Legs retention horizon ─────────────────────────────────

const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

test('E1: ncSurvivingCallLegsDates_ enumerates and sorts the day-sheets, ignoring everything else', function () {
  const ss = makeFakeSpreadsheet({ sheets: {
    'Call_Legs_2026-08-12': [['h']],
    'Call_Legs_2026-08-10': [['h']],
    'Raw Data': [['h']],
    'Call_Legs_junk': [['h']],          // no date suffix -> ignored
    'DQE Historical Data': [['h']],
  } });
  assert.deepEqual(JSON.parse(JSON.stringify(h.ctx.ncSurvivingCallLegsDates_(ss))),
    ['2026-08-10', '2026-08-12']);
  assert.deepEqual(JSON.parse(JSON.stringify(
    h.ctx.ncSurvivingCallLegsDates_(makeFakeSpreadsheet({ sheets: {} })))), []);
});

// Fake conn serving ncNeonDateCounts_'s json_agg protocol per table.
function rrConn_(countsByTable, throwFor) {
  return {
    prepareStatement: function (sql) {
      const table = /FROM (\w+) WHERE/.exec(sql)[1];
      return {
        setString: function () {},
        executeQuery: function () {
          if (throwFor && throwFor[table]) throw new Error(throwFor[table]);
          const rows = Object.keys(countsByTable[table] || {}).map(function (d) {
            return { d: d, n: countsByTable[table][d] };
          });
          return {
            next: function () { return true; },
            getString: function () { return JSON.stringify(rows); },
            close: function () {},
          };
        },
        close: function () {},
      };
    },
  };
}

test('E1: ncRetentionRisk_ flags surviving weekdays a table is missing, with the ~last recoverable day', function () {
  // Surviving: Mon 08-10 .. Wed 08-12 (2026-08-10 is a Monday).
  const surviving = ['2026-08-10', '2026-08-11', '2026-08-12'];
  const conn = rrConn_({
    inbound_calls:  { '2026-08-10': 5, '2026-08-12': 7 },   // missing the 11th
    outbound_calls: { '2026-08-10': 2, '2026-08-11': 3, '2026-08-12': 1 },
  });
  const out = JSON.parse(JSON.stringify(h.ctx.ncRetentionRisk_(conn, surviving, null)));
  const ib = out.tables.find(function (t) { return t.table === 'inbound_calls'; });
  const ob = out.tables.find(function (t) { return t.table === 'outbound_calls'; });
  assert.deepEqual(ib.atRisk, [{ date: '2026-08-11', lastDay: '2026-08-25' }],
    'the unmirrored surviving date, with date + NC_RETENTION_DAYS_ as the deadline');
  assert.deepEqual(ob.atRisk, [], 'a fully-mirrored table has nothing at risk');
});

test('E1: a weekend hole and a PRUNED date are not "at risk" -- only surviving weekdays are', function () {
  // Surviving skips the weekend (08-15/16) AND Friday 08-14 already pruned.
  const surviving = ['2026-08-13', '2026-08-17'];   // Thu, then Mon
  const conn = rrConn_({ inbound_calls: {}, outbound_calls: {} });
  const out = JSON.parse(JSON.stringify(h.ctx.ncRetentionRisk_(conn, surviving, null)));
  const ib = out.tables.find(function (t) { return t.table === 'inbound_calls'; });
  assert.deepEqual(ib.atRisk.map(function (a) { return a.date; }),
    ['2026-08-13', '2026-08-17'],
    'Fri 08-14 has NO surviving sheet -- it is already lost, not at risk; the '
    + 'weekend is not an expected capture day');
});

test('E1: a missing table reads as missingTable (deploy-ahead-of-capture), never a throw', function () {
  const conn = rrConn_({ inbound_calls: {} },
    { outbound_calls: 'ERROR: relation "outbound_calls" does not exist' });
  const out = JSON.parse(JSON.stringify(
    h.ctx.ncRetentionRisk_(conn, ['2026-08-11'], null)));
  const ob = out.tables.find(function (t) { return t.table === 'outbound_calls'; });
  assert.equal(ob.missingTable, true);
  assert.deepEqual(ob.atRisk, []);
});

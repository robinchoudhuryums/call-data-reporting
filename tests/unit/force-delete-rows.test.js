'use strict';

// R38: the force-path `deleteHistoricalRowsForDate` (cdr-import autoImport.js)
// used to read every column of every row, keep the non-matching rows and
// rewrite the whole sheet padded to its original height. It now reads ONLY
// the date column, deletes the matching rows as contiguous blocks (bottom-up)
// and re-pads the sheet to its previous getMaxRows. These pins hold the
// contract every caller relies on: the IDENTICAL match (Date cells + text
// cells via parseHistoryDateCell_), the removed COUNT (what the P26 loss
// guards key on), untouched rows kept in order, and the post-state row
// capacity -- so a downstream reader cannot tell the two implementations apart.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSheet } = require('../harness/fakeSheet');

const h = loadGas({ project: 'cdr-import', files: ['autoImport.js'] });
const del = h.fn('deleteHistoricalRowsForDate');

const DATE_COL = 3;   // 1-based; header ['A','B','Date','D']

function grid(cells) {
  return [['A', 'B', 'Date', 'D']].concat(cells.map(function (d, i) {
    return ['a' + i, 'b' + i, d, 'd' + i];
  }));
}

test('deletes split blocks of the target date, keeps the rest in order, returns the count', function () {
  const target = new Date(2026, 7, 20);
  const other = new Date(2026, 7, 21);
  // rows 2..9: T T O O T O T T  -> blocks [2,2] [6,1] [8,2]
  const sheet = makeFakeSheet('CDR Historical Data',
    grid([target, target, other, other, target, other, target, target]));
  const calls = [];
  const inner = sheet.deleteRows;
  sheet.deleteRows = function (r, n) { calls.push([r, n]); return inner.call(this, r, n); };
  sheet._maxRows = 50;

  const removed = del(sheet, new Date(2026, 7, 20), DATE_COL);

  assert.equal(removed, 5, 'the removed count keeps its meaning');
  assert.deepEqual(calls, [[8, 2], [6, 1], [2, 2]], 'contiguous blocks, deleted bottom-up');
  assert.deepEqual(sheet._data.slice(1).map(function (r) { return r[0]; }), ['a2', 'a3', 'a5'],
    'the other rows survive untouched and in order');
  assert.equal(sheet.getLastRow(), 4);
  assert.equal(sheet.getMaxRows(), 50, 're-padded to the previous capacity');
});

test('text date cells match through parseHistoryDateCell_ exactly like the old full-row scan', function () {
  const sheet = makeFakeSheet('QCD Historical Data',
    grid(['8/20/2026', '2026-08-20', new Date(2026, 7, 20), '8/21/2026', '', 'garbage']));
  const removed = del(sheet, new Date(2026, 7, 20), DATE_COL);
  assert.equal(removed, 3, 'M/D/YYYY, ISO and Date cells all match; blank/garbage never do');
  assert.deepEqual(sheet._data.slice(1).map(function (r) { return r[2]; }), ['8/21/2026', '', 'garbage']);
});

test('no match: returns 0 and touches nothing (a NON-force empty date is a no-op, F5)', function () {
  const sheet = makeFakeSheet('DQE Historical Data', grid([new Date(2026, 7, 21), '8/22/2026']));
  sheet.deleteRows = function () { throw new Error('must not delete'); };
  sheet.insertRowsAfter = function () { throw new Error('must not pad'); };
  assert.equal(del(sheet, new Date(2026, 7, 20), DATE_COL), 0);
  assert.equal(del(makeFakeSheet('Empty', [['A', 'B', 'Date', 'D']]), new Date(2026, 7, 20), DATE_COL), 0);
});

test('reads only the date column, never the full grid', function () {
  const sheet = makeFakeSheet('CSR Transfer Historical Data',
    grid([new Date(2026, 7, 20), new Date(2026, 7, 21)]));
  const reads = [];
  const inner = sheet.getRange;
  sheet.getRange = function (r, c, nr, nc) { reads.push([r, c, nr, nc]); return inner.call(this, r, c, nr, nc); };
  del(sheet, new Date(2026, 7, 20), DATE_COL);
  assert.deepEqual(reads, [[2, DATE_COL, 2, 1]], 'one single-column read');
});

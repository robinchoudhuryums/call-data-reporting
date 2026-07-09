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

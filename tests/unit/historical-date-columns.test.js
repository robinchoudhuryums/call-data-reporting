'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
// vm-created objects have a foreign prototype, so deepStrictEqual fails on
// identity alone -- the legacy deepEqual compares structure, which is the
// property under test.
const { deepEqual } = require('node:assert');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

// Phase 0 (date-column census, sheetRepairs.js): the read-only scan that
// decides whether a `.sort({column: <date>})` can order a historical sheet at
// all. Its load-bearing property is that MIXED TYPE is detected SEPARATELY
// from disorder -- Sheets groups numeric/Date cells before text, so a mixed
// column that has been sorted reads as non-decreasing while being wrong.
// A census that only asked "is it ordered?" would certify DQE forever.
//
// sheetRepairs.js needs parseDateForNeon (neonWrite.js, same project) -- the
// census deliberately reuses that one resolver rather than adding a sixth
// hand-mirrored date parser.
const h = loadGas({ project: 'cdr-report', files: ['neonWrite.js', 'sheetRepairs.js'] });

const HEADERS = ['Month', 'Date', 'Agent'];

// A cell is (raw value, rendered display) -- the real distinction the census
// depends on. A Date-typed cell RENDERS as "3/9/2026"; stringifying the JS
// Date instead would feed parseDateForNeon a UTC instant and shift it a day
// (the F-8 class), which is a property of the fake, not of Sheets.
function dateCell(y, m, d) {
  return { v: new Date(y, m - 1, d), disp: m + '/' + d + '/' + y };
}
function textCell(str)   { return { v: str, disp: str }; }
function serialCell(n)   { return { v: n, disp: String(n) }; }   // numeric number-format
const BLANK = { v: '', disp: '' };

// DQE keeps its date in col B; the other four use col C.
function buildSheet(cells, dateIdx) {
  const values = [], displays = [];
  const header = ['Month', 'Date', 'Agent', 'x'];
  values.push(header.slice()); displays.push(header.slice());
  cells.forEach(function (c, i) {
    const v = ['Mar, 26', 'W1', 'row' + i, 'x'];
    const d = v.slice();
    v[dateIdx] = c.v; d[dateIdx] = c.disp;
    values.push(v); displays.push(d);
  });
  return { values: values, displays: displays };
}
function dqeSheet(cells)   { return buildSheet(cells, 1); }
function colCSheet(cells)  { return buildSheet(cells, 2); }

function install(sheets) {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.spreadsheet = makeFakeSpreadsheet({ timeZone: 'America/Chicago', sheets: sheets });
}

function scan(sheets) {
  install(sheets);
  const census = h.call('previewHistoricalDateColumns');
  const byName = {};
  census.sheets.forEach(function (s) { byName[s.sheet] = s; });
  return byName;
}

test('Phase 0: a clean single-typed ascending column reads CLEAN', function () {
  const got = scan({
    'DQE Historical Data': dqeSheet([
      dateCell(2026, 3, 9), dateCell(2026, 3, 10), dateCell(2026, 3, 11),
    ]),
  })['DQE Historical Data'];
  assert.equal(got.verdict, 'CLEAN');
  assert.equal(got.rows, 3);
  assert.equal(got.singleTyped, true);
  assert.equal(got.ordered, true);
  assert.equal(got.inversions, 0);
  assert.equal(got.minIso, '2026-03-09');
  assert.equal(got.maxIso, '2026-03-11');
  assert.deepEqual(Object.keys(got.types), ['date']);
});

test('Phase 0: a single-typed column with an appended older date reads UNSORTED', function () {
  // The exact shape reprocessing a date produces: rebuilt rows appended at the
  // bottom instead of slotted in chronologically.
  const got = scan({
    'QCD Historical Data': colCSheet([
      dateCell(2026, 3, 9), dateCell(2026, 3, 11), dateCell(2026, 3, 10),
    ]),
  })['QCD Historical Data'];
  assert.equal(got.verdict, 'UNSORTED');
  assert.equal(got.singleTyped, true, 'type is not the problem here');
  assert.equal(got.inversions, 1);
  deepEqual(got.inversionSamples[0], { row: 4, prev: '2026-03-11', cur: '2026-03-10' });
});

test('Phase 0: MIXED-TYPE is reported even when the column is non-decreasing', function () {
  // THE pin. Dates first, then text -- exactly what Sheets produces after
  // sorting a mixed column, and it is ascending end to end. An order-only
  // check passes; the census must still say MIXED-TYPE.
  const got = scan({
    'DQE Historical Data': dqeSheet([
      dateCell(2026, 3, 9), dateCell(2026, 3, 10), textCell('3/11/2026'), textCell('3/12/2026'),
    ]),
  })['DQE Historical Data'];
  assert.equal(got.ordered, true, 'fixture really is non-decreasing');
  assert.equal(got.inversions, 0);
  assert.equal(got.singleTyped, false);
  assert.equal(got.verdict, 'MIXED-TYPE');
  assert.equal(got.types['date'], 2);
  assert.equal(got.types['text:mdy'], 2);
});

test('Phase 0: type ranges expose an ERA split rather than just a count', function () {
  const got = scan({
    'DQE Historical Data': dqeSheet([
      textCell('3/1/2026'), textCell('3/2/2026'), dateCell(2026, 3, 3), dateCell(2026, 3, 4),
    ]),
  })['DQE Historical Data'];
  deepEqual(got.typeRanges['text:mdy'], { firstRow: 2, lastRow: 3 });
  deepEqual(got.typeRanges['date'],     { firstRow: 4, lastRow: 5 });
});

test('Phase 0: an unresolvable cell is counted, never guessed at', function () {
  // A numeric serial rendered under a NUMERIC format displays as a bare
  // number. parseDateForNeon cannot read it, and the census must say so
  // rather than inventing a date -- these rows need a repair, not a sort.
  const got = scan({
    'DQE Historical Data': dqeSheet([dateCell(2026, 3, 9), serialCell(45726), dateCell(2026, 3, 11)]),
  })['DQE Historical Data'];
  assert.equal(got.unparsed, 1);
  assert.equal(got.unparsedSamples[0].row, 3);
  assert.equal(got.unparsedSamples[0].type, 'serial');
  assert.ok(got.verdict.indexOf('UNPARSED') >= 0, 'verdict names it: ' + got.verdict);
  // The unreadable cell must not corrupt the range of the cells that DID read.
  assert.equal(got.minIso, '2026-03-09');
  assert.equal(got.maxIso, '2026-03-11');
});

test('Phase 0: blanks are ignored for single-typedness and for ordering', function () {
  const got = scan({
    'DQE Historical Data': dqeSheet([dateCell(2026, 3, 9), BLANK, dateCell(2026, 3, 10)]),
  })['DQE Historical Data'];
  assert.equal(got.singleTyped, true, 'a blank is not a second type');
  assert.equal(got.verdict, 'CLEAN');
  assert.equal(got.types['blank'], 1);
});

test('Phase 0: every one of the five historical sheets is scanned, at its own date column', function () {
  // The Phase 0 finding that reshaped the plan: only DQE sorts itself on
  // write. A census that covered DQE alone would have missed that Q Path /
  // QCD / CSR Transfer never sort on the daily path at all.
  const got = scan({
    'DQE Historical Data':          dqeSheet([dateCell(2026, 3, 9)]),
    'QCD Historical Data':          colCSheet([dateCell(2026, 3, 9)]),
    'CDR Historical Data':          colCSheet([dateCell(2026, 3, 9)]),
    'CSR Transfer Historical Data': colCSheet([dateCell(2026, 3, 9)]),
    'Q Path Historical Data':       colCSheet([dateCell(2026, 3, 9)]),
  });
  assert.deepEqual(Object.keys(got).sort(), [
    'CDR Historical Data', 'CSR Transfer Historical Data', 'DQE Historical Data',
    'QCD Historical Data', 'Q Path Historical Data',
  ].sort());
  assert.equal(got['DQE Historical Data'].dateCol, 2, 'DQE dates live in col B');
  ['QCD Historical Data', 'CDR Historical Data', 'CSR Transfer Historical Data',
   'Q Path Historical Data'].forEach(function (name) {
    assert.equal(got[name].dateCol, 3, name + ' dates live in col C');
    assert.equal(got[name].verdict, 'CLEAN', name);
  });
});

test('Phase 0: a missing or empty sheet reads distinctly, and never throws', function () {
  const got = scan({ 'DQE Historical Data': dqeSheet([]) });   // header only
  assert.equal(got['DQE Historical Data'].verdict, 'EMPTY');
  assert.equal(got['QCD Historical Data'].verdict, 'MISSING');
  assert.equal(got['QCD Historical Data'].rows, 0);
});

test('Phase 0: the census WRITES NOTHING (it is a preview, and the sheet is live)', function () {
  install({
    'DQE Historical Data': dqeSheet([dateCell(2026, 3, 10), dateCell(2026, 3, 9)]),
  });
  const sheet = h.state.spreadsheet.getSheetByName('DQE Historical Data');
  const before = JSON.stringify(sheet.getRange(1, 1, sheet.getLastRow(), 3).getValues());
  h.call('previewHistoricalDateColumns');
  const after = JSON.stringify(sheet.getRange(1, 1, sheet.getLastRow(), 3).getValues());
  assert.equal(after, before, 'cell values unchanged');
  assert.equal(sheet._numberFormats, undefined, 'no setNumberFormat call');
});

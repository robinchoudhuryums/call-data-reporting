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
const { formatDate } = require('../harness/formatDate');
// buildDQEHistoricalData.js is loaded for dateAtSheetMidnight_ (R46): the
// writer's own col-B construction, which the repair and these fixtures share.
const h = loadGas({ project: 'cdr-report', files: ['neonWrite.js', 'buildDQEHistoricalData.js', 'sheetRepairs.js'] });

// R46: the fake spreadsheet DEFAULTS to a timezone that is NOT the script's
// (the shim's Session.getScriptTimeZone() is America/Chicago, and CI pins the
// process TZ to it) -- roadmap 1a; cross-file-pins pins the two apart. Mexico
// City is UTC-6 year round, Chicago UTC-5 in summer -- the live pair, one hour
// apart from March to November. A script-TZ midnight built for a SUMMER date
// is 23:00 of the previous day here, which is what the first live Phase 1 run
// wrote 9,516 times. (Winter dates cannot show the split: both zones are UTC-6.)
const SS_TZ = makeFakeSpreadsheet({ sheets: {} }).getSpreadsheetTimeZone();
const SCRIPT_TZ = 'America/Chicago';
function sheetMidnight(y, m, d) { return h.call('dateAtSheetMidnight_', SS_TZ, y, m, d); }
function inTz(v, tz) { return formatDate(v, tz, 'yyyy-MM-dd HH:mm'); }

const HEADERS = ['Month', 'Date', 'Agent'];

// A cell is (raw value, rendered display) -- the real distinction the census
// depends on. A Date-typed cell RENDERS as "3/9/2026"; stringifying the JS
// Date instead would feed parseDateForNeon a UTC instant and shift it a day
// (the F-8 class), which is a property of the fake, not of Sheets.
function dateCell(y, m, d) {
  return { v: sheetMidnight(y, m, d), disp: m + '/' + d + '/' + y, fmt: 'M/d/yyyy' };
}
// R46: the shifted shape -- a Date at SCRIPT-TZ midnight of (y, m, d), which
// the Mexico City sheet renders as 23:00 of the day before. Built as an
// explicit instant so the fixture does not depend on the process TZ.
function scriptMidnightCell(y, m, d) {
  const want = Date.UTC(y, m - 1, d);
  let t = want;
  for (let k = 0; k < 3; k++) {
    const seen = Date.parse(inTz(new Date(t), SCRIPT_TZ).replace(' ', 'T') + ':00Z');
    if (seen === want) break;
    t += want - seen;
  }
  const v = new Date(t);
  return { v: v, disp: formatDate(v, SS_TZ, 'M/d/yyyy H:mm') + ':00', fmt: '' };
}
// Phase 0b: a text cell may sit in a plain-text ('@') cell -- the live
// finding -- or in a General cell (a writer emitting a non-coercible string).
function textCell(str, fmt) { return { v: str, disp: str, fmt: fmt || 'General' }; }
function serialCell(n)      { return { v: n, disp: String(n), fmt: '0' }; }   // numeric number-format
const BLANK = { v: '', disp: '', fmt: 'General' };

// DQE keeps its date in col B; the other four use col C.
function buildSheet(cells, dateIdx) {
  const values = [], displays = [], formats = [];
  const header = ['Month', 'Date', 'Agent', 'x'];
  values.push(header.slice()); displays.push(header.slice());
  formats.push(['General', 'General', 'General', 'General']);
  cells.forEach(function (c, i) {
    const v = ['Mar, 26', 'W1', 'row' + i, 'x'];
    const d = v.slice();
    const f = ['General', 'General', 'General', 'General'];
    v[dateIdx] = c.v; d[dateIdx] = c.disp; f[dateIdx] = c.fmt;
    values.push(v); displays.push(d); formats.push(f);
  });
  return { values: values, displays: displays, formats: formats };
}
function dqeSheet(cells)   { return buildSheet(cells, 1); }
function colCSheet(cells)  { return buildSheet(cells, 2); }

function install(sheets) {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: sheets });
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
  // (Phase 0b added minIso/maxIso to each entry -- asserted in its own test.)
  assert.equal(got.typeRanges['text:mdy'].firstRow, 2);
  assert.equal(got.typeRanges['text:mdy'].lastRow, 3);
  assert.equal(got.typeRanges['date'].firstRow, 4);
  assert.equal(got.typeRanges['date'].lastRow, 5);
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

// ── Phase 0b ─────────────────────────────────────────────────────────────

test('Phase 0b: each type reports its own ISO range, so an era boundary is a DATE', function () {
  // The live census found rows 2-22470 Date-typed and 22471-31912 text, in
  // order -- but could not say when the boundary was, because it printed
  // only row numbers. Per-type min/max names the boundary date directly.
  const got = scan({
    'DQE Historical Data': dqeSheet([
      dateCell(2026, 3, 1), dateCell(2026, 3, 2), textCell('3/3/2026'), textCell('3/4/2026'),
    ]),
  })['DQE Historical Data'];
  deepEqual(got.typeRanges['date'],
    { firstRow: 2, lastRow: 3, minIso: '2026-03-01', maxIso: '2026-03-02' });
  deepEqual(got.typeRanges['text:mdy'],
    { firstRow: 4, lastRow: 5, minIso: '2026-03-03', maxIso: '2026-03-04' });
});

test('Phase 0b: the number-format histogram separates plain-text cells from a text-emitting writer', function () {
  // THE Phase 1 gate. A coercible "M/D/YYYY" string stays text in an '@'
  // cell; the same string in a General cell would have coerced to a Date.
  // Which one the live sheet is decides whether the repair resets formats.
  const got = scan({
    'DQE Historical Data': dqeSheet([
      dateCell(2026, 3, 1), textCell('3/2/2026', '@'), textCell('3/3/2026', '@'),
      textCell('3/4/2026', 'General'),
    ]),
  })['DQE Historical Data'];
  deepEqual(got.formats['date'],     { 'M/d/yyyy': 1 });
  deepEqual(got.formats['text:mdy'], { '@': 2, 'General': 1 });
});

test('Phase 0b: a failing format read costs only the format signal, never the census', function () {
  // getNumberFormats is the SECONDARY signal. If the platform refuses it
  // (quota, a sheet shape the API rejects), the type/order/range findings
  // must still come back -- they are what Phase 1's scope hangs on.
  install({
    'DQE Historical Data': dqeSheet([dateCell(2026, 3, 1), dateCell(2026, 3, 2)]),
  });
  const sheet = h.state.spreadsheet.getSheetByName('DQE Historical Data');
  const realGetRange = sheet.getRange;
  sheet.getRange = function () {
    const r = realGetRange.apply(sheet, arguments);
    r.getNumberFormats = function () { throw new Error('formats unavailable'); };
    return r;
  };
  const census = h.call('previewHistoricalDateColumns');
  const got = census.sheets.filter(function (x) { return x.sheet === 'DQE Historical Data'; })[0];
  assert.equal(got.formats, null, 'format signal marked unreadable');
  assert.equal(got.verdict, 'CLEAN', 'every other finding still computed');
  assert.equal(got.rows, 2);
  assert.equal(got.minIso, '2026-03-01');
  assert.equal(got.typeRanges['date'].maxIso, '2026-03-02');
});

// ── Phase 1: the repair ──────────────────────────────────────────────────

function colB(sheet) {
  return sheet._data.slice(1).map(function (r) { return r[1]; });
}
function localIso(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
    + '-' + String(d.getDate()).padStart(2, '0');
}

test('Phase 1: preview counts the text cells and writes nothing', function () {
  install({ 'DQE Historical Data': dqeSheet([
    dateCell(2026, 3, 6), textCell('3/9/2026'), textCell('3/10/2026'), BLANK,
  ]) });
  const sheet = h.state.spreadsheet.getSheetByName('DQE Historical Data');
  const before = JSON.stringify(colB(sheet).map(String));
  const res = h.call('previewDqeDateNormalize');
  assert.equal(res.applied, false);
  assert.equal(res.alreadyDate, 1);
  assert.equal(res.converted, 2);
  assert.equal(res.blank, 1);
  assert.deepEqual(res.refused.length, 0);
  assert.equal(JSON.stringify(colB(sheet).map(String)), before, 'preview wrote nothing');
  assert.equal(sheet._numberFormats, undefined, 'and touched no number format');
});

test('Phase 1: apply converts text "M/D/YYYY" to a SHEET-MIDNIGHT Date, skips Dates and blanks, then sorts', function () {
  // Post-cutover text rows landed AFTER the Date rows (the live shape) and,
  // to prove the sort ran, one text row is older than the last Date row.
  install({ 'DQE Historical Data': dqeSheet([
    dateCell(2026, 3, 5), dateCell(2026, 3, 6), textCell('3/10/2026'), textCell('3/4/2026'), BLANK,
  ]) });
  const sheet = h.state.spreadsheet.getSheetByName('DQE Historical Data');
  const res = h.call('repairDqeDateNormalize');
  assert.equal(res.applied, true);
  assert.equal(res.converted, 2);
  const b = colB(sheet).filter(function (v) { return v !== ''; });
  b.forEach(function (v, i) {
    assert.ok(v instanceof Date, 'row ' + i + ' is a Date after apply');
    assert.equal(inTz(v, SS_TZ).slice(11), '00:00',
      'row ' + i + ' is midnight in the SPREADSHEET TZ -- the writer\'s construction (R46)');
  });
  // The fake's sort is a no-op (tests filter by key rather than row order), so
  // order is asserted on the CONVERTED set, not the sheet: every date is present
  // and each converted cell carries its own calendar date, not a neighbour's.
  const isos = b.map(function (v) { return inTz(v, SS_TZ).slice(0, 10); }).sort();
  assert.deepEqual(isos, ['2026-03-04', '2026-03-05', '2026-03-06', '2026-03-10']);
  assert.equal(sheet._numberFormats, undefined, 'no number-format write -- the cells are automatic-format');
});

test('Phase 1: the repair is idempotent -- a second apply converts nothing', function () {
  install({ 'DQE Historical Data': dqeSheet([dateCell(2026, 3, 6), textCell('3/9/2026')]) });
  assert.equal(h.call('repairDqeDateNormalize').converted, 1);
  const again = h.call('repairDqeDateNormalize');
  assert.equal(again.converted, 0);
  assert.equal(again.alreadyDate, 2);
  assert.equal(again.applied, false, 'nothing to write, so no sort either');
});

test('Phase 1: any cell that is neither Date nor "M/D/YYYY" text REFUSES the whole apply', function () {
  // A stray ISO string and a bare serial. Converting the good cells around them
  // would leave col B mixed -- still unsortable -- while looking repaired.
  install({ 'DQE Historical Data': dqeSheet([
    textCell('3/9/2026'), textCell('2026-03-10'), serialCell(45726), textCell('3/11/2026'),
  ]) });
  const sheet = h.state.spreadsheet.getSheetByName('DQE Historical Data');
  const res = h.call('repairDqeDateNormalize');
  assert.equal(res.applied, false);
  assert.equal(res.refused.length, 2);
  assert.equal(res.refused[0].row, 3);
  assert.equal(res.refused[0].type, 'text:iso');
  assert.equal(res.refused[1].row, 4);
  assert.equal(res.refused[1].type, 'serial');
  // The convertible cells were NOT converted -- whole-run refusal.
  assert.equal(typeof colB(sheet)[0], 'string', 'row 2 left as text');
  assert.equal(typeof colB(sheet)[3], 'string', 'row 5 left as text');
});

test('Phase 1: an impossible calendar date is refused, never rolled forward', function () {
  // new Date(2026, 1, 30) silently becomes March 2. The build never emits such
  // a string, but a hand-pasted row could; the repair must not invent a date.
  const d = h.call('dqeDateFromMdy_', '2/30/2026', SS_TZ);
  assert.equal(d, null);
  const ok = h.call('dqeDateFromMdy_', '2/28/2026', SS_TZ);
  assert.equal(inTz(ok, SS_TZ), '2026-02-28 00:00');
});

// ── Phase 1b / R46: the timezone of a date-only cell ───────────────────────
//
// The first live Phase 1 run built every converted cell with
// `new Date(Y, M-1, D)` -- midnight in the SCRIPT's timezone -- and the
// spreadsheet, one hour behind in summer, rendered all 9,516 of them as 23:00
// of the previous day. The census then read CLEAN, because a display value of
// "9/8/2026 23:00:00" parses as a perfectly valid 9/8. These pins are the
// ones that would have failed.

test('R46: dateAtSheetMidnight_ builds midnight in the SPREADSHEET timezone, whatever the process TZ', function () {
  // Tokyo is +9: far from every plausible process TZ, so a process-local
  // midnight can never coincide with the right answer by accident.
  const d = h.call('dateAtSheetMidnight_', 'Asia/Tokyo', 2026, 9, 9);
  assert.equal(inTz(d, 'Asia/Tokyo'), '2026-09-09 00:00');
  assert.equal(inTz(d, 'UTC'), '2026-09-08 15:00');
  // The live pair, on a summer date: Mexico City midnight is 05:00 Chicago...
  const mx = h.call('dateAtSheetMidnight_', SS_TZ, 2026, 9, 9);
  assert.equal(inTz(mx, SS_TZ), '2026-09-09 00:00');
  assert.equal(inTz(mx, SCRIPT_TZ), '2026-09-09 01:00');
  // ...and a winter date coincides (both UTC-6) -- the reason the bug was
  // invisible in March fixtures.
  const mxw = h.call('dateAtSheetMidnight_', SS_TZ, 2026, 1, 15);
  assert.equal(inTz(mxw, SCRIPT_TZ), '2026-01-15 00:00');
  // Impossible dates are refused, never rolled.
  assert.equal(h.call('dateAtSheetMidnight_', SS_TZ, 2026, 2, 30), null);
  assert.equal(h.call('dateAtSheetMidnight_', SS_TZ, 2026, 13, 1), null);
});

test('R46: the converted cell is sheet midnight, NOT script midnight -- the live shift, on a summer date', function () {
  install({ 'DQE Historical Data': dqeSheet([textCell('9/9/2026')]) });
  const sheet = h.state.spreadsheet.getSheetByName('DQE Historical Data');
  h.call('repairDqeDateNormalize');
  const v = colB(sheet)[0];
  assert.equal(inTz(v, SS_TZ), '2026-09-09 00:00', 'midnight where the sheet renders it');
  assert.equal(inTz(v, SCRIPT_TZ), '2026-09-09 01:00', 'and the SAME calendar day in the script TZ');
  // The fake now renders Dates in the spreadsheet TZ, so the display path
  // agrees with the sheet the dup guard and the census will read.
  assert.equal(sheet.getRange(2, 2).getDisplayValues()[0][0], '9/9/2026');
});

test('R46: a Date at script-TZ midnight that is not sheet midnight is RE-ANCHORED to its own calendar day', function () {
  // Row 2 is the shifted shape (23:00 of 9/8 on the sheet, meant 9/9); row 3
  // is a correct cell; row 4 is text. The preview must count them apart and
  // the apply must leave all three at sheet midnight of the RIGHT day.
  install({ 'DQE Historical Data': dqeSheet([
    scriptMidnightCell(2026, 9, 9), dateCell(2026, 9, 8), textCell('9/10/2026'),
  ]) });
  const sheet = h.state.spreadsheet.getSheetByName('DQE Historical Data');
  assert.equal(sheet.getRange(2, 2).getDisplayValues()[0][0], '9/8/2026 23:00:00', 'fixture renders the live shift');
  const pre = h.call('previewDqeDateNormalize');
  assert.equal(pre.reanchored, 1);
  assert.equal(pre.alreadyDate, 1);
  assert.equal(pre.converted, 1);
  deepEqual(pre.reanchorRange, { firstRow: 2, lastRow: 2, minIso: '2026-09-09', maxIso: '2026-09-09' });   // legacy deepEqual: vm-realm object
  assert.equal(pre.refused.length, 0);
  assert.equal(inTz(colB(sheet)[0], SS_TZ), '2026-09-08 23:00', 'preview wrote nothing');
  const res = h.call('repairDqeDateNormalize');
  assert.equal(res.applied, true);
  assert.equal(res.reanchored, 1);
  const days = colB(sheet).map(function (v) { return inTz(v, SS_TZ); });
  // The apply sorts col B after writing (the build's own after-write sort), and
  // since Batch 4 the fake MODELS Range.sort, so the rows land in date order.
  assert.deepEqual(days, ['2026-09-08 00:00', '2026-09-09 00:00', '2026-09-10 00:00']);
  // Idempotent: a second pass sees three cells at sheet midnight.
  const again = h.call('repairDqeDateNormalize');
  assert.equal(again.alreadyDate, 3);
  assert.equal(again.reanchored + again.converted, 0);
});

test('R46: a Date with a genuine time-of-day in BOTH zones is refused, never re-anchored by guess', function () {
  // Noon Chicago = 11:00 Mexico City: neither zone reads midnight, so the cell
  // is of unknown provenance and the whole apply refuses (the Phase 1 rule).
  const noon = new Date(Date.UTC(2026, 8, 9, 17, 0, 0));
  install({ 'DQE Historical Data': dqeSheet([
    { v: noon, disp: '9/9/2026 11:00:00', fmt: '' }, textCell('9/10/2026'),
  ]) });
  const sheet = h.state.spreadsheet.getSheetByName('DQE Historical Data');
  const res = h.call('repairDqeDateNormalize');
  assert.equal(res.applied, false);
  assert.equal(res.refused.length, 1);
  assert.equal(res.refused[0].type, 'date:time');
  assert.equal(typeof colB(sheet)[1], 'string', 'the text cell was left alone -- whole-run refusal');
});

test('R46: the census flags TZ-SPLIT when a Date cell reads a different calendar day in the two zones', function () {
  // The shifted cell reads 9/8 on the sheet and 9/9 to the script; a
  // CDR-style NOON cell reads 9/9 in both and is NOT flagged -- the check is
  // on the calendar DAY, not on having a time component.
  const noon = new Date(Date.UTC(2026, 8, 9, 17, 0, 0));
  const by = scan({
    'DQE Historical Data': dqeSheet([dateCell(2026, 9, 8), scriptMidnightCell(2026, 9, 9)]),
    'CDR Historical Data': colCSheet([{ v: noon, disp: '9/9/2026', fmt: 'm/d/yyyy' }]),
  });
  const dqe = by['DQE Historical Data'];
  assert.equal(dqe.tzSplit, 1);
  deepEqual(dqe.tzSplitSamples, [{ row: 3, sheet: '2026-09-08', script: '2026-09-09' }]);   // legacy deepEqual: vm-realm objects
  assert.match(dqe.verdict, /TZ-SPLIT/);
  // Without the R46 check this sheet read CLEAN: single-typed, ordered (9/8, 9/8), parsed.
  assert.equal(dqe.singleTyped, true);
  assert.equal(dqe.ordered, true);
  assert.equal(dqe.unparsed, 0);
  const cdr = by['CDR Historical Data'];
  assert.equal(cdr.tzSplit, 0);
  assert.equal(cdr.verdict, 'CLEAN');
});

test('R46: the fake sheet renders a Date in the SPREADSHEET timezone -- the shift is visible on the display path', function () {
  // No explicit display grid here: the fake must derive the display from the
  // raw value, as Sheets does. A script-TZ midnight of 9/9 renders as 9/8 in
  // a Mexico City sheet -- the exact thing the dup guard, the census and every
  // backfill read after the first live run.
  const ss = makeFakeSpreadsheet({ sheets: { X: [
    ['Date'], [scriptMidnightCell(2026, 9, 9).v], [sheetMidnight(2026, 9, 9)],
  ] } });
  const disp = ss.getSheetByName('X').getRange(2, 1, 2, 1).getDisplayValues().map(function (r) { return r[0]; });
  assert.deepEqual(disp, ['9/8/2026', '9/9/2026']);
});

test('R46: the writer and the repair build a col-B Date ONLY through dateAtSheetMidnight_ (source pin)', function () {
  const fs = require('fs'), path = require('path');
  const root = path.join(__dirname, '..', '..', 'apps-script');
  ['cdr-report', 'cdr-import'].forEach(function (proj) {
    const src = fs.readFileSync(path.join(root, proj, 'buildDQEHistoricalData.js'), 'utf8');
    const write = src.slice(src.indexOf('const colBDate = dateAtSheetMidnight_('), src.indexOf('const newLastRow'));
    assert.ok(write.length > 0, proj + ': col-B write site found');
    assert.ok(/return \[colBDate\]/.test(write), proj + ': col B is written from the helper\'s instant');
    assert.ok(!/return \[callDateObj\]/.test(write), proj + ': never callDateObj itself (script-TZ midnight)');
  });
  const rep = fs.readFileSync(path.join(root, 'cdr-report', 'sheetRepairs.js'), 'utf8');
  const fn = rep.slice(rep.indexOf('function dqeDateFromMdy_('), rep.indexOf('function normalizeDqeDateColumn_('));
  assert.ok(/return dateAtSheetMidnight_\(/.test(fn), 'dqeDateFromMdy_ returns the helper\'s instant');
  assert.ok(!/return d;/.test(fn), 'and never the local-midnight probe');
});

test('Batch 4: the TZ-SPLIT predicate is memoized per distinct INSTANT (a nightly job cannot afford ~32k formatDate pairs)', function () {
  // 300 rows over 3 distinct instants -> at most 2 formatDate calls per
  // instant (sheet zone + script zone), not 2 per row. parseDateForNeon's
  // M/D/YYYY path never formats, so the count is the predicate's alone.
  const cells = [];
  for (let i = 0; i < 300; i++) cells.push(dateCell(2026, 6, 1 + (i % 3)));
  install({ 'DQE Historical Data': dqeSheet(cells) });
  const real = h.ctx.Utilities.formatDate;
  let calls = 0;
  h.ctx.Utilities.formatDate = function () { calls++; return real.apply(this, arguments); };
  try {
    const census = h.call('previewHistoricalDateColumns');
    const dqe = census.sheets.filter(function (s) { return s.sheet === 'DQE Historical Data'; })[0];
    assert.equal(dqe.rows, 300);
    assert.equal(dqe.verdict, 'MIXED-TYPE+UNSORTED'.length ? (dqe.ordered ? 'CLEAN' : 'UNSORTED') : '', 'sanity');
    assert.ok(calls > 0, 'the predicate ran');
    assert.ok(calls <= 2 * 3, 'formatDate calls bounded by 2 x distinct instants, got ' + calls);
  } finally {
    h.ctx.Utilities.formatDate = real;
  }
});

test('Batch 4: the memo does not change the verdict -- a shifted instant is still flagged on every row that carries it', function () {
  const cells = [dateCell(2026, 7, 1), scriptMidnightCell(2026, 7, 2), scriptMidnightCell(2026, 7, 2), dateCell(2026, 7, 3)];
  const byName = scan({ 'DQE Historical Data': dqeSheet(cells) });
  const dqe = byName['DQE Historical Data'];
  assert.equal(dqe.tzSplit, 2, 'both rows counted');
  assert.match(dqe.verdict, /TZ-SPLIT/);
});

test('Batch 4: a serial cell displaying a bare number is UNPARSED through the shared resolver (the census no longer guards it alone)', function () {
  const byName = scan({ 'DQE Historical Data': dqeSheet([dateCell(2026, 6, 1), serialCell(46114), dateCell(2026, 6, 3)]) });
  const dqe = byName['DQE Historical Data'];
  assert.equal(dqe.unparsed, 1);
  assert.equal(dqe.maxIso, '2026-06-03', 'the serial never became a year-46114 maxIso');
  assert.equal(h.fn('parseDateForNeon')('46114'), null, 'the resolver itself refuses it');
});

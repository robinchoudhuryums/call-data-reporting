'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deepEqual } = require('node:assert'); // legacy: prototype-agnostic for cross-realm vm values
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');

// Util.gs pulls a couple of names from Config.gs (none at load time);
// load both so the shared-scope refs resolve.
const h = loadGas({ files: ['Config.gs', 'Util.gs'], capture: ['SHEETS', 'COMPANY_HOLIDAYS_HEADERS'] });

test('round1_ rounds to one decimal and coerces junk to 0', function () {
  assert.equal(h.call('round1_', 3.14159), 3.1);
  assert.equal(h.call('round1_', 3.15), 3.2);
  assert.equal(h.call('round1_', -2.449), -2.4);
  assert.equal(h.call('round1_', null), 0);
  assert.equal(h.call('round1_', 'not a number'), 0);
  assert.equal(h.call('round1_', 0), 0);
});

test('formatSecondsHms_ matches the Sonia 2026-03-09 spot-check (S7)', function () {
  // CLAUDE.md Operator State #5 / S7: TTT 0:15:03, ATT 0:03:01.
  assert.equal(h.call('formatSecondsHms_', 903), '0:15:03');   // TTT
  assert.equal(h.call('formatSecondsHms_', 181), '0:03:01');   // ATT
});

test('formatSecondsHms_ zero/empty and padding/rounding', function () {
  assert.equal(h.call('formatSecondsHms_', 0), '0:00:00');
  assert.equal(h.call('formatSecondsHms_', null), '0:00:00');
  assert.equal(h.call('formatSecondsHms_', undefined), '0:00:00');
  assert.equal(h.call('formatSecondsHms_', 3661), '1:01:01');
  assert.equal(h.call('formatSecondsHms_', 59), '0:00:59');
  assert.equal(h.call('formatSecondsHms_', 90.4), '0:01:30');  // rounds
  assert.equal(h.call('formatSecondsHms_', 89.6), '0:01:30');
});

test('escapeHtmlServer_ neutralizes all five entities', function () {
  assert.equal(h.call('escapeHtmlServer_', '<b>"x"&\'y\'</b>'),
    '&lt;b&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/b&gt;');
  assert.equal(h.call('escapeHtmlServer_', null), '');
  assert.equal(h.call('escapeHtmlServer_', 42), '42');
  // & is escaped first so existing entities aren't double-mangled into ambiguity
  assert.equal(h.call('escapeHtmlServer_', 'a & b'), 'a &amp; b');
});

test('generateMonthList_ inclusive, spans year boundary', function () {
  deepEqual(
    h.call('generateMonthList_', new Date(2025, 0, 15), new Date(2025, 2, 3)),
    ['2025-01', '2025-02', '2025-03']);
  // single month
  deepEqual(
    h.call('generateMonthList_', new Date(2026, 4, 1), new Date(2026, 4, 28)),
    ['2026-05']);
  // across Dec -> Jan
  deepEqual(
    h.call('generateMonthList_', new Date(2025, 10, 2), new Date(2026, 1, 9)),
    ['2025-11', '2025-12', '2026-01', '2026-02']);
});

test('buildTeamInsights_ gates on non-trivial volume and caps at 3', function () {
  // Trivial volume (both rung < 10) -> no insights.
  deepEqual(h.call('buildTeamInsights_', { rung: 3, pct: 50 }, { rung: 2, pct: 90 }), []);

  // Answer-rate swing >= 5 pts surfaces a negative insight.
  const out = h.call('buildTeamInsights_',
    { rung: 100, pct: 70, answered: 70, missed: 5, att: 180 },
    { rung: 100, pct: 90, answered: 90, missed: 5, att: 180 });
  assert.ok(out.length >= 1 && out.length <= 3);
  assert.equal(out[0].type, 'negative');
  assert.match(out[0].text, /Answer rate fell/);
});

test('buildTeamInsights_ excludeVolume drops raw-volume insights, keeps rate + ATT', function () {
  // Big answer-rate swing + big answered-volume swing + big missed swing +
  // big ATT swing -> without the flag, volume insights appear.
  const curr = { rung: 200, pct: 70, answered: 140, missed: 40, att: 240 };
  const prev = { rung: 100, pct: 90, answered: 90,  missed: 5,  att: 180 };

  const full = h.call('buildTeamInsights_', curr, prev);
  assert.ok(full.some(function (i) { return /call volume/.test(i.text); }),
    'volume insight present without the flag');

  const trimmed = h.call('buildTeamInsights_', curr, prev, { excludeVolume: true });
  assert.ok(!trimmed.some(function (i) { return /call volume|Missed-call count/.test(i.text); }),
    'no raw-volume insights with excludeVolume');
  assert.ok(trimmed.some(function (i) { return /Answer rate/.test(i.text); }),
    'answer-rate insight retained');
  assert.ok(trimmed.some(function (i) { return /Avg talk time/.test(i.text); }),
    'avg-talk-time insight retained');
});

test('assertAdmin_ throws for non-admins, passes for admins', function () {
  // resolveUser_ lives in Auth.gs; inject a stub into the shared scope
  // so we exercise assertAdmin_'s role check in isolation.
  h.ctx.resolveUser_ = function (email) {
    return { role: email === 'admin@x.com' ? 'admin' : 'manager' };
  };

  h.state.userEmail = 'manager@x.com';
  assert.throws(function () { h.call('assertAdmin_'); }, /admin-only/);

  h.state.userEmail = 'admin@x.com';
  assert.doesNotThrow(function () { h.call('assertAdmin_'); });
});

test('countWorkingDays_ counts Mon-Fri inclusive (INV-35 working-day mismatch)', function () {
  // A single Mon-Fri week = 5 workdays.
  assert.equal(h.call('countWorkingDays_', '2026-03-02', '2026-03-06'), 5);
  // Mon..next Mon spans a weekend = 6 workdays (the 1.2x partner of 5).
  assert.equal(h.call('countWorkingDays_', '2026-04-06', '2026-04-13'), 6);
  // 10 calendar days (Fri..Sun, 2 weekends) and 8 calendar days (Mon..Mon,
  // 1 weekend) are BOTH 6 workdays -- the equal-workday case that must NOT
  // read as a mismatch despite the 1.25x calendar ratio.
  assert.equal(h.call('countWorkingDays_', '2026-03-06', '2026-03-15'), 6);
  assert.equal(h.call('countWorkingDays_', '2026-03-09', '2026-03-16'), 6);
  // A single weekend = 0 workdays; empty/garbage input = 0 (guards the divide).
  assert.equal(h.call('countWorkingDays_', '2026-03-07', '2026-03-08'), 0);
  assert.equal(h.call('countWorkingDays_', '', ''), 0);
  // Reversed args are tolerated (normalized).
  assert.equal(h.call('countWorkingDays_', '2026-03-06', '2026-03-02'), 5);
});

// -- S5: company-holiday awareness -------------------------------------------

function setHolidays(spec) {
  if (spec == null) delete h.state.props.COMPANY_HOLIDAYS;
  else h.state.props.COMPANY_HOLIDAYS = spec;
  h.ctx.COMPANY_HOLIDAYS_MEMO_ = null;   // per-execution memo (tests reset)
}

test('S5: parseSkipDateRanges_ (now shared from Util.gs) is tolerant', function () {
  const out = h.call('parseSkipDateRanges_',
    ' 2026-12-25 , 2026-12-31..2027-01-01, garbage, 2026-07-06..2026-07-03 ');
  deepEqual(out, [
    { from: '2026-12-25', to: '2026-12-25' },
    { from: '2026-12-31', to: '2027-01-01' },
    { from: '2026-07-03', to: '2026-07-06' },   // reversed range swapped
  ]);
  deepEqual(h.call('parseSkipDateRanges_', ''), []);
});

test('S5: countWorkingDays_ excludes company holidays (INV-35)', function () {
  try {
    // Mon Jul 6 2026 is a holiday: Mon-Fri week counts 4, not 5.
    setHolidays('2026-07-06');
    assert.equal(h.call('countWorkingDays_', '2026-07-06', '2026-07-10'), 4);
    // A holiday RANGE spanning the whole week -> 0.
    setHolidays('2026-07-06..2026-07-10');
    assert.equal(h.call('countWorkingDays_', '2026-07-06', '2026-07-10'), 0);
    // A holiday falling on a WEEKEND changes nothing (already excluded).
    setHolidays('2026-07-05');   // Sunday
    assert.equal(h.call('countWorkingDays_', '2026-07-06', '2026-07-10'), 5);
    // Unset property -> byte-identical to pre-S5 (regression safety).
    setHolidays(null);
    assert.equal(h.call('countWorkingDays_', '2026-07-06', '2026-07-10'), 5);
  } finally { setHolidays(null); }
});

test('S5: prevBusinessDayIso_ walks back over weekends AND holidays', function () {
  try {
    setHolidays(null);
    // No holidays: F-6 behavior. Tue Jun 23 -> Mon Jun 22; Mon Jun 22 -> Fri Jun 19.
    assert.equal(h.call('prevBusinessDayIso_', new Date(2026, 5, 23, 8)), '2026-06-22');
    assert.equal(h.call('prevBusinessDayIso_', new Date(2026, 5, 22, 8)), '2026-06-19');
    // Mon Jul 6 2026 is a holiday: Tue Jul 7 walks Mon(holiday) -> Sun -> Sat -> Fri Jul 3.
    setHolidays('2026-07-06');
    assert.equal(h.call('prevBusinessDayIso_', new Date(2026, 6, 7, 8)), '2026-07-03');
    // ...and if Fri Jul 3 is ALSO a holiday (observed 4th), lands on Thu Jul 2.
    setHolidays('2026-07-03, 2026-07-06');
    assert.equal(h.call('prevBusinessDayIso_', new Date(2026, 6, 7, 8)), '2026-07-02');
  } finally { setHolidays(null); }
});

// -- H1: the Company Holidays SHEET is the primary source ---------------------
//
// The list moved to a sheet so an external reader (team-tools, same workbook)
// sees the same calendar. Rules pinned here: the sheet WINS over the property
// the moment it holds one active range (never a union); an absent or empty
// sheet falls back to the property; a FAILED read falls back to the property
// too and is reported; a Date-coerced cell is formatted in the SPREADSHEET's
// tz; Active=FALSE parks a row; the memo is per execution.

function installHolidaySheet(rows, opts) {
  opts = opts || {};
  h.state.props = h.state.props || {};
  h.state.props.SPREADSHEET_ID = 'fake';
  const sheets = {};
  if (rows !== null) sheets[h.consts.SHEETS.COMPANY_HOLIDAYS] = [h.consts.COMPANY_HOLIDAYS_HEADERS.slice()].concat(rows);
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: sheets, timeZone: opts.timeZone });
  h.ctx.COMPANY_HOLIDAYS_MEMO_ = null;
  h.ctx.COMPANY_HOLIDAYS_SOURCE_ = '';
}
function uninstallHolidaySheet() {
  delete h.state.spreadsheet;
  setHolidays(null);
  h.ctx.COMPANY_HOLIDAYS_SOURCE_ = '';
}

test('H1: the Company Holidays sheet is read (one range per row, comma lists, Active=FALSE parked)', function () {
  try {
    installHolidaySheet([
      ['2026-07-06', 'Observed 4th', '', ''],
      ['2026-11-26..2026-11-27', 'Thanksgiving', 'TRUE', ''],
      ['2026-12-24, 2026-12-25', 'Christmas', true, 'two dates in one cell parse too'],
      ['2026-01-01', 'parked', 'FALSE', 'Active=FALSE is skipped'],
      ['2026-05-25', 'parked (boolean)', false, ''],
      ['', 'blank dates cell is skipped', '', ''],
      ['garbage', 'unparseable token is dropped', '', ''],
    ]);
    setHolidays(null);
    deepEqual(h.call('getCompanyHolidayRanges_'), [
      { from: '2026-07-06', to: '2026-07-06' },
      { from: '2026-11-26', to: '2026-11-27' },
      { from: '2026-12-24', to: '2026-12-24' },
      { from: '2026-12-25', to: '2026-12-25' },
    ]);
    assert.equal(h.call('companyHolidaySource_'), 'sheet');
    assert.equal(h.call('isCompanyHoliday_', '2026-11-27'), true);
    assert.equal(h.call('isCompanyHoliday_', '2026-01-01'), false, 'a parked row does not count');
    // The consumers inherit it: Tue Jul 7 walks over the Mon Jul 6 sheet holiday.
    assert.equal(h.call('prevBusinessDayIso_', new Date(2026, 6, 7, 8)), '2026-07-03');
  } finally { uninstallHolidaySheet(); }
});

test('H1: the sheet WINS over the COMPANY_HOLIDAYS property (never merged) and the shadowing is named', function () {
  try {
    installHolidaySheet([['2026-07-06', 'sheet only', '', '']]);
    setHolidays('2026-09-07');   // property lists a DIFFERENT date
    h.ctx.COMPANY_HOLIDAYS_MEMO_ = null;
    deepEqual(h.call('getCompanyHolidayRanges_'), [{ from: '2026-07-06', to: '2026-07-06' }]);
    assert.equal(h.call('isCompanyHoliday_', '2026-09-07'), false,
      'a property date is NOT unioned in -- a half-migrated property must not hide a date the external reader never sees');
    assert.equal(h.call('companyHolidaySource_'), 'sheet-shadowed', 'the Health row can say the property is ignored');
  } finally { uninstallHolidaySheet(); }
});

test('H1: an absent or EMPTY sheet falls back to the property; neither -> no holidays (pre-S5 behavior)', function () {
  try {
    // Absent sheet (a pre-setup() install).
    installHolidaySheet(null);
    setHolidays('2026-07-06');
    h.ctx.COMPANY_HOLIDAYS_MEMO_ = null;
    deepEqual(h.call('getCompanyHolidayRanges_'), [{ from: '2026-07-06', to: '2026-07-06' }]);
    assert.equal(h.call('companyHolidaySource_'), 'property');
    // Sheet exists but has only parked / blank rows -> still the property.
    installHolidaySheet([['2026-01-01', 'parked', 'FALSE', ''], ['', '', '', '']]);
    setHolidays('2026-07-06');
    h.ctx.COMPANY_HOLIDAYS_MEMO_ = null;
    deepEqual(h.call('getCompanyHolidayRanges_'), [{ from: '2026-07-06', to: '2026-07-06' }]);
    assert.equal(h.call('companyHolidaySource_'), 'property');
    // Nothing anywhere.
    setHolidays(null);
    h.ctx.COMPANY_HOLIDAYS_MEMO_ = null;
    deepEqual(h.call('getCompanyHolidayRanges_'), []);
    assert.equal(h.call('companyHolidaySource_'), 'none');
    assert.equal(h.call('countWorkingDays_', '2026-07-06', '2026-07-10'), 5);
  } finally { uninstallHolidaySheet(); }
});

test('H1: a FAILED sheet read falls back to the property and is reported, never thrown', function () {
  try {
    installHolidaySheet([['2026-07-06', 'unreachable', '', '']]);
    setHolidays('2026-09-07');
    h.ctx.COMPANY_HOLIDAYS_MEMO_ = null;
    const ss = h.state.spreadsheet;
    ss.getSheetByName = function () { throw new Error('Service Spreadsheets timed out'); };
    deepEqual(h.call('getCompanyHolidayRanges_'), [{ from: '2026-09-07', to: '2026-09-07' }]);
    assert.equal(h.call('companyHolidaySource_'), 'property+sheet-error');
    // No spreadsheet at all (a suite that loads Util.gs without a fixture) is
    // the same shape: the property serves, nothing throws.
    delete h.state.spreadsheet;
    h.ctx.COMPANY_HOLIDAYS_MEMO_ = null;
    deepEqual(h.call('getCompanyHolidayRanges_'), [{ from: '2026-09-07', to: '2026-09-07' }]);
  } finally { uninstallHolidaySheet(); }
});

test('H1: a Dates cell Sheets coerced to a Date is keyed in the SPREADSHEET tz (INV-02 twin), not toISOString', function () {
  try {
    // Mexico City midnight of 2026-07-06 is 06:00Z. toISOString() would agree
    // here, so pin a value where the zones DISAGREE: 23:30 Mexico City on
    // Jul 5 is 05:30Z Jul 6 -- toISOString says Jul 6, the sheet says Jul 5.
    installHolidaySheet([[new Date('2026-07-06T05:30:00Z'), 'coerced cell', '', '']],
      { timeZone: 'America/Mexico_City' });
    setHolidays(null);
    deepEqual(h.call('getCompanyHolidayRanges_'), [{ from: '2026-07-05', to: '2026-07-05' }]);
  } finally { uninstallHolidaySheet(); }
});

test('H1: the holiday list is memoized per execution (one sheet read per request)', function () {
  try {
    installHolidaySheet([['2026-07-06', '', '', '']]);
    setHolidays(null);
    const ss = h.state.spreadsheet;
    let reads = 0;
    const real = ss.getSheetByName;
    ss.getSheetByName = function (n) { reads++; return real.call(ss, n); };
    h.call('getCompanyHolidayRanges_');
    h.call('isCompanyHoliday_', '2026-07-06');
    h.call('countWorkingDays_', '2026-07-06', '2026-07-10');
    assert.equal(reads, 1, 'consumers share the one memoized read');
  } finally { uninstallHolidaySheet(); }
});

test('CORE-7: sheetSafeCell_ neutralizes formula-leading cells, passes everything else through', function () {
  const f = h.fn('sheetSafeCell_');
  assert.equal(f('=IMPORTXML("http://evil","x")'), "'=IMPORTXML(\"http://evil\",\"x\")");
  assert.equal(f('+1 (555) 000'), "'+1 (555) 000");
  assert.equal(f('-lead'), "'-lead");
  assert.equal(f('@mention'), "'@mention");
  assert.equal(f('\t=x'), "'\t=x");
  assert.equal(f('Robin Choudhury, 139'), 'Robin Choudhury, 139');
  assert.equal(f('note with = inside'), 'note with = inside');
  assert.equal(f(''), '');
  assert.equal(f(42), 42, 'non-strings untouched');
  const d = new Date(2026, 0, 1);
  assert.equal(f(d), d);
});

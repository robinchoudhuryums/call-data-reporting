'use strict';

// Exception days (owner 2026-10-22, Operator State #81). A day whose call data
// is REAL but unfair to judge by (the 09/21 8x8 outage) is left out of every
// windowed figure -- counts as well as rates, so a screen's numbers still
// reconcile -- and every report says so. Pinned here: the sheet reader and its
// last-good copy, the one DQE exclusion step (all-department vs one-department
// days, roster-only volume, in place), the QCD filter, the working-day walks,
// the admin-only include switch, the cache tag, and the editor's INV-01 write.
// The "every reader calls it" half is cross-file-pins' #81 sweep.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { dqeRow, dqeSheet, rosterGrid } = require('../harness/fixtures');

const J = (x) => JSON.parse(JSON.stringify(x));
const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'CompanyOverview.gs', 'QCDReport.gs',
          'DeptConfig.gs', 'Data.gs', 'NeonRead.gs', 'ExceptionDays.gs'],
  capture: ['SHEETS', 'EXCEPTION_DAYS_HEADERS'],
});

const ROSTER = rosterGrid({ Alpha: ['Anna, 201', 'Ben, 202'], Beta: ['Cara, 301'] });
const REAL_RESOLVE = h.ctx.resolveUser_;
const HEAD = () => h.consts.EXCEPTION_DAYS_HEADERS.slice();

function install(excRows, opts) {
  opts = opts || {};
  h.state.props = Object.assign({ SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' }, opts.props || {});
  h.state.userEmail = opts.user || 'admin@x.com';
  const sheets = { 'DO NOT EDIT!': ROSTER, 'DQE Historical Data': dqeSheet(opts.dqe || []) };
  if (excRows !== null) sheets[h.consts.SHEETS.EXCEPTION_DAYS] = [HEAD()].concat(excRows || []);
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: sheets, timeZone: opts.timeZone });
  h.state.cache.clear();
  h.ctx.resolveUser_ = REAL_RESOLVE;
}

// ── The sheet ─────────────────────────────────────────────────────────────

test('a row parses to { date, depts, reason }; blank / ALL / * is every department; Active=FALSE parks it', function () {
  install(null);
  const row = (r) => J(h.call('exceptionDayFromRow_', r, 'America/Chicago'));
  assert.deepEqual(row(['2026-09-21', '', '8x8 outage', 'TRUE']), { date: '2026-09-21', depts: [], reason: '8x8 outage' });
  assert.deepEqual(row(['2026-09-21', 'ALL', 'x', '']).depts, []);
  assert.deepEqual(row(['2026-09-21', '*', 'x', '']).depts, []);
  assert.deepEqual(row(['2026-09-21', 'CSR, Sales ,', 'x', '']).depts, ['CSR', 'Sales']);
  ['FALSE', 'no', '0', false].forEach(function (a) { assert.equal(row(['2026-09-21', '', 'x', a]), null, String(a)); });
  assert.equal(row(['9/21/2026', '', 'x', '']), null, 'only an ISO date (setup pins the column to plain text)');
  assert.equal(row(['', '', 'x', '']), null);
});

test('a Date-coerced cell is read in the SPREADSHEET time zone', function () {
  install(null);
  // Midnight 09/21 in Mexico City is 23:00 09/20 in Chicago (DST) -- the
  // script TZ would key the day a day early.
  const cell = new Date('2026-09-21T06:00:00Z');
  assert.equal(h.call('exceptionDayFromRow_', [cell, '', 'x', ''], 'America/Mexico_City').date, '2026-09-21');
});

test('getExceptionDays_ reads the sheet oldest first, caches it, and keeps a last-good copy', function () {
  install([['2026-09-21', '', '8x8 outage', 'TRUE'], ['2026-09-02', 'Alpha', 'Fire drill', 'TRUE'],
           ['2026-08-01', '', 'parked', 'FALSE']]);
  const days = J(h.call('getExceptionDays_'));
  assert.deepEqual(days.map((d) => d.date), ['2026-09-02', '2026-09-21']);
  assert.ok(h.state.cache.has('excDays:v1'), 'cached for the next request');
  assert.equal(h.state.props.EXCEPTION_DAYS_SHEET_COPY, JSON.stringify(days));
});

test('a FAILED read serves the last-good copy (one retry) -- never a silent "none"', function () {
  install([['2026-09-21', '', '8x8 outage', 'TRUE']]);
  h.call('getExceptionDays_');
  h.state.cache.clear();
  let calls = 0;
  h.state.spreadsheet.getSheetByName = function () { calls++; throw new Error('Service Spreadsheets timed out'); };
  assert.deepEqual(J(h.call('getExceptionDays_')).map((d) => d.date), ['2026-09-21']);
  assert.equal(calls, 2, 'one retry, then the copy');
});

test('emptying the sheet retires the copy; a missing sheet is no days, not an error', function () {
  install([], { props: { EXCEPTION_DAYS_SHEET_COPY: '[{"date":"2026-09-21","depts":[],"reason":"x"}]' } });
  assert.deepEqual(J(h.call('getExceptionDays_')), []);
  assert.equal(h.state.props.EXCEPTION_DAYS_SHEET_COPY, undefined);
  install(null);
  assert.deepEqual(J(h.call('getExceptionDays_')), []);
});

test('the cache tag is EMPTY with no days (every key unchanged), a hash otherwise, and moves with the list', function () {
  install([]);
  assert.equal(h.call('exceptionDaysTag_'), '');
  assert.equal(h.call('reportFreshnessTag_').indexOf(':x'), -1);
  install([['2026-09-21', '', '8x8 outage', 'TRUE']]);
  const t1 = h.call('exceptionDaysTag_');
  assert.match(t1, /^:x[0-9a-f]{10}$/);
  install([['2026-09-21', '', '8x8 outage (corrected)', 'TRUE']]);
  assert.notEqual(h.call('exceptionDaysTag_'), t1, 'an edit re-keys every report');
});

// ── The DQE step ──────────────────────────────────────────────────────────

function rows() {
  return [
    { dateIso: '2026-09-18', agent: 'Anna', totalRung: 10, totalAnswered: 8, totalMissed: 2 },
    { dateIso: '2026-09-21', agent: 'Anna', totalRung: 40, totalAnswered: 10, totalMissed: 30 },
    { dateIso: '2026-09-21', agent: 'Cara', totalRung: 5, totalAnswered: 1, totalMissed: 4 },
    { dateIso: '2026-09-22', agent: 'Ben', totalRung: 12, totalAnswered: 12, totalMissed: 0 },
  ];
}

test('applyExceptionDays_ removes the day IN PLACE and reports what it held (roster volume only)', function () {
  install([['2026-09-21', '', '8x8 outage', 'TRUE']]);
  const out = h.inExecution(function () {
    const r = rows();
    const info = h.call('applyExceptionDays_', r, 'Alpha', { assessAgents: ['Anna', 'Ben'] });
    return { left: r.map((x) => x.dateIso + ':' + x.agent), info: J(info) };
  });
  assert.deepEqual(out.left, ['2026-09-18:Anna', '2026-09-22:Ben']);
  assert.deepEqual(out.info.excluded, [{ date: '2026-09-21', reason: '8x8 outage', rung: 40, answered: 10, missed: 30 }],
    'Cara (a floater) is removed too but never counted in the roster volume');
  assert.deepEqual(out.info.daily, { '2026-09-21': { answered: 10, missed: 30 } });
});

test('a ONE-department day leaves only that department\'s figures; a company figure keeps it', function () {
  install([['2026-09-21', 'Beta', 'Beta phones down', 'TRUE']]);
  const left = (dept) => h.inExecution(function () {
    const r = rows(); h.call('applyExceptionDays_', r, dept, null); return r.length;
  });
  assert.equal(left('Alpha'), 4, 'Alpha is untouched');
  assert.equal(left('Beta'), 2, 'Beta loses the day');
  assert.equal(left(null), 4, 'the company line drops only ALL-department days');
});

test('no exception days -> the rows and the info are exactly what they were (the common path)', function () {
  install([]);
  const out = h.inExecution(function () {
    const r = rows(); const info = h.call('applyExceptionDays_', r, 'Alpha', null); return { n: r.length, info: J(info) };
  });
  assert.deepEqual(out, { n: 4, info: { excluded: [], daily: {} } });
});

test('computeSummary_ leaves the day out of every figure and says so (meta + the day bars\' list)', function () {
  const dqe = [
    dqeRow({ date: '2026-09-18', agent: 'Anna', ext: '501', rung: 10, answered: 8, missed: 2, ttt: '0:10:00', att: '0:01:15' }),
    dqeRow({ date: '2026-09-21', agent: 'Anna', ext: '501', rung: 40, answered: 10, missed: 30, ttt: '0:05:00', att: '0:00:30' }),
    dqeRow({ date: '2026-09-22', agent: 'Ben', ext: '501', rung: 12, answered: 12, missed: 0, ttt: '0:12:00', att: '0:01:00' }),
  ];
  install([['2026-09-21', '', '8x8 outage', 'TRUE']], { dqe: dqe });
  const d = J(h.call('computeSummary_', 'Alpha', '2026-09-18', '2026-09-22', 'roster', { daily: true }));
  const anna = d.rows.filter((r) => r.agent === 'Anna')[0];
  assert.equal(anna.totalRung, 10, 'counts drop the day too, so the screen reconciles');
  assert.equal(anna.totalMissed, 2);
  assert.equal(d.totals.totalRung, 22);
  assert.deepEqual(d.meta.exceptionDays, [{ date: '2026-09-21', reason: '8x8 outage', rung: 40, answered: 10, missed: 30 }]);
  assert.ok(Array.isArray(d.totals.dailyExcluded) && d.totals.dailyExcluded.length === 1,
    'the day bars still draw the day: ' + JSON.stringify(d.totals.dailyExcluded));
  assert.ok(!(d.totals.daily || []).some((x) => (x.date || x[0]) === '2026-09-21'), 'never among the counted days');

  install([], { dqe: dqe });
  const plain = J(h.call('computeSummary_', 'Alpha', '2026-09-18', '2026-09-22', 'roster', { daily: true }));
  assert.equal(plain.totals.totalRung, 62);
  assert.equal(plain.meta.exceptionDays, undefined, 'no list -> no field (the payload is what it was)');
});

// ── The admin's include switch ────────────────────────────────────────────

test('the include switch is an ADMIN\'s alone; a manager asking for it still gets the exclusion', function () {
  install([['2026-09-21', '', '8x8 outage', 'TRUE']]);
  h.ctx.resolveUser_ = function () { return { role: 'manager', department: 'Alpha', departments: ['Alpha'] }; };
  const mgr = h.inExecution(function () {
    h.call('setExceptionIncludeFromReq_', { includeExceptionDays: true });
    return { on: h.call('exceptionIncludeOn_'), day: J(h.call('exceptionDayFor_', '2026-09-21', 'Alpha')) };
  });
  assert.equal(mgr.on, false);
  assert.equal(mgr.day.reason, '8x8 outage');
  h.ctx.resolveUser_ = function () { return { role: 'admin' }; };
  const adm = h.inExecution(function () {
    h.call('setExceptionIncludeFromReq_', { includeExceptionDays: true });
    const r = rows(); h.call('applyExceptionDays_', r, 'Alpha', null);
    return { on: h.call('exceptionIncludeOn_'), n: r.length, tag: h.call('exceptionDaysTag_') };
  });
  assert.equal(adm.on, true);
  assert.equal(adm.n, 4, 'included: nothing removed');
  assert.match(adm.tag, /i$/, 'the included view caches under its own key');
  h.ctx.resolveUser_ = REAL_RESOLVE;
});

// ── Working days ──────────────────────────────────────────────────────────

test('an ALL-department exception day is not a working day: the per-workday count and the prior window skip it', function () {
  install([['2026-09-21', '', '8x8 outage', 'TRUE']]);
  assert.equal(h.call('countWorkingDays_', '2026-09-21', '2026-09-25'), 4);
  // Tue 9/22 alone compares to the previous WORKING day: Fri 9/18, not Mon 9/21.
  assert.deepEqual(J(h.call('computePriorWindow_', '2026-09-22', '2026-09-22')), { from: '2026-09-18', to: '2026-09-18' });
  assert.equal(h.call('metricsOffDayFn_', 'Alpha')('2026-09-21'), true);
  install([['2026-09-21', 'Beta', 'x', 'TRUE']]);
  assert.equal(h.call('countWorkingDays_', '2026-09-21', '2026-09-25'), 5, 'a one-department day leaves the company count alone');
  assert.equal(h.call('metricsOffDayFn_', 'Beta')('2026-09-21'), true);
  assert.equal(h.call('metricsOffDayFn_', 'Alpha')('2026-09-21'), false);
});

// ── Queue data ────────────────────────────────────────────────────────────

function qcdGrid() {
  const r = (iso, q, total) => ['', '', iso, q, 'Total Calls', total, total - 1, 1, '', '', 0, 0];
  const values = [r('2026-09-18', 'A_Q_Alpha', 50), r('2026-09-21', 'A_Q_Alpha', 90), r('2026-09-21', 'A_Q_Beta', 30)];
  return { values: values, displays: values.map((v) => v.map(String)), dates: values.map((v) => v[2]), ssTZ: 'America/Chicago' };
}

test('readQcdGrid_ drops an all-department day, and only the named department\'s OWN queues for a scoped one', function () {
  h.ctx.readQcdGridRaw_ = function () { return qcdGrid(); };
  h.ctx.getDeptQcdQueues_ = function (d) { return d === 'Beta' ? ['A_Q_Beta'] : ['A_Q_Alpha']; };
  try {
    install([['2026-09-21', '', '8x8 outage', 'TRUE']]);
    let g = J(h.call('readQcdGrid_', '2026-09-01', '2026-09-30'));
    assert.deepEqual(g.values.map((v) => v[2] + ':' + v[3]), ['2026-09-18:A_Q_Alpha']);
    assert.equal(g.displays.length, 1, 'displays stay aligned');
    assert.deepEqual(g.dates, ['2026-09-18'], 'dates stay aligned');
    assert.equal(J(h.call('readQcdGrid_', '2026-09-01', '2026-09-30', { raw: true })).values.length, 3,
      'raw is for the readers that must see what happened');
    install([['2026-09-21', 'Beta', 'Beta phones down', 'TRUE']]);
    g = J(h.call('readQcdGrid_', '2026-09-01', '2026-09-30'));
    assert.deepEqual(g.values.map((v) => v[2] + ':' + v[3]), ['2026-09-18:A_Q_Alpha', '2026-09-21:A_Q_Alpha']);
    install([['2026-08-03', '', 'outside', 'TRUE']]);
    assert.equal(J(h.call('readQcdGrid_', '2026-09-01', '2026-09-30')).values.length, 3, 'a day outside the window costs nothing');
  } finally {
    delete h.ctx.readQcdGridRaw_;
    delete h.ctx.getDeptQcdQueues_;
  }
});

// ── The editor (INV-01 admin carve-out) ───────────────────────────────────

function sheetRows() {
  return h.state.spreadsheet.getSheetByName('Exception Days').getDataRange().getValues().slice(1);
}

test('the editor is admin-only', function () {
  install([]);
  h.state.userEmail = 'manager@x.com';
  ['getExceptionDaysInit', 'saveExceptionDay', 'removeExceptionDay'].forEach(function (fn) {
    assert.throws(function () { h.call(fn, { date: '2026-09-21', reason: 'x' }); }, /admin/i, fn);
  });
});

test('save validates (date, not future, a reason, real departments) and upserts ONE row per date', function () {
  install([]);
  const usage = [];
  h.ctx.logReportUsage_ = function (kind, detail) { usage.push(kind + '|' + detail); };
  h.ctx.getAllDepartments_ = function () { return ['Alpha', 'Beta']; };
  try {
    assert.throws(() => h.call('saveExceptionDay', { date: '9/21/2026', reason: 'x' }), /Choose a date/);
    assert.throws(() => h.call('saveExceptionDay', { date: '2099-01-01', reason: 'x' }), /already happened/);
    assert.throws(() => h.call('saveExceptionDay', { date: '2026-09-21', reason: '  ' }), /Say why/);
    assert.throws(() => h.call('saveExceptionDay', { date: '2026-09-21', reason: 'x'.repeat(201) }), /200 characters/);
    assert.throws(() => h.call('saveExceptionDay', { date: '2026-09-21', reason: 'x', departments: ['Gamma'] }), /not a department/);
    h.call('saveExceptionDay', { date: '2026-09-21', reason: '8x8 outage', departments: [] });
    h.call('saveExceptionDay', { date: '2026-09-21', reason: '=HYPERLINK("x")', departments: ['Beta', 'Beta'] });
    const r = sheetRows();
    assert.equal(r.length, 1, 'the second save UPDATES the date\'s row');
    assert.equal(r[0][1], 'Beta', 'deduped');
    assert.match(String(r[0][2]), /^'=HYPERLINK/, 'formula text is neutralized (sheetSafeCell_)');
    assert.equal(r[0][4], 'admin@x.com', 'stamped');
    assert.deepEqual(usage, ['exceptionDays:save|ALL', 'exceptionDays:save|Beta']);
  } finally { delete h.ctx.logReportUsage_; delete h.ctx.getAllDepartments_; }
});

test('a save busts the list, so the next report read sees it; remove puts the day back', function () {
  install([]);
  h.ctx.logReportUsage_ = function () {};
  h.ctx.getAllDepartments_ = function () { return ['Alpha', 'Beta']; };
  try {
    assert.equal(h.call('exceptionDaysTag_'), '');
    h.call('saveExceptionDay', { date: '2026-09-21', reason: '8x8 outage' });
    assert.notEqual(h.call('exceptionDaysTag_'), '', 'no 5-minute wait after a save');
    const out = J(h.call('removeExceptionDay', { date: '2026-09-21' }));
    assert.equal(out.removed, 1);
    assert.equal(sheetRows().length, 0);
    assert.equal(h.call('exceptionDaysTag_'), '');
  } finally { delete h.ctx.logReportUsage_; delete h.ctx.getAllDepartments_; }
});

// ── The client's working-day mirror ───────────────────────────────────────

test('the client\'s working-day test skips an ALL-department exception day, as the server does (unless included)', function () {
  const fs = require('fs');
  const path = require('path');
  const S1 = fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard', 'script-1-core.html'), 'utf8');
  const at = S1.search(/function isCompanyHolidayIso_\(/);
  const open = S1.indexOf('{', at);
  let depth = 0, end = -1;
  for (let i = open; i < S1.length; i++) {
    if (S1[i] === '{') depth++;
    else if (S1[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const src = S1.slice(at, end);
  // eslint-disable-next-line no-new-func
  const make = (win, included) => new Function('window', 'excIncludeOn_', 'return (' + src + ');')(win, () => included);
  const win = { __COMPANY_HOLIDAYS__: [{ from: '2026-12-25', to: '2026-12-25' }], __EXCEPTION_DAYS__: ['2026-09-21'] };
  assert.equal(make(win, false)('2026-09-21'), true);
  assert.equal(make(win, false)('2026-12-25'), true);
  assert.equal(make(win, false)('2026-09-22'), false);
  assert.equal(make(win, true)('2026-09-21'), false, 'an admin who includes them counts the day on both sides');
  assert.equal(make(win, false)('2026-09-21', true), false, 'holidaysOnly: the day bars draw the day themselves');
  assert.equal(make(win, false)('2026-12-25', true), true);
  assert.equal(make({ __COMPANY_HOLIDAYS__: [] }, false)('2026-09-21'), false, 'no injection: holidays only');
  // and the page injects exactly the all-department dates
  const code = fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard', 'Code.gs'), 'utf8');
  assert.match(code, /tmpl\.exceptionDaysJson = JSON\.stringify\(exceptionDates\)/);
  assert.match(code, /getExceptionDays_\(\)\.filter\(function \(d\) \{ return !d\.depts\.length; \}\)/);
});

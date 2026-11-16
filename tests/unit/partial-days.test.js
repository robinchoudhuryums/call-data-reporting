'use strict';

// Partial days (P7, owner 2026-11-16, Operator State #94). An agent's day that
// counts as less than a whole day in the PER-DAY figures. Rule A, confirmed by
// the owner: only the divisor changes -- answered per day and outbound per day
// divide by CREDITED days; calls, totals and rates never move; the attendance
// sits beside the figure; a per-day figure is a dash below one credited day.
// Pinned here: the sheet reader, the credit lookup and cache tag, the admin
// editor's INV-01 write, the summary's credited divisor (agent, team, the
// combined view), the outbound twin, and the client's attendance text.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadGas, DASHBOARD_DIR } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { dqeRow, dqeSheet, rosterGrid } = require('../harness/fixtures');

const J = (x) => JSON.parse(JSON.stringify(x));
const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'CompanyOverview.gs', 'QCDReport.gs',
          'DeptConfig.gs', 'Data.gs', 'NeonRead.gs', 'NeonCoverage.gs', 'OutboundReport.gs', 'AgentHome.gs', 'Setup.gs', 'PartialDays.gs'],
  capture: ['SHEETS', 'PARTIAL_DAYS_HEADERS', 'PARTIAL_DAY_CREDITS_', 'PARTIAL_DAY_REASONS_'],
});

const ROSTER = rosterGrid({ Alpha: ['Anna, 201', 'Ben, 202'], Beta: ['Cara, 301'] });
const REAL_RESOLVE = h.ctx.resolveUser_;
const HEAD = () => h.consts.PARTIAL_DAYS_HEADERS.slice();

function install(marks, opts) {
  opts = opts || {};
  h.state.props = Object.assign({ SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' }, opts.props || {});
  h.state.userEmail = opts.user || 'admin@x.com';
  const sheets = { 'DO NOT EDIT!': ROSTER, 'DQE Historical Data': dqeSheet(opts.dqe || []) };
  if (marks !== null) sheets[h.consts.SHEETS.PARTIAL_DAYS] = [HEAD()].concat(marks || []);
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: sheets, timeZone: opts.timeZone });
  h.state.cache.clear();
  h.ctx.resolveUser_ = REAL_RESOLVE;
}
// Five workdays for Anna (10 answered a day) and Ben (4 a day), Mon 03-09 .. Fri 03-13.
const WEEK = ['2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13'];
function week() {
  const rows = [];
  WEEK.forEach(function (d) {
    rows.push(dqeRow({ date: d, agent: 'Anna', ext: '501', rung: 12, missed: 2, answered: 10 }));
    rows.push(dqeRow({ date: d, agent: 'Ben', ext: '501', rung: 5, missed: 1, answered: 4 }));
  });
  return rows;
}
const summary = (dept, from, to) => h.call('computeSummary_', dept, from, to, 'roster');
const rowOf = (s, name) => s.rows.filter(function (r) { return r.agent === name; })[0];

// ── The sheet ────────────────────────────────────────────────────────────────

test('a row parses to { date, agent, credit, reason }; a whole day, a bad share or no agent is not a mark', function () {
  install(null);
  const row = (r) => J(h.call('partialDayFromRow_', r, 'America/Chicago'));
  assert.deepEqual(row(['2026-03-10', 'Anna', 0.5, 'Training']), { date: '2026-03-10', agent: 'Anna', credit: 0.5, reason: 'Training' });
  assert.equal(row(['2026-03-10', ' Anna ', '0.25', '']).agent, 'Anna');
  assert.equal(row(['2026-03-10', 'Anna', 0, 'Leave']).credit, 0, 'zero is a real mark: the day does not count');
  [1, 1.5, -0.5, '', 'half', null].forEach(function (c) { assert.equal(row(['2026-03-10', 'Anna', c, 'x']), null, 'credit ' + JSON.stringify(c)); });
  assert.equal(row(['2026-03-10', '', 0.5, 'x']), null);
  assert.equal(row(['3/10/2026', 'Anna', 0.5, 'x']), null, 'only an ISO date (setup pins the column to plain text)');
  // A Date-coerced cell is read in the SPREADSHEET time zone, like the other date lists.
  assert.equal(h.call('partialDayFromRow_', [new Date('2026-03-10T06:00:00Z'), 'Anna', 0.5, 'x'], 'America/Mexico_City').date, '2026-03-10');
});

test('the list reads oldest first and is cached; the credit lookup is exact on (date, name) and 1 when unmarked', function () {
  install([['2026-03-12', 'Ben', 0.25, 'Leave'], ['2026-03-10', 'Anna', 0.5, 'Training']]);
  h.inExecution(function () {
    assert.deepEqual(J(h.call('getPartialDays_')).map(function (d) { return d.date + '|' + d.agent + '|' + d.credit; }),
      ['2026-03-10|Anna|0.5', '2026-03-12|Ben|0.25']);
    assert.equal(h.call('partialDayCredit_', '2026-03-10', 'Anna'), 0.5);
    assert.equal(h.call('partialDayCredit_', '2026-03-10', 'Ben'), 1, 'another agent, same day');
    assert.equal(h.call('partialDayCredit_', '2026-03-11', 'Anna'), 1);
    assert.equal(h.call('partialDayCredit_', '2026-03-10', 'anna'), 1, 'INV-04: the name match is exact');
    assert.deepEqual(J(h.call('creditedDays_', 'Anna', WEEK)), { credited: 4.5, partial: 1, marks: [['2026-03-10', 0.5]] });
    assert.deepEqual(J(h.call('partialMarkedDatesIn_', '2026-03-11', '2026-03-31')), ['2026-03-12']);
  });
  assert.ok(h.state.cache.has('partialDays:v1'), 'cached for the next request');
  install(null);
  assert.deepEqual(J(h.call('getPartialDays_')), [], 'a missing sheet is no marks, not an error');
});

test('the cache tag is EMPTY with no marks (every key unchanged), moves with the list, and ignores the reason', function () {
  install([]);
  assert.equal(h.call('partialDaysTag_'), '');
  const base = h.call('reportFreshnessTag_');
  install([['2026-03-10', 'Anna', 0.5, 'Training']]);
  const t1 = h.call('partialDaysTag_');
  assert.match(t1, /^:p[0-9a-f]{10}$/);
  assert.equal(h.call('reportFreshnessTag_'), base + t1, 'every 6 h report key re-keys on an edit');
  install([['2026-03-10', 'Anna', 0.5, 'Meeting']]);
  assert.equal(h.call('partialDaysTag_'), t1, 'no figure reads the reason, so it does not re-key');
  install([['2026-03-10', 'Anna', 0.25, 'Training']]);
  assert.notEqual(h.call('partialDaysTag_'), t1, 'a different share is a different answer');
});

test('perCreditedDay_: the quotient over credited days, and a dash below one', function () {
  install(null);
  assert.equal(h.call('perCreditedDay_', 45, 4.5), 10);
  assert.equal(h.call('perCreditedDay_', 20, 1), 20);
  assert.equal(h.call('perCreditedDay_', 20, 0.5), null, '20 calls over half a day is not "40 a day"');
  assert.equal(h.call('perCreditedDay_', 20, 0), null);
});

// ── Rule A in the summary ────────────────────────────────────────────────────

test('RULE A: a partial day changes the per-day DIVISOR only -- calls, totals and rates are byte-identical', function () {
  install([], { dqe: week() });
  const before = summary('Alpha', WEEK[0], WEEK[4]);
  install([[WEEK[1], 'Anna', 0.5, 'Training']], { dqe: week() });
  const after = summary('Alpha', WEEK[0], WEEK[4]);
  const a0 = rowOf(before, 'Anna'), a1 = rowOf(after, 'Anna');
  ['totalAnswered', 'totalMissed', 'totalRung', 'totalUnique', 'tttSeconds', 'attSeconds', 'daysActive'].forEach(function (k) {
    assert.equal(a1[k], a0[k], k + ' is untouched');
  });
  ['totalAnswered', 'totalMissed', 'totalRung', 'totalUnique', 'tttSeconds', 'attSeconds', 'ansPerDayAnswered'].forEach(function (k) {
    assert.equal(after.totals[k], before.totals[k], 'totals.' + k + ' is untouched');
  });
  assert.equal(a0.ansPerDay, 10);                      // 50 over 5 days
  assert.equal(a0.daysCredited, 5);
  assert.equal(a0.partialDays, 0);
  assert.equal(a0.partialMarks, undefined);
  assert.equal(a1.daysCredited, 4.5);
  assert.equal(a1.partialDays, 1);
  assert.deepEqual(J(a1.partialMarks), [[WEEK[1], 0.5]], 'the mark, never the reason');
  assert.equal(a1.ansPerDay, 11.1, '50 answered over 4.5 credited days');
  assert.ok(JSON.stringify(after).indexOf('Training') === -1, 'the reason is nowhere in the payload');
  // Ben, unmarked, is exactly as before.
  assert.deepEqual(J(rowOf(after, 'Ben')), J(rowOf(before, 'Ben')));
});

test('the TEAM per-day figure credits teammates\' partial days too', function () {
  install([], { dqe: week() });
  const before = summary('Alpha', WEEK[0], WEEK[4]);
  assert.equal(before.totals.ansPerDayAgentDays, 10);
  assert.equal(before.totals.ansPerDay, 7);            // 70 over 10 agent-days
  install([[WEEK[1], 'Anna', 0.5, 'Training'], [WEEK[2], 'Ben', 0, 'Leave']], { dqe: week() });
  const after = summary('Alpha', WEEK[0], WEEK[4]);
  assert.equal(after.totals.ansPerDayAgentDays, 8.5, '4.5 for Anna + 4 for Ben (a zero-credit day is not a day)');
  assert.equal(after.totals.ansPerDay, 8.2, '70 over 8.5');
  assert.equal(rowOf(after, 'Ben').ansPerDay, 5, '20 over 4 credited days -- the zero-credit day\'s calls stay in the count');
});

test('a per-day figure is a dash below one credited day; a mark on a day with no rings changes nothing', function () {
  const one = [dqeRow({ date: WEEK[0], agent: 'Anna', ext: '501', rung: 22, missed: 2, answered: 20 })];
  install([[WEEK[0], 'Anna', 0.5, 'Partial shift']], { dqe: one });
  const s = summary('Alpha', WEEK[0], WEEK[0]);
  assert.equal(rowOf(s, 'Anna').ansPerDay, null, 'never 40 a day');
  assert.equal(rowOf(s, 'Anna').daysCredited, 0.5);
  assert.equal(rowOf(s, 'Anna').totalAnswered, 20, 'the calls stay');
  install([['2026-03-16', 'Anna', 0.5, 'Leave']], { dqe: week() });   // the following Monday: no rows
  const w = summary('Alpha', WEEK[0], WEEK[4]);
  assert.equal(rowOf(w, 'Anna').daysCredited, 5);
  assert.equal(rowOf(w, 'Anna').partialDays, 0, 'only a marked day the agent was active on is counted');
});

test('the combined view counts a crossover repeat in credited days (rowCreditedDays_; an older cached row falls back)', function () {
  install(null);
  assert.equal(h.call('rowCreditedDays_', { daysActive: 5, daysCredited: 4.5 }), 4.5);
  assert.equal(h.call('rowCreditedDays_', { daysActive: 5 }), 5, 'a row cached before the field');
  assert.equal(h.call('rowCreditedDays_', { daysActive: 5, daysCredited: 0 }), 0);
  assert.equal(h.call('rowCreditedDays_', null), 0);
  const src = fs.readFileSync(path.join(DASHBOARD_DIR, 'Data.gs'), 'utf8');
  const combine = src.slice(src.indexOf('function combineSummaries_('), src.indexOf('function computeSummary_('));
  assert.ok(!/ansPerDayAgentDays -= Number\(r\.daysActive\)/.test(combine), 'no repeat is subtracted in raw days any more');
  assert.equal((combine.match(/grand\.ansPerDayAgentDays -= rowCreditedDays_\(r\);/g) || []).length, 2);
  assert.match(combine, /e\.sum - creditedDays_\(name, Object\.keys\(e\.union\)\)\.credited/, 'the union of a crossover agent\'s days is credited too');
});

// ── Outbound per day ────────────────────────────────────────────────────────

test('outbound per day: credited days from the marked dates the agent placed a call on; a dash below one', function () {
  install([[WEEK[1], 'Anna', 0.5, 'Training'], [WEEK[2], 'Anna', 0, 'Leave'], [WEEK[3], 'Ben', 0.25, 'Meeting']]);
  h.inExecution(function () {
    // Anna placed calls on 5 days, two of them marked.
    assert.deepEqual(J(h.call('obCreditedDays_', 'Anna', 5, [WEEK[1], WEEK[2]])), { credited: 3.5, partial: 2 });
    // A marked date that is not HER mark changes nothing.
    assert.deepEqual(J(h.call('obCreditedDays_', 'Anna', 5, [WEEK[3]])), { credited: 5, partial: 0 });
    assert.deepEqual(J(h.call('obCreditedDays_', 'Anna', 5, null)), { credited: 5, partial: 0 });
    const sql = h.call('outboundAgentsSel_', WEEK[0], WEEK[4], '');
    assert.match(sql, /json_agg\(DISTINCT call_date::text\) FILTER \(WHERE call_date IN \('2026-03-10'::date, '2026-03-11'::date, '2026-03-12'::date\)\), '\[\]'::json\) AS marked_days /);
    assert.ok(h.call('outboundAgentsSel_', '2026-04-01', '2026-04-30', '').indexOf('marked_days') === -1, 'no mark in the window: the query text is what it was');
  });
  const t = h.call('deptObTotals_', [
    { agent: 'Anna', scopeDept: 'Alpha', obTotal: 35, obDays: 5, obDaysCredited: 3.5 },
    { agent: 'Ben', scopeDept: 'Alpha', obTotal: 10, obDays: 5 },                      // a row shaped before the field
  ], {});
  assert.equal(t.obPerDayAgentDays, 8.5);
  assert.equal(t.obPerDay, 5.3, '45 over 8.5 credited agent-days');
});

test('the sheet twin names the marked dates an agent has a call on, like the SQL', function () {
  install([[WEEK[1], 'Anna', 0.5, 'Training']]);
  const grid = [[WEEK[0], '', '', 'Anna', '', '', 'TRUE', 30, 5, 1], [WEEK[1], '', '', 'Anna', '', '', 'TRUE', 30, 5, 1],
                [WEEK[0], '', '', 'Ben', '', '', 'TRUE', 30, 5, 1]];
  const rows = J(h.call('obAgentsFromGrid_', grid, WEEK[0], WEEK[4]));
  const anna = rows.filter(function (r) { return r.agent === 'Anna'; })[0], ben = rows.filter(function (r) { return r.agent === 'Ben'; })[0];
  assert.equal(anna.ob_days, 2);
  assert.deepEqual(anna.marked_days, [WEEK[1]]);
  assert.deepEqual(ben.marked_days, [], 'Ben placed no call on a marked date');
  install([]);
  assert.equal('marked_days' in J(h.call('obAgentsFromGrid_', grid, WEEK[0], WEEK[4]))[0], false, 'no marks: the rows are what they were');
});

// ── The editor (INV-01 admin carve-out) ─────────────────────────────────────

test('the editor is admin-only, validates every field against a fixed list, and writes one row per (date, agent)', function () {
  install([], { user: 'manager@x.com' });
  ['getPartialDaysInit', 'savePartialDay', 'removePartialDay'].forEach(function (fn) {
    assert.throws(function () { h.call(fn, { date: WEEK[0], agent: 'Anna', credit: 0.5, reason: 'Training' }); }, /admin/i, fn);
  });
  install([]);
  const init = J(h.call('getPartialDaysInit'));
  assert.deepEqual(init.credits, [0, 0.25, 0.5, 0.75]);
  assert.deepEqual(init.reasons, ['Partial shift', 'Training', 'Meeting', 'Leave', 'Other']);
  assert.deepEqual(init.rosters, { Alpha: ['Anna', 'Ben'], Beta: ['Cara'] });
  const bad = function (req, re) { assert.throws(function () { h.call('savePartialDay', req); }, re, JSON.stringify(req)); };
  bad({ date: '', agent: 'Anna', credit: 0.5, reason: 'Training' }, /date/i);
  bad({ date: '2999-01-01', agent: 'Anna', credit: 0.5, reason: 'Training' }, /already happened/);
  bad({ date: WEEK[0], agent: 'Nobody', credit: 0.5, reason: 'Training' }, /not on any department roster/);
  bad({ date: WEEK[0], agent: 'anna', credit: 0.5, reason: 'Training' }, /roster/, 'exact name');
  bad({ date: WEEK[0], agent: 'Anna', credit: 0.4, reason: 'Training' }, /how much of the day/);
  bad({ date: WEEK[0], agent: 'Anna', credit: 1, reason: 'Training' }, /how much of the day/);
  bad({ date: WEEK[0], agent: 'Anna', credit: '', reason: 'Training' }, /how much of the day/);
  bad({ date: WEEK[0], agent: 'Anna', credit: 0.5, reason: 'Sick -- flu' }, /Choose a reason/);   // no free text
  let out = J(h.call('savePartialDay', { date: WEEK[0], agent: 'Anna', credit: 0.5, reason: 'Training' }));
  assert.equal(out.days.length, 1);
  assert.equal(out.days[0].addedBy, 'admin@x.com');
  out = J(h.call('savePartialDay', { date: WEEK[0], agent: 'Anna', credit: 0, reason: 'Leave' }));
  assert.equal(out.days.length, 1, 'the same (date, agent) is updated, not duplicated');
  assert.equal(out.days[0].credit, 0);
  out = J(h.call('savePartialDay', { date: WEEK[0], agent: 'Ben', credit: 0.75, reason: 'Meeting' }));
  assert.equal(out.days.length, 2, 'another agent on the same day is its own row');
  assert.equal(h.call('partialDayCredit_', WEEK[0], 'Anna'), 0, 'the save busts the list cache');
  out = J(h.call('removePartialDay', { date: WEEK[0], agent: 'Anna' }));
  assert.equal(out.removed, 1);
  assert.deepEqual(out.days.map(function (d) { return d.agent; }), ['Ben']);
  assert.equal(h.call('partialDayCredit_', WEEK[0], 'Anna'), 1);
});

test('setup() creates the Partial Days sheet with its header and a text-pinned Date column', function () {
  h.state.props = { SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' };
  h.state.userEmail = 'admin@x.com';
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: { 'DO NOT EDIT!': ROSTER } });
  h.state.cache.clear();
  h.ctx.resolveUser_ = REAL_RESOLVE;
  h.call('setup');
  const sheet = h.state.spreadsheet.getSheetByName('Partial Days');
  assert.ok(sheet, 'created');
  assert.equal(sheet.getRange(1, 1, 1, 6).getValues()[0].join('|'), HEAD().join('|'));
});

// ── The agent's own attendance ──────────────────────────────────────────────

test('the agent app carries the agent\'s OWN credited days and partial count -- no reason, no teammate\'s marks', function () {
  const src = fs.readFileSync(path.join(DASHBOARD_DIR, 'AgentHome.gs'), 'utf8');
  assert.match(src, /daysCredited: \(r\.daysCredited != null\) \? r\.daysCredited : r\.daysActive,\s*partialDays: Number\(r\.partialDays\) \|\| 0,/);
  assert.match(src, /daysCredited: own \? own\.daysCredited : 0,[^\n]*\n\s*partialDays: own \? own\.partialDays : 0,/);
  assert.ok(!/partialMarks/.test(src), 'the dated marks are not shipped to the agent app');
  const app = fs.readFileSync(path.join(DASHBOARD_DIR, 'agentApp.html'), 'utf8');
  const at = app.indexOf('function agentAttendanceHtml_(');
  const ctx = vm.createContext({});
  vm.runInContext(app.slice(at, app.indexOf('\n  }', at) + 4), ctx);
  assert.equal(ctx.agentAttendanceHtml_({ daysActive: 20, daysCredited: 20, partialDays: 0 }), '', 'nothing unless a day is marked');
  const html = ctx.agentAttendanceHtml_({ daysActive: 20, daysCredited: 18.75, partialDays: 3 });
  assert.match(html, /Days with calls: <b>20<\/b> &middot; counted as <b>18\.75<\/b> \(3 marked as a partial day\)/);
  assert.match(html, /Your calls and answer rate are not changed/);
});

// ── The client's attendance text ────────────────────────────────────────────

test('the attendance text: "17.5 of 22 workdays, 9 partial"; the tooltip lists days and shares only', function () {
  const core = fs.readFileSync(path.join(DASHBOARD_DIR, 'script-1-core.html'), 'utf8');
  const grab = function (name) {
    const at = core.indexOf('function ' + name + '(');
    let depth = 0;
    for (let i = core.indexOf('{', at); i < core.length; i++) {
      if (core[i] === '{') depth++;
      else if (core[i] === '}') { depth--; if (depth === 0) return core.slice(at, i + 1); }
    }
  };
  const ctx = vm.createContext({ excDateLabel_: function (iso) { return 'D' + iso.slice(8); },
    escapeHtml: function (x) { return String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); },
    workingDaysBetween_: function () { return 22; }, state: { meta: { from: '2026-03-01', to: '2026-03-31' } } });
  vm.runInContext(['attNum_', 'attendanceText_', 'attWindowWorkdays_', 'attMarksTitle_', 'attendanceHtml_', 'ansPerDayHtml_'].map(grab).join('\n'), ctx);
  assert.equal(ctx.attendanceText_(17.5, 9, 22), '17.5 of 22 workdays, 9 partial');
  assert.equal(ctx.attendanceText_(1, 1, 1), '1 of 1 workday, 1 partial');
  assert.equal(ctx.attendanceText_(4.25, 0, 0), '4.25 days');
  assert.equal(ctx.attMarksTitle_([['2026-03-10', 0.5], ['2026-03-11', 0]]), 'Partial days: D10 (0.5 day), D11 (not counted)');
  assert.equal(ctx.attendanceHtml_(5, 0, null), '', 'no mark applied: nothing is added to the page');
  assert.match(ctx.attendanceHtml_(17.5, 9, [['2026-03-10', 0.5]]), /^<span class="att-line" title="Partial days: D10 \(0\.5 day\)">17\.5 of 22 workdays, 9 partial<\/span>$/);
  // An unmarked agent's cell is what it always was.
  assert.equal(ctx.ansPerDayHtml_({ ansPerDay: 10, daysActive: 5, daysCredited: 5, partialDays: 0, totalAnswered: 50 }),
    '<span class="ans-perday" title="50 answered over 5 days with rings">&middot; 10.0 ans/day</span>');
  // A marked one gains the attendance; under one credited day it is a dash that says why.
  const marked = ctx.ansPerDayHtml_({ ansPerDay: 11.1, daysActive: 5, daysCredited: 4.5, partialDays: 1, totalAnswered: 50, partialMarks: [['2026-03-10', 0.5]] });
  assert.match(marked, /50 answered over 4\.5 credited days \(5 with rings, 1 partial\)/);
  assert.match(marked, /&middot; 11\.1 ans\/day<\/span> <span class="ans-att"[^>]*>4\.5 of 22 workdays, 1 partial<\/span>$/);
  const dash = ctx.ansPerDayHtml_({ ansPerDay: null, daysActive: 1, daysCredited: 0.5, partialDays: 1, totalAnswered: 20 });
  assert.match(dash, /under one credited day, so no per-day figure/);
  assert.match(dash, /&middot; – ans\/day<\/span>/);
  assert.equal(ctx.ansPerDayHtml_({ ansPerDay: null, daysActive: 0, partialDays: 0 }), '', 'no figure and no mark: nothing, as before');
});

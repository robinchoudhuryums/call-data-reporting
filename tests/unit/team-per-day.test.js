'use strict';

// P8 (follow-up plan 2026-11-13; Operator State #94): the Individual Report
// and Insights compare an agent's VOLUME with the team PER CREDITED DAY.
//
// Before: a window total against the team's per-agent window total -- so an
// agent who was out for a week, or on a marked part day, read as "40% below
// the team" for being absent. Now: calls per day worked against the team's
// calls per credited agent-day. What must hold:
//   - no count, total, rate or share moves; the old per-agent window figures
//     stay in the payload;
//   - a day with no calls is not a day; a marked day counts as its credit;
//   - the team's agent-days leave out the dept's team-average excludes;
//   - under one credited day there is no pace -- null, never a huge number;
//   - a payload without the days (cached before P8) keeps the old comparison.

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
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'CompanyOverview.gs', 'QCDReport.gs', 'DeptConfig.gs',
          'Data.gs', 'NeonRead.gs', 'IndividualReport.gs', 'InsightsReport.gs', 'Digest.gs', 'EmailKit.gs'],
  capture: ['SHEETS', 'PARTIAL_DAYS_HEADERS', 'DEPT_CONFIG_HEADERS'],
});

const ROSTER = rosterGrid({ Alpha: ['Anna, 201', 'Ben, 202', 'Mel, 203'], Beta: ['Cara, 301'] });
// Ten workdays, Mon 03-02 .. Fri 03-13.
const DAYS = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06',
              '2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13'];
const FROM = DAYS[0], TO = DAYS[9];

function install(rows, opts) {
  opts = opts || {};
  h.state.userEmail = 'admin@x.com';
  h.state.props = { SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' };
  const sheets = { 'DO NOT EDIT!': ROSTER, 'DQE Historical Data': dqeSheet(rows) };
  sheets[h.consts.SHEETS.PARTIAL_DAYS] = [h.consts.PARTIAL_DAYS_HEADERS.slice()].concat(opts.marks || []);
  if (opts.excludes) {
    sheets['Dept Config'] = [h.consts.DEPT_CONFIG_HEADERS.slice(),
      ['Alpha', '', '', opts.excludes, '', true, '', '', '', '', '']];
  }
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: sheets });
  h.state.cache.clear();
}
const row = (d, agent, rung, missed) => dqeRow({ date: d, agent: agent, ext: '501', rung: rung, missed: missed, answered: rung - missed });
// Anna works all ten days at 20 rung / 2 missed. Ben works the same PACE but
// only the last five days. Mel (a manager) takes 2 calls a day.
function fixture() {
  const rows = [];
  DAYS.forEach(function (d, i) {
    rows.push(row(d, 'Anna', 20, 2));
    if (i >= 5) rows.push(row(d, 'Ben', 20, 2));
    rows.push(row(d, 'Mel', 2, 0));
  });
  return rows;
}
const ir = (agents) => J(h.call('getIndividualReport', { department: 'Alpha', from: FROM, to: TO, agents: agents }));
const ins = (agents) => J(h.call('getInsightsReport', { department: 'Alpha', from: FROM, to: TO, agents: agents || [] }));
const card = (d, name) => (d.summaryData || d.agentData).filter(function (c) { return c.name === name; })[0];
const mark = (d, agent, credit) => [d, agent, credit, 'Training', 'admin@x.com', 't'];

// ── Individual Report ───────────────────────────────────────────────────────

test('IR: each card carries its days and its figures per credited day; the team carries calls per credited agent-day', function () {
  install(fixture());
  const d = ir(['Anna', 'Ben']);
  assert.deepEqual(card(d, 'Anna').days, { active: 10, credited: 10, partial: 0 });
  assert.deepEqual(card(d, 'Ben').days, { active: 5, credited: 5, partial: 0 }, 'a day with no calls is not a day');
  assert.deepEqual(card(d, 'Anna').perDay, { rung: 20, missed: 2, answered: 18 });
  assert.deepEqual(card(d, 'Ben').perDay, { rung: 20, missed: 2, answered: 18 }, 'half the days at the same pace is the same pace');
  // Team: Anna 10 + Ben 5 + Mel 10 = 25 agent-days; 200 + 100 + 20 = 320 rung.
  assert.deepEqual(d.teamAvg.perDay, { rung: 12.8, missed: 1.2, answered: 11.6, agentDays: 25 });
});

test('IR: nothing that was there before moves -- counts, rate, share and the per-agent window average', function () {
  install(fixture());
  const plain = ir(['Anna', 'Ben']);
  install(fixture(), { marks: [mark(DAYS[9], 'Ben', 0.5)] });
  const marked = ir(['Anna', 'Ben']);
  ['stats', 'share', 'priorStats'].forEach(function (k) {
    assert.deepEqual(card(marked, 'Ben')[k], card(plain, 'Ben')[k], k);
  });
  ['rung', 'missed', 'answered', 'pct', 'ttt', 'att', 'raw'].forEach(function (k) {
    assert.deepEqual(marked.teamAvg[k], plain.teamAvg[k], 'teamAvg.' + k);
  });
  assert.deepEqual(marked.deptStats, plain.deptStats);
  assert.equal(plain.teamAvg.rung, 107, 'the per-agent window average (320 / 3) is still in the payload');
});

test('IR: a marked day counts as its credit for the agent AND in the team agent-days; the reason never reaches the payload', function () {
  install(fixture(), { marks: [mark(DAYS[9], 'Ben', 0.5), mark(DAYS[8], 'Ben', 0)] });
  const d = ir(['Ben']);
  assert.deepEqual(card(d, 'Ben').days, { active: 5, credited: 3.5, partial: 2, marks: [[DAYS[8], 0], [DAYS[9], 0.5]] });
  assert.equal(card(d, 'Ben').perDay.rung, 28.57, '100 rung over 3.5 credited days');
  assert.equal(d.teamAvg.perDay.agentDays, 23.5, '10 + 3.5 + 10');
  assert.ok(!/Training/.test(JSON.stringify(d)));
});

test('IR: the team agent-days leave out the dept\'s team-average excludes (INV-26), like the sums they divide', function () {
  install(fixture(), { excludes: 'Mel' });
  const d = ir(['Anna', 'Mel']);
  assert.deepEqual(d.teamAvg.perDay, { rung: 20, missed: 2, answered: 18, agentDays: 15 }, 'Anna 10 + Ben 5; 300 rung');
  assert.deepEqual(card(d, 'Mel').perDay, { rung: 2, missed: 0, answered: 2 }, 'an excluded manager still has their own pace');
});

test('IR: under one credited day there is no per-day figure -- null, never 40 a day', function () {
  install([row(DAYS[0], 'Anna', 20, 2), row(DAYS[0], 'Ben', 20, 2)], { marks: [mark(DAYS[0], 'Ben', 0.5)] });
  const d = ir(['Ben']);
  assert.deepEqual(card(d, 'Ben').perDay, { rung: null, missed: null, answered: null });
  assert.equal(card(d, 'Ben').stats.rung, 20, 'the calls are still counted');
  assert.equal(d.teamAvg.perDay.agentDays, 1.5);
});

test('IR: the volume sentences compare per day worked -- an absence is not "lower volume", a real gap still is', function () {
  // Ben worked half the days at the same pace as Anna: by window total he is
  // far under the per-agent average, per day he is not.
  install(fixture(), { excludes: 'Mel' });
  let d = ir(['Anna', 'Ben']);
  const txt = function (name) { return card(d, name).insights.map(function (i) { return i.text; }).join(' | '); };
  assert.ok(!/Call volume/.test(txt('Ben')), 'no "lower than team" for the days he was out: ' + txt('Ben'));
  assert.ok(!/Call volume/.test(txt('Anna')));
  // A real pace gap: Ben rings 8 a day against Anna's 20.
  const rows = [];
  DAYS.forEach(function (day, i) { rows.push(row(day, 'Anna', 20, 2)); if (i >= 5) rows.push(row(day, 'Ben', 8, 4)); });
  install(rows);
  d = ir(['Anna', 'Ben']);
  assert.match(txt('Ben'), /Call volume per day worked is \d+% lower than team avg \(8\.0 vs 16\.0 rung a day\)/);
  assert.match(txt('Ben'), /Missed calls per day worked are \d+% above team avg \(4\.0 vs 2\.7 missed a day\)/);
});

test('IR: the empty shape carries the same fields', function () {
  install([]);
  const d = ir(['Anna']);
  assert.deepEqual(d.teamAvg.perDay, { rung: null, missed: null, answered: null, agentDays: 0 });
  assert.deepEqual(card(d, 'Anna').days, { active: 0, credited: 0, partial: 0 });
  assert.deepEqual(card(d, 'Anna').perDay, { rung: null, missed: null, answered: null });
});

// ── Insights ────────────────────────────────────────────────────────────────

test('Insights: every card carries its days, and the baseline its credited agent-days over the non-excluded active roster', function () {
  install(fixture(), { excludes: 'Mel', marks: [mark(DAYS[9], 'Ben', 0.5)] });
  const d = ins();
  assert.deepEqual(card(d, 'Anna').days, { active: 10, credited: 10, partial: 0 });
  assert.deepEqual(card(d, 'Ben').days, { active: 5, credited: 4.5, partial: 1, marks: [[DAYS[9], 0.5]] });
  assert.deepEqual(card(d, 'Mel').days, { active: 10, credited: 10, partial: 0 });
  const b = d.meta.teamAvgBasis;
  assert.equal(b.agentDays, 14.5, 'Anna 10 + Ben 4.5 -- Mel is outside the benchmark');
  assert.equal(b.rung, 300, 'the sums it divides are unchanged');
  assert.equal(b.agents, 2);
  assert.ok(!/Training/.test(JSON.stringify(d)), 'the reason never reaches the payload');
});

test('Insights: the marks move nothing else in the payload', function () {
  install(fixture());
  const plain = ins();
  install(fixture(), { marks: [mark(DAYS[9], 'Ben', 0.5)] });
  const marked = ins();
  assert.deepEqual(marked.teamStats, plain.teamStats);
  assert.deepEqual(card(marked, 'Ben').metrics, card(plain, 'Ben').metrics);
  assert.equal(marked.meta.answeredDeptTotal, plain.meta.answeredDeptTotal);
  const strip = function (b) { const o = Object.assign({}, b); delete o.agentDays; return o; };
  assert.deepEqual(strip(marked.meta.teamAvgBasis), strip(plain.meta.teamAvgBasis));
});

test('Insights: the empty shape carries days and agentDays', function () {
  install([]);
  const d = ins(['Anna']);
  assert.equal(d.meta.teamAvgBasis.agentDays, 0);
  assert.deepEqual(card(d, 'Anna').days, { active: 0, credited: 0, partial: 0 });
});

// ── The client's pure helpers ───────────────────────────────────────────────

function grabFrom(file) {
  const src = fs.readFileSync(path.join(DASHBOARD_DIR, file), 'utf8');
  return function (name) {
    const at = src.indexOf('function ' + name + '(');
    assert.ok(at >= 0, name + ' in ' + file);
    let depth = 0;
    for (let i = src.indexOf('{', at); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
    }
  };
}
function clientCtx() {
  const ctx = vm.createContext({
    excDateLabel_: function (iso) { return 'D' + iso.slice(8); },
    escapeHtml: function (x) { return String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); },
    workingDaysBetween_: function () { return 22; }, state: { meta: {} },
  });
  const core = grabFrom('script-1-core.html'), insF = grabFrom('script-8-insights.html'), irF = grabFrom('script-6-ir.html');
  vm.runInContext(['attNum_', 'attendanceText_', 'attWindowWorkdays_', 'attMarksTitle_', 'attendanceHtml_',
    'perDayOf_', 'attDaysText_', 'attDaysHtml_', 'perDayText_'].map(core).join('\n')
    + '\n' + ['insTeamPerDay_', 'insVsTeamBadge_'].map(insF).join('\n')
    + '\n' + ['irDiffBadge', 'irPerDayBadge_'].map(irF).join('\n'), ctx);
  return ctx;
}

test('client: a count per credited day -- a number, null under one day, undefined with no days block (the old comparison stays)', function () {
  const c = clientCtx();
  assert.equal(c.perDayOf_(520, { credited: 21 }), 520 / 21);
  assert.equal(c.perDayOf_(20, { credited: 0.5 }), null, 'under one credited day: no pace');
  assert.equal(c.perDayOf_(0, { credited: 0 }), null);
  assert.equal(c.perDayOf_(520, undefined), undefined, 'a payload from before P8');
  assert.equal(c.perDayOf_(520, {}), undefined);
  assert.equal(c.perDayText_(24.76), '24.8');
  assert.equal(c.perDayText_(null), '–');
});

test('client: the days line -- "21 days with calls", or the attendance when a day is marked, dates on hover', function () {
  const c = clientCtx();
  assert.equal(c.attDaysText_({ active: 21, credited: 21, partial: 0 }, 22), '21 days with calls');
  assert.equal(c.attDaysText_({ active: 1, credited: 1, partial: 0 }, 22), '1 day with calls');
  assert.equal(c.attDaysText_({ active: 21, credited: 19.75, partial: 2 }, 22), '19.75 of 22 workdays, 2 partial');
  assert.equal(c.attDaysText_(undefined, 22), '');
  assert.equal(c.attDaysHtml_({ active: 21, credited: 21, partial: 0 }, 22, 'ir-days'), '<span class="ir-days">21 days with calls</span>');
  assert.equal(c.attDaysHtml_({ active: 5, credited: 4.5, partial: 1, marks: [['2026-03-13', 0.5]] }, 22),
    '<span class="att-line" title="Partial days: D13 (0.5 day)">4.5 of 22 workdays, 1 partial</span>');
});

test('client: the Insights team pace comes from the R18 baseline and its agent-days; absent agent-days = no per-day basis', function () {
  const c = clientCtx();
  assert.deepEqual(J(c.insTeamPerDay_({ teamAvgBasis: { agentDays: 82.75, rung: 1843, missed: 182, answered: 1661 } })),
    { agentDays: 82.75, rung: 1843 / 82.75, missed: 182 / 82.75, answered: 1661 / 82.75 });
  assert.equal(c.insTeamPerDay_({ teamAvgBasis: { rung: 1843, answered: 1661 } }), null, 'a payload from before P8');
  assert.equal(c.insTeamPerDay_({ teamAvgBasis: { agentDays: 0.5, rung: 10 } }), null, 'under one agent-day');
  assert.equal(c.insTeamPerDay_({}), null);
});

test('client: the vs-team chip per day -- on par within 10%, and it says "ans/day"; the window form is unchanged', function () {
  const c = clientCtx();
  assert.match(c.insVsTeamBadge_(21.2, 20.1, true), /cr-vs-team-flat[^>]*>≈ on par · 21\.2 vs 20\.1 ans\/day</);
  assert.match(c.insVsTeamBadge_(24.8, 20.1, true), /cr-vs-team-pos[^>]*>▲ above team · 24\.8 vs 20\.1 ans\/day</);
  assert.match(c.insVsTeamBadge_(16.2, 20.1, true), /cr-vs-team-neg[^>]*>▼ below team · 16\.2 vs 20\.1 ans\/day</);
  assert.match(c.insVsTeamBadge_(24.8, 20.1, true), /per day worked vs the team average/);
  // 0.4 vs 0.5 a day: the old absolute floor of 1 would have called this "on par".
  assert.match(c.insVsTeamBadge_(0.4, 0.5, true), /cr-vs-team-neg/);
  assert.match(c.insVsTeamBadge_(142, 98), /▲ above team · 142 vs 98 ans</, 'the window form (an old payload)');
});

test('client: the IR per-day badge -- a percent against the team pace, and a plain "-" under one credited day', function () {
  const c = clientCtx();
  assert.match(c.irPerDayBadge_(24.76, 20.07, 'pos', 'answered calls per day worked'), /ir-badge-pos[^>]*>\+23\.4%</);
  assert.match(c.irPerDayBadge_(0.57, 2.2, 'neg', 'missed calls per day worked'), /ir-badge-pos[^>]*>-74\.1%</);
  const none = c.irPerDayBadge_(null, 20.07, 'pos', 'answered calls per day worked');
  assert.match(none, /ir-badge-neu/);
  assert.match(none, /Under one credited day/);
  assert.ok(!/-100/.test(none), 'never "-100%" for an agent with no pace');
});

// ── Where the comparisons are wired ─────────────────────────────────────────

test('the surfaces are wired to the per-day basis, each with the old comparison as its fallback', function () {
  const insSrc = fs.readFileSync(path.join(DASHBOARD_DIR, 'script-8-insights.html'), 'utf8');
  const irSrc = fs.readFileSync(path.join(DASHBOARD_DIR, 'script-6-ir.html'), 'utf8');
  // The share benchmark: each agent's share of the days worked, flat only
  // without the days.
  assert.match(insSrc, /byDays \? \(100 - excludedShare\) \* \(Number\(s\.days\) \|\| 0\) \/ benchDays : eqShare/);
  assert.match(insSrc, /benchSlices\.every\(function \(s\) \{ return s\.days != null; \}\)/);
  // The gap chart: per day only when EVERY card carries days.
  assert.match(insSrc, /const perDayOn = !!tPer && cards\.every\(function \(c\) \{ return c\.days && c\.days\.credited != null; \}\)/);
  assert.match(insSrc, /return perDayOn \? perDayOf_\(v, c\.days\) : v;/);
  // The card bars: the number beside the bar stays the window total.
  assert.match(insSrc, /const pd = \(!isPct && tPer\) \? perDayOf_\(val, c\.days\) : undefined;/);
  // The IR tiles: three volume tiles through one helper; rates untouched.
  assert.equal((irSrc.match(/volTile\('/g) || []).length, 3);
  assert.match(irSrc, /irKpiTile\('% Answered',  agent\.stats\.pct,      teamAvg\.pct,/);
  assert.match(irSrc, /if \(!perDayOn\) \{\s*return irKpiTile\(label, agent\.stats\[key\], teamAvg\[key\],/);
});

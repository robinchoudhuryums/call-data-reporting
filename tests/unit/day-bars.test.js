'use strict';

// Step 4 (owner 2026-10-16): linked day bars in the My Department team cards.
// The bars must SUM to the tile they sit in, so their data rides the SAME
// payload as the tiles (owner ruling: extend the dept payload, no new call):
//   - totals.daily: the roster agents' answered / missed per date
//     (computeSummary_, opt-in via opts.daily -- only My Department asks), and
//     the combined view's grand daily, corrected by every crossover repeat the
//     grand totals are corrected by;
//   - qcd.range.daily: the dept's OWN queues per date, avg answer
//     answered-weighted like the range block's own.
// The client bucketing (workdays only, weekly past 31) is pinned below as
// pure functions lifted from script-5-dept.html.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { dqeRow, dqeSheet, rosterGrid } = require('../harness/fixtures');

const J = (x) => JSON.parse(JSON.stringify(x));

const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'CompanyOverview.gs',
          'QCDReport.gs', 'DeptConfig.gs', 'Data.gs', 'NeonRead.gs'],
});

const ROSTER = rosterGrid({
  Alpha: ['Anna, 201', 'Ben, 202'],
  Beta:  ['Cara, 301'],
});

function install(rows, extraSheets) {
  h.state.props.SPREADSHEET_ID = 'fake';
  h.state.spreadsheet = makeFakeSpreadsheet({
    sheets: Object.assign({ 'DO NOT EDIT!': ROSTER, 'DQE Historical Data': dqeSheet(rows) }, extraSheets || {}),
  });
  h.ctx.DEPT_CONFIG_ROWS_MEMO_ = null;
  h.ctx.DQE_DATE_BOUNDS_MEMO_ = null;
  h.ctx.DQE_SHEET_ROWS_MEMO_ = null;
  h.ctx.DQE_DATE_COL_MEMO_ = null;
  h.ctx.DQE_EXT_GRID_MEMO_ = null;
  h.ctx.QCD_SHEET_DATA_MEMO_ = null;
  h.ctx.QCD_NEON_GRID_MEMO_ = null;
  h.ctx.QCD_SNAPSHOT_READ_FAILED_ = false;
  h.state.cache.clear();
}

const ROWS = [
  dqeRow({ date: '2026-03-09', agent: 'Anna', ext: '501', rung: 10, missed: 1, answered: 9 }),
  dqeRow({ date: '2026-03-10', agent: 'Anna', ext: '501', rung: 6,  missed: 2, answered: 4 }),
  dqeRow({ date: '2026-03-09', agent: 'Ben',  ext: '501', rung: 5,  missed: 0, answered: 5 }),
  // Cara is Beta's, a queue-only FLOATER into Alpha -- out of every total (INV-53).
  dqeRow({ date: '2026-03-09', agent: 'Cara', ext: '501', rung: 40, missed: 20, answered: 20 }),
  // A prior-window day never reaches the window's bars.
  dqeRow({ date: '2026-03-06', agent: 'Anna', ext: '501', rung: 8,  missed: 8, answered: 0 }),
];

test('totals.daily: roster agents per date, summing to the tiles\' totals', function () {
  install(ROWS);
  const data = h.call('computeSummary_', 'Alpha', '2026-03-09', '2026-03-10', 'both', { daily: true });
  assert.deepEqual(J(data.totals.daily), [
    ['2026-03-09', 14, 1],
    ['2026-03-10', 4, 2],
  ], 'Anna + Ben only: the floater and the prior window stay out; compact [iso, answered, missed]');
  const sum = data.totals.daily.reduce(function (s, d) { return { a: s.a + d[1], m: s.m + d[2] }; }, { a: 0, m: 0 });
  assert.equal(sum.a, data.totals.totalAnswered);
  assert.equal(sum.m, data.totals.totalMissed);
  assert.ok(!('_dailyByAgent' in J(data.totals)), 'the per-agent map is never serialized (or cached)');
  assert.ok(data.totals._dailyByAgent && data.totals._dailyByAgent.Anna, 'but rides along for the combine');
});

test('totals.daily is opt-in: Digest / Coaching / the agent app see no change', function () {
  install(ROWS);
  const data = h.call('computeSummary_', 'Alpha', '2026-03-09', '2026-03-10', 'both');
  assert.equal(data.totals.daily, undefined);
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard', 'Data.gs'), 'utf8');
  assert.match(src, /return computeSummary_\(d, from, to, scope, \{ sections: d === dept, daily: true, dropIdle: true \}\);/,
    'only the My Department request asks for it');
});

// -- the combined view ---------------------------------------------------------
const hData = loadGas({ files: ['Config.gs', 'Util.gs', 'CompanyOverview.gs', 'DeptConfig.gs', 'Data.gs'] });

function part(dept, rows, totals, daily, byAgent) {
  totals.daily = daily;
  Object.defineProperty(totals, '_dailyByAgent', { value: byAgent, enumerable: false });
  return { meta: { department: dept }, rows: rows, totals: totals, qcd: null, csrTransfer: null,
           diagnostics: { rosterWithNoData: [], queueOnlyMatched: [] } };
}
function rosterRow(agent, o) {
  return { agent: agent, matchedViaRoster: true, totalUnique: o.u || 0, totalRung: o.r || 0,
           totalMissed: o.m || 0, totalAnswered: o.a || 0, tttSeconds: 0 };
}

test('combined: the grand daily drops a crossover agent\'s repeat days, so the bars still sum to the tile', function () {
  const anna = { r: 6, m: 1, a: 5 };
  const annaDays = { '2026-03-09': { answered: 3, missed: 1 }, '2026-03-10': { answered: 2, missed: 0 } };
  const a = part('CSR', [rosterRow('Anna', anna), rosterRow('Bob', { r: 3, a: 3 })],
    { totalRung: 9, totalMissed: 1, totalAnswered: 8, rosterAgentCount: 2 },
    [['2026-03-09', 6, 1], ['2026-03-10', 2, 0]],
    { Anna: annaDays, Bob: { '2026-03-09': { answered: 3, missed: 0 } } });
  const b = part('Spanish', [rosterRow('Anna', anna)],
    { totalRung: 6, totalMissed: 1, totalAnswered: 5, rosterAgentCount: 1 },
    [['2026-03-09', 3, 1], ['2026-03-10', 2, 0]],
    { Anna: annaDays });
  const r = hData.call('combineSummaries_', a, [a, b]);
  assert.equal(r.totals.crossoverAgentCount, 1);
  assert.deepEqual(J(r.totals.daily), [['2026-03-09', 6, 1], ['2026-03-10', 2, 0]]);
  const sum = r.totals.daily.reduce(function (s, d) { return { a: s.a + d[1], m: s.m + d[2] }; }, { a: 0, m: 0 });
  assert.equal(sum.a, r.totals.totalAnswered);
  assert.equal(sum.m, r.totals.totalMissed);
  assert.deepEqual(J(r.deptGroups[1].totals.daily), J(b.totals.daily), 'a dept subtotal keeps its own days (S35)');
});

test('combined: no daily on a part (an older caller) means no grand daily, never a partial one', function () {
  const a = part('CSR', [rosterRow('Bob', { r: 3, a: 3 })], { totalRung: 3, totalAnswered: 3, rosterAgentCount: 1 },
    [['2026-03-09', 3, 0]], {});
  const b = { meta: { department: 'Spanish' }, rows: [], totals: { totalRung: 0, rosterAgentCount: 0 },
              qcd: null, csrTransfer: null, diagnostics: {} };
  const r = hData.call('combineSummaries_', a, [a, b]);
  assert.equal(r.totals.daily, undefined);
});

// -- the queue cards -------------------------------------------------------------
const QCD_HEADER = ['Month Year', 'Week', 'Date', 'Call Queue', 'Call Source',
  'Total Calls', 'Total Answered', 'Abandoned', 'Longest Wait', 'Avg Answer', 'Abandoned %', 'Violations'];
function qrow(dateIso, queue, total, answered, abandoned, avg, source) {
  return ['', '', dateIso, queue, source || 'Total Calls', total, answered, abandoned, '0:01:00', avg, '', 0];
}

test('qcd.range.daily: own queues per date, avg answer weighted, summing to the range block', function () {
  install([]);
  const own = h.call('getDeptQcdQueues_', 'CSR')[0];
  const all = h.call('queuesForDept_', 'CSR');
  const sub = all.filter(function (q) { return h.call('getDeptQcdQueues_', 'CSR').indexOf(q) === -1; })[0];
  const grid = [QCD_HEADER,
    qrow('2026-06-02', own, 100, 90, 10, '0:00:20'),
    qrow('2026-06-02', own, 50, 10, 40, '0:01:00', 'Inbound Only'),   // not the summed source
    qrow('2026-06-03', own, 40, 30, 10, '0:00:40'),
    qrow('2026-05-20', own, 999, 999, 0, '0:00:10'),                  // outside the range
  ];
  if (sub) grid.push(qrow('2026-06-02', sub, 500, 500, 0, '0:00:05'));   // a SUB-queue: not the dept's own
  install([], { 'QCD Historical Data': grid });
  const snap = h.call('computeDeptQcdSnapshot_', 'CSR', 'America/Chicago', { from: '2026-06-01', to: '2026-06-30' });
  assert.deepEqual(J(snap.range.daily), [
    ['2026-06-02', 100, 90, 10, 20],
    ['2026-06-03', 40, 30, 10, 40],
  ], 'compact [iso, calls, answered, abandoned, avgAnswerSec]');
  const t = snap.range.daily.reduce(function (s, d) { return { c: s.c + d[1], x: s.x + d[3] }; }, { c: 0, x: 0 });
  assert.equal(t.c, snap.range.totalCalls, 'the days sum to the Queue calls tile');
  assert.equal(t.x, snap.range.abandoned);
  assert.equal(snap.mtd.daily, undefined, 'only the range block carries days');
});

// -- the client's pure rules -----------------------------------------------------
const S5 = fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard', 'script-5-dept.html'), 'utf8');
function extractFn(text, name) {
  const at = text.search(new RegExp('function ' + name + '\\('));
  assert.ok(at >= 0, 'function ' + name + ' not found');
  const open = text.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(at, i + 1); }
  }
  throw new Error('unbalanced ' + name);
}
// eslint-disable-next-line no-new-func
const buckets = new Function('return (' + extractFn(S5, 'dtsDayBuckets_') + ');')();
function workdays(holidays) {
  const hol = new Set(holidays || []);
  return function (iso) {
    const d = new Date(iso + 'T12:00:00Z').getUTCDay();
    return d !== 0 && d !== 6 && !hol.has(iso);
  };
}
function span(from, to) {
  const out = [];
  for (let d = new Date(from + 'T12:00:00Z'); d <= new Date(to + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

test('buckets: one bar per WORKDAY -- weekends and company holidays get none, a quiet workday gets an empty bar', function () {
  const days = { '2026-09-04': { q: 10 }, '2026-09-08': { q: 12 }, '2026-09-05': { q: 3 } };   // a Saturday with data
  const b = buckets(span('2026-09-03', '2026-09-09'), days, workdays(['2026-09-07']));
  assert.deepEqual(J(b.map(function (x) { return x.from; })), ['2026-09-03', '2026-09-04', '2026-09-08', '2026-09-09'],
    'Thu, Fri, (no Sat/Sun, no Labor Day) Tue, Wed');
  assert.equal(b[0].n, 1);
  assert.equal(b[0].days.length, 0, 'Thu had no data: an empty bar, not a missing one');
  assert.equal(b[1].days[0].q, 10);
  assert.equal(b[0].weekly, false);
});

test('buckets: past 31 workdays, one bar per Monday-start week with its workday count', function () {
  const b = buckets(span('2026-07-01', '2026-09-30'), {}, workdays(['2026-09-07']));
  assert.ok(b.length >= 13 && b.length <= 15, 'about three months = ~14 weekly bars, got ' + b.length);
  assert.equal(b[0].weekly, true);
  assert.equal(b[0].from, '2026-07-01', 'a part week starts on the window\'s first workday');
  assert.equal(b[0].n, 3, 'Wed-Fri');
  const labor = b.filter(function (x) { return x.key === '2026-09-07'; })[0];
  assert.equal(labor.from, '2026-09-08', 'the holiday Monday starts no bar: the week begins Tuesday');
  assert.equal(labor.n, 4, 'the Labor Day week has 4 workdays');
});

test('buckets: past ~6 months (130 workdays), one bar per calendar month', function () {
  const wd = workdays();
  const days = span('2026-01-01', '2026-12-31').filter(wd);
  const b = buckets(days, {}, wd);
  assert.equal(b.length, 12);
  assert.equal(b[0].monthly, true);
  assert.equal(b[0].weekly, false);
  assert.equal(b[1].key, '2026-02');
  assert.equal(buckets(days.slice(0, 130), {}, wd)[0].weekly, true, '130 workdays is still weekly');
});

test('buckets: exactly 31 workdays stays daily; 32 goes weekly', function () {
  const wd = workdays();
  const days = span('2026-06-01', '2026-08-31').filter(wd);
  assert.equal(buckets(days.slice(0, 31), {}, wd)[0].weekly, false);
  assert.equal(buckets(days.slice(0, 32), {}, wd)[0].weekly, true);
});

test('wiring: admin-only, attached on every strip render, one shared selection', function () {
  assert.match(extractFn(S5, 'renderDeptTeamStrip_'), /dtsAttachDayBars_\(strip, state\);/);
  assert.match(extractFn(S5, 'dtsBarsActive_'), /USER\.role === 'admin'\s*&& document\.body\.getAttribute\('data-view-as'\) !== 'manager'/);
  const attach = extractFn(S5, 'dtsAttachDayBars_');
  assert.match(attach, /if \(!dtsBarsActive_\(\)\) return;/, 'managers never get the bars built');
  assert.match(attach, /block\.setAttribute\('data-admin-only', ''\);/, 'and View-as hides them');
  assert.match(attach, /m\.from === m\.to\) return;/, 'a one-day window has nothing to choose between');
  assert.match(attach, /return dow !== 0 && dow !== 6 && !isCompanyHolidayIso_\(iso, true\);/,
    'workdays are the client\'s one holiday calendar, the same one the tiles\' per-workday pace uses');
  const sel = extractFn(S5, 'dtsSelect_');
  assert.match(sel, /strip\.querySelectorAll\('\.dts-daybars'\)\.forEach/, 'a selection paints EVERY card');
});

// Option 2 (owner 2026-10-21): a card with a STANDARD draws a dashed target
// line on a scale fitted to the days plus the target; far off, a tag instead.
// eslint-disable-next-line no-new-func
const dtsScale = new Function('return (' + extractFn(S5, 'dtsScale_') + ');')();

test('target line: within reach the scale spans days AND target, and the line sits between the bars it divides', function () {
  const days = [84, 79, 88, 91, 76, 83, 69, 86];
  const sc = dtsScale(days, 80);
  assert.equal(sc.off, null);
  assert.ok(sc.lo < 69 && sc.hi > 91, 'every day fits');
  assert.ok(sc.pos(79) < sc.line && sc.line < sc.pos(83), 'below-target days are shorter than the line, above-target taller');
  assert.ok(sc.pos(69) > 0 && sc.pos(91) <= 100);
  // A target just ABOVE every day (within reach) still gets its own height,
  // not the top edge: the scale must stretch to include it.
  const up = dtsScale([60, 64, 70, 66], 80);
  assert.equal(up.off, null);
  assert.ok(up.hi >= 80, 'the scale reaches the target');
  assert.ok(up.line < 100 && up.line > up.pos(70), 'the line sits above the tallest day, inside the plot');
});

test('target line: a target far above every day is not drawn (it would squash the bars); a tag says which way', function () {
  const sc = dtsScale([27, 31, 24, 33, 29, 22, 35], 80);
  assert.equal(sc.off, 'above');
  assert.equal(sc.line, null);
  assert.ok(sc.pos(35) - sc.pos(22) > 60, 'the days keep their own spread');
  assert.equal(dtsScale([0.2, 0.4, 0.3], 30).off, 'above');
  assert.equal(dtsScale([40, 42], 10).off, 'below');
});

test('target line: Abandoned % (low is good) -- a 4% standard over sub-1% days stays drawn above them', function () {
  const sc = dtsScale([0, 0.4, 1.2, 0.8, 0], 4);
  assert.equal(sc.off, null, 'within the 5-pt minimum reach');
  assert.ok(sc.line > sc.pos(1.2));
  assert.ok(sc.lo >= 0, 'never below zero');
});

test('target line: no standard (or no data) -> no scale; the card keeps min-to-max heights', function () {
  assert.equal(dtsScale([1, 2, 3], null), null);
  assert.equal(dtsScale([], 80), null);
  const attach = extractFn(S5, 'dtsAttachDayBars_');
  assert.match(attach, /var sc = dtsScale_\(nums, tgt\);/);
  assert.match(attach, /\(sc \? sc\.pos\(v\) : 22 \+ 78 \*/, 'a card without a standard keeps the old heights');
  assert.match(attach, /'<div class="dts-plot">'/, 'the line sits beside the bars, not among them (dtsSelect_ indexes .dts-bars children)');
  const metrics = S5.slice(S5.indexOf('var DTS_METRICS_ = {'), S5.indexOf('function dtsScale_'));
  assert.match(metrics, /t: function \(dept\) \{ return answerStdFor_\(dept\)\.target; \}/, '% Ans: the dept\'s own answer standard');
  assert.match(metrics, /t: function \(\) \{ return ABANDON_STANDARD_; \}/, 'Abandoned %: the 4% standard');
});

// ── QV-1 (owner 2026-10-29): the day quick view ──────────────────────────
const dqvCardFigure = new Function('answerTierCls_', 'fmtNumber', 'fmtDuration', 'ABANDON_STANDARD_',
  'return (' + extractFn(S5, 'dqvCardFigure_') + ');')(
  function (pct) { return pct < 80 ? ' bm-bad' : (pct < 90 ? ' bm-watch' : ' bm-target'); },
  function (n) { return String(n); },
  function (s) { return '0:00:' + String(Math.round(s)).padStart(2, '0'); },
  4);

test('QV-1: each card\'s day figure comes from the bars\' own day sums, tinted where a standard broke', function () {
  const t = { ans: 85, miss: 15, q: 100, qans: 95, abd: 5, avgW: 30 * 95, avgN: 95 };
  assert.deepEqual(dqvCardFigure('rate', t, 'CSR'), { big: '85.0%', sub: '85 of 100 rings', cls: 'is-watch' });
  assert.equal(dqvCardFigure('rate', Object.assign({}, t, { ans: 70, miss: 30 }), 'CSR').cls, 'is-bad');
  assert.equal(dqvCardFigure('rate', Object.assign({}, t, { ans: 95, miss: 5 }), 'CSR').cls, '');
  assert.deepEqual(dqvCardFigure('rate', Object.assign({}, t, { ans: 0, miss: 0 }), 'CSR'), { big: '–', sub: 'no rings', cls: '' });
  assert.deepEqual(dqvCardFigure('qcalls', t), { big: '100', sub: '95 answered · 5 abandoned', cls: '' });
  assert.deepEqual(dqvCardFigure('qabd', t), { big: '5.00%', sub: '5 abandoned', cls: 'is-bad' }, '4.00% or more breaks the standard');
  assert.equal(dqvCardFigure('qabd', Object.assign({}, t, { abd: 3 })).cls, '');
  assert.deepEqual(dqvCardFigure('qavg', t), { big: '0:00:30', sub: 'avg answer', cls: '' });
  assert.equal(dqvCardFigure('qavg', Object.assign({}, t, { avgN: 0 })).big, '–');
  assert.equal(dqvCardFigure('answered', t).big, '85');
  assert.equal(dqvCardFigure('nope', t), null);
});

test('QV-1: released WITH the day bars; outbound behind obAllowed_; day bars only; two single-day reads', function () {
  assert.match(extractFn(S5, 'dqvActive_'), /return dtsBarsActive_\(\);/, 'one gate: the pop-up ships to managers when the bars do');
  assert.match(extractFn(S5, 'dqvDaily_'), /!st\.bs\[0\]\.weekly && !st\.bs\[0\]\.monthly/, 'a week or month bar never opens it');
  const show = extractFn(S5, 'dqvShow_');
  assert.match(show, /var showOb = obAllowed_\(\);/, 'the outbound column stays admin-only after the release');
  assert.match(show, /dqvFetchDays_\(\[b\], showOb, false,/, 'QV-2: the open day is ONE request, outbound only where the viewer sees it');
  assert.match(show, /dqvAgentsHtml_\(day\.summary, \(showOb && !e\.outbound\) \? day\.outbound : null, showOb\)/,
    'a failed outbound part leaves the column on dashes');
  assert.match(extractFn(S5, 'dqvFetchDays_'), /var req = \{ department: DQV_\.dept, dates: list\.map\(function \(x\) \{ return x\.b\.from; \}\), outbound: !!ob \};/,
    'each day of the request is one bucket\'s own date');
  assert.match(extractFn(S5, 'dqvFetchDays_'), /\.getDayQuickView\(req\);/);
  assert.match(show, /var prev = st\.bs\[i - 1\], next = st\.bs\[i \+ 1\];/, 'the arrows step the bars\' days: weekends and holidays are never a stop');
  assert.match(extractFn(S5, 'dqvAgentDayHtml_'), /if \(!showOb\) kpis = kpis\.split\(/, 'the agent-day drill drops its outbound half too');
  const wire = extractFn(S5, 'dtsWire_');
  assert.match(wire, /if \(e\.pointerType === 'mouse' \|\| \(st\.held && st\.sel === idx\)\) \{\s*if \(dqvDaily_\(st\)\) dqvOpen_\(strip, idx\);/);
  assert.match(wire, /\(e\.key === 'Enter' \|\| e\.key === ' '\) && dqvDaily_\(st\)/);
  assert.match(extractFn(S5, 'refresh'), /obSummaryStoreClear_\(\);[^\n]*\n\s*dqvStoreClear_\(\);/, 'an explicit Refresh drops the held days');
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard', 'dashboard.html'), 'utf8');
  const m = html.match(/<div id="day-qv-modal"[^>]*>/);
  assert.ok(m, 'the modal exists');
  assert.doesNotMatch(m[0], /data-admin-only/, 'never [data-admin-only]: that rule would un-hide it on load');
  assert.match(m[0], /style="display:none;"/);
});

test('QV-1b / QV-2: neighbour prefetch -- both neighbours in ONE request, once the open day has landed, through the one store', function () {
  const show = extractFn(S5, 'dqvShow_');
  assert.equal((show.match(/dqvPrefetch_\(i\);/g) || []).length, 2, 'after the open day lands AND after it fails');
  const pre = extractFn(S5, 'dqvPrefetch_');
  assert.match(pre, /if \(!DQV_\.open \|\| !st \|\| DQV_\.i !== i\) return;/, 'a closed pop-up or a day stepped past prefetches nothing');
  assert.match(pre, /var near = \[st\.bs\[i - 1\], st\.bs\[i \+ 1\]\]\.filter\(Boolean\);/, 'the two neighbours only, never the whole range');
  assert.match(pre, /if \(near\.length\) dqvFetchDays_\(near, obAllowed_\(\), true,/, 'ONE prefetch request (prefetch: true -> no usage row)');
  const fd = extractFn(S5, 'dqvFetchDays_');
  assert.match(fd, /if \(e && e\.done\) \{ setTimeout\(function \(\) \{ ok\(e\.data, b\); \}, 0\); return; \}/, 'a held day replays asynchronously');
  assert.match(fd, /if \(e\) \{ e\.w\.push\(/, 'a day in flight (a prefetch) is joined by the step, never re-sent');
  assert.match(fd, /if \(DQV_STORE_\[x\.k\] === x\.e\) delete DQV_STORE_\[x\.k\];/, 'a failed request is never kept');
  assert.match(fd, /send\[dqvInc_\(b\) \? 1 : 0\]\.push/, 'days split only by their exception-day flag');
  assert.match(extractFn(S5, 'dqvKey_'), /\[DQV_\.dept, b\.from, ob \? 1 : 0, dqvInc_\(b\) \? 1 : 0\]/);
  assert.doesNotMatch(S5.slice(S5.indexOf('function dqvFetchDays_('), S5.indexOf('function dqvAgentsHtml_(')),
    /getDepartmentSummary|getMissedCallsReport|obSummaryFetch_/, 'the pop-up reads nothing outside the one request');
});

test('QV-3: loading states -- skeletons on a fresh open, frost when stepping, none for a held day, the label follows the day', function () {
  const show = extractFn(S5, 'dqvShow_');
  assert.match(show, /var held = DQV_STORE_\[dqvKey_\(b, showOb\)\];\s*if \(!\(held && held\.done\)\) \{/, 'a prefetched day paints with no busy state');
  assert.match(show, /dqvBusy_\(agentsEl, 'agents', lbl, showOb\);\s*dqvBusy_\(missedEl, 'missed', lbl\);/);
  assert.equal((show.match(/dqvPaint_\(/g) || []).length, 4, 'every outcome (data or error, both sections) lifts the busy state');
  const busy = extractFn(S5, 'dqvBusy_');
  assert.match(busy, /el\.setAttribute\('aria-busy', 'true'\);/);
  assert.match(busy, /if \(el\.__dqvFilled\) \{\s*dsFrostShow_\(el, label\);/, 'content already shown is frosted, never collapsed');
  assert.match(busy, /if \(lab\) lab\.textContent = label;/, 'a second quick step relabels the frost already up');
  assert.match(busy, /else \{\s*el\.innerHTML = dqvSkeletonHtml_\(kind, label, ob\);/);
  const paint = extractFn(S5, 'dqvPaint_');
  assert.match(paint, /el\.classList\.remove\('ds-frost-host'\);\s*el\.removeAttribute\('aria-busy'\);\s*el\.__dqvFilled = true;/);
  assert.match(extractFn(S5, 'dqvOpen_'), /el\.__dqvFilled = false;/, 'a fresh open never frosts the last visit\'s content');
  const sk = extractFn(S5, 'dqvSkeletonHtml_');
  assert.match(sk, /role="status"><span class="sr-only">' \+ escapeHtml\(label\)/, 'the skeleton is a labelled live status');
  assert.match(extractFn(S5, 'dqvToggleAgent_'), /dqvSkeletonHtml_\('day', 'Loading ' \+ agent/);
});

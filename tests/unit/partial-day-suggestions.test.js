'use strict';

// P9 (follow-up plan 2026-11-13; Operator State #94): suggestions of likely
// partial days, for the admin to confirm.
//
// The per-call tables record when each call started, so every agent-day has a
// first and a last call time. A day much shorter than that agent's OWN usual
// span is suggested, with the share the span implies. What must hold:
//   - it only SUGGESTS: the read writes nothing, and nothing is marked until
//     the admin saves the day or dismisses the suggestion;
//   - "usual" is the agent's median span, so short days do not drag it down;
//   - an agent with too little history, or a usual day too short to fall
//     short of (a manager), is not judged;
//   - a day that already has a row -- a mark, or a dismissal -- is never
//     suggested again; nor is a weekend, a holiday or an exception day;
//   - a dismissal is a Credit-1 row: NOT a mark, so no figure and no cache key
//     moves;
//   - agent names reach the database as a bound parameter, never as SQL text.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadGas, DASHBOARD_DIR } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { dqeSheet, rosterGrid } = require('../harness/fixtures');

const J = (x) => JSON.parse(JSON.stringify(x));
const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'Auth.gs', 'CompanyOverview.gs', 'QCDReport.gs', 'DeptConfig.gs',
          'Data.gs', 'NeonRead.gs', 'NeonCoverage.gs', 'Setup.gs', 'PartialDays.gs'],
  capture: ['SHEETS', 'PARTIAL_DAYS_HEADERS', 'EXCEPTION_DAYS_HEADERS', 'PARTIAL_SUGGEST_DAYS_',
            'PARTIAL_DAY_REVIEWED_REASON_', 'PARTIAL_SUGGEST_MAX_'],
});

const ROSTER = rosterGrid({ Alpha: ['Anna, 201', 'Ben, 202', 'Mel, 203'], Beta: ['Cara, 301'] });
const REAL_CONN = h.ctx.getDashboardNeonConn_;
const REAL_EGRESS = h.ctx.neonNoteEgress_;

// The last ten workdays before today, oldest first (the read ends yesterday).
function isoOf(d) { return d.toISOString().slice(0, 10); }
// "Today" as the server sees it (Config.gs TZ) -- a clock read, not a sheet
// fixture, so the R46 fixture-timezone rule does not apply to it.
const SCRIPT_TZ = ['America', 'Chicago'].join('/');
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: SCRIPT_TZ }).format(new Date());
const WORKDAYS = (function () {
  const out = [];
  const d = new Date(TODAY + 'T12:00:00Z');
  while (out.length < 10) {
    d.setUTCDate(d.getUTCDate() - 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.unshift(isoOf(d));
  }
  return out;
})();
// The most recent Saturday before today.
const SATURDAY = (function () {
  const d = new Date(TODAY + 'T12:00:00Z');
  do { d.setUTCDate(d.getUTCDate() - 1); } while (d.getUTCDay() !== 6);
  return isoOf(d);
})();

function install(opts) {
  opts = opts || {};
  h.state.props = { SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' };
  h.state.userEmail = opts.user || 'admin@x.com';
  const sheets = { 'DO NOT EDIT!': ROSTER, 'DQE Historical Data': dqeSheet([]) };
  sheets[h.consts.SHEETS.PARTIAL_DAYS] = [h.consts.PARTIAL_DAYS_HEADERS.slice()].concat(opts.rows || []);
  if (opts.exception) {
    sheets[h.consts.SHEETS.EXCEPTION_DAYS] = [h.consts.EXCEPTION_DAYS_HEADERS.slice()].concat(opts.exception);
  }
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: sheets });
  h.state.cache.clear();
  h.ctx.getDashboardNeonConn_ = REAL_CONN;
  h.ctx.neonNoteEgress_ = REAL_EGRESS;
}
// A fake database: `main` answers the inbound + outbound statement, `direct`
// the direct-call one (an Error = the table does not exist). Records every
// statement's SQL and bound parameters.
function fakeNeon(main, direct) {
  const seen = { sql: [], binds: [], egress: [] };
  h.ctx.getDashboardNeonConn_ = function () {
    return {
      prepareStatement: function (sql) {
        const isDirect = String(sql).indexOf('FROM direct_calls') !== -1;
        if (isDirect && direct instanceof Error) throw direct;
        const binds = [];
        seen.sql.push(String(sql)); seen.binds.push(binds);
        let n = 0;
        return { setString: function (i, v) { binds[i - 1] = v; }, setQueryTimeout: function () {},
          executeQuery: function () {
            return { next: function () { return n++ === 0; },
              getString: function () { return JSON.stringify(isDirect ? (direct || []) : main); }, close: function () {} };
          }, close: function () {} };
      },
      close: function () {},
    };
  };
  h.ctx.neonNoteEgress_ = function (bytes, label) { seen.egress.push([bytes, label]); };
  return seen;
}
const sheetRows = function () {
  return h.state.spreadsheet.getSheetByName(h.consts.SHEETS.PARTIAL_DAYS).getDataRange().getValues()
    .slice(1).map(function (r) { return r[0] + '|' + r[1] + '|' + r[2] + '|' + r[3]; });
};
// 6:30-14:45 Pacific = 8.25 h.
const FULL = [23400, 53100];
const span = (agent, date, first, last, n) => ({ agent: agent, date: date, first: first, last: last, n: n == null ? 30 : n });
const suggest = (spans, opts) => J(h.call('partialDaySuggestionsFrom_', spans, opts || {}));

// ── The rule (pure) ─────────────────────────────────────────────────────────

test('the suggested share is the nearest quarter below a whole day; within an eighth of usual is no suggestion', function () {
  const c = function (s, u) { return h.call('pdSuggestedCredit_', s, u); };
  assert.equal(c(8, 8), null);
  assert.equal(c(7.1, 8), null, 'a slightly short day is not a suggestion');
  assert.equal(c(6.9, 8), 0.75);
  assert.equal(c(5, 8), 0.75, 'exactly five eighths rounds up');
  assert.equal(c(4.9, 8), 0.5);
  assert.equal(c(4, 8), 0.5);
  assert.equal(c(2.9, 8), 0.25);
  assert.equal(c(1, 8), 0.25);
  assert.equal(c(0.9, 8), 0, 'almost nothing: not a day');
  assert.equal(c(0, 8), 0);
  assert.equal(c(3, 0), null, 'no usual day, no suggestion');
});

test('stored times are Pacific and shown in Central; the median is the middle, not the mean', function () {
  assert.equal(h.call('pdClockCst_', 23400), '8:30');
  assert.equal(h.call('pdClockCst_', 53100), '16:45');
  assert.equal(h.call('pdClockCst_', 0), '2:00');
  assert.equal(h.call('pdMedian_', [8, 8, 8, 1, 2]), 8);
  assert.equal(h.call('pdMedian_', [2, 4]), 3);
  assert.equal(h.call('pdMedian_', []), 0);
});

test('a day much shorter than the agent\'s own usual day is suggested, with its times and the usual day', function () {
  const spans = WORKDAYS.slice(0, 6).map(function (d) { return span('Anna', d, FULL[0], FULL[1]); });
  spans.push(span('Anna', WORKDAYS[6], FULL[0], FULL[0] + 4 * 3600, 12));
  const out = suggest(spans);
  assert.deepEqual(out.suggestions, [{ date: WORKDAYS[6], agent: 'Anna', first: '8:30', last: '12:30',
    hours: 4, usualHours: 8.3, calls: 12, usualCalls: 30, credit: 0.5 }]);
  assert.equal(out.judged, 1);
  assert.equal(out.truncated, false);
});

test('"usual" is the median, so several short days do not pull it down to meet them', function () {
  const spans = WORKDAYS.slice(0, 6).map(function (d) { return span('Anna', d, FULL[0], FULL[1]); });
  WORKDAYS.slice(6, 10).forEach(function (d) { spans.push(span('Anna', d, FULL[0], FULL[0] + 2 * 3600)); });
  const out = suggest(spans);
  assert.equal(out.suggestions.length, 4, 'all four short days stand out against the 8.3 h usual');
  assert.ok(out.suggestions.every(function (s) { return s.usualHours === 8.3 && s.credit === 0.25; }));
  assert.deepEqual(out.suggestions.map(function (s) { return s.date; }), WORKDAYS.slice(6, 10).reverse(), 'newest first');
});

test('an agent with too little history, or a usual day too short to fall short of, is not judged', function () {
  const spans = [];
  WORKDAYS.slice(0, 3).forEach(function (d) { spans.push(span('Ben', d, FULL[0], FULL[1])); });   // 4 days in all
  spans.push(span('Ben', WORKDAYS[4], FULL[0], FULL[0] + 600));
  WORKDAYS.slice(0, 9).forEach(function (d) { spans.push(span('Mel', d, 36000, 39600, 3)); });     // a 1 h usual day
  spans.push(span('Mel', WORKDAYS[9], 36000, 36300, 1));
  const out = suggest(spans);
  assert.deepEqual(out.suggestions, []);
  assert.equal(out.judged, 0);
  assert.deepEqual(out.skippedAgents, ['Ben', 'Mel']);
  // The floors are options: with them lowered, both are judged.
  assert.equal(suggest(spans, { minDays: 2, minUsualHours: 0.5 }).suggestions.length, 2);
});

test('a day that already has a row -- a mark, a zero, or a dismissal -- is never suggested', function () {
  const spans = WORKDAYS.slice(0, 6).map(function (d) { return span('Anna', d, FULL[0], FULL[1]); });
  [6, 7, 8, 9].forEach(function (i) { spans.push(span('Anna', WORKDAYS[i], FULL[0], FULL[0] + 3600)); });
  const answered = {};
  answered[WORKDAYS[6] + '|Anna'] = 0.5;   // marked
  answered[WORKDAYS[7] + '|Anna'] = 0;     // marked "not a day"
  answered[WORKDAYS[8] + '|Anna'] = 1;     // dismissed: a whole day
  const out = suggest(spans, { answered: answered });
  assert.deepEqual(out.suggestions.map(function (s) { return s.date; }), [WORKDAYS[9]]);
  // Another agent's row on the same date answers nothing for Anna.
  const other = {}; other[WORKDAYS[9] + '|Ben'] = 0.5;
  assert.equal(suggest(spans, { answered: other }).suggestions.length, 4);
});

test('a day that is not a workday is neither suggested nor counted toward "usual"; a bad span is ignored', function () {
  const spans = WORKDAYS.slice(0, 6).map(function (d) { return span('Anna', d, FULL[0], FULL[1]); });
  spans.push(span('Anna', SATURDAY, FULL[0], FULL[0] + 1800));        // a Saturday call
  spans.push(span('Anna', WORKDAYS[7], 50000, 40000));                // last before first
  spans.push({ agent: 'Anna', date: WORKDAYS[8], first: 'x', last: 'y', n: 1 });
  const out = suggest(spans, { isWorkday: function (iso) { return iso !== SATURDAY; } });
  assert.deepEqual(out.suggestions, []);
  assert.equal(out.judged, 1);
});

test('the list is capped, newest first, and says so', function () {
  const spans = [];
  ['Anna', 'Ben'].forEach(function (a) {
    WORKDAYS.slice(0, 6).forEach(function (d) { spans.push(span(a, d, FULL[0], FULL[1])); });
    WORKDAYS.slice(6, 10).forEach(function (d) { spans.push(span(a, d, FULL[0], FULL[0] + 3600)); });
  });
  const out = suggest(spans, { max: 3 });
  assert.equal(out.suggestions.length, 3);
  assert.equal(out.truncated, true);
  assert.deepEqual(out.suggestions.map(function (s) { return s.date + ' ' + s.agent; }),
    [WORKDAYS[9] + ' Anna', WORKDAYS[9] + ' Ben', WORKDAYS[8] + ' Anna']);
});

// ── The read ────────────────────────────────────────────────────────────────

// Anna: six full days and one four-hour day, split across the inbound and
// outbound rows the way the database returns them.
function annaRows() {
  const rows = [];
  WORKDAYS.slice(0, 6).forEach(function (d) {
    rows.push(['Anna', d, FULL[0] + 900, FULL[1] - 1800, 26]);   // inbound legs
    rows.push(['Anna', d, FULL[0], FULL[1], 4]);                 // outbound calls
  });
  rows.push(['Anna', WORKDAYS[6], FULL[0], FULL[0] + 4 * 3600, 12]);
  return rows;
}

test('the read is admin-only, needs a real department, and writes nothing', function () {
  install({ user: 'manager@x.com' });
  assert.throws(function () { h.call('getPartialDaySuggestions', { department: 'Alpha' }); }, /admin/i);
  install();
  assert.throws(function () { h.call('getPartialDaySuggestions', { department: 'Nowhere' }); }, /Choose a department/);
  assert.throws(function () { h.call('getPartialDaySuggestions', {}); }, /Choose a department/);
  fakeNeon(annaRows());
  const before = sheetRows().join(';');
  const out = J(h.call('getPartialDaySuggestions', { department: 'Alpha' }));
  assert.equal(out.suggestions.length, 1);
  assert.equal(sheetRows().join(';'), before, 'a suggestion is not a mark: the sheet is untouched');
  assert.equal(h.call('partialDayCredit_', WORKDAYS[6], 'Anna'), 1);
});

test('the read merges an agent-day across the sources: earliest first call, latest last call, calls summed', function () {
  install();
  const seen = fakeNeon(annaRows(), [['Anna', WORKDAYS[6], FULL[0] - 600, FULL[0] + 300, 2]]);
  const out = J(h.call('getPartialDaySuggestions', { department: 'Alpha' }));
  assert.equal(out.available, true);
  assert.equal(out.department, 'Alpha');
  assert.deepEqual(out.suggestions, [{ date: WORKDAYS[6], agent: 'Anna', first: '8:20', last: '12:30',
    hours: 4.2, usualHours: 8.3, calls: 14, usualCalls: 30, credit: 0.5 }]);
  assert.equal(out.judged, 1);
  // The window ends yesterday and is PARTIAL_SUGGEST_DAYS_ long.
  const y = new Date(TODAY + 'T12:00:00Z'); y.setUTCDate(y.getUTCDate() - 1);
  const f = new Date(y.getTime()); f.setUTCDate(f.getUTCDate() - (h.consts.PARTIAL_SUGGEST_DAYS_ - 1));
  assert.equal(out.to, isoOf(y));
  assert.equal(out.from, isoOf(f));
  assert.equal(seen.sql.length, 2, 'one statement for inbound + outbound, one for direct calls');
  assert.deepEqual(seen.egress.map(function (e) { return e[1]; }), ['partialSuggest', 'partialSuggest'], 'both reads are metered');
});

test('agent names reach the database as ONE bound JSON parameter, never as SQL text; the journey read is guarded', function () {
  install();
  const seen = fakeNeon(annaRows());
  h.call('getPartialDaySuggestions', { department: 'Alpha' });
  const sql = seen.sql[0];
  ['Anna', 'Ben', 'Mel'].forEach(function (n) { assert.ok(sql.indexOf(n) === -1, n + ' is not in the SQL text'); });
  assert.deepEqual(J(seen.binds[0]).filter(function (b) { return /^\[/.test(b); }).map(function (b) { return JSON.parse(b); }),
    [['Anna', 'Ben', 'Mel'], ['Anna', 'Ben', 'Mel']], 'the roster, bound once per source');
  assert.ok(seen.binds[0].indexOf('Cara') === -1 && JSON.stringify(seen.binds[0]).indexOf('Cara') === -1, 'only this department\'s roster');
  assert.match(sql, /IN \(SELECT json_array_elements_text\(\?::json\)\)/);
  assert.match(sql, /CASE WHEN c\.journey LIKE '\[%' THEN c\.journey::json ELSE '\[\]'::json END/, 'a journey that is not a JSON array cannot fail the read');
  assert.match(sql, /COALESCE\(e->>'transfer', ''\) <> 'true'/, 'cross-referenced transfer events are not the agent\'s own legs');
  assert.match(sql, /\(e->>'t'\) ~ '\^\[0-9\]\{1,2\}:\[0-9\]\{2\}:\[0-9\]\{2\}\$'/, 'only well-formed times are cast');
  assert.match(sql, /GROUP BY 1, 2/, 'aggregated in the database: one row per agent-day comes back, never a call');
});

test('no direct-call table yet: the inbound and outbound evidence still answers', function () {
  install();
  fakeNeon(annaRows(), new Error('relation "direct_calls" does not exist'));
  const out = J(h.call('getPartialDaySuggestions', { department: 'Alpha' }));
  assert.equal(out.available, true);
  assert.equal(out.suggestions.length, 1);
});

test('the database unreachable or failing: "not available" with a reason, never a throw and never a guess', function () {
  install();
  h.ctx.getDashboardNeonConn_ = function () { return null; };
  let out = J(h.call('getPartialDaySuggestions', { department: 'Alpha' }));
  assert.equal(out.available, false);
  assert.match(out.reason, /could not be reached/);
  assert.deepEqual(out.suggestions, []);
  h.ctx.getDashboardNeonConn_ = function () { return { prepareStatement: function () { throw new Error('boom'); }, close: function () {} }; };
  out = J(h.call('getPartialDaySuggestions', { department: 'Alpha' }));
  assert.equal(out.available, false);
  assert.match(out.reason, /could not be read/);
  assert.ok(!/boom/.test(out.reason), 'the raw error stays in the log');
});

test('a weekend and an exception day are left out by the read; so is a day with a row in the sheet', function () {
  const rows = annaRows();
  rows.push(['Anna', SATURDAY, FULL[0], FULL[0] + 1800, 2]);                 // a Saturday call
  rows.push(['Anna', WORKDAYS[7], FULL[0], FULL[0] + 2 * 3600, 6]);          // an outage day
  rows.push(['Anna', WORKDAYS[8], FULL[0], FULL[0] + 2 * 3600, 6]);          // dismissed below
  rows.push(['Anna', WORKDAYS[9], FULL[0], FULL[0] + 2 * 3600, 6]);          // another department's outage
  // The outage on WORKDAYS[7] is THIS department's only (found by bite-check:
  // an all-company exception day is already not a working day, so only a
  // department-scoped one shows whether the read asks about the department).
  install({ exception: [[WORKDAYS[7], 'Alpha', 'outage', true, 'admin@x.com', 't'],
                        [WORKDAYS[9], 'Beta', 'their outage', true, 'admin@x.com', 't']],
            rows: [[WORKDAYS[8], 'Anna', 1, h.consts.PARTIAL_DAY_REVIEWED_REASON_, 'admin@x.com', 't']] });
  fakeNeon(rows);
  const out = J(h.call('getPartialDaySuggestions', { department: 'Alpha' }));
  assert.deepEqual(out.suggestions.map(function (s) { return s.date; }), [WORKDAYS[9], WORKDAYS[6]],
    'Alpha\'s own outage day is out; Beta\'s outage is an ordinary day for Alpha');
});

// ── Dismissing a suggestion ─────────────────────────────────────────────────

test('dismiss is admin-only and validated; a refused call writes nothing', function () {
  install({ user: 'manager@x.com' });
  const before = sheetRows().join(';');
  assert.throws(function () { h.call('dismissPartialDaySuggestion', { date: WORKDAYS[5], agent: 'Anna' }); }, /admin/i);
  assert.equal(sheetRows().join(';'), before);
  install();
  assert.throws(function () { h.call('dismissPartialDaySuggestion', { date: 'x', agent: 'Anna' }); }, /date/i);
  assert.throws(function () { h.call('dismissPartialDaySuggestion', { date: '2999-01-01', agent: 'Anna' }); }, /not happened/);
  assert.throws(function () { h.call('dismissPartialDaySuggestion', { date: WORKDAYS[5], agent: 'Nobody' }); }, /not on any department roster/);
  assert.throws(function () { h.call('dismissPartialDaySuggestion', { date: WORKDAYS[5], agent: 'anna' }); }, /roster/, 'exact name');
  assert.equal(sheetRows().join(';'), '');
});

test('a dismissal is a Credit-1 row -- NOT a mark: no figure and no cache key moves, and it is listed apart', function () {
  install();
  const tag0 = h.call('partialDaysTag_');
  const out = J(h.call('dismissPartialDaySuggestion', { date: WORKDAYS[5], agent: 'Anna' }));
  assert.deepEqual(sheetRows(), [WORKDAYS[5] + '|Anna|1|' + h.consts.PARTIAL_DAY_REVIEWED_REASON_]);
  assert.deepEqual(out.days, [], 'not among the marks');
  assert.equal(out.reviewed.length, 1);
  assert.equal(out.reviewed[0].date, WORKDAYS[5]);
  assert.equal(out.reviewed[0].agent, 'Anna');
  assert.equal(out.reviewed[0].addedBy, 'admin@x.com');
  assert.equal(h.call('partialDayCredit_', WORKDAYS[5], 'Anna'), 1, 'the day is still a whole day');
  assert.deepEqual(J(h.call('creditedDays_', 'Anna', [WORKDAYS[5]])), { credited: 1, partial: 0, marks: [] });
  assert.equal(h.call('partialDaysTag_'), tag0, 'no report cache key changes');
  assert.equal(tag0, '');
  // Dismissing twice adds nothing.
  h.call('dismissPartialDaySuggestion', { date: WORKDAYS[5], agent: 'Anna' });
  assert.equal(sheetRows().length, 1);
});

test('a day that already has a mark is left exactly as it is; a review can be removed, or turned into a mark in place', function () {
  install({ rows: [[WORKDAYS[4], 'Anna', 0.5, 'Training', 'admin@x.com', 't']] });
  h.call('dismissPartialDaySuggestion', { date: WORKDAYS[4], agent: 'Anna' });
  assert.deepEqual(sheetRows(), [WORKDAYS[4] + '|Anna|0.5|Training'], 'the mark stands');
  h.call('dismissPartialDaySuggestion', { date: WORKDAYS[5], agent: 'Anna' });
  // Saving a mark on the reviewed day updates that one row.
  let out = J(h.call('savePartialDay', { date: WORKDAYS[5], agent: 'Anna', credit: 0.25, reason: 'Leave' }));
  assert.equal(sheetRows().length, 2);
  assert.equal(out.reviewed.length, 0);
  assert.equal(h.call('partialDayCredit_', WORKDAYS[5], 'Anna'), 0.25);
  // And a review is removed by the same Remove the marks use.
  h.call('dismissPartialDaySuggestion', { date: WORKDAYS[6], agent: 'Ben' });
  out = J(h.call('removePartialDay', { date: WORKDAYS[6], agent: 'Ben' }));
  assert.equal(out.removed, 1);
  assert.equal(out.reviewed.length, 0);
});

test('the editor\'s init carries the reviewed days and the look-back, beside the marks', function () {
  install({ rows: [[WORKDAYS[4], 'Anna', 0.5, 'Training', 'admin@x.com', 't'],
                   [WORKDAYS[5], 'Ben', 1, h.consts.PARTIAL_DAY_REVIEWED_REASON_, 'admin@x.com', 't'],
                   [WORKDAYS[6], '', 1, '', '', '']] });   // no agent: not a row
  const init = J(h.call('getPartialDaysInit'));
  assert.equal(init.days.length, 1);
  assert.deepEqual(init.reviewed.map(function (r) { return r.date + ' ' + r.agent; }), [WORKDAYS[5] + ' Ben']);
  assert.equal(init.suggestDays, h.consts.PARTIAL_SUGGEST_DAYS_);
  assert.equal(h.consts.PARTIAL_SUGGEST_DAYS_, 90);
});

// ── The client's pure helpers ───────────────────────────────────────────────

test('client: a suggestion disappears once its day has a row; the summary says who was and was not checked', function () {
  const src = fs.readFileSync(path.join(DASHBOARD_DIR, 'script-7-admin.html'), 'utf8');
  const grab = function (name) {
    const at = src.indexOf('function ' + name + '(');
    assert.ok(at >= 0, name);
    let depth = 0;
    for (let i = src.indexOf('{', at); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
    }
  };
  const ctx = vm.createContext({});
  vm.runInContext(['pdSuggestOpen_', 'pdSuggestSummary_'].map(grab).join('\n'), ctx);
  const sug = [{ date: '2026-11-11', agent: 'Carla' }, { date: '2026-11-06', agent: 'Anna' }, { date: '2026-11-05', agent: 'Ben' }];
  const open = J(ctx.pdSuggestOpen_(sug, { days: [{ date: '2026-11-11', agent: 'Carla' }], reviewed: [{ date: '2026-11-06', agent: 'Anna' }] }));
  assert.deepEqual(open, [{ date: '2026-11-05', agent: 'Ben' }]);
  assert.equal(J(ctx.pdSuggestOpen_(sug, { days: [{ date: '2026-11-11', agent: 'Ben' }] })).length, 3, 'another agent\'s row answers nothing');
  assert.equal(J(ctx.pdSuggestOpen_(sug, null)).length, 3);
  assert.equal(ctx.pdSuggestSummary_({ from: '2026-08-18', to: '2026-11-15', judged: 4, notJudged: ['Robin'] }, 2),
    '2 days to look at · 2026-08-18 to 2026-11-15 · 4 agents checked · 1 not checked (too few days, or a usual day too short to judge): Robin');
  assert.equal(ctx.pdSuggestSummary_({ from: 'a', to: 'b', judged: 1, notJudged: [] }, 0), 'Nothing stands out · a to b · 1 agent checked');
  assert.match(ctx.pdSuggestSummary_({ from: 'a', to: 'b', judged: 9, notJudged: [], truncated: true }, 200), /showing the newest 200$/);
  // "Use" fills the form and saves nothing; only Save and Whole day call the server.
  const use = grab('pdSuggestUse_');
  assert.ok(!/google\.script\.run/.test(use), 'Use never calls the server');
  assert.match(grab('pdSuggestDismiss_'), /\.dismissPartialDaySuggestion\(\{ date: date, agent: agent \}\)/);
});

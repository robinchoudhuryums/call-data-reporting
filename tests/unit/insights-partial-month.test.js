'use strict';

// Step 1 (owner 2026-10-16, option A): the Insights trend charts mark a month
// the trend window only PARTLY covers. A raw COUNT (answered / missed / rung /
// queue calls / violations) for a part-month reads as a dip that is only the
// calendar, so on a count chart the segment into that month is dashed, its
// point is hollow, the axis tick reads "<label> (to date)" and the tooltip
// gives the count so far plus the whole-month pace. Rates (% answered,
// abandoned %) and talk time are untouched.
//
// The rules are PURE functions lifted out of script-8-insights.html (the
// insights-brief.test.js technique).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');
const F = 'script-8-insights.html';
const SRC = fs.readFileSync(path.join(DIR, F), 'utf8');

function fnSource(name) {
  const start = SRC.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, name + ' is missing from ' + F);
  const open = SRC.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error('unbalanced ' + name);
}
// eslint-disable-next-line no-new-func
const partialMonths = new Function('return (' + fnSource('insTrendPartialMonths_') + ');')();
// eslint-disable-next-line no-new-func
const pace = new Function('return (' + fnSource('insTrendPace_') + ');')();
// eslint-disable-next-line no-new-func
const chartBits = new Function('insTrendPace_', 'return (' + fnSource('insPartialChartBits_') + ');')(pace);

// Mon-Fri minus a holiday set -- the shape of the client's workingDaysBetween_.
function workdays(holidays) {
  const hol = new Set(holidays || []);
  return function (fromIso, toIso) {
    let n = 0;
    const d = new Date(fromIso + 'T12:00:00Z');
    const end = new Date(toIso + 'T12:00:00Z');
    for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const dow = d.getUTCDay();
      if (dow === 0 || dow === 6) continue;
      if (hol.has(d.toISOString().slice(0, 10))) continue;
      n++;
    }
    return n;
  };
}
const J = (x) => JSON.parse(JSON.stringify(x));
const MONTHS = ['2026-08', '2026-09', '2026-10'];

test('a window ending mid-month marks ONLY the last month, in workdays', () => {
  const p = partialMonths(MONTHS, '2026-08-01', '2026-10-15', '2026-10-15', workdays());
  assert.equal(p[0], null);
  assert.equal(p[1], null);
  assert.deepEqual(J(p[2]), { month: '2026-10', from: '2026-10-01', to: '2026-10-15', elapsed: 11, total: 22 });
});

test('a window ending on the month\'s last WORKDAY is a whole month (Fri Oct 30, the 31st a Saturday)', () => {
  const p = partialMonths(MONTHS, '2026-08-01', '2026-10-30', '2026-10-30', workdays());
  assert.deepEqual(J(p), [null, null, null]);
});

test('a window ending past the latest data is cut at the data', () => {
  const p = partialMonths(MONTHS, '2026-08-01', '2026-10-31', '2026-10-15', workdays());
  assert.equal(p[2].to, '2026-10-15');
  assert.equal(p[2].elapsed, 11);
});

test('company holidays count on neither side (Labor Day 2026-09-07)', () => {
  const p = partialMonths(['2026-08', '2026-09'], '2026-08-01', '2026-09-15', '2026-09-15', workdays(['2026-09-07']));
  assert.deepEqual(J(p[1]), { month: '2026-09', from: '2026-09-01', to: '2026-09-15', elapsed: 10, total: 21 });
});

test('a 366+-day window starting mid-month marks its FIRST month too', () => {
  const p = partialMonths(['2025-03', '2025-04', '2026-03'], '2025-03-17', '2026-03-31', '2026-03-31', workdays());
  assert.equal(p[0].from, '2025-03-17');
  assert.ok(p[0].elapsed < p[0].total);
  assert.equal(p[1], null);
  assert.equal(p[2], null, 'ends on the 31st: whole');
});

test('one month partial at BOTH ends is one entry over the covered span', () => {
  const p = partialMonths(['2026-10'], '2026-10-05', '2026-10-09', '2026-10-09', workdays());
  assert.deepEqual(J(p[0]), { month: '2026-10', from: '2026-10-05', to: '2026-10-09', elapsed: 5, total: 22 });
});

test('data that ends before the last month began: elapsed 0, no pace', () => {
  const p = partialMonths(MONTHS, '2026-08-01', '2026-10-31', '2026-09-30', workdays());
  assert.equal(p[2].elapsed, 0);
  assert.equal(pace(0, p[2]), null);
});

test('bad input degrades to "no partial months", never a throw', () => {
  assert.deepEqual(J(partialMonths(MONTHS, '', '', '', workdays())), [null, null, null]);
  assert.deepEqual(J(partialMonths(MONTHS, '2026-08-01', '2026-10-15', '', null)), [null, null, null]);
  assert.deepEqual(J(partialMonths([], '2026-08-01', '2026-10-15', '', workdays())), []);
});

test('pace scales the count by workdays', () => {
  assert.equal(pace(212, { elapsed: 11, total: 23 }), 443);
  assert.equal(pace(212, null), null);
  assert.equal(pace('x', { elapsed: 11, total: 23 }), null);
});

test('chart bits: dashed segment into the partial point, "(to date)" tick, pace in the tooltip', () => {
  const p = partialMonths(MONTHS, '2026-08-01', '2026-10-15', '2026-10-15', workdays());
  const b = chartBits(p);
  assert.equal(b.any, true);
  assert.deepEqual(b.segment.borderDash({ p0DataIndex: 1, p1DataIndex: 2 }), [5, 4]);
  assert.equal(b.segment.borderDash({ p0DataIndex: 0, p1DataIndex: 1 }), undefined);
  assert.equal(b.tick('Oct 2026', 2), 'Oct 2026 (to date)');
  assert.equal(b.tick('Sep 2026', 1), 'Sep 2026');
  assert.equal(b.note(2, 220), ' so far (Oct 1–Oct 15, 11 of 22 workdays) · on pace for ~440');
  assert.equal(b.note(1, 400), '');
  const none = chartBits([null, null]);
  assert.equal(none.any, false);
  assert.equal(none.tick('Oct 2026', 1), 'Oct 2026');
});

test('wiring: COUNT charts mark the partial month; rates and talk time never do', () => {
  const cards = fnSource('insRenderCardsChartTrend_');
  assert.match(cards, /insPartialChartBits_\(isPct \? \[\] : insPartialForData_\(insLastData\)\)/,
    'the per-agent chart skips % Answered');
  const team = fnSource('insRenderTrendChart_');
  assert.match(team, /insPartialChartBits_\(\(!daily && !isPercent && !isMinutes\) \? insPartialForData_\(data\) : \[\]\)/,
    'the team chart: monthly counts only');
  assert.match(team, /insPartialChartBits_\(\(!daily && !isPct && \(labels \|\| \[\]\)\.length === teamMonths\.length\)/,
    'the queue chart: monthly counts only, and only when its months line up with the team trend');
  // The labels themselves stay untouched -- the point drill parses them.
  assert.doesNotMatch(cards + team, /labels\s*=\s*labels\.map\([^)]*to date/);
});

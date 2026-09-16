'use strict';

// 6b: the Overview trend chart's "Answered calls" metric.
//
// THE RULE: `ovDeptChartSeries_` emits a per-day ANSWERED COUNT alongside the
// answer RATE, from the same DQE per-day map the rate already reads (no extra
// scan), and it follows the null convention every series in that function
// shares -- a day with NO DQE rows is null so the line BREAKS at a weekday
// gap, while a day that has rows and answered nothing is a real 0.
//
// The null-vs-zero half is the part worth pinning: drawing 0 for an absent day
// is indistinguishable from a genuinely dead day, and this chart's whole job
// is comparing departments' volume across days.
//
// The client wiring is pinned by source (the fragment is not loadable here --
// the rendered gate, `npm run ci:ui`, is what actually draws it), because the
// series is useless if the payload field, the range slice, the metric registry
// and the tab button do not all name the same thing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadGas } = require('../harness/loadGas');

const h = loadGas({ files: ['Config.gs', 'Util.gs', 'CompanyOverview.gs'] });
const series = h.ctx.ovDeptChartSeries_;

const LABELS = ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23'];

test('THE RULE: trendAnswered is the per-day answered COUNT, aligned to labels', function () {
  const out = series(LABELS, {
    '2026-07-20': { rung: 10, answered: 8 },
    '2026-07-21': { rung: 20, answered: 15 },
    '2026-07-22': { rung: 5,  answered: 5 },
    '2026-07-23': { rung: 4,  answered: 1 },
  }, {});
  assert.deepEqual(out.trendAnswered, [8, 15, 5, 1]);
});

test('a day with NO DQE rows is null, so the line breaks instead of drawing a false zero', function () {
  const out = series(LABELS, {
    '2026-07-20': { rung: 10, answered: 8 },
    '2026-07-23': { rung: 4, answered: 1 },
  }, {});
  assert.deepEqual(out.trendAnswered, [8, null, null, 1]);
});

test('a day that HAS rows and answered nothing is a real 0, not a gap', function () {
  const out = series(['2026-07-20'], { '2026-07-20': { rung: 12, answered: 0 } }, {});
  assert.deepEqual(out.trendAnswered, [0],
    'zero answered on a day with rings is a fact about the day, not missing data');
  assert.notEqual(out.trendAnswered[0], null);
});

test('the answered COUNT is independent of the rate -- a zero-ring day nulls both', function () {
  const out = series(['2026-07-20'], { '2026-07-20': { rung: 0, answered: 0 } }, {});
  assert.equal(out.trend[0], null, 'no rings -> no rate');
  assert.equal(out.trendAnswered[0], 0, 'but the row exists, so the count is a real 0');
});

test('the count reads the SAME map as the rate -- no separate source to drift', function () {
  const daily = { '2026-07-20': { rung: 10, answered: 7 } };
  const out = series(['2026-07-20'], daily, {});
  assert.equal(out.trend[0], 70);
  assert.equal(out.trendAnswered[0], 7);
});

test('a missing / empty dqeDaily map yields all nulls, never a throw', function () {
  assert.deepEqual(series(LABELS, null, null).trendAnswered, [null, null, null, null]);
  assert.deepEqual(series([], {}, {}).trendAnswered, []);
});

test('the three pre-existing series are unchanged by the addition', function () {
  const out = series(['2026-07-20'], { '2026-07-20': { rung: 10, answered: 8 } },
    { '2026-07-20': { totalCalls: 50, abandoned: 4 } });
  assert.equal(out.trend[0], 80);
  assert.equal(out.trendAbandoned[0], 4);
  assert.equal(out.trendAbandonedPct[0], 8);
});

// --- client wiring: the payload field, the slice, the registry, the tab -----

const DASH = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');
const read = function (f) { return fs.readFileSync(path.join(DASH, f), 'utf8'); };

test('both payloads ship the series: the 90-day blob and the separately-cached YTD fetch', function () {
  const gs = read('CompanyOverview.gs');
  assert.match(gs, /trendChartAnswered: chartSeries\.trendAnswered/,
    'the 90-day Overview blob must carry trendChartAnswered');
  assert.match(gs, /trendAnswered: series\.trendAnswered/,
    'getOverviewChartTrend (YTD) must carry trendAnswered -- it is a SEPARATE payload');
});

test('both cache prefixes were bumped -- the two payloads are cached independently', function () {
  const gs = read('CompanyOverview.gs');
  // FLOORS, not equalities. 6b shipped `trendAnswered` in BOTH payloads and
  // bumped both prefixes (companyOverview v21->v22, overviewChartYtd v1->v2);
  // what must never regress is that either sits BELOW those. Pinning the exact
  // numbers made this fail on the next unrelated bump (R50 moved the blob to
  // v23 for the card `periods` and broke it), which teaches "re-pin the
  // literal" -- a ritual edit that would happily accept a REVERT too.
  const ver = function (re, name) {
    const m = re.exec(gs);
    assert.ok(m, name + ' not found / reshaped -- update this pin');
    return Number(m[1]);
  };
  assert.ok(ver(/COMPANY_OVERVIEW_CACHE_KEY = 'companyOverview:v(\d+)'/, 'COMPANY_OVERVIEW_CACHE_KEY') >= 22,
    'companyOverview must not regress below the v22 that shipped trendAnswered');
  assert.ok(ver(/OVERVIEW_CHART_TREND_CACHE_PREFIX = 'overviewChartYtd:v(\d+)'/, 'OVERVIEW_CHART_TREND_CACHE_PREFIX') >= 2,
    'the YTD payload has its own prefix; bumping only the blob would serve a '
    + 'warmed YTD payload with no trendAnswered for its TTL');
});

test('the client slices, registers and labels the metric under one consistent name', function () {
  const frag = read('script-3-overview.html');
  assert.match(frag, /trendAnswered: \(d\.trendChartAnswered \|\| \[\]\)\.slice\(startIdx\)/,
    'the 30/60/90 range slice must normalize trendChartAnswered -> trendAnswered');
  assert.match(frag, /answeredCalls: \{\s*\n?\s*field: 'trendAnswered', unit: 'count'/,
    'OV_CHART_METRICS_.answeredCalls must read the normalized field as a count');
  assert.match(read('dashboard.html'), /data-metric="answeredCalls"/,
    'the metric needs a tab button -- the registry alone is unreachable');
});

test('the metric name the tab sends is the key the registry answers to', function () {
  const frag = read('script-3-overview.html');
  const keys = (frag.match(/^\s{4}(\w+): \{$/gm) || []).join('');
  assert.ok(/answeredCalls/.test(keys), 'answeredCalls must be a top-level registry key');
  const tabs = read('dashboard.html').match(/data-metric="(\w+)"/g) || [];
  tabs.forEach(function (t) {
    const k = t.match(/"(\w+)"/)[1];
    assert.ok(new RegExp('\\n    ' + k + ': \\{').test(frag),
      'tab data-metric="' + k + '" has no OV_CHART_METRICS_ entry -- the click is a no-op');
  });
});

// ── R50: the Window selector's option set covers the chart's ranges ─────────
//
// THE RULE: the dept cards' Window selector offers 60- and 90-day windows, so
// a manager who puts the trend on 90 days can ask the cards the same question.
// The two controls were built apart and their option sets diverged; the fix is
// only useful if the SERVER ships a period block for every option the CLIENT
// offers -- a missing key falls back to `latest` (ONE day) in ovPeriodStats_,
// which renders as a plausible number rather than an error. So the pin below
// compares the two sets rather than either alone.

test('R50: every client Window option has a server period block, and vice versa', function () {
  const gs = read('CompanyOverview.gs');
  const frag = read('script-3-overview.html');

  const periodsBlk = /periods: \{([\s\S]*?)\},/.exec(gs);
  assert.ok(periodsBlk, 'the `periods` block was not found / reshaped -- update this pin');
  const serverKeys = (periodsBlk[1].match(/^\s*(\w+):/gm) || [])
    .map(function (s) { return s.trim().replace(':', ''); }).sort();

  const clientBlk = /const OV_CARD_PERIODS_ = \{([\s\S]*?)\n  \};/.exec(frag);
  assert.ok(clientBlk, 'OV_CARD_PERIODS_ was not found / reshaped -- update this pin');
  const clientKeys = (clientBlk[1].match(/^\s*(\w+):/gm) || [])
    .map(function (s) { return s.trim().replace(':', ''); }).sort();

  assert.deepEqual(clientKeys, serverKeys,
    'the Window options and the server `periods` block must name the same '
    + 'windows -- a client-only key silently renders ONE day');
  assert.ok(clientKeys.indexOf('last60') !== -1 && clientKeys.indexOf('last90') !== -1,
    'R50 added the 60- and 90-day windows');
});

test('R50: each Window option maps to a real chart range, or to none on purpose', function () {
  const frag = read('script-3-overview.html');
  const ranges = /const OV_CHART_RANGES_ = \{([\s\S]*?)\};/.exec(frag);
  assert.ok(ranges, 'OV_CHART_RANGES_ not found / reshaped -- update this pin');

  const clientBlk = /const OV_CARD_PERIODS_ = \{([\s\S]*?)\n  \};/.exec(frag);
  const mapped = (clientBlk[1].match(/chartRange: (null|'[^']+')/g) || [])
    .map(function (s) { return s.replace("chartRange: ", '').replace(/'/g, ''); });
  assert.ok(mapped.length >= 5, 'every Window option declares a chartRange (null counts)');

  mapped.forEach(function (r) {
    if (r === 'null') return;   // Yesterday: a single day has no trend equivalent
    assert.ok(new RegExp("'?" + r + "'?:").test(ranges[1]),
      'Window maps to chart range "' + r + '" but OV_CHART_RANGES_ has no such key');
  });
  assert.equal(mapped.filter(function (r) { return r === 'null'; }).length, 1,
    'exactly one window (Yesterday) has no chart equivalent');
});

test('R50: the sync runs through the SAME helper the range buttons use', function () {
  const frag = read('script-3-overview.html');
  // A second copy of the range-change logic would have to reproduce YTD's
  // on-demand fetch -- and would drop it, leaving a YTD window charting 90d.
  assert.match(frag, /function ovApplyChartRange_\(r\) \{/,
    'the range change is factored into ovApplyChartRange_');
  assert.match(frag, /if \(cr\) ovApplyChartRange_\(cr\);/,
    'the Window bar syncs the chart through that helper');
  const applyBody = /function ovApplyChartRange_\(r\) \{([\s\S]*?)\n  \}/.exec(frag);
  assert.ok(applyBody, 'ovApplyChartRange_ not found / reshaped');
  assert.match(applyBody[1], /ovLoadYtdChart_\(\)/,
    'the shared helper still owns the YTD on-demand fetch');
});

test('R50: the buttons the markup offers are exactly the windows the client knows', function () {
  const html = fs.readFileSync(path.join(DASH, 'dashboard.html'), 'utf8');
  const bar = /<div id="ov-period-bar"[\s\S]*?<\/div>/.exec(html);
  assert.ok(bar, '#ov-period-bar not found / reshaped -- update this pin');
  const btns = (bar[0].match(/data-period="(\w+)"/g) || [])
    .map(function (s) { return s.replace(/data-period="|"/g, ''); }).sort();

  const frag = read('script-3-overview.html');
  const clientBlk = /const OV_CARD_PERIODS_ = \{([\s\S]*?)\n  \};/.exec(frag);
  const clientKeys = (clientBlk[1].match(/^\s*(\w+):/gm) || [])
    .map(function (s) { return s.trim().replace(':', ''); }).sort();

  assert.deepEqual(btns, clientKeys,
    'a button with no OV_CARD_PERIODS_ entry is inert (the handler rejects it); '
    + 'an entry with no button is unreachable');
});

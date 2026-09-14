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
  assert.match(gs, /COMPANY_OVERVIEW_CACHE_KEY = 'companyOverview:v22'/);
  assert.match(gs, /OVERVIEW_CHART_TREND_CACHE_PREFIX = 'overviewChartYtd:v2'/,
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

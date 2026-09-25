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

// --- the COMPANY aggregate line (owner request 2026-09-18) ------------------
// Pinned HERE because this suite already owns the "both payloads, both
// prefixes" property, and the company line has the same two-payload shape --
// plus one the answered count did not: it is ADMIN-ONLY, and the two payloads
// enforce that by different mechanisms.

test('both payloads ship the company series, by their own admin-gate mechanism', function () {
  const gs = read('CompanyOverview.gs');
  // The 90-day blob puts it INSIDE companyAggregate, which
  // personalizeOverview_ deletes wholesale -- no new strip-list entry to
  // forget, which is the reason for that placement.
  assert.match(gs, /trendChart: chartTrendIsoLabels\.map/,
    'the 90-day blob carries the company rate series');
  assert.match(gs, /trendChartAbandonedPct: chartTrendIsoLabels\.map/,
    'the 90-day blob carries the company abandon series');
  // The YTD endpoint is manager-or-admin with a SHARED cache, so it computes
  // once and strips on serve.
  assert.match(gs, /function ovStripChartTrend_/,
    'the YTD payload needs its own strip -- it is a separate, manager-reachable endpoint');
  assert.match(gs, /if \(user && user\.role === 'admin'\) return payload;/,
    'and it fails CLOSED: anything but a resolved admin loses the field');
  // Every return path must go through it, or a cache hit leaks.
  const fn = gs.slice(gs.indexOf('function getOverviewChartTrend'), gs.indexOf('function ovStripChartTrend_'));
  const returns = (fn.match(/return (data|hit);/g) || []);
  assert.equal(returns.length, 0,
    'no raw `return data/hit` may bypass the strip -- found: ' + JSON.stringify(returns));
  assert.equal((fn.match(/ovStripChartTrend_\(/g) || []).length, 3,
    'all three return paths (cache hit, degraded, fresh) are stripped');
});

test('the company aggregate is counted ONCE per row, never summed from the dept maps', function () {
  const gs = read('CompanyOverview.gs');
  // The 90-day arm reuses companyTrendByDate, which the main loop already
  // accumulates once per (date, agent) row.
  assert.match(gs, /const day = companyTrendByDate\[iso\];/,
    'the 90-day company rate reads the once-per-row map');
  // The YTD arm has no such map, so it builds its own pass -- summing
  // `deptDaily` there would double-count every crossover agent.
  assert.match(gs, /const companyDailyYtd = \{\};/,
    'the YTD company rate gets its OWN pass over the rows');
  assert.ok(!/companyDailyYtd\[[^\]]*\]\s*=\s*deptDaily/.test(gs),
    'and never derives itself from the per-dept maps');
  // The abandon arm is accumulated once per QUEUE ROW inside the snapshot
  // builder, outside the per-dept fan-out.
  assert.match(gs, /out\._companyDaily = companyQcdDaily;/,
    'the QCD snapshot builder returns the company map it accumulated per queue row');
});

test('the client treats it as a reference series on PERCENTAGE metrics only', function () {
  const ov = read('script-3-overview.html');
  // Only the two pct metrics name a company field; the count metrics must not,
  // or a company "answered calls" line would just restate the dept sum.
  const reg = ov.slice(ov.indexOf('const OV_CHART_METRICS_ = {'), ov.indexOf('const OV_CHART_METRIC_KEY_'));
  assert.equal((reg.match(/companyField:/g) || []).length, 2, 'exactly two metrics carry a company line');
  assert.match(reg, /companyField: 'trend'/);
  assert.match(reg, /companyField: 'trendAbandonedPct'/);
  // It must not take a dept hue: IR_CHART_COLORS carries dept IDENTITY.
  const ds = ov.slice(ov.indexOf('const companySeries ='), ov.indexOf('// Metric-specific dashed reference baseline'));
  assert.ok(!/IR_CHART_COLORS/.test(ds) && !/colorByDept/.test(ds),
    'the company line takes no categorical dept hue');
  assert.match(ds, /borderColor: \(THEME && THEME\.text\)/, 'it wears neutral ink');
  assert.ok(!/_deptName/.test(ds.replace(/\/\/[^\n]*/g, '')),
    'and carries no _deptName -- the tile-hover and point-click handlers map a dataset to a DEPT');
  // Pinning a dept must not hide the aggregate it is being compared against.
  assert.match(ov, /skipLabel: \[mcfg\.baselineLabel \|\| '__ov_no_baseline__', OV_COMPANY_LABEL_\]/,
    'the company line is exempt from spotlight dimming');
});

// UI-3 (broad-scan 2026-09-23): the YTD endpoint honors VIEW-AS. The client
// always sent `viewAsDept`; the server ignored it, so an admin previewing a
// manager still got the admin-only Company line. Behavioural: served from a
// cache hit so only the viewer resolution + the strip run.
test('UI-3: getOverviewChartTrend strips the company line for an admin previewing a manager', function () {
  const cached = JSON.stringify({ available: true, latestDate: '2026-09-22', depts: [],
    company: { trend: [90] } });
  const saved = {};
  const stub = {
    resolveUser_: function () { return stub.__user; },
    assertManagerOrAdmin_: function () {},
    getLatestDataDate: function () { return '2026-09-22'; },
    getAllDepartments_: function () { return ['Sales', 'CSR']; },
    logReportUsage_: function () {},
    CacheService: { getScriptCache: function () { return { get: function () { return cached; }, put: function () {} }; } },
    Session: { getActiveUser: function () { return { getEmail: function () { return 'a@x'; } }; } },
  };
  Object.keys(stub).forEach(function (k) { if (k !== '__user') { saved[k] = h.ctx[k]; h.ctx[k] = stub[k]; } });
  try {
    const call = function (user, req) { stub.__user = user; return h.ctx.getOverviewChartTrend(req); };
    const admin = { email: 'a@x', role: 'admin', departments: ['Sales', 'CSR'] };
    const mgr = { email: 'm@x', role: 'manager', department: 'Sales', departments: ['Sales'] };
    assert.ok(call(admin, {}).company, 'a plain admin keeps the company line');
    assert.ok(call(admin, { viewAsDept: '' }).company, 'an empty view-as is not a preview');
    assert.equal(call(admin, { viewAsDept: 'Sales' }).company, undefined,
      'an admin previewing Sales sees what a Sales manager sees -- no company line');
    assert.ok(call(admin, { viewAsDept: 'Nope' }).company, 'an unknown dept is ignored (no preview)');
    assert.equal(call(mgr, {}).company, undefined, 'a real manager never gets it');
    assert.equal(call(mgr, { viewAsDept: 'CSR' }).company, undefined,
      'view-as never WIDENS a non-admin');
  } finally {
    Object.keys(saved).forEach(function (k) { h.ctx[k] = saved[k]; });
  }
});

test('UI-3: the client keys the cached YTD payload by view-as scope and re-fetches on a scope change', function () {
  const ov = fs.readFileSync(path.join(__dirname, '../../apps-script/department-dashboard/script-3-overview.html'), 'utf8');
  assert.match(ov, /function ovYtdFresh_\(\) \{\s*return !!\(ovYtdData && ovYtdData\.available && ovYtdScope === \(viewAsDept_ \|\| ''\)\);/,
    'a cached payload is fresh only for the view-as scope it was fetched under');
  assert.ok(!/ovYtdData && ovYtdData\.available\)/.test(ov.replace(/function ovYtdFresh_[\s\S]*?\n  \}/, '')),
    'every YTD freshness check must go through ovYtdFresh_');
  const apply = ov.slice(ov.indexOf('function applyViewAs_('), ov.indexOf('function applyViewAs_(') + 4000);
  assert.match(apply, /ovChartRange === 'ytd'[\s\S]*?ovLoadYtdChart_\(\)/,
    'entering/exiting view-as re-fetches the YTD series when YTD is on screen');
});

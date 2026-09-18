'use strict';

// getCompanyOverview END-TO-END (the adoption-round follow-on): the real
// entry point run against a DQE fixture, pinning the two-pass aggregation
// the queue-split adoption restructured -- (a) OFF is the documented Phase 0
// behavior (a crossover agent's all-queue figures appear in BOTH dept tiles;
// the company aggregate counts each row ONCE), and (b) DEPT partitions the
// crossover agent between tiles while the company aggregate is UNCHANGED
// (the hero stays all-queue by design). Sub-probes (QCD snapshots, the three
// admin banners) are stubbed -- this suite pins the DQE loop, not them.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');
const { makeFakeSpreadsheet } = require('../harness/fakeSheet');
const { rosterGrid } = require('../harness/fixtures');

const h = loadGas({
  files: ['Config.gs', 'Util.gs', 'DeptConfig.gs', 'CompanyOverview.gs', 'Data.gs'],
});

const LATEST = '2026-07-20';   // a Monday -- inside the weekday trend axis

const ANNA_SPLIT = JSON.stringify({
  A_Q_CSR:     { u: 5, r: 6, m: 2, a: 4, t: 400, n: 4, mt: '' },
  A_Q_Spanish: { u: 4, r: 4, m: 1, a: 3, t: 300, n: 3, mt: '' },
});

function dalRow(o) {
  return {
    dateIso: o.date || LATEST, agent: o.agent,
    totalUnique: o.u || 0, totalRung: o.r || 0, totalMissed: o.m || 0,
    totalAnswered: o.a || 0, tttSec: o.t || 0, attSec: o.att || 0,
    avgAbdWaitSec: 0, csrAvgAbdWaitSec: 0,
    queueSplit: o.split == null ? '' : o.split,
  };
}

function fixtureRows() {
  return [
    // Anna is on BOTH rosters (the crossover case): 10 all-queue rings,
    // splitting 6 CSR / 4 Spanish.
    dalRow({ agent: 'Anna', r: 10, m: 3, a: 7, u: 9, t: 700, att: 100, split: ANNA_SPLIT }),
    // Bob is CSR-only with NO split (a pre-Phase-1 row): fail-open keeps him.
    dalRow({ agent: 'Bob', r: 5, m: 1, a: 4, u: 5, t: 300, att: 75 }),
    // An INV-23 sentinel must reach no tile and not the company aggregate.
    dalRow({ agent: 'A_Q_CSR', r: 0, m: 9, a: 0 }),
  ];
}

function install(opts) {
  opts = opts || {};
  h.state.userEmail = 'admin@x.com';
  h.state.props = { SPREADSHEET_ID: 'fake', ADMIN_EMAILS: 'admin@x.com' };
  if (opts.queueScope) h.state.props.QUEUE_SPLIT_SCOPE = opts.queueScope;
  if (h.state.cache && h.state.cache.clear) h.state.cache.clear();
  h.state.spreadsheet = makeFakeSpreadsheet({ sheets: {
    'DO NOT EDIT!': rosterGrid({ CSR: ['Anna, 301', 'Bob, 302'], Spanish: ['Anna, 301'] }),
    // Present + non-empty so the sheet-source path proceeds; the actual rows
    // come from the sheetFetchDqeRows_ override below.
    'DQE Historical Data': [['h'], ['x']],
  } });
  h.ctx.getAllDepartments_ = function () { return ['CSR', 'Spanish']; };   // Auth.gs, not loaded
  h.ctx.resolveUser_ = function () {
    return { email: 'admin@x.com', role: 'admin', department: null,
             departments: ['CSR', 'Spanish'], assignedDepartments: ['CSR', 'Spanish'], allDepts: false };
  };
  h.ctx.getLatestDataDate = function () { return LATEST; };
  h.ctx.getDqeReadSource_ = function () { return 'sheet'; };
  h.ctx.sheetFetchDqeRows_ = function () { return opts.rows ? opts.rows() : fixtureRows(); };
  h.ctx.inboundQueuesForDept_ = function (d) {
    return { CSR: ['A_Q_CSR'], Spanish: ['A_Q_Spanish'] }[d] || [];
  };
  // Sub-probes out of scope here: QCD chips + the three admin banners.
  h.ctx.computeQcdSnapshots_ = function () { return {}; };
  h.ctx.computeOverviewPipelineFreshness_ = function () { return null; };
  h.ctx.computeOverviewOrphanNag_ = function () { return null; };
  h.ctx.computeOverviewUnmappedQcd_ = function () { return null; };
  h.ctx.logReportUsage_ = function () {};
}

function deptTile(data, name) {
  return (data.depts || []).filter(function (d) { return d.name === name; })[0];
}

test('E2E off: crossover agent appears ALL-QUEUE in both tiles; company aggregate counts each row once; sentinel reaches nothing', function () {
  install({});
  const data = h.call('getCompanyOverview', {});
  const csr = deptTile(data, 'CSR');
  const spa = deptTile(data, 'Spanish');
  assert.ok(csr && spa, 'both dept tiles present');
  assert.equal(csr.latest.rung, 15, 'CSR = Anna 10 (all-queue) + Bob 5');
  assert.equal(spa.latest.rung, 10, 'Spanish = Anna 10 (all-queue) -- the documented Phase 0 double-count');
  assert.equal(csr.latest.answered, 11);
  assert.equal(spa.latest.answered, 7);
  assert.equal(csr.activeAgents, 2);
  assert.equal(spa.activeAgents, 1);
  // Company aggregate: Anna once + Bob once, never the sentinel.
  assert.equal(data.companyAggregate.rung, 15);
  assert.equal(data.companyAggregate.answered, 11);
  const json = JSON.stringify(data);
  assert.ok(json.indexOf('A_Q_CSR') === -1 || data.depts.every(function (d) {
    return !(d.latest && d.name === 'A_Q_CSR');
  }), 'no sentinel tile');
});

test('E2E dept: the crossover agent PARTITIONS between tiles; unsplit rows fail open; the company hero is UNCHANGED', function () {
  install({ queueScope: 'dept' });
  const data = h.call('getCompanyOverview', {});
  const csr = deptTile(data, 'CSR');
  const spa = deptTile(data, 'Spanish');
  assert.equal(csr.latest.rung, 11, 'CSR = Anna\'s CSR slice 6 + Bob 5 (no split -> fail-open rollup)');
  assert.equal(spa.latest.rung, 4, 'Spanish = Anna\'s Spanish slice only');
  assert.equal(csr.latest.rung + spa.latest.rung, 15, 'the two tiles partition the rollup');
  assert.equal(csr.latest.answered, 8, 'Anna 4 + Bob 4');
  assert.equal(spa.latest.answered, 3);
  // The company hero deliberately stays all-queue: every call once.
  assert.equal(data.companyAggregate.rung, 15, 'hero unchanged by the flip');
  assert.equal(data.companyAggregate.answered, 11);
});

test('E2E: the narrowing never leaks between depts on the shared row array (same request computes both tiles)', function () {
  install({ queueScope: 'dept' });
  const data = h.call('getCompanyOverview', {});
  // If dept A's narrowing mutated the shared rows, dept B (computed second,
  // alphabetically CSR then Spanish) would see already-narrowed CSR figures
  // and Spanish's slice would vanish (0) or double-narrow. The partition
  // assertions above catch magnitude errors; this pins the exact leak shape.
  assert.equal(deptTile(data, 'Spanish').latest.rung, 4,
    'Spanish still sees its slice after CSR\'s pass consumed the same array');
  assert.equal(deptTile(data, 'Spanish').latest.missed, 1);
});

test('E2E: trend series carries the latest day for both modes (the axis the tiles spark from)', function () {
  install({});
  const off = h.call('getCompanyOverview', {});
  const offCsr = deptTile(off, 'CSR');
  assert.ok(Array.isArray(offCsr.trend) && offCsr.trend.length > 0, '30-day sparkline present');

  install({ queueScope: 'dept' });
  const dept = h.call('getCompanyOverview', {});
  assert.ok(Array.isArray(deptTile(dept, 'CSR').trend), 'sparkline present when narrowed');
});

// ── R50: the card Window selector's 60- and 90-day periods ─────────────────
//
// THE RULE: `periods` carries a bucket per Window option, each an INCLUSIVE
// N-day window ending on the latest date -- so `last60` spans latest-59d..
// latest, exactly like `last30` spans latest-29d. The boundary is the part
// worth driving: an off-by-one here is invisible (every figure still looks
// plausible) and would make the cards disagree with the chart by one day,
// which is the divergence R50 exists to close.

const R50_ROWS = function () {
  return [
    dalRow({ agent: 'Bob', date: '2026-07-20', r: 10, m: 0, a: 10 }),  // latest
    dalRow({ agent: 'Bob', date: '2026-06-05', r: 100, m: 0, a: 100 }), // -45d: in 60/90/ytd
    dalRow({ agent: 'Bob', date: '2026-05-22', r: 1000, m: 0, a: 1000 }), // -59d: the last60 EDGE
    dalRow({ agent: 'Bob', date: '2026-05-21', r: 10000, m: 0, a: 10000 }), // -60d: out of last60
    dalRow({ agent: 'Bob', date: '2026-04-22', r: 100000, m: 0, a: 100000 }), // -89d: the last90 EDGE
    dalRow({ agent: 'Bob', date: '2026-04-21', r: 1000000, m: 0, a: 1000000 }), // -90d: out of last90
  ];
};

test('R50: each period is an INCLUSIVE N-day window ending on the latest date', function () {
  install({ rows: R50_ROWS });
  const p = deptTile(h.call('getCompanyOverview', {}), 'CSR').periods;
  // Powers of ten, so the sum NAMES exactly which days landed in each bucket.
  assert.equal(p.yesterday.rung, 10,      'yesterday = the latest day alone');
  assert.equal(p.last30.rung,    10,      'last30 = latest only (nothing else is within 29d)');
  assert.equal(p.last60.rung,    1110,    'last60 includes the -59d EDGE day, excludes -60d');
  assert.equal(p.last90.rung,    111110,  'last90 includes the -89d EDGE day, excludes -90d');
  assert.equal(p.ytd.rung,       1111110, 'ytd takes every row (all in the same year)');
});

test('R50: the new periods carry the same shape as the old ones', function () {
  install({ rows: R50_ROWS });
  const p = deptTile(h.call('getCompanyOverview', {}), 'CSR').periods;
  Object.keys(plain_(p)).forEach(function (k) {
    ['rung', 'missed', 'answered', 'pctFormatted', 'attFormatted'].forEach(function (f) {
      assert.ok(Object.prototype.hasOwnProperty.call(p[k], f),
        'period ' + k + ' is missing ' + f + ' -- the card renderer reads every one');
    });
  });
});

test('R50: every Window option the client offers has a bucket here', function () {
  install({ rows: R50_ROWS });
  const p = deptTile(h.call('getCompanyOverview', {}), 'CSR').periods;
  ['yesterday', 'last30', 'last60', 'last90', 'ytd'].forEach(function (k) {
    assert.ok(p[k], 'no `' + k + '` period -- that Window silently renders ONE day');
  });
});

function plain_(o) { return Object.assign({}, o); }

// DD-2 (broad-scan 2026-09-17): the Overview trend series carries `missed` and
// rates through answerRatePct_, so the chart line follows ANSWER_RATE_FORMULA.
test('DD-2: ovDeptChartSeries_ rates follow the formula switch; an empty denominator breaks the line', function () {
  const labels = ['2026-09-01', '2026-09-02'];
  const daily = { '2026-09-01': { rung: 10, answered: 6, missed: 2 }, '2026-09-02': { rung: 0, answered: 0, missed: 0 } };
  h.ctx.ANSWER_RATE_FORMULA_MEMO_ = null;
  delete h.state.props.ANSWER_RATE_FORMULA;
  assert.deepEqual(h.call('ovDeptChartSeries_', labels, daily, {}).trend, [60, null]);
  try {
    h.state.props.ANSWER_RATE_FORMULA = 'answerable';
    h.ctx.ANSWER_RATE_FORMULA_MEMO_ = null;
    assert.deepEqual(h.call('ovDeptChartSeries_', labels, daily, {}).trend, [75, null]);
    assert.match(h.call('overviewCacheKey_'), /:rf-answerable$/, 'the blob key carries the formula');
  } finally {
    delete h.state.props.ANSWER_RATE_FORMULA;
    h.ctx.ANSWER_RATE_FORMULA_MEMO_ = null;
  }
});

// ---- D-5 (broad-scan 2026-09-17): a thrown QCD snapshot read never pins the Overview --

test('D-5: a QCD snapshot read that THROWS is served but never cached (no companyOverview put)', function () {
  install();
  h.ctx.QCD_SNAPSHOT_READ_FAILED_ = false;
  // install() stubs computeQcdSnapshots_ (QCDReport.gs is not loaded here);
  // emulate its real catch, which calls noteQcdSnapshotReadFailed_ -- the
  // wiring itself is pinned by source below and by compute-summary's D-5 test.
  h.ctx.computeQcdSnapshots_ = function () { h.ctx.noteQcdSnapshotReadFailed_('computeQcdSnapshots_', new Error('QCD sheet read exploded')); return {}; };
  try {
    const data = h.call('getCompanyOverview', {});
    assert.ok(data && data.depts && data.depts.length, 'the Overview still renders');
    assert.ok(!Array.from(h.state.cache.keys()).some(function (k) { return k.indexOf('companyOverview:') === 0; }),
      'a payload with no QCD chips / abandon series is never pinned for the 6 h TTL');
  } finally { h.ctx.QCD_SNAPSHOT_READ_FAILED_ = false; }
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'apps-script', 'department-dashboard', 'CompanyOverview.gs'), 'utf8');
  const catchIdx = src.indexOf("noteQcdSnapshotReadFailed_('computeQcdSnapshots_', e)");
  assert.ok(catchIdx > 0, 'the real computeQcdSnapshots_ catch notes the failure');
  assert.ok(/qcdSnapshotReadFailed_\(\)\) \{[^}]*skipping cache put/.test(src), 'getCompanyOverview gates its put on it');
  h.state.cache.clear();
  h.ctx.computeQcdSnapshots_ = function () { return {}; };   // the healthy stub install() uses
  h.call('getCompanyOverview', {});
  assert.ok(Array.from(h.state.cache.keys()).some(function (k) { return k.indexOf('companyOverview:') === 0; }),
    'control: a healthy snapshot path IS cached');
});

// THE CHART'S COMPANY LINE (owner request 2026-09-18). Two properties are
// worth pinning and neither is visible by eye on a chart: the rate is
// VOLUME-WEIGHTED (a mean of dept percentages would let a tiny queue swing the
// company number as hard as CSR), and each row is counted ONCE (summing the
// per-dept series would double-count every crossover agent -- Anna is on two
// rosters here, which is exactly the shape that would expose it).

test('chart company line: volume-weighted, NOT a mean of the dept percentages', function () {
  install({});
  const data = h.call('getCompanyOverview', {});
  const ca = data.companyAggregate;
  const idx = (data.chartTrendIsoLabels || []).indexOf(LATEST);
  assert.ok(idx >= 0, 'the latest date is on the chart axis');
  const company = ca.trendChart[idx];

  // Truth: Anna 10 rung / 7 answered / 3 missed + Bob 5 / 4 / 1, each ONCE.
  const csr = deptTile(data, 'CSR');
  const spa = deptTile(data, 'Spanish');
  const weighted = h.ctx.round1_(h.ctx.answerRatePct_(11, 4, 15));
  assert.equal(company, weighted, 'the company point is the weighted company rate');

  // And it is NOT the average of the two dept lines, which double-count Anna.
  const csrPt = csr.trendChart[idx], spaPt = spa.trendChart[idx];
  const mean = h.ctx.round1_((csrPt + spaPt) / 2);
  assert.notEqual(company, mean,
    'a mean of the dept points (' + csrPt + ', ' + spaPt + ' -> ' + mean + ') is a different number');
  // Sanity: the weighted value sits between the two dept rates, never outside.
  assert.ok(company <= Math.max(csrPt, spaPt) && company >= Math.min(csrPt, spaPt),
    'a weighted mean stays inside the dept range');
});

test('chart company line: the abandon arm is counted once per QUEUE row, not per dept', function () {
  // A queue listed by TWO depts (and a parent rolling up a child) would be
  // double-counted by any per-dept sum. computeQcdSnapshots_ returns the
  // company map alongside the per-dept ones for exactly that reason.
  install({});
  h.ctx.computeQcdSnapshots_ = function () {
    return {
      CSR:     { daily: { [LATEST]: { totalCalls: 100, abandoned: 10 } } },
      Spanish: { daily: { [LATEST]: { totalCalls: 100, abandoned: 10 } } },
      // The company map: ONE queue row, not the sum of the two tiles above.
      _companyDaily: { [LATEST]: { totalCalls: 100, abandoned: 10 } },
    };
  };
  const data = h.call('getCompanyOverview', {});
  const idx = (data.chartTrendIsoLabels || []).indexOf(LATEST);
  assert.equal(data.companyAggregate.trendChartAbandonedPct[idx], 10,
    '10/100 from the company map, not 20/200 or 10/200 from summing tiles');
});

test('chart company line: a day with no rows is null, so the line BREAKS rather than plotting a zero', function () {
  install({});
  const data = h.call('getCompanyOverview', {});
  const labels = data.chartTrendIsoLabels || [];
  const series = data.companyAggregate.trendChart;
  assert.equal(series.length, labels.length, 'aligned to the axis');
  const idx = labels.indexOf(LATEST);
  labels.forEach(function (iso, i) {
    if (i === idx) return;
    assert.equal(series[i], null, iso + ' has no rows -> null, never 0');
  });
});

test('chart company line: rides companyAggregate, so INV-39 strips it for a manager', function () {
  install({});
  const data = h.call('getCompanyOverview', {});
  assert.ok(data.companyAggregate.trendChart, 'admin sees it');
  // personalizeOverview_ deletes the whole object -- that is the point of
  // putting the series inside it rather than beside it.
  const mgr = h.ctx.personalizeOverview_(data, {
    email: 'm@x.com', role: 'manager', department: 'CSR', departments: ['CSR'], allDepts: false,
  });
  assert.equal(mgr.companyAggregate, undefined, 'a manager gets no company aggregate at all');
  // NB `trendChartAbandonedPct` is ALSO a per-DEPT field name, so searching
  // the whole payload for it proves nothing -- the company copy is identified
  // by its location, not its name. (An earlier draft of this assertion did
  // exactly that and failed on the legitimate dept series.)
  assert.ok((mgr.depts || []).every(function (d) { return Array.isArray(d.trendChartAbandonedPct); }),
    'the per-dept series are untouched -- only the company aggregate is stripped');
});

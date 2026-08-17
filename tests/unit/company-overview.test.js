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
  h.ctx.sheetFetchDqeRows_ = function () { return fixtureRows(); };
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

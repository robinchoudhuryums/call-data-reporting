'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// ovDqeSilence_ (CompanyOverview.gs): the Overview tile's queue-lens fallback
// detector. Over the trailing 7 chart days: DQE rings 0 while QCD calls > 0
// means the dept's agent view is blind while the queue keeps working (the
// Field Ops Power blind spot). Null = healthy = no badge.
const h = loadGas({ files: ['Config.gs', 'Util.gs', 'CompanyOverview.gs'] });

const L = ['2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07',
           '2026-08-08', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14'];
const call = (dqe, qcd, days) =>
  JSON.parse(JSON.stringify(h.call('ovDqeSilence_', L, dqe, qcd, days || 7) || null));

test('silent dept: zero rings + queue volume over the window -> the queue-lens payload', function () {
  const qcd = {};
  L.slice(-7).forEach(function (iso) { qcd[iso] = { totalCalls: 25, abandoned: 1 }; });
  const r = call({}, qcd);
  assert.deepEqual(r, { days: 7, qcdCalls: 175, qcdAbandoned: 7, qcdPct: 4 });
});

test('ANY ring in the window means healthy -- one answered call is proof the wiring works', function () {
  const qcd = { '2026-08-14': { totalCalls: 25, abandoned: 0 } };
  const dqe = { '2026-08-11': { rung: 1, answered: 1 } };
  assert.equal(call(dqe, qcd), null);
});

test('no queue volume either -> null (a genuinely idle dept is not "dark", it is idle)', function () {
  assert.equal(call({}, {}), null);
});

test('rings OUTSIDE the trailing window do not count as health', function () {
  // Activity 8 days ago with silence since is exactly the broken state.
  const dqe = { '2026-08-04': { rung: 40, answered: 36 } };   // outside slice(-7)
  const qcd = {};
  L.slice(-7).forEach(function (iso) { qcd[iso] = { totalCalls: 2, abandoned: 0 }; });
  const r = call(dqe, qcd);
  assert.ok(r, 'stale activity beyond the window must not mask current silence');
  assert.equal(r.qcdCalls, 14);
});

test('the abandoned % is computed from the window sums, rounded to 1dp', function () {
  const qcd = { '2026-08-13': { totalCalls: 7, abandoned: 1 },
                '2026-08-14': { totalCalls: 8, abandoned: 1 } };
  const r = call({}, qcd);
  assert.equal(r.qcdCalls, 15);
  assert.equal(r.qcdAbandoned, 2);
  assert.equal(r.qcdPct, 13.3);
});

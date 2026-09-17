'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadGas } = require('../harness/loadGas');

// DD-2 (broad-scan 2026-09-17): ONE answer-rate formula for every server
// surface, chosen by the ANSWER_RATE_FORMULA Script Property (Operator State
// #69): 'rung' (default -- answered / rung, today's behaviour) or 'answerable'
// (answered / (answered + missed), the H2 standard the My Department table,
// the agent app and team-tools already use). Plus the read-only probe that
// prints both rates per dept so the owner can flip with the gap known.

const h = loadGas({ files: ['Config.gs', 'Diagnostics.gs'] });
const DIR = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');

function setFormula(v) {
  h.state.props = h.state.props || {};
  if (v == null) delete h.state.props.ANSWER_RATE_FORMULA; else h.state.props.ANSWER_RATE_FORMULA = v;
  h.ctx.ANSWER_RATE_FORMULA_MEMO_ = null;
}

test('DD-2: the switch defaults to rung, accepts answerable case-insensitively, refuses garbage', function () {
  setFormula(null);
  assert.equal(h.call('getAnswerRateFormula_'), 'rung');
  setFormula('ANSWERABLE');
  assert.equal(h.call('getAnswerRateFormula_'), 'answerable');
  setFormula('bogus');
  assert.equal(h.call('getAnswerRateFormula_'), 'rung');
  // Memoized per execution: a property change without a memo reset is not seen.
  setFormula('answerable');
  assert.equal(h.call('getAnswerRateFormula_'), 'answerable');   // memoizes
  h.state.props.ANSWER_RATE_FORMULA = 'rung';
  assert.equal(h.call('getAnswerRateFormula_'), 'answerable', 'the memo holds until reset');
  setFormula(null);
});

test('DD-2: answerRatePct_ / answerRateDenom_ / answerRateCacheTag_ under both formulas', function () {
  // 10 legs rang; 6 answered, 2 missed, 2 neither (transferred / other).
  setFormula(null);
  assert.equal(h.call('answerRateDenom_', 6, 2, 10), 10);
  assert.equal(h.call('answerRatePct_', 6, 2, 10), 60);
  assert.equal(h.call('answerRateCacheTag_'), 'rf-rung');
  setFormula('answerable');
  assert.equal(h.call('answerRateDenom_', 6, 2, 10), 8);
  assert.equal(h.call('answerRatePct_', 6, 2, 10), 75);
  assert.equal(h.call('answerRateCacheTag_'), 'rf-answerable');
  // Empty denominators are 0, never NaN (the sites used to guard rung > 0 themselves).
  assert.equal(h.call('answerRatePct_', 0, 0, 0), 0);
  setFormula(null);
  assert.equal(h.call('answerRatePct_', 0, 0, 0), 0);
  assert.equal(h.call('answerRatePct_', '6', '2', '10'), 60, 'string inputs coerce');
});

test('DD-2 probe row: both rates, the neither-legs count, the worst agent, and the verdict flip', function () {
  const row = h.call('answerRateProbeRow_', 'CSR',
    { totalRung: 100, totalAnswered: 70, totalMissed: 20 },
    [{ agent: 'Anna', totalRung: 50, totalAnswered: 40, totalMissed: 5 },     // 80 -> 88.9 (+8.9)
     { agent: 'Ben',  totalRung: 50, totalAnswered: 30, totalMissed: 15 }],   // 60 -> 66.7 (+6.7)
    75);
  assert.equal(row.neither, 10);
  assert.equal(row.rateRung, 70);
  assert.equal(row.rateAnswerable, 77.8);
  assert.equal(row.deltaPts, 7.8);
  assert.equal(row.worstAgent.agent, 'Anna');
  assert.equal(row.worstAgent.deltaPts, 8.9);
  assert.equal(row.meetsTargetRung, false);
  assert.equal(row.meetsTargetAnswerable, true);
  assert.equal(row.verdictChanges, true, '70 misses a 75 target; 77.8 meets it');
  const same = h.call('answerRateProbeRow_', 'X', { totalRung: 10, totalAnswered: 6, totalMissed: 4 }, [], 50);
  assert.equal(same.deltaPts, 0, 'no neither-legs -> the formulas agree');
  assert.equal(same.verdictChanges, false);
  assert.equal(h.call('answerRateProbeRow_', 'X', {}, [], null).target, null);
});

test('DD-2 probe: admin-gated, defaults to 30 days ending yesterday, one row per dept, names the flips', function () {
  const seen = [];
  h.state.props = { ADMIN_EMAILS: 'admin@x.com' };
  h.ctx.assertAdmin_ = function () {};
  h.ctx.isIsoDate_ = function (s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); };
  h.ctx.getAllDepartments_ = function () { return ['CSR', 'Sales']; };
  h.ctx.getAnswerStandardFor_ = function (d) { return { target: d === 'CSR' ? 92 : 80, band: 2 }; };
  h.ctx.computeSummary_ = function (dept, from, to) {
    seen.push([dept, from, to]);
    return dept === 'CSR'
      ? { totals: { totalRung: 100, totalAnswered: 90, totalMissed: 5 }, rows: [] }    // 90 -> 94.7: flips at 92
      : { totals: { totalRung: 100, totalAnswered: 85, totalMissed: 15 }, rows: [] };  // 85 -> 85: same
  };
  h.ctx.logStatusReturn_ = function (o) { return o; };
  h.ctx.ANSWER_RATE_FORMULA_MEMO_ = null;
  const out = h.call('probeAnswerRateFormulas');
  assert.equal(out.active, 'rung');
  assert.equal(out.depts.length, 2);
  assert.equal(out.verdictChanges.join(','), 'CSR');
  assert.equal(out.maxDeltaPts, 4.7);
  assert.equal(seen[0][2] < seen[0][1] ? 'bad' : 'ok', 'ok');
  const days = (Date.parse(seen[0][2]) - Date.parse(seen[0][1])) / 86400000;
  assert.equal(days, 29, 'default window is 30 days inclusive');
  // Explicit window props are honoured; nothing is written or cleared (read-only).
  h.state.props.ANSWER_RATE_PROBE_FROM = '2026-08-01'; h.state.props.ANSWER_RATE_PROBE_TO = '2026-08-31';
  seen.length = 0;
  h.call('probeAnswerRateFormulas');
  assert.equal(seen[0].slice(1).join(','), '2026-08-01,2026-08-31');
  assert.equal(h.state.props.ANSWER_RATE_PROBE_FROM, '2026-08-01', 'params kept -- the probe is read-only');
  delete h.ctx.assertAdmin_; delete h.ctx.isIsoDate_; delete h.ctx.getAllDepartments_;
  delete h.ctx.getAnswerStandardFor_; delete h.ctx.computeSummary_; delete h.ctx.logStatusReturn_;
});

// The tripwire: no server surface computes its own answer rate any more.
// The ONLY `answered / ...rung` literals allowed are the helper (Config.gs) and
// the probe (Diagnostics.gs computes BOTH on purpose). The table (client) and
// the agent app are the H2 standard by construction and are pinned as such.
test('DD-2 tripwire: every server rate site routes through answerRatePct_; the four rate caches carry the tag', function () {
  const files = fs.readdirSync(DIR).filter(function (f) { return /\.gs$/.test(f); });
  const offenders = [];
  files.forEach(function (f) {
    if (f === 'Config.gs' || f === 'Diagnostics.gs') return;
    const text = fs.readFileSync(path.join(DIR, f), 'utf8');
    text.split('\n').forEach(function (ln, i) {
      if (/^\s*(\/\/|\*)/.test(ln)) return;   // comments may describe the old shape
      if (/answered\s*\/\s*[\w.]*rung\b/i.test(ln)) offenders.push(f + ':' + (i + 1));
    });
  });
  assert.deepEqual(offenders, [], 'a bare answered/rung rate outside the helper: ' + offenders.join(', '));
  [['IndividualReport.gs', 1], ['InsightsReport.gs', 1], ['CompanyOverview.gs', 2]].forEach(function (p) {
    const text = fs.readFileSync(path.join(DIR, p[0]), 'utf8');
    const n = (text.match(/answerRateCacheTag_\(\)/g) || []).length;
    assert.ok(n >= p[1], p[0] + ' cache key(s) carry answerRateCacheTag_ (' + n + ' < ' + p[1] + ')');
  });
  // The H2 standard on the two surfaces that were already there.
  assert.ok(/answered \/ \(answered \+ missed\)/.test(fs.readFileSync(path.join(DIR, 'script-5-dept.html'), 'utf8')),
    'the My Department table computes answered / (answered + missed)');
  assert.ok(/var denom = answered \+ missed;/.test(fs.readFileSync(path.join(DIR, 'AgentHome.gs'), 'utf8')),
    'the agent app computes answered / (answered + missed)');
});

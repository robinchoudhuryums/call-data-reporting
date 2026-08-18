'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../harness/loadGas');

// parseAnswerTargets_ / answerTargetsPropertyString_ are pure; getAnswerTargets_
// layers the ANSWER_TARGETS Script Property over the Config.gs seed default.
const h = loadGas({ files: ['Config.gs', 'Util.gs'] });

function freshTargets() {
  h.ctx.ANSWER_TARGETS_MEMO_ = null;   // reset the per-execution memo between tests
  return h.call('getAnswerTargets_');
}

test('answer targets: parser accepts key=value pairs, tolerant separators + trailing %', function () {
  const p = h.call('parseAnswerTargets_', 'global=90, direct = 80%\ninbound=85.55');
  assert.equal(p.global, 90);
  assert.equal(p.direct, 80);
  assert.equal(p.inbound, 85.6);   // one decimal max
});

test('answer targets: unknown keys and out-of-range values are silently dropped', function () {
  const p = h.call('parseAnswerTargets_', 'global=92, bogus=50, direct=0, inbound=101, dept=abc, =5, direct');
  assert.equal(p.global, 92);
  assert.equal(p.direct, undefined);    // 0 is out of range (1-100)
  assert.equal(p.inbound, undefined);   // 101 is out of range
  assert.equal(Object.keys(p).length, 1);
  assert.equal(Object.keys(h.call('parseAnswerTargets_', null)).length, 0);
});

test('answer targets: effective layering — global always present, surfaces only when set', function () {
  delete h.state.props.ANSWER_TARGETS;
  let eff = freshTargets();
  assert.equal(eff.global, 80, 'seed default when the property is unset (owner 2026-08: 92 -> 80)');
  assert.equal(eff.direct, undefined);

  h.state.props.ANSWER_TARGETS = 'direct=80';
  eff = freshTargets();
  assert.equal(eff.global, 80, 'global falls back to the seed when only a surface is set');
  assert.equal(eff.direct, 80);

  h.state.props.ANSWER_TARGETS = 'global=88, direct=80';
  eff = freshTargets();
  assert.equal(eff.global, 88);
  assert.equal(eff.direct, 80);
  delete h.state.props.ANSWER_TARGETS;
  h.ctx.ANSWER_TARGETS_MEMO_ = null;
});

test('answer targets: save canonicalizer builds the property string, blank = unset', function () {
  assert.equal(h.call('answerTargetsPropertyString_', { global: '92', direct: '80', inbound: '' }),
    'global=92, direct=80');
  assert.equal(h.call('answerTargetsPropertyString_', { global: '', direct: '', inbound: '' }),
    '', 'all-blank -> empty string (caller deletes the property)');
  assert.equal(h.call('answerTargetsPropertyString_', { direct: '80.55%' }),
    'direct=80.6', 'trailing % tolerated, one decimal kept');
});

test('answer targets: save canonicalizer THROWS loudly on invalid values (unlike the parser)', function () {
  assert.throws(function () { h.call('answerTargetsPropertyString_', { global: 'abc' }); }, /between 1 and 100/);
  assert.throws(function () { h.call('answerTargetsPropertyString_', { direct: '0' }); }, /between 1 and 100/);
  assert.throws(function () { h.call('answerTargetsPropertyString_', { inbound: '250' }); }, /between 1 and 100/);
});

// ── R23: amber band + per-dept overrides + transfer tiers ────────────────

function freshDeptTargets() {
  h.ctx.DEPT_ANSWER_TARGETS_MEMO_ = null;
  return h.call('getDeptAnswerTargets_');
}

test('R23 band: parser accepts band=N (0-50), effective layering defaults band to the seed 10', function () {
  const p = h.call('parseAnswerTargets_', 'global=85, band=6');
  assert.equal(p.band, 6);
  assert.equal(h.call('parseAnswerTargets_', 'band=99').band, undefined, 'out of range dropped');
  delete h.state.props.ANSWER_TARGETS;
  assert.equal(freshTargets().band, 10, 'seed amber band');
  h.state.props.ANSWER_TARGETS = 'band=4';
  assert.equal(freshTargets().band, 4);
  delete h.state.props.ANSWER_TARGETS;
  h.ctx.ANSWER_TARGETS_MEMO_ = null;
  assert.equal(h.call('answerTargetsPropertyString_', { global: '80', band: '6' }), 'global=80, band=6');
  assert.throws(function () { h.call('answerTargetsPropertyString_', { band: '70' }); }, /between 0 and 50/);
});

test('R23 dept targets: parser reads Dept=target/band; CSR seed 92/2 layers under the property', function () {
  const p = h.call('parseDeptAnswerTargets_', 'CSR=92/2, Sales = 85, Junk=abc, =5');
  assert.equal(p.CSR.target, 92);
  assert.equal(p.CSR.band, 2);
  assert.equal(p.Sales.target, 85);
  assert.equal(p.Sales.band, undefined, 'band optional');
  assert.equal(p.Junk, undefined, 'bad target drops the pair');

  delete h.state.props.DEPT_ANSWER_TARGETS;
  let eff = freshDeptTargets();
  assert.equal(eff.CSR.target, 92, 'seed override present with no property');
  assert.equal(eff.CSR.band, 2);

  h.state.props.DEPT_ANSWER_TARGETS = 'CSR=90/3, Spanish=75';
  eff = freshDeptTargets();
  assert.equal(eff.CSR.target, 90, 'property wins over the seed');
  assert.equal(eff.Spanish.target, 75);
  delete h.state.props.DEPT_ANSWER_TARGETS;
  h.ctx.DEPT_ANSWER_TARGETS_MEMO_ = null;
});

test('R23 getAnswerStandardFor_: CSR resolves 92/2, unknown dept gets global target + band', function () {
  delete h.state.props.ANSWER_TARGETS;
  delete h.state.props.DEPT_ANSWER_TARGETS;
  h.ctx.ANSWER_TARGETS_MEMO_ = null;
  h.ctx.DEPT_ANSWER_TARGETS_MEMO_ = null;
  const csr = h.call('getAnswerStandardFor_', 'CSR');
  assert.equal(csr.target, 92);
  assert.equal(csr.band, 2);
  const other = h.call('getAnswerStandardFor_', 'Sales');
  assert.equal(other.target, 80);
  assert.equal(other.band, 10);
  const none = h.call('getAnswerStandardFor_', null);
  assert.equal(none.target, 80);
});

test('R23 dept targets: save canonicalizer throws loudly on malformed tokens', function () {
  assert.equal(h.call('deptAnswerTargetsPropertyString_', ' CSR=92/2 ,Sales=85 '), 'CSR=92/2, Sales=85');
  assert.equal(h.call('deptAnswerTargetsPropertyString_', ''), '');
  assert.throws(function () { h.call('deptAnswerTargetsPropertyString_', 'CSR=junk'); }, /Could not read/);
});

test('R23 transfer tiers: seed 25/30/35, property override, canonicalizer enforces the ascending ladder', function () {
  delete h.state.props.TRANSFER_TIERS;
  h.ctx.TRANSFER_TIERS_MEMO_ = null;
  let t = h.call('getTransferTiers_');
  assert.equal(t.deep, 25); assert.equal(t.light, 30); assert.equal(t.amber, 35);

  h.state.props.TRANSFER_TIERS = 'deep=20, light=28, amber=33';
  h.ctx.TRANSFER_TIERS_MEMO_ = null;
  t = h.call('getTransferTiers_');
  assert.equal(t.deep, 20); assert.equal(t.amber, 33);
  delete h.state.props.TRANSFER_TIERS;
  h.ctx.TRANSFER_TIERS_MEMO_ = null;

  assert.equal(h.call('transferTiersPropertyString_', { deep: '25', light: '30', amber: '35' }),
    'deep=25, light=30, amber=35');
  assert.equal(h.call('transferTiersPropertyString_', {}), '', 'all-blank clears');
  assert.throws(function () { h.call('transferTiersPropertyString_', { deep: '30', light: '25', amber: '35' }); }, /ascend/);
  assert.throws(function () { h.call('transferTiersPropertyString_', { deep: '25' }); }, /all three/i);
});

test('R23 bundle: getStandardsBundle_ carries answer + depts + transfer + the abandon constant', function () {
  delete h.state.props.ANSWER_TARGETS;
  delete h.state.props.DEPT_ANSWER_TARGETS;
  delete h.state.props.TRANSFER_TIERS;
  h.ctx.ANSWER_TARGETS_MEMO_ = null;
  h.ctx.DEPT_ANSWER_TARGETS_MEMO_ = null;
  h.ctx.TRANSFER_TIERS_MEMO_ = null;
  const b = h.call('getStandardsBundle_');
  assert.equal(b.answer.global, 80);
  assert.equal(b.answer.band, 10);
  assert.equal(b.answer.depts.CSR.target, 92);
  assert.equal(b.transfer.light, 30);
  assert.equal(b.abandon, 4);
});

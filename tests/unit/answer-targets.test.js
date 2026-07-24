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
  assert.equal(eff.global, 92, 'seed default when the property is unset');
  assert.equal(eff.direct, undefined);

  h.state.props.ANSWER_TARGETS = 'direct=80';
  eff = freshTargets();
  assert.equal(eff.global, 92, 'global falls back to the seed when only a surface is set');
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

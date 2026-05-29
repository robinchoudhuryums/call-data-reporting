'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deepEqual } = require('node:assert'); // legacy: prototype-agnostic for cross-realm vm values
const crypto = require('crypto');
const { loadGas } = require('../harness/loadGas');

const h = loadGas({ files: ['Config.gs', 'Util.gs', 'Data.gs'] });

function nodeMd5(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

test('hashAgents_ is order-insensitive (INV-36)', function () {
  assert.equal(h.call('hashAgents_', ['Bob', 'Alice']), h.call('hashAgents_', ['Alice', 'Bob']));
});

test('hashAgents_ returns a 32-char lowercase hex digest', function () {
  const hex = h.call('hashAgents_', ['Alice', 'Bob', 'Carol']);
  assert.match(hex, /^[0-9a-f]{32}$/);
});

test('hashAgents_ matches a real MD5 of the sorted, pipe-joined list', function () {
  assert.equal(h.call('hashAgents_', ['Bob', 'Alice']), nodeMd5('Alice|Bob'));
  assert.equal(h.call('hashAgents_', ['Carol', 'Alice', 'Bob']), nodeMd5('Alice|Bob|Carol'));
});

test('hashAgents_ handles empty / missing input (bounded key, INV-36)', function () {
  assert.equal(h.call('hashAgents_', []), nodeMd5(''));
  assert.equal(h.call('hashAgents_', null), nodeMd5(''));
  assert.equal(h.call('hashAgents_', undefined), nodeMd5(''));
});

test('hashAgents_ keeps the key bounded for a large selection', function () {
  const big = [];
  for (let i = 0; i < 200; i++) big.push('Agent Name Number ' + i);
  const hex = h.call('hashAgents_', big);
  assert.equal(hex.length, 32);   // never grows with selection size
});

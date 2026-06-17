'use strict';

// classifyAbandonedCell_ (Util.gs) is the READ-side guard for the abandoned
// ID/time cells (cols AD/AE/AF) that the Sheets number-coercion bug corrupted.
// It must NEVER let a coerced/lost value be split-and-counted as real call IDs
// (which would over-count abandons + render garbage badges in the Missed Calls
// report), while still passing correct values through untouched and recovering
// lossless single-value coercions. This pins that contract -- the same shape
// cdr-report's sanitizeAbandonedCellForNeon_ mirrors on the write side.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deepEqual } = require('node:assert'); // legacy: prototype-agnostic for cross-realm vm values
const { loadGas } = require('../harness/loadGas');

const h = loadGas({ files: ['Config.gs', 'Util.gs'], capture: ['DQE_ABANDONED_LOST_SENTINEL'] });

function classify(raw) { return h.call('classifyAbandonedCell_', raw); }

test('classifyAbandonedCell_: correct values pass through untouched', function () {
  // Empty = genuinely "0 abandoned".
  deepEqual(classify(''),   { lost: false, value: '' });
  deepEqual(classify(null), { lost: false, value: '' });
  // A single long ID and a comma-list of long IDs are the valid shapes.
  deepEqual(classify('1762242202191'),
    { lost: false, value: '1762242202191' });
  deepEqual(classify('1762242202191,1762242165529'),
    { lost: false, value: '1762242202191,1762242165529' });
  deepEqual(classify('1762242202191,1762242165529,1762242100000'),
    { lost: false, value: '1762242202191,1762242165529,1762242100000' });
});

test('classifyAbandonedCell_: lossless single-value coercion is recovered', function () {
  // "1,762,242,202,191" (13 digits, <= 2^53) -> separators stripped, kept.
  deepEqual(classify('1,762,242,202,191'),
    { lost: false, value: '1762242202191' });
});

test('classifyAbandonedCell_: genuinely-lost multi-value coercions are flagged, never counted', function () {
  // The exact corrupt example from the field (thousands-separated, > 2^53).
  deepEqual(classify('17,622,419,789,481,700,000,000,000'),
    { lost: true, value: '' });
  // Scientific-notation display of the same coercion.
  deepEqual(classify('1.7622421978948E+24'), { lost: true, value: '' });
  // Bare digit run too long to be one real ID.
  deepEqual(classify('17622419789481700000000000'), { lost: true, value: '' });
});

test('classifyAbandonedCell_: the lost sentinel is recognized and excluded', function () {
  const sentinel = h.consts.DQE_ABANDONED_LOST_SENTINEL;
  assert.equal(sentinel, '#REBUILD', 'sentinel constant value');
  deepEqual(classify(sentinel), { lost: true, value: '' });
});

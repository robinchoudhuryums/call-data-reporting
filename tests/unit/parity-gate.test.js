'use strict';

// ST3 (broad-scan 259, E2): ONE compare gate for every key-by-key flip gate.
// parityGate_ (Util.gs) owns the three rules the known-issues standard asks of
// a flip gate -- duplicates fail by name, `compared` counts the keys on BOTH
// sides, and an empty sheet side is INCONCLUSIVE (never clean) -- and every
// gate reaches its verdict through it: compareDqeSources_, compareQcdSources_
// and, via configSourceCompare_, the three CONFIG_SOURCE compares. The sweep
// at the bottom fails when a NEW compare*Sources gate skips the helper, which
// is how each of the old holes got in (DL-1, QO-3, F42, Batch 6: one gate at a
// time re-learning the same rule).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadGas } = require('../harness/loadGas');

const DASH = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');
const h = loadGas({ files: ['Config.gs', 'Util.gs'] });
const J = function (x) { return JSON.parse(JSON.stringify(x)); };   // vm objects are another realm's
const gate = function (s, n, o) { return J(h.call('parityGate_', s, n, o)); };

test('ST3: matching sides are clean, and `compared` counts the keys on BOTH sides', function () {
  const g = gate([['a', 1], ['b', 2]], [['a', 1], ['b', 2]]);
  assert.equal(g.clean, true);
  assert.equal(g.inconclusive, false);
  assert.equal(g.compared, 2);
  const partial = gate([['a', 1], ['b', 2]], [['a', 1], ['c', 3]]);
  assert.equal(partial.compared, 1, 'only "a" is on both sides');
  assert.deepEqual(partial.missingInNeon, ['b']);
  assert.deepEqual(partial.extraInNeon, ['c']);
  assert.equal(partial.clean, false);
});

test('ST3: a duplicate key on EITHER side fails by name, and the FIRST occurrence is the one compared', function () {
  const s = gate([['a', 1], ['a', 9]], [['a', 1]]);
  assert.deepEqual(s.duplicates, ['a (sheet x2)']);
  assert.equal(s.clean, false);
  assert.deepEqual(s.mismatched, [], 'first sheet row (1) matches Neon (1)');
  const n = gate([['a', 1]], [['a', 1], ['a', 1]]);
  assert.deepEqual(n.duplicates, ['a (neon x2)']);
  assert.equal(n.clean, false);
});

test('ST3: an empty sheet side is INCONCLUSIVE -- never clean -- unless the caller opts into emptyMeans:clean', function () {
  const e = gate([], []);
  assert.equal(e.inconclusive, true);
  assert.equal(e.clean, false);
  const extra = gate([], [['x', 1]]);
  assert.equal(extra.inconclusive, true);
  assert.deepEqual(extra.extraInNeon, ['x'], 'the extras are still reported');
  const cfg = gate([], [], { emptyMeans: 'clean' });
  assert.equal(cfg.clean, true, 'config gates: reachable empty-vs-empty serves the same seeds');
  assert.equal(cfg.inconclusive, false);
  assert.equal(gate([], [['x', 1]], { emptyMeans: 'clean' }).clean, false, 'emptyMeans:clean still fails a one-sided key');
});

test('ST3: a diff function names the differing fields; rounding-only keys are counted, not failed', function () {
  const diff = function (s, n) {
    const out = [];
    if (s.n !== n.n) out.push('n sheet=' + s.n + ' neon=' + n.n);
    return { diffs: out, rounding: Math.abs(s.t - n.t) === 1 };
  };
  const g = h.call('parityGate_', [['a', { n: 1, t: 20 }], ['b', { n: 2, t: 5 }]],
    [['a', { n: 1, t: 21 }], ['b', { n: 3, t: 5 }]], { diff: diff });
  assert.deepEqual(J(g.mismatched), ['b :: n sheet=2 neon=3']);
  assert.deepEqual(J(g.mismatchedKeys), ['b']);
  assert.equal(g.roundingOnly, 1);
  assert.equal(g.clean, false);
  const ok = h.call('parityGate_', [['a', { n: 1, t: 20 }]], [['a', { n: 1, t: 21 }]], { diff: diff });
  assert.equal(ok.clean, true, 'a rounding-only difference does not fail the gate');
});

test('ST3: configSourceCompare_ keeps its return shape on top of the shared gate', function () {
  const r = J(h.call('configSourceCompare_', 'test', [['csr', 'x'], ['sales', 'y']], [['csr', 'x'], ['pap', 'z']]));
  assert.deepEqual(Object.keys(r).sort(), ['clean', 'compared', 'duplicates', 'mismatched', 'missingInNeon', 'missingInSheet']);
  assert.deepEqual(r.missingInNeon, ['sales']);
  assert.deepEqual(r.missingInSheet, ['pap']);
  assert.equal(r.compared, 1);
});

test('ST3 sweep: every key-by-key flip gate reaches its verdict through parityGate_', function () {
  const files = fs.readdirSync(DASH).filter(function (f) { return /\.gs$/.test(f); });
  const bodyOf = function (src, name) {
    const start = src.indexOf('function ' + name + '(');
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    return '';
  };
  const gates = [];
  files.forEach(function (f) {
    const src = fs.readFileSync(path.join(DASH, f), 'utf8');
    const re = /^function (compare\w*Sources_?)\(/gm;
    let m;
    while ((m = re.exec(src)) !== null) {
      const body = bodyOf(src, m[1]);
      gates.push(m[1]);
      assert.ok(/\b(parityGate_|configSourceCompare_)\(/.test(body),
        f + '::' + m[1] + ' is a compare gate that does not reach its verdict through parityGate_ '
        + '(directly, or via configSourceCompare_) -- it would re-learn the duplicate / compared / '
        + 'empty-is-INCONCLUSIVE rules on its own.');
    }
  });
  assert.deepEqual(gates.sort(), ['compareAlertConfigSources', 'compareDeptConfigSources',
    'compareDigestConfigSources', 'compareDqeSources_', 'compareQcdSources_'],
    'the gate inventory changed -- check the new one routes through parityGate_, then update this list');
  const util = fs.readFileSync(path.join(DASH, 'Util.gs'), 'utf8');
  assert.match(bodyOf(util, 'configSourceCompare_'), /parityGate_\(/, 'the config shim itself uses the gate');
});

'use strict';

// The cdr-import project's Script Property registry
// (propRegistry.js::CDR_IMPORT_PROP_REGISTRY_) -- the sibling of the
// dashboard's prop-registry.test.js. The registry is kept true BOTH ways:
//   S1 (forward): every property-key literal the project's .js files pass to
//       get/set/deleteProperty is registered (a typo of a real key must show
//       as UNRECOGNIZED, never default silently);
//   S2 (reverse): every registered key is still referenced by code (a dead
//       entry would hide a genuinely-orphaned stored key forever).
// Plus: the secret set covers the credential keys, and the lister never
// takes a value.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadGas } = require('../harness/loadGas');

const DIR = path.join(__dirname, '..', '..', 'apps-script', 'cdr-import');
const h = loadGas({ project: 'cdr-import', files: ['propRegistry.js'] });

function sweepPropKeys() {
  const files = fs.readdirSync(DIR).filter(function (n) { return n.endsWith('.js'); });
  const literals = new Map();
  const idents = new Set();
  const sources = {};
  files.forEach(function (f) {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8');
    sources[f] = src;
    src.split('\n').forEach(function (ln, i) {
      let m;
      const reLit = /(?:getProperty|setProperty|deleteProperty)\(\s*['"]([A-Za-z0-9_]+)['"]\s*[,)]/g;
      while ((m = reLit.exec(ln)) !== null) if (!literals.has(m[1])) literals.set(m[1], f + ':' + (i + 1));
      const reId = /(?:getProperty|setProperty|deleteProperty)\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,)]/g;
      while ((m = reId.exec(ln)) !== null) idents.add(m[1]);
    });
  });
  idents.forEach(function (id) {
    for (const f of files) {
      const m = new RegExp("(?:var|const|let)\\s+" + id + "\\s*=\\s*['\"]([A-Za-z0-9_]+)['\"]").exec(sources[f]);
      if (m) { if (!literals.has(m[1])) literals.set(m[1], f + ' (via ' + id + ')'); return; }
    }
  });
  return literals;
}

test('S1 forward: every property key the cdr-import code references is registered', function () {
  const swept = sweepPropKeys();
  assert.ok(swept.size >= 20, 'the sweep sees the project (' + swept.size + ' keys)');
  const unregistered = [];
  swept.forEach(function (at, key) {
    if (!h.call('cdrImportPropRegistryGroup_', key)) unregistered.push(key + ' @ ' + at);
  });
  assert.deepEqual(unregistered, [], 'register these in propRegistry.js (same commit as the code that reads them)');
});

test('S2 reverse: every registered key is still referenced by code', function () {
  const swept = sweepPropKeys();
  const dead = Object.keys(h.ctx.CDR_IMPORT_PROP_REGISTRY_.exact).filter(function (k) { return !swept.has(k); });
  assert.deepEqual(dead, [], 'retire these from propRegistry.js -- nothing reads or writes them');
});

test('secrets are registered as operator keys and the classifier never touches values', function () {
  const reg = h.ctx.CDR_IMPORT_PROP_REGISTRY_;
  Object.keys(reg.secret).forEach(function (k) { assert.equal(reg.exact[k], 'operator', k); });
  const c = h.call('classifyCdrImportProps_', ['NEON_PASS', 'bulkIndex', 'SAMPLE_QUEUE', 'NEON_MIROR_MODE']);
  assert.equal(c.unrecognized.join(','), 'NEON_MIROR_MODE', 'a typo of a real key is flagged, never defaulted silently');
  assert.equal(c.operator.join(','), 'NEON_PASS');
  assert.equal(c.engine.join(','), 'bulkIndex');
  assert.equal(c.tool.join(','), 'SAMPLE_QUEUE');
  h.state.props.NEON_PASS = 'hunter2';
  h.state.props.bulkIndex = '3';
  const logs = [];
  const real = h.ctx.Logger.log;
  h.ctx.Logger.log = function (s) { logs.push(String(s)); };
  try { h.call('listCdrImportScriptProperties'); } finally { h.ctx.Logger.log = real; delete h.state.props.NEON_PASS; delete h.state.props.bulkIndex; }
  assert.ok(logs.length === 1 && logs[0].indexOf('hunter2') === -1, 'the lister names keys only');
  assert.match(logs[0], /engine   \(1\): bulkIndex/);
});

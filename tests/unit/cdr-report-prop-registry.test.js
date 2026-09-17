'use strict';

// The cdr-report project's Script Property registry
// (propRegistry.js::CDR_REPORT_PROP_REGISTRY_), kept true both ways like the
// dashboard's prop-registry suite and cdr-import's. Two project-specific
// shapes the sweep must see: the backfill resume helpers take the KEY as an
// argument (`nbResumeRead_(props, 'DQE_UPSERT_RESUME', …)`), and several keys
// are declared as `var` constants -- `RESUME_KEY` is declared TWICE with
// different values, so every declaration of an identifier counts.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadGas } = require('../harness/loadGas');

const DIR = path.join(__dirname, '..', '..', 'apps-script', 'cdr-report');
const h = loadGas({ project: 'cdr-report', files: ['propRegistry.js'] });

function sweepPropKeys() {
  const files = fs.readdirSync(DIR).filter(function (n) { return n.endsWith('.js'); });
  const literals = new Map();
  const idents = new Set();
  const sources = {};
  const CALL = '(?:getProperty|setProperty|deleteProperty|nbResumeRead_|nbResumeWrite_)\\(\\s*(?:props\\s*,\\s*)?';
  files.forEach(function (f) {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8');
    sources[f] = src;
    src.split('\n').forEach(function (ln, i) {
      let m;
      const reLit = new RegExp(CALL + "['\"]([A-Za-z0-9_]+)['\"]\\s*[,)]", 'g');
      while ((m = reLit.exec(ln)) !== null) if (!literals.has(m[1])) literals.set(m[1], f + ':' + (i + 1));
      const reId = new RegExp(CALL + '([A-Za-z_][A-Za-z0-9_]*)\\s*[,)]', 'g');
      while ((m = reId.exec(ln)) !== null) if (m[1] !== 'props') idents.add(m[1]);
    });
  });
  idents.forEach(function (id) {
    for (const f of files) {
      const re = new RegExp("(?:var|const|let)\\s+" + id + "\\s*=\\s*['\"]([A-Za-z0-9_]+)['\"]", 'g');
      let m;
      while ((m = re.exec(sources[f])) !== null) if (!literals.has(m[1])) literals.set(m[1], f + ' (via ' + id + ')');
    }
  });
  // The nightly sort's resume-pointer list names keys as array literals.
  const sr = /HISTORICAL_SORT_RESUME_PROPS_\s*=\s*\[([^\]]*)\]/.exec(sources['sheetRepairs.js'] || '');
  if (sr) sr[1].replace(/['"]([A-Za-z0-9_]+)['"]/g, function (_, k) { if (!literals.has(k)) literals.set(k, 'sheetRepairs.js (HISTORICAL_SORT_RESUME_PROPS_)'); return _; });
  return literals;
}

test('S1 forward: every property key the cdr-report code references is registered', function () {
  const swept = sweepPropKeys();
  assert.ok(swept.size >= 20, 'the sweep sees the project (' + swept.size + ' keys)');
  const unregistered = [];
  swept.forEach(function (at, key) {
    if (!h.call('cdrReportPropRegistryGroup_', key)) unregistered.push(key + ' @ ' + at);
  });
  assert.deepEqual(unregistered, [], 'register these in cdr-report/propRegistry.js (same commit as the code that reads them)');
});

test('S2 reverse: every registered key is still referenced by code', function () {
  const swept = sweepPropKeys();
  const dead = Object.keys(h.ctx.CDR_REPORT_PROP_REGISTRY_.exact).filter(function (k) { return !swept.has(k); });
  assert.deepEqual(dead, [], 'retire these from cdr-report/propRegistry.js -- nothing reads or writes them');
});

test('the sweep sees both RESUME_KEY declarations and the resume-helper literals', function () {
  const swept = sweepPropKeys();
  ['CDR_PHONES_BACKFILL_RESUME', 'CDR_MISSING_BACKFILL_RESUME', 'QCD_BACKFILL_RESUME', 'NEON_EGRESS_MTD', 'HR_BACKUP_SS_ID', 'HISTORICAL_SORT_ENABLED']
    .forEach(function (k) { assert.ok(swept.has(k), k + ' is swept'); });
});

test('secrets are registered as operator keys and the lister never touches values', function () {
  const reg = h.ctx.CDR_REPORT_PROP_REGISTRY_;
  Object.keys(reg.secret).forEach(function (k) { assert.equal(reg.exact[k], 'operator', k); });
  const c = h.call('classifyCdrReportProps_', ['HMAC_SECRET', 'DQE_UPSERT_LAST', 'QUEUE_OVERLAP_DATE', 'DQE_UPSERT_RESUM']);
  assert.equal(c.unrecognized.join(','), 'DQE_UPSERT_RESUM', 'a typo of a real key is flagged, never defaulted silently');
  assert.equal(c.operator.join(','), 'HMAC_SECRET');
  assert.equal(c.engine.join(','), 'DQE_UPSERT_LAST');
  assert.equal(c.tool.join(','), 'QUEUE_OVERLAP_DATE');
  h.state.props.HMAC_SECRET = 'hunter2';
  const logs = [];
  const real = h.ctx.Logger.log;
  h.ctx.Logger.log = function (s) { logs.push(String(s)); };
  try { h.call('listCdrReportScriptProperties'); } finally { h.ctx.Logger.log = real; delete h.state.props.HMAC_SECRET; }
  assert.ok(logs.length === 1 && logs[0].indexOf('hunter2') === -1, 'keys only');
});

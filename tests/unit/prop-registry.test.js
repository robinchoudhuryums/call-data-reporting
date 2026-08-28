'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadGas } = require('../harness/loadGas');

// ── Script Property registry (Config.gs::PROP_REGISTRY_) ───────────────────
//
// The dashboard's property store holds ~90 keys — past the settings page's
// 50-row display cap — so the registry + the Health page's inventory section
// are the only complete view. This suite is the C2 enforcement that keeps the
// registry true BOTH ways:
//   S1 (forward): every property-key literal, resolvable constant, and
//       composed 'PREFIX' + expr in the dashboard .gs files must classify via
//       propRegistryGroup_ — an unregistered key would render as a false
//       "unrecognized" warn on the Health page for a key the code itself uses.
//   S2 (reverse): every registry entry must still be referenced by code — a
//       dead entry would hide a genuinely-orphaned stored key forever.
// Plus: the secret set covers the credential keys, and the Health payload
// never carries a secret's VALUE.

const DIR = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');

const h = loadGas({ files: ['Config.gs'] });

/**
 * Sweep every dashboard .gs for property-key references:
 *  - literals:   getProperty('KEY') / setProperty('KEY', / deleteProperty('KEY')
 *  - prefixes:   the same calls with 'PREFIX' + expr as the key argument
 *  - constants:  calls with an IDENT argument whose declaration is
 *                `var|const|let IDENT = 'VALUE'` (a trailing ` + ` makes it a
 *                prefix, e.g. `var markerKey = 'DIGEST_RUN_MARKER_' + cadence`)
 * Identifier args with no such declaration (loop vars, params) are ignored —
 * the values they carry are the registered literals they were called with.
 */
function sweepPropKeys() {
  const files = fs.readdirSync(DIR).filter(function (n) { return n.endsWith('.gs'); });
  const literals = new Map();   // key -> first "file:line"
  const prefixes = new Map();   // prefix -> first "file:line"
  const idents = new Set();
  const sources = {};
  files.forEach(function (f) {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8');
    sources[f] = src;
    src.split('\n').forEach(function (ln, i) {
      const at = f + ':' + (i + 1);
      let m;
      const reLit = /(?:getProperty|setProperty|deleteProperty)\(\s*'([A-Z0-9_]+)'\s*([,)+])/g;
      while ((m = reLit.exec(ln)) !== null) {
        const bucket = m[2] === '+' ? prefixes : literals;
        if (!bucket.has(m[1])) bucket.set(m[1], at);
      }
      const reId = /(?:getProperty|setProperty|deleteProperty)\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,)]/g;
      while ((m = reId.exec(ln)) !== null) idents.add(m[1]);
    });
  });
  // Resolve identifier args across all files.
  idents.forEach(function (id) {
    for (const f of files) {
      const m = new RegExp("(?:var|const|let)\\s+" + id + "\\s*=\\s*'([A-Z0-9_]+)'\\s*(\\+?)").exec(sources[f]);
      if (m) {
        const bucket = m[2] === '+' ? prefixes : literals;
        if (!bucket.has(m[1])) bucket.set(m[1], f + ' (via ' + id + ')');
        return;
      }
    }
    // No declaration found -> a passthrough parameter; its callers pass
    // registered literals, which the literal sweep already covers.
  });
  return { literals: literals, prefixes: prefixes };
}

test('S1 forward: every property key the dashboard code references is registered', function () {
  const swept = sweepPropKeys();
  const unregistered = [];
  swept.literals.forEach(function (at, key) {
    if (!h.call('propRegistryGroup_', key)) unregistered.push(key + ' @ ' + at);
  });
  swept.prefixes.forEach(function (at, pfx) {
    // A composed key classifies when the swept prefix starts with (or equals)
    // a registered prefix — probe with a synthetic suffix.
    if (!h.call('propRegistryGroup_', pfx + 'X')) unregistered.push(pfx + '* @ ' + at);
  });
  assert.deepEqual(unregistered, [],
    'unregistered Script Property key(s) — add each to Config.gs PROP_REGISTRY_ in this commit '
    + '(else the Health inventory falsely flags a code-owned key as unrecognized): '
    + unregistered.join('; '));
});

test('S2 reverse: every registry entry is still referenced by code (no dead entries)', function () {
  const swept = sweepPropKeys();
  const reg = h.ctx.PROP_REGISTRY_;
  const dead = [];
  Object.keys(reg.exact).forEach(function (key) {
    if (!swept.literals.has(key)) dead.push(key);
  });
  Object.keys(reg.prefix).forEach(function (pfx) {
    if (!swept.prefixes.has(pfx)) dead.push(pfx + '*');
  });
  assert.deepEqual(dead, [],
    'registry entries no longer referenced by any dashboard .gs — remove them '
    + '(and consider whether the stored key itself should be deleted): ' + dead.join(', '));
});

test('classifier: exact wins, prefixes cover dynamic families, unknown -> null', function () {
  assert.equal(h.call('propRegistryGroup_', 'DQE_READ_SOURCE'), 'operator');
  assert.equal(h.call('propRegistryGroup_', 'SMOKE_LAST'), 'engine');
  assert.equal(h.call('propRegistryGroup_', 'DQE_PARITY_FROM'), 'tool');
  assert.equal(h.call('propRegistryGroup_', 'ESC_SNAPSHOT_3'), 'engine');
  assert.equal(h.call('propRegistryGroup_', 'ESC_SNAPSHOT_META'), 'engine');
  assert.equal(h.call('propRegistryGroup_', 'DIGEST_RUN_MARKER_weekly'), 'engine');
  assert.equal(h.call('propRegistryGroup_', 'DIGEST_LAST_RESULT_daily'), 'engine');
  assert.equal(h.call('propRegistryGroup_', 'SOME_OLD_LEFTOVER'), null);
  assert.equal(h.call('propRegistryGroup_', ''), null);
});

test('secrets: the credential keys are flagged secret AND registered', function () {
  const reg = h.ctx.PROP_REGISTRY_;
  ['NEON_PASS', 'HMAC_SECRET'].forEach(function (k) {
    assert.equal(reg.secret[k], true, k + ' must be in PROP_REGISTRY_.secret');
    assert.ok(reg.exact[k], k + ' must also be registered exact');
  });
});

// ── Self-cleaning tool params ──────────────────────────────────────────────
// The parity wrappers clear their window props ONLY on a clean verdict —
// MISMATCH / INCONCLUSIVE keeps them for the fix-and-re-run loop.

const h2 = loadGas({ files: ['Config.gs', 'Util.gs', 'Auth.gs', 'NeonRead.gs', 'QCDReport.gs'] });

function installTool2_() {
  h2.state.userEmail = 'admin@x.com';
  h2.state.props = {
    ADMIN_EMAILS: 'admin@x.com',
    DQE_PARITY_FROM: '2026-08-01', DQE_PARITY_TO: '2026-08-07',
    QCD_PARITY_FROM: '2026-08-01', QCD_PARITY_TO: '2026-08-07',
  };
}

test('clearToolParamsAfterCleanRun_: deletes only present keys; a property hiccup never throws', function () {
  installTool2_();
  h2.call('clearToolParamsAfterCleanRun_', ['DQE_PARITY_FROM', 'NOT_SET_KEY'], 'test');
  assert.ok(!('DQE_PARITY_FROM' in h2.state.props), 'present key deleted');
  assert.equal(h2.state.props.DQE_PARITY_TO, '2026-08-07', 'unlisted key untouched');
  assert.doesNotThrow(function () { h2.call('clearToolParamsAfterCleanRun_', null, 'test'); });
});

test('runDqeParityCheck / runQcdParityCheck: clean clears the window props; non-clean keeps them', function () {
  const realDqe = h2.ctx.compareDqeSources_;
  const realQcd = h2.ctx.compareQcdSources_;
  const realGate = h2.ctx.assertAdmin_;
  try {
    installTool2_();
    // resolveUser_ opens the spreadsheet for the Access Control lookup, which
    // this harness doesn't build — the gate itself is pinned in the auth
    // suites; here the subject is the wrappers' cleanup behavior.
    h2.ctx.assertAdmin_ = function () {};
    h2.ctx.compareDqeSources_ = function () { return { clean: false, mismatches: 2 }; };
    h2.ctx.compareQcdSources_ = function () { return { error: 'no sheet rows in range -- nothing compared' }; };
    h2.call('runDqeParityCheck');
    h2.call('runQcdParityCheck');
    assert.equal(h2.state.props.DQE_PARITY_FROM, '2026-08-01', 'MISMATCH keeps the DQE window');
    assert.equal(h2.state.props.QCD_PARITY_FROM, '2026-08-01', 'INCONCLUSIVE keeps the QCD window');
    h2.ctx.compareDqeSources_ = function () { return { clean: true, compared: 40 }; };
    h2.ctx.compareQcdSources_ = function () { return { clean: true, compared: 12 }; };
    const vd = h2.call('runDqeParityCheck');
    const vq = h2.call('runQcdParityCheck');
    assert.equal(vd.clean, true, 'the verdict still returns to the caller');
    assert.equal(vq.clean, true);
    ['DQE_PARITY_FROM', 'DQE_PARITY_TO', 'QCD_PARITY_FROM', 'QCD_PARITY_TO'].forEach(function (k) {
      assert.ok(!(k in h2.state.props), 'clean run clears ' + k);
    });
  } finally {
    h2.ctx.compareDqeSources_ = realDqe;   // vm-binding discipline: restore, never delete
    h2.ctx.compareQcdSources_ = realQcd;
    h2.ctx.assertAdmin_ = realGate;
  }
});

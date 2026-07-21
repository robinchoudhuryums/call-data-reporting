'use strict';

// R8-D1/D2 (audit 2026-07-21): cross-file tripwires for the scan's dominant
// defect class -- a fix or contract landing in one file while its sibling
// copy / consumer keeps the old value. The cache-version-sync suite proved
// the pattern (extract the CANONICAL value from code, never hardcode both
// sides); these pins extend it to:
//   D1 -- sheet-width constants shared across projects (the REP-10 / R8-2
//         regression: NeonMirror's DQE read kept 36 cols after the schema
//         was pinned at 34 elsewhere);
//   D2 -- the UI_FLAGS registry vs its CSS implementation (the R8-A1
//         regression: a registry key whose CSS rule targeted only a caption
//         element, so the "surface" never actually hid).
// Source-regex extraction is deliberate: these are tripwires, not behavior
// tests -- the behavioral coverage lives in neon-mirror-tail / dal-cutover.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DASH = path.join(ROOT, 'apps-script', 'department-dashboard');

function read(rel, base) { return fs.readFileSync(path.join(base || ROOT, rel), 'utf8'); }

// ---- canonical values, extracted from code (never hardcoded twice) ---------

const configGs = read('Config.gs', DASH);

const dqeColsM = /CSR_AVG_ABD_WAIT:\s*(\d+)/.exec(configGs);
assert.ok(dqeColsM, 'HISTORICAL_COLS.CSR_AVG_ABD_WAIT not found in Config.gs -- update this suite');
const DQE_COLS = Number(dqeColsM[1]);   // the last DQE column = the sheet width

const qcdColsM = /VIOLATIONS:\s*(\d+)/.exec(configGs);
assert.ok(qcdColsM, 'QCD_HISTORICAL_COLS.VIOLATIONS not found in Config.gs -- update this suite');
const QCD_COLS = Number(qcdColsM[1]);

// ---- D1: cross-project sheet-width pins -------------------------------------

test('R8-D1: NeonMirror\'s deferred DQE read width matches the DQE schema (REP-10 propagated)', function () {
  const nm = read('apps-script/cdr-import/NeonMirror.js');
  // mirrorDqeForDate_'s tail read: nmReadDateRowsTail_(sheet, <width>, 1, iso)
  const m = /function mirrorDqeForDate_[\s\S]*?nmReadDateRowsTail_\(sheet,\s*(\d+),\s*1/.exec(nm);
  assert.ok(m, 'mirrorDqeForDate_ read call not found -- was it renamed? Update this pin.');
  assert.equal(Number(m[1]), DQE_COLS,
    'DQE Historical Data is ' + DQE_COLS + ' cols (A-AH, INV-10); a wider read THROWS on a '
    + 'width-trimmed sheet (the REP-10 failure NeonMirror re-grew once already)');
});

test('R8-D1: NeonMirror\'s deferred QCD read width matches the QCD schema', function () {
  const nm = read('apps-script/cdr-import/NeonMirror.js');
  const m = /function mirrorQcdForDate_[\s\S]*?nmReadDateRowsTail_\(sheet,\s*(\d+),\s*2/.exec(nm);
  assert.ok(m, 'mirrorQcdForDate_ read call not found -- was it renamed? Update this pin.');
  assert.equal(Number(m[1]), QCD_COLS);
});

test('R8-D1: the duplicate-row merge repair reads the DQE schema width', function () {
  const sr = read('apps-script/cdr-report/sheetRepairs.js');
  const m = /function mergeDqeDuplicateRows_[\s\S]*?getRange\(2,\s*1,\s*lastRow\s*-\s*1,\s*(\d+)\)/.exec(sr);
  assert.ok(m, 'mergeDqeDuplicateRows_ read call not found -- update this pin.');
  assert.equal(Number(m[1]), DQE_COLS);
});

// ---- D2: UI_FLAGS registry <-> CSS <-> markup parity ------------------------

test('R8-D2: every UI_FLAG_SURFACES key has a CSS hide rule whose targets exist in the markup', function () {
  const keysM = /const UI_FLAG_SURFACES = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(configGs);
  assert.ok(keysM, 'UI_FLAG_SURFACES not found in Config.gs -- update this suite');
  const keys = [];
  keysM[1].replace(/'([a-z0-9-]+)':/g, function (_, k) { keys.push(k); return _; });
  assert.ok(keys.length >= 5, 'suspiciously few registry keys parsed: ' + keys.join(','));

  const styles = read('styles.html', DASH);
  const dashboard = read('dashboard.html', DASH);
  const script = read('script.html', DASH);

  keys.forEach(function (key) {
    // (1) A CSS rule exists for the key.
    const marker = 'body[data-ui-flags~="' + key + '"]';
    assert.ok(styles.indexOf(marker) !== -1,
      'registry key "' + key + '" has NO CSS hide rule in styles.html -- the '
      + 'Health-page toggle would silently do nothing (the R8-A1 class)');

    // (2) Every selector target the key's rules name actually exists in the
    // markup (an #id in dashboard.html; a .class in the markup OR built by
    // script.html), so the rule can't be hiding a stale/renamed element
    // while the real surface keeps rendering.
    const targets = [];
    const lineRe = new RegExp('body\\[data-ui-flags~="' + key + '"\\]\\s*([#.][\\w-]+)', 'g');
    let m2;
    while ((m2 = lineRe.exec(styles)) !== null) targets.push(m2[1]);
    assert.ok(targets.length > 0,
      'no selector target parsed for "' + key + '" -- selector shape changed? Update this pin.');
    targets.forEach(function (t) {
      if (t.charAt(0) === '#') {
        const id = t.slice(1);
        assert.ok(dashboard.indexOf('id="' + id + '"') !== -1 || script.indexOf("'" + id + "'") !== -1
          || script.indexOf('"' + id + '"') !== -1,
          'UI-flag "' + key + '" targets #' + id + ' but no such id exists in the markup/client');
      } else {
        const cls = t.slice(1);
        assert.ok(dashboard.indexOf(cls) !== -1 || script.indexOf(cls) !== -1,
          'UI-flag "' + key + '" targets .' + cls + ' but the class appears nowhere in the markup/client');
      }
    });
  });
});

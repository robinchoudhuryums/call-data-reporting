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

// The LAST DQE column is the sheet width. Sub-queue Phase 1 appended AI
// (QUEUE_SPLIT), so derive from that and fall back to CSR_AVG_ABD_WAIT -- an
// append is exactly what this pin exists to propagate.
const dqeColsM = /QUEUE_SPLIT:\s*(\d+)/.exec(configGs)
             || /CSR_AVG_ABD_WAIT:\s*(\d+)/.exec(configGs);
assert.ok(dqeColsM, 'HISTORICAL_COLS last column not found in Config.gs -- update this suite');
const DQE_COLS = Number(dqeColsM[1]);   // the last DQE column = the sheet width

const qcdColsM = /VIOLATIONS:\s*(\d+)/.exec(configGs);
assert.ok(qcdColsM, 'QCD_HISTORICAL_COLS.VIOLATIONS not found in Config.gs -- update this suite');
const QCD_COLS = Number(qcdColsM[1]);

// ---- D1: cross-project sheet-width pins -------------------------------------

test('R8-D1: NeonMirror\'s deferred DQE read width matches the DQE schema (REP-10 propagated)', function () {
  const nm = read('apps-script/cdr-import/NeonMirror.js');
  // mirrorDqeForDate_'s tail read: nmReadDateRowsTail_(sheet, <width>, 1, iso)
  // Since Phase 1 the read is Math.min(<schema width>, sheet.getMaxColumns()):
  // the schema grew to 35 but a sheet that has not been widened yet is still
  // 34, and a read past getMaxColumns THROWS (the REP-10 failure NeonMirror
  // re-grew once already). Pin the CEILING, and require the min-guard so the
  // narrow-sheet case cannot regress.
  const m = /function mirrorDqeForDate_[\s\S]*?nmReadDateRowsTail_\(sheet,\s*Math\.min\((\d+),\s*sheet\.getMaxColumns\(\)\),\s*1/.exec(nm);
  assert.ok(m, 'mirrorDqeForDate_ read call not found, or it no longer clamps to '
    + 'sheet.getMaxColumns() -- an unclamped read throws on a width-trimmed sheet.');
  assert.equal(Number(m[1]), DQE_COLS,
    'DQE Historical Data is ' + DQE_COLS + ' cols (A-AI, INV-10)');
});

test('R8-D1: NeonMirror\'s deferred QCD read width matches the QCD schema', function () {
  const nm = read('apps-script/cdr-import/NeonMirror.js');
  const m = /function mirrorQcdForDate_[\s\S]*?nmReadDateRowsTail_\(sheet,\s*(\d+),\s*2/.exec(nm);
  assert.ok(m, 'mirrorQcdForDate_ read call not found -- was it renamed? Update this pin.');
  assert.equal(Number(m[1]), QCD_COLS);
});

test('R8-D1: the duplicate-row merge repair reads the DQE ROLLUP width', function () {
  const sr = read('apps-script/cdr-report/sheetRepairs.js');
  const m = /function mergeDqeDuplicateRows_[\s\S]*?getRange\(2,\s*1,\s*lastRow\s*-\s*1,\s*(\d+)\)/.exec(sr);
  assert.ok(m, 'mergeDqeDuplicateRows_ read call not found -- update this pin.');
  // 34, NOT DQE_COLS: this repair recomputes the ROLLUP columns (D..AH) from
  // the merged duplicates and has no way to merge two per-queue splits. It
  // reads the rollup width and CLEARS col AI instead, so the merged row reads
  // as "not split" rather than carrying a split that describes fewer calls
  // than the row it sits on.
  assert.equal(Number(m[1]), 34);
  assert.ok(/getRange\(w\.row, 35\)\.setValue\(''\)/.test(sr),
    'the merge must CLEAR col AI -- a stale split on a merged row is worse '
    + 'than no split, because a reader would trust it');
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

// ---- D3: sticky-header modals must flush their scrollport's top edge -------
//
// `top: 0` on a sticky <th> is measured from the SCROLLPORT'S PADDING BOX, so
// any `padding-top` on `.modal-panel-body` parks the pinned header that far
// down and lets rows slide through the gap above it. R11-B10 fixed this for
// the Inbound and Direct modals by moving the breathing room onto the first
// child; the Daily Call Queue Report was left out and showed the identical
// awkward strip until an owner reported it.
//
// SCOPE, honestly: this pins the OVERRIDE's internal consistency and that the
// condition making it necessary still holds. It cannot discover a NEW modal
// that needs the treatment -- the qcd table is built by script.html at
// runtime, so there is nothing static to match on. The real guard is a
// rendered-UI check, which needs a harness fixture for the all-dept report
// that does not exist yet.

test('R8-D3: every modal in the flush-header rule appears in BOTH halves', function () {
  const styles = read('apps-script/department-dashboard/styles.html');
  const pad = /([^{}]*)\{\s*padding-top:\s*0;\s*\}/g;
  let m, padSel = null, kidSel = null;
  while ((m = pad.exec(styles)) !== null) {
    if (/modal-panel-body/.test(m[1]) && !/:first-child/.test(m[1])) padSel = m[1];
  }
  const kid = /([^{}]*:first-child[^{}]*)\{\s*margin-top:\s*14px;\s*\}/g;
  while ((m = kid.exec(styles)) !== null) {
    if (/modal-panel-body/.test(m[1])) kidSel = m[1];
  }
  assert.ok(padSel, 'the padding-top:0 half of the flush-header rule is gone -- '
    + 'every sticky-header modal would regain the gap strip');
  assert.ok(kidSel, 'the first-child margin half is gone -- headers would be flush '
    + 'but the modal would lose its breathing room');

  // STRIP CSS COMMENTS FIRST. The captured "selector" text runs back to the
  // previous `}`, so it swallows the explanatory comment above the rule -- and
  // that comment names #qcd-alldept-modal in prose. Without this the guard
  // read the id out of its own documentation and passed even with the selector
  // deleted, which is exactly the bug it exists to catch. (Found by breaking
  // it: removing the selector did not fail the test.)
  // De-duped SET: the halves are compared for membership, and a greedy match
  // can pick the same id up twice.
  const ids = function (sel) {
    const bare = String(sel).replace(/\/\*[\s\S]*?\*\//g, ' ');
    return Array.from(new Set(bare.match(/#[\w-]+/g) || [])).sort();
  };
  assert.deepEqual(ids(padSel), ids(kidSel),
    'a modal listed in one half but not the other gets either the gap back or '
    + 'a body jammed against its title bar');
  assert.ok(ids(padSel).indexOf('#qcd-alldept-modal') !== -1,
    'the Daily Call Queue Report must stay in the list -- this is the modal an '
    + 'owner reported the gap on');
});

test('R8-D3: the override is still NEEDED (wide modal bodies carry top padding)', function () {
  const styles = read('apps-script/department-dashboard/styles.html');
  const m = /\.modal-panel-wide \.modal-panel-body\s*\{\s*padding:\s*(\d+)px/.exec(styles);
  assert.ok(m, '.modal-panel-wide .modal-panel-body padding rule not found -- update this pin');
  assert.ok(Number(m[1]) > 0,
    'wide modal bodies no longer have top padding, so the flush-header overrides '
    + 'are dead code -- delete them rather than leaving a rule nothing needs');
});

test('R8-D3: the sticky header the rule exists for is still sticky at top: 0', function () {
  const styles = read('apps-script/department-dashboard/styles.html');
  const m = /\.agents thead th \{([\s\S]*?)\}/.exec(styles);
  assert.ok(m, '.agents thead th rule not found -- update this pin');
  assert.match(m[1], /position:\s*sticky/);
  assert.match(m[1], /top:\s*0/,
    'the whole flush-header treatment is downstream of this being top: 0');
});

// ---- B-2: every DQE reader must be cut over to the DAL ---------------------
//
// The DAL cutover was ASSERTED complete ("ALL DQE readers are now cut over")
// while three readers still went straight to the sheet -- Alerts'
// alertRowsForDate_, Digest's computeDigestWowDriver_, OrphanFix's
// computeOrphans_. The claim is what justifies letting the sheet age, and the
// alert one turns that into silence: a present-but-trimmed sheet yields zero
// rows for yesterday, so every dept logs `no-data` and the low-answer-rate
// alerts stop firing behind a full, plausible-looking Alert Log.
//
// Doc prose could not keep that true. This can: a dashboard file that reads
// SHEETS.HISTORICAL must also reference neonFetchDqeRows_, unless it is on the
// allowlist below WITH a reason. Adding a new DQE reader now fails CI until it
// is cut over in the same commit.
const DQE_SHEET_ONLY_ALLOWED = {
  // The DAL itself: sheetFetchDqeRows_ / dqeSheetMaxDate_ ARE the sheet arm,
  // and the source-independent max-date probe must never read Neon (it exists
  // to compare the two).
  'NeonRead.gs': 'the DAL / the sheet arm it dispatches to',
  // Editor-run diagnostics that deliberately inspect the SHEET's cells --
  // dumpCell_ / diagnoseTimes_ exist to show what the spreadsheet holds and
  // how it coerces, which is meaningless against Neon.
  'Diagnostics.gs': 'sheet-cell diagnostics; reading Neon would defeat their purpose',
};

test('B-2: no dashboard file reads the DQE sheet without a Neon path', function () {
  const files = fs.readdirSync(DASH).filter(function (f) { return /\.gs$/.test(f); });
  const uncut = [];
  files.forEach(function (f) {
    const src = read(f, DASH);
    if (src.indexOf('SHEETS.HISTORICAL') === -1) return;      // not a DQE reader
    if (DQE_SHEET_ONLY_ALLOWED[f]) return;                    // documented exemption
    if (src.indexOf('neonFetchDqeRows_') !== -1) return;      // cut over
    uncut.push(f);
  });
  assert.deepEqual(uncut, [],
    'these files read DQE Historical Data with no Neon path, so they go blind the '
    + 'day DQE_READ_SOURCE=neon and the sheet is trimmed: ' + uncut.join(', ')
    + '. Cut them over via neonFetchDqeRows_ + neonDqeRowsUsable_ (see '
    + 'alertRowsForDate_), or add an entry to DQE_SHEET_ONLY_ALLOWED with a reason.');
});

// ---- S2-2: force-path loss guards track the dashboard-read set -------------
//
// guardForceRebuildLoss_'s exemption list is keyed on "is this sheet
// dashboard-read", and that property CHANGES: R10-5 made CSR Transfer
// dashboard-read (Data.gs::computeCsrTransferRange_ -> the My Department
// team-strip Transfer % tile) and nobody revisited the guard, so a force
// re-import producing zero CSR rows deleted that date's history with no
// failure row and no email. Pin both guarded steps so a future edit that drops
// one has to argue with a test.
test('S2-2: processIntegratedHistory guards the force path for QCD and CSR', function () {
  const src = read('apps-script/cdr-import/autoImport.js');
  ['processIntegratedHistory:QCD', 'processIntegratedHistory:CSR'].forEach(function (step) {
    const re = new RegExp('guardForceRebuildLoss_\\(targetSS,\\s*[\'"]'
      + step.replace(/[:]/g, '[:]') + '[\'"]');
    assert.match(src, re,
      step + ' has no guardForceRebuildLoss_ call -- a force rebuild that '
      + 'produces 0 rows would silently delete that date (the sheet is '
      + 'dashboard-read, so the loss reaches a tile).');
  });
});

test('S2-2: CSR Transfer really is dashboard-read (the reason it is guarded)', function () {
  // If this ever stops being true the guard above is merely harmless rather
  // than required -- but the far likelier failure is the reverse, so assert the
  // premise rather than trusting the comment that states it.
  const dataGs = read('Data.gs', DASH);
  assert.match(dataGs, /CSR Transfer Historical Data/,
    'Data.gs no longer reads CSR Transfer Historical Data -- re-check whether '
    + 'the S2-2 force-path guard is still warranted before removing it.');
});

// ── F-7: the userJson script-tag escape (Code.gs -> dashboard.html) ─────────
//
// `<?!= ?>` does NOT HTML-escape, and JSON.stringify does not escape the
// literal end-of-script-tag pattern inside string values -- a crafted agent /
// dept / config string containing "</script>" would CLOSE the inline <script>
// block and inject markup. The documented defense (CLAUDE.md's scriptlet
// gotcha) is server-side: every tmpl.*Json assignment replaces '<' with
// < BEFORE it reaches the template. That rule had no pin; this one is
// GENERIC on purpose -- a future tmpl.<new>Json injection missing the escape
// fails here without anyone updating a list.
test('F-7: every tmpl.*Json assignment in Code.gs carries the \\u003c escape', function () {
  const codeGs = read('Code.gs', DASH);
  const assigns = codeGs.match(/tmpl\.\w+Json\s*=[^;]+;/g) || [];
  assert.ok(assigns.length >= 6,
    'expected the known tmpl.*Json assignments; found ' + assigns.length
    + ' -- if renderDashboard_ was refactored, re-point this pin');
  const unescaped = assigns.filter(function (a) {
    return a.indexOf("replace(/</g, '\\\\u003c')") === -1;
  });
  assert.deepEqual(unescaped, [],
    'tmpl.*Json assignment(s) WITHOUT the \\u003c escape -- a string value '
    + 'containing an end-of-script tag would break out of the inline script '
    + 'block (see the CLAUDE.md scriptlet gotcha)');
});

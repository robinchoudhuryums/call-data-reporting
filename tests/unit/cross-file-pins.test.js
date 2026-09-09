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
  // #4 (Round-16): the client is script.html (assembler) + the script-*.html
  // fragments it includes; search the whole family, since the classes/ids the
  // flag rules target are built across the fragments.
  const script = read('script.html', DASH) + fs.readdirSync(DASH)
    .filter(function (f) { return /^script-[\w-]+\.html$/.test(f); })
    .map(function (f) { return read(f, DASH); })
    .join('\n');

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
  // Admin-gated live-wiring probe: opens the sheet BY LITERAL to report
  // whether it exists/has rows -- a reachability check, not a data read;
  // its DQE data probes go through the DAL separately.
  'SmokeCheck.gs': 'live-wiring probe of the sheet itself; the data reads are DAL-routed',
};

// S4 (broad-scan 2026-08-27): detect a DQE reader by the OPEN CALL too, by
// literal or constant -- the F11 QCD twin below was hardened exactly this way
// after two readers were found reaching for the sheet by STRING LITERAL,
// which the SHEETS.HISTORICAL mention-check cannot see.
const DQE_SHEET_OPEN_RE =
  /getSheetByName\(\s*(?:['"]DQE Historical Data['"]|SHEETS\.HISTORICAL)\s*\)/;

test('B-2: no dashboard file reads the DQE sheet without a Neon path', function () {
  const files = fs.readdirSync(DASH).filter(function (f) { return /\.gs$/.test(f); });
  const uncut = [];
  files.forEach(function (f) {
    const src = read(f, DASH);
    if (src.indexOf('SHEETS.HISTORICAL') === -1
      && !DQE_SHEET_OPEN_RE.test(src)) return;                // not a DQE reader (S4: literal opens count)
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

// R22 (owner: abandon standard 5% -> 4%): the display standard lives in TWO
// copies -- Config.gs::ABANDON_STANDARD_PCT (server renderers: QueueReportEmail,
// InboundReport) and script-1-core.html::ABANDON_STANDARD_ (every client tint /
// legend / chart baseline) -- plus the PIPELINE's violation gate
// (cdr-import autoImport.js::QCD_VIOLATION_ABANDON_RATE, a 0..1 rate). A drift
// between them makes tints disagree with the violation counts they sit beside.
test('R22: the abandon standard is identical across server, client, and the pipeline gate', function () {
  const cfg = /const ABANDON_STANDARD_PCT = (\d+(?:\.\d+)?);/.exec(read('Config.gs', DASH));
  assert.ok(cfg, 'Config.gs::ABANDON_STANDARD_PCT missing');
  const core = /var ABANDON_STANDARD_ = (\d+(?:\.\d+)?);/.exec(read('script-1-core.html', DASH));
  assert.ok(core, 'script-1-core.html::ABANDON_STANDARD_ missing');
  const pipe = /const QCD_VIOLATION_ABANDON_RATE = (0\.\d+);/.exec(
    read('apps-script/cdr-import/autoImport.js'));
  assert.ok(pipe, 'autoImport.js::QCD_VIOLATION_ABANDON_RATE missing');
  assert.equal(Number(core[1]), Number(cfg[1]), 'client copy != server copy');
  assert.equal(Number(pipe[1]) * 100, Number(cfg[1]),
    'pipeline violation gate != the display standard');
});

// R23 (owner: answer target 92 -> 80, CSR stays 92): the injection-failure
// FALLBACK literals must match the Config.gs seeds -- a client running with a
// failed __ANSWER_TARGETS__/__STANDARDS__ injection (or the agent app with a
// failed __ANSWER_STD__) silently judges against its fallback, so a drifted
// fallback shows different colors than every healthy session.
test('R23: the answer-target seed matches the client + agent-app fallback literals', function () {
  const cfg = /const ANSWER_TARGET_DEFAULT = (\d+(?:\.\d+)?);/.exec(read('Config.gs', DASH));
  assert.ok(cfg, 'Config.gs::ANSWER_TARGET_DEFAULT missing');
  const nav = /return \(isFinite\(g\) && g > 0\) \? g : (\d+);/.exec(read('script-4-nav.html', DASH));
  assert.ok(nav, 'script-4-nav.html::answerTarget_ fallback missing');
  assert.equal(Number(nav[1]), Number(cfg[1]), 'answerTarget_ fallback != seed');
  const agent = /Number\(ANSWER_STD_OBJ_\.target\) : (\d+);/.exec(read('agentApp.html', DASH));
  assert.ok(agent, 'agentApp.html answer-standard fallback missing');
  assert.equal(Number(agent[1]), Number(cfg[1]), 'agent-app fallback != seed');
  const band = /const ANSWER_AMBER_BAND_DEFAULT = (\d+(?:\.\d+)?);/.exec(read('Config.gs', DASH));
  assert.ok(band, 'Config.gs::ANSWER_AMBER_BAND_DEFAULT missing');
  const agentBand = /Number\(ANSWER_STD_OBJ_\.band\) : (\d+);/.exec(read('agentApp.html', DASH));
  assert.ok(agentBand, 'agent-app band fallback missing');
  assert.equal(Number(agentBand[1]), Number(band[1]), 'agent-app band fallback != seed');
});

// R20 row-40 (broad-scan F1/F2): the Extraction Sidebar mirrors the pipeline's
// QCD row rules BY HAND, and that mirror had already drifted. The R20 owner
// ruling moved row 40 (A_Q_Spanish per QCDR Output A40) off its ">0s" abandon
// holdout onto the >1min rule every other queue uses; the fix landed in
// autoImport.js only, so the sidebar went on listing rows the pipeline no
// longer counts -- i.e. the tool an operator reaches for WHEN THEY ALREADY
// SUSPECT the numbers told them the pipeline was under-counting.
//
// check-duplicated-files.sh now guards the two shared time-decode helpers, but
// the ROW RULES are structurally different code in the two files and cannot be
// diffed. This pin instead extracts every abandon-wait threshold token from
// each file's row-40 block and asserts the two agree -- narrow, but aimed
// exactly at the drift that actually happened.
function q40Block_(src, startMarker, label) {
  const i = src.indexOf(startMarker);
  assert.ok(i !== -1, label + ': row-40 block marker "' + startMarker
    + '" not found -- the block moved or was renamed; update this suite.');
  // Brace-match from the marker's opening `{` to its close.
  let depth = 0, started = false, end = -1;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') { depth--; if (started && depth === 0) { end = j; break; } }
  }
  assert.ok(end !== -1, label + ': row-40 block never closes -- update this suite.');
  return src.slice(i, end + 1);
}

// Every `abandoned === "abandoned" && waitDec > <token>` in a block. The col-7
// `abandoned !== "abandoned" && waitDec >= 0` clauses do not match (different
// operator on both halves), which is correct -- they are not abandon rules.
function abandonWaitTokens_(block) {
  const out = new Set();
  const re = /abandoned === "abandoned" && waitDec > ([A-Za-z0-9_]+)/g;
  let m;
  while ((m = re.exec(block)) !== null) out.add(m[1]);
  return out;
}

test('R20 row-40: the Extraction Sidebar and the pipeline use the SAME abandon threshold', function () {
  const pipeBlock = q40Block_(
    read('apps-script/cdr-import/autoImport.js'),
    'if (queueName === q40_name) {', 'autoImport.js');
  const sideBlock = q40Block_(
    read('apps-script/cdr-report/dataFilters.js'),
    'if (targetRow === 40 && is630to1500 && queueName === q40_name) {', 'dataFilters.js');

  const pipeTokens = abandonWaitTokens_(pipeBlock);
  const sideTokens = abandonWaitTokens_(sideBlock);

  assert.ok(pipeTokens.size > 0, 'no abandon-wait rule found in autoImport row-40 block');
  assert.ok(sideTokens.size > 0, 'no abandon-wait rule found in dataFilters row-40 block');

  // R20: ONE threshold on each side, and the same one. A second token on
  // either side means a partial edit (exactly how this drifted the first time).
  assert.deepEqual([...pipeTokens].sort(), ['time1Min'],
    'autoImport row-40 abandon rules should all use time1Min (R20 owner ruling)');
  assert.deepEqual([...sideTokens].sort(), ['time1Min'],
    'dataFilters (Extraction Sidebar) row-40 abandon rules drifted from the '
    + 'pipeline: the sidebar would list rows the pipeline does not count, so a '
    + 'reconciliation reads as "the pipeline is under-counting". Mirror the '
    + 'autoImport q40_name block.');
});

// ---- F11: the B-2 tripwire, in the QCD dimension ---------------------------
//
// B-2 (elsewhere in this suite) pins that no dashboard file reads the DQE
// sheet without a Neon path -- the lesson being that an uncut reader is
// INVISIBLE until the sheet ages out from under it, and the Alerts reader
// silently stopped every low-answer-rate alert the day that happened.
//
// QCD has the same shape: QCD_READ_SOURCE + a parity gate + a documented
// cutover (Operator State #30), and readers that reach the sheet directly.
// It had no tripwire, and two readers were found reaching for the sheet by
// STRING LITERAL (not the SHEETS.* constant), so even a constant-based check
// would have missed them.
//
// Detection is the OPEN CALL (getSheetByName), not a mention of the sheet's
// name: half a dozen files discuss "QCD Historical Data" in prose while
// reading it through the source-aware readQcdGrid_, and a prose-matching
// tripwire flags those forever and gets muted.
//
// Each entry below is a DECISION someone made and has to defend, not a
// blanket exemption -- that is the whole value of the list.
const QCD_SHEET_ONLY_ALLOWED = {
  // The QCD DAL itself: readQcdSheetData_ / readQcdGrid_ ARE the sheet arm
  // that getQcdReadSource_ dispatches to, and the parity gate must be able to
  // read both sides.
  'QCDReport.gs': 'the QCD DAL / the sheet arm it dispatches to',
  // DELIBERATE (see queueReportQcdLatestIso_'s docstring): this answers "did
  // the import finish?", not "what data exists?", and the sheet is what the
  // import writes. CONSEQUENCE, undocumented until F11: the QCD sheet cannot
  // be retired while this reads it, or the Daily Call Queue Report trigger
  // silently stops sending with no failure anywhere.
  'QueueReportEmail.gs': 'import-finished signal is deliberately the sheet '
    + '(queueReportQcdLatestIso_) -- NOTE: this BLOCKS retiring the QCD sheet',
  // Admin queue DISCOVERY for the Dept Config modal, not a metric read. It
  // goes blind against a trimmed sheet, so its consumer (saveDeptConfig) now
  // fails OPEN on an empty universe with a warning instead of rejecting every
  // queue name as unknown (F11).
  'DeptConfig.gs': 'admin queue discovery; saveDeptConfig fails open when the scan is empty',
};

// Any getSheetByName pointing at QCD Historical Data, by literal or constant.
const QCD_SHEET_OPEN_RE =
  /getSheetByName\(\s*(?:['"]QCD Historical Data['"]|SHEETS\.QCD[A-Z_]*)\s*\)/;

test('F11: no dashboard file OPENS the QCD sheet without a Neon path or a recorded reason', function () {
  const files = fs.readdirSync(DASH).filter(function (f) { return /\.gs$/.test(f); });
  const uncut = [];
  files.forEach(function (f) {
    const src = read(f, DASH);
    if (!QCD_SHEET_OPEN_RE.test(src)) return;                 // not a QCD sheet reader
    if (QCD_SHEET_ONLY_ALLOWED[f]) return;                    // documented exemption
    if (src.indexOf('getQcdReadSource_') !== -1) return;      // source-aware
    uncut.push(f);
  });
  assert.deepEqual(uncut, [],
    'these files open QCD Historical Data with no Neon path, so they go blind the '
    + 'day QCD_READ_SOURCE=neon and the sheet is trimmed: ' + uncut.join(', ')
    + '. Route the read through getQcdReadSource_, or add an entry to '
    + 'QCD_SHEET_ONLY_ALLOWED with a reason AND its consequence.');
});

// The allowlist is only worth having if it stays honest: an entry for a file
// that no longer opens the sheet is stale documentation that will mislead the
// next reader into thinking a blind spot exists where it does not.
test('F11: every QCD_SHEET_ONLY_ALLOWED entry still describes a real sheet reader', function () {
  Object.keys(QCD_SHEET_ONLY_ALLOWED).forEach(function (f) {
    const p = path.join(DASH, f);
    assert.ok(fs.existsSync(p), 'QCD_SHEET_ONLY_ALLOWED names a missing file: ' + f);
    assert.ok(QCD_SHEET_OPEN_RE.test(read(f, DASH)),
      f + ' is exempted from the QCD sheet tripwire but no longer opens the sheet '
      + '-- drop the entry.');
  });
});

// ── JDBC connection properties: Apps Script REJECTS timeout params ─────────
// This pin is INVERTED from what it originally asserted, and the inversion is
// the finding. Adding `?connectTimeout=..&socketTimeout=..&loginTimeout=..` to
// the Neon JDBC URLs was meant to stop a hanging connect from burning the
// 6-min execution ceiling. Apps Script's JDBC service does not accept those
// properties -- it throws "The following connection properties are
// unsupported: connectTimeout,socketTimeout,loginTimeout" -- so instead of
// bounding the hang it made EVERY Neon connection fail instantly, in all three
// projects, until it was caught in production the next day.
//
// The unit suite could not have caught it: the shim's Jdbc mock accepts any
// URL, and the real validation lives in Google's runtime. What a test CAN do
// is stop the same idea being re-applied, so this asserts the params are
// ABSENT and says why. Bound STATEMENTS with stmt.setQueryTimeout(seconds)
// (which getReachableNeonConn_'s probe already does) -- that the platform
// supports; there is no supported connect-level timeout.
test('no Neon JDBC URL carries connect/socket/login timeout properties', function () {
  const JDBC_FILES = [
    'apps-script/department-dashboard/NeonRead.gs',
    'apps-script/cdr-report/neonWrite.js',
    'apps-script/cdr-import/neonWrite.js',
    'apps-script/cdr-report/dbHistorical.js',
    'apps-script/cdr-report/neonbackfill.js',
    'apps-script/department-dashboard/OrphanFix.gs',
  ];
  JDBC_FILES.forEach(function (rel) {
    const src = read(rel);
    assert.ok(/jdbc:postgresql/.test(src), rel + ' no longer builds a JDBC URL -- drop it from this pin.');
    assert.ok(!/connectTimeout|socketTimeout|loginTimeout/.test(src.replace(/\/\/[^\n]*/g, '')),
      rel + ' puts a timeout property on the Neon JDBC URL. Apps Script REJECTS '
      + 'these and the connection fails outright -- this exact change took every '
      + 'Neon read and write down across all three projects. Use '
      + 'stmt.setQueryTimeout(seconds) on statements instead.');
  });
  // Completeness: no OTHER file opens a JDBC connection unlisted here.
  const globSync = function (dir) {
    let out = [];
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out = out.concat(globSync(p));
      else if (/\.(gs|js)$/.test(e.name)) out.push(p);
    });
    return out;
  };
  const listed = JDBC_FILES.map(function (rel) { return path.join(ROOT, rel); });
  globSync(path.join(ROOT, 'apps-script')).forEach(function (p) {
    const src = fs.readFileSync(p, 'utf8');
    if (/Jdbc\.getConnection/.test(src) && listed.indexOf(p) === -1) {
      assert.fail(p + ' calls Jdbc.getConnection but is not in this pin list -- add it.');
    }
  });
});

// ── FO-1: ONE client-side reader of __COMPANY_HOLIDAYS__ ────────────────────
// The holiday-range test had four inline copies across client fragments and
// they had already drifted (script-6-ir guarded malformed range entries; the
// others did not). They now share isCompanyHolidayIso_ in script-1-core. A
// fifth copy would re-open the same drift, and no behavioral test can see it
// (each copy renders fine -- it is only WRONG on a holiday), so pin it here.
test('FO-1: only the shared helper reads __COMPANY_HOLIDAYS__ on the client', function () {
  const FRAGMENTS = fs.readdirSync(DASH).filter(function (f) { return /^script-\d+-.*\.html$/.test(f); });
  // Match a real property ACCESS (window./globalThis./self.), not the prose
  // mentions the fragments legitimately keep in their comments.
  const readers = FRAGMENTS.filter(function (f) {
    return /\.\s*__COMPANY_HOLIDAYS__/.test(read(f, DASH));
  });
  assert.deepEqual(readers, ['script-1-core.html'],
    'the company-holiday global must be read ONLY by isCompanyHolidayIso_ in '
    + 'script-1-core.html -- a per-fragment copy of the range loop is how the '
    + 'four originals drifted. Call the shared helper instead. Found: '
    + readers.join(', '));
  const core = read('script-1-core.html', DASH);
  assert.ok(/function isCompanyHolidayIso_/.test(core), 'the shared helper is gone');
  assert.ok(/r && r\.from && r\.to/.test(core),
    'the shared helper must keep the malformed-entry guard it inherited from '
    + 'the most defensive of the copies it replaced');
});

// ---- S1 (broad-scan 2026-08-27): the INV-06 work window's FOUR copies ------
//
// The pipeline's numeric seconds (DQE_WINDOW_START/END) are the SOURCE OF
// TRUTH. Three mirrors restate the same 6:30 AM-3:00 PM PST window, and
// CLAUDE.md calls keeping them equal a "sync obligation":
//   - DASHBOARD_WORK_WINDOW   (Config.gs)  the display strings, BOTH zones
//   - INBOUND_WORK_WINDOW_PST (Config.gs)  the SQL query strings
//   - DQE_DD_WINDOW_START/END (DQEdrilldown.js)  the drill's own re-implementation
// Every mirror is derived from the pipeline numbers here, never hardcoded
// twice, so moving the window forces every copy to move with it.
const pipelineWindow_ = function () {
  const build = read('apps-script/cdr-import/buildDQEHistoricalData.js');
  const startExpr = /const DQE_WINDOW_START = ([^;]+);/.exec(build);
  const endExpr   = /const DQE_WINDOW_END\s*=\s*([^;]+);/.exec(build);
  const shiftExpr = /const DQE_PST_TO_CST\s*=\s*([^;]+);/.exec(build);
  assert.ok(startExpr && endExpr, 'DQE_WINDOW_START/END not found -- update this pin');
  assert.ok(shiftExpr, 'DQE_PST_TO_CST not found -- update this pin');
  return {
    start: windowSecs_(startExpr[1], 'DQE_WINDOW_START'),
    end:   windowSecs_(endExpr[1],   'DQE_WINDOW_END'),
    toCst: windowSecs_(shiftExpr[1], 'DQE_PST_TO_CST'),
  };
};

// The RHS of each window constant is plain arithmetic ((6 * 60 + 30) * 60), so
// evaluate it rather than re-deriving the number here. Guarded: if a constant
// ever becomes an expression referencing something else, this says WHICH one
// and why it could not be read, instead of a bare ReferenceError from Function.
const windowSecs_ = function (expr, name) {
  let v;
  try { v = Function('return (' + expr + ');')(); }
  catch (e) {
    assert.fail(name + ' is no longer plain arithmetic (' + expr.trim() + ') -- '
      + 'this pin evaluates the RHS to compare copies. Rework the pin. ' + e.message);
  }
  assert.ok(Number.isFinite(v),
    name + ' did not evaluate to a number (' + expr.trim() + ') -- rework this pin');
  return v;
};

test('S1/INV-06: the work-window copies agree (pipeline seconds, dashboard display in BOTH zones, inbound strings)', function () {
  const pipe = pipelineWindow_();
  const pipeStart = pipe.start;
  const pipeEnd   = pipe.end;

  const inbStart = /start:\s*'(\d{2}):(\d{2}):(\d{2})'/.exec(configGs);
  const inbEnd   = /end:\s*'(\d{2}):(\d{2}):(\d{2})'/.exec(configGs);
  assert.ok(inbStart && inbEnd, 'INBOUND_WORK_WINDOW_PST not found -- update this pin');
  const hmsSecs = function (m) { return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]); };
  assert.equal(hmsSecs(inbStart), pipeStart, 'inbound window START drifted from the pipeline');
  assert.equal(hmsSecs(inbEnd),   pipeEnd,   'inbound window END drifted from the pipeline');

  const disp = /pst:\s*'(\d{1,2}):(\d{2}) (AM|PM) [^']*?(\d{1,2}):(\d{2}) (PM|AM) PST'/.exec(configGs);
  assert.ok(disp, 'DASHBOARD_WORK_WINDOW.pst not found / reshaped -- update this pin');
  const ampmSecs = function (h, m, ap) {
    let hh = (+h) % 12; if (ap === 'PM') hh += 12;
    return hh * 3600 + (+m) * 60;
  };
  assert.equal(ampmSecs(disp[1], disp[2], disp[3]), pipeStart, 'display window START drifted');
  assert.equal(ampmSecs(disp[4], disp[5], disp[6]), pipeEnd,   'display window END drifted');

  // The CST half of the SAME object. It is the PST window plus the pipeline's
  // own DQE_PST_TO_CST shift, so it is derived here rather than restated --
  // the .pst check above passing said nothing about .cst, and the CST string
  // is the one managers actually read on the work-window pill (E2).
  const dispC = /cst:\s*'(\d{1,2}):(\d{2}) (AM|PM) [^']*?(\d{1,2}):(\d{2}) (PM|AM) CST'/.exec(configGs);
  assert.ok(dispC, 'DASHBOARD_WORK_WINDOW.cst not found / reshaped -- update this pin');
  assert.equal(ampmSecs(dispC[1], dispC[2], dispC[3]), pipeStart + pipe.toCst,
    'display window START (CST) drifted from pipeline start + DQE_PST_TO_CST');
  assert.equal(ampmSecs(dispC[4], dispC[5], dispC[6]), pipeEnd + pipe.toCst,
    'display window END (CST) drifted from pipeline end + DQE_PST_TO_CST');
});

// The FOURTH copy, and the one with the worst track record: DQEdrilldown.js
// re-implements the INV-06 window with its own constants (CLAUDE.md: it has
// drifted from the build three times, each time contradicting the build during
// the investigation the drill exists to serve). dqe-drilldown-parity.test.js
// drives both with a fixture and would catch SOME window drift -- its Q4 leg
// sits at 05:00 PST -- but only where a fixture leg straddles the moved edge,
// so an END drift is invisible to it. This pin is unconditional.
test('S1/INV-06: the DQE drill-down\'s own window constants match the pipeline', function () {
  const pipe = pipelineWindow_();
  const dd = read('apps-script/cdr-report/DQEdrilldown.js');
  const ddStart = /DQE_DD_WINDOW_START\s*=\s*([^;]+);/.exec(dd);
  const ddEnd   = /DQE_DD_WINDOW_END\s*=\s*([^;]+);/.exec(dd);
  assert.ok(ddStart && ddEnd,
    'DQE_DD_WINDOW_START/END not found in DQEdrilldown.js -- if the drill now '
    + 'reads the pipeline constants directly, delete this pin; if it was '
    + 'renamed, update it. Do not let it become unpinned.');
  assert.equal(windowSecs_(ddStart[1], 'DQE_DD_WINDOW_START'), pipe.start,
    'the drill-down window START drifted from the pipeline -- the drill would '
    + 'attribute legs the build does not count (INV-06)');
  assert.equal(windowSecs_(ddEnd[1], 'DQE_DD_WINDOW_END'), pipe.end,
    'the drill-down window END drifted from the pipeline -- the drill would '
    + 'attribute legs the build does not count (INV-06)');
});

// ---- F1 / F2 (broad-scan 2026-09-09): two conventions that were WRITTEN as
// obligations and enforced by nothing -- the C2 corollary gap. Both are the
// repo's recurring shape: a list you must remember to join, where forgetting
// is invisible until the surface it guards breaks in production.

// F1. drive-admin.js's MODALS list is hand-copied from the ROUTER TABLE in
// script-4-nav.html. Nothing compared them, and the gap had already
// materialised: '/admin/coaching' shipped with no rendered coverage at all.
// This pins every kind:'modal' route to either the driver's list or a
// documented exemption, so a new modal route cannot join the router silently.
const DRIVER_MODAL_EXEMPT = {
  // The three report modals are a SEPARATE coverage question (they are
  // admin-only while being vetted, and their payload fixtures are not built
  // by gen-phase3.js). Listed here so the omission is deliberate and visible
  // rather than an accident of who last edited the driver.
  'inbound-modal':     'report modal — admin-only while vetted; no harness fixture yet',
  'direct-call-modal': 'report modal — admin-only while vetted; no harness fixture yet',
  'outbound-modal':    'report modal — admin-only while vetted; no harness fixture yet',
};

test('F1: every modal route in the router is driven by drive-admin.js or documented as exempt', function () {
  const nav = read('script-4-nav.html', DASH);
  const routed = [];
  for (const m of nav.matchAll(/'(\/[^']+)':\s*\{\s*kind:\s*'modal',\s*modalId:\s*'([^']+)'/g)) {
    routed.push({ route: m[1], modalId: m[2] });
  }
  assert.ok(routed.length >= 7,
    'the router table parse found only ' + routed.length + ' modal routes -- the '
    + 'table was reshaped and this pin can no longer read it. Fix the pin.');

  // Scan EVERY asserting driver the gate runs, not just drive-admin: the
  // Individual Report modal is driven by drive-smoke + drive-f13, and a pin
  // that looked only at drive-admin would have called it uncovered. The
  // driver list is read from ci.mjs's STAGES so it follows the real gate.
  const ci = read('tools/ui-harness/ci.mjs');
  const driverFiles = [...ci.matchAll(/\['node',\s*\['(drive-[a-z0-9-]+\.js)'\]/g)].map((m) => m[1]);
  assert.ok(driverFiles.length >= 5,
    'only ' + driverFiles.length + ' asserting drivers parsed out of ci.mjs -- '
    + 'the STAGES table was reshaped. Fix the pin.');
  const driven = new Set();
  for (const df of driverFiles) {
    const src = read('tools/ui-harness/' + df);
    for (const m of src.matchAll(/#([a-z0-9-]+-modal)\b/g)) driven.add(m[1]);
  }

  const uncovered = routed
    .filter((r) => !driven.has(r.modalId) && !(r.modalId in DRIVER_MODAL_EXEMPT))
    .map((r) => r.route + ' (#' + r.modalId + ')');

  assert.deepEqual(uncovered, [],
    'modal route(s) with NO rendered-gate coverage and no documented exemption: '
    + uncovered.join(', ') + '. Add each to drive-admin.js\'s MODALS list (its '
    + 'RPCs must be mocked in build-harness.js first), or add it to '
    + 'DRIVER_MODAL_EXEMPT here with the reason. A modal nothing ever OPENS is '
    + 'how the header dept-selector ReferenceError reached production.');
});

test('F1: every DRIVER_MODAL_EXEMPT entry still names a real modal route', function () {
  const nav = read('script-4-nav.html', DASH);
  const routedIds = new Set();
  for (const m of nav.matchAll(/kind:\s*'modal',\s*modalId:\s*'([^']+)'/g)) routedIds.add(m[1]);
  const stale = Object.keys(DRIVER_MODAL_EXEMPT).filter((id) => !routedIds.has(id));
  assert.deepEqual(stale, [],
    'DRIVER_MODAL_EXEMPT names modal id(s) the router no longer has: ' + stale.join(', ')
    + '. Drop them -- a stale exemption silently widens the hole it documents.');
});

// F2. Eight engines gate their handler BODY on an `*_ENABLED` Script Property,
// so an installed trigger whose flag is off fires and returns immediately.
// svc()'s optional `flagProp` is what makes the Health page say so ("installed
// but DISABLED -- every run is a no-op" / "NO trigger installed but
// flag=true"). CLAUDE.md states that a new flag-gated engine MUST pass it;
// nothing checked, so a ninth engine would silently inherit the old blind spot.
test('F2: every *_ENABLED-gated engine passes its flagProp to svc()', function () {
  const health = read('SystemHealth.gs', DASH);
  // Extract the flags actually PASSED TO svc(), by walking each call's
  // balanced parens. A first draft just grepped SystemHealth.gs for the flag
  // string and passed even after the argument was deleted -- the flag is also
  // named in hint text and the property inventory. A check that stays green
  // when its subject is gone is worse than no check.
  const svcFlags = new Set();
  for (let i = health.indexOf('svc('); i !== -1; i = health.indexOf('svc(', i + 1)) {
    let depth = 0, j = i + 3;
    for (; j < health.length; j++) {
      if (health[j] === '(') depth++;
      else if (health[j] === ')') { depth--; if (depth === 0) break; }
    }
    const call = health.slice(i, j + 1);
    for (const m of call.matchAll(/'([A-Z0-9_]+_ENABLED)'/g)) svcFlags.add(m[1]);
  }
  assert.ok(svcFlags.size >= 6,
    'only ' + svcFlags.size + ' flagProps parsed out of svc() calls -- the call '
    + 'shape changed and this pin can no longer read it. Fix the pin.');

  // The engines, discovered from their own files rather than restated here:
  // a handler that reads `<X>_ENABLED` is flag-gated by definition.
  const dir = path.join(ROOT, 'apps-script', 'department-dashboard');
  const engines = new Set();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.gs'))) {
    if (f === 'SystemHealth.gs' || f === 'Config.gs') continue;   // reader + registry, not engines
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    // An ENGINE is a flag-gated TRIGGER handler. A file that reads an
    // `*_ENABLED` property but installs no trigger is a feature flag
    // (AGENT_ROLE_ENABLED, LOGIN_NOTIFY_ENABLED in Auth.gs) -- svc() reports
    // TRIGGERS, so those correctly have no flagProp and must not be demanded.
    if (!/ScriptApp\.newTrigger\(/.test(src)) continue;
    for (const m of src.matchAll(/getProperty\(\s*'([A-Z0-9_]+_ENABLED)'\s*\)/g)) engines.add(m[1]);
  }
  assert.ok(engines.size >= 6,
    'only ' + engines.size + ' flag-gated engines discovered -- the property read '
    + 'was reshaped and this pin can no longer see them. Fix the pin.');

  const missing = [...engines].filter((f) => !svcFlags.has(f)).sort();
  assert.deepEqual(missing, [],
    'flag-gated engine(s) whose flag is never passed to svc(): ' + missing.join(', ')
    + '. Pass it as svc()\'s last argument, or the Health page reports the trigger '
    + 'ARMED while every run is a no-op -- the exact blind spot flagProp exists to close.');
});

// ── R40: the per-execution DQE memo family resets together ────────────────
//
// Two globals memoize DQE-sheet-derived state for the length of one execution
// -- DQE_DATE_BOUNDS_MEMO_ (the date-column bounds) and DQE_SHEET_ROWS_MEMO_
// (the DAL row sets). Apps Script drops both at the end of a request, but a
// TEST harness ctx outlives every test in its file, so a suite that swaps the
// DQE fixture without nulling them serves the PREVIOUS test's data -- silently,
// as a wrong number rather than an error. That trap was documented in prose for
// the bounds memo; adding the second one made prose insufficient, because the
// failure mode is a suite that copies the reset it knows about and misses the
// one it does not. (This is exactly what happened when the rows memo landed:
// eight tests in two suites broke on stale fixtures.)
//
// So: the two are pinned to reset TOGETHER. Their scope is identical -- both
// are invalidated by precisely the same event, a fixture swap -- so a suite
// needing one always needs the other, and no suite legitimately resets only
// half. A third memo over the same sheet should join this list.
const DQE_EXEC_MEMOS = ['DQE_DATE_BOUNDS_MEMO_', 'DQE_SHEET_ROWS_MEMO_'];

test('R40: a suite resetting one per-execution DQE memo resets the whole family', () => {
  const unitDir = path.join(ROOT, 'tests', 'unit');
  const offenders = [];
  let sawAny = 0;
  for (const f of fs.readdirSync(unitDir).filter((x) => x.endsWith('.test.js'))) {
    const src = fs.readFileSync(path.join(unitDir, f), 'utf8');
    // Only a suite that actually RESETS one of them is in scope; merely naming
    // a memo (this pin itself, or a doc comment) is not a reset.
    const resets = DQE_EXEC_MEMOS.filter(
      (m) => new RegExp('ctx\\.' + m + '\\s*=\\s*null').test(src));
    if (!resets.length) continue;
    sawAny++;
    const missing = DQE_EXEC_MEMOS.filter((m) => !resets.includes(m));
    if (missing.length) offenders.push(f + ' -> missing ' + missing.join(', '));
  }
  assert.ok(sawAny >= 4,
    'only ' + sawAny + ' suite(s) seen resetting a DQE execution memo -- the reset '
    + 'was reshaped and this pin can no longer see it. Fix the pin.');
  assert.deepEqual(offenders, [],
    'suite(s) resetting only part of the DQE per-execution memo family: '
    + offenders.join('; ') + '. Reset every memo in DQE_EXEC_MEMOS in the same '
    + 'install(), or the suite silently serves the previous fixture\'s DQE data.');
});

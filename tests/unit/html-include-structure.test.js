'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Why this exists (2026-07, shipped to production before anyone noticed).
//
// styles.html and script.html are Apps Script INCLUDES: their whole body is
// injected into dashboard.html inside a single <style> / <script> element. The
// sub-queue Phase 1 CSS was appended to styles.html *after* its closing
// </style> tag, so ~40 lines of raw CSS -- comment banner first -- rendered as
// visible text at the top of the page for every user.
//
// Nothing caught it. The rendered-UI gate boots the real client and asserts
// console errors, blank canvases and horizontal overflow; stray text produces
// none of those, because the browser is doing exactly what the markup says.
// The failure is structural, so this is a structural check: the tag that wraps
// the file must actually wrap ALL of it.
//
// The rule for anyone appending to these files: content goes BEFORE the closing
// tag, which lives on the last line. Appending to the end of the file is the
// natural motion and is exactly what breaks it.

const DIR = path.join(__dirname, '..', '..', 'apps-script', 'department-dashboard');

const INCLUDES = [
  { file: 'styles.html', tag: 'style' },
  { file: 'script.html', tag: 'script' },
];

INCLUDES.forEach(function (spec) {
  test(spec.file + ': the wrapping <' + spec.tag + '> encloses the ENTIRE file', function () {
    const text = fs.readFileSync(path.join(DIR, spec.file), 'utf8');
    const open = '<' + spec.tag + '>';
    const close = '</' + spec.tag + '>';

    const opens = text.split(open).length - 1;
    const closes = text.split(close).length - 1;
    assert.equal(opens, 1, spec.file + ' must contain exactly one ' + open);
    assert.equal(closes, 1, spec.file + ' must contain exactly one ' + close);

    const before = text.slice(0, text.indexOf(open)).trim();
    assert.equal(before, '',
      'nothing may precede ' + open + ' -- it would render as literal text');

    const after = text.slice(text.indexOf(close) + close.length).trim();
    assert.equal(after, '',
      'NOTHING may follow ' + close + '. Found ' + after.length + ' chars, starting: '
      + JSON.stringify(after.slice(0, 120))
      + '\nThis is the exact bug that shipped: content appended to the end of the '
      + 'file lands OUTSIDE the tag and renders as visible text on the page. '
      + 'Move it above the closing tag.');
  });
});

// ---- #4 (Round-16): the assembled-client fragment family ------------------
//
// script.html is now an ASSEMBLER: one <script> element wrapping one IIFE
// whose body is spliced from the raw-JS script-N-*.html fragment includes, in
// order, by the template-evaluating include_ (Code.gs). That preserves the
// single shared function scope the client has always had -- and it changes
// what the dangerous mistakes look like:
//   * a fragment containing the end-of-script-tag pattern closes the
//     assembled block early (the ORIGINAL bug class, now reachable from any
//     fragment, not just the tail of one big file);
//   * a fragment containing a scriptlet-open sequence EXECUTES at render,
//     because include_ evaluates templates now;
//   * a fragment on disk that is not in script.html's include list silently
//     drops every feature it defines (include_ pulls by name, nothing scans
//     the directory).
// So: purity pins per fragment, list-parity both directions, and a syntax
// check on the assembled body (the closest a zero-dep suite gets to "the
// spliced JS actually parses as one program").

const FRAGMENT_RE = /<\?!= includeJs_\('([\w-]+)'\) \?>/g;

function scriptIncludeList() {
  const text = fs.readFileSync(path.join(DIR, 'script.html'), 'utf8');
  const names = [];
  let m;
  while ((m = FRAGMENT_RE.exec(text)) !== null) names.push(m[1]);
  return { text, names };
}

test('script.html: include list matches the script-*.html files on disk, in both directions', function () {
  const { names } = scriptIncludeList();
  assert.ok(names.length >= 2, 'script.html no longer looks like the fragment assembler');
  const onDisk = fs.readdirSync(DIR)
    .filter(function (f) { return /^script-[\w-]+\.html$/.test(f); })
    .map(function (f) { return f.replace(/\.html$/, ''); })
    .sort();
  const included = names.slice().sort();
  assert.deepEqual(included, onDisk,
    'script.html includes and script-*.html files diverge. A fragment on disk '
    + 'but not included silently DROPS its features; an include with no file '
    + 'throws at render. Included: ' + included.join(', ') + ' | On disk: ' + onDisk.join(', '));
});

test('styles.html: no scriptlets -- include_ template-evaluates it now', function () {
  // include_ switched to createTemplateFromFile().evaluate() for the fragment
  // assembly (#4), and styles.html rides the same helper -- a scriptlet-open
  // sequence in the CSS would execute server-side at render.
  const body = fs.readFileSync(path.join(DIR, 'styles.html'), 'utf8');
  assert.equal(body.indexOf('<' + '?'), -1,
    'styles.html contains a scriptlet-open sequence -- include_ EVALUATES '
    + 'templates now, so this would execute server-side at render.');
});

test('script fragments: script-tag wrapped raw JS -- ONE wrapper pair, no scriptlets', function () {
  // Apps Script's HTML loader parses every file it loads; a fragment of BARE
  // JS fails live with "Malformed HTML content" (it took the deployed app
  // down -- the harness cannot run Google's real template compiler). So each
  // fragment wraps its JS in its own script tags and includeJs_ strips them
  // at splice time. Exactly one opener + one closer; nothing outside them.
  const { names } = scriptIncludeList();
  names.forEach(function (name) {
    const body = fs.readFileSync(path.join(DIR, name + '.html'), 'utf8');
    const opens = body.split('<' + 'script>').length - 1;
    const closes = body.split('</' + 'script>').length - 1;
    assert.equal(opens, 1, name + '.html must contain exactly ONE script-open wrapper tag');
    assert.equal(closes, 1, name + '.html must contain exactly ONE script-close wrapper tag '
      + '(a nested close would end the ASSEMBLED block early and render page text)');
    assert.equal(body.slice(0, body.indexOf('<' + 'script>')).trim(), '',
      name + '.html: nothing may precede the wrapper');
    assert.equal(body.slice(body.indexOf('</' + 'script>') + 9).trim(), '',
      name + '.html: nothing may follow the wrapper');
    assert.equal(body.indexOf('<' + '?'), -1,
      name + '.html contains a scriptlet-open sequence -- script.html is '
      + 'template-EVALUATED, so this would execute server-side at render.');
  });
});

test('script.html + fragments: the assembled IIFE body parses as one program', function () {
  const { text, names } = scriptIncludeList();
  const assembled = text.replace(FRAGMENT_RE, function (_, name) {
    // Mirror includeJs_: strip each fragment's own script-tag wrapper.
    const body = fs.readFileSync(path.join(DIR, name + '.html'), 'utf8');
    const o = body.indexOf('<' + 'script>');
    const c = body.lastIndexOf('</' + 'script>');
    return (o !== -1 && c > o) ? body.slice(o + 8, c) : body;
  });
  const open = assembled.indexOf('<script>');
  const close = assembled.indexOf('</script>');
  assert.ok(open !== -1 && close > open, 'assembled page lost its script element');
  const js = assembled.slice(open + '<script>'.length, close);
  const os = require('os');
  const cp = require('child_process');
  // .cjs, NOT .js: for a `.js` file Node has to decide CommonJS-vs-ESM, which
  // means reading the nearest package.json -- and the nearest one to a temp
  // file is whatever happens to be sitting in the OS temp directory. A stray
  // corrupt package.json there (common enough on Windows; an installer drops
  // one) made this test fail with ERR_INVALID_PACKAGE_CONFIG, reported as
  // "assembled client body fails to parse", which is the opposite of the
  // truth. The explicit extension tells Node the format outright so it never
  // consults ambient state. Verified: a genuine syntax error still fails.
  const tmp = path.join(os.tmpdir(), 'assembled-client-' + process.pid + '.cjs');
  fs.writeFileSync(tmp, js);
  try {
    const r = cp.spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
    assert.equal(r.status, 0,
      'assembled client body fails to parse -- a fragment boundary probably cut '
      + 'a statement in half, or a fragment edit broke syntax:\n' + (r.stderr || ''));
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('styles.html: the sub-queue CSS is inside the style element', function () {
  // A named regression pin for the block that actually escaped, so a future
  // refactor that re-appends it is caught by name rather than by byte offset.
  const text = fs.readFileSync(path.join(DIR, 'styles.html'), 'utf8');
  const marker = text.indexOf('Sub-queue scope bar + grouped agent table');
  assert.notEqual(marker, -1, 'the Phase 1 sub-queue CSS block is missing entirely');
  assert.ok(marker < text.indexOf('</style>'),
    'the sub-queue CSS must sit ABOVE </style> -- it shipped below it once');
});

// ---- S8 (broad-scan 2026-08-27): the two prose-only client conventions -----
//
// "Any new chart callsite must route through safeChart_" and "any new tabular
// cell writer must call csvSafeCell_" were rules with no tripwire. Both are
// currently clean; these pins keep them that way.

test('S8: safeChart_ is the ONLY `new Chart(` callsite in the client', function () {
  const fragNames = [];
  const text = fs.readFileSync(path.join(DIR, 'script.html'), 'utf8');
  let fm; const fre = /<\?!= includeJs_\('([\w-]+)'\) \?>/g;
  while ((fm = fre.exec(text)) !== null) fragNames.push(fm[1]);
  fragNames.forEach(function (name) {
    const src = fs.readFileSync(path.join(DIR, name + '.html'), 'utf8');
    const offenders = [];
    src.split('\n').forEach(function (ln, i) {
      if (ln.indexOf('new Chart(') === -1) return;
      if (/^\s*(\/\/|\*)/.test(ln)) return;                    // comment lines
      offenders.push(name + '.html:' + (i + 1));
    });
    if (name === 'script-1-core') {
      // The one real callsite lives inside safeChart_ itself.
      assert.equal(offenders.length, 1, 'script-1-core must hold exactly the safeChart_ callsite; found ' + offenders.join(', '));
      const at = parseInt(offenders[0].split(':')[1], 10);
      const fnStart = src.indexOf('function safeChart_');
      const fnLine = src.slice(0, fnStart).split('\n').length;
      assert.ok(at > fnLine && at < fnLine + 40,
        'the `new Chart(` callsite moved outside safeChart_ -- route it back through');
    } else {
      assert.deepEqual(offenders, [],
        'chart created without safeChart_ (CDN-failure fallback lost): ' + offenders.join(', '));
    }
  });
});

test('S8: every tabular cell writer routes through csvSafeCell_', function () {
  // The named writers (CLAUDE.md's CSV-injection bullet). csvEscape is the
  // shared My-Dept escaper; each body must reference csvSafeCell_ (or
  // csvEscape, which wraps it) -- a writer that stops is a formula-injection
  // reopening, not a refactor.
  const WRITERS = [
    // csvEscape is a local inside exportTableCsv_ (script-5), not a core fn.
    ['script-5-dept',   /csvEscape = function[\s\S]{0,200}?csvSafeCell_/,     'exportTableCsv_\'s csvEscape must wrap csvSafeCell_'],
    ['script-8-insights', /function insDownloadCsv_[\s\S]*?csvSafeCell_/,    'insDownloadCsv_'],
    ['script-9-inbound-direct', /function inboundDownloadCsv_[\s\S]*?csvSafeCell_/, 'inboundDownloadCsv_'],
    ['script-9-inbound-direct', /function directCallDownloadCsv_[\s\S]*?csvSafeCell_/, 'directCallDownloadCsv_'],
    ['script-9-inbound-direct', /function outboundDownloadCsv_[\s\S]*?csvSafeCell_/, 'outboundDownloadCsv_'],
    ['script-11-qcd-boot', /function qcdAllDeptCsv_[\s\S]*?csvSafeCell_/,    'qcdAllDeptCsv_'],
    ['script-6-ir',     /ir-copy-tsv[\s\S]{0,2000}?csvSafeCell_/,            'the IR copy-as-TSV handler (E-3)'],
  ];
  WRITERS.forEach(function (w) {
    const src = fs.readFileSync(path.join(DIR, w[0] + '.html'), 'utf8');
    assert.ok(w[1].test(src), w[0] + ': ' + w[2] + ' -- csvSafeCell_ routing lost or renamed');
  });
});

test('S8: dsPrompt_ is the only prompt path -- no window.prompt callsite survives', function () {
  // window.prompt renders in the browser/Sheets chrome (the incongruence
  // dsConfirm_ exists to fix) and cannot validate without discarding what was
  // typed. dsPrompt_ replaced the one callsite; this keeps it replaced.
  // NOTE: ~12 legacy window.confirm callsites remain by design (the
  // documented "adopt dsConfirm_ incrementally" backlog), so this pins the
  // PROMPT family only -- tighten it to confirm() once that backlog closes.
  const fragNames = [];
  const text = fs.readFileSync(path.join(DIR, 'script.html'), 'utf8');
  let fm; const fre = /<\?!= includeJs_\('([\w-]+)'\) \?>/g;
  while ((fm = fre.exec(text)) !== null) fragNames.push(fm[1]);
  const offenders = [];
  fragNames.forEach(function (name) {
    const src = fs.readFileSync(path.join(DIR, name + '.html'), 'utf8');
    src.split('\n').forEach(function (ln, i) {
      if (!/(^|[^.\w])(window\.)?prompt\s*\(/.test(ln)) return;
      if (/^\s*(\/\/|\*)/.test(ln)) return;                 // comment lines
      if (/function dsPrompt_|dsPrompt_\s*\(/.test(ln)) return;  // the replacement itself
      offenders.push(name + '.html:' + (i + 1));
    });
  });
  assert.deepEqual(offenders, [],
    'native prompt() callsite -- route it through dsPrompt_ (script-1-core), '
    + 'which is themed and validates in place: ' + offenders.join(', '));
});

test('S8: the email-to-agent flow routes through the app dialogs, not native ones', function () {
  const src = fs.readFileSync(path.join(DIR, 'script-6-ir.html'), 'utf8');
  const start = src.indexOf('function irEmailToAgent_');
  assert.notEqual(start, -1, 'irEmailToAgent_ is missing -- move this pin with it');
  const body = src.slice(start, start + 3000);
  assert.match(body, /dsConfirm_\(/, 'the registered-address path must CONFIRM before sending');
  assert.match(body, /dsPrompt_\(/, 'the no-address path must collect the address in-app');
  assert.match(body, /validate:/, 'the prompt must validate inline, not bounce a toast afterwards');
});

test('update notice: both templates inject __BUILD_STAMP__ and both heartbeats route through presenceBeatOk_', function () {
  // The redeploy-detection wiring (CLAUDE.md live-presence bullet): the page
  // bakes the serving deployment's stamp in at load, and the presence beat's
  // success handler compares it against recordPresence's returned stamp.
  // Four pieces, each silently inert without the others -- a lost injection
  // or a success handler reverted to a no-op turns the notice off with no
  // error anywhere, so pin all four.
  [
    ['dashboard.html', /window\.__BUILD_STAMP__ = <\?!= buildStampJson \?>/, 'load-time stamp injection'],
    ['agent.html',     /window\.__BUILD_STAMP__ = <\?!= buildStampJson \?>/, 'load-time stamp injection'],
    ['script-1-core.html', /\.withSuccessHandler\(presenceBeatOk_\)/, 'heartbeat stamp-check handler'],
    ['agentApp.html',      /\.withSuccessHandler\(presenceBeatOk_\)/, 'heartbeat stamp-check handler'],
  ].forEach(function (p) {
    const src = fs.readFileSync(path.join(DIR, p[0]), 'utf8');
    assert.ok(p[1].test(src), p[0] + ': ' + p[2] + ' lost -- the update notice is silently dead');
  });
});

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

const FRAGMENT_RE = /<\?!= include_\('([\w-]+)'\) \?>/g;

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

test('script fragments: raw JS only -- no script/style tags, no scriptlets', function () {
  const { names } = scriptIncludeList();
  names.forEach(function (name) {
    const body = fs.readFileSync(path.join(DIR, name + '.html'), 'utf8');
    assert.equal(body.indexOf('</scr' + 'ipt'), -1,
      name + '.html contains the end-of-script-tag pattern -- the browser closes '
      + 'the ASSEMBLED block there and everything after renders as page text.');
    assert.equal(body.indexOf('<scr' + 'ipt'), -1,
      name + '.html contains a script-open tag -- fragments are spliced INSIDE '
      + 'one script element and must stay raw JS.');
    assert.equal(body.indexOf('<' + '?'), -1,
      name + '.html contains a scriptlet-open sequence -- include_ EVALUATES '
      + 'templates now, so this would execute server-side at render.');
  });
});

test('script.html + fragments: the assembled IIFE body parses as one program', function () {
  const { text, names } = scriptIncludeList();
  const assembled = text.replace(FRAGMENT_RE, function (_, name) {
    return fs.readFileSync(path.join(DIR, name + '.html'), 'utf8');
  });
  const open = assembled.indexOf('<script>');
  const close = assembled.indexOf('</script>');
  assert.ok(open !== -1 && close > open, 'assembled page lost its script element');
  const js = assembled.slice(open + '<script>'.length, close);
  const os = require('os');
  const cp = require('child_process');
  const tmp = path.join(os.tmpdir(), 'assembled-client-' + process.pid + '.js');
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
